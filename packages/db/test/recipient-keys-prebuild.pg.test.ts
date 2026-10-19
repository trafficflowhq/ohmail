import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations, readJournalOf, MAIL_JOURNAL } from "../src/admin.js";
import { ensureConcurrentIndexes } from "../src/concurrent-index.js";
import { ensureWithheldProvenanceIndex, RECIPIENT_KEYS_PREBUILD_SPEC } from "../src/search-setup.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * MAIL 0154's INDEX IS BUILT AHEAD OF THE MIGRATOR, ON REAL POSTGRES. The prebuild runs before
 * `runMigrations`, so on a database at 0153 the function its index names does not exist yet: the
 * spec's prelude creates it under the migration lock, the index builds CONCURRENTLY, and the
 * journal's `if not exists` then finds it. Without the prelude the build is 42883 and the setup
 * stops ahead of the migrator — the control below shows exactly that.
 */
const SUFFIX = randomUUID().replace(/-/g, "").slice(0, 12);
const PG_UP = await realPgAvailable(PG_TEST_URL);
const ENTRY = readJournalOf(MAIL_JOURNAL).find((e) => e.tag === "0154_messages_recipient_keys");
const urlFor = (name: string): string => { const u = new URL(PG_TEST_URL); u.pathname = `/${name}`; return u.toString(); };

describe.skipIf(!PG_UP)("mail 0154's prebuild on a database at 0153", () => {
  let admin: ReturnType<typeof postgres>;
  const created: string[] = [];

  /** A migrated database rewound to 0153: 0154's objects and bookkeeping row gone. */
  async function at0153(tag: string) {
    const name = `ohmail_recipkeys_${tag}_${SUFFIX}`;
    await admin.unsafe(`create database "${name}"`);
    created.push(name);
    const url = urlFor(name);
    await runMigrations(url);
    const client = postgres(url, { max: 1, onnotice: () => {} });
    const db = brandDialect(drizzle(client), "pg");
    await db.execute(sql`drop index if exists public.messages_recipient_keys_idx`);
    await db.execute(sql`drop function if exists public.messages_recipient_keys(uuid, jsonb, jsonb)`);
    await db.execute(sql`delete from drizzle_mail.__drizzle_migrations where created_at >= ${ENTRY!.when}`);
    return { url, db, client };
  }

  const state = async (db: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }) => (await db.execute(sql`
    select i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
     where c.relname = 'messages_recipient_keys_idx'`)) as unknown as Array<{ valid: boolean }>;

  beforeAll(async () => {
    expect(ENTRY, "0154 must be in the mail journal").toBeDefined();
    admin = postgres(PG_TEST_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(created.map((name) => admin?.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {})));
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, 60_000);

  it("the prebuild creates the function and builds the index; the migrator then leaves one valid index", async () => {
    const { url, db, client } = await at0153("ok");
    try {
      const logs: string[] = [];
      await ensureWithheldProvenanceIndex(db, { log: (m) => logs.push(m) });
      expect(logs).toContain("messages_recipient_keys_idx: building concurrently on messages");
      expect(await state(db)).toEqual([{ valid: true }]);
      await runMigrations(url);
      expect(await state(db)).toEqual([{ valid: true }]);
      const applied = (await db.execute(sql`select count(*)::int as n from drizzle_mail.__drizzle_migrations
        where created_at = ${ENTRY!.when}`)) as unknown as Array<{ n: number }>;
      expect(applied[0]!.n).toBe(1);
      // A second setup run finds it present and valid and builds nothing.
      const again: string[] = [];
      await ensureWithheldProvenanceIndex(db, { log: (m) => again.push(m) });
      expect(again.filter((m) => m.startsWith("messages_recipient_keys_idx"))).toEqual([]);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 120_000);

  it("CONTROL: the same spec without its prelude fails 42883 on a database at 0153", async () => {
    const { db, client } = await at0153("bare");
    try {
      const { prelude: _drop, ...bare } = RECIPIENT_KEYS_PREBUILD_SPEC;
      const code = await ensureConcurrentIndexes(db, [bare], { label: "control" })
        .then(() => "built", (e: unknown) => String((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code));
      expect(code).toBe("42883");
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 120_000);
});
