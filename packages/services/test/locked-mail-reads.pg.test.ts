import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closePooledDbs, makePooledDb } from "@trafficflow/db/cloud";
import { bindDb, senderIsActiveSql, resolveCutline, type Tx } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { sql } from "drizzle-orm";
import {
  lockedQueryGroundAvailable, startLockedQueryGround, type LockedQueryGround,
} from "../../db/test/_locked-query-ground.js";
import { bridgeTx, dbFor, type ServiceContext } from "../src/context.js";
import { heldReleaseGroups, heldReleaseTotal } from "../src/held-release-service.js";
import { materializeMessages } from "../src/dto/materialize.js";
import { MessageService } from "../src/message-service.js";
import { ScreenerReadService } from "../src/screener-service.js";
import { statementSeam } from "./helpers/statement-seam.js";

const available = lockedQueryGroundAvailable("locked-mail-reads.pg.test.ts");
const database = "locked_reads";
const account = randomUUID();
const other = randomUUID();
const smallAccounts = [randomUUID(), randomUUID()];
const cold = process.env.TF_MAIL_QUERY_COLD === "1";
const rows = cold ? 880_000 : 400_000;
const mailboxCount = cold ? 8 : 1;
const held = 384;
const now = new Date("2026-01-01T00:00:00Z");

