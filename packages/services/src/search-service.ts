import { sql, type SQL } from "drizzle-orm";
import { holdsPunctuation, showSimilar, type SearchTier } from "@trafficflow/core/search-rank";
import type { ServiceContext, Db } from "./context.js";
import { dialect, pgOnly, type Dialect } from "@trafficflow/db/dialect";
import { materializeMessages } from "./dto/materialize.js";
import { clampLimit } from "./pagination.js";
import { ServiceError } from "./errors.js";
import type { MessageDTO } from "./dto/types.js";

/**
 * Hybrid search (lexical + fuzzy), the user's top HEY pain point
 * ("search is not fast/optimal/smart"). TWO SQL arms, and — this is the part that changed —
 * they are TIERS rather than contributors to one score:
 *   • lexical — `websearch_to_tsquery('english', q)` against the DB-generated
 *     `subject_tsv` (subject+from) and `body_tsv` (redacted body), ranked by
 *     `ts_rank`. Core Postgres, present in PGlite too. This is THE answer.
 *   • fuzzy   — pg_trgm `word_similarity(q, subject|from_address)` so a TYPO
 *     ("invoce" → "Invoice") still surfaces the right message a pure tsvector
 *     match MISSES. It runs ONLY when the lexical arm found nothing. When pg_trgm is
 *     absent (PGlite), it DEGRADES to an ILIKE-contains so the service still works offline.
 *
 * ── WHY THE RANK FUSION IS GONE ──────────────────────────────────────────────────────────
 *
 * The two arms used to be fused by Reciprocal-Rank Fusion — per-arm `row_number()` over a
 * bounded top-N window, fused score `sum(1/(k+rank))`. RRF fuses arms that are both trying to
 * answer the question; typo tolerance is not that. It is a GUESS about what the reader meant,
 * and RRF ranks by POSITION, so a guess at the top of the fuzzy arm scored `1/(60+1)` and beat
 * a real lexical match at rank five, `1/(60+5)`. Measured against real Postgres on a seeded
 * corpus: the query `graphite` put five messages about a mountain ridge ("Grat", trigram
 * similarity 0.33, no lexical match at all) into a five-answer result, one of them ABOVE the
 * message whose body says `graphite` — and `total` said ten, so the count on screen was a claim
 * about the noise.
 *
 * The tier rule that replaces it lives in `@trafficflow/core/search-rank`, shared with the
 * client engine's local index, because two doors answering one search in two different orders
 * is the same defect wearing different clothes. A third SEMANTIC (pgvector) arm, if it ever
 * lands, is a fusion candidate WITH the lexical arm — it is an attempt at the question — and
 * would not change where typo tolerance sits.
 *
 * Sensitivity: search runs ONLY over subject / from_address / the STORED
 * `message_bodies.text` (already redacted when sensitive) — it never re-derives a
 * secret and joins no raw-secret source. Everything is accountId-scoped.
 */

/** pg_trgm word-similarity floor for the fuzzy arm (Postgres default is 0.3). */
const FUZZY_THRESHOLD = 0.3;
/** How many senders the sender facet returns. */
const SENDER_FACET_LIMIT = 10;

/** Filters narrow the query — applied uniformly to results, facets, and total. */
export interface SearchFilters {
  folder?: string;            // a Destination (folder_state.desiredFolder, else native/INBOX)
  sender?: string;            // exact from_address (case-insensitive) — a facet click
  unread?: boolean;
  hasAttachments?: boolean;
  dateFrom?: string;          // ISO — inclusive lower bound on date
  dateTo?: string;            // ISO — inclusive upper bound on date
}

/**
 * THE ORDERS A CALLER MAY ASK FOR — a CLOSED set, and unknown values are refused at the route
 * rather than coerced to the default. Answering a different question than the one asked is how
 * a sorted list stops being trustworthy without anybody being able to see that it has.
 *
 * `relevance` is the default and IS the fused RRF ranking below, untouched. The other four are
 * a different query SHAPE, not a different `order by` on the same one — see {@link
 * SearchService.orderedArm} for why that distinction is the whole of this feature.
 */
