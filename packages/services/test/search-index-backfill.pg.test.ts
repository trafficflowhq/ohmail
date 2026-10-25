import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { brandDialect, dialect } from "@trafficflow/db/dialect";
import { accounts, accountSettings, attachments, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions } from "@trafficflow/db/admin";
import { pgTestUrl, MIGRATED_DB_SETUP_BUDGET_MS } from "@trafficflow/db/testing";
import { inArray } from "drizzle-orm";
import {
  SEARCH_BODY_MAX_CHARS, SEARCH_DOCUMENT_SHAPE_AT, searchDocumentOf, searchIndexBackfillPass, searchIndexBuilt, searchIndexOwedAccounts,
  searchIndexProgress, searchInputsFromStore,
} from "@trafficflow/core/mail";

/* @reads: packages/core/src/message-search.ts
   Read as text by a path built at runtime, so no landing pass selects this file when it moves. */
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * THE STORE-ONLY BACKFILL (`search_index_backfill`) — real Postgres. Nine messages written the way
 * mail ingested before mail 0125 is stored (bodies, no documents): text, HTML-only, empty, one with
 * an attachment, one tombstoned. The pass fills them newest first in bounded rounds, writes the
 * marker once the living set is covered, and never needs a mailbox.
 */
const PG_URL = pgTestUrl(import.meta.url);
const client = postgres(PG_URL, { max: 3, onnotice: () => {} });
const db = brandDialect(drizzle(client, { schema }), "pg");
const A = randomUUID();
const ids: string[] = [];

const docs = async (): Promise<Array<{ id: string; source: string; terms: string }>> =>
  (await db.execute(sql`select message_id as id, source, terms from message_search where account_id = ${A}`)) as never;

