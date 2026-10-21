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
 * THE HOSTED RANKING TABLE — the same claims as the client engine's, against real Postgres.
 *
 * It has to be here rather than in the PGlite suite for the standing reason `search.pg.test.ts`
 * exists: `pg_trgm` lives only on :5433, and the fuzzy arm this file is ABOUT degrades to an
 * ILIKE-contains without it. A green table under the degrade would say nothing about the
 * behaviour that shipped.
 *
 * ── WHAT WAS MEASURED HERE BEFORE THE TIERS ──────────────────────────────────────────────
 *
 * The two arms were fused by Reciprocal-Rank Fusion, which ranks by POSITION within an arm. A
 * fuzzy-arm hit at rank 1 scores `1/(60+1) = 0.01639`; a lexical hit at rank 5 scores
 * `1/(60+5) = 0.01538`. So on a seeded corpus the query `graphite` came back as:
 *
 *      1–4  graphite order / restock / samples / invoice     (lexical, exact)
 *      5    Fotos vom Grat                                   ← trigram guess, no lexical match
 *      6    Notes from the studio                            ← EXACT body match, demoted
 *      7–10 four more "Grat" rows
 *
 * — an exact match beneath a guess, and `total = 10` for a query with five answers, so the
 * count under the box described the noise. Case (1) below is that corpus.
 */
const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 5 });
const db = brandDialect(drizzle(client, { schema }), "pg");
const svc = new SearchService();

const NOW = new Date("2026-08-20T12:00:00.000Z");
const A = randomUUID();
const ids: Record<string, string> = {};

function ctx(): ServiceContext {
  return { db, accountId: A, userId: null, now: () => NOW, requestId: "search-tiers" };
}

async function seed(o: {
  key: string;
  mailboxId: string;
  subject: string;
  from: string;
  body: string;
  daysAgo: number;
}): Promise<void> {
  const [m] = await db
    .insert(messages)
    .values({
      accountId: A,
      mailboxId: o.mailboxId,
      bodyHash: "h",
      dedupKey: `tiers:${randomUUID()}`,
      subject: o.subject,
      fromAddress: o.from,
      date: new Date(NOW.getTime() - o.daysAgo * 86_400_000),
      unread: false,
      hasAttachments: false,
      nativeLocator: { folder: "INBOX", ref: "1:1" },
    })
    .returning();
  await db.insert(messageBodies).values({ messageId: m!.id, text: o.body });
  await db.insert(folderState).values({
    messageId: m!.id,
    desiredFolder: "INBOX",
    observedFolder: "INBOX",
    lastSetBy: "us",
  });
  ids[o.key] = m!.id;
}