export const SEARCH_SORTS = ["relevance", "date_desc", "date_asc", "mailbox", "sender"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/** Narrow an untrusted string to a {@link SearchSort}. Every route that accepts one uses this. */
export function isSearchSort(v: unknown): v is SearchSort {
  return typeof v === "string" && (SEARCH_SORTS as readonly string[]).includes(v);
}

/**
 * THE LONGEST SEARCH TERM THIS SERVICE ACCEPTS.
 *
 * `q` had no length bound anywhere, and it is not merely stored — it reaches three predicates
 * whose cost is superlinear in its length and is paid ONCE PER CANDIDATE ROW:
 *
 *   · `websearch_to_tsquery('english', q)` parses it into a tsquery; a megabyte of text is a
 *     megabyte of lexemes,
 *   · `word_similarity(q, m.subject)` and `word_similarity(q, m.from_address)` are pg_trgm
 *     trigram comparisons, i.e. O(len(q) × len(column)) per row, evaluated over the account's
 *     whole message table by the fuzzy arm, and
 *   · the offline degrade is `m.subject ilike '%' || q || '%'`, the same shape without an index.
 *
 * So one authenticated GET with a large `q` buys an arbitrary amount of CPU on a database every
 * other account shares. This is the read-side twin of the bound `admin.ts#accountQueryOf`
 * already applies for a smaller reason — *"so a megabyte of query string cannot become a
 * megabyte of `normalize('NFD')`"* — and it takes the same number.
 *
 * 200 characters. Longer than any phrase a person types into a mail search (a full subject line
 * is ~78 by RFC convention) and far shorter than anything whose trigram cost is interesting.
 *
 * **Over the limit is a 400, not a truncation and not an empty page.** Truncating would answer a
 * different question than the one asked, silently; an empty page is indistinguishable from "no
 * mail matches", which is the shape a caller cannot debug.
 */
export const SEARCH_QUERY_MAX_CHARS = 200;

/**
 * THE FACET FILTERS ARE DELIBERATELY UNBOUNDED, and this is the argument for that.
 *
 * `folder` and `sender` were briefly given a 512-character ceiling in the same slice that bounded
 * `q`, on the reasoning that a bound costs nothing and removes the need to re-check the argument
 * later. It was removed for a reason worth writing down, because it is the failure mode a bound
 * can have: **it refused a facet this service itself had just emitted.**
 *
 * `messages.from_address` is a `text` column written from whatever `From:` the sending server
 * delivered, scrubbed for case and NULs and bounded by nothing else. So `facets()` can legitimately
 * return a sender longer than any ceiling, the client renders it as a clickable facet, and clicking
 * it would have answered 400 — a refusal aimed at a value the product produced.
 *
 * And the cost these predicates carry does not need a bound. Both are EQUALITY comparisons
 * (`folderExpr = $1`, `lower(from_address) = lower($1)`), where Postgres compares lengths before
 * bytes, so a long value is one length check per row rather than work proportional to it. That is
 * the difference from `q`, whose trigram and `ILIKE` predicates ARE proportional — see
 * {@link SEARCH_QUERY_MAX_CHARS}, which is where the ceiling belongs.
 *
 * The remaining bound on these is whatever request-line limit the host in front imposes — they
 * arrive in a URL, so `JSON_BODY_MAX_BYTES` (a BODY ceiling) is not it. That is the honest answer
 * for a value whose cost is linear and paid once, and it is a different number on every
 * deployment.
 */

export interface SearchOptions {
  q: string;
  filters?: SearchFilters;
  limit?: number;
  /** Absent means `relevance` — the fused ranking, byte-identical to passing it explicitly. */
  sort?: SearchSort;
}

export interface Facets {
  /** desiredFolder (else native locator, else INBOX) → count. */
  folder: Record<string, number>;
  /** top-N senders by count within the match set. */
  sender: Array<{ address: string; count: number }>;
  unread: { true: number; false: number };
  hasAttachments: { true: number; false: number };
  /** coarse recency buckets. */
  date: { today: number; last7: number; last30: number; older: number };
}

export interface SearchResult {
  items: MessageDTO[];
  facets: Facets;
  /**
   * How many messages match — COUNTED OVER THE TIER THAT IS BEING RETURNED, never over both
   * arms. It used to count `lexical or fuzzy`, so a query with five real answers reported ten
   * and the number under the box described rows the reader could not see the point of.
   */
  total: number;
  /**
   * WHICH TIER THIS ANSWER IS. `exact` when the lexical arm matched; `similar` when it did not
   * and these rows are typo-tolerant guesses. Never a mixture — see the class header.
   *
   * A caller that renders `similar` rows without saying so is making the claim this field
   * exists to remove, which is why it is on the result and not left to be inferred from an
   * empty-looking list.
   */
  tier: SearchTier;
}

/**
 * ═══ THE ADDRESS ARM — one address, an EQUALITY, and only in the FROM direction ═════════════
 *
 * `GET /search?address=<addr>&direction=from`. It is not a filter on {@link SearchService.search}
 * and could not be: that method requires a `q` and answers `emptyResult()` without one, because
 * every one of its predicates is built out of the reader's words. An address query has no words.
 *
 * ── WHY `from` IS THE ONLY DIRECTION THIS DOOR ANSWERS ─────────────────────────────────────
 *
 * Measured on a private database at 20 000 rows with `EXPLAIN (ANALYZE, BUFFERS)`:
 *
 *   · `lower(from_address) = $1`, account-scoped   INDEX SCAN, `messages_account_from_addr_idx`,
 *                                                  4 shared buffers.
 *   · the recipients, either spelling               SEQ SCAN. They are two JSONB columns —
 *     (`jsonb_array_elements(to_addresses)`,        `messages.to_addresses` / `.cc_addresses`,
 *      or `to_addresses @> …`)                      `EmailAddress[]` — and NO index exists on
 *                                                   either one. There is no recipients table.
 *   · `lower(from_address) = $1 OR exists(to) …`    SEQ SCAN — **the OR loses the from-index
 *                                                   too**, which is why this is one predicate
 *                                                   and never a union of the two questions.
 *
 * A recipient index is a migration with a backfill (a lowercased `text[]` maintained at ingest
 * plus a GIN — JSONB containment cannot case-fold, so a GIN on the JSONB columns is not the
 * answer), and it is not this change. So this door answers the direction it can serve from an
 * index and **REFUSES the other two BY NAME** rather than answering them partially:
 * `search_direction_unsupported`, 400.
 *
 * A refusal and not an empty page, and not a silent from-only answer either. An empty list is
 * indistinguishable from "this address never received mail from you", and a from-only answer to
 * `direction=any` is a claim about the whole archive that is false by exactly the recipients.
 * The client's own request builder therefore asks for `from` whatever its toggle says, and the
 * view states the archive's half as "by sender" — see `apps/webapp/app/shell/address-view.ts`.
 */
export const ADDRESS_DIRECTIONS = ["any", "from", "to"] as const;
export type AddressSearchDirection = (typeof ADDRESS_DIRECTIONS)[number];

/**
 * THE DIRECTIONS THIS SERVICE CAN SERVE FROM AN INDEX — one, today. A closed list rather than a
 * hard-coded `=== "from"` so the day the recipient index lands, the arm and its refusal move
 * together; a comparison spelled inline in three places is three places to forget.
 */
export const ADDRESS_DIRECTIONS_SERVED: readonly AddressSearchDirection[] = ["from"];

/** Narrow an untrusted string to a direction. Every door that accepts one uses this. */
export function isAddressSearchDirection(v: unknown): v is AddressSearchDirection {
  return typeof v === "string" && (ADDRESS_DIRECTIONS as readonly string[]).includes(v);
}

export interface AddressSearchOptions {
  /** The address, matched by `lower()` equality. Never a substring and never tokenized. */
  address: string;
  /** Which side of the message. Only the members of {@link ADDRESS_DIRECTIONS_SERVED} are answered. */
  direction: AddressSearchDirection;
  limit?: number;
}

export interface AddressSearchResult {
  /** Newest first — `SQL_RANK_ORDER`'s key sequence with the relevance term removed. */
  items: MessageDTO[];
  /** How many messages match, over the whole archive rather than over this page. */
  total: number;
  /**
   * WHICH DIRECTION THIS ANSWER IS ABOUT — always `"from"` today, and on the wire rather than
   * inferred. A caller that asked for `from` and a caller whose toggle says "All" receive the
   * same rows, and only this field lets the second one label them honestly.
   */
  direction: AddressSearchDirection;
}

/** Normalize the driver-specific `execute` shape: postgres-js returns an array,
 *  PGlite returns `{ rows }`. Keep every read below driver-agnostic. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** The empty result — used for a blank query (no predicate would be safe/meaningful). */
function emptyResult(): SearchResult {
  return {
    items: [],
    facets: {
      folder: {}, sender: [],
      unread: { true: 0, false: 0 },
      hasAttachments: { true: 0, false: 0 },
      date: { today: 0, last7: 0, last30: 0, older: 0 },
    },
    total: 0,
    tier: "exact",
  };
}

// pg_trgm presence is a property of the physical database, not the request; memoize
// per Db handle so we probe `to_regprocedure` at most once per connection object.
const trgmCache = new WeakMap<object, Promise<boolean>>();
function hasTrgm(db: Db): Promise<boolean> {
  // ASKED ONLY OF A STORE THAT COULD ANSWER. `to_regprocedure` is a server function, so composing
  // this for the device store would not return `false` — it would fail to parse, during a search.
  // The seam puts this probe in the caller by contract, because one dialect runs against a
  // database that HAS the extension and one that does not; the device is neither, and its answer
  // is a fact about the store.
  if (dialect(db).name !== "pg") return Promise.resolve(false);
  const key = db as unknown as object;
  let p = trgmCache.get(key);
  if (!p) {
    /* A DECLARED POSTGRES-ONLY ARM, and it is unreachable above: the guard one line up answers
       `false` for any store that is not the server, so this statement is never composed there.
       It stays in the caller by the seam's own contract — the fuzzy member IS the trigram arm,
       and whether THIS deployment has the extension is a fact about the deployment, not about
       the dialect, which is why the seam takes it as an argument rather than guessing it. The
       question has no second spelling: `to_regprocedure` reads a Postgres catalog. */
    p = db.execute(pgOnly(sql`select to_regprocedure('word_similarity(text,text)') is not null as ok`))
      .then((r) => Boolean(rowsOf<{ ok: boolean }>(r)[0]?.ok))
      .catch(() => false);
    trgmCache.set(key, p);
  }
  return p;
}

export class SearchService {
  /** The FROM + 1:1 LEFT JOINs shared by every arm/facet query (no row fan-out:
   *  message_bodies and folder_state are both UNIQUE per message). */
  private readonly from = sql`
    from messages m
    left join message_bodies b on b.message_id = m.id
    left join folder_state fs on fs.message_id = m.id`;

  /** desiredFolder → native locator folder → INBOX (mirrors materializeMessage). */
  private readonly folderExpr = sql`coalesce(fs.desired_folder, m.native_locator->>'folder', 'INBOX')`;

  async search(ctx: ServiceContext, opts: SearchOptions): Promise<SearchResult> {
    // ── THE CEILING IS CONSULTED BEFORE ANYTHING SCANS THE STRING ─────────────────────────
    //
    // `.length` is O(1); `.trim()` is O(n) and would have scanned a ten-megabyte caller string
    // before the ceiling below ever ran — and an all-whitespace one would then have paid for that
    // scan and returned a silent empty result, which is the exact failure shape this class is
    // named for. So the RAW length decides, and the refusal reports it because that is the number
    // the caller has to bring down.
    //
    // It allows exactly ONE character over, which is one trailing space on a term at the ceiling
    // — the only case the trim was ever for. Two spaces on such a term are refused, and that is
    // the deliberate trade: the alternatives are trimming first, which is the unbounded scan, and
    // slicing first, which silently ACCEPTED a truncated query. This comment twice said the
    // ceiling is measured on the trimmed value; it is not, and the difference is a character.
    const raw = opts.q ?? "";
    /**
     * THE RAW LENGTH DECIDES, and the version that sliced first was silently wrong.
     *
     * Slicing to the ceiling PLUS ONE and then trimming looks equivalent and is not: a term of
     * exactly `MAX` characters followed by a space and more text slices to `MAX + 1`, trims the
     * boundary space away, and passes as a `MAX`-character query — so the caller's search ran
     * against a PREFIX of what they typed, with a 200 and no indication. That is the silent
     * truncation this bound's own docstring refuses, produced by the bound.
     *
     * So the ceiling is consulted on the raw LENGTH first (`.length` is O(1), which was the whole
     * reason for slicing at all), and it allows exactly ONE character over — which is exactly one
     * trailing space on a term at the ceiling, the case the trim exists for. Two characters over
     * cannot trim back to the ceiling without losing a non-space, so it is refused here; anything
     * that survives to the check below is refused there. Neither path truncates.
     */
    if (raw.length > SEARCH_QUERY_MAX_CHARS + 1) {
      throw new ServiceError(
        "validation_failed", 400,
        `q is ${raw.length} characters; the limit is ${SEARCH_QUERY_MAX_CHARS}`,
      );
    }
    const q = raw.trim();
    if (!q) return emptyResult();
    // BEFORE the tsquery, the trigram comparisons and the ILIKE degrade — see
    // {@link SEARCH_QUERY_MAX_CHARS}. Refused, never truncated: a truncated term answers a
    // question the caller did not ask, and does it silently.
    if (q.length > SEARCH_QUERY_MAX_CHARS) {
      throw new ServiceError(
        "validation_failed", 400,
        `q is ${raw.length} characters; the limit is ${SEARCH_QUERY_MAX_CHARS}`,
      );
    }
    const limit = clampLimit(opts.limit);
    // The DEFAULT BRANCH, stated once. An absent `sort` is `relevance` and takes the fused
    // query below with nothing changed — see the `hitQuery` ternary.
    const sort: SearchSort = opts.sort ?? "relevance";

    // ── shared predicates ──────────────────────────────────────────────────
    // BOTH ARMS THROUGH THE SEAM. The two stores index this text in ways that share no syntax —
    // a generated `tsvector` column on the row here, separate full-text tables joined by `rowid`
    // there — and neither spelling parses on the other. `"mail"` names the corpus because the
    // device arm needs TABLE NAMES this file has no reason to know.
    const d = dialect(ctx.db);
    const where = this.whereSql(d, ctx.accountId, opts.filters ?? {});

    const trgm = await hasTrgm(ctx.db);
    const lex = d.search.lexical(q, "mail");
    // Typo tolerance where the extension exists, and where it does not the seam's degrade — the
    // same substring shape this file used to spell inline, ranked by RECENCY for the reason the
    // old comment gave: offline there is no relevance signal left.
    const fuzz = d.search.fuzzy(q, "mail", { trigram: trgm, threshold: FUZZY_THRESHOLD });
    const lexPred = lex.pred;
    const lexRank = lex.rank;
    const fuzzPred = fuzz.pred;
    const fuzzRank = fuzz.rank;

    /**
     * ── THE VERBATIM ARM: A PUNCTUATED QUERY IS ONE LEXEME, AND A LEXEME MATCH IS ALL-OR-NOTHING
     *
     * `to_tsvector('english','Alpha/Beta merger')` is `'alpha/beta':1 'merger':2` — one lexeme
     * for the slashed pair — so `websearch_to_tsquery('english','pha/Bet')` (`'pha/bet'`) matches
     * NOTHING, however plainly those characters sit in the subject. That is not a stemming
     * near-miss the fuzzy arm should be guessing about; the reader's characters are present, in
     * order, in the field. So they are matched as characters.
     *
     * Three bounds on it, and each is load-bearing:
     *
     *  · **Gated on punctuation** ({@link holdsPunctuation}, shared with the client index's
     *    tokenizer). Running an unindexed `ILIKE '%…%'` for every query would widen every search
     *    in the product to a substring scan AND change what a match means — `pha` would start
     *    finding `Alpha/Beta`, which is not the question asked. `search-punctuation.pg.test.ts`
     *    case (d) is the pair that tells the gate apart: the same characters, punctuation the
     *    only difference, and the tier flips.
     *  · **Never the only arm.** It is OR'd with `lexPred`, so it can only ever ADD rows.
     *  · **Ranked below the lexical arm** — and the expression below is why that needed care:
     *    `ts_rank` is NOT zero for a row the tsquery fails to match. Measured on this exact
     *    subject: `ts_rank(to_tsvector('english','Marker xD-U-N-Sx only'), 'D-U-N-S')` is
     *    0.0991 with `@@` false, because the rank function scores whatever query lexemes are
     *    present and knows nothing about the phrase operator that refused. So the tier cannot be
     *    inferred from the rank; it is stated — `1 + ts_rank` for a lexical row, `0` for a
     *    verbatim-only one — which puts every verbatim row below every lexical one regardless of
     *    what `ts_rank` returns, and leaves the order AMONG lexical rows exactly as it was.
     *
     * Subject only. `message_bodies.text` has no index that could serve this predicate and a
     * body scan is a different cost argument; the query length is already bounded by
     * {@link SEARCH_QUERY_MAX_CHARS}, which is what keeps the `ILIKE` itself cheap per row.
     */
    // THROUGH THE SEAM, like the fuzzy degrade that used to share this line: `ilike` is the
    // server's word for it and the device store has no such operator — it folds both sides
    // instead, ASCII only, which is a narrower comparison and the one that store can make.
    const like = `%${q}%`;
    const verbatimPred = holdsPunctuation(q) ? d.ilike(sql`m.subject`, like) : null;
    const exactPred = verbatimPred === null ? lexPred : sql`(${lexPred} or ${verbatimPred})`;
    const exactRank = verbatimPred === null
      ? lexRank
      : sql`(case when ${lexPred} then 1 + ${lexRank} else 0 end)`;

    /**
     * ── THE TIER IS DECIDED BEFORE A SINGLE ROW IS RANKED ──────────────────────────────────
     *
     * The EXACT arm is counted first, and that count IS `total` whenever it is non-zero — so
     * in the common case (a query with an answer) this costs nothing: `total` was always going
     * to be counted, and it is now counted over one predicate instead of two. The fuzzy arm's
     * count is paid only on a query the corpus does not literally answer, which is the case a
     * reader is already waiting on a guess for.
     *
     * "Exact" is `lexPred`, plus the verbatim arm on a punctuated query — see {@link
     * SearchService.search}'s verbatim block above. It is deliberately the count over the
     * predicate the ROWS come from: counting the lexical arm alone would have put a query whose
     * only answers are verbatim into the SIMILAR tier and filed real matches as guesses.
     *
     * `showSimilar` rather than `=== 0` so the floor exists in exactly one place; the argument
     * for its value is in `@trafficflow/core/search-rank`, measured on both doors.
     */
    const exactTotal = await this.count(ctx, d, where, exactPred);
    const tier: SearchTier = showSimilar(exactTotal) ? "similar" : "exact";
    const matchPred = tier === "exact" ? exactPred : fuzzPred;
    const rank = tier === "exact" ? exactRank : fuzzRank;
    const total = tier === "exact" ? exactTotal : await this.count(ctx, d, where, fuzzPred);

    /**
     * THE RELEVANCE QUERY — one arm, the tier's own, over the tier's own predicate.
     *
     * No candidate window. The RRF version bounded each arm at 100 rows before fusing, which
     * meant the final `limit` was applied to a SELECTION rather than to the match set — and the
     * row it silently dropped was the one outside the window. With one arm the `order by`
     * decides which `limit` rows come back, which is what a relevance ranking is.
     *
     * The key sequence is `SQL_RANK_ORDER`'s and it is the client comparator's: relevance, then
     * recency as a TIE-BREAK, then id so two rows that tie on both never swap between calls.
     * `nulls last` is the SQL spelling of "an undated message has no place on a timeline".
     */
    const ranked = sql`
      select m.id
      ${this.from}
      where ${where} and ${matchPred}
      order by ${rank} desc, m.date desc nulls last, m.id desc
      limit ${limit}`;

    /**
     * ── THE ONE THING THIS FEATURE MUST NOT DO ────────────────────────────────────────────
     *
     * A user-chosen order is a DIFFERENT QUERY, never an `order by` bolted onto the fused one.
     * The fused query is a RANKED SELECTION: each arm keeps its top {@link ARM_LIMIT}
     * candidates and the final select keeps `limit` of the fusion. Sorting THAT by date answers
     * "of the most relevant few, which is newest" — which is not the question, and the row it
     * silently drops is exactly the one the reader asked for: the newest match sitting outside
     * the relevance window. On a corpus larger than the window it is invisibly wrong, which is
     * the worst kind.
     *
     * The relevance query no longer HAS a candidate window (the fusion it came from is gone —
     * see the class header), so the two shapes are closer than they were. The distinction still
     * stands, and the file keeps it: a non-relevance sort runs over the SAME predicates
     * (`where` + `matchPred`, the identical match set facets and total are counted over) with a
     * different order key, and the sort key decides which `limit` rows come back.
     * `search-sort.r12.test.ts` plants a low-relevance newest match and watches this.
     *
     * **`matchPred` IS THE TIER'S PREDICATE, and passing it here is load-bearing.** Ordering by
     * date over `lexical or fuzzy` would re-admit every typo guess the tier rule just excluded,
     * and put the newest of them at the top — the reader would pick "Newest first" and watch
     * the noise come back. One predicate, decided once, used by the hits, the facets and the
     * total alike.
     */
    const hitQuery = sort === "relevance" ? ranked : this.orderedArm(where, matchPred, sort, limit);
    // Positional rows on both stores — the seam's one shape, and this statement selects one
    // column, so position 0 is the id.
    const hitRows = (await d.exec(ctx.db, hitQuery)).map((r) => ({ id: String(r[0]) }));

    /**
     * Re-materialize the hits into canonical MessageDTOs (folder + sensitivity), preserving
     * fused order. `materializeMessages` re-checks accountId, exactly as the singular
     * form does — it is the same function; the singular one is a one-element wrapper over it.
     *
     * ── WHY THE BATCH FORM, AND WHY IT MATTERED THE DAY THIS GOT A CALLER ──────────────────
     *
     * This was `for (const h of hitRows) await materializeMessage(...)`. Each call issues FOUR
     * queries (messages, folder_state, message_states, message_tags), so a default page of 50
     * hits was 200 statements, awaited one after another, on a pool the API runs at `max: 1`.
     * That was invisible for as long as `GET /search` had zero callers on any surface — which
     * it did, for its whole life until now. Wiring the client is what turns it into a hot path,
     * so it is fixed in the same change: 4 statements for the page, regardless of its size.
     *
     * NOT parallelised — batched. Firing the per-hit calls concurrently would have been the
     * other way to make the numbers look better and is the shape that deadlocked the admin
     * console on the same `max: 1` pool.
     */
    const byId = await materializeMessages(ctx.db, ctx.accountId, hitRows.map((h) => h.id));
    const items: MessageDTO[] = [];
    for (const h of hitRows) {
      const dto = byId.get(h.id);
      if (dto) items.push(dto);
    }

    const facets = await this.facets(ctx, d, where, matchPred);
    return { items, facets, total, tier };
  }

  /**
   * EVERY MESSAGE IN THE ARCHIVE FROM ONE ADDRESS — the address view's archive half.
   *
   * See {@link AddressSearchOptions} for why `from` is the only direction served and why the
   * other two are refused by name. Three properties are the whole of the query:
   *
   *  · `lower(m.from_address) = lower($1)` — byte-for-byte {@link SearchService.whereSql}'s
   *    `sender` filter, so the two doors into "mail from this person" cannot answer differently,
   *    and the index `messages_account_from_addr_idx` (`(account_id, lower(from_address), id)`)
   *    serves it. An EQUALITY: no `like`, no `%`, no tokenizing. A substring match here would put
   *    a stranger's mail on screen under somebody else's name, which is why the pg twin asserts
   *    a substring returns nothing rather than merely asserting the exact match returns something.
   *  · `whereSql` supplies the account scope and `deleted_at is null`. The account LEADS the
   *    index for the reason that index's own comment gives: a sender address is attacker-choosable,
   *    so it can never be a filter applied to a cross-account result.
   *  · The order is `date desc nulls last, id desc` — `SQL_RANK_ORDER` with the relevance term
   *    dropped, because there is none. Newest first is the view's order, and the `id` tail keeps
   *    two rows sharing an instant from swapping between calls.
   *
   * An EMPTY address answers empty rather than matching the rows whose `from_address` is `''`
   * (the column is `NOT NULL DEFAULT ''`, so those rows are real). A caller reaches this by
   * handing the service an address it failed to parse, and the honest answer to "show me
   * everything from nobody" is nothing.
   */
  async searchByAddress(
    ctx: ServiceContext, opts: AddressSearchOptions,
  ): Promise<AddressSearchResult> {
    if (!ADDRESS_DIRECTIONS_SERVED.includes(opts.direction)) {
      throw new ServiceError(
        "search_direction_unsupported", 400,
        `direction ${opts.direction} is not searchable in the archive yet; `
        + `only ${ADDRESS_DIRECTIONS_SERVED.join(", ")} is`,
      );
    }
    // The ceiling {@link SEARCH_QUERY_MAX_CHARS} exists for predicates whose cost is
    // superlinear in the string's length. This one is an equality, where Postgres compares
    // lengths before bytes — the same argument `whereSql`'s `sender` filter is deliberately
    // unbounded on, and for the same reason: a bound here could refuse an address the product
    // itself emitted. See the note above {@link SearchOptions}.
    const address = opts.address;
    if (address === "" || address.trim() === "") {
      return { items: [], total: 0, direction: opts.direction };
    }
    const limit = clampLimit(opts.limit);
    const d = dialect(ctx.db);
    const where = this.whereSql(d, ctx.accountId, {});
    const pred = sql`lower(m.from_address) = lower(${address})`;

    const total = await this.count(ctx, d, where, pred);
    /* THROUGH THE SEAM, AND THE ROWS COME BACK POSITIONAL.
     *
     * `d.exec` answers `unknown[][]` on both stores — its own contract says positional is the shape
     * both can produce honestly — so this reads `r[0]` and not `.id`. A `db.execute` here would
     * compile and run on the server and throw on the device, which is what the seam exists to stop.
     * `search-address.pg.test.ts` pins the shape and the order this page comes back in. */
    const hitRows = await d.exec(ctx.db, sql`
      select m.id
      ${this.from}
      where ${where} and ${pred}
      order by m.date desc nulls last, m.id desc
      limit ${limit}`);
    const hitIds = hitRows.map((r) => String(r[0]));

    // The batch form, for the reason {@link SearchService.search} gives at its own call site:
    // four statements for the page instead of four per hit on a `max: 1` pool.
    const byId = await materializeMessages(ctx.db, ctx.accountId, hitIds);
    const items: MessageDTO[] = [];
    for (const id of hitIds) {
      const dto = byId.get(id);
      if (dto) items.push(dto);
    }
    return { items, total, direction: opts.direction };
  }

  // ── the user-chosen orders ────────────────────────────────────────────────

  /**
   * ONE ARM, over the whole match set, ordered by the key the caller asked for.
   *
   * NO MIGRATION AND NO NEW INDEX: every key is a column that already exists. The `tsv` GIN
   * indexes still carry the MATCH — this is `where ${where} and ${matchPred}`, the same
   * predicates {@link SearchService.total} and {@link SearchService.facets} run over — and the
   * sort happens across the rows that match, which is the definition of the feature.
   *
   * ── THE JOIN IS `left`, DELIBERATELY ────────────────────────────────────────────────────
   *
   * `messages.mailbox_id` is NOT NULL with a foreign key, so an inner join would be equivalent
   * today. It is a `left join` anyway because the invariant worth protecting is that **a sort
   * never changes WHICH rows match, only the order they come back in.** An inner join makes the
   * ordering clause capable of dropping a hit, and a search that returns fewer results when you
   * reorder it is the same class of quiet wrongness as sorting the fused window. `nulls last`
   * on the address is the other half of that.
   *
   * Every order ends in `m.id`, so two rows that tie on the key (same instant, same sender)
   * still come back in a fixed order. Without it a tie is free to flip between calls, which
   * reads as a list that reshuffles itself while you look at it.
   */
  private orderedArm(
    where: SQL, matchPred: SQL, sort: Exclude<SearchSort, "relevance">, limit: number,
  ): SQL {
    // Only the mailbox key needs a row this query does not already have.
    const from = sort === "mailbox"
      ? sql`${this.from} left join mailboxes mbx on mbx.id = m.mailbox_id`
      : this.from;

    // `nulls last` on both date directions: a message with no `Date:` header has no place on a
    // timeline, and Postgres would otherwise sort it FIRST on `asc`. Unknown belongs at the end
    // in both readings of "by date".
    const order =
      sort === "date_desc" ? sql`m.date desc nulls last, m.id desc`
      : sort === "date_asc" ? sql`m.date asc nulls last, m.id asc`
      // Mail is grouped BY MAILBOX and then newest-first inside each one — a flat address-major
      // ordering with arbitrary dates inside a group is not a list anybody reads.
      : sort === "mailbox" ? sql`lower(mbx.address) asc nulls last, m.date desc nulls last, m.id desc`
      // `lower()` so "Anna@" and "anna@" are one sender, matching `whereSql`'s sender filter.
      : sql`lower(m.from_address) asc, m.date desc nulls last, m.id desc`;

    return sql`
      select m.id
      ${from}
      where ${where} and ${matchPred}
      order by ${order}
      limit ${limit}`;
  }

  // ── facets & total over the SAME candidate set (filters + text match) ──────

  /**
   * How many rows a predicate matches. Called twice for different jobs and it is worth naming
   * both: once to DECIDE the tier (over the lexical predicate, before anything is ranked), and
   * once — the same call, the same number — as the `total` the caller renders. In the exact tier
   * those are one query, not two.
   */
  private async count(ctx: ServiceContext, d: Dialect, where: SQL, matchPred: SQL): Promise<number> {
    const rows = await d.exec(ctx.db,
      sql`select ${d.castInt(sql`count(*)`)} as n ${this.from} where ${where} and ${matchPred}`);
    return Number(rows[0]?.[0] ?? 0);
  }

  private async facets(ctx: ServiceContext, d: Dialect, where: SQL, matchPred: SQL): Promise<Facets> {
    const now = ctx.now();
    const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
    // THE INSTANT IS A DIFFERENT LITERAL ON EACH STORE — an ISO string the server parses, a count
    // of milliseconds the device keeps — and the old comment named only half the reason (that
    // postgres-js will not serialize a bare Date through a raw `sql`). Both halves are the seam's.
    const today = d.ts(todayStart);
    const d7 = d.ts(new Date(todayStart.getTime() - 7 * 86_400_000));
    const d30 = d.ts(new Date(todayStart.getTime() - 30 * 86_400_000));
    const n = (e: SQL): SQL => d.castInt(e);

    // Scalars (unread / hasAttachments / recency buckets) in one aggregate pass.
    const scalarSql = sql`
      select
        ${n(sql`count(*) filter (where m.unread)`)} as unread_t,
        ${n(sql`count(*) filter (where not m.unread)`)} as unread_f,
        ${n(sql`count(*) filter (where m.has_attachments)`)} as att_t,
        ${n(sql`count(*) filter (where not m.has_attachments)`)} as att_f,
        ${n(sql`count(*) filter (where m.date >= ${today})`)} as d_today,
        ${n(sql`count(*) filter (where m.date >= ${d7} and m.date < ${today})`)} as d_7,
        ${n(sql`count(*) filter (where m.date >= ${d30} and m.date < ${d7})`)} as d_30,
        ${n(sql`count(*) filter (where m.date is null or m.date < ${d30})`)} as d_older
      ${this.from}
      where ${where} and ${matchPred}`;

    const folderSql = sql`
      select ${this.folderExpr} as folder, ${n(sql`count(*)`)} as c
      ${this.from}
      where ${where} and ${matchPred}
      group by 1`;

    const senderSql = sql`
      select m.from_address as address, ${n(sql`count(*)`)} as c
      ${this.from}
      where ${where} and ${matchPred}
      group by 1
      order by c desc, address asc
      limit ${SENDER_FACET_LIMIT}`;

    // POSITIONAL ROWS, in the order each statement selects — the seam's one shape on both stores.
    // The scalar row's eight positions are the eight aggregates above, read by index rather than
    // by alias; if that list is ever reordered, these indices move with it.
    const [scalarR, folderR, senderR] = await Promise.all([
      d.exec(ctx.db, scalarSql),
      d.exec(ctx.db, folderSql),
      d.exec(ctx.db, senderSql),
    ]);

    const s = (scalarR[0] ?? []).map((v) => Number(v ?? 0));
    const folder: Record<string, number> = {};
    for (const row of folderR) folder[String(row[0])] = Number(row[1] ?? 0);

    return {
      folder,
      sender: senderR.map((r) => ({ address: String(r[0]), count: Number(r[1] ?? 0) })),
      unread: { true: s[0] ?? 0, false: s[1] ?? 0 },
      hasAttachments: { true: s[2] ?? 0, false: s[3] ?? 0 },
      date: { today: s[4] ?? 0, last7: s[5] ?? 0, last30: s[6] ?? 0, older: s[7] ?? 0 },
    };
  }

  // ── filter → WHERE (account scope always first) ───────────────────────

  /**
   * The two date bounds are the only filter values that are CAST rather than compared.
   *
   * `${f.dateFrom}::timestamptz` is parameterized, so there is no injection here — but the cast
   * is evaluated by Postgres, and a string that is not an instant raises 22007
   * `invalid input syntax for type timestamp with time zone`. That reaches `withErrorEnvelope`
   * as an unhandled error and answers **500 `internal`** for what is plainly a bad request:
   * `GET /search?q=x&dateFrom=notadate`.
   *
   * It is refused HERE rather than in `routes/search.ts` because the route is not the only door.
   * `apps/sidecar/src/cloud-read.ts` calls `searchService.search` directly, so a check living in
   * the route would guard the hosted door and not the desktop one — the shape this repository
   * treats as a finding in its own right.
   *
   * The message matches the one `MessageService.list` already gives for `beforeDate`, because
   * they are the same refusal about the same kind of value.
   */
  private static instantOr400(value: string, field: string): string {
    if (Number.isNaN(new Date(value).getTime())) {
      throw new ServiceError("validation_failed", 400, `${field} must be an ISO instant`);
    }
    return value;
  }

  private whereSql(d: Dialect, accountId: string, f: SearchFilters): SQL {
    // `deleted_at is null` unconditionally (mail 0065): search is a living view, and a deleted
    // or fully-expunged message must not come back as a hit over its stored (husked) headers.
    const preds: SQL[] = [sql`m.account_id = ${accountId}`, sql`m.deleted_at is null`];
    if (f.folder !== undefined) preds.push(sql`${this.folderExpr} = ${f.folder}`);
    if (f.sender !== undefined) preds.push(sql`lower(m.from_address) = lower(${f.sender})`);
    if (f.unread !== undefined) preds.push(sql`m.unread = ${f.unread}`);
    if (f.hasAttachments !== undefined) preds.push(sql`m.has_attachments = ${f.hasAttachments}`);
    if (f.dateFrom !== undefined) {
      preds.push(sql`m.date >= ${d.ts(new Date(SearchService.instantOr400(f.dateFrom, "dateFrom")))}`);
    }
    if (f.dateTo !== undefined) {
      preds.push(sql`m.date <= ${d.ts(new Date(SearchService.instantOr400(f.dateTo, "dateTo")))}`);
    }
    return sql.join(preds, sql` and `);
  }
}

export const searchService = new SearchService();
