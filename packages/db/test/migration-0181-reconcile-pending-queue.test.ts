import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { SQLITE_JOURNAL } from "@ohmail/db-mail/sqlite-journal";
import { makeTestDb } from "../src/testing.js";
import { migrateSqlite } from "../src/sqlite-migrate.js";
import { ensureConcurrentIndexes } from "../src/concurrent-index.js";
import { FLAG_STATE_PENDING_QUEUE_PREBUILD_SPEC, FOLDER_STATE_PENDING_QUEUE_PREBUILD_SPEC } from "../src/search-setup.js";

/**
 * MAIL 0181 ON A STORE THAT PREDATES IT, on PGlite and on the device store: move and read-mark
 * queues of every shape (ours, the user's own from another client, two sides that agree, settled)
 * in two accounts are written at 0180; then the prebuild (on Postgres) and the entry, twice. Every
 * pending row carries its message's account, a settled row none, no other column moves (`updated_at`
 * included), and each mailbox's queue read by its account is the queue the join gave.
 */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const split = (text: string): string[] => text.split("--> statement-breakpoint")
  .map((s) => s.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean);
const PG_0181 = split(read("../../db-mail/drizzle/0181_reconcile_pending_queue.sql"));
const rows = <T,>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];

const QUEUES = [
  { table: "folder_state", col: "outstanding_account_id",
    snapshot: "message_id, desired_folder, observed_folder, last_set_by, reconcile_status, attempts, next_attempt_at, last_error_class, updated_at" },
  { table: "flag_state", col: "pending_account_id",
    snapshot: "message_id, desired_seen, observed_seen, last_set_by, reconcile_status, conflict, attempts, next_attempt_at, updated_at" },
] as const;
const SNAPSHOT = (q: (typeof QUEUES)[number]) => `select ${q.snapshot} from ${q.table} order by message_id`;
const FILLED = (q: (typeof QUEUES)[number]) => `select t.message_id, t.${q.col} as got, m.account_id as want,
  (t.reconcile_status = 'pending') as pending from ${q.table} t join messages m on m.id = t.message_id order by t.message_id`;
const BY_JOIN = (q: (typeof QUEUES)[number]) => `select m.mailbox_id, count(*) as n from ${q.table} t join messages m on m.id = t.message_id
  where t.reconcile_status = 'pending' group by m.mailbox_id order by m.mailbox_id`;
const BY_ACCOUNT = (q: (typeof QUEUES)[number]) => `select m.mailbox_id, count(*) as n from ${q.table} t join messages m on m.id = t.message_id
  where t.reconcile_status = 'pending' and t.${q.col} = (select account_id from mailboxes where id = m.mailbox_id)
  group by m.mailbox_id order by m.mailbox_id`;

const N = "cast(substr(body_hash, 3) as integer)";
/**
 * Thirty messages per mailbox. Moves: every fifth an outstanding filing of ours, every seventh the
 * user's own, every eleventh one whose sides agree, the rest settled. Read marks: every third ours,
 * every fourth the user's own, the rest settled.
 */
function seedSql(account: string, mailbox: string, n: number): string[] {
  const values = Array.from({ length: n }, (_x, i) =>
    `('${randomUUID()}', '${account}', '${mailbox}', 'mid:<${mailbox}-${i + 1}@example.test>', 'h-${i + 1}')`);
  return [
    `insert into messages (id, account_id, mailbox_id, dedup_key, body_hash) values ${values.join(", ")}`,
    `insert into folder_state (message_id, desired_folder, observed_folder, last_set_by, reconcile_status, attempts, updated_at)
      select id,
        case when ${N} % 5 = 0 then 'ohmail/News' when ${N} % 7 = 0 then 'Archive' else 'INBOX' end, 'INBOX',
        case when ${N} % 5 <> 0 and ${N} % 7 = 0 then 'external' else 'us' end,
        case when ${N} % 5 = 0 or ${N} % 7 = 0 or ${N} % 11 = 0 then 'pending' else 'reconciled' end,
        ${N} % 3, UPDATED_AT
      from messages where mailbox_id = '${mailbox}'`,
    `insert into flag_state (message_id, desired_seen, observed_seen, last_set_by, reconcile_status, attempts, updated_at)
      select id, ${N} % 4 <> 0 or ${N} % 3 = 0, ${N} % 3 <> 0,
        case when ${N} % 3 <> 0 and ${N} % 4 = 0 then 'external' else 'us' end,
        case when ${N} % 3 = 0 or ${N} % 4 = 0 then 'pending' else 'reconciled' end,
        ${N} % 2, UPDATED_AT
      from messages where mailbox_id = '${mailbox}'`,
  ];
}

