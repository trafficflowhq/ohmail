import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mailboxes, messages } from "../src/schema-mail.js";
import { makeTestDb } from "../src/testing.js";

/**
 * MAIL 0154 ON POSTGRES (PGlite here): the recipients are indexed by an IMMUTABLE function over the
 * columns that already hold them, so a row written before the migration is found the moment the
 * index exists — no column, no UPDATE, nothing to backfill. The function's output is pinned: the
 * account prefix, lowercase, one key per address, and every entry it must skip.
 */
const STATEMENTS = readFileSync(fileURLToPath(new URL("../../db-mail/drizzle/0154_messages_recipient_keys.sql", import.meta.url)), "utf8")
  .split("--> statement-breakpoint").map((s) => s.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean);

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const rows = <T,>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];
const keysOf = async (db: Db, account: string, to: string, cc: string): Promise<string[]> =>
  rows<{ k: string[] }>(await db.execute(sql`select messages_recipient_keys(${account}::uuid, ${to}::jsonb, ${cc}::jsonb) as k`))[0]!.k;
const long = (n: number) => `${"x".repeat(n - "@acme.test".length)}@acme.test`;

describe("mail 0154: the recipient keys", () => {
  it("rows written before the index are found through it once 0154 applies, and 0154 replays", async () => {
    const db = await makeTestDb();
    await db.execute(sql`drop index if exists messages_recipient_keys_idx`);
    await db.execute(sql`drop function if exists messages_recipient_keys(uuid, jsonb, jsonb)`);
    const a = randomUUID();
    const b = randomUUID();
    const [mbA] = await db.insert(mailboxes).values({ accountId: a, provider: "imap", address: "a@tf.test" }).returning();
    const [mbB] = await db.insert(mailboxes).values({ accountId: b, provider: "imap", address: "b@tf.test" }).returning();
    const [mine] = await db.insert(messages).values({
      accountId: a, mailboxId: mbA!.id, bodyHash: "h", dedupKey: `d:${randomUUID()}`, fromAddress: "s@acme.test",
      toAddresses: [{ name: null, address: "Info@ACME.test" }], ccAddresses: [],
    }).returning();
    await db.insert(messages).values({
      accountId: b, mailboxId: mbB!.id, bodyHash: "h", dedupKey: `d:${randomUUID()}`, fromAddress: "s@acme.test",
      toAddresses: [{ name: null, address: "info@acme.test" }], ccAddresses: [],
    });
    for (let pass = 0; pass < 2; pass++) for (const s of STATEMENTS) await db.execute(sql.raw(s));
    const found = rows<{ id: string }>(await db.execute(sql`select m.id from messages m
      where messages_recipient_keys(m.account_id, m.to_addresses, m.cc_addresses) @> array[${a}::text || ':' || lower(${"INFO@acme.test"})]`));
    expect(found.map((r) => r.id)).toEqual([mine!.id]);
    const ix = rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from pg_indexes where indexname = 'messages_recipient_keys_idx'`));
    expect(ix[0]!.n).toBe(1);
  });

  it("the function: account-prefixed, lowercased, deduplicated, and blind to what is not an address", async () => {
    const db = await makeTestDb();
    const a = "5eed0000-0000-4000-8000-00000000000a";
    const to = JSON.stringify([
      { name: null, address: "Info@ACME.test" }, "bare@acme.test", { name: "none" }, { name: null, address: "" },
      { name: null, address: long(300) }, { name: null, address: long(3000) }, { name: null, address: null },
    ]);
    const cc = JSON.stringify([{ name: null, address: "info@acme.test" }, { name: null, address: long(254).toUpperCase() }]);
    expect((await keysOf(db, a, to, cc)).sort()).toEqual([`${a}:info@acme.test`, `${a}:${long(254)}`].sort());
    expect(await keysOf(db, a, "[]", "[]")).toEqual([]);
    expect(await keysOf(db, a, '{"address":"x@acme.test"}', '"x@acme.test"')).toEqual([]);
  });
});