describe.skipIf(!available)("large mailbox reads with the Cloud row lock", () => {
  let ground: LockedQueryGround;
  let port: number;
  let owner: postgres.Sql;
  let api: postgres.Sql;
  let db: ReturnType<typeof makePooledDb>;
  let ownerDb: ReturnType<typeof makePooledDb>;
  let mailboxId: string;
  let invitationIds: string[];
  const statements: { query: string; parameters: unknown[] }[] = [];

  beforeAll(async () => {
    ground = await startLockedQueryGround(import.meta.url, database, "ohmail_api");
    port = Number(new URL(ground.runtimeUrl).port);
    if (cold) {
      if (!ground.docker) throw new Error("the cold run needs to restart its own PostgreSQL server");
      const admin = ground.docker.connectAs(database);
      try {
        await admin`alter system set shared_buffers = '512MB'`;
        await admin`alter system set track_io_timing = on`;
      } finally {
        await admin.end();
      }
      await restartPostgres();
    } else {
      openConnections();
    }
    const [policy] = await api<{ active: boolean }[]>`
      select pg_catalog.row_security_active('public.messages') as active`;
    expect(policy?.active).toBe(true);
    if (cold) await owner`set statement_timeout = '300s'`;

    await owner`insert into accounts (id) values (${account}), (${other})`;
    const suffix = String.fromCharCode(64) + "fixture.invalid";
    const mailboxes = await owner<{ id: string }[]>`insert into mailboxes
      (account_id, provider, address, organizer_role)
      select ${account}, 'imap', case when n = 1 then 'mailbox' else 'mailbox-' || n end || ${suffix}, 'organizer'
      from generate_series(1, ${mailboxCount}) n returning id`;
    const mailboxIds = mailboxes.map(({ id }) => id);
    mailboxId = mailboxIds[0]!;
    await owner`insert into messages (account_id, mailbox_id, body_hash, dedup_key, from_address, date, created_at, unread, snippet)
      select ${account}, (${owner.array(mailboxIds)}::uuid[])[1 + (i - 1) % ${mailboxCount}], 'fixture', i::text,
        case when i % 100 = 0 and i > 12000 then 'Mailbox'
          when i <= ${held} then 'Held' || i else 'Bulk' || (i % 8192) end || ${suffix},
        '2018-01-01'::timestamptz + (i % 2800) * interval '1 day',
        '2018-01-01'::timestamptz + (i % 2800) * interval '1 day',
        i <= 64 or (${cold} and i > ${held} and i % 5 <> 0), repeat(md5(i::text), 16)
      from generate_series(1, ${rows}) as i`;
    if (cold) {
      await owner`with accounts_added as (
          insert into accounts (id) select gen_random_uuid() from generate_series(1, 22) returning id
        )
        insert into mailboxes (account_id, provider, address, organizer_role)
        select id, 'imap', 'other-' || id || ${suffix}, 'organizer' from accounts_added`;
      await owner`insert into messages (account_id, mailbox_id, body_hash, dedup_key, from_address, date, unread, snippet)
        select b.account_id, b.id, 'fixture', n::text, 'Bulk' || (n % 8192) || ${suffix},
          '2025-12-01'::timestamptz, n % 5 <> 0, repeat(md5(n::text), 16)
        from mailboxes b cross join generate_series(1, 5500) n where b.account_id <> ${account}`;
      await owner`insert into folder_state
        (account_id, message_id, desired_folder, observed_folder, last_set_by, reconcile_status)
        select account_id, id, 'INBOX', 'INBOX', 'external', 'settled' from messages where account_id <> ${account}`;
    }
    await owner`insert into folder_state (account_id, message_id, desired_folder, observed_folder, last_set_by, reconcile_status)
      select account_id, id, f.folder, f.folder, 'external', 'settled'
      from messages cross join lateral
        (select case when dedup_key::integer <= ${held} then 'ohmail/Screener' else 'INBOX' end as folder) f
      where account_id = ${account}`;
    await owner`insert into rules (account_id, kind, match, destination)
      select ${account}, 'sender', '  HELD' || i || ${suffix} || ' ', 'INBOX'
      from generate_series(1, 120) as i`;
    await owner`insert into rules (account_id, kind, match, destination)
      select ${account}, 'sender', 'bulk' || i || ${suffix}, 'INBOX'
      from generate_series(1, 600) as i`;
    const invites = await owner<{ message_id: string; sequence: number }[]>`
      insert into message_invitations
        (account_id, message_id, mailbox_id, uid, sequence, method, organizer, starts_at, start_raw, stamped_at)
      select account_id, id, mailbox_id, 'event-' || ((dedup_key::int - 10001) % 1000),
        (dedup_key::int - 10001) / 1000, 'REQUEST', ${'organizer' + suffix},
        '2026-01-01'::timestamptz + ((dedup_key::int - 1) / 1000) * interval '1 day',
        '20260101T000000Z', created_at
        from messages where account_id = ${account}
          and dedup_key::int between 10001 and ${cold ? 42_000 : 12_000}
      returning message_id, sequence`;
    invitationIds = invites.filter(({ sequence }) => sequence === (cold ? 31 : 1)).map(({ message_id }) => message_id);
    if (cold) {
      // Re-use a corpus of varied synthetic body blocks. Headers are stored out-of-line as well.
      await owner`create temporary table fixture_body as
        select piece, string_agg(md5(piece::text || ':' || n::text), '' order by n) as words
        from generate_series(1, 1024) piece cross join generate_series(1, 220) n group by piece`;
      await owner`insert into message_bodies (account_id, message_id, text, html, headers)
        select m.account_id, m.id, substr(b.words, 1, 2400),
          '<div>' || b.words || '</div>',
          jsonb_build_object('auto-submitted', jsonb_build_array('no'), 'received', jsonb_build_array(substr(b.words, 3500, 2800)))
        from messages m join fixture_body b on b.piece = 1 + m.dedup_key::int % 1024
        where m.dedup_key::int % 2 = 0`;
    } else {
      await owner`insert into message_bodies (account_id, message_id, headers)
        select account_id, id, case when dedup_key = '13000' then
          '{"auto-submitted":["auto-replied"]}'::jsonb else '{"auto-submitted":["no"]}'::jsonb end
        from messages where account_id = ${account} and dedup_key::int % 5 = 0`;
    }
    await owner`analyze message_bodies`;
    await owner`analyze message_invitations`;
    await owner`analyze messages`;
    await owner`analyze folder_state`;
    await owner`analyze rules`;
  }, 360_000);

  afterAll(async () => {
    await closePooledDbs();
    await api?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
    await ground?.close();
  });

  function atPort(url: string): string {
    const target = new URL(url);
    if (cold) target.port = String(port);
    return target.href;
  }

  function connect(url: string): postgres.Sql {
    return postgres(atPort(url), { max: 1, connect_timeout: 2, onnotice: () => {} });
  }

  function openConnections(): void {
    owner = connect(ground.ownerUrl);
    api = connect(ground.runtimeUrl);
    db = makePooledDb(atPort(ground.runtimeUrl));
    ownerDb = makePooledDb(atPort(ground.ownerUrl));
  }

  async function restartPostgres(): Promise<void> {
    await closePooledDbs();
    await api?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
    const docker = ground.docker!;
    execFileSync("docker", ["restart", "-t", "10", docker.server.container], { stdio: "pipe" });
    const mapping = execFileSync("docker", ["port", docker.server.container, "5432/tcp"], { encoding: "utf8" });
    const nextPort = Number(/^127\.0\.0\.1:(\d+)$/m.exec(mapping)?.[1]);
    if (!Number.isInteger(nextPort)) throw new Error("the test database lost its loopback port");
    port = nextPort;
    const admin = connect(docker.urlAs(database));
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const [setting] = await admin`show shared_buffers`;
          expect(setting?.shared_buffers).toBe("512MB");
          break;
        } catch (error) {
          if (attempt >= 30) throw error;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    } finally {
      await admin.end();
    }
    openConnections();
  }

  function context(accountId = account, handle = db): ServiceContext {
    const bound = statementSeam(dbFor(handle, accountId), (query, parameters) => {
      statements.push({ query, parameters });
      return null;
    });
    return { db: bound, accountId, userId: null, now: () => now, requestId: "fixture" };
  }

  async function measure<T>(
    label: string, read: (ctx: ServiceContext) => Promise<T>, statementBudget?: number,
  ): Promise<{ result: T; ms: number }> {
    statements.length = 0;
    const start = performance.now();
    const outcome = await read(context()).then((result) => ({ result }), (error: unknown) => ({ error }));
    const ms = performance.now() - start;
    const queries = statements.filter(({ query }) => /from (?:public\.)?(?:"messages"|"rules"|messages [mn])/i.test(query));
    const planDir = process.env.TF_MAIL_QUERY_PLANS;
    const jitOff = statements.some(({ query }) => query === "set local jit = off");
    if (planDir || statementBudget !== undefined) {
      if (planDir) console.info(`mail query benchmark ${label}: ${ms.toFixed(1)} ms through the service`);
      expect(queries.length).toBeGreaterThan(0);
      for (const role of ["api", "owner"] as const) {
        if (role === "owner" && (cold || !planDir)) continue;
        const plans = [];
        for (const { query, parameters } of queries) {
          if (cold) await restartPostgres();
          const conn = role === "api" ? api : owner;
          plans.push(await conn.begin("read only", async (tx) => {
            await tx`select set_config('ohmail.account', ${account}, true)`;
            await tx`set local statement_timeout = '140s'`;
            if (jitOff) await tx`set local jit = off`;
            return tx.unsafe<{ "QUERY PLAN": [{ "Execution Time": number }] }[]>(
              "explain (analyze, buffers, format json) " + query, parameters as never[],
            );
          }));
        }
        if (planDir) writeFileSync(resolve(planDir, `${label}-${role}.json`),
          JSON.stringify(plans, null, 2).replace(/[\w.+-]+@[\w.-]+/g, "[fixture]"));
        if (role === "api" && statementBudget !== undefined) {
          for (const plan of plans) {
            if (cold) console.info(`cold ${label}: ${plan[0]?.["QUERY PLAN"][0]["Execution Time"]} ms`);
            const check = cold ? expect.soft : expect;
            check(plan[0]?.["QUERY PLAN"][0]["Execution Time"],
              `${label} statement duration in milliseconds`).toBeLessThan(statementBudget);
          }
        }
      }
    }
    if ("error" in outcome) throw outcome.error;
    return { result: outcome.result, ms };
  }

  it("checks the waiting senders without scanning the mailbox once per sender", async () => {
    const { result, ms } = await measure("screener", (ctx) => new ScreenerReadService({}).list(ctx));
    expect(result.items.length).toBe(0);
    expect(ms, "Screener duration in milliseconds").toBeLessThan(2500);
  }, 180_000);

  it("counts held mail behind rules within the read budget", async () => {
    const { result, ms } = await measure("rule-count", (ctx) => heldReleaseGroups(bridgeTx(ctx.db), account));
    expect(result.length).toBe(120);
    expect(result.every(({ count }) => count === 1)).toBe(true);
    expect(ms, "rule count duration in milliseconds").toBeLessThan(2500);
  }, 180_000);

  it("counts each History month with row security active", async () => {
    const service = new MessageService();
    const { result, ms } = await measure("timeline", (ctx) => service.timeline(ctx, { zone: "Europe/Zurich" }));
    expect(result.total).toBe(rows);
    expect(result.months.length).toBeGreaterThan(90);
    expect((await service.timeline(context(other), { zone: "Europe/Zurich" })).total).toBe(0);
    expect(ms, "timeline duration in milliseconds").toBeLessThan(2500);
  }, 180_000);

  it("reads calendar invitation revisions within the read budget", async () => {
    const { result } = await measure("invitation", (ctx) =>
      materializeMessages(ctx.db, account, invitationIds.slice(-200)), 500);
    expect(result.size).toBe(200);
    expect([...result.values()].every(({ invitation }) => invitation?.previous?.startsAt !== undefined)).toBe(true);
    const query = statements.find(({ query }) => query.includes("earlier"));
    expect(query?.query.match(/from "message_invitations" earlier/g)).toHaveLength(1);
  }, 180_000);

  it("keeps both accounts' waiting, held and History rows equal to the unrestricted table reads", async () => {
    const at = String.fromCharCode(64);
    const senders = ["One", "Two", "Shared", "Dormant", "Claim"].map((name) => name + at + name.toLowerCase() + ".invalid");
    for (const [index, id] of smallAccounts.entries()) {
      await owner`insert into accounts (id) values (${id})`;
      const [mailbox] = await owner<{ id: string }[]>`insert into mailboxes
        (account_id, provider, address, organizer_role, initial_import_completed_at)
        values (${id}, 'imap', ${"mailbox-" + index + at + "fixture.invalid"}, 'organizer', '2025-06-01') returning id`;
      await owner`insert into messages (account_id, mailbox_id, body_hash, dedup_key, from_address, date)
        values (${id}, ${mailbox!.id}, 'fixture', 'first', ${senders[0]!}, '2025-11-30 23:30:00+00'),
               (${id}, ${mailbox!.id}, 'fixture', 'second', ${senders[1]!}, '2025-12-01 02:30:00+00'),
               (${id}, ${mailbox!.id}, 'fixture', 'shared', ${senders[2]!}, '2025-12-02 12:00:00+00'),
               (${id}, ${mailbox!.id}, 'fixture', 'undated', ${senders[index]!}, null)`;
      // Only B has activity for Dormant or a current claim. Both held copies in A are old.
      await owner`insert into messages (account_id, mailbox_id, body_hash, dedup_key, from_address, date,
                                        created_at, unread, sender_check, sender_check_by, auth_verdict)
        values (${id}, ${mailbox!.id}, 'fixture', 'dormant', ${senders[3]!},
                ${index === 0 ? "2025-01-10" : "2025-12-10"}, '2025-12-10', false, null, null, null),
               (${id}, ${mailbox!.id}, 'fixture', 'claim', ${senders[4]!}, '2025-01-10',
                '2025-12-10', false, 'impersonation', ${index === 0 ? null : "ingest"}, 'fail')`;
      await owner`insert into folder_state (account_id, message_id, desired_folder, observed_folder, last_set_by, reconcile_status)
        select account_id, id, placement.folder, placement.folder, 'external', 'settled'
        from messages cross join lateral (
          select case when ${index} = 1 and dedup_key = 'dormant' then 'INBOX' else 'ohmail/Screener' end as folder
        ) placement
        where account_id = ${id} and dedup_key <> 'undated'`;
      if (index === 1) {
        await owner`insert into organizer_requests (account_id, mailbox_id, kind, payload, decided_at)
          values (${id}, ${mailbox!.id}, 'screener.decide',
            jsonb_build_object('scope', 'sender', 'match', ${senders[1]!.toLowerCase()}::text, 'appliedFolder', 'INBOX'), ${now})`;
      }
      await owner`insert into rules (account_id, kind, match, destination)
        values (${id}, 'sender', ${" " + senders[index]!.toUpperCase() + " "}, 'INBOX'),
               (${id}, 'domain', ${senders[index]!.split(at)[1]!}, 'ohmail/Receipts'),
               (${id}, 'sender', ${senders[2]!}, ${index === 0 ? "INBOX" : "ohmail/Receipts"})`;
    }

    const screener = new ScreenerReadService({});
    const history = new MessageService();
    for (const [index, id] of smallAccounts.entries()) {
      const apiContext = context(id);
      const ownerContext = context(id, ownerDb);
      const [waiting, expectedWaiting] = await Promise.all([screener.list(apiContext), screener.list(ownerContext)]);
      const expectedTotal = index === 0 ? 1 : 2;
      expect(waiting.total).toBe(expectedTotal);
      expect(expectedWaiting.total, "owner-role Screener total").toBe(expectedTotal);
      expect(waiting.items.length).toBe(expectedTotal);
      expect({ items: waiting.items, total: waiting.total }).toEqual({
        items: expectedWaiting.items, total: expectedWaiting.total,
      });

      const apiTx = bridgeTx(apiContext.db);
      const ownerTx = bridgeTx(ownerContext.db);
      const groups = await heldReleaseGroups(apiTx, id);
      const expectedGroups = await heldReleaseGroups(ownerTx, id);
      expect(groups.map(({ count }) => count)).toEqual([1, 1, 1]);
      expect(groups).toEqual(expectedGroups);
      const total = await heldReleaseTotal(apiTx, id, groups);
      expect(total).toBe(2);
      expect(total).toBe(await heldReleaseTotal(ownerTx, id, expectedGroups));

      for (const zone of [
        "UTC", "Europe/Zurich", "America/Los_Angeles", "Asia/Kolkata", "Europe/Kyiv",
        "America/Argentina/Buenos_Aires", "+0530", "-05",
      ]) {
        const from = statements.length;
        const timeline = await history.timeline(apiContext, { zone });
        if (!/^[+-]/.test(zone)) {
          const monthQuery = statements.slice(from).find(({ query }) => query.includes("date_trunc"));
          expect(monthQuery?.parameters, zone).toContain(zone);
        }
        expect(timeline.total, zone).toBe(6);
        expect(timeline.undated, zone).toBe(1);
        expect(timeline, zone).toEqual(await history.timeline(ownerContext, { zone }));
      }
    }

    const id = smallAccounts[0]!;
    const rejectedZoneDb = statementSeam(dbFor(db, id), (query, parameters) => {
      if (!query.includes("date_trunc") || !parameters.includes("Europe/Zurich")) return null;
      return async () => { throw Object.assign(new Error("time zone not recognized"), { code: "22023" }); };
    });
    expect(await history.timeline({ ...context(id), db: rejectedZoneDb }, { zone: "Europe/Zurich" }))
      .toEqual(await history.timeline(context(id, ownerDb), { zone: "UTC" }));
  });
  it("reads the waiting queue and held-rule groups during a large first import", async () => {
    await owner`update folder_state set desired_folder = 'ohmail/Screener', observed_folder = 'ohmail/Screener'
      where account_id = ${account} and message_id in
        (select id from messages where account_id = ${account} and dedup_key::int between 12001 and 42000)`;
    await owner`update messages set unread = true
      where account_id = ${account} and dedup_key::int between 42001 and 100000`;
    await owner`insert into organizer_requests (account_id, mailbox_id, kind, payload, decided_at)
      select ${account}, ${mailboxId}, 'screener.decide',
        jsonb_build_object('scope', 'sender', 'match', 'bulk' || i || ${String.fromCharCode(64) + "fixture.invalid"},
          'appliedFolder', 'INBOX'), ${now}
      from generate_series(700, 719) i`;
    await owner`analyze messages`;
    await owner`analyze folder_state`;
    await owner`analyze organizer_requests`;

    const service = new ScreenerReadService({});
    const page = await measure("screener-live", (ctx) => service.list(ctx, { live: true }), 500);
    expect(page.result.items.length).toBeGreaterThan(0);
    expect(page.result.nextCursor).not.toBeNull();
    const onward = await measure("screener-onward", (ctx) => service.list(ctx, {
      live: true, cursor: page.result.nextCursor!,
    }), 500);
    const waiting = await measure("screener-waiting", (ctx) => service.waitingCount(ctx, mailboxId), 500);
    const rules = await measure("rule-count-import", (ctx) => heldReleaseGroups(bridgeTx(ctx.db), account), 500);
    expect(onward.result.items.length).toBeGreaterThan(0);
    if (cold) {
      expect(waiting.result.senders).toBeGreaterThan(0);
      expect(waiting.result.senders).toBeLessThanOrEqual(page.result.total!);
    } else {
      expect(waiting.result.senders).toBe(page.result.total);
    }
    expect(rules.result.length).toBeGreaterThan(120);
  }, 180_000);

  it.runIf(cold)("checks candidate senders under the bound worker role within the read budget", async () => {
    await restartPostgres();
    const handle = makePooledDb(atPort(ground.docker!.urlAs(database, "ohmail_worker")));
    const db = bindDb(handle, { account }) as unknown as Tx;
    const d = dialect(db);
    const cutline = resolveCutline({ now });
    const sender = (i: number) => `bulk${i}${String.fromCharCode(64)}fixture.invalid`;
    const candidates = Array.from({ length: 64 }, (_, index) => ({
      key: sender(index < 32 ? 700 + index : 9_000 + index),
      arrived: index % 8 === 0,
    }));
    // The worker asks the correlated question behind an OR, so an EXISTS in a bare WHERE
    // would measure a different plan: Postgres could turn it into a semi-join.
    const values = candidates.map(({ key, arrived }) => sql`(${key}::text, ${arrived}::boolean)`);
    const query = sql`explain (analyze, buffers, format json)
      with candidates(sender, arrived) as not materialized (values ${sql.join(values, sql`, `)})
      select k.sender from candidates k where k.arrived or ${senderIsActiveSql(d, account, sql`k.sender`, cutline, [], {
        candidates: sql`select sender from candidates where not arrived`,
      })}`;
    const plan = await d.exec(db, query);
    const report = (plan[0]?.[0] as [{ "Execution Time": number; Plan: { "Actual Rows": number } }])[0];
    console.info(`cold worker sender predicate: ${report["Execution Time"]} ms`);
    const dir = process.env.TF_MAIL_QUERY_PLANS;
    if (dir) writeFileSync(resolve(dir, "sender-worker.json"),
      JSON.stringify(plan, null, 2).replace(/[\w.+-]+@[\w.-]+/g, "[fixture]"));
    expect(report.Plan["Actual Rows"]).toBe(36);
    expect(report["Execution Time"], "worker sender predicate duration in milliseconds").toBeLessThan(500);
  }, 180_000);

});
