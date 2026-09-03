/**
 * THE SEARCH RANKING RULE — one definition, three doors.
 *
 * This module is dependency-free (no store, no clock, no network, no node builtin, no DOM) and
 * lives on its own source subpath for the reason `./drain-policy` and `./reply-subject` have
 * one: it is imported by two graphs that share nothing else — `packages/client-engine`, the
 * browser/phone engine that searches an in-memory mirror, and `packages/services`, whose search
 * is SQL against Postgres. Neither can share the other's implementation. What they MUST share is
 * the rule, or the two doors answer the same question in two different orders and only one of
 * them can be the one anybody tested.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────────
 *
 * 1. A hit is EXACT when every token of the query matched the message literally — an exact term,
 *    or (on a door that offers as-you-type) a prefix of one. It is SIMILAR when at least one
 *    token only reached the message through typo tolerance.
 * 2. The exact tier is ranked by relevance, and recency is only its TIE-BREAK. See
 *    {@link compareRanked}, which is the whole of that ordering and is called by every door
 *    that orders in JavaScript; the SQL door writes the same key sequence as an `order by`.
 * 3. **The similar tier is offered only when the exact tier is empty** ({@link showSimilar}), it
 *    is never interleaved, and no similar hit ever appears above an exact one. A door that
 *    renders both puts the similar ones under their own heading, below the exact ones — which,
 *    given the rule, means below nothing.
 *
 * ── WHY THE FLOOR IS ZERO AND NOT "FEWER THAN THREE" ────────────────────────────────────────
 *
 * A floor above zero was the obvious shape — show a few guesses when the real answer is thin —
 * and measurement refused it. Two facts decide it:
 *
 *  · **The case typo tolerance exists for has a zero exact tier by construction.** A misspelt
 *    word matches nothing literally. On the demo corpus `invoce` and `petar` — the canonical
 *    typo queries — return no exact hit at all, so a floor of zero still serves them fully.
 *  · **Every query WITH an exact hit was made worse by the guesses.** Measured on the same
 *    corpus: `graphite` had one exact hit and the fuzzy arm added `grat`, `grad` and `white`;
 *    `talk` had two and gained `walk`, `take` and `tag`; `atelier` had four and gained
 *    `lovelier`. Trigram similarity at a usable recall threshold is simply not a synonym
 *    relation, so a floor of three would re-admit exactly the rows the ordering rule exists to
 *    remove — and it would admit them on the queries a reader is most likely to be typing
 *    carefully.
 *
 * So the floor buys nothing on the queries fuzzy matching is FOR, and costs noise on every
 * query it is not for. Zero.
 */

/** The two tiers an answer can be. An answer is one or the other, never a mixture. */
export const SEARCH_TIERS = ["exact", "similar"] as const;
export type SearchTier = (typeof SEARCH_TIERS)[number];

/**
 * The number of exact hits at or below which the similar tier is offered.
 *
 * Zero, and the reason is in this module's header: a floor above it re-admits the noise on
 * precisely the queries that already had their answer. Raising it is a product decision, not a
 * tuning knob — `search-rank.test.ts` reads this constant, so a change here is a change the
 * ranking table has to be re-argued against.
 */
export const SIMILAR_FLOOR = 0;

/**
 * Should the similar (typo-tolerant) tier be shown at all, given how many exact hits there are?
 *
 * Every door asks this ONE function rather than comparing against the constant itself, so the
 * comparison (`<=`, not `<`) exists once. A door that inlined `count === 0` would be correct
 * today and silently wrong the day the floor moves.
 */
export function showSimilar(exactCount: number): boolean {
  return exactCount <= SIMILAR_FLOOR;
}

/**
 * The minimum length of an INDEXED TERM a typo match may be made against.
 *
 * Not the query token's length — that bound already existed and is a different one. This is the
 * length of the term in the corpus, and its absence was the single largest source of the noise
 * this bound answers: on a sample mailbox the query `invoce` produced twenty hits, nineteen of
 * which were the two-letter word `in` scoring a trigram similarity over the threshold. `anna`
 * reached twelve messages through `and`. Short words are common words, and a short word is
 * trigram-similar to a great many things.
 *
 * Four characters. `invoice`, `petra`, `graphite` — every term a person is plausibly reaching
 * for through a typo clears it, and the stop-word-shaped terms that generated the noise do not.
 */
export const MIN_FUZZY_TERM_LEN = 4;

/** The minimum length of a QUERY TOKEN before typo tolerance is attempted for it at all. */
export const MIN_FUZZY_QUERY_LEN = 4;

/**
 * One ranked row, reduced to the three things the ordering reads.
 *
 * Structural rather than a shared entity type: the client engine ranks `EngineMessage`s and the
 * webapp view ranks merged hits from two different sources. Neither should have to agree on a
 * message type to agree on an order.
 */
export interface RankedRow {
  /** Relevance. Higher first. Comparable only within one tier and one door. */
  score: number;
  /** The message's `Date:` as millis, or `null` when it has none. */
  dateMs: number | null;
  /** Stable identity — the last tie-break, so two identical rows never swap between renders. */
  id: string;
}

/**
 * RELEVANCE, THEN RECENCY, THEN IDENTITY — and the order of those three is the point.
 *
 * Recency is a TIE-BREAK and not a driver: it separates two rows the relevance signal cannot
 * tell apart, and it never promotes a less relevant row over a more relevant one. A ranking that
 * let the date lead would answer "what arrived recently that mentions this" for a reader who
 * asked "what mentions this" — which is what the `date_desc` sort is FOR, chosen deliberately.
 *
 * An undated message sorts LAST rather than first: a message with no `Date:` header has no place
 * on a timeline, and `null` compares as "unknown", never as "the beginning of time".
 *
 * The `id` tail is not decoration. Without it two rows that tie on both keys are free to swap
 * between renders, which reads as a result list that reshuffles itself while you look at it.
 */
export function compareRanked(a: RankedRow, b: RankedRow): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.dateMs !== b.dateMs) {
    if (a.dateMs === null) return 1;
    if (b.dateMs === null) return -1;
    return b.dateMs - a.dateMs;
  }
  return a.id.localeCompare(b.id);
}

/**
 * THE SQL DOOR'S ORDERING, AS A STRING — the same key sequence {@link compareRanked} applies.
 *
 * `packages/services` cannot call the comparator: its ranking is an `order by` evaluated by
 * Postgres over rows that never reach JavaScript. What it CAN do is build its order clause from
 * this template, so that the two doors' key sequences cannot drift apart silently — and
 * `search-census.test.ts` reads this constant out of the emitted SQL.
 *
 * `{rank}` is substituted with the tier's relevance expression. `nulls last` on the date is the
 * SQL spelling of the comparator's rule that an undated message sorts last.
 */
export const SQL_RANK_ORDER = "{rank} desc, m.date desc nulls last, m.id desc";
