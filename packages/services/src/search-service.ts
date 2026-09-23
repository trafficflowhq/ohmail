import { sql, type SQL } from "drizzle-orm";
import { holdsPunctuation, showSimilar, type SearchTier } from "@trafficflow/core/search-rank";
import { searchIndexBuilt, searchIndexProgress } from "@trafficflow/core/mail";
import type { ServiceContext, Db } from "./context.js";
import { boolLiteral, dialect, pgOnly, type Dialect, type SearchArm } from "@trafficflow/db/dialect";
import { materializeMessages } from "./dto/materialize.js";
import { clampLimit } from "./pagination.js";
import { ServiceError } from "./errors.js";
import { instantRefusal, readInstant } from "./instant.js";
import type { MessageDTO } from "./dto/types.js";

/**
 * SEARCH OVER THE STORE'S SEARCH DOCUMENT (mail 0125), fused from index-shaped ARMS — each its own
 * id set on its own index, never an OR across a join. EXACT tier: `head` (subject, people, file
 * names — ranked), `text` (the body — newest first) and `substring` (`axa` in `myAXA`), each cut at
 * its TOP-K, fused by reciprocal rank, paged AFTER fusion by a `(score, date, id)` cursor. The
 * SIMILAR tier (typo guesses) runs only when the exact tier is empty. The first page carries no
 * count; `total` and facets are {@link SearchService.summary}. Rows without a document yet are
 * read through the pre-0125 columns until the account's backfill marker is written.
 */

/** pg_trgm word-similarity floor for the typo tier (Postgres default is 0.3). */
const FUZZY_THRESHOLD = 0.3;
/** The RRF constant: an arm's row at position `r` contributes `RRF_SCALE / (RRF_K + r)`. */
const RRF_K = 60;
/** Integer scores, so a page cursor compares exactly on every store. */
const RRF_SCALE = 1_000_000_000;
/** The substring arm's width floor — a trigram's, below which its index cannot select. */
const SUBSTRING_MIN_CHARS = 3;
/** The page ceiling for search — each arm reads {@link SEARCH_ARM_FACTOR} pages' worth. */
const SEARCH_PAGE_MAX = 50;
/** Each arm's cut, in pages: RRF fuses the top `factor × page` of every arm, never a whole id set. */
const SEARCH_ARM_FACTOR = 8;
/**
 * A RANKED arm ranks only its newest `window × page` candidates: ranking every match of a broad
 * word costs one rank per match, where the newest window is read off the History index in order
 * and costs the window. A narrow word has fewer matches than the window, so its ranking is exact.
 */
const SEARCH_RANK_WINDOW_FACTOR = 40;
/** How many senders the sender facet returns. */
const SENDER_FACET_LIMIT = 10;

/**
 * Does the substring arm run for this query? Shut for a quoted phrase or a `-term` — the reader
 * asking for exactness, which the word arms give — and below a trigram's width unless the query is
 * punctuated (`pha/Bet` inside `Alpha/Beta`, one lexeme to the word arms).
 */
function substringOpen(q: string): boolean {
  if (q.includes('"') || /(^|\s)-\S/.test(q)) return false;
  return [...q].length >= SUBSTRING_MIN_CHARS || holdsPunctuation(q);
}

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
 * THE LONGEST SEARCH TERM THIS SERVICE ACCEPTS. `q` had no bound and reaches three predicates
 * whose cost is superlinear in its length, paid ONCE PER CANDIDATE ROW: `websearch_to_tsquery`
 * parses it; `word_similarity(q, …)` is O(len(q) × len(column)) per row over the whole table; the
 * offline degrade is `ilike '%' || q || '%'`. One authenticated GET with a large `q` buys
 * arbitrary CPU on a shared database. 200 characters — longer than any phrase a person types (a
 * subject line is ~78 by RFC convention), far shorter than anything whose trigram cost is
 * interesting. Over the limit is a 400, not a truncation and not an empty page: truncating
 * answers a different question silently; an empty page reads as "no mail matches".
 */
export const SEARCH_QUERY_MAX_CHARS = 200;

/**
 * THE FACET FILTERS ARE DELIBERATELY UNBOUNDED. `folder` and `sender` briefly had a 512-character
 * ceiling, removed for the failure a bound can have: IT REFUSED A FACET THIS SERVICE ITSELF
 * EMITTED. `from_address` is `text` from whatever `From:` was delivered, so `facets()` can return
 * a sender longer than any ceiling — rendered clickable, and clicking answered 400. These
 * predicates need no bound: both are EQUALITY comparisons, one length check per row — unlike `q`,
 * whose trigram and `ILIKE` predicates ARE proportional (`SEARCH_QUERY_MAX_CHARS` is where the
 * ceiling belongs). The remaining bound is the host's request-line limit — they arrive in a URL,
 * so `JSON_BODY_MAX_BYTES` (a BODY ceiling) is not it.
 */

