import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { closePooledDbs, makePooledDb } from "@trafficflow/db/cloud";
import { MIGRATOR_ROLE, ownServersAvailable, startLockGround, type LockGround } from "@trafficflow/db/testing";
import { bridgeTx, dbFor, type ServiceContext } from "../src/context.js";
import { heldReleaseGroups, heldReleaseTotal } from "../src/held-release-service.js";
import { MessageService } from "../src/message-service.js";
import { ScreenerReadService } from "../src/screener-service.js";
import { statementSeam } from "./helpers/statement-seam.js";

const available = ownServersAvailable("locked-mail-reads.pg.test.ts");
const database = "locked_reads";
const account = randomUUID();
const other = randomUUID();
const smallAccounts = [randomUUID(), randomUUID()];
const rows = 370_000;
const held = 384;
const now = new Date("2026-01-01T00:00:00Z");

describe.skipIf(!available)("large mailbox reads with the Cloud row lock", () => {
  let ground: LockGround;
  let owner: postgres.Sql;
  let api: postgres.Sql;
  let db: ReturnType<typeof makePooledDb>;
  let ownerDb: ReturnType<typeof makePooledDb>;
  const statements: { query: string; parameters: unknown[] }[] = [];

  beforeAll(async () => {
    ground = await startLockGround(17, "locked_reads", database);
    await ground.setup(database);
    await ground.makeRoles(database);
    execFileSync(process.execPath, [
      "--conditions=ohmail-source", "--import=tsx", "packages/db/src/setup-prod-cli.ts", "--lock",
    ], {
      cwd: resolve(import.meta.dirname, "../../.."),
      env: { DATABASE_URL_SESSION: ground.urlAs(database, MIGRATOR_ROLE), TF_PROD_DB_HOST: "127.0.0.1" },
      stdio: "pipe",
    });
    await ground.runRolesScript(database);
    owner = ground.connectAs(database, MIGRATOR_ROLE);
    api = ground.connectAs(database, "ohmail_api");
    db = makePooledDb(ground.urlAs(database, "ohmail_api"));
    ownerDb = makePooledDb(ground.urlAs(database, MIGRATOR_ROLE));
    const [policy] = await api<{ active: boolean }[]>`
      select pg_catalog.row_security_active('public.messages') as active`;
    expect(policy?.active).toBe(true);

    await owner`insert into accounts (id) values (${account}), (${other})`;
    const suffix = String.fromCharCode(64) + "fixture.invalid";
    const [mailbox] = await owner<{ id: string }[]>`insert into mailboxes
      (account_id, provider, address, organizer_role)
      values (${account}, 'imap', ${"mailbox" + suffix}, 'organizer') returning id`;
    await owner`insert into messages (account_id, mailbox_id, body_hash, dedup_key, from_address, date, created_at, unread)
      select ${account}, ${mailbox!.id}, 'fixture', i::text,
        case when i <= ${held} then 'Held' || i else 'Bulk' || (i % 8192) end || ${suffix},
        '2018-01-01'::timestamptz + (i % 2800) * interval '1 day',
        '2018-01-01'::timestamptz + (i % 2800) * interval '1 day', i <= 64
      from generate_series(1, ${rows}) as i`;
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
    await owner`analyze messages`;
    await owner`analyze folder_state`;
    await owner`analyze rules`;
  }, 180_000);

  afterAll(async () => {
    await closePooledDbs();
    await api?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
    ground?.stop();
  });

  function context(accountId = account, handle = db): ServiceContext {
    const bound = statementSeam(dbFor(handle, accountId), (query, parameters) => {
      statements.push({ query, parameters });
      return null;
    });
    return { db: bound, accountId, userId: null, now: () => now, requestId: "fixture" };
  }

  async function measure<T>(label: string, read: (ctx: ServiceContext) => Promise<T>): Promise<{ result: T; ms: number }> {
    statements.length = 0;
    const start = performance.now();
    const outcome = await read(context()).then((result) => ({ result }), (error: unknown) => ({ error }));
    const ms = performance.now() - start;
    const queries = statements.filter(({ query }) => /from (?:public\.)?(?:"messages"|"rules"|messages [mn])/i.test(query));
    const planDir = process.env.TF_MAIL_QUERY_PLANS;
    if (planDir) {
      console.info(`mail query benchmark ${label}: ${ms.toFixed(1)} ms through the service`);
      expect(queries.length).toBeGreaterThan(0);
      for (const [role, conn] of [["api", api], ["owner", owner]] as const) {
        const plans = await conn.begin("read only", async (tx) => {
          await tx`select set_config('ohmail.account', ${account}, true)`;
          await tx`set local statement_timeout = '140s'`;
          const plans = [];
          for (const { query, parameters } of queries) {
            plans.push(await tx.unsafe("explain (analyze, buffers, format json) " + query, parameters as never[]));
          }
          return plans;
        });
        writeFileSync(resolve(planDir, `${label}-${role}.json`),
          JSON.stringify(plans, null, 2).replace(/[\w.+-]+@[\w.-]+/g, "[fixture]"));
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
});
