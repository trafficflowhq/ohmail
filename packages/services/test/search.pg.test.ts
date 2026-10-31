import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { sql } from "drizzle-orm";
import { mailboxes, messages, messageBodies, folderState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions, ensureWordIndex } from "@trafficflow/db/admin";
import { SearchService } from "@trafficflow/services";
import type { SearchFilters, ServiceContext } from "@trafficflow/services";
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

// One client for both blocks, ended after the last.
afterAll(async () => { await client.end({ timeout: 5 }); });

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

/**
 * THE SERVER'S COUNT STAYS WITHIN ITS CAP on a word in more letters than the summary counts exactly:
 * the count says "at least" past 2,000 matches, while the date orders and the sender order still
 * list every match, in order.
 */
describe("past the summary's cap (real Postgres)", () => {
  const C = randomUUID();
  const BROAD = 2_100;
  const RARE = 30;

  beforeAll(async () => {
    const [mb] = await db.insert(mailboxes).values({ accountId: C, provider: "imap", address: "c@tf.example" }).returning();
    // Letter g: "lapwing" in every letter up to BROAD, "plover" in every 70th, "minutes" in the rest.
    await db.execute(sql`insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator)
      select gen_random_uuid(), ${C}::uuid, ${mb!.id}::uuid, 'h', 'cap:' || g,
        case when g <= ${BROAD} then 'lapwing count ' || g else 'board minutes ' || g end
          || case when g % 70 = 0 then ' plover' else '' end,
        'watcher' || (g % 7) || '@cap.example', ${NOW.toISOString()}::timestamptz - make_interval(mins => g), false, false,
        jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g)
      from generate_series(1, ${BROAD + 40}) g`);
    await db.execute(sql`insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
      select m.id, m.account_id, to_tsvector('english', m.subject), to_tsvector('english', 'nothing here'), lower(m.subject), 'text'
      from messages m where m.account_id = ${C}::uuid`);
    await db.execute(sql`insert into account_settings (account_id, search_index_built_at) values (${C}::uuid, ${NOW.toISOString()}::timestamptz)
      on conflict (account_id) do update set search_index_built_at = excluded.search_index_built_at`);
    await db.execute(sql`analyze messages`);
    await db.execute(sql`analyze message_search`);
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    await db.execute(sql`delete from message_search where account_id = ${C}`);
    await db.execute(sql`delete from messages where account_id = ${C}`);
    await db.execute(sql`delete from account_settings where account_id = ${C}`);
    await db.execute(sql`delete from mailboxes where account_id = ${C}`);
  });

  it("the summary of a word in 2,100 letters says at least 2,000; one in 30 is exact", async () => {
    const broad = await svc.search(ctx(C), { q: "lapwing", parts: "summary" });
    expect({ total: broad.total, exact: broad.totalExact }).toEqual({ total: 2_000, exact: false });
    expect(broad.facets, "past the cap the estimate's facets stand").toBeNull();
    // Asked with the page, the facets are the page's candidates'.
    const both = await svc.search(ctx(C), { q: "lapwing" });
    expect({ total: both.total, exact: both.totalExact, items: both.items.length }).toEqual({ total: 2_000, exact: false, items: 50 });
    expect(both.facets.unread.false).toBeGreaterThanOrEqual(50);
    const rare = await svc.search(ctx(C), { q: "plover", parts: "summary" });
    expect({ total: rare.total, exact: rare.totalExact }).toEqual({ total: RARE, exact: true });
    expect(rare.facets!.unread.false).toBe(RARE);
  });

  it("the date orders answer the newest and the oldest matches in order, paged without a gap", async () => {
    for (const [q, n] of [["lapwing", BROAD], ["plover", RARE]] as const) {
      const all = Array.from({ length: BROAD + 40 }, (_, i) => i + 1).filter((g) => (q === "lapwing" ? g <= BROAD : g % 70 === 0));
      expect(all).toHaveLength(n);
      const got: number[] = [];
      let cursor: string | undefined;
      for (let p = 0; p < 3; p++) {
        const r = await svc.search(ctx(C), { q, parts: "page", sort: "date_desc", ...(cursor ? { cursor } : {}) });
        got.push(...r.items.map((m) => (NOW.getTime() - Date.parse(m.date!)) / 60_000));
        expect(r.bounded).toBe(false);
        cursor = r.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(got, q).toEqual(all.slice(0, Math.min(150, n)));
      const oldest = await svc.search(ctx(C), { q, parts: "page", sort: "date_asc" });
      expect(oldest.items.map((m) => (NOW.getTime() - Date.parse(m.date!)) / 60_000), q).toEqual([...all].reverse().slice(0, Math.min(50, n)));
    }
  });

  it("the sender order lists every one of a word's 2,100 matches in order, and never says bounded", async () => {
    const seen: Array<{ from: string; date: number }> = [];
    let cursor: string | undefined;
    let last: Awaited<ReturnType<typeof svc.search>> | null = null;
    do {
      last = await svc.search(ctx(C), { q: "lapwing", parts: "page", sort: "sender", ...(cursor ? { cursor } : {}) });
      seen.push(...last.items.map((m) => ({ from: m.from.address, date: Date.parse(m.date!) })));
      cursor = last.nextCursor ?? undefined;
    } while (cursor);
    expect(last.bounded).toBe(false);
    const sorted = [...seen].sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : y.date - x.date));
    expect(seen).toEqual(sorted);
    expect(seen.map((x) => (NOW.getTime() - x.date) / 60_000).sort((a, b) => a - b)).toEqual(Array.from({ length: BROAD }, (_, i) => i + 1));
  });
});

