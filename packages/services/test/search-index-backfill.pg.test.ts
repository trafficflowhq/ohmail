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
import { eq, inArray } from "drizzle-orm";
import {
  SEARCH_BODY_MAX_CHARS, SEARCH_DOCUMENT_SHAPE_AT, searchDated, searchDatesFillPass, searchDatesOwedAccounts, searchDocumentOf,
  searchIndexBackfillPass, searchIndexBuilt, searchIndexOwedAccounts, searchIndexProgress, searchInputsFromStore,
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

/**
 * Where a document holds a file name: a word of its head, a word of its text whole, its first part a word
 * of its text; and whether its head is the one the writer builds now from the letter's stored headers.
 */
const vectorsOf = async (id: string, name: string): Promise<Record<string, boolean>> => {
  const [stored] = await searchInputsFromStore(db as never, A, [id]);
  const head = dialect(db).search.document(searchDocumentOf(stored!.input).parts)!.head;
  const part = name.split(/[^\p{L}\p{N}]+/u)[0]!;
  const [r] = (await db.execute(sql`select head_tsv @@ plainto_tsquery('simple', ${name}) as head,
    text_tsv @@ plainto_tsquery('english', ${name}) as text, text_tsv @@ plainto_tsquery('english', ${part}) as parts,
    head_tsv = ${head} as writers from message_search where message_id = ${id}`)) as unknown as Array<Record<string, boolean>>;
  return { ...r! };
};

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
    // The substring corpus: the header text, then the mark and the file name whole; none without a name.
    expect(byId.get(ids[5]!)!.terms).toBe("backfill 5 s5@club.example claims desk claims@axa.example\u001fquince-invoice.pdf");
    expect(byId.get(ids[0]!)!.terms).toBe("backfill 0 s0@club.example claims desk claims@axa.example");
    // The file name is a word of the text, whole and in parts, and never of the head.
    expect(await vectorsOf(ids[5]!, "quince-invoice.pdf")).toEqual({ head: false, text: true, parts: true, writers: true });
    const svc = new SearchService();
    const ctx: ServiceContext = { db, accountId: A, userId: null, now: () => new Date(), requestId: "bf" } as never;
    expect((await svc.page(ctx, { q: "marzipan" })).items.map((m) => m.id)).toEqual([ids[7]]);
    expect((await svc.page(ctx, { q: "quince" })).items.map((m) => m.id)).toEqual([ids[5]]);
  });

  const BEFORE = new Date("2026-10-01T00:00:00Z");
  /**
   * A letter's document as 0.30.16's writer built it: the file names whole as words of the head (`B`, as
   * the people), the text the body alone, the substring corpus the subject, the people and the names in
   * one run with no mark, built `at`.
   */
  const builtBefore = async (id: string, at: Date = BEFORE, body?: string): Promise<void> => {
    const [stored] = await searchInputsFromStore(db as never, A, [id]);
    const input = stored!.input;
    const { parts } = searchDocumentOf({ ...input, attachmentNames: [] });
    const names = input.attachmentNames.join(" ");
    const head = sql`(setweight(to_tsvector('english', ${parts.subject}), 'A') || setweight(to_tsvector('simple', ${parts.people}), 'B')
      || setweight(to_tsvector('simple', ${names}), 'B'))`;
    const people = [input.from, ...input.to, ...input.cc].map((a) => (a === null ? "" : `${a.name ?? ""} ${a.address}`.trim()));
    const terms = [input.subject, ...people, names].filter((t) => t.trim() !== "").join(" ").replace(/\s+/g, " ").toLowerCase().slice(0, 2048);
    await db.execute(sql`update message_search set head_tsv = ${head}, text_tsv = to_tsvector('english', ${body ?? input.bodyText}), terms = ${terms},
      built_at = ${at.toISOString()}::timestamptz where message_id = ${id}`);
  };
  const termsOf = async (id: string): Promise<string> =>
    ((await db.execute(sql`select terms from message_search where message_id = ${id}`)) as unknown as Array<{ terms: string }>)[0]!.terms;
  const markerAt = (at: Date) => db.execute(sql`update account_settings set search_index_built_at = ${at.toISOString()}::timestamptz where account_id = ${A}`);
  const exact = async (q: string): Promise<string[]> => {
    const ctx: ServiceContext = { db, accountId: A, userId: null, now: () => new Date(), requestId: "bf" } as never;
    const r = await new SearchService().search(ctx, { q, parts: "page" });
    return r.tier === "exact" ? r.items.map((m) => m.id).sort() : [];
  };

  it("refills a document an older writer built: one pass and the letter is found by its file name, whole or a part, beside another word", async () => {
    await builtBefore(ids[5]!);
    await markerAt(BEFORE);
    expect(await exact("plain invoice")).toEqual([]);
    expect(await termsOf(ids[5]!)).toBe("backfill 5 s5@club.example claims desk claims@axa.example quince-invoice.pdf");
    expect(await vectorsOf(ids[5]!, "quince-invoice.pdf")).toEqual({ head: true, text: false, parts: false, writers: false });
    expect(await searchIndexBackfillPass({ db: db as never, accountId: A })).toMatchObject({ ran: true, written: 1, marked: true });
    expect(await exact("plain invoice")).toEqual([ids[5]]);
    expect(await exact("plain quince-invoice.pdf")).toEqual([ids[5]]);
    // Its substring corpus is the one the writer writes now: the header text, the mark, the name whole.
    const [stored] = await searchInputsFromStore(db as never, A, [ids[5]!]);
    expect(await termsOf(ids[5]!)).toBe(searchDocumentOf(stored!.input).terms);
    expect(await termsOf(ids[5]!)).toBe("backfill 5 s5@club.example claims desk claims@axa.example\u001fquince-invoice.pdf");
    // Its head is built again from the stored headers, with no name in it; its text gains the name whole and its parts.
    expect(await vectorsOf(ids[5]!, "quince-invoice.pdf")).toEqual({ head: false, text: true, parts: true, writers: true });
    // The marker is the shape's now: nothing is owed, and nothing is read.
    expect(await searchIndexBackfillPass({ db: db as never, accountId: A })).toMatchObject({ ran: false, written: 0 });
  });

  it("the refill keeps the backfill's bound: newest first, batch × rounds a pass, the marker after the last", async () => {
    for (const i of [8, 6, 3]) await db.insert(attachments).values({ accountId: A, messageId: ids[i]!, filename: `fig-${i}-ledger.pdf`, contentType: "application/pdf" });
    for (const i of [8, 6, 5, 3, 1]) await builtBefore(ids[i]!);
    await markerAt(BEFORE);
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

  it("an older writer's document and marker dated after any calendar day are refilled all the same", async () => {
    await builtBefore(ids[8]!, new Date("2027-05-10T00:00:00Z"));
    await markerAt(new Date("2027-05-10T00:00:00Z"));
    expect(await exact("ledger plain")).not.toContain(ids[8]);
    const late = () => new Date("2027-06-01T00:00:00Z");
    expect(await searchIndexBackfillPass({ db: db as never, accountId: A, now: late })).toMatchObject({ ran: true, written: 1, marked: true });
    expect(await exact("ledger plain")).toContain(ids[8]);
  });

  it("a withheld body keeps the words its document holds and gains its file names' parts", async () => {
    const id = ids[6]!;
    // Ingested whole, then evicted for space: the store holds no text, the document its words.
    await builtBefore(id, BEFORE, "lagoon minutes");
    await db.update(messageBodies).set({ text: "", html: null, withheldReason: "storage_cap" }).where(eq(messageBodies.messageId, id));
    await markerAt(BEFORE);
    expect(await searchIndexBackfillPass({ db: db as never, accountId: A })).toMatchObject({ ran: true, marked: true });
    expect(await exact("lagoon")).toEqual([id]);
    expect(await exact("lagoon ledger")).toEqual([id]);
    expect(await vectorsOf(id, "fig-6-ledger.pdf")).toEqual({ head: false, text: true, parts: true, writers: true });
  });

  const weeks = async (): Promise<Map<string, number | null>> => new Map(((await db.execute(sql`select message_id as id, search_week as w
    from message_search where account_id = ${A}`)) as unknown as Array<{ id: string; w: number | null }>).map((r) => [r.id, r.w]));
  const JANUARY_2026 = 2026 * 12;

  it("every document carries its letter's month from the stored date, an older writer's too, and the dates fill marks the account once", async () => {
    // The backfill and the refill wrote every document's month: the letters are dated in January 2026.
    const written = await weeks();
    expect(written.size).toBe(8);
    expect([...written.values()]).toEqual(Array(8).fill(JANUARY_2026));
    // An older writer's document, written with no month: the database fills it from the letter's date.
    const [mb] = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.accountId, A));
    const letter = async (key: string, date: Date | null): Promise<string> => {
      const [m] = await db.insert(messages).values({
        accountId: A, mailboxId: mb!.id, bodyHash: "h", dedupKey: `bf:${key}`, subject: `Dated ${key}`, fromAddress: "d@club.example",
        date, nativeLocator: { folder: "INBOX", ref: `2:${key}` },
      }).returning();
      await db.execute(sql`insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
        values (${m!.id}, ${A}, to_tsvector('english', ${key}), to_tsvector('english', ''), ${key}, 'headers_only')`);
      return m!.id;
    };
    const december = await letter("december", new Date("2025-12-15T10:00:00Z"));
    const undated = await letter("undated", null);
    const ahead = await letter("ahead", new Date(Date.now() + 90 * 86_400_000));
    const filled = await weeks();
    expect([filled.get(december), filled.get(undated), filled.get(ahead)]).toEqual([2025 * 12 + 11, -1, -2]);
    // Documents written before mail 0174 have none: the fill gives each its month, in rounds, and marks the
    // account once its walk has read the last document, and only then.
    await db.execute(sql`update message_search set search_week = null where account_id = ${A}`);
    expect(await searchDated(db as never, A)).toBe(false);
    expect(await searchDatesFillPass({ db: db as never, accountId: A, batch: 4, until: () => true })).toMatchObject({ ran: true, filled: 4, rounds: 1, marked: false });
    expect([...(await weeks()).values()].filter((w) => w === null)).toHaveLength(7);
    expect(await searchDatesFillPass({ db: db as never, accountId: A, batch: 4, limit: 100 })).toMatchObject({ ran: true, filled: 7, marked: true });
    expect(await searchDated(db as never, A)).toBe(true);
    expect(await weeks()).toEqual(filled);
    expect(await searchDatesFillPass({ db: db as never, accountId: A })).toMatchObject({ ran: false, filled: 0 });
    for (const id of [december, undated, ahead]) {
      await db.execute(sql`delete from message_search where message_id = ${id}`);
      await db.execute(sql`delete from messages where id = ${id}`);
    }
  });

  it("the dates fill writes a batch a statement, stops between statements once its slice is spent, and at its share", async () => {
    await db.execute(sql`update message_search set search_week = null where account_id = ${A}`);
    await db.execute(sql`update account_settings set search_dated_at = null where account_id = ${A}`);
    const owed = async (): Promise<number> => [...(await weeks()).values()].filter((w) => w === null).length;
    // The slice is spent from the start: one statement's documents, then it stops, unmarked.
    expect(await searchDatesFillPass({ db: db as never, accountId: A, batch: 3, until: () => true })).toMatchObject({ ran: true, filled: 3, rounds: 1, marked: false, cut: true });
    expect(await owed()).toBe(5);
    // A share of two: two written, in one statement of two.
    expect(await searchDatesFillPass({ db: db as never, accountId: A, batch: 3, limit: 2 })).toMatchObject({ filled: 2, rounds: 1, marked: false, cut: true });
    expect(await owed()).toBe(3);
    // The rest, in statements of three, and the mark once the walk has read the last document.
    expect(await searchDatesFillPass({ db: db as never, accountId: A, batch: 3, limit: 100 })).toMatchObject({ filled: 3, marked: true, cut: false });
    expect(await owed()).toBe(0);
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
    await own.insert(accountSettings).values({ accountId: older, searchIndexBuiltAt: new Date("2026-10-01T00:00:00Z") });
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

  it("the dates fill owes every account with living mail and no dates mark, and none once it is written", async () => {
    expect((await searchDatesOwedAccounts(own as never, { limit: 1000, shard: inArray(accounts.id, mine) })).sort())
      .toEqual([owedA, owedB, done, older].sort());
    expect(await searchDatesFillPass({ db: own as never, accountId: owedB })).toMatchObject({ ran: true, marked: true });
    expect(await searchDatesFillPass({ db: own as never, accountId: gone })).toMatchObject({ ran: true, marked: false });
    expect((await searchDatesOwedAccounts(own as never, { limit: 1000, shard: inArray(accounts.id, mine) })).sort())
      .toEqual([owedA, done, older].sort());
    expect(await searchDatesOwedAccounts(own as never, { limit: 1, shard: inArray(accounts.id, mine) })).toHaveLength(1);
  });

  it("reads a long body only as far as the document keeps it, and the document still starts with its words", async () => {
    const [row] = await searchInputsFromStore(own as never, owedA, [longId]);
    expect(row!.input.bodyText).toHaveLength(SEARCH_BODY_MAX_CHARS);
    expect(row!.input.bodyText.startsWith("lead w")).toBe(true);
  });
});
