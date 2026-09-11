/**
 * The search ranking rule — one definition, three doors. Dependency-free, on its own source
 * subpath, because two graphs that share nothing else import it: `packages/client-engine`
 * searches an in-memory mirror, `packages/services` runs SQL. They must share the RULE. A hit is
 * EXACT when every query token matched literally (or by prefix on an as-you-type door), SIMILAR
 * when a token only matched through typo tolerance. The exact tier is ranked by {@link
 * compareRanked}; the similar tier appears only when the exact tier is empty ({@link
 * showSimilar}), never interleaved. The floor is zero: a misspelt query has a zero exact tier by
 * construction, and every measured query with an exact hit was made worse by fuzzy guesses.
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
 * The minimum length of an INDEXED TERM a typo match may be made against — not the query token's
 * length, which is a separate bound. Short corpus words were the largest noise source: on a
 * sample mailbox `invoce` produced twenty hits, nineteen of them the word `in` scoring over the
 * trigram threshold. Four characters clears every term a person plausibly reaches through a typo
 * (`invoice`, `petra`, `graphite`) and excludes the stop-word-shaped terms that generated the
 * noise.
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
 * Relevance, then recency, then identity — in that order. Recency is a tie-break, never a driver:
 * it separates rows the relevance signal cannot tell apart and never promotes a less relevant
 * row; a date-led ranking is what the `date_desc` sort is for. An undated message sorts LAST —
 * `null` compares as "unknown", never as the beginning of time. The `id` tail keeps two
 * fully-tied rows from swapping between renders.
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
 * The SQL door's ordering, as a string — the same key sequence {@link compareRanked} applies.
 * `packages/services` cannot call the comparator (its ranking is an `order by` evaluated by
 * Postgres), so it builds its order clause from this template and the two doors cannot drift
 * silently; `search-census.test.ts` reads this constant out of the emitted SQL. `{rank}` is the
 * tier's relevance expression; `nulls last` is the SQL spelling of "an undated message sorts
 * last".
 */
export const SQL_RANK_ORDER = "{rank} desc, m.date desc nulls last, m.id desc";

/**
 * Punctuation is part of the word. A reader typed `D-U-N-S` and was told there was nothing while
 * a subject read "Your D-U-N-S Number is enclosed": the client index tokenized on
 * letters-and-digits with a two-character floor, so query and subject both lost the same four
 * single letters; the SQL door's `websearch_to_tsquery` treats a punctuated query as ONE LEXEME,
 * and a lexeme match is all-or-nothing. The two doors cannot share an implementation — one
 * tokenizes in JavaScript, the other hands the string to Postgres — so they share the rule, here.
 * `test/search-rank-census.test.ts` holds both to it.
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
 * The two extra forms a compound is worth: the compound VERBATIM (`d-u-n-s`) and its JOINED form
 * (`duns`). Its parts are deliberately not returned — the caller's ordinary word pass already
 * produces them under its own length floor. The joined form is what lets the two spellings reach
 * each other: a subject saying `D-U-N-S` and a query saying `DUNS` share exactly this token.
 * Deduped, lower-cased, ordered by first appearance, so a highlighting caller gets the compound —
 * the form findable in the original string.
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
 * Does this query hold a character no word-splitter keeps? The gate on the SQL door's verbatim
 * arm: an unconditional substring scan would widen every search to an unindexed `ILIKE` and
 * change what a match means — `pha` would start finding `Alpha/Beta`. A punctuated query is the
 * case where the lexical arm can be confidently wrong, and the only case that pays. Whitespace is
 * not punctuation: a two-word query is two lexemes and the lexical arm handles it.
 */
export function holdsPunctuation(q: string): boolean {
  return /[^\p{L}\p{N}\s]/u.test(q);
}