/**
 * PAST THE CAP THE CHOSEN ORDERS STILL READ THE EXACT MATCHES, on the account-keyed word index, in
 * a store written oldest first (as an import from a folder's first UID writes it), so the index's
 * own order is not the date order. Letter g is g minutes old; three more letters have no Date.
 * "lapwing": the newest 2,100 letters, none of the 3,000 older ones. "heron": the newest 3,000 and
 * every 200th older one (5 in the oldest 1,000), and the three undated letters.
 */
describe("past the cap, the chosen orders read the exact matches (real Postgres, keyed)", () => {
  const U = randomUUID();
  const N = 5_100;
  // A handle of its own, so the store's index facts are read after the word index exists.
  const keyed = brandDialect(drizzle(client, { schema }), "pg");
  const kctx = (): ServiceContext => ({ db: keyed, accountId: U, userId: null, now: () => NOW, requestId: "search-cap-keyed" });
  const ageOf = (m: { date: string | null; subject: string }): number =>
    (m.date === null ? Number.POSITIVE_INFINITY : (NOW.getTime() - Date.parse(m.date)) / 60_000);
  const heron = (g: number): boolean => g <= 3_000 || g % 200 === 0;
  const walk = async (q: string, sort: "date_desc" | "date_asc" | "sender", enough = Number.POSITIVE_INFINITY) => {
    const pages: Awaited<ReturnType<typeof svc.search>>[] = [];
    let cursor: string | undefined;
    let n = 0;
    do {
      const r = await svc.search(kctx(), { q, parts: "page", sort, ...(cursor ? { cursor } : {}) });
      pages.push(r);
      n += r.items.length;
      cursor = r.nextCursor ?? undefined;
    } while (cursor && pages.length < 200 && n < enough);
    return pages;
  };

  beforeAll(async () => {
    await ensureWordIndex(db, { concurrently: false });
    const [mb] = await db.insert(mailboxes).values({ accountId: U, provider: "imap", address: "u@tf.example" }).returning();
    await db.execute(sql`insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator)
      select gen_random_uuid(), ${U}::uuid, ${mb!.id}::uuid, 'h', 'ucap:' || g,
        'count ' || g || case when g <= 2100 then ' lapwing' else '' end
          || case when g <= 3000 or g % 200 = 0 or g > ${N} then ' heron' else '' end
          || case when g % 7 = 0 then ' plover' else '' end,
        case when g <= 100 then 'new@cap.example' else 'old' || (g % 5) || '@cap.example' end,
        case when g > ${N} then null else ${NOW.toISOString()}::timestamptz - make_interval(mins => g) end, false, false,
        jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g)
      from generate_series(${N + 3}, 1, -1) g`);
    await db.execute(sql`insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
      select m.id, m.account_id, to_tsvector('english', m.subject), to_tsvector('english', 'nothing here'), lower(m.subject), 'text'
      from messages m where m.account_id = ${U}::uuid order by m.date asc nulls first`);
    await db.execute(sql`insert into account_settings (account_id, search_index_built_at) values (${U}::uuid, ${NOW.toISOString()}::timestamptz)
      on conflict (account_id) do update set search_index_built_at = excluded.search_index_built_at`);
    await db.execute(sql`analyze messages`);
    await db.execute(sql`analyze message_search`);
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    await db.execute(sql`delete from message_search where account_id = ${U}`);
    await db.execute(sql`delete from messages where account_id = ${U}`);
    await db.execute(sql`delete from account_settings where account_id = ${U}`);
    await db.execute(sql`delete from mailboxes where account_id = ${U}`);
  });

  it("oldest first starts at a word's oldest letter though the oldest 3,000 hold none", async () => {
    const r = await svc.search(kctx(), { q: "lapwing", parts: "page", sort: "date_asc" });
    expect(r.items.map(ageOf)).toEqual(Array.from({ length: 50 }, (_, i) => 2_100 - i));
    expect(r.nextCursor).not.toBeNull();
    expect(r.bounded).toBe(false);
  });

  it("oldest first pages every match of a word sparse in old mail, the undated ones last", async () => {
    const pages = await walk("heron", "date_asc");
    const want = [...Array.from({ length: N }, (_, i) => N - i).filter(heron), ...Array(3).fill(Number.POSITIVE_INFINITY)];
    expect(pages.flatMap((p) => p.items.map(ageOf))).toEqual(want);
    expect(pages.every((p) => !p.bounded)).toBe(true);
    // An excluded word: the oldest letters without it, in order (a page past the cap may be short).
    const kept = (await walk("heron -plover", "date_asc", 50)).flatMap((p) => p.items.map(ageOf));
    expect(kept.slice(0, 50)).toEqual(want.filter((g) => g % 7 !== 0).slice(0, 50));
  }, 120_000);

  it("newest first pages every match of a word sparse in old mail, the undated ones last", async () => {
    const pages = await walk("heron", "date_desc");
    const want = [...Array.from({ length: N }, (_, i) => i + 1).filter(heron), ...Array(3).fill(Number.POSITIVE_INFINITY)];
    expect(pages.flatMap((p) => p.items.map(ageOf))).toEqual(want);
    expect(pages.every((p) => !p.bounded && p.tier === "exact")).toBe(true);
  }, 120_000);

  it("the sender order lists every match though the index holds the oldest first", async () => {
    const pages = await walk("lapwing", "sender");
    const seen = pages.flatMap((p) => p.items.map((m) => ({ from: m.from.address, g: ageOf(m) })));
    expect(seen.map((x) => x.g).sort((a, b) => a - b)).toEqual(Array.from({ length: 2_100 }, (_, i) => i + 1));
    expect(seen.filter((x) => x.from === "new@cap.example")).toHaveLength(100);
    expect(seen).toEqual([...seen].sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : x.g - y.g)));
    expect(pages.some((p) => p.bounded)).toBe(false);
  }, 120_000);

});

