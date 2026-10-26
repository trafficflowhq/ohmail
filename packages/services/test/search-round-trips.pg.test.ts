import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { accountSettings, folderState, mailboxes, messageBodies, messages, messageTags, tags } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions } from "@trafficflow/db/admin";
import { pgTestUrl, MIGRATED_DB_SETUP_BUDGET_MS } from "@trafficflow/db/testing";
import { searchIndexBackfillPass, upsertMessageSearch } from "@trafficflow/core/mail";
import { SearchService, materializeMessages } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * A SEARCH ANSWER IS A BOUNDED NUMBER OF STATEMENTS, whatever the page holds: production pays a
 * round trip per statement, so a page is begin, the session's settings with the backfill marker,
 * ONE read that is the page's rows and their DTOs, and commit — never a statement per table. The
 * count and facets are the same shape. Counted on the wire by the driver's own debug hook, which
 * sees every statement including begin and commit. Two accounts share the word: every answer
 * holds only the caller's rows.
 */
let statements: string[] = [];
const PG_URL = pgTestUrl(import.meta.url);
const client = postgres(PG_URL, {
  max: 1, onnotice: () => {},
  debug: (_c: number, q: string) => { statements.push(q.replace(/\s+/g, " ").trim()); },
});
const db = brandDialect(drizzle(client, { schema }), "pg");
const svc = new SearchService();
const NOW = new Date("2026-09-24T12:00:00.000Z");
const A = randomUUID();
const B = randomUUID();
/** Mail and no search document or marker yet: an account the backfill is still building. */
const C = randomUUID();
const own: Record<string, Set<string>> = { [A]: new Set(), [B]: new Set(), [C]: new Set() };
const PAGE = 4;

function ctx(accountId: string): ServiceContext {
  return { db: db as never, accountId, userId: null, now: () => NOW, requestId: "search-round-trips" };
}

async function counted<T>(run: () => Promise<T>): Promise<{ value: T; statements: string[] }> {
  statements = [];
  const value = await run();
  return { value, statements: [...statements] };
}

