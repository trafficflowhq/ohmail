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
import { FOLDER_STATE_OUTSTANDING_PREBUILD_SPEC, MAILBOXES_ACCOUNT_PREBUILD_SPEC } from "../src/search-setup.js";

/**
 * MAIL 0160 ON A STORE THAT PREDATES IT, on PGlite and on the device store: filings outstanding and
 * settled in two accounts are written at 0159; then the prebuild (on Postgres) and the entry, twice.
 * Every outstanding row carries its message's account, every other row stays NULL, no other column
 * moves (`updated_at` included), and the per-mailbox count read through the new index is the count
 * the old join gave.
 */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const split = (text: string): string[] => text.split("--> statement-breakpoint")
  .map((s) => s.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean);
const PG_0160 = split(read("../../db-mail/drizzle/0160_folder_state_outstanding.sql"));
const PG_0161 = split(read("../../db-mail/drizzle/0161_mailboxes_account_idx.sql"));
const rows = <T,>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];

const OUTSTANDING = `fs.reconcile_status = 'pending' and fs.last_set_by = 'us' and fs.desired_folder <> fs.observed_folder`;
/** Every column the entry must leave alone, per row. */
const SNAPSHOT = `select message_id, desired_folder, observed_folder, last_set_by, reconcile_status, attempts,
  next_attempt_at, last_error_class, updated_at from folder_state order by message_id`;
const FILLED = `select fs.message_id, fs.outstanding_account_id as got, m.account_id as want, (${OUTSTANDING}) as outstanding
  from folder_state fs join messages m on m.id = fs.message_id order by fs.message_id`;
const BY_JOIN = `select m.mailbox_id, count(*) as n from folder_state fs join messages m on m.id = fs.message_id
  where ${OUTSTANDING} group by m.mailbox_id order by m.mailbox_id`;
const BY_INDEX = `select m.mailbox_id, count(*) as n from folder_state fs join messages m on m.id = fs.message_id
  where ${OUTSTANDING} and fs.outstanding_account_id = m.account_id group by m.mailbox_id order by m.mailbox_id`;

/** Thirty messages per mailbox; every fifth an outstanding filing, every seventh an external one. */
function seedSql(account: string, mailbox: string, n: number): { messages: string; filing: string } {
  const g = Array.from({ length: n }, (_x, i) => i + 1);
  const messages = g.map((i) => `('${randomUUID()}', '${account}', '${mailbox}', 'mid:<${mailbox}-${i}@example.test>', 'h-${i}')`);
  return {
    messages: `insert into messages (id, account_id, mailbox_id, dedup_key, body_hash) values ${messages.join(", ")}`,
    filing: `insert into folder_state (message_id, desired_folder, observed_folder, last_set_by, reconcile_status, attempts, updated_at)
      select id,
        case when cast(substr(body_hash, 3) as integer) % 5 = 0 then 'ohmail/News' else 'Archive' end,
        case when cast(substr(body_hash, 3) as integer) % 7 = 0 then 'INBOX' else 'Archive' end,
        case when cast(substr(body_hash, 3) as integer) % 7 = 0 then 'external' else 'us' end,
        case when cast(substr(body_hash, 3) as integer) % 5 = 0 or cast(substr(body_hash, 3) as integer) % 7 = 0 then 'pending' else 'reconciled' end,
        cast(substr(body_hash, 3) as integer) % 3,
        UPDATED_AT
      from messages where mailbox_id = '${mailbox}'`,
  };
}

