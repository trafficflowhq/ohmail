import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mailboxes, messageBodies } from "@trafficflow/db";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { SearchService, SEARCH_SORTS, isSearchSort } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/** The search documents of what was seeded, as ingest writes them with each letter. */
const indexed = (db: Awaited<ReturnType<typeof makeCtx>>["db"], accountId: string) =>
  searchIndexBackfillPass({ db: db as never, accountId });

/**
 * SEARCH RESULTS IN THE ORDER THE READER ASKED FOR.
 *
 * ═══ THE DEFECT THIS FILE EXISTS TO CATCH ══════════════════════════════════════════════════
 *
 * There is one obvious way to build this and it is wrong: take the fused RRF query that
 * already exists and hang the caller's `order by` on the end of it. It type-checks, it reads
 * naturally, and on a small mailbox every assertion anybody would think to write passes.
 *
 * It is wrong because the fused query is a RANKED SELECTION, not a filter. Each arm keeps its
 * top `ARM_LIMIT` (100) candidates by relevance and the final select keeps `limit` of the
 * fusion. Re-ordering that output by date answers "of the most relevant few, which is the
 * newest" — and the row it drops is precisely the one the reader wanted: a message that matched
 * weakly but arrived this morning.
 *
 * The fixture below is built to make that difference visible rather than theoretical: 105
 * decoys that match strongly through BOTH arms, and one weak match that is the newest mail in
 * the account. Under `relevance` the weak one is nowhere near the page. Under `date_desc` it
 * must be first. Hang the sort on the fused query and it cannot be, because it was never in the
 * set being sorted.
 *
 * ── ON PGlite ──────────────────────────────────────────────────────────────────────────────
 *
 * pg_trgm is absent here, so the fuzzy arm degrades to ILIKE-contains and ranks by recency
 * (`search-service.ts`). That is FAVOURABLE to the implementation under test rather than a
 * weakness of the fixture: the degraded fuzzy arm ranks by date, so if anything it pushes the
 * newest row UP under relevance. It still does not reach the page, because it does not match
 * that arm's predicate at all — the term appears nowhere in its subject or sender.
 */

/** The word every message in the fixture is searched by. */
const TERM = "kingfisher";

/** Comfortably past `ARM_LIMIT` (100), so the per-arm candidate window really does truncate. */
const DECOYS = 105;

const OLD = new Date("2026-06-01T09:00:00.000Z");
const NEWEST = new Date("2026-07-28T11:00:00.000Z");

/**
 * A body long enough that one occurrence of the term earns a LOW `ts_rank`: the ranking divides
 * by document length, so burying the word in filler is how a match is made weak without being
 * made absent.
 */
const FILLER = "the river ran wide and slow past the reeds and the alders ".repeat(40);