/**
 * WHAT ONE ANSWER CARRIES. `both` (the default) is the page, the exact `total` and the facets;
 * `page` is the first page alone, so a search answers at index speed — `total` is then the
 * fused candidates' count, exact only when `totalExact`; `summary` is the exact `total` and the
 * facets with no rows, the second answer a caller asks for when the first was cut.
 */
export const SEARCH_PARTS = ["both", "page", "summary"] as const;
export type SearchParts = (typeof SEARCH_PARTS)[number];

/** Narrow an untrusted string to a {@link SearchParts}. */
export function isSearchParts(v: unknown): v is SearchParts {
  return typeof v === "string" && (SEARCH_PARTS as readonly string[]).includes(v);
}

export interface SearchOptions {
  q: string;
  filters?: SearchFilters;
  limit?: number;
  /** Absent means `relevance` — the fused ranking, byte-identical to passing it explicitly. */
  sort?: SearchSort;
  /** Absent means `both`. */
  parts?: SearchParts;
  /** The `nextCursor` of the previous page, for the same `q`, filters and sort. */
  cursor?: string;
}

export interface SearchResult {
  items: MessageDTO[];
  /** `null` when only the page was asked for (`parts: "page"`). */
  facets: Facets | null;
  /** How many messages match, over the tier being returned — never over both tiers. */
  total: number;
  /** WHICH TIER THIS ANSWER IS: `exact` literal matches, or `similar` typo guesses. Never mixed. */
  tier: SearchTier;
  /** `false` when `total` is a lower bound: the page alone was asked for and an arm was cut. */
  totalExact: boolean;
  /**
   * With `parts: "page"` and a cut arm: about how many match — the planner's estimate for each
   * cut arm, the largest of them, read from statistics and no row. `parts: "summary"` is exact.
   */
  totalEstimate?: number;
  /** This answer's server time in milliseconds. */
  ms: number;
  /** The next page's cursor, or `null` on the last page (always `null` for `summary`). */
  nextCursor: string | null;
  /**
   * On the last RELEVANCE page: an arm was cut at its top-K, so matches exist past the fused set
   * and the date orders walk them all.
   */
  bounded: boolean;
  /** Present on a summary while this account's search documents are still being built. */
  indexed?: { done: number; total: number };
}

/** One page, before the summary is joined to it. */
interface SearchPage {
  items: MessageDTO[];
  tier: SearchTier;
  nextCursor: string | null;
  bounded: boolean;
  /** The fused candidates' count — the whole match set when no arm was cut. */
  candidates: number;
  cut: boolean;
  /** When cut: the planner's estimate of the match set, from each cut arm's statistics. */
  estimate: number | null;
}

