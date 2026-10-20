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
 * MAIL 0157's INDEX IS BUILT AHEAD OF THE MIGRATOR, ON REAL POSTGRES. On a database at 0156 the
 * prebuild builds the sender-date index CONCURRENTLY, the journal's `if not exists` then finds it,
 * and a second setup run builds nothing.
 */
const SUFFIX = randomUUID().replace(/-/g, "").slice(0, 12);
const PG_UP = await realPgAvailable(PG_TEST_URL);
const NAME = "messages_account_sender_date_idx";
const ENTRY = readJournalOf(MAIL_JOURNAL).find((e) => e.tag === "0157_messages_sender_date");
const urlFor = (name: string): string => { const u = new URL(PG_TEST_URL); u.pathname = `/${name}`; return u.toString(); };

describe.skipIf(!PG_UP)("mail 0157's prebuild on a database at 0156", () => {
  let admin: ReturnType<typeof postgres>;
  const created: string[] = [];

  beforeAll(async () => {
    admin = postgres(PG_TEST_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(created.map((name) => admin?.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {})));
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, 60_000);

  it("the prebuild builds it concurrently; the migrator then leaves one valid index; a rerun builds nothing", async () => {
    expect(ENTRY, "0157 must be in the mail journal").toBeDefined();
    const name = `ohmail_senderdate_${SUFFIX}`;
    await admin.unsafe(`create database "${name}"`);
    created.push(name);
    const url = urlFor(name);
    await runMigrations(url);
    const client = postgres(url, { max: 1, onnotice: () => {} });
    const db = brandDialect(drizzle(client), "pg");
    const state = async () => (await db.execute(sql`
      select i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname = ${NAME}`)) as unknown as Array<{ valid: boolean }>;
    try {
      // Rewound to 0156: the index and 0157's bookkeeping row gone.
      await db.execute(sql`drop index if exists public.messages_account_sender_date_idx`);
      await db.execute(sql`delete from drizzle_mail.__drizzle_migrations where created_at >= ${ENTRY!.when}`);
      expect(await state()).toEqual([]);
      const logs: string[] = [];
      await ensureWithheldProvenanceIndex(db, { log: (m) => logs.push(m) });
      expect(logs).toContain(`${NAME}: building concurrently on messages`);
      expect(await state()).toEqual([{ valid: true }]);
      await runMigrations(url);
      expect(await state()).toEqual([{ valid: true }]);
      const applied = (await db.execute(sql`select count(*)::int as n from drizzle_mail.__drizzle_migrations
        where created_at = ${ENTRY!.when}`)) as unknown as Array<{ n: number }>;
      expect(applied[0]!.n).toBe(1);
      const again: string[] = [];
      await ensureWithheldProvenanceIndex(db, { log: (m) => again.push(m) });
      expect(again.filter((m) => m.startsWith(NAME))).toEqual([]);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 120_000);
});