describe("search sorts over the match set, never over the relevance window", () => {
  /**
   * Builds the corpus once per test: `DECOYS` strong old matches, one weak newest match.
   *
   * Strong = the term is in the SUBJECT (so the document's head ranks it high) and repeated in a short
   * body, and the subject match is also what puts the row in the ILIKE fuzzy arm. Weak = the term
   * appears once, in the middle of a long body, and the subject and sender never mention it.
   */
  const seedCorpus = async (): Promise<{
    db: Awaited<ReturnType<typeof makeCtx>>["db"];
    ctx: Awaited<ReturnType<typeof makeCtx>>["ctx"];
    accountId: string;
    mailboxId: string;
    newest: string;
  }> => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    for (let i = 0; i < DECOYS; i++) {
      const id = await seedMessage(db, accountId, mailboxId, {
        subject: `${TERM} sighting report ${i}`,
        from: `ranger${i}@reserve.example`,
        date: new Date(OLD.getTime() + i * 60_000),
      });
      await db.insert(messageBodies).values({
        messageId: id, accountId,
        text: `a ${TERM} again today. ${TERM}, ${TERM}. report ${i}.`,
      });
    }
    // THE ROW THE WHOLE FILE IS ABOUT: newest in the account, and the term is buried.
    const newest = await seedMessage(db, accountId, mailboxId, {
      subject: "minutes of the water board meeting",
      from: "clerk@waterboard.example",
      date: NEWEST,
    });
    await db.insert(messageBodies).values({
      messageId: newest, accountId,
      text: `${FILLER} item nine, a ${TERM} was noted at the weir. ${FILLER}`,
    });
    await indexed(db, accountId);
    return { db, ctx, accountId, mailboxId, newest };
  };

  it("(1) date_desc returns the NEWEST match first — the one relevance never reaches", async () => {
    const { ctx, newest } = await seedCorpus();
    const svc = new SearchService();

    // The corpus really is bigger than the page and bigger than the candidate window, or the
    // rest of this test proves nothing.
    const relevance = await svc.search(ctx, { q: TERM, sort: "relevance", limit: 10 });
    expect(relevance.total).toBe(DECOYS + 1);
    expect(relevance.items).toHaveLength(10);

    // Relevance does not surface it. Not merely "not first" — not on the page at all, which is
    // the honest statement of the problem: no amount of scrolling this page reaches it.
    expect(relevance.items.map((m) => m.id)).not.toContain(newest);

    // THE GUARD. Red the moment the sort is applied to the fused output instead of to the match
    // set: `newest` is not in the fused window, so no re-ordering of that window can return it.
    const byDate = await svc.search(ctx, { q: TERM, sort: "date_desc", limit: 10 });
    expect(byDate.items[0]!.id).toBe(newest);

    // The match set itself is untouched by the ordering — facets and total run over the same
    // predicates and must not notice which sort was asked for.
    expect(byDate.total).toBe(relevance.total);
    expect(byDate.facets).toEqual(relevance.facets);

    // And the other direction genuinely reverses rather than merely differing: the oldest decoy
    // leads, and `newest` is nowhere near the front.
    const byDateAsc = await svc.search(ctx, { q: TERM, sort: "date_asc", limit: 10 });
    expect(byDateAsc.items.map((m) => m.id)).not.toContain(newest);
    const stamps = byDateAsc.items.map((m) => Date.parse(m.date!));
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  });

  it("(2) an ABSENT sort is relevance — the default branch, asserted rather than assumed", async () => {
    const { ctx } = await seedCorpus();
    const svc = new SearchService();

    // The branch nobody tests, because every caller in the codebase passes something. It is also
    // the branch every EXISTING caller takes, so a regression here is a regression in behaviour
    // that predates this feature entirely.
    const absent = await svc.search(ctx, { q: TERM, limit: 10 });
    const explicit = await svc.search(ctx, { q: TERM, sort: "relevance", limit: 10 });

    expect(absent.items.map((m) => m.id)).toEqual(explicit.items.map((m) => m.id));
    expect(absent.total).toBe(explicit.total);
    expect(absent.facets).toEqual(explicit.facets);
    // Byte-identical, not merely same-ids: the whole payload for the two calls is one value —
    // but for `ms`, the server time each answer reports about itself.
    expect(JSON.stringify({ ...absent, ms: 0 })).toBe(JSON.stringify({ ...explicit, ms: 0 }));
  });

  it("(3a) the mailbox arm groups by ADDRESS, newest-first within each group", async () => {
    const { db, ctx, accountId, mailboxId: first } = await makeCtx();

    // Two mailboxes whose addresses sort OPPOSITE to their creation order, so an implementation
    // that quietly ordered by `mailbox_id` or by insertion would not pass by luck. `makeCtx`
    // seeds the default seeded address; this one sorts before it.
    const [second] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: "aardvark@lichtgrat.example" })
      .returning();

    const t = (iso: string): Date => new Date(iso);
    const gOld = await seedMessage(db, accountId, first, { subject: `${TERM} one`, date: t("2026-07-01T09:00:00Z") });
    const gNew = await seedMessage(db, accountId, first, { subject: `${TERM} two`, date: t("2026-07-20T09:00:00Z") });
    const aOld = await seedMessage(db, accountId, second!.id, { subject: `${TERM} three`, date: t("2026-07-02T09:00:00Z") });
    const aNew = await seedMessage(db, accountId, second!.id, { subject: `${TERM} four`, date: t("2026-07-21T09:00:00Z") });
    await indexed(db, accountId);

    const r = await new SearchService().search(ctx, { q: TERM, sort: "mailbox" });

    // `aardvark@` before `mila@`, and inside each mailbox the newer message leads. The DATE
    // TIEBREAK is the half that is easy to get wrong: address-major with arbitrary dates inside
    // a group is not a list anybody can read.
    expect(r.items.map((m) => m.id)).toEqual([aNew, aOld, gNew, gOld]);
  });

  it("(3b) the sender arm orders by from_address, newest-first within each sender", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();

    const t = (iso: string): Date => new Date(iso);
    // Mixed case on one of them: the arm lowercases, exactly as the sender FILTER does, so
    // "Zoe" and "zoe" are one person rather than two blocks at opposite ends of the list.
    const zOld = await seedMessage(db, accountId, mailboxId, { subject: `${TERM} a`, from: "Zoe@late.example", date: t("2026-07-03T09:00:00Z") });
    const zNew = await seedMessage(db, accountId, mailboxId, { subject: `${TERM} b`, from: "zoe@late.example", date: t("2026-07-19T09:00:00Z") });
    const aOld = await seedMessage(db, accountId, mailboxId, { subject: `${TERM} c`, from: "anna@early.example", date: t("2026-07-04T09:00:00Z") });
    const aNew = await seedMessage(db, accountId, mailboxId, { subject: `${TERM} d`, from: "anna@early.example", date: t("2026-07-18T09:00:00Z") });
    await indexed(db, accountId);

    const r = await new SearchService().search(ctx, { q: TERM, sort: "sender" });

    expect(r.items.map((m) => m.id)).toEqual([aNew, aOld, zNew, zOld]);
  });

  it("(4) a sort NARROWS NOTHING — every order returns the same match set", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    for (let i = 0; i < 6; i++) {
      await seedMessage(db, accountId, mailboxId, { subject: `${TERM} ${i}`, date: new Date(OLD.getTime() + i * 1000) });
    }
    await indexed(db, accountId);
    const svc = new SearchService();

    // The invariant behind the `left join` on the mailbox arm: an ordering clause must never be
    // able to drop a hit. A search that returns fewer results when you reorder it is the same
    // class of quiet wrongness as sorting the relevance window.
    const seen = await Promise.all(
      SEARCH_SORTS.map(async (sort) => {
        const r = await svc.search(ctx, { q: TERM, sort });
        return { sort, total: r.total, ids: new Set(r.items.map((m) => m.id)) };
      }),
    );
    for (const s of seen) {
      expect(s.total, s.sort).toBe(6);
      expect(s.ids.size, s.sort).toBe(6);
      expect(s.ids, s.sort).toEqual(seen[0]!.ids);
    }
  });

  it("(5) the sort vocabulary is closed", () => {
    expect([...SEARCH_SORTS]).toEqual(["relevance", "date_desc", "date_asc", "mailbox", "sender"]);
    for (const s of SEARCH_SORTS) expect(isSearchSort(s)).toBe(true);
    // The values a client is most likely to invent, and the shapes an attacker would try.
    for (const bad of ["newest", "date", "DATE_DESC", "", "m.date desc", null, undefined, 3, {}]) {
      expect(isSearchSort(bad), String(bad)).toBe(false);
    }
    // Not a prototype walk: `toString` is on every object and is not a sort.
    expect(isSearchSort("toString")).toBe(false);
    expect(isSearchSort(randomUUID())).toBe(false);
  });
});