describe("the search index backfill (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(PG_URL);
    await ensureSearchExtensions(db, { concurrently: false });
    const [mb] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "b@tf.example" }).returning();
    for (let i = 0; i < 9; i++) {
      const [m] = await db.insert(messages).values({
        accountId: A, mailboxId: mb!.id, bodyHash: "h", dedupKey: `bf:${i}`, subject: `Backfill ${i}`,
        fromAddress: `s${i}@club.example`, toAddresses: [{ name: "Claims Desk", address: "claims@axa.example" }],
        date: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 86_400_000),
        nativeLocator: { folder: "INBOX", ref: `1:${i}` }, ...(i === 4 ? { deletedAt: new Date() } : {}),
      }).returning();
      ids.push(m!.id);
      const body = i === 7 ? { text: "", html: "<p>marzipan only in html</p>" }
        : i === 2 ? { text: "", html: null } : { text: `plain words ${i}`, html: null };
      await db.insert(messageBodies).values({ messageId: m!.id, ...body });
      if (i === 5) await db.insert(attachments).values({ accountId: A, messageId: m!.id, filename: "quince-invoice.pdf", contentType: "application/pdf" });
    }
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    await db.execute(sql`delete from message_search where account_id = ${A}`);
    await db.execute(sql`delete from attachments where account_id = ${A}`);
    await db.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${A})`);
    await db.execute(sql`delete from messages where account_id = ${A}`);
    await db.execute(sql`delete from mailboxes where account_id = ${A}`);
    await db.execute(sql`delete from account_settings where account_id = ${A}`);
    await client.end({ timeout: 5 });
  });

  it("fills newest first in bounded rounds, then writes the marker once, and only once", async () => {
    expect(await searchIndexProgress(db as never, A)).toEqual({ done: 0, total: 8 });
    const first = await searchIndexBackfillPass({ db: db as never, accountId: A, batch: 2, rounds: 2 });
    expect(first).toMatchObject({ ran: true, written: 4, rounds: 2, marked: false });
    // The newest four living messages (8, 7, 6, 5 — 4 is tombstoned) are the ones built.
    expect(new Set((await docs()).map((d) => d.id))).toEqual(new Set([ids[8], ids[7], ids[6], ids[5]]));
    expect(await searchIndexProgress(db as never, A)).toEqual({ done: 4, total: 8 });
    const second = await searchIndexBackfillPass({ db: db as never, accountId: A, batch: 2, rounds: 5 });
    expect(second).toMatchObject({ ran: true, written: 4, marked: true });
    expect(await searchIndexBuilt(db as never, A)).toBe(true);
    expect(await searchIndexBackfillPass({ db: db as never, accountId: A })).toMatchObject({ ran: false, written: 0 });
    expect((await docs()).map((d) => d.id)).not.toContain(ids[4]);
  });

  it("builds from the STORE: html-derived words, no-body headers, recipients and file names", async () => {
    const byId = new Map((await docs()).map((d) => [d.id, d]));
    expect(byId.get(ids[7]!)!.source).toBe("html");
    expect(byId.get(ids[2]!)!.source).toBe("headers_only");
    expect(byId.get(ids[0]!)!.source).toBe("text");
    expect(byId.get(ids[5]!)!.terms).toContain("quince-invoice.pdf");
    expect(byId.get(ids[0]!)!.terms).toContain("claims@axa.example");
    const svc = new SearchService();
    const ctx: ServiceContext = { db, accountId: A, userId: null, now: () => new Date(), requestId: "bf" } as never;
    expect((await svc.page(ctx, { q: "marzipan" })).items.map((m) => m.id)).toEqual([ids[7]]);
    expect((await svc.page(ctx, { q: "quince" })).items.map((m) => m.id)).toEqual([ids[5]]);
  });

  const BEFORE = new Date(SEARCH_DOCUMENT_SHAPE_AT.getTime() - 30 * 86_400_000);
  /** A letter's document as the writer built it before the shape: each file name one word of the head, the text the body alone, built then. */
  const builtBefore = async (id: string): Promise<void> => {
    const [stored] = await searchInputsFromStore(db as never, A, [id]);
    const input = stored!.input;
    const old = dialect(db).search.document({ ...searchDocumentOf(input).parts, attachments: input.attachmentNames.join(" "), body: input.bodyText })!;
    await db.execute(sql`update message_search set head_tsv = ${old.head}, text_tsv = ${old.text}, built_at = ${BEFORE.toISOString()}::timestamptz
      where message_id = ${id}`);
  };
  const exact = async (q: string): Promise<string[]> => {
    const ctx: ServiceContext = { db, accountId: A, userId: null, now: () => new Date(), requestId: "bf" } as never;
    const r = await new SearchService().search(ctx, { q, parts: "page" });
    return r.tier === "exact" ? r.items.map((m) => m.id).sort() : [];
  };

  it("refills a document an older writer built: one pass and the letter is found by a part of its file name beside another word", async () => {
    await builtBefore(ids[5]!);
    await db.execute(sql`update account_settings set search_index_built_at = ${BEFORE.toISOString()}::timestamptz where account_id = ${A}`);
    expect(await exact("plain invoice")).toEqual([]);
    expect(await searchIndexBackfillPass({ db: db as never, accountId: A })).toMatchObject({ ran: true, written: 1, marked: true });
    expect(await exact("plain invoice")).toEqual([ids[5]]);
    // The marker is the shape's now: nothing is owed, and nothing is read.
    expect(await searchIndexBackfillPass({ db: db as never, accountId: A })).toMatchObject({ ran: false, written: 0 });
  });

  it("the refill keeps the backfill's bound: newest first, batch × rounds a pass, the marker after the last", async () => {
    for (const i of [8, 6, 3]) await db.insert(attachments).values({ accountId: A, messageId: ids[i]!, filename: `fig-${i}-ledger.pdf`, contentType: "application/pdf" });
    for (const i of [8, 6, 5, 3, 1]) await builtBefore(ids[i]!);
    await db.execute(sql`update account_settings set search_index_built_at = ${BEFORE.toISOString()}::timestamptz where account_id = ${A}`);
    const built = async (): Promise<string[]> => ((await db.execute(sql`select message_id as id from message_search
      where account_id = ${A} and built_at >= ${SEARCH_DOCUMENT_SHAPE_AT.toISOString()}::timestamptz`)) as unknown as Array<{ id: string }>).map((r) => r.id);
    const before = await built();
    // 1 has no file name: its document has no part to gain, so it is not owed again.
    expect(await searchIndexBackfillPass({ db: db as never, accountId: A, batch: 1, rounds: 2 })).toMatchObject({ ran: true, written: 2, rounds: 2, marked: false });
    expect((await built()).filter((id) => !before.includes(id)).sort()).toEqual([ids[8], ids[6]].sort());
    expect(await searchIndexBackfillPass({ db: db as never, accountId: A, batch: 1, rounds: 5 })).toMatchObject({ ran: true, written: 2, marked: true });
    expect(await exact("ledger plain")).toEqual([ids[8], ids[6], ids[3]].sort());
    expect((await built()).includes(ids[1]!)).toBe(false);
  });

  it("takes no mailbox: the pass's arguments carry no adapter, and its module imports none", () => {
    const src = readFileSync(new URL("../../core/src/message-search.ts", import.meta.url), "utf8");
    const sig = src.slice(src.indexOf("export async function searchIndexBackfillPass"), src.indexOf("): Promise<SearchIndexBackfillResult>"));
    expect(sig).toContain("accountId: string");
    expect(sig).not.toMatch(/adapter|imap|lease/i);
    expect(src).not.toMatch(/from\s+"[^"]*(adapters\/imap|imapflow|lease)[^"]*"/);
  });
});

/**
 * WHICH ACCOUNTS THE TAIL'S BACKFILL SECTION VISITS: living mail and no marker, or a marker older
 * than the document's shape, nothing else. An account whose messages are all tombstoned owes
 * nothing, and neither does one whose marker is written in the present shape. The caller's `shard`
 * predicate narrows the list and the limit bounds it. The store read is bounded too: a body longer
 * than the document keeps is read only as far as it keeps.
 */
describe("the accounts the backfill owes (real Postgres)", () => {
  const owedA = randomUUID(), owedB = randomUUID(), done = randomUUID(), gone = randomUUID(), empty = randomUUID(), older = randomUUID();
  const mine = [owedA, owedB, done, gone, empty, older];
  // Its own connection: the describe above ends the shared one in its afterAll.
  const ownClient = postgres(PG_URL, { max: 2, onnotice: () => {} });
  const own = brandDialect(drizzle(ownClient, { schema }), "pg");
  let longId = "";

  beforeAll(async () => {
    await runMigrations(PG_URL);
    for (const id of mine) await own.insert(accounts).values({ id, name: "owed" });
    for (const id of [owedA, owedB, done, gone, older]) {
      const [mb] = await own.insert(mailboxes).values({ accountId: id, provider: "imap", address: `${id}@tf.example` }).returning();
      const [m] = await own.insert(messages).values({
        accountId: id, mailboxId: mb!.id, bodyHash: "h", dedupKey: `owed:${id}`, subject: "Owed",
        fromAddress: "o@club.example", nativeLocator: { folder: "INBOX", ref: "1:1" },
        ...(id === gone ? { deletedAt: new Date() } : {}),
      }).returning();
      if (id === owedA) longId = m!.id;
      await own.insert(messageBodies).values({ messageId: m!.id, text: id === owedA ? `lead ${"w".repeat(SEARCH_BODY_MAX_CHARS * 2)}` : "short", html: null });
    }
    await own.insert(accountSettings).values({ accountId: done, searchIndexBuiltAt: SEARCH_DOCUMENT_SHAPE_AT });
    await own.insert(accountSettings).values({ accountId: older, searchIndexBuiltAt: new Date(SEARCH_DOCUMENT_SHAPE_AT.getTime() - 1) });
  });

  afterAll(async () => {
    await own.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id in (${sql.join(mine.map((i) => sql`${i}::uuid`), sql`, `)}))`);
    await own.delete(messages).where(inArray(messages.accountId, mine));
    await own.delete(mailboxes).where(inArray(mailboxes.accountId, mine));
    await own.delete(accountSettings).where(inArray(accountSettings.accountId, mine));
    await own.delete(accounts).where(inArray(accounts.id, mine));
    await ownClient.end({ timeout: 5 });
  });

  it("lists living mail without a marker or with one older than the shape, and neither a built account, an all-tombstoned one nor an empty one", async () => {
    const listed = await searchIndexOwedAccounts(own as never, { limit: 1000, shard: inArray(accounts.id, mine) });
    expect(listed.sort()).toEqual([owedA, owedB, older].sort());
  });

  it("the shard predicate narrows the list and the limit bounds it", async () => {
    expect(await searchIndexOwedAccounts(own as never, { limit: 1000, shard: inArray(accounts.id, [owedB, done]) })).toEqual([owedB]);
    expect(await searchIndexOwedAccounts(own as never, { limit: 1, shard: inArray(accounts.id, mine) })).toHaveLength(1);
  });

  it("reads a long body only as far as the document keeps it, and the document still starts with its words", async () => {
    const [row] = await searchInputsFromStore(own as never, owedA, [longId]);
    expect(row!.input.bodyText).toHaveLength(SEARCH_BODY_MAX_CHARS);
    expect(row!.input.bodyText.startsWith("lead w")).toBe(true);
  });
});