describe("the hosted search ranking table (real Postgres, pg_trgm)", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    await ensureSearchExtensions(db, { concurrently: false });
    const [mb] = await db
      .insert(mailboxes)
      .values({ accountId: A, provider: "imap", address: "tiers@tf.example" })
      .returning();
    const id = mb!.id;

    // The exact match that used to be demoted: `graphite` in the BODY only, so its `ts_rank` is
    // low and the lexical arm ranks it below the four subject matches.
    await seed({
      key: "sketch",
      mailboxId: id,
      subject: "Notes from the studio",
      from: "ben@lichtgrat.example",
      body: "The graphite sketch came out well.",
      daysAgo: 40,
    });
    /*
     * Four strong lexical matches, so the lexical arm has depth and `sketch` sits at rank 5.
     *
     * `13 - i` and NOT `10 + i`, deliberately: it makes date order the REVERSE of insertion
     * order. With the two agreeing, case (4) stayed green with the date tie-break deleted —
     * Postgres returned the rows in heap order, which was insertion order, which was also the
     * order the test expected. A row that passes whether or not the thing it names exists is
     * not a guard, and this fixture is what makes it one.
     */
    for (const [i, s] of ["graphite order", "graphite restock", "graphite samples", "graphite invoice"].entries()) {
      await seed({
        key: `lex${i}`,
        mailboxId: id,
        subject: s,
        from: `shop${i}@pigmentpapier.example`,
        body: "graphite graphite graphite",
        daysAgo: 13 - i,
      });
    }
    // Five trigram-similar decoys with NO lexical match — the rows that used to pad the answer.
    for (const [i, s] of [
      "Fotos vom Grat", "Grat hike report", "Der Grat im Nebel", "Grat weather", "Grat gear list",
    ].entries()) {
      await seed({
        key: `grat${i}`,
        mailboxId: id,
        subject: s,
        from: `post${i}@gratbrief.example`,
        body: "Nothing to do with pencils.",
        daysAgo: i,
      });
    }
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    // FK order: the children first. The :5433 database is shared and long-lived, so a file that
    // leaves rows behind poisons the next run's counts rather than its own.
    await db.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${A})`);
    await db.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${A})`);
    await db.execute(sql`delete from messages where account_id = ${A}`);
    await db.execute(sql`delete from mailboxes where account_id = ${A}`);
    await client.end({ timeout: 5 });
  });

  it("(1) the exact tier answers alone — no guess in the list, and `total` counts what is shown", async () => {
    const r = await svc.search(ctx(), { q: "graphite" });
    expect(r.tier).toBe("exact");
    // Five lexical matches, and only those five. The five "Grat" rows are gone.
    expect(r.total).toBe(5);
    expect(r.items).toHaveLength(5);
    const returned = new Set(r.items.map((m) => m.id));
    for (const k of ["lex0", "lex1", "lex2", "lex3", "sketch"]) expect(returned).toContain(ids[k]!);
    for (const k of ["grat0", "grat1", "grat2", "grat3", "grat4"]) expect(returned).not.toContain(ids[k]!);
  });

  it("(2) the demoted exact match is IN the answer — it used to sit below a guess", async () => {
    const r = await svc.search(ctx(), { q: "graphite" });
    const order = r.items.map((m) => m.id);
    // It is last of the five, which is right: a body match is less relevant than four subject
    // matches. What matters is that nothing WITHOUT the word is above it any more.
    expect(order).toContain(ids.sketch!);
    const below = order.slice(order.indexOf(ids.sketch!) + 1);
    expect(below).toEqual([]);
  });

  it("(3) with nothing matching literally, the guesses answer — labelled `similar`", async () => {
    // Prove the lexical arm finds nothing first, or a green here would be ambiguous.
    const lex = await db.execute(sql`
      select count(*)::int as n
      from messages m left join message_bodies b on b.message_id = m.id
      where m.account_id = ${A}
        and (m.subject_tsv @@ websearch_to_tsquery('english', 'grrat')
             or b.body_tsv @@ websearch_to_tsquery('english', 'grrat'))`);
    const rows = Array.isArray(lex) ? lex : (lex as { rows: Array<{ n: number }> }).rows;
    expect((rows as Array<{ n: number }>)[0]!.n).toBe(0);

    const r = await svc.search(ctx(), { q: "grrat" });
    expect(r.tier).toBe("similar");
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.map((m) => m.id)).toContain(ids.grat0!);
  });

  it("(4) recency is the TIE-BREAK: equal `ts_rank`, newest first", async () => {
    // The four `lex*` rows carry the same relevance signal for this query and differ only in
    // date — and they were seeded so that date order is the REVERSE of insertion order, so this
    // expectation cannot be met by a heap scan that happens to agree. See the seeding comment.
    const r = await svc.search(ctx(), { q: "graphite" });
    const lexOrder = r.items.map((m) => m.id).filter((id) => id !== ids.sketch);
    expect(lexOrder).toEqual([ids.lex3!, ids.lex2!, ids.lex1!, ids.lex0!]);
  });

  it("(5) a NON-RELEVANCE sort orders the tier, and never re-admits the guesses", async () => {
    // This is the sharp one. `date_desc` runs its own arm over `matchPred` — and if that
    // predicate were still `lexical or fuzzy`, the five "Grat" rows (the NEWEST messages in
    // this corpus, 0–4 days old) would take the entire first page. Picking "Newest first"
    // would bring the noise straight back.
    const r = await svc.search(ctx(), { q: "graphite", sort: "date_desc" });
    expect(r.tier).toBe("exact");
    expect(r.total).toBe(5);
    for (const k of ["grat0", "grat1", "grat2", "grat3", "grat4"]) {
      expect(r.items.map((m) => m.id)).not.toContain(ids[k]!);
    }
    // Newest of the five matches leads: `lex3` at 10 days beats `sketch` at 40.
    expect(r.items[0]!.id).toBe(ids.lex3!);
    expect(r.items.at(-1)!.id).toBe(ids.sketch!);
  });

  it("(6) facets and total are counted over the SAME predicate the items came from", async () => {
    const r = await svc.search(ctx(), { q: "graphite" });
    const folderTotal = Object.values(r.facets!.folder).reduce((a, b) => a + b, 0);
    expect(folderTotal).toBe(r.total);
    expect(r.facets!.unread.true + r.facets!.unread.false).toBe(r.total);
    expect(r.facets!.hasAttachments.true + r.facets!.hasAttachments.false).toBe(r.total);
  });

  /**
   * (7) THE FIRST PAGE CARRIES ITS TYPO TIER, and starts it only when the exact tier is empty —
   * read off the page statement's own plan: every trigram node of an exact page never runs, and
   * the closest-words page (the control) runs them.
   */
  it("(7) a first page's typo arms run only when the exact tier is empty", async () => {
    const logged: Array<{ q: string; p: unknown[] }> = [];
    const traced = brandDialect(drizzle(client, { schema, logger: { logQuery: (q, p) => { logged.push({ q, p }); } } }), "pg");
    const trigramLoops = async (q: string): Promise<number[]> => {
      logged.length = 0;
      await svc.search({ ...ctx(), db: traced }, { q, parts: "page" });
      const page = logged.find((l) => l.q.includes("fused_s"));
      expect(page, `${q}: the page's statement was not logged`).toBeDefined();
      const plan = await client.begin(async (tx) => {
        await tx.unsafe("select set_config('pg_trgm.word_similarity_threshold', '0.3', true), set_config('enable_seqscan', 'off', true)");
        return tx.unsafe(`explain (analyze, format json) ${page!.q}`, page!.p as never[]);
      });
      const loops: number[] = [];
      const walk = (n: Record<string, unknown>): void => {
        if (JSON.stringify([n["Filter"], n["Index Cond"], n["Recheck Cond"]]).includes("<%")) loops.push(Number(n["Actual Loops"]));
        for (const c of (n["Plans"] as Array<Record<string, unknown>> | undefined) ?? []) walk(c);
      };
      walk(((plan[0] as Record<string, Array<Record<string, unknown>>>)["QUERY PLAN"]![0]!)["Plan"] as Record<string, unknown>);
      return loops;
    };
    const exact = await trigramLoops("graphite");
    expect(exact.length, "the typo arm is in the page's statement").toBeGreaterThan(0);
    expect(exact).toEqual(exact.map(() => 0));
    const typo = await trigramLoops("grrat");
    expect(typo.some((n) => n > 0), "the control: a closest-words page runs its trigram arm").toBe(true);
  });

  it("(8) a closest-words page says its total is a lower bound when its own arm was cut", async () => {
    // More guesses than four: a one-row page cuts the arm at four, a fifty-row page does not.
    const whole = await svc.search(ctx(), { q: "grrat", parts: "page", limit: 50 });
    expect(whole.items.length).toBeGreaterThan(4);
    expect({ tier: whole.tier, totalExact: whole.totalExact, total: whole.total })
      .toEqual({ tier: "similar", totalExact: true, total: whole.items.length });
    const cut = await svc.search(ctx(), { q: "grrat", parts: "page", limit: 1 });
    expect({ tier: cut.tier, totalExact: cut.totalExact }).toEqual({ tier: "similar", totalExact: false });
  });
});
