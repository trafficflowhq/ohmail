import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations, readJournalOf, MAIL_JOURNAL } from "../src/admin.js";
import { ensureWithheldProvenanceIndex } from "../src/search-setup.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * MAIL 0160 AND 0161 ARE BUILT AHEAD OF THE MIGRATOR, ON REAL POSTGRES. On a database at 0159 the
 * prebuild adds the column (its prelude) and builds both indexes CONCURRENTLY; the migrator then
 * finds them, adds the trigger and backfills; a second setup run builds nothing, and takes no lock
 * a writer would wait on: it completes while another session holds `folder_state` as a writer does.
 */
const SUFFIX = randomUUID().replace(/-/g, "").slice(0, 12);
const PG_UP = await realPgAvailable(PG_TEST_URL);
const NAMES = ["folder_state_outstanding_idx", "mailboxes_account_idx"];
const ENTRY = readJournalOf(MAIL_JOURNAL).find((e) => e.tag === "0160_folder_state_outstanding");
const urlFor = (name: string): string => { const u = new URL(PG_TEST_URL); u.pathname = `/${name}`; return u.toString(); };

describe.skipIf(!PG_UP)("mail 0160 and 0161's prebuild on a database at 0159", () => {
  let admin: ReturnType<typeof postgres>;
  const created: string[] = [];

  beforeAll(async () => {
    admin = postgres(PG_TEST_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(created.map((name) => admin?.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {})));
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, 60_000);

  it("the prebuild adds the column and builds both concurrently; the migrator fills; a rerun takes no lock", async () => {
    expect(ENTRY, "0160 must be in the mail journal").toBeDefined();
    const name = `ohmail_fsoprebuild_${SUFFIX}`;
    await admin.unsafe(`create database "${name}"`);
    created.push(name);
    const url = urlFor(name);
    await runMigrations(url);
    const client = postgres(url, { max: 1, onnotice: () => {} });
    const writer = postgres(url, { max: 1, onnotice: () => {} });
    const db = brandDialect(drizzle(client), "pg");
    const rows = async <T,>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];
    const state = () => rows<{ name: string; valid: boolean }>(sql`
      select c.relname as name, i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname in ('folder_state_outstanding_idx', 'mailboxes_account_idx') order by 1`);
    try {
      // Rewound to 0159: trigger, function, indexes, column and the two bookkeeping rows gone; one
      // outstanding filing written at 0159.
      await db.execute(sql`drop trigger if exists folder_state_outstanding_account_tg on folder_state`);
      await db.execute(sql`drop function if exists folder_state_outstanding_account()`);
      await db.execute(sql`drop index if exists public.folder_state_outstanding_idx`);
      await db.execute(sql`drop index if exists public.mailboxes_account_idx`);
      await db.execute(sql`alter table folder_state drop column outstanding_account_id`);
      await db.execute(sql`delete from drizzle_mail.__drizzle_migrations where created_at >= ${ENTRY!.when}`);
      const account = randomUUID();
      await db.execute(sql`insert into mailboxes (id, account_id, provider, address) values (${account}, ${account}, 'imap', 'p@example.test')`);
      await db.execute(sql`insert into messages (account_id, mailbox_id, dedup_key, body_hash) values (${account}, ${account}, 'mid:<p@example.test>', 'h')`);
      await db.execute(sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
        select id, 'ohmail/News', 'INBOX', 'us' from messages where mailbox_id = ${account}`);
      expect(await state()).toEqual([]);

      const logs: string[] = [];
      await ensureWithheldProvenanceIndex(db, { log: (m) => logs.push(m) });
      for (const n of NAMES) expect(logs).toContain(`${n}: building concurrently on ${n.startsWith("folder") ? "folder_state" : "mailboxes"}`);
      expect(await state()).toEqual(NAMES.map((n) => ({ name: n, valid: true })));
      await runMigrations(url);
      expect(await state()).toEqual(NAMES.map((n) => ({ name: n, valid: true })));
      const filled = await rows<{ a: string | null }>(sql`select outstanding_account_id::text as a from folder_state`);
      expect(filled).toEqual([{ a: account }]);
      const tg = await rows<{ n: number }>(sql`select count(*)::int as n from pg_trigger where tgname = 'folder_state_outstanding_account_tg'`);
      expect(tg[0]!.n).toBe(1);

      // A writer holds folder_state; a second setup run neither builds nor waits on it.
      const held = writer.begin(async (tx) => {
        await tx`lock table public.folder_state in row exclusive mode`;
        await new Promise((r) => setTimeout(r, 4_000));
      });
      await new Promise((r) => setTimeout(r, 300));
      const again: string[] = [];
      const t0 = Date.now();
      await ensureWithheldProvenanceIndex(db, { log: (m) => again.push(m) });
      expect(Date.now() - t0, "the rerun waited on the writer").toBeLessThan(3_000);
      await held;
      expect(again.filter((m) => NAMES.some((n) => m.startsWith(n)))).toEqual([]);
    } finally {
      await writer.end({ timeout: 5 });
      await client.end({ timeout: 5 });
    }
  }, 120_000);
});
