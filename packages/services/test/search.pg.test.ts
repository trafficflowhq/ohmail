import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { sql } from "drizzle-orm";
import { mailboxes, messages, messageBodies, folderState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions } from "@trafficflow/db/admin";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { pgTestUrl, MIGRATED_DB_SETUP_BUDGET_MS } from "@trafficflow/db/testing";

/**
 * Phase 2c-1 golden-relevance — the search tests PGlite cannot host (pg_trgm lives
 * only in the real Postgres on :5433, RC8). Proves the hybrid lexical+fuzzy RRF
 * ranking: an exact query ranks the right message top; a TYPO query surfaces a
 * message pure tsvector MISSES (the fuzzy arm earns its keep); facet counts and
 * filters are correct; and accountId isolation holds.
 */
const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 5 });
const db = brandDialect(drizzle(client, { schema }), "pg");
const svc = new SearchService();

// Fixed clock so the date-bucket facets are deterministic.
const NOW = new Date("2026-07-27T12:00:00.000Z");
const TODAY = new Date("2026-07-27T10:00:00.000Z");

const A = randomUUID();   // the account under test
const B = randomUUID();   // a second account — must never leak into A's results
const ids: Record<string, string> = {};

function ctx(accountId: string): ServiceContext {
  return { db, accountId, userId: null, now: () => NOW, requestId: "search-test" };
}

async function seedMsg(o: {
  key: string; accountId: string; mailboxId: string; subject: string; from: string;
  body: string; folder: string; unread: boolean; hasAttachments: boolean;
}): Promise<void> {
  const [m] = await db.insert(messages).values({
    accountId: o.accountId, mailboxId: o.mailboxId, bodyHash: "h",
    dedupKey: `search:${randomUUID()}`, subject: o.subject, fromAddress: o.from,
    date: TODAY, unread: o.unread, hasAttachments: o.hasAttachments,
    nativeLocator: { folder: o.folder, ref: "1:1" },
  }).returning();
  await db.insert(messageBodies).values({ messageId: m!.id, text: o.body });
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: o.folder, observedFolder: o.folder, lastSetBy: "us",
  });
  ids[o.key] = m!.id;
}