/** The counts over the whole match set. */
interface SearchSummary {
  total: number;
  facets: Facets;
  tier: SearchTier;
  indexed?: { done: number; total: number };
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

/**
 * THE ADDRESS ARM — one address, an EQUALITY, only in the FROM direction. Not a filter on
 * `search`, which requires a `q` — an address query has no words. Why `from` only, measured with
 * `EXPLAIN (ANALYZE, BUFFERS)` at 20 000 rows: `lower(from_address) = $1` is an INDEX SCAN
 * (`messages_account_from_addr_idx`); the recipients are two JSONB columns with NO index — SEQ
 * SCAN — and the OR loses the from-index too, so this is one predicate, never a union. A
 * recipient index is a migration with a backfill, not this change. The other two directions are
 * REFUSED BY NAME (`search_direction_unsupported`, 400): an empty list reads as "this address
 * never wrote you", and a from-only answer to `direction=any` is false by exactly the recipients.
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

/** The empty facets — a blank query, or a query nothing matches. */
function emptyFacets(): Facets {
  return {
    folder: {}, sender: [],
    unread: { true: 0, false: 0 },
    hasAttachments: { true: 0, false: 0 },
    date: { today: 0, last7: 0, last30: 0, older: 0 },
  };
}

/** Normalize the driver-specific `execute` shape: postgres-js returns an array,
 *  PGlite returns `{ rows }`. Keep every read below driver-agnostic. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
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
    // scoped-by: reads a Postgres catalog only — an extension probe, no account rows
    p = db.execute(pgOnly(sql`select to_regprocedure('word_similarity(text,text)') is not null as ok`))
      .then((r) => Boolean(rowsOf<{ ok: boolean }>(r)[0]?.ok))
      .catch(() => false);
    trgmCache.set(key, p);
  }
  return p;
}

/** One branch of an arm: an index-served predicate and the rank the arm orders by. */
interface Branch { readonly pred: SQL; readonly rank: SQL }
/**
 * An arm: its branches (one per index), cut at its top-K after they are merged. `ranked`: ordered
 * by its rank within the newest candidates; otherwise newest first, read off the History index.
 */
interface Arm { readonly name: string; readonly ranked: boolean; readonly branches: readonly Branch[] }

/** A relevance cursor: the last row's fused score, date and id, and the tier it belongs to. */
interface RelevanceCursor { readonly k: "r"; readonly t: SearchTier; readonly s: number; readonly d: number | null; readonly i: string }
/** A date-order cursor: the last row's sort keys and id. */
interface OrderedCursor { readonly k: "o"; readonly t: SearchTier; readonly o: string; readonly x: string | null; readonly d: number | null; readonly i: string }
type SearchCursor = RelevanceCursor | OrderedCursor;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A cursor is ours or refused: the longest one this file writes is well under this. */
const SEARCH_CURSOR_MAX_CHARS = 1024;

function encodeCursor(c: SearchCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Decode a cursor this service wrote, or refuse it — a malformed one is a 400, never a guess. */
function decodeCursor(raw: string): SearchCursor {
  const bad = (): never => { throw new ServiceError("validation_failed", 400, "cursor is not a search cursor"); };
  if (raw.length > SEARCH_CURSOR_MAX_CHARS) bad();
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); } catch {
    bad(); // not base64url JSON: refused as not ours
  }
  const c = v as Record<string, unknown>;
  const tierOk = c.t === "exact" || c.t === "similar";
  const dateOk = c.d === null || (typeof c.d === "number" && Number.isFinite(c.d));
  const idOk = typeof c.i === "string" && UUID_RE.test(c.i);
  if (!c || typeof c !== "object" || !tierOk || !dateOk || !idOk) bad();
  if (c.k === "r" && typeof c.s === "number" && Number.isInteger(c.s)) return c as unknown as RelevanceCursor;
  if (c.k === "o" && typeof c.o === "string" && (SEARCH_SORTS as readonly string[]).includes(c.o)
    && (c.x === null || typeof c.x === "string")) return c as unknown as OrderedCursor;
  return bad();
}