async function seed(accountId: string, n: number, tagId: string, built = true): Promise<void> {
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${accountId.slice(0, 8)}@rt.example` }).returning();
  for (let i = 0; i < n; i++) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `rt:${randomUUID()}`,
      subject: `heron sighting ${i}`, fromAddress: `watcher${i % 3}@rt.example`,
      date: new Date(NOW.getTime() - i * 3_600_000), unread: i % 2 === 0, hasAttachments: false,
      nativeLocator: { folder: "INBOX", ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: `a heron by the lake, note ${i}` });
    await db.insert(folderState).values({ messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
    if (i % 2 === 0) await db.insert(messageTags).values({ accountId, messageId: m!.id, tagId });
    if (built) await upsertMessageSearch(db as never, m!.id, {
      accountId, subject: `heron sighting ${i}`, from: { name: null, address: `watcher${i % 3}@rt.example` }, to: [], cc: [],
      attachmentNames: [], bodyText: `a heron by the lake, note ${i}`, source: "text",
    });
    own[accountId]!.add(m!.id);
  }
  if (!built) return;
  await db.insert(accountSettings).values({ accountId, searchIndexBuiltAt: NOW })
    .onConflictDoUpdate({ target: accountSettings.accountId, set: { searchIndexBuiltAt: NOW } });
}

const isTx = (s: string): boolean => /^(begin|commit)\b/i.test(s);

describe("a search answer is a bounded number of statements (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(PG_URL);
    await ensureSearchExtensions(db, { concurrently: false });
    for (const acct of [A, B, C]) {
      const [t] = await db.insert(tags).values({ accountId: acct, name: "birds", hue: "moss" }).returning();
      await seed(acct, acct === B ? 6 : 9, t!.id, acct !== C);
    }
    // Warm the per-handle extension probe, which is once per handle and not per answer.
    await svc.search(ctx(A), { q: "heron", parts: "page", limit: PAGE });
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    for (const a of [A, B, C]) {
      await db.execute(sql`delete from message_search where account_id = ${a}`);
      await db.execute(sql`delete from message_tags where account_id = ${a}`);
      await db.execute(sql`delete from tags where account_id = ${a}`);
      await db.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${a})`);
      await db.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${a})`);
      await db.execute(sql`delete from messages where account_id = ${a}`);
      await db.execute(sql`delete from mailboxes where account_id = ${a}`);
      await db.execute(sql`delete from account_settings where account_id = ${a}`);
    }
    await client.end({ timeout: 5 });
  });

  it("a relevance page and the page after it: begin, the session, ONE read, commit", async () => {
    const first = await counted(() => svc.search(ctx(A), { q: "heron", parts: "page", limit: PAGE }));
    console.log(`search-round-trips page: ${first.statements.length} statements`);
    expect(first.value.items).toHaveLength(PAGE);
    expect(first.statements.length, first.statements.map((s) => s.slice(0, 60)).join(" | ")).toBeLessThanOrEqual(4);
    expect(first.statements.filter((s) => !isTx(s)).length).toBeLessThanOrEqual(2);
    const next = await counted(() => svc.search(ctx(A), { q: "heron", parts: "page", limit: PAGE, cursor: first.value.nextCursor! }));
    expect(next.value.items).toHaveLength(PAGE);
    expect(next.statements.length).toBeLessThanOrEqual(4);
    // The cursor walks on: no row twice, and the tags reached the DTOs through the one read.
    const seen = [...first.value.items, ...next.value.items].map((m) => m.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(first.value.items.some((m) => m.labels.length === 1)).toBe(true);
  });

  it("a chosen order's page is the same shape", async () => {
    const r = await counted(() => svc.search(ctx(A), { q: "heron", parts: "page", limit: PAGE, sort: "date_desc" }));
    expect(r.value.items).toHaveLength(PAGE);
    expect(r.statements.length).toBeLessThanOrEqual(4);
    const dates = r.value.items.map((m) => Date.parse(m.date!));
    expect([...dates].sort((x, y) => y - x)).toEqual(dates);
  });

  it("the count and facets: begin, the session, ONE statement, commit — the summary and the estimate", async () => {
    for (const parts of ["summary", "estimate"] as const) {
      const r = await counted(() => svc.search(ctx(A), { q: "heron", parts, limit: PAGE }));
      console.log(`search-round-trips ${parts}: ${r.statements.length} statements`);
      expect(r.value.total, parts).toBe(9);
      expect(r.statements.length, `${parts}: ${r.statements.map((s) => s.slice(0, 60)).join(" | ")}`).toBeLessThanOrEqual(4);
      expect(r.statements.filter((s) => !isTx(s)).length, parts).toBeLessThanOrEqual(2);
    }
  });

  it("while the backfill builds, the count reads its progress once, and again after 30 s", async () => {
    const first = await svc.search(ctx(C), { q: "heron", parts: "estimate", limit: PAGE });
    expect(first.indexed).toEqual({ done: 0, total: 9 });
    for (const parts of ["estimate", "summary"] as const) {
      const r = await counted(() => svc.search(ctx(C), { q: "heron", parts, limit: PAGE }));
      expect(r.value.total, parts).toBe(9);
      expect(r.value.indexed, parts).toEqual({ done: 0, total: 9 });
      expect(r.statements.length, `${parts}: ${r.statements.map((s) => s.slice(0, 60)).join(" | ")}`).toBeLessThanOrEqual(4);
      expect(r.statements.filter((s) => !isTx(s)).length, parts).toBeLessThanOrEqual(2);
    }
    await searchIndexBackfillPass({ db: db as never, accountId: C, batch: 2, rounds: 1, now: () => NOW });
    const later = new Date(NOW.getTime() + 31_000);
    const after = await svc.search({ ...ctx(C), now: () => later }, { q: "heron", parts: "estimate", limit: PAGE });
    expect(after.indexed).toEqual({ done: 2, total: 9 });
  });

  it("an empty exact tier asks the typo tier in the SAME transaction", async () => {
    const r = await counted(() => svc.search(ctx(A), { q: "zzqqxx", parts: "page", limit: PAGE }));
    expect(r.value.items).toEqual([]);
    expect(r.statements.filter(isTx)).toHaveLength(2);
    expect(r.statements.length).toBeLessThanOrEqual(5);
  });

  it("the one materializing read answers only the caller's messages, asked for another's", async () => {
    const mixed = [...own[A]!, ...own[B]!];
    const r = await counted(() => materializeMessages(db as never, A, mixed));
    expect(new Set(r.value.keys())).toEqual(own[A]);
    expect(r.statements).toHaveLength(1);
    expect((await materializeMessages(db as never, B, [...own[A]!])).size).toBe(0);
  });

  it("every page, count and facet holds only the caller's rows", async () => {
    for (const acct of [A, B]) {
      const other = acct === A ? B : A;
      let cursor: string | null = null;
      const got: string[] = [];
      do {
        const page: Awaited<ReturnType<typeof svc.search>> = await svc.search(ctx(acct), {
          q: "heron", parts: "page", limit: PAGE, ...(cursor ? { cursor } : {}),
        });
        got.push(...page.items.map((m) => m.id));
        expect(page.items.every((m) => m.accountId === acct)).toBe(true);
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(new Set(got)).toEqual(own[acct]);
      expect(got.some((id) => own[other]!.has(id))).toBe(false);
      for (const sort of ["date_desc", "sender"] as const) {
        const page = await svc.search(ctx(acct), { q: "heron", parts: "page", limit: 50, sort });
        expect(new Set(page.items.map((m) => m.id))).toEqual(own[acct]);
      }
      const summary = await svc.search(ctx(acct), { q: "heron", parts: "summary" });
      expect(summary.total).toBe(own[acct]!.size);
      const senders = summary.facets!.sender.reduce((n, s) => n + s.count, 0);
      expect(senders).toBe(own[acct]!.size);
    }
  });
});