describe("hybrid search (lexical + fuzzy RRF) on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    await ensureSearchExtensions(db, { concurrently: false });

    const [mbA] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "a@tf.example" }).returning();
    const [mbB] = await db.insert(mailboxes).values({ accountId: B, provider: "imap", address: "b@tf.example" }).returning();

    await seedMsg({ key: "invoice", accountId: A, mailboxId: mbA!.id,
      subject: "Invoice from Anna Acme March 2026", from: "anna@acme-com.example",
      body: "Please find attached the invoice, total 500 CHF.", folder: "INBOX",
      unread: true, hasAttachments: true });
    await seedMsg({ key: "newsletter", accountId: A, mailboxId: mbA!.id,
      subject: "Weekly product newsletter", from: "news@shop.example",
      body: "Deals and discounts this week.", folder: "ohmail/News",
      unread: false, hasAttachments: false });
    await seedMsg({ key: "lunch", accountId: A, mailboxId: mbA!.id,
      subject: "Team lunch Friday", from: "bob@work.example",
      body: "Let us meet for lunch.", folder: "INBOX", unread: true, hasAttachments: false });
    await seedMsg({ key: "receipt", accountId: A, mailboxId: mbA!.id,
      subject: "Payment receipt", from: "billing@acme-com.example",
      body: "Your payment was received.", folder: "ohmail/Receipts",
      unread: false, hasAttachments: false });

    // Account B: a DECOY that matches every A query but must stay invisible to A.
    await seedMsg({ key: "otherInvoice", accountId: B, mailboxId: mbB!.id,
      subject: "Invoice secret other account", from: "anna@acme-com.example",
      body: "Acme invoice for the other tenant.", folder: "INBOX",
      unread: true, hasAttachments: true });
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => { await client.end({ timeout: 5 }); });

  it("(a) an exact lexical query ranks the right message top", async () => {
    const r = await svc.search(ctx(A), { q: "invoice" });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0]!.id).toBe(ids.invoice);
  });

  it("(b) a TYPO query surfaces a message pure lexical MISSES (fuzzy arm + RRF earn value)", async () => {
    // Prove the lexical arm ALONE finds nothing for the misspelling…
    const [{ n }] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n
      from messages m left join message_bodies b on b.message_id = m.id
      where m.account_id = ${A}
        and (m.subject_tsv @@ websearch_to_tsquery('english', 'invoce')
             or b.body_tsv @@ websearch_to_tsquery('english', 'invoce'))`) as unknown as Array<{ n: number }>;
    expect(n).toBe(0);

    // …yet the hybrid search still surfaces the invoice message, ranked top.
    const r = await svc.search(ctx(A), { q: "invoce" });
    expect(r.items.map((m) => m.id)).toContain(ids.invoice);
    expect(r.items[0]!.id).toBe(ids.invoice);
  });

  /**
   * (c) FACET COUNTS DESCRIBE THE TIER THAT IS RETURNED. "acme" is in the invoice's subject and in
   * BOTH senders' domains, so the exact tier holds both rows (the substring arm reads the sender)
   * and the facets say 2 — a row both arms hold (the invoice) ranks first. It once expected 1,
   * treating the queried address as a guess; the characters are in the address. The trigram reach
   * is not lost: ask for something the corpus answers literally nowhere and it answers, labelled.
   */
  it("(c) facet counts describe the returned tier, and the fuzzy reach still exists below it", async () => {
    const r = await svc.search(ctx(A), { q: "acme" });
    expect(r.tier).toBe("exact");
    expect(r.total).toBe(2);
    expect(r.items.map((m) => m.id)).toEqual([ids.invoice, ids.receipt]);
    expect(r.facets!.folder).toEqual({ INBOX: 1, "ohmail/Receipts": 1 });
    expect(r.facets!.unread).toEqual({ true: 1, false: 1 });
    expect(r.facets!.hasAttachments).toEqual({ true: 1, false: 1 });
    expect(r.facets!.date.today).toBe(2);
    const senders = Object.fromEntries(r.facets!.sender.map((s) => [s.address, s.count]));
    expect(senders["anna@acme-com.example"]).toBe(1);
    expect(senders["billing@acme-com.example"]).toBe(1);
    // The newsletter's sender holds no "acme" — the substring arm reads characters, not guesses.
    expect(r.items.map((m) => m.id)).not.toContain(ids.newsletter);

    // …and with NOTHING matching literally, the same trigram reach answers, under `similar`.
    const guess = await svc.search(ctx(A), { q: "acmee" });
    expect(guess.tier).toBe("similar");
    expect(guess.items.map((m) => m.id)).toContain(ids.receipt);
    expect(guess.facets!.folder["ohmail/Receipts"]).toBeGreaterThanOrEqual(1);
  });

  it("(d) filters narrow correctly", async () => {
    const r = await svc.search(ctx(A), { q: "acme", filters: { folder: "INBOX" } });
    expect(r.total).toBe(1);
    expect(r.items.map((m) => m.id)).toEqual([ids.invoice]);

    /*
     * A FILTER IS PART OF THE QUESTION, so the tier is decided over the filtered corpus: among
     * messages already read, "acme" is answered literally by the receipt's sender alone. The
     * view's facets are a different act — they narrow a list already given and never promote
     * guesses into it.
     */
    const unreadOnly = await svc.search(ctx(A), { q: "acme", filters: { unread: false } });
    expect(unreadOnly.tier).toBe("exact");
    expect(unreadOnly.items.map((m) => m.id)).toEqual([ids.receipt]);
  });

  it("(e) accountId isolation — another account's messages never appear", async () => {
    const r = await svc.search(ctx(A), { q: "invoice" });
    expect(r.items.map((m) => m.id)).not.toContain(ids.otherInvoice);
    for (const m of r.items) expect(m.accountId).toBe(A);

    // Account B sees its own decoy, not A's.
    const rb = await svc.search(ctx(B), { q: "invoice" });
    expect(rb.items.map((m) => m.id)).toContain(ids.otherInvoice);
    expect(rb.items.map((m) => m.id)).not.toContain(ids.invoice);
  });

  it("latency sanity — a query over the seeded corpus returns well under ~500ms", async () => {
    await svc.search(ctx(A), { q: "invoice" });   // warm caches / trgm probe
    const t0 = performance.now();
    await svc.search(ctx(A), { q: "invoice" });
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