/**
 * THE EXACT TIER NEVER FALLS TO THE SIMILAR TIER WHILE A MATCH EXISTS: past the caps a chosen order
 * still lists the exact matches 0.30.19 listed, under a filter too. Letter g is g minutes old; each
 * store is written oldest first. `NEWEST`: "osprey" in the newest 2,300 of 8,500 letters, "ospray"
 * (a typo of it) in some old ones. `GAP`: "osprey" in 2,200 letters, none of the newest 500, "ospray"
 * in three new ones. `EVERY`: "wren" in all 21,000 letters, 100 of them (5,001 to 5,100 minutes old)
 * in Archive.
 */
describe("a chosen order answers the exact tier while a match exists (real Postgres, keyed)", () => {
  const NEWEST = randomUUID();
  const GAP = randomUUID();
  const EVERY = randomUUID();
  const keyed = brandDialect(drizzle(client, { schema }), "pg");
  const rctx = (accountId: string): ServiceContext => ({ db: keyed, accountId, userId: null, now: () => NOW, requestId: "search-exact-orders" });
  const ageOf = (m: { date: string | null }): number => (m.date === null ? -1 : (NOW.getTime() - Date.parse(m.date)) / 60_000);
  const seed = async (account: string, n: number, subject: string, folder: string): Promise<void> => {
    const [mb] = await db.insert(mailboxes).values({ accountId: account, provider: "imap", address: `${account.slice(0, 8)}@exact.example` }).returning();
    await db.execute(sql`insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator)
      select gen_random_uuid(), ${account}::uuid, ${mb!.id}::uuid, 'h', 'exact:' || g, ${sql.raw(subject)},
        'p' || (g % 5) || '@exact.example', ${NOW.toISOString()}::timestamptz - make_interval(mins => g), false, false,
        jsonb_build_object('folder', ${sql.raw(folder)}, 'ref', '1:' || g)
      from generate_series(${n}, 1, -1) g`);
    await db.execute(sql`insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
      select m.id, m.account_id, to_tsvector('english', m.subject), to_tsvector('english', 'nothing here'), lower(m.subject), 'text'
      from messages m where m.account_id = ${account}::uuid order by m.date asc nulls first`);
    await db.execute(sql`insert into account_settings (account_id, search_index_built_at) values (${account}::uuid, ${NOW.toISOString()}::timestamptz)
      on conflict (account_id) do update set search_index_built_at = excluded.search_index_built_at`);
  };

  beforeAll(async () => {
    await ensureWordIndex(db, { concurrently: false });
    await seed(NEWEST, 8_500, `'item ' || g || case when g <= 2300 then ' osprey' else '' end || case when g > 2300 and g % 500 = 0 then ' ospray' else '' end`, `'INBOX'`);
    await seed(GAP, 3_000, `'item ' || g || case when g between 501 and 2700 then ' osprey' else '' end || case when g in (100, 200, 300) then ' ospray' else '' end`, `'INBOX'`);
    await seed(EVERY, 21_000, `'item ' || g || ' wren'`, `case when g between 5001 and 5100 then 'Archive' else 'INBOX' end`);
    await db.execute(sql`analyze messages`);
    await db.execute(sql`analyze message_search`);
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    for (const a of [NEWEST, GAP, EVERY]) {
      await db.execute(sql`delete from message_search where account_id = ${a}`);
      await db.execute(sql`delete from messages where account_id = ${a}`);
      await db.execute(sql`delete from account_settings where account_id = ${a}`);
      await db.execute(sql`delete from mailboxes where account_id = ${a}`);
    }
  });

  it("oldest first: a word absent from the oldest 6,200 letters starts at its oldest match, and the count beside it is exact's", async () => {
    const r = await svc.search(rctx(NEWEST), { q: "osprey", parts: "page", sort: "date_asc" });
    expect({ tier: r.tier, first: r.items.slice(0, 3).map(ageOf), n: r.items.length }).toEqual({ tier: "exact", first: [2300, 2299, 2298], n: 50 });
    const both = await svc.search(rctx(NEWEST), { q: "osprey", sort: "date_asc" });
    expect({ tier: both.tier, first: both.items[0] && ageOf(both.items[0]), total: both.total }).toEqual({ tier: "exact", first: 2300, total: 2_000 });
  }, 120_000);

  it("the sender and mailbox orders: a word in 2,200 letters, none of the newest 500, lists every match", async () => {
    for (const sort of ["sender", "mailbox"] as const) {
      const seen: Array<{ from: string; g: number }> = [];
      let cursor: string | undefined;
      let last: Awaited<ReturnType<typeof svc.search>> | null = null;
      do {
        last = await svc.search(rctx(GAP), { q: "osprey", parts: "page", sort, ...(cursor ? { cursor } : {}) });
        expect(last.tier, sort).toBe("exact");
        seen.push(...last.items.map((m) => ({ from: m.from.address, g: ageOf(m) })));
        cursor = last.nextCursor ?? undefined;
      } while (cursor);
      // All 2,200 matches, each once, in the order asked.
      expect(seen.map((x) => x.g).sort((a, b) => a - b), sort).toEqual(Array.from({ length: 2_200 }, (_, i) => 501 + i));
      const keyOf = (x: { from: string }) => (sort === "sender" ? x.from : "");
      expect(seen, sort).toEqual([...seen].sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : x.g - y.g)));
      expect(last.bounded, sort).toBe(false);
    }
  }, 120_000);

  it("the sender order under a folder: the 100 Archive letters of a word in 21,000, exactly", async () => {
    const seen: number[] = [];
    const tiers = new Set<string>();
    let cursor: string | undefined;
    let last: Awaited<ReturnType<typeof svc.search>> | null = null;
    for (let p = 0; p < 10; p++) {
      last = await svc.search(rctx(EVERY), { q: "wren", parts: "page", sort: "sender", filters: { folder: "Archive" }, ...(cursor ? { cursor } : {}) });
      tiers.add(last.tier);
      seen.push(...last.items.map(ageOf));
      cursor = last.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect({ tiers: [...tiers], n: seen.length, bounded: last!.bounded }).toEqual({ tiers: ["exact"], n: 100, bounded: false });
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => 5_001 + i));
  }, 120_000);

  it("oldest first under a folder: the first page is the exact tier's oldest Archive letters", async () => {
    const r = await svc.search(rctx(EVERY), { q: "wren", parts: "page", sort: "date_asc", filters: { folder: "Archive" } });
    expect({ tier: r.tier, first: r.items.slice(0, 3).map(ageOf), n: r.items.length }).toEqual({ tier: "exact", first: [5100, 5099, 5098], n: 50 });
  }, 120_000);
});