describe("mail 0181 on Postgres (PGlite), from 0180", () => {
  it("fills every pending row's account, changes nothing else, and replays", async () => {
    const db = await makeTestDb();
    const run = async (s: string) => rows<Record<string, unknown>>(await db.execute(sql.raw(s)));
    // Back to 0180: 0181's triggers, the read-state column and its function, and both indexes gone.
    await run("drop trigger if exists folder_state_pending_account_tg on folder_state");
    await run("drop trigger if exists flag_state_pending_account_tg on flag_state");
    await run("drop function if exists flag_state_pending_account()");
    await run("drop index if exists folder_state_pending_queue_idx");
    await run("drop index if exists flag_state_pending_queue_idx");
    await run("alter table flag_state drop column if exists pending_account_id");
    for (const account of [randomUUID(), randomUUID()]) {
      for (const j of [0, 1]) {
        const mailbox = randomUUID();
        await run(`insert into mailboxes (id, account_id, provider, address) values ('${mailbox}', '${account}', 'imap', '${mailbox}@example.test')`);
        for (const s of seedSql(account, mailbox, 30)) {
          await run(s.replace("UPDATED_AT", `'2026-11-07T08:00:00.123456Z'::timestamptz - (${N} * interval '1 minute')`));
        }
      }
    }
    const before = await Promise.all(QUEUES.map((q) => run(SNAPSHOT(q))));
    const counts = await Promise.all(QUEUES.map((q) => run(BY_JOIN(q))));
    for (const c of counts) expect(c.length).toBe(4);

    // setup-prod's order: the prebuild (the read-state column and both indexes), then the entry, twice.
    await ensureConcurrentIndexes(db as never, [FOLDER_STATE_PENDING_QUEUE_PREBUILD_SPEC, FLAG_STATE_PENDING_QUEUE_PREBUILD_SPEC],
      { label: "t", concurrently: false });
    for (let pass = 0; pass < 2; pass++) for (const s of PG_0181) await run(s);

    for (const [k, q] of QUEUES.entries()) {
      expect(await run(SNAPSHOT(q)), q.table).toEqual(before[k]);
      const filled = await run(FILLED(q));
      expect(filled.filter((r) => r.pending).length, q.table).toBe(counts[k]!.reduce((n, r) => n + Number(r.n), 0));
      for (const r of filled) expect(r.got, `${q.table} ${String(r.message_id)}`).toBe(r.pending ? r.want : null);
      expect(await run(BY_ACCOUNT(q)), q.table).toEqual(counts[k]);
      const [ix] = await run(`select indexdef from pg_indexes where indexname = '${q.table}_pending_queue_idx'`);
      expect(String(ix!.indexdef)).toContain(`(${q.col}, updated_at, message_id) WHERE (reconcile_status = 'pending'::text)`);
      const [tg] = await run(`select count(*)::int as n from pg_trigger where tgname = '${q.table}_pending_account_tg'`);
      expect(tg!.n, q.table).toBe(1);
    }
  }, 60_000);
});

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>>; run(...params: unknown[]): unknown };
  };
};

describe("mail 0181 on the device store, from 0180", () => {
  it("fills every pending row's account, changes nothing else, and replays", async () => {
    const db = new DatabaseSync(":memory:");
    const target = {
      run: async (s: string) => { db.exec(s); },
      all: async <T,>(s: string) => db.prepare(s).all() as T[],
    };
    const at = SQLITE_JOURNAL.findIndex((e) => e.name === "0181_reconcile_pending_queue.sql");
    expect(at).toBeGreaterThan(0);
    await migrateSqlite(target, SQLITE_JOURNAL.slice(0, at));
    for (const [k, account] of [randomUUID(), randomUUID()].entries()) {
      db.prepare("insert into accounts (id, name) values (?, ?)").run(account, `m0181-${k}`);
      for (const j of [0, 1]) {
        const mailbox = randomUUID();
        db.prepare("insert into mailboxes (id, account_id, provider, address) values (?, ?, 'imap', ?)").run(mailbox, account, `${k}-${j}@example.test`);
        for (const s of seedSql(account, mailbox, 30)) db.exec(s.replace("UPDATED_AT", `1794038400123 - ${N} * 60000`));
      }
    }
    const before = QUEUES.map((q) => db.prepare(SNAPSHOT(q)).all());
    const counts = QUEUES.map((q) => db.prepare(BY_JOIN(q)).all());
    for (const c of counts) expect(c.length).toBe(4);

    // The owed tail comes from the journal, so a later entry does not redden this file.
    const applied = await migrateSqlite(target);
    expect(applied).toEqual(SQLITE_JOURNAL.slice(at).map((e) => e.name));
    expect(applied[0]).toBe("0181_reconcile_pending_queue.sql");
    // Replayed: every statement but the column's, which the ledger never runs twice.
    for (const e of SQLITE_JOURNAL.slice(at)) for (const s of e.statements) if (!/^ALTER TABLE/i.test(s)) db.exec(s);

    for (const [k, q] of QUEUES.entries()) {
      expect(db.prepare(SNAPSHOT(q)).all(), q.table).toEqual(before[k]);
      const filled = db.prepare(FILLED(q)).all();
      expect(filled.filter((r) => r.pending).length, q.table).toBe(counts[k]!.reduce((n, r) => n + Number(r.n), 0));
      for (const r of filled) expect(r.got, `${q.table} ${String(r.message_id)}`).toBe(r.pending ? r.want : null);
      expect(db.prepare(BY_ACCOUNT(q)).all(), q.table).toEqual(counts[k]);
    }
  });
});
