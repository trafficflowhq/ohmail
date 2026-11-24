import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { bindDb, type Tx } from "@trafficflow/db";
import { ROLE_DEFAULT_TIMEOUTS, closePooledDbs, makePooledDb } from "@trafficflow/db/cloud";
import {
  lockedQueryGroundAvailable, startLockedQueryGround, type LockedQueryGround,
} from "../../../packages/db/test/_locked-query-ground.js";
import { statementSeam } from "../../../packages/services/test/helpers/statement-seam.js";
import { screenerImpersonationPass } from "@ohmail/organizer/screener-impersonation";
import { screenerAutoActPass } from "@ohmail/organizer/screener-auto-act";
import { screenerAutoSuggestPass } from "@ohmail/organizer/screener-auto-suggest";

/**
 * THE WORKER'S THREE SCREENER READS ON AN EIGHT-MAILBOX ACCOUNT, under the bound worker login with
 * forced row security. Each pass's waiting-sender read is captured as the pass sends it, timed with
 * EXPLAIN ANALYZE, and compared with the same statement read by a login that row security does not
 * filter (which asks each sender by its index instead of one set). Every read is held to ten seconds and
 * runs under the worker's own statement limit of 55 s. `TF_MAIL_QUERY_COLD=1` runs the full
 * million-message fixture and restarts the server before each timed read.
 */
const available = lockedQueryGroundAvailable("screener-passes-locked.pg.test.ts");
const cold = process.env.TF_MAIL_QUERY_COLD === "1";
const database = "locked_screener_passes";
const account = randomUUID();
const rows = cold ? 880_000 : 400_000;
const mailboxCount = 8;
const now = new Date("2026-01-01T00:00:00Z");
/** The live statement limit of the worker's login, in milliseconds: a read past it fails there. */
const workerStatementLimit = String(ROLE_DEFAULT_TIMEOUTS.statement_timeout);
const readBudgetMs = 10_000;