/**
 * EVERY ORDER UNDER EVERY FILTER answers 0.30.19's rows in 0.30.19's tier, on two accounts of 21,000
 * and 60,000 letters, each written oldest first. Letter g is g minutes old, in mailbox a (g even) or b,
 * from p(g mod 5), unread when g mod 3 is 0, with a file when g mod 50 is 0, and in Archive for g
 * 5,001-5,100 (its folder) and 15,001-15,050 or 40,001-40,050 (moved there). Its subject holds "item",
 * g and "wren", "heron" in the newest 2,300, "osprey" in 501-2,700, "plover" in the oldest 2,500 and
 * "egret" in every 997th; its body holds "lark" in the newest 2,300. 0.30.19 listed every match of a
 * chosen order in that order, and the closest words (header text within the similarity, holding no
 * excluded word) only when no letter matched.
 */
describe("every order under every filter answers 0.30.19's rows (real Postgres, keyed)", () => {
  type Acct = { readonly name: string; readonly id: string; readonly n: number; readonly moved: readonly [number, number] };
  const ACCTS: readonly Acct[] = [
    { name: "21,000", id: randomUUID(), n: 21_000, moved: [15_001, 15_050] },
    { name: "60,000", id: randomUUID(), n: 60_000, moved: [40_001, 40_050] },
  ];
  const keyed = brandDialect(drizzle(client, { schema }), "pg");
  const sctx = (a: Acct): ServiceContext => ({ db: keyed, accountId: a.id, userId: null, now: () => NOW, requestId: "search-sweep" });
  const ageOf = (m: { date: string | null }): number => (m.date === null ? -1 : (NOW.getTime() - Date.parse(m.date)) / 60_000);
  const IN: Record<string, (g: number, n: number) => boolean> = {
    item: () => true, wren: () => true, heron: (g) => g <= 2_300, osprey: (g) => g >= 501 && g <= 2_700,
    plover: (g, n) => g > n - 2_500, egret: (g) => g % 997 === 0, lark: (g) => g <= 2_300,
  };
  // Single words, two words (one of them across the subject and the body), an excluded word in the subject or the body.
  const QUERIES = ["wren", "osprey", "heron", "egret", "plover", "lark", "wren item", "osprey item", "egret item", "wren lark",
    "wren -heron", "osprey -heron", "wren -lark"];
  const excludedOf = (q: string): string[] => q.split(" ").filter((w) => w.startsWith("-")).map((w) => w.slice(1));
  const matchOf = (q: string, g: number, n: number): boolean => q.split(" ").every((w) => (w.startsWith("-") ? !IN[w.slice(1)]!(g, n) : IN[w]!(g, n)));
  const FILTERS: Record<string, { filters: SearchFilters; keep: (a: Acct) => (g: number) => boolean }> = {
    none: { filters: {}, keep: () => () => true },
    folder: { filters: { folder: "Archive" }, keep: (a) => (g) => (g >= 5_001 && g <= 5_100) || (g >= a.moved[0] && g <= a.moved[1]) },
    unread: { filters: { unread: true }, keep: () => (g) => g % 3 === 0 },
    from: { filters: { sender: "p3@sweep.example" }, keep: () => (g) => g % 5 === 3 },
    file: { filters: { hasAttachments: true }, keep: () => (g) => g % 50 === 0 },
  };
  type Order = "date_desc" | "date_asc" | "sender" | "mailbox";
  const keyOf = (sort: Order, g: number): string => (sort === "sender" ? `p${g % 5}@sweep.example` : sort === "mailbox" ? (g % 2 === 0 ? "a" : "b") : "");
  const ordered = (sort: Order, gs: readonly number[]): number[] => [...gs].sort((x, y) => (sort === "date_asc" ? y - x : sort === "date_desc" ? x - y
    : keyOf(sort, x) < keyOf(sort, y) ? -1 : keyOf(sort, x) > keyOf(sort, y) ? 1 : x - y));
  /** 0.30.19's answer to a question: its tier, and every letter it listed (the matches, else the closest words). */
  const guessed = new Map<string, number[]>();
  const answerOf = async (a: Acct, q: string, filter: string): Promise<{ tier: "exact" | "similar"; all: number[] }> => {
    const keep = FILTERS[filter]!.keep(a);
    const exact = Array.from({ length: a.n }, (_, i) => i + 1).filter((g) => matchOf(q, g, a.n) && keep(g));
    if (exact.length > 0) return { tier: "exact", all: exact };
    const memo = `${a.id} ${q}`;
    if (!guessed.has(memo)) {
      const rows = (await db.execute(sql`select split_part(m.dedup_key, ':', 2)::int as g from messages m join message_search s on s.message_id = m.id
        where m.account_id = ${a.id}::uuid and word_similarity(${q}, s.terms) >= 0.3`)) as unknown as Array<{ g: number }>;
      guessed.set(memo, rows.map((r) => Number(r.g)).filter((g) => excludedOf(q).every((w) => !IN[w]!(g, a.n))));
    }
    return { tier: "similar", all: guessed.get(memo)!.filter(keep) };
  };

  beforeAll(async () => {
    await ensureWordIndex(db, { concurrently: false });
    for (const a of ACCTS) {
      const [ma] = await db.insert(mailboxes).values({ accountId: a.id, provider: "imap", address: `a-${a.n}@sweep.example` }).returning();
      const [mb] = await db.insert(mailboxes).values({ accountId: a.id, provider: "imap", address: `b-${a.n}@sweep.example` }).returning();
      await db.execute(sql`insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator)
        select gen_random_uuid(), ${a.id}::uuid, case when g % 2 = 0 then ${ma!.id}::uuid else ${mb!.id}::uuid end, 'h', 'sweep:' || g,
          'item ' || g || ' wren' || case when g <= 2300 then ' heron' else '' end || case when g between 501 and 2700 then ' osprey' else '' end
            || case when g > ${a.n - 2_500} then ' plover' else '' end || case when g % 997 = 0 then ' egret' else '' end,
          'p' || (g % 5) || '@sweep.example', ${NOW.toISOString()}::timestamptz - make_interval(mins => g), g % 3 = 0, g % 50 = 0,
          jsonb_build_object('folder', case when g between 5001 and 5100 then 'Archive' else 'INBOX' end, 'ref', '1:' || g)
        from generate_series(${a.n}, 1, -1) g`);
      await db.execute(sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
        select m.id, 'Archive', 'INBOX', 'us' from messages m cross join lateral (select split_part(m.dedup_key, ':', 2)::int as g) x
        where m.account_id = ${a.id}::uuid and x.g between ${a.moved[0]} and ${a.moved[1]}`);
      await db.execute(sql`insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
        select m.id, m.account_id, to_tsvector('english', m.subject),
          to_tsvector('english', 'nothing here' || case when split_part(m.dedup_key, ':', 2)::int <= 2300 then ' lark' else '' end), lower(m.subject), 'text'
        from messages m where m.account_id = ${a.id}::uuid order by m.date asc nulls first`);
      await db.execute(sql`insert into account_settings (account_id, search_index_built_at) values (${a.id}::uuid, ${NOW.toISOString()}::timestamptz)
        on conflict (account_id) do update set search_index_built_at = excluded.search_index_built_at`);
    }
    await db.execute(sql`analyze messages`);
    await db.execute(sql`analyze message_search`);
    await db.execute(sql`analyze folder_state`);
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    for (const a of ACCTS) {
      await db.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${a.id})`);
      await db.execute(sql`delete from message_search where account_id = ${a.id}`);
      await db.execute(sql`delete from messages where account_id = ${a.id}`);
      await db.execute(sql`delete from account_settings where account_id = ${a.id}`);
      await db.execute(sql`delete from mailboxes where account_id = ${a.id}`);
    }
  });

  /**
   * Relevance: its tier, and a page of the letters 0.30.19 lists, each once (a full one but beside an
   * excluded word, which may cut it). Newest first: its first three pages. Oldest first and the sender
   * and mailbox orders: their first page.
   */
  it.each(ACCTS.map((a) => [a.name, a] as const))("on %s letters, every order under every filter: 0.30.19's rows, in its tier", async (_, a) => {
    const wrong: string[] = [];
    for (const q of QUERIES) {
      for (const [name, f] of Object.entries(FILTERS)) {
        const { tier, all } = await answerOf(a, q, name);
        const label = `${q} under ${name}`;
        const rel = await svc.search(sctx(a), { q, parts: "page", filters: f.filters });
        const ranked = rel.items.map(ageOf);
        const full = excludedOf(q).length > 0 || ranked.length === Math.min(50, all.length);
        if (rel.tier !== tier || !full || new Set(ranked).size !== ranked.length || ranked.some((g) => !all.includes(g))) {
          wrong.push(`${label} relevance: ${rel.tier} ${ranked.length}, 0.30.19 ${tier} of ${all.length}`);
        }
        const newest = ordered("date_desc", all).slice(0, 150);
        const got: number[] = [];
        let cursor: string | undefined;
        let last: Awaited<ReturnType<typeof svc.search>> | null = null;
        for (let p = 0; p < 3; p++) {
          last = await svc.search(sctx(a), { q, parts: "page", sort: "date_desc", filters: f.filters, ...(cursor ? { cursor } : {}) });
          if (last.tier !== tier) wrong.push(`${label} date_desc page ${p + 1}: ${last.tier}, 0.30.19 ${tier}`);
          got.push(...last.items.map(ageOf));
          cursor = last.nextCursor ?? undefined;
          if (!cursor) break;
        }
        if (JSON.stringify(got.slice(0, 150)) !== JSON.stringify(newest) || (cursor === undefined && got.length !== all.length) || last!.bounded) {
          wrong.push(`${label} date_desc: ${got.length} ${JSON.stringify(got.slice(0, 3))}${last!.bounded ? " bounded" : ""}, 0.30.19 ${all.length} ${JSON.stringify(newest.slice(0, 3))}`);
        }
        for (const sort of ["date_asc", "sender", "mailbox"] as const) {
          const r = await svc.search(sctx(a), { q, parts: "page", sort, filters: f.filters });
          const page = r.items.map(ageOf);
          const want = ordered(sort, all).slice(0, 50);
          if (r.tier !== tier || JSON.stringify(page) !== JSON.stringify(want) || (r.nextCursor !== null) !== (all.length > 50) || r.bounded) {
            wrong.push(`${label} ${sort}: ${r.tier} ${page.length} ${JSON.stringify(page.slice(0, 3))}${r.bounded ? " bounded" : ""}, 0.30.19 ${tier} ${all.length} ${JSON.stringify(want.slice(0, 3))}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  }, 1_200_000);

  it.each([
    ["osprey", "sender", "none"], ["wren", "sender", "folder"], ["plover", "mailbox", "unread"], ["heron", "mailbox", "file"],
    ["egret", "sender", "from"], ["osprey item", "mailbox", "from"], ["wren -heron", "sender", "none"], ["heron", "date_asc", "none"],
    ["wren", "date_asc", "folder"], ["plover", "date_desc", "from"], ["wren lark", "date_desc", "unread"], ["wren -lark", "date_desc", "none"],
  ] as const)("%s, %s under %s, on 21,000 letters: every page in order, each match once, never bounded", async (q, sort, filter) => {
    const a = ACCTS[0]!;
    const { all } = await answerOf(a, q, filter);
    // Every match where there are at most 2,500 of them, else the first five pages.
    const want = ordered(sort, all).slice(0, all.length <= 2_500 ? undefined : 250);
    const got: number[] = [];
    let cursor: string | undefined;
    let last: Awaited<ReturnType<typeof svc.search>> | null = null;
    do {
      last = await svc.search(sctx(a), { q, parts: "page", sort, filters: FILTERS[filter]!.filters, ...(cursor ? { cursor } : {}) });
      expect(last.tier).toBe("exact");
      expect(last.bounded).toBe(false);
      got.push(...last.items.map(ageOf));
      cursor = last.nextCursor ?? undefined;
    } while (cursor && got.length < want.length);
    expect(got.slice(0, want.length)).toEqual(want);
    expect(cursor === undefined).toBe(want.length === all.length);
  }, 300_000);
});
