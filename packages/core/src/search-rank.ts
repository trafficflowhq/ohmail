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

/**
 * ═══ PUNCTUATION IS PART OF THE WORD ════════════════════════════════════════════════════════
 *
 * A reader typed `D-U-N-S` into search and was told there was nothing, while an opened message's
 * subject read "Your D-U-N-S Number is enclosed." Nothing was broken about either door — the
 * query simply did not survive being turned into words:
 *
 *  · the client index tokenized on `[\p{L}\p{N}]+` with a two-character floor, so both the
 *    QUERY and the SUBJECT lost the same four single letters and there was nothing left to
 *    match on either side, and
 *  · the SQL door's `websearch_to_tsquery('english','D-U-N-S')` is a PHRASE —
 *    `'d-u-n-' <-> 'd' <-> 'u' <-> 'n'` — which the subject's own vector does satisfy, so the
 *    archive had the message all along, but a punctuated query IS ONE LEXEME and a lexeme match
 *    is all-or-nothing: `Alpha/Beta merger` vectors as the single lexeme `'alpha/beta'`, and
 *    `pha/Bet` therefore matches nothing at all however plainly its characters are in the
 *    subject.
 *
 * The two doors cannot share an implementation — one tokenizes in JavaScript, the other hands
 * the string to Postgres — so what they share is the rule, here, for the reason this module
 * exists at all. `test/search-rank-census.test.ts` holds both to it.
 */

/**
 * A hyphenated or dotted run of letters and digits: `d-u-n-s`, `2026-09-08`, `dnb.example`.
 *
 * Two separators and no more. `-` and `.` are the characters that appear INSIDE things people
 * search for by name — reference numbers, dates, hostnames, part codes — and widening the set to
 * every punctuation mark would start gluing `and/or` and `see:this` into single terms, which is
 * a different rule with a different cost.
 */
const COMPOUND = /[\p{L}\p{N}]+(?:[-.][\p{L}\p{N}]+)+/gu;

/** The floor both doors already applied to a term, restated so this module can honour it. */
const MIN_TERM_LEN = 2;

/**
 * THE TWO EXTRA FORMS A COMPOUND IS WORTH, given the text it appears in.
 *
 * For each compound in `text`: the compound VERBATIM (`d-u-n-s`) and its JOINED form (`duns`).
 * Its PARTS are deliberately not returned — the caller's ordinary word pass already produces
 * them, under the caller's own length floor, and returning them here would make the two passes
 * disagree about that floor.
 *
 * The joined form is what lets the two spellings reach each other: a subject that says
 * `D-U-N-S` and a query that says `DUNS` share exactly this token and nothing else.
 *
 * Deduped and lower-cased. Order is the order of first appearance, so a caller that keeps the
 * first match for highlighting gets the compound rather than the joined form — the compound is
 * the one that can be found in the original string.
 */
export function compoundForms(text: string): string[] {
  const found = text.toLowerCase().match(COMPOUND);
  if (found === null) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const compound of found) {
    for (const form of [compound, compound.replace(/[-.]/g, "")]) {
      if (form.length < MIN_TERM_LEN || seen.has(form)) continue;
      seen.add(form);
      out.push(form);
    }
  }
  return out;
}

/**
 * Does this query hold a character that no word-splitter keeps?
 *
 * The gate on the SQL door's verbatim arm, and the reason it is a gate rather than an
 * unconditional second predicate: a substring scan for every query would widen every search in
 * the product to an unindexed `ILIKE`, and would also change what a MATCH means — `pha` would
 * start finding `Alpha/Beta`, which is not what the reader asked. A query with punctuation in it
 * is the case where the lexical arm can be confidently wrong, and it is the only case that pays.
 *
 * Whitespace is not punctuation here: a two-word query is two lexemes and the lexical arm
 * handles it correctly.
 */
export function holdsPunctuation(q: string): boolean {
  return /[^\p{L}\p{N}\s]/u.test(q);
}