describe.skipIf(!available)("the worker's Screener passes on a large account with forced row security", () => {
  let ground: LockedQueryGround;
  let owner: postgres.Sql;
  let port: number;
  let mailboxIds: string[];

  const atPort = (url: string): string => {
    if (!ground.docker) return url;
    const target = new URL(url);
    target.port = String(port);
    return target.href;
  };
  const connect = (url: string): postgres.Sql => postgres(atPort(url), { max: 1, connect_timeout: 2, onnotice: () => {} });

  /** A cold read: the server restarts with an empty buffer cache. On the farm there is none to restart. */
  async function restart(): Promise<void> {
    if (!ground.docker || !cold) return;
    await closePooledDbs();
    await owner.end({ timeout: 2 });
    const container = ground.docker.server.container;
    execFileSync("docker", ["restart", "-t", "10", container], { stdio: "pipe" });
    const mapping = execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" });
    port = Number(/^127\.0\.0\.1:(\d+)$/m.exec(mapping)?.[1]);
    for (let attempt = 0; ; attempt++) {
      owner = connect(ground.ownerUrl);
      try {
        await owner`select 1`;
        return;
      } catch (error) {
        await owner.end({ timeout: 1 });
        if (attempt >= 30) throw error;
        await new Promise((done) => setTimeout(done, 200));
      }
    }
  }

  beforeAll(async () => {
    ground = await startLockedQueryGround(import.meta.url, database, "ohmail_worker");
    port = Number(new URL(ground.ownerUrl).port);
    if (ground.docker && cold) {
      const admin = ground.docker.connectAs(database);
      try {
        await admin`alter system set shared_buffers = '512MB'`;
      } finally {
        await admin.end();
      }
    }
    owner = connect(ground.ownerUrl);
    await restart();
    await owner`set statement_timeout = '300s'`;

    const suffix = String.fromCharCode(64) + "fixture.invalid";
    await owner`insert into accounts (id) values (${account})`;
    const mailboxes = await owner<{ id: string }[]>`insert into mailboxes
      (account_id, provider, address, organizer_role)
      select ${account}, 'imap', 'mailbox-' || n || ${suffix}, 'organizer'
      from generate_series(1, ${mailboxCount}) n returning id`;
    mailboxIds = mailboxes.map(({ id }) => id);
    // Senders who wrote once and are held (the first 384), a large crowd who write often, and the
    // account's own address. About four in five letters are unread, so most of the crowd is active.
    await owner`insert into messages (account_id, mailbox_id, body_hash, dedup_key, from_address, date, created_at, unread, snippet)
      select ${account}, (${owner.array(mailboxIds)}::uuid[])[1 + (i - 1) % ${mailboxCount}], 'fixture', i::text,
        case when i % 100 = 0 and i > 12000 then 'Mailbox'
          when i <= 384 then 'Held' || i else 'Bulk' || (i % 8192) end || ${suffix},
        '2018-01-01'::timestamptz + (i % 2800) * interval '1 day',
        '2018-01-01'::timestamptz + (i % 2800) * interval '1 day',
        i <= 64 or (i > 384 and i % 5 <> 0), repeat(md5(i::text), 16)
      from generate_series(1, ${rows}) as i`;
    // Other accounts' mail, which the bound login must read past.
    await owner`with added as (
        insert into accounts (id) select gen_random_uuid() from generate_series(1, 22) returning id
      ), boxes as (
        insert into mailboxes (account_id, provider, address, organizer_role)
        select id, 'imap', 'other-' || id || ${suffix}, 'organizer' from added returning id, account_id
      )
      insert into messages (account_id, mailbox_id, body_hash, dedup_key, from_address, date, unread, snippet)
      select b.account_id, b.id, 'fixture', n::text, 'Bulk' || (n % 8192) || ${suffix},
        '2025-12-01'::timestamptz, n % 5 <> 0, repeat(md5(n::text), 16)
      from boxes b cross join generate_series(1, ${cold ? 5500 : 1000}) n`;
    // A first import in progress: 30,384 letters held at the gate, the rest in the Inbox.
    await owner`insert into folder_state (account_id, message_id, desired_folder, observed_folder, last_set_by, reconcile_status)
      select account_id, id, f.folder, f.folder, 'external', 'settled'
      from messages cross join lateral (select case when account_id = ${account}
        and (dedup_key::int <= 384 or dedup_key::int between 12001 and 42000)
        then 'ohmail/Screener' else 'INBOX' end as folder) f`;
    // Company claims on a share of the held senders, and a copy on record for every letter.
    await owner`update messages set sender_check = 'impersonation', sender_check_by = 'ingest'
      where account_id = ${account} and dedup_key::int between 12001 and 42000 and (dedup_key::int % 8192) % 40 = 0`;
    await owner`insert into message_instances (account_id, mailbox_id, message_id, folder, uidvalidity, uid)
      select m.account_id, m.mailbox_id, m.id, f.desired_folder, 1, m.dedup_key::int
      from messages m join folder_state f on f.message_id = m.id`;
    await owner`insert into rules (account_id, kind, match, destination)
      select ${account}, 'sender', 'bulk' || i || ${suffix}, 'INBOX' from generate_series(1, 600) as i`;
    await owner`insert into account_settings (account_id, auto_suggest_at, screener_auto_act_at)
      values (${account}, '2017-01-01', '2017-01-01')`;
    for (const table of ["messages", "folder_state", "message_instances", "rules"]) {
      await owner.unsafe(`analyze ${table}`);
    }
    const [policy] = await owner<{ active: boolean }[]>`
      select pg_catalog.row_security_active('public.messages') as active`;
    expect(policy?.active, "the reference login reads without row security").toBe(false);
  }, 1_200_000);

  afterAll(async () => {
    await closePooledDbs();
    await owner?.end({ timeout: 2 });
    await ground?.close();
  });

  const settings = { screeningBaselineAt: null, dormancyDays: null, screeningScope: null };
  const unreachable = async (): Promise<never> => { throw new Error("no model in this fixture"); };
  const passes: Array<[string, (db: Tx) => Promise<unknown>]> = [
    ["impersonation", (db) => screenerImpersonationPass(db, {
      accountId: account, mailboxIds, now: () => now, settings: { on: true, ...settings },
    })],
    ["auto-act", (db) => screenerAutoActPass(db, {
      accountId: account, now: () => now, settings: { ...settings, screeningScope: "window", screenerAutoActAt: now },
      consent: { stillGiven: async () => true },
    })],
    ["auto-suggest", (db) => screenerAutoSuggestPass(db, {
      accountId: account, now: () => now, unmetered: true,
      classifier: { classify: unreachable, screen: unreachable },
    })],
  ];

  it.each(passes)("reads the %s pass's waiting senders as one set within the read budget", async (label, pass) => {
    await restart();
    const workerUrl = atPort(ground.runtimeUrl);
    const picked: { query: string; parameters: unknown[] }[] = [];
    const stop = new Error("the waiting senders were read");
    const db = statementSeam(bindDb(makePooledDb(workerUrl), { account }), (query, parameters) => {
      if (!query.includes("row_number() over")) return null;
      picked.push({ query, parameters });
      return async () => { throw stop; };
    }) as unknown as Tx;
    await pass(db).catch((error: unknown) => { if (error !== stop) throw error; });
    await closePooledDbs();
    expect(picked).toHaveLength(1);
    const { query, parameters } = picked[0]!;

    const worker = postgres(workerUrl, { max: 1, connect_timeout: 2, onnotice: () => {} });
    try {
      const read = <T>(statement: string) => worker.begin("read only", async (tx) => {
        await tx`select set_config('ohmail.account', ${account}, true)`;
        await tx`select set_config('statement_timeout', ${workerStatementLimit}, true)`;
        const [policy] = await tx<{ active: boolean }[]>`
          select pg_catalog.row_security_active('public.messages') as active`;
        expect(policy?.active).toBe(true);
        return tx.unsafe(statement, parameters as never[]).values() as unknown as Promise<T>;
      });
      const plan = await read<[[[{ "Execution Time": number }]]]>("explain (analyze, buffers, format json) " + query);
      const ms = plan[0][0][0]["Execution Time"];
      console.info(`worker ${label} read: ${ms} ms`);
      const dir = process.env.TF_MAIL_QUERY_PLANS;
      if (dir) writeFileSync(resolve(dir, `worker-${label}.json`),
        JSON.stringify(plan, null, 2).replace(/[\w.+-]+@[\w.-]+/g, "[fixture]"));

      const bound = await read<unknown[][]>(query);
      const unrestricted = await owner.unsafe(query, parameters as never[]).values();
      expect(bound.length).toBeGreaterThan(0);
      expect(bound).toEqual(unrestricted);
      // One pass over the account's mail is the floor (row security keeps the sender index out of
      // reach); a per-sender shape takes minutes here. The budget holds a wide margin under 55 s.
      expect(ms, `${label} read duration in milliseconds`).toBeLessThan(readBudgetMs);
    } finally {
      await worker.end({ timeout: 2 });
    }
  }, 600_000);
});