describe("mail 0160 on Postgres (PGlite), from 0159", () => {
  it("fills the outstanding filings alone, changes nothing else, and replays", async () => {
    const db = await makeTestDb();
    const run = async (s: string) => rows<Record<string, unknown>>(await db.execute(sql.raw(s)));
    // Back to 0159: no trigger, no function, no index, no column; and 0161's index gone.
    await run("drop trigger if exists folder_state_outstanding_account_tg on folder_state");
    await run("drop function if exists folder_state_outstanding_account()");
    await run("drop index if exists folder_state_outstanding_idx");
    await run("alter table folder_state drop column outstanding_account_id");
    await run("drop index if exists mailboxes_account_idx");
    const accounts = [randomUUID(), randomUUID()];
    for (const [k, account] of accounts.entries()) {
      for (const j of [0, 1]) {
        const mailbox = randomUUID();
        await run(`insert into mailboxes (id, account_id, provider, address) values ('${mailbox}', '${account}', 'imap', '${k}-${j}@example.test')`);
        const s = seedSql(account, mailbox, 30);
        await run(s.messages);
        await run(s.filing.replace("UPDATED_AT", "'2026-10-21T08:00:00.123456Z'::timestamptz - (cast(substr(body_hash, 3) as integer) * interval '1 minute')"));
      }
    }
    const before = await run(SNAPSHOT);
    const counts = await run(BY_JOIN);
    expect(counts.length).toBe(4);

    // setup-prod's order: the prebuild (the column and the index), then the journal entries, twice.
    await ensureConcurrentIndexes(db as never, [FOLDER_STATE_OUTSTANDING_PREBUILD_SPEC, MAILBOXES_ACCOUNT_PREBUILD_SPEC],
      { label: "t", concurrently: false });
    for (let pass = 0; pass < 2; pass++) for (const s of [...PG_0160, ...PG_0161]) await run(s);

    expect(await run(SNAPSHOT)).toEqual(before);
    const filled = await run(FILLED);
    expect(filled.filter((r) => r.outstanding).length).toBe(Number(counts.reduce((n, r) => n + Number(r.n), 0)));
    for (const r of filled) expect(r.got, String(r.message_id)).toBe(r.outstanding ? r.want : null);
    expect(await run(BY_INDEX)).toEqual(counts);
    const ix = await run(`select indexname from pg_indexes where indexname in ('folder_state_outstanding_idx', 'mailboxes_account_idx') order by 1`);
    expect(ix.map((r) => r.indexname)).toEqual(["folder_state_outstanding_idx", "mailboxes_account_idx"]);
    const tg = await run(`select count(*)::int as n from pg_trigger where tgname = 'folder_state_outstanding_account_tg'`);
    expect(tg[0]!.n).toBe(1);
  }, 60_000);
});

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>>; run(...params: unknown[]): unknown };
  };
};

describe("mail 0160 on the device store, from 0159", () => {
  it("fills the outstanding filings alone, changes nothing else, and replays", async () => {
    const db = new DatabaseSync(":memory:");
    const target = {
      run: async (s: string) => { db.exec(s); },
      all: async <T,>(s: string) => db.prepare(s).all() as T[],
    };
    const at = SQLITE_JOURNAL.findIndex((e) => e.name === "0160_folder_state_outstanding.sql");
    expect(at).toBeGreaterThan(0);
    await migrateSqlite(target, SQLITE_JOURNAL.slice(0, at));
    const accounts = [randomUUID(), randomUUID()];
    for (const [k, account] of accounts.entries()) {
      db.prepare("insert into accounts (id, name) values (?, ?)").run(account, `m0160-${k}`);
      for (const j of [0, 1]) {
        const mailbox = randomUUID();
        db.prepare("insert into mailboxes (id, account_id, provider, address) values (?, ?, 'imap', ?)").run(mailbox, account, `${k}-${j}@example.test`);
        const s = seedSql(account, mailbox, 30);
        db.exec(s.messages);
        db.exec(s.filing.replace("UPDATED_AT", "1792396800123 - cast(substr(body_hash, 3) as integer) * 60000"));
      }
    }
    const before = db.prepare(SNAPSHOT).all();
    const counts = db.prepare(BY_JOIN).all();
    expect(counts.length).toBe(4);

    expect(await migrateSqlite(target)).toEqual([
      "0160_folder_state_outstanding.sql", "0161_mailboxes_account_idx.sql", "0162_outbound_sends_offer_state.sql",
      "0163_folder_state_fresh_intent.sql",
    ]);
    // Replayed: every statement but the column's, which the ledger never runs twice.
    for (const e of SQLITE_JOURNAL.slice(at)) for (const s of e.statements) if (!/^ALTER TABLE/i.test(s)) db.exec(s);

    expect(db.prepare(SNAPSHOT).all()).toEqual(before);
    const filled = db.prepare(FILLED).all();
    expect(filled.filter((r) => r.outstanding).length).toBe(counts.reduce((n, r) => n + Number(r.n), 0));
    for (const r of filled) expect(r.got, String(r.message_id)).toBe(r.outstanding ? r.want : null);
    expect(db.prepare(BY_INDEX).all()).toEqual(counts);
  });
});