/** An instant as the cursor carries it — what either driver handed back, in milliseconds. */
function millisOf(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Strictly after `(date, id)` under `date desc nulls last, id desc` — the History keyset. */
function afterDateDesc(d: Dialect, date: number | null, id: string, idCol: SQL): SQL {
  return date === null
    ? sql`(m.date is null and ${idCol} < ${id})`
    : sql`(m.date < ${d.ts(new Date(date))} or (m.date = ${d.ts(new Date(date))} and ${idCol} < ${id}) or m.date is null)`;
}

/** Strictly after `(date, id)` under `date asc nulls last, id asc`. */
function afterDateAsc(d: Dialect, date: number | null, id: string): SQL {
  return date === null
    ? sql`(m.date is null and m.id > ${id})`
    : sql`(m.date > ${d.ts(new Date(date))} or (m.date = ${d.ts(new Date(date))} and m.id > ${id}) or m.date is null)`;
}

export class SearchService {
  /**
   * The FROM every arm shares. The joins are 1:1 (each is unique per message), so no fan-out; a
   * predicate on `s` makes its join inner, and `b` is only joined by a branch that reads it.
   */
  private readonly from = sql`
    from messages m
    left join message_search s on s.message_id = m.id
    left join message_bodies b on b.message_id = m.id
    left join folder_state fs on fs.message_id = m.id`;

  /** desiredFolder → native locator folder → INBOX (mirrors materializeMessage). */
  private readonly folderExpr = sql`coalesce(fs.desired_folder, m.native_locator->>'folder', 'INBOX')`;

  /** Refuse an over-long query BEFORE anything scans it; see {@link SEARCH_QUERY_MAX_CHARS}. */
  private static termOf(raw: string | undefined): string {
    const q0 = raw ?? "";
    // The RAW length decides, one trailing space allowed: trimming first would scan an unbounded
    // string, slicing first would silently search a prefix of what was typed.
    if (q0.length > SEARCH_QUERY_MAX_CHARS + 1) {
      throw new ServiceError("validation_failed", 400, `q is ${q0.length} characters; the limit is ${SEARCH_QUERY_MAX_CHARS}`);
    }
    const q = q0.trim();
    if (q.length > SEARCH_QUERY_MAX_CHARS) {
      throw new ServiceError("validation_failed", 400, `q is ${q0.length} characters; the limit is ${SEARCH_QUERY_MAX_CHARS}`);
    }
    return q;
  }

  /** The page size: the route's clamp, and at most {@link SEARCH_PAGE_MAX}. */
  private static pageOf(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return SEARCH_PAGE_MAX;
    return Math.max(1, Math.min(SEARCH_PAGE_MAX, Math.floor(limit)));
  }

  /**
   * The arms of one tier. `exact`: head, text and (when open) substring; `similar`: the typo
   * arm. While the account's backfill is unfinished each arm also reads the rows without a
   * document through the pre-0125 columns, ANDed with "no document" so no row is read twice.
   */
  private async arms(ctx: ServiceContext, d: Dialect, q: string, tier: SearchTier): Promise<Arm[]> {
    const trigram = await hasTrgm(ctx.db);
    const built = await searchIndexBuilt(ctx.db as never, ctx.accountId);
    const legacy = built ? null : d.search.unindexed(q, { trigram, threshold: FUZZY_THRESHOLD });
    const bare = (b: SearchArm): Branch => ({ pred: sql`(${b.pred} and s.message_id is null)`, rank: b.rank });
    // Where the arms read the document (a store with vectors), a branch names the document's own
    // account too, so an index that leads with the account reads one account's candidates. A
    // store whose word index is over the rows keeps every row, document or not.
    const documents = d.search.document({ subject: "", people: "", attachments: "", body: "" }) !== null;
    const own = (b: SearchArm): Branch =>
      documents ? { pred: sql`(s.account_id = ${ctx.accountId} and ${b.pred})`, rank: b.rank } : b;
    if (tier === "similar") {
      const fuzz = d.search.fuzzy(q, "mail", { trigram, threshold: FUZZY_THRESHOLD });
      return [{ name: "similar", ranked: true, branches: [own(fuzz), ...(legacy?.fuzzy ?? []).map(bare)] }];
    }
    const words = d.search.words(q);
    const out: Arm[] = [
      { name: "head", ranked: true, branches: [own(words.head), ...(legacy ? [bare(legacy.words.head)] : [])] },
      { name: "text", ranked: false, branches: [own(words.text), ...(legacy ? [bare(legacy.words.text)] : [])] },
    ];
    if (substringOpen(q)) {
      out.push({
        name: "substring",
        ranked: false,
        branches: [own(d.search.substring(q, { trigram })), ...(legacy?.substring ?? []).map(bare)],
      });
    }
    return out;
  }

  /**
   * One arm's top-K as `(id, r)`. Every branch is read NEWEST FIRST and cut — at the window for a
   * ranked arm (then ordered by rank), at K otherwise — so no branch reads more than its cut off
   * an index; the branches are merged and the arm numbered by its own order.
   */
  private armSql(where: SQL, arm: Arm, k: number, window: number): SQL {
    const cut = arm.ranked ? window : k;
    const branch = (b: Branch): SQL => sql`(select m.id as id, m.date as date, ${arm.ranked ? b.rank : sql`0`} as rank
      ${this.from} where ${where} and ${b.pred}
      order by m.date desc nulls last, m.id desc limit ${cut})`;
    const merged = arm.branches.length === 1
      ? branch(arm.branches[0]!)
      : sql`(select id, date, max(rank) as rank from (${sql.join(arm.branches.map(branch), sql` union all `)}) u group by id, date)`;
    // `SQL_RANK_ORDER`'s key sequence (a recency arm's rank is the constant its branches wrote).
    const rank = sql`m.rank`;
    return sql`select m.id, row_number() over (order by ${rank} desc, m.date desc nulls last, m.id desc) as r
               from (select m.id, m.date, m.rank from ${merged} m
                     order by ${rank} desc, m.date desc nulls last, m.id desc limit ${k}) m`;
  }

  /** The union of every branch's id set — what `total` and the facets count over. */
  private unionSql(where: SQL, arms: readonly Arm[]): SQL {
    const selects = arms.flatMap((a) => a.branches).map((b) => sql`select m.id as id ${this.from} where ${where} and ${b.pred}`);
    return sql.join(selects, sql` union `);
  }

  /**
   * ONE PAGE — the first response, with nothing counted on its path. Relevance: the arms' top-K,
   * fused by reciprocal rank and paged by `(score, date, id)`. A chosen order: the union of the
   * arms' predicates, walked by its own keyset. The tier is the exact tier unless it has no row.
   */
  async page(ctx: ServiceContext, opts: SearchOptions): Promise<SearchPage> {
    const q = SearchService.termOf(opts.q);
    if (!q) return { items: [], tier: "exact", nextCursor: null, bounded: false, candidates: 0, cut: false, estimate: null };
    const limit = SearchService.pageOf(opts.limit);
    const sort: SearchSort = opts.sort ?? "relevance";
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    const d = dialect(ctx.db);
    const where = this.whereSql(d, ctx.accountId, opts.filters ?? {});

    let tier: SearchTier = cursor?.t ?? "exact";
    let got = await this.pageRows(ctx, d, q, tier, where, sort, limit, cursor);
    if (cursor === null && tier === "exact" && got.rows.length === 0) {
      tier = "similar";
      got = await this.pageRows(ctx, d, q, tier, where, sort, limit, null);
    }
    const byId = await materializeMessages(ctx.db, ctx.accountId, got.rows.map((r) => r.id));
    const items: MessageDTO[] = [];
    for (const r of got.rows) { const dto = byId.get(r.id); if (dto) items.push(dto); }
    const nextCursor = got.next === null ? null : encodeCursor({ ...got.next, t: tier } as SearchCursor);
    const bounded = sort === "relevance" && nextCursor === null && got.cut;
    return { items, tier, nextCursor, bounded, candidates: got.candidates, cut: got.cut, estimate: got.estimate };
  }

  /** The rows of one page of one tier, and the cursor after them. */
  private async pageRows(
    ctx: ServiceContext, d: Dialect, q: string, tier: SearchTier, where: SQL,
    sort: SearchSort, limit: number, cursor: SearchCursor | null,
  ): Promise<{
    rows: Array<{ id: string }>; next: Omit<RelevanceCursor, "t"> | Omit<OrderedCursor, "t"> | null;
    cut: boolean; candidates: number; estimate: number | null;
  }> {
    const arms = await this.arms(ctx, d, q, tier);
    // The page's arms read newest first off the History index or their own GIN — never a table
    // scan, which the planner picks for a word in a large share of the store (it does not price
    // the per-row vector read), so the page runs with the scan priced out, like the counts.
    const run = (statement: SQL): Promise<unknown[][]> =>
      this.inSession(ctx, d, { tier, preferIndexes: true }, (db) => d.exec(db, statement));
    if (sort === "relevance") {
      if (cursor !== null && cursor.k !== "r") throw new ServiceError("validation_failed", 400, "cursor belongs to another order");
      const k = SEARCH_ARM_FACTOR * limit;
      // The typo tier ranks its newest K only: every candidate costs one similarity, and the
      // tier is a guess list, where the closest recent guesses are the useful ones.
      const window = tier === "similar" ? k : SEARCH_RANK_WINDOW_FACTOR * limit;
      const armSqls = arms.map((a) => this.armSql(where, a, k, window));
      const named = armSqls.map((a, i) => sql`${sql.raw("a" + String(i))} as (${a})`);
      const all = sql.join(armSqls.map((_, i) => sql`select id, r from ${sql.raw("a" + String(i))}`), sql` union all `);
      // Each arm's size, so the last page can say the fused set was cut. Uncorrelated: one read.
      // Each named apart: positional rows collapse same-named columns on the server's driver.
      const sizes = sql.join(armSqls.map((_, i) =>
        sql`${d.castInt(sql`(select count(*) from ${sql.raw("a" + String(i))})`)} as ${sql.raw("n" + String(i))}`), sql`, `);
      const after = cursor === null ? sql`` : sql`where (f.score < ${cursor.s} or (f.score = ${cursor.s} and ${afterDateDesc(d, cursor.d, cursor.i, sql`f.id`)}))`;
      const rows = await run(sql`
        with ${sql.join(named, sql`, `)},
        fused as (select id, ${d.castInt(sql`sum(${sql.raw(String(RRF_SCALE))} / (${sql.raw(String(RRF_K))} + r))`)} as score from (${all}) x group by id)
        select f.id, f.score, m.date, ${d.castInt(sql`(select count(*) from fused)`)} as fused, ${sizes}
        from fused f join messages m on m.id = f.id
        ${after}
        order by f.score desc, m.date desc nulls last, f.id desc
        limit ${limit + 1}`);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const sizesOf = (rows[0] ?? []).slice(4).map((n) => Number(n));
      const cut = sizesOf.some((n) => n >= k);
      const candidates = Number(rows[0]?.[3] ?? 0);
      // THE ESTIMATE, off the index and the statistics: an arm under its cut is counted exactly by
      // its own size; a cut arm by the planner's expected rows. The union is at least its largest arm.
      let estimate: number | null = null;
      if (cut && cursor === null) {
        const perArm = await Promise.all(arms.map(async (a, i) => (sizesOf[i]! < k ? sizesOf[i]!
          : (await d.search.estimateRows(ctx.db, this.unionSql(where, [a]))) ?? sizesOf[i]!)));
        estimate = Math.max(candidates, ...perArm);
      }
      return {
        rows: page.map((r) => ({ id: String(r[0]) })),
        next: rows.length > limit && last ? { k: "r", s: Number(last[1]), d: millisOf(last[2]), i: String(last[0]) } : null,
        cut, candidates, estimate,
      };
    }
    if (cursor !== null && (cursor.k !== "o" || cursor.o !== sort)) {
      throw new ServiceError("validation_failed", 400, "cursor belongs to another order");
    }
    const c = cursor as OrderedCursor | null;
    const { statement, key } = this.orderedPage(d, where, arms, sort, limit, c);
    const rows = await run(statement);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      rows: page.map((r) => ({ id: String(r[0]) })),
      next: rows.length > limit && last
        ? { k: "o", o: sort, x: key === null ? null : String(last[2] ?? ""), d: millisOf(last[1]), i: String(last[0]) }
        : null,
      // A date order walks the whole match set, so its page says nothing about the count.
      cut: true,
      candidates: page.length,
      estimate: null,
    };
  }

  /**
   * A CHOSEN ORDER over the whole match set — a different query, never an `order by` on the
   * ranked selection (sorting the relevance window by date answers "of the most relevant few,
   * which is newest"). The union of the arms' predicates, walked by `(key, date, id)`.
   */
  private orderedPage(
    d: Dialect, where: SQL, arms: readonly Arm[], sort: Exclude<SearchSort, "relevance">,
    limit: number, c: OrderedCursor | null,
  ): { statement: SQL; key: SQL | null } {
    const ids = this.unionSql(where, arms);
    const key = sort === "mailbox" ? sql`lower(mbx.address)` : sort === "sender" ? sql`lower(m.from_address)` : null;
    const from = sort === "mailbox"
      ? sql`from messages m join (${ids}) u on u.id = m.id left join mailboxes mbx on mbx.id = m.mailbox_id`
      : sql`from messages m join (${ids}) u on u.id = m.id`;
    const order = sort === "date_asc" ? sql`m.date asc nulls last, m.id asc`
      : key === null ? sql`m.date desc nulls last, m.id desc`
      : sql`${key} asc, m.date desc nulls last, m.id desc`;
    // A mailbox address and a sender address are NOT NULL, so the key keyset needs no null arm.
    const after = c === null ? sql``
      : sort === "date_asc" ? sql`where ${afterDateAsc(d, c.d, c.i)}`
      : key === null ? sql`where ${afterDateDesc(d, c.d, c.i, sql`m.id`)}`
      : sql`where (${key} > ${c.x ?? ""} or (${key} = ${c.x ?? ""} and ${afterDateDesc(d, c.d, c.i, sql`m.id`)}))`;
    return {
      key,
      statement: sql`select m.id, m.date, ${key ?? sql`null`} as k ${from} ${after} order by ${order} limit ${limit + 1}`,
    };
  }

  /**
   * THE SECOND RESPONSE — `total` and the facets over the whole match set of the tier the page
   * answered in, and the backfill's progress while it runs. Off the first page's path.
   */
  async summary(ctx: ServiceContext, opts: SearchOptions): Promise<SearchSummary> {
    const q = SearchService.termOf(opts.q);
    if (!q) return { total: 0, facets: emptyFacets(), tier: "exact" };
    const d = dialect(ctx.db);
    const where = this.whereSql(d, ctx.accountId, opts.filters ?? {});
    let tier: SearchTier = "exact";
    let counted = await this.facets(ctx, d, this.unionSql(where, await this.arms(ctx, d, q, "exact")), tier);
    if (showSimilar(counted.total)) {
      tier = "similar";
      counted = await this.facets(ctx, d, this.unionSql(where, await this.arms(ctx, d, q, "similar")), tier);
    }
    const { total, facets } = counted;
    const built = await searchIndexBuilt(ctx.db as never, ctx.accountId);
    const indexed = built ? undefined : await searchIndexProgress(ctx.db as never, ctx.accountId);
    return { total, facets, tier, ...(indexed !== undefined && indexed.done < indexed.total ? { indexed } : {}) };
  }

  /**
   * ONE ANSWER, by {@link SearchParts}: `page` is the first page with nothing counted on its path,
   * `summary` the exact count and facets, `both` (the default) the two together — the shape
   * `GET /search` has always answered.
   */
  // Asked for both parts (or none named), the facets are always there.
  async search(ctx: ServiceContext, opts: SearchOptions & { parts?: "both" }): Promise<SearchResult & { facets: Facets }>;
  async search(ctx: ServiceContext, opts: SearchOptions): Promise<SearchResult>;
  async search(ctx: ServiceContext, opts: SearchOptions): Promise<SearchResult> {
    const t0 = performance.now();
    const parts: SearchParts = opts.parts ?? "both";
    const ms = (): number => Math.round(performance.now() - t0);
    if (parts === "summary") {
      const s = await this.summary(ctx, opts);
      return {
        items: [], facets: s.facets, total: s.total, tier: s.tier, totalExact: true,
        nextCursor: null, bounded: false, ...(s.indexed ? { indexed: s.indexed } : {}), ms: ms(),
      };
    }
    const page = await this.page(ctx, opts);
    if (parts === "page") {
      return {
        items: page.items, facets: null, total: page.candidates, tier: page.tier, totalExact: !page.cut,
        ...(page.estimate !== null ? { totalEstimate: page.estimate } : {}),
        nextCursor: page.nextCursor, bounded: page.bounded, ms: ms(),
      };
    }
    const s = await this.summary(ctx, opts);
    return {
      items: page.items, facets: s.facets, total: s.total, tier: page.tier, totalExact: true,
      nextCursor: page.nextCursor, bounded: page.bounded, ...(s.indexed ? { indexed: s.indexed } : {}), ms: ms(),
    };
  }

  /**
   * EVERY MESSAGE IN THE ARCHIVE FROM ONE ADDRESS — the address view's archive half; `from` is
   * the only direction served. `lower(m.from_address) = lower($1)` — byte-for-byte `whereSql`'s
   * `sender` filter, served by `messages_account_from_addr_idx`; an EQUALITY — a substring match
   * would put a stranger's mail under somebody else's name (the pg twin asserts a substring
   * returns NOTHING). `whereSql` supplies account scope and `deleted_at is null`; the account
   * LEADS the index — a sender address is attacker-choosable. Order: `date desc nulls last, id
   * desc`. An EMPTY address answers empty rather than matching rows whose `from_address` is `''`:
   * the honest answer to "everything from nobody" is nothing.
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

    const total = await this.count(ctx, d, sql`select m.id as id ${this.from} where ${where} and ${pred}`);
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

  // ── counts & facets over the union of the tier's arms ─────────────────────────────────

  /**
   * Run `fn` in a transaction shaped for a search read — the tier's typo threshold, and for the
   * counts, the word indexes kept over a table scan — or on the plain handle when nothing needs
   * shaping.
   */
  private async inSession<T>(
    ctx: ServiceContext, d: Dialect, opts: { tier: SearchTier; preferIndexes: boolean },
    fn: (db: unknown) => Promise<T>,
  ): Promise<T> {
    const setup = d.search.searchSession({
      ...(opts.tier === "similar" ? { typoThreshold: FUZZY_THRESHOLD } : {}),
      preferIndexes: opts.preferIndexes,
    });
    if (setup === null) return fn(ctx.db);
    const tx = ctx.db as unknown as { transaction: <R>(f: (t: unknown) => Promise<R>) => Promise<R> };
    return tx.transaction(async (t) => { await d.exec(t, setup); return fn(t); });
  }

  /** How many messages the union matches — ONE count over the union, each branch on its index. */
  private async count(ctx: ServiceContext, d: Dialect, ids: SQL, tier: SearchTier = "exact"): Promise<number> {
    const rows = await this.inSession(ctx, d, { tier, preferIndexes: true }, (db) =>
      d.exec(db, sql`select ${d.castInt(sql`count(*)`)} as n from (${ids}) u`));
    return Number(rows[0]?.[0] ?? 0);
  }

  /**
   * `total` and the facets over one tier's union — three passes, the first carrying the count, and
   * the other two skipped when nothing matched.
   */
  private async facets(
    ctx: ServiceContext, d: Dialect, ids: SQL, tier: SearchTier,
  ): Promise<{ total: number; facets: Facets }> {
    const now = ctx.now();
    const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
    // The instant is a different literal on each store — an ISO string the server parses, a count
    // of milliseconds the device keeps — so it goes through the seam.
    const today = d.ts(todayStart);
    const d7 = d.ts(new Date(todayStart.getTime() - 7 * 86_400_000));
    const d30 = d.ts(new Date(todayStart.getTime() - 30 * 86_400_000));
    const n = (e: SQL): SQL => d.castInt(e);
    const base = sql`from (${ids}) u join messages m on m.id = u.id left join folder_state fs on fs.message_id = m.id`;
    // Scalars (unread / hasAttachments / recency buckets) in one aggregate pass. POSITIONAL rows:
    // the eight positions below are read by index, so a reorder here moves them together.
    const scalarSql = sql`
      select
        ${n(sql`count(*) filter (where m.unread)`)} as unread_t,
        ${n(sql`count(*) filter (where not m.unread)`)} as unread_f,
        ${n(sql`count(*) filter (where m.has_attachments)`)} as att_t,
        ${n(sql`count(*) filter (where not m.has_attachments)`)} as att_f,
        ${n(sql`count(*) filter (where m.date >= ${today})`)} as d_today,
        ${n(sql`count(*) filter (where m.date >= ${d7} and m.date < ${today})`)} as d_7,
        ${n(sql`count(*) filter (where m.date >= ${d30} and m.date < ${d7})`)} as d_30,
        ${n(sql`count(*) filter (where m.date is null or m.date < ${d30})`)} as d_older,
        ${n(sql`count(*)`)} as total
      ${base}`;
    const folderSql = sql`select ${this.folderExpr} as folder, ${n(sql`count(*)`)} as c ${base} group by 1`;
    const senderSql = sql`
      select m.from_address as address, ${n(sql`count(*)`)} as c ${base}
      group by 1 order by c desc, address asc limit ${SENDER_FACET_LIMIT}`;
    const [scalarR, folderR, senderR] = await this.inSession(ctx, d, { tier, preferIndexes: true }, async (db) => {
      const scalars = await d.exec(db, scalarSql);
      if (Number(scalars[0]?.[8] ?? 0) === 0) return [scalars, [], []];
      return [scalars, await d.exec(db, folderSql), await d.exec(db, senderSql)];
    });
    const s = (scalarR[0] ?? []).map((v) => Number(v ?? 0));
    const folder: Record<string, number> = {};
    for (const row of folderR) folder[String(row[0])] = Number(row[1] ?? 0);
    return {
      total: s[8] ?? 0,
      facets: {
        folder,
        sender: senderR.map((r) => ({ address: String(r[0]), count: Number(r[1] ?? 0) })),
        unread: { true: s[0] ?? 0, false: s[1] ?? 0 },
        hasAttachments: { true: s[2] ?? 0, false: s[3] ?? 0 },
        date: { today: s[4] ?? 0, last7: s[5] ?? 0, last30: s[6] ?? 0, older: s[7] ?? 0 },
      },
    };
  }

  // ── filter → WHERE (account scope always first) ───────────────────────

  /**
   * The two date bounds are the only filter values CAST rather than compared: a non-instant
   * raises 22007 in Postgres and reached `withErrorEnvelope` as a 500 for a plainly bad request.
   * Refused HERE, not in `routes/search.ts`: `apps/sidecar/src/cloud-read.ts` calls
   * `searchService.search` directly, so a route check guards one door of two. TOTAL, through
   * the same `readInstant` as `MessageService.list`'s `beforeDate` and the schedule door's
   * `sendAt`: `new Date()` rolled February 30 into March 2 and read an offset-less time in the
   * server's zone, so a bound was a window nobody asked for.
   */
  private static instantOr400(value: string, field: string): Date {
    const read = readInstant(value);
    if (!read.ok) throw new ServiceError("validation_failed", 400, instantRefusal(field, read.why));
    return read.at;
  }

  private whereSql(d: Dialect, accountId: string, f: SearchFilters): SQL {
    // `deleted_at is null` unconditionally (mail 0065): search is a living view, and a deleted
    // or fully-expunged message must not come back as a hit over its stored (husked) headers.
    const preds: SQL[] = [sql`m.account_id = ${accountId}`, sql`m.deleted_at is null`];
    if (f.folder !== undefined) preds.push(sql`${this.folderExpr} = ${f.folder}`);
    if (f.sender !== undefined) preds.push(sql`lower(m.from_address) = lower(${f.sender})`);
    // Literals, not bound booleans — see `boolLiteral`.
    if (f.unread !== undefined) preds.push(sql`m.unread = ${boolLiteral(f.unread)}`);
    if (f.hasAttachments !== undefined) preds.push(sql`m.has_attachments = ${boolLiteral(f.hasAttachments)}`);
    if (f.dateFrom !== undefined) {
      preds.push(sql`m.date >= ${d.ts(SearchService.instantOr400(f.dateFrom, "dateFrom"))}`);
    }
    if (f.dateTo !== undefined) {
      preds.push(sql`m.date <= ${d.ts(SearchService.instantOr400(f.dateTo, "dateTo"))}`);
    }
    return sql.join(preds, sql` and `);
  }
}

export const searchService = new SearchService();
