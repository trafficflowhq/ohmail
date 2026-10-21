import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { mailboxes, messages, messageBodies, folderState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions } from "@trafficflow/db/admin";
import { pgTestUrl } from "@trafficflow/db/testing";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * ß AND ss FIND EACH OTHER on the server — real Postgres with pg_trgm, the hosted
 * and self-hosted store. The twin of `search-eszett-fold.test.ts` (PGlite and the device), with the
 * same corpus, on this file's own random account.
 */
const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 2 });
const db = brandDialect(drizzle(client, { schema }), "pg");
const NOW = new Date("2026-09-23T12:00:00.000Z");
const A = randomUUID();
const keyOf = new Map<string, string>();
const ctx: ServiceContext = { db, accountId: A, userId: null, now: () => NOW, requestId: "search-eszett-fold" };

const CORPUS: ReadonlyArray<readonly [key: string, subject: string, body: string]> = [
  ["eszett-body", "Fahrplan", "Die Straßenbahn fährt ab Montag später."],
  ["ss-subject", "Strassenbahn Linie 4", "Neue Haltestelle."],
  ["eszett-street", "Umzug", "Neue Adresse: Schloßstraße 9."],
  ["decoy", "A stranger at the door", "Nothing about trams."],
];

async function found(q: string): Promise<{ tier: string; keys: string[] }> {
  const r = await new SearchService().search(ctx, { q, limit: 50 });
  return { tier: r.tier, keys: r.items.map((m) => keyOf.get(m.id)!).sort() };
}

describe("the ß/ss fold on the server (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    await ensureSearchExtensions(db, { concurrently: false });
    const [mb] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "eszett@tf.example" }).returning();
    for (const [i, [key, subject, body]] of CORPUS.entries()) {
      const [m] = await db.insert(messages).values({
        accountId: A, mailboxId: mb!.id, bodyHash: "h", dedupKey: `eszett:${randomUUID()}`, subject,
        fromAddress: `s${i}@site.example`, date: new Date(NOW.getTime() - (i + 1) * 86_400_000),
        unread: false, hasAttachments: false, nativeLocator: { folder: "INBOX", ref: `1:${i + 1}` },
      }).returning();
      await db.insert(messageBodies).values({ messageId: m!.id, text: body });
      await db.insert(folderState).values({ messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
      keyOf.set(m!.id, key);
    }
    expect((await searchIndexBackfillPass({ db: db as never, accountId: A })).marked).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await db.execute(sql`delete from message_search where account_id = ${A}::uuid`);
    await db.execute(sql`delete from account_settings where account_id = ${A}::uuid`);
    await db.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${A}::uuid)`);
    await db.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${A}::uuid)`);
    await db.execute(sql`delete from messages where account_id = ${A}::uuid`);
    await db.execute(sql`delete from mailboxes where account_id = ${A}::uuid`);
    await client.end({ timeout: 5 });
  });

  it.each([
    ["Strassenbahn", ["eszett-body", "ss-subject"]],
    ["Straßenbahn", ["eszett-body", "ss-subject"]],
    ["strassenb", ["eszett-body", "ss-subject"]],
    ["Schlossstrasse", ["eszett-street"]],
  ] as const)("%s finds both spellings, in the exact tier", async (q, keys) => {
    expect(await found(q)).toEqual({ tier: "exact", keys: [...keys] });
  });

  it("a word with neither reads as before (the positive control)", async () => {
    expect(await found("Fahrplan")).toEqual({ tier: "exact", keys: ["eszett-body"] });
  });
});
