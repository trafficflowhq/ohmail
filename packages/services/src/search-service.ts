import { sql, type SQL } from "drizzle-orm";
import { exactAsked, showSimilar, substringOpen, type SearchTier } from "@trafficflow/core/search-rank";
import { searchIndexBuilt, searchIndexProgress } from "@trafficflow/core/mail";
import { accountSettings, messages } from "@trafficflow/db";
import type { ServiceContext, Db } from "./context.js";
import { boolLiteral, dialect, pgOnly, type Dialect, type SearchArm } from "@trafficflow/db/dialect";
import { materializeMessages, materializePage, type MaterializeSource } from "./dto/materialize.js";
import { clampLimit } from "./pagination.js";
import { ServiceError } from "./errors.js";
import { storeProbe } from "./store-probe.js";
import { afterSettings, afterSettingsRead } from "./settings-first.js";
import { importOpen, storeStillImporting, truthy } from "./search-coverage.js";
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
/** The page ceiling for search — each arm reads {@link SEARCH_ARM_FACTOR} pages' worth. */
const SEARCH_PAGE_MAX = 50;
/**
 * Each arm's cut, in pages: RRF fuses the top `factor × page` of every arm, never a whole id set.
 * Four, the floor: a recency arm's walk and the typo tier's similarity checks are proportional to it.
 * Paired against eight on the desktop's own store, the typo page went 95 to 59 ms p95.
 */
const SEARCH_ARM_FACTOR = 4;
/**
 * A RANKED arm ranks only its newest `window × page` candidates: ranking every match of a broad
 * word costs one rank per match, where the newest window is read off the History index in order
 * and costs the window. A narrow word has fewer matches than the window, so its ranking is exact.
 */
const SEARCH_RANK_WINDOW_FACTOR = 40;
/**
 * A BOUNDED arm walks at most this many cuts' worth of the newest messages. The planner prices a
 * part's tsquery (`word:*` and its stems) at a per-term floor, never by its matches: a rare part
 * was planned as a walk of the whole mailbox asking every body (131 ms in the budget file, for no
 * match), a common one as a read of every match. So the walk has a bound, and the GIN is the
 * fallback for a part too rare to fill it.
 */
const SEARCH_PART_WALK_FACTOR = 6;
/**
 * A BOUNDED arm first asks the newest page-cut of mail (K messages) and walks the full bound only
 * when at least K / {@link SEARCH_PART_WALK_FACTOR} of them match: a sparser part could not fill
 * its cut inside the walk, so it is read off the GIN at once. A part in one message of 200 was
 * walked 1,200 documents deep for six hits (11.7 ms of a 30 ms page at 74k), then read anyway.
 */
const SEARCH_PART_PROBE_SHARE = SEARCH_PART_WALK_FACTOR;
/**
 * On the desktop's own store an arm reads its matches off its index only while it has at most this
 * many cuts' worth (counted off the search document alone); past that it walks the newest
 * {@link SEARCH_PART_WALK_FACTOR} cuts of mail. Each match read that way costs a lookup of its
 * message, and in-process PGlite plans a few thousand as a scan of the whole mailbox (0.1-0.6 s).
 */
const LOCAL_ARM_READ_FACTOR = 4;
/**
 * The typo arm walks at most this many cuts of the newest mail, asking each document the cheap
 * necessary condition (`typoPrefilter`) before the similarity: ~7-10 µs a 75-character document
 * for the similarity, ~3-4 for the condition and the lookup, so 8 000 at most (~35 ms at 74k).
 */
const SEARCH_TYPO_WALK_FACTOR = 40;
/**
 * A BOUNDED arm held to an excluded word walks on past its bound, to this many cuts of the newest
 * mail, when its words are dense there and the exclusion leaves too few: reading their matches off
 * the GINs reads every match (two common words and a common exclusion: 67k matches, 265 ms at 74k),
 * the walk ~6 µs a letter (8 000 at most, ~45 ms).
 */
const SEARCH_EXCLUSION_WALK_FACTOR = 40;
/**
 * A bounded arm still short of K after main's walk reads its matches once as a set: never more than
 * its per-branch read, which reads every match too and sorts them. History is then walked newest
 * first against the set, index entries only, at most this many a member, half what one member's date
 * lookup costs; when the probe puts the K-th match past that, or under K members, every member is dated.
 */
const SEARCH_SET_WALK_PER_MEMBER = 6;
/**
 * The text arm beside a part arm reads its own set only when the part arm's set, every account's of
 * it, holds at most this many ids a letter of History walked to the part's K-th match: an id costs
 * about a twelfth of a letter the planner's walk asks (the body vector sits in TOAST), eight leave a
 * margin, and the text arm's newest K lie at least that deep (a part of a word finds what the whole word finds).
 */
const SEARCH_TEXT_SET_PER_WALKED = 8;
/**
 * Every `whereSql` whose filters read the heap (folder, sender, unread, attachments): there a set's
 * members are each looked up to be filtered, where the per-branch read is planned with the filter.
 */
const heapWhere = new WeakSet<SQL>();
/** How many senders the sender facet returns. */
const SENDER_FACET_LIMIT = 10;

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
 * fused candidates' count, exact only when `totalExact`; `estimate` is the count and facets over
 * those candidates with no rows — exact when `totalExact`, else `totalEstimate` says about how
 * many; `summary` is the exact `total` and facets, asked only when the estimate was not exact.
 */
export const SEARCH_PARTS = ["both", "page", "summary", "estimate"] as const;
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
  /** `null` when only the page was asked for (`parts: "page"`); over the candidates for `estimate`. */
  facets: Facets | null;
  /** How many messages match, over the tier being returned — never over both tiers. */
  total: number;
  /** WHICH TIER THIS ANSWER IS: `exact` literal matches, or `similar` typo guesses. Never mixed. */
  tier: SearchTier;
  /** `false` when `total` is a lower bound: the page alone was asked for and an arm was cut. */
  totalExact: boolean;
  /**
   * With `parts: "estimate"` and a cut arm: about how many match — the planner's estimate for
   * each cut arm, the largest of them, read from statistics and no row. Never on a page.
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
  /** Present on every part while the store has not taken in the whole mailbox ({@link importOpen}). */
  importing?: true;
}

/** A part's reading of {@link SearchResult.importing}, taken in the part's own session. */
interface Coverage { importing?: true }

/** One tier's page rows as their DTOs, the cursor after them, and whether an arm was cut. */
interface TierRows {
  items: MessageDTO[]; next: Omit<RelevanceCursor, "t"> | Omit<OrderedCursor, "t"> | null;
  cut: boolean; candidates: number;
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
  importing?: true;
}

/** The counts over the whole match set. */
interface SearchSummary {
  total: number;
  facets: Facets;
  tier: SearchTier;
  indexed?: { done: number; total: number };
  importing?: true;
}

/** The counts over the fused candidates: the whole match set exactly when no arm was cut. */
interface SearchEstimate extends SearchSummary {
  exact: boolean;
  /** When cut: the planner's estimate of the match set, as the page's. */
  estimate: number | null;
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
 * THE ADDRESS ARM — one address, an EQUALITY, in a direction. Not a filter on `search`, which
 * requires a `q` — an address query has no words. `from` is `lower(from_address) = $1`, an INDEX
 * SCAN of `messages_account_from_addr_idx`; `to` is To and Cc through mail 0154's account-keyed
 * expression index (the device store: its trigger-kept side table); `any` is the two as a UNION
 * of index-served branches, never an OR in one predicate (an OR loses both indexes).
 */
export const ADDRESS_DIRECTIONS = ["any", "from", "to"] as const;
export type AddressSearchDirection = (typeof ADDRESS_DIRECTIONS)[number];

/**
 * THE DIRECTIONS THIS SERVICE CAN SERVE FROM AN INDEX — all three since mail 0154. Kept as a
 * closed list with its refusal (`search_direction_unsupported`), so a direction added to the
 * vocabulary is refused until an index serves it.
 */
export const ADDRESS_DIRECTIONS_SERVED: readonly AddressSearchDirection[] = ["any", "from", "to"];

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
   * WHICH DIRECTION THIS ANSWER IS ABOUT — on the wire rather than inferred: a client that fell
   * back to `from` against an older server labels its rows by this field, not by what it asked.
   */
  direction: AddressSearchDirection;
  /** Present while the store has not taken in the whole mailbox ({@link importOpen}): `total` is of the mail synced so far. */
  importing?: true;
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

/**
 * Accounts whose backfill marker this handle has READ as written: the marker is written once and
 * never cleared (`coalesce` on its only writer), so a written marker is remembered and the session
 * statement then carries no parameter — one round trip through the pooler instead of two.
 */
const markerWritten = new WeakMap<object, Set<string>>();
const MARKER_MEMO_MAX = 10_000;
/** The backfill's progress as this handle last read it, per account: a count reads it again after this. */
const progressRead = new WeakMap<object, Map<string, { at: number; p: { done: number; total: number } }>>();
const INDEX_PROGRESS_FRESH_MS = 30_000;

// pg_trgm presence is a property of the physical database, not the request: asked once per
// handle, and a "no" asked again after a while (`storeProbe`), so a later install is seen.
const trgmProbe = storeProbe();
function hasTrgm(db: Db): Promise<boolean> {
  // ASKED ONLY OF A STORE THAT COULD ANSWER. `to_regprocedure` is a server function, so composing
  // this for the device store would not return `false` — it would fail to parse, during a search.
  // The seam puts this probe in the caller by contract, because one dialect runs against a
  // database that HAS the extension and one that does not; the device is neither, and its answer
  // is a fact about the store.
  if (dialect(db).name !== "pg") return Promise.resolve(false);
  return trgmProbe(db as unknown as object, () =>
    /* A DECLARED POSTGRES-ONLY ARM, and it is unreachable above: the guard one line up answers
       `false` for any store that is not the server, so this statement is never composed there.
       It stays in the caller by the seam's own contract — the fuzzy member IS the trigram arm,
       and whether THIS deployment has the extension is a fact about the deployment, not about
       the dialect, which is why the seam takes it as an argument rather than guessing it. The
       question has no second spelling: `to_regprocedure` reads a Postgres catalog. */
    // scoped-by: reads a Postgres catalog only — an extension probe, no account rows
    db.execute(pgOnly(sql`select to_regprocedure('word_similarity(text,text)') is not null as ok`))
      .then((r) => Boolean(rowsOf<{ ok: boolean }>(r)[0]?.ok)));
}

/** What the store says before a search composes its arms: the backfill marker and pg_trgm. */
interface StoreFacts { readonly built: boolean; readonly trigram: boolean }

/** One branch of an arm: an index-served predicate and the rank the arm orders by. */
interface Branch {
  readonly pred: SQL; readonly rank: SQL;
  /** The predicate without its account: what a bounded read asks the index for by itself. */
  readonly raw?: SQL;
  /** The account `raw` leaves out. */
  readonly account?: string;
  /**
   * Over the document (`s`), asked only of rows the branch has already cut: an excluded word, whose
   * check reads the body vector, so never of every index match ({@link SearchService.keeps}).
   */
  readonly after?: SQL;
  /**
   * A branch of an arm held to an excluded word: its words without the exclusion, over the document,
   * which {@link SearchService.boundedRead} asks of the newest mail to choose a deeper walk or the index.
   */
  readonly pos?: SQL;
  /** A pre-0125 branch's matches as ids off its own table, for {@link SearchService.setPath}. */
  readonly set?: SQL;
}
/**
 * An arm: its branches (one per index), cut at its top-K after they are merged. `ranked`: ordered
 * by its rank within the newest candidates; otherwise newest first, read off the History index.
 */
interface Arm {
  readonly name: string; readonly ranked: boolean; readonly branches: readonly Branch[];
  /** A recency arm whose selectivity the planner cannot see: see {@link SEARCH_PART_WALK_FACTOR}. */
  readonly bounded?: boolean;
  /** Its words may straddle the letter's parts: one predicate over the whole letter. */
  readonly across?: boolean;
  /** Read by {@link SearchService.localRead} for this account: the desktop's own store, documents built. */
  readonly local?: { readonly account: string };
  /** The typo arm's walk test, a cheap necessary condition first: read by {@link SearchService.typoRead}. */
  readonly typo?: { readonly walkPred: SQL; readonly vectors: boolean };
}

/**
 * An arm's rows out of its tier's shared reads ({@link SearchService.tierWalk}): a bounded arm's
 * whole read (`rows`), or the text arm's set beside the planner's read, `gate` saying which answers.
 */
type TierRead = { readonly rows: SQL } | { readonly gate: SQL; readonly rows: SQL };

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
function afterDateDesc(d: Dialect, date: number | null, id: string, idCol: SQL, dateCol: SQL = sql`m.date`): SQL {
  return date === null
    ? sql`(${dateCol} is null and ${idCol} < ${id})`
    : sql`(${dateCol} < ${d.ts(new Date(date))} or (${dateCol} = ${d.ts(new Date(date))} and ${idCol} < ${id}) or ${dateCol} is null)`;
}

/** Strictly after `(date, id)` under `date asc nulls last, id asc`. */
function afterDateAsc(d: Dialect, date: number | null, id: string): SQL {
  return date === null
    ? sql`(m.date is null and m.id > ${id})`
    : sql`(m.date > ${d.ts(new Date(date))} or (m.date = ${d.ts(new Date(date))} and m.id > ${id}) or m.date is null)`;
}

export class SearchService {
  /**
   * `indexFills: false` for a store no backfill fills (the phone, `composition-passes.ts`): its rows
   * without a document are searched the older way, complete, and nothing writes one, so an answer
   * there states no index progress rather than a percentage that never moves. `localStore` for the
   * desktop's own store, whose exact-tier arms are each read within a bound ({@link localRead}).
   */
  constructor(private readonly opts: { readonly indexFills: boolean; readonly localStore?: boolean } = { indexFills: true }) {}

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
  private arms(ctx: ServiceContext, d: Dialect, q: string, tier: SearchTier, store: StoreFacts): Arm[] {
    const { built, trigram } = store;
    const legacy = built ? null : d.search.unindexed(q, { trigram, threshold: FUZZY_THRESHOLD });
    const bare = (b: SearchArm): Branch => ({ pred: sql`(${b.pred} and s.message_id is null)`, rank: b.rank });
    // A pre-0125 word branch, tagged with its table: its matches as one set there (bodies or subjects).
    const bareOn = (table: "bodies" | "subjects", b: SearchArm): Branch => ({
      ...bare(b),
      set: table === "bodies"
        ? sql`select b.message_id as id from message_bodies b where ${b.pred}
            and not exists (select 1 from message_search s where s.message_id = b.message_id)`
        : sql`select m.id as id from messages m where m.account_id = ${ctx.accountId} and ${b.pred}
            and not exists (select 1 from message_search s where s.message_id = m.id)`,
    });
    // Where the arms read the document (a store with vectors), a branch names the document's own
    // account too, so an index that leads with the account reads one account's candidates. A
    // store whose word index is over the rows keeps every row, document or not.
    const documents = d.search.document({ subject: "", people: "", attachments: "", body: "" }) !== null;
    const own = (b: SearchArm): Branch =>
      documents ? { pred: sql`(s.account_id = ${ctx.accountId} and ${b.pred})`, rank: b.rank, raw: b.pred, account: ctx.accountId } : b;
    if (tier === "similar") {
      // A guess never holds a word the reader excluded, anywhere in the letter.
      const held = (b: SearchArm, none: SQL | undefined): SearchArm => (none ? { pred: sql`(${b.pred} and ${none})`, rank: b.rank } : b);
      const excluded = d.search.words(q).excluded;
      const fuzz = held(d.search.fuzzy(q, "mail", { trigram, threshold: FUZZY_THRESHOLD }), excluded);
      const old = (legacy?.fuzzy ?? []).map((b) => bare(held(b, legacy!.excluded)));
      const arm: Arm = { name: "similar", ranked: true, branches: [own(fuzz), ...old] };
      // The server's documents only: the desktop's store keeps its scans inside six cuts.
      const pre = trigram && documents && legacy === null && this.opts.localStore !== true
        ? d.search.typoPrefilter(q, { threshold: FUZZY_THRESHOLD, terms: sql`s.terms`, lowered: sql`s.t` }) : null;
      if (pre === null) return [arm];
      const walkPred = sql`(s.account_id = ${ctx.accountId} and (case when ${pre} then ${fuzz.pred} else false end))`;
      return [{ ...arm, typo: { walkPred, vectors: excluded !== undefined } }];
    }
    const local = this.opts.localStore === true && d.name === "pg" && documents && legacy === null;
    const words = d.search.words(q);
    // An excluded word: on the server's documents asked of each arm's cut rows only (its check reads
    // the body), elsewhere in the arm's predicate. There the text arm reads, per `or` group, what the
    // text index answers whole (`alone`), and a group of several operands also as its letter, held.
    const keep = words.excluded;
    const late = keep !== undefined && d.name === "pg" && documents && !local;
    const held = (b: Branch): Branch => (keep === undefined ? b : late ? { ...b, after: keep }
      : { ...b, pred: sql`(${b.pred} and ${keep})`, ...(b.raw ? { raw: sql`(${b.raw} and ${keep})` } : {}) });
    const alone = late && words.alone ? words.alone : null;
    const rank = words.text.rank;
    const text = alone
      ? alone.flatMap((g) => [{ ...own({ pred: g.pred, rank }), pos: g.letter }, ...(g.whole ? [] : [{ ...held(own({ pred: g.letter, rank })), pos: g.letter }])])
      : [held(own(words.text))];
    const out: Arm[] = [
      { name: "head", ranked: true, branches: [held(own(words.head)), ...(legacy ? [bare(legacy.words.head)] : [])] },
      {
        name: "text", ranked: false, ...(words.across === true && d.name === "pg" ? { bounded: true, across: true } : {}),
        branches: [...text, ...(legacy ? [bareOn("bodies", legacy.words.text)] : [])],
      },
    ];
    // A part of a word finds what the whole word finds: the same vectors as `head` and `text`,
    // each word also read as the start of a longer one (`elevat` reaches `elevation`). On Postgres
    // ONE bounded arm over both, so a common part's walk fills at once; the device store's FTS5
    // reads have no such misplan and keep two plain arms (one branch each: no union there).
    const part = exactAsked(q) ? null : d.search.partWords(q);
    const old = legacy?.part ?? null;
    if (part !== null && part.across === true) {
      // Words that may straddle the letter's parts: one predicate over the whole letter.
      out.push({
        name: "part", ranked: false, ...(d.name === "pg" ? { bounded: true } : {}), across: true,
        branches: [own(part.text), ...(old ? [bareOn("subjects", old.head), bareOn("bodies", old.text)] : [])],
      });
    } else if (part !== null && d.name === "pg") {
      out.push({
        name: "part", ranked: false, bounded: true,
        branches: [own(part.head), own(part.text), ...(old ? [bareOn("subjects", old.head), bareOn("bodies", old.text)] : [])],
      });
    } else if (part !== null) {
      out.push(
        { name: "part-head", ranked: false, branches: [own(part.head), ...(old ? [bare(old.head)] : [])] },
        { name: "part-text", ranked: false, branches: [own(part.text), ...(old ? [bare(old.text)] : [])] },
      );
    }
    if (substringOpen(q)) {
      out.push({
        name: "substring",
        ranked: false,
        branches: [own(d.search.substring(q, { trigram })), ...(legacy?.substring ?? []).map(bare)],
      });
    }
    // Every branch is then the document's own (`own`), so the bounded read can ask it by itself.
    return local ? out.map((a) => ({ ...a, local: { account: ctx.accountId }, bounded: false })) : out;
  }

  /**
   * One arm's top-K as `(id, r)`. Every branch is read NEWEST FIRST and cut — at the window for a
   * ranked arm (then ordered by rank), at K otherwise — so no branch reads more than its cut off
   * an index; the branches are merged and the arm numbered by its own order.
   */
  private armSql(where: SQL, arm: Arm, k: number, window: number, walk?: SQL, tier?: TierRead): SQL {
    const cut = arm.ranked ? window : k;
    const read = (b: Branch, unless?: SQL): SQL => sql`(select m.id as id, m.date as date, ${arm.ranked ? b.rank : sql`0`} as rank
      ${this.from} where ${where} and ${b.pred}${unless ? sql` and not ${unless}` : sql``}
      order by m.date desc nulls last, m.id desc limit ${cut})`;
    const capped = SearchService.capped(arm);
    // A branch held to `after` keeps its cut rows that pass; a full cut says the arm is cut (`x`). A
    // row that fails stays as a row with no id, so the flag outlives every row.
    const branch = (b: Branch): SQL => (b.after !== undefined
      ? sql`(select case when ${this.keeps(b.after, sql`c.id`)} then c.id end as id, c.date, c.rank, c.x
          from (select r.*, case when count(*) over () >= ${cut} then 1 else 0 end as x from ${read(b)} r) c)`
      : capped ? sql`(select r.*, 0 as x from ${read(b)} r)` : read(b));
    // The text arm beside a part arm: its own set, else the planner's read, exactly one by the gate.
    const merged = tier && "gate" in tier ? sql`(select id, date, 0 as rank from (${tier.rows}) f union all ${read(arm.branches[0]!, tier.gate)})`
      : arm.local && walk ? this.localRead(where, arm, k, cut, walk)
      : arm.typo ? this.typoRead(where, arm.branches[0]!, arm.typo, k)
      : arm.bounded ? (tier ? sql`(${tier.rows})` : this.boundedRead(where, arm.branches, k))
      : arm.branches.length === 1 ? branch(arm.branches[0]!)
      : sql`(select id, date, max(rank) as rank${capped ? sql`, max(x) as x` : sql``}
          from (${sql.join(arm.branches.map(branch), sql` union all `)}) u group by id, date)`;
    // `SQL_RANK_ORDER`'s key sequence (a recency arm's rank is the constant its branches wrote).
    const rank = sql`m.rank`;
    const rows = (from: SQL): SQL => sql`select m.id, m.date, row_number() over (order by ${rank} desc, m.date desc nulls last, m.id desc) as r
               from (select m.id, m.date, m.rank from ${from} m ${capped ? sql`where m.id is not null` : sql``}
                     order by ${rank} desc, m.date desc nulls last, m.id desc limit ${k}) m`;
    if (!capped) return rows(merged);
    // A capped arm: its rows with `x` 0, and one row with no id when it is cut ({@link SearchService.capped}),
    // whether or not a row survived.
    return sql`with mg as (select * from ${merged} m)
      select id, date, r, 0 as x from (${rows(sql`mg`)}) m
      union all
      select null, null, null, 1 where exists (select 1 from mg where mg.x = 1)`;
  }

  /**
   * AN ARM OF THE DESKTOP'S OWN STORE, within a bound whatever its match count: counted off the
   * search document alone up to {@link LOCAL_ARM_READ_FACTOR} cuts; at most that many are read off
   * the index and dated one lookup each (`offset 0` keeps each a lookup: no join, so no scan of the
   * mailbox), else it takes its rows of the tier's one walk ({@link sharedWalk}). A walk that holds
   * fewer than K sets `x`, so the arm reads as cut: its older matches are counted by the summary and
   * walked by the date orders. A walk that holds none reads the index after all.
   */
  private localRead(where: SQL, arm: Arm, k: number, cut: number, walk: SQL): SQL {
    const cap = LOCAL_ARM_READ_FACTOR * k;
    const account = arm.local!.account;
    const raw = sql.join(arm.branches.map((b) => sql`(${b.raw ?? b.pred})`), sql` or `);
    const rank = arm.ranked ? arm.branches[0]!.rank : sql`0`;
    // The document's own predicate by itself (`offset 0`), so its index serves it: with the account
    // beside it the planner reads the account's documents and filters each one's vector.
    const docs = sql`select s.message_id as id, s.account_id as account, ${rank} as rank from message_search s
      where ${raw} offset 0`;
    const dated = sql`select m.date as date from messages m left join folder_state fs on fs.message_id = m.id
      where m.id = d.id and ${where} offset 0`;
    const indexed = sql`select d.id as id, t.date as date, d.rank as rank from (${docs}) d cross join lateral (${dated}) t
      where d.account = ${account} order by (t.date is null), t.date desc, d.id desc limit ${cut}`;
    // A walk that holds none of an arm's matches is no answer (the page would read as the closest
    // words): that arm is read off its index whatever its count.
    return sql`(with lc as (select count(*) as n from (select 1 from (${docs}) d where d.account = ${account} limit ${cap + 1}) c),
      lw as (select id, date, rank from (${walk}) r where (select n from lc) > ${cap}),
      li as (select id, date, rank from (${indexed}) r where (select n from lc) <= ${cap} or not exists (select 1 from lw))
      select id, date, rank, 0 as x from li
      union all
      select id, date, rank, case when (select count(*) from lw) < ${k} then 1 else 0 end as x from lw)`;
  }

  /**
   * ONE WALK FOR EVERY LOCAL ARM OF A TIER: the newest {@link SEARCH_PART_WALK_FACTOR} cuts of mail
   * under the filters, each asked every arm's predicate (and the ranked arm's rank) in one look at
   * its document. Read only by an arm past its index read, so a narrow search never starts it.
   */
  private sharedWalk(where: SQL, arms: readonly Arm[], k: number): SQL {
    const cols = arms.flatMap((a, i) => a.local ? [
      sql`(${sql.join(a.branches.map((b) => sql`(${b.raw ?? b.pred})`), sql` or `)}) as ${sql.raw("f" + String(i))}`,
      sql`${a.ranked ? a.branches[0]!.rank : sql`0`} as ${sql.raw("r" + String(i))}`,
    ] : []);
    const newest = sql`select m.id as id, m.date as date from messages m left join folder_state fs on fs.message_id = m.id
      where ${where} order by m.date desc nulls last, m.id desc limit ${SEARCH_PART_WALK_FACTOR * k}`;
    return sql`select w.id as id, w.date as date, h.* from (${newest}) w
      cross join lateral (select ${sql.join(cols, sql`, `)} from message_search s where s.message_id = w.id offset 0) h`;
  }

  /**
   * ONE PROBE AND ONE WALK FOR A TIER'S BOUNDED ARMS over the server's documents (no exclusion, no
   * pre-0125 branch), as main's bounded read takes them: the probe asks the newest K under the
   * filters every such arm's predicates in one look at each document, and an arm walks the newest
   * {@link SEARCH_PART_WALK_FACTOR} cuts when a sixth of its probe matched, the walk read once for
   * every arm. Short of K an arm reads its set ({@link setPath}), or under a filter the History index
   * cannot answer its per-branch read, which the planner reads with that filter's own index. Off the
   * heap, a text arm beside a part arm takes its own set only when the part arm's proves it cheaper
   * than the planner's read ({@link SEARCH_TEXT_SET_PER_WALKED}).
   */
  private tierWalk(where: SQL, arms: readonly Arm[], k: number, pre: string): { named: SQL[]; of: (i: number) => TierRead | undefined } {
    const joined = arms.flatMap((x, i) => (x.bounded && !x.local
      && x.branches.every((b) => b.raw !== undefined && b.after === undefined && b.pos === undefined) ? [i] : []));
    if (joined.length === 0) return { named: [], of: () => undefined };
    const heap = heapWhere.has(where);
    const probe = sql.raw(pre + "rp");
    const walk = sql.raw(pre + "rw");
    const f = (i: number): SQL => sql.raw("f" + String(i));
    const h = (i: number): SQL => sql.raw("h" + String(i));
    const named = (i: number | string, s: string): SQL => sql.raw(`${pre}j${String(i)}${s}`);
    const flags = sql.join(joined.map((i) => sql`(${sql.join(arms[i]!.branches.map((b) => b.pred), sql` or `)}) as ${f(i)}`), sql`, `);
    // Every letter kept (a letter with no document matches none), so a walk shorter than its depth read the mailbox whole.
    const asked = (n: SQL | number): SQL => sql`(select m.id as id, m.date as date from messages m left join folder_state fs on fs.message_id = m.id
      where ${where} order by m.date desc nulls last, m.id desc limit ${n}) w
      left join lateral (select ${flags} from message_search s where s.message_id = w.id offset 0) x on true`;
    const bound = SEARCH_PART_WALK_FACTOR * k;
    const walks = (i: number): SQL => sql`(select ${h(i)} >= ${Math.ceil(k / SEARCH_PART_PROBE_SHARE)} from ${probe})`;
    // The depth of an arm's K-th match at its probe's rate (none when the probe saw none).
    const reach = (i: number): SQL => sql`(select case when ${h(i)} > 0 then (${3 * k * k} + 2 * ${h(i)} - 1) / (2 * ${h(i)}) end from ${probe})`;
    // In the walk's own order, newest first: an order by here would sort the walk's whole depth.
    const walked = (i: number): SQL => sql`select id, date from ${walk} where ${f(i)} and ${walks(i)} limit ${k}`;
    // Short of K, unless the walk read fewer letters than its depth: then it read every letter under the filters.
    const short = (i: number): SQL => sql`(case when (select count(*) from (${walked(i)}) t) >= ${k} then false
      when not ${walks(i)} then true else (select count(*) from ${walk}) >= ${bound} end)`;
    const ctes: SQL[] = [
      sql`${probe} as (select ${sql.join(joined.map((i) => sql`coalesce(sum(case when x.${f(i)} then 1 else 0 end), 0) as ${h(i)}`), sql`, `)}
        from ${asked(k)})`,
      sql`${walk} as (select w.id as id, w.date as date, ${sql.join(joined.map((i) => sql`x.${f(i)}`), sql`, `)}
        from ${asked(sql`(select case when ${sql.join(joined.map((i) => sql`${h(i)} >= ${Math.ceil(k / SEARCH_PART_PROBE_SHARE)}`), sql` or `)} then ${bound} else 0 end from ${probe})`)})`,
    ];
    // The text arm beside a part arm (a part of a word finds what the whole word finds), off the heap.
    const part = heap ? undefined : joined.find((i) => arms[i]!.name === "part" && !arms[i]!.across);
    const text = part === undefined ? -1 : arms.findIndex((x) => x.name === "text" && !x.bounded && !x.local && x.branches.length === 1
      && x.branches[0]!.raw !== undefined && x.branches[0]!.after === undefined && x.branches[0]!.pos === undefined);
    const reads = new Map<number, TierRead>();
    for (const i of joined) {
      const q = named(i, "q");
      ctes.push(sql`${q} as (select ${short(i)} as v)`);
      const s = heap ? { named: [], rows: sql`select id, date from (${this.matchedOf(where, arms[i]!.branches, k)}) m where (select v from ${q})` }
        // A part arm the text arm follows walks History against its set even past the probe's reach: its depth is the text arm's proof.
        : this.setPath(where, k, {
          short: sql`(select v from ${q})`, branches: arms[i]!.branches, name: (x) => named(i, x),
          ...(i === part && text >= 0 ? { every: true } : { reach: reach(i) }),
        });
      ctes.push(...s.named);
      reads.set(i, { rows: sql`select id, date, 0 as rank from (${walked(i)}) w where not (select v from ${q})
        union all select id, date, 0 as rank from (${s.rows}) x` });
    }
    if (part !== undefined && text >= 0) {
      // Its own set when every account's part set holds at most so many ids a letter walked to the part's K-th match.
      const gate = sql.raw(`${pre}tg`);
      ctes.push(sql`${gate} as (select coalesce((select v from ${named(part, "q")}) and ((select g from ${named(part, "n")}) <= ${k}
        or (select d from ${named(part, "c")}) * ${SEARCH_TEXT_SET_PER_WALKED} >= (select g from ${named(part, "n")})), false) as v)`);
      // Its K-th match lies at least as deep as the part's.
      const s = this.setPath(where, k, {
        short: sql`(select v from ${gate})`, branches: arms[text]!.branches, name: (x) => sql.raw(`${pre}t${x}`), reach: sql`(select d from ${named(part, "c")})`, whole: true,
      });
      ctes.push(...s.named);
      reads.set(text, { gate: sql`(select v from ${gate})`, rows: s.rows });
    }
    return { named: ctes, of: (i) => reads.get(i) };
  }

  /**
   * A bounded arm's newest K. The newest {@link SEARCH_PART_WALK_FACTOR} × K messages under the
   * filters are walked in order, each asked every branch by itself (`limit 1 offset 0` keeps it a
   * per-row question: no join, so no read of every match); when they hold fewer than K, each
   * branch's matches are read instead, under a sort key no index serves (`date is null` first is
   * `nulls last`), so off its GIN. Exactly one of the two answers. Before the backfill the branches'
   * matches are read as one set instead ({@link setPath}); an arm of its tier's one walk reads that ({@link tierWalk}).
   */
  private boundedRead(where: SQL, branches: readonly Branch[], k: number): SQL {
    const newestOf = (n: number): SQL => sql`select m.id as id, m.date as date from messages m left join folder_state fs on fs.message_id = m.id
      where ${where} order by m.date desc nulls last, m.id desc limit ${n}`;
    const read = (b: Branch): SQL => sql`select id, date from (select m.id as id, m.date as date ${this.from}
      where ${where} and ${b.pred} order by (m.date is null), m.date desc, m.id desc limit ${k}) r`;
    const matched = this.matchedOf(where, branches, k);
    // Every branch the document's own: each walked row asks its document alone. The walk's row is
    // already the message under the filters, and a second lookup of it was a disk read per row cold.
    const docOnly = branches.every((b) => b.raw !== undefined);
    const hitOf = (preds: SQL[]): SQL => (docOnly
      ? sql`exists (select 1 from message_search s where s.message_id = w.id and (${sql.join(preds, sql` or `)}) limit 1 offset 0)`
      : sql`exists (select 1 from messages m left join message_search s on s.message_id = m.id
      left join message_bodies b on b.message_id = m.id
      where m.id = w.id and (${sql.join(preds, sql` or `)}) limit 1 offset 0)`);
    const hit = hitOf(branches.map((b) => b.pred));
    // The probe: the newest K asked first; a part too sparse there to fill the walk skips it.
    const probe = sql`(select count(*) from (${newestOf(k)}) w where ${hit})`;
    const walkedOn = (dense: SQL): SQL => sql`select w.id as id, w.date as date from (${newestOf(SEARCH_PART_WALK_FACTOR * k)}) w where ${dense} and ${hit}
      order by w.date desc nulls last, w.id desc limit ${k}`;
    const walked = walkedOn(sql`${probe} >= ${Math.ceil(k / SEARCH_PART_PROBE_SHARE)}`);
    const plain = branches.every((b) => b.after === undefined && b.pos === undefined);
    // Before the backfill: each branch's matches off its own table, never one OR across tables.
    const sets = branches.map((b) => (b.raw !== undefined ? sql`select s.message_id as id from message_search s where ${b.pred}` : b.set));
    if (plain && !heapWhere.has(where) && sets.every((s) => s !== undefined)) {
      const s = this.setPath(where, k, {
        short: sql`(select v from pq)`, set: sql.join(sets as SQL[], sql` union all `), name: (x) => sql.raw("p" + x), distinct: sets.length > 1,
        reach: sql`(select case when h > 0 then (${3 * k * k} + 2 * h - 1) / (2 * h) end from pp)`,
      });
      return sql`(with pp as (select ${probe} as h), pw as (${walkedOn(sql`(select h from pp) >= ${Math.ceil(k / SEARCH_PART_PROBE_SHARE)}`)}),
        pq as (select (select count(*) from pw) < ${k} as v), ${sql.join(s.named, sql`, `)}
        select id, date, 0 as rank from pw where not (select v from pq)
        union all select id, date, 0 as rank from (${s.rows}) x)`;
    }
    if (plain) {
      return sql`(with pw as (${walked})
      select id, date, 0 as rank from pw where (select count(*) from pw) >= ${k}
      union all
      select id, date, 0 as rank from (${matched}) pm where (select count(*) from pw) < ${k})`;
    }
    // AN EXCLUSION, whose check reads the body: never asked of every index match. The newest bound
    // of mail is walked, each row asked whole. Short of K with older mail unasked, the walk goes on to
    // {@link SEARCH_EXCLUSION_WALK_FACTOR} cuts when what it kept would fill K there at the same rate,
    // or when a held branch's words without the exclusion are dense in the newest K (their matches,
    // too many to read off the index); it walks only until the arm holds a page (K over
    // {@link SEARCH_ARM_FACTOR}), since each letter it asks costs a document read and the arm says it
    // is cut anyway. Otherwise the branches the index answers whole are read, and each held branch's
    // matches newest first under the bound, asked `after` one by one until K pass. The arm is cut
    // (`x`, a row of its own) when the deeper walk stopped short of K with mail past it, or a held
    // read was full.
    const bound = SEARCH_PART_WALK_FACTOR * k;
    const far = SEARCH_EXCLUSION_WALK_FACTOR * k;
    const page = Math.ceil(k / SEARCH_ARM_FACTOR);
    // A group's index branch is inside its held branch (the same words, `pos`), so a walk asks the held one alone.
    const inside = (b: Branch): boolean => b.after === undefined && b.pos !== undefined
      && branches.some((o) => o.after !== undefined && o.pos === b.pos);
    const kept = hitOf(branches.filter((b) => !inside(b)).map((b) => (b.after === undefined ? b.pred : sql`(${b.pred} and ${b.after})`)));
    const sure = branches.filter((b) => b.after === undefined);
    const late = branches.flatMap((b, i) => (b.after === undefined ? [] : [{ b, i }]));
    // A held branch's words without the exclusion, asked of the newest K (`pb`).
    const words = late.length === 0 ? sql`false` : hitOf(late.map(({ b }) => b.pos ?? b.pred));
    const count = (n: number, skip = 0): SQL => sql`(select count(*) from (select m.id from messages m left join folder_state fs on fs.message_id = m.id
      where ${where} order by m.date desc nulls last, m.id desc limit ${n} offset ${skip}) f)`;
    // Each asked once, and only once the one before it holds.
    const short = sql`(select count(*) from pw) < ${k}`;
    const full = sql`(select v from pf)`;
    const crowded = sql`(select v from pb)`;
    // The kept rate fills K inside the deeper walk, or a held branch's index read would read every match.
    const rate = sql`(select count(*) from pw) >= ${Math.ceil((k * bound) / far)}`;
    const walkOn = sql`(select v from pv)`;
    const index = sql`${short} and ${full} and not ${walkOn}`;
    const pr = (i: number): SQL => sql.raw("pr" + String(i));
    const deep = late.map(({ b, i }) => sql`, ${pr(i)} as (select m.id as id, m.date as date ${this.from}
        where ${where} and ${b.pred} and ${index} order by (m.date is null), m.date desc, m.id desc limit ${bound})`);
    const passed = late.map(({ b, i }) => sql`select id, date from (select p.id, p.date from ${pr(i)} p where ${this.keeps(b.after!, sql`p.id`)} limit ${k}) k${pr(i)}`);
    const found = [
      sql`select id, date from pw`, sql`select id, date from pd`,
      ...sure.map((b) => sql`select id, date from (${read(b)}) s where ${index}`), ...passed,
    ];
    const readFull = late.length === 0 ? sql`false` : sql.join(late.map(({ i }) => sql`(select count(*) from ${pr(i)}) >= ${bound}`), sql` or `);
    return sql`(with pw as (select w.id as id, w.date as date from (${newestOf(bound)}) w where ${kept}
        order by w.date desc nulls last, w.id desc limit ${k}),
      pf as (select ${count(bound)} >= ${bound} as v),
      pb as (select (select count(*) from (${newestOf(k)}) w where ${words}) >= ${Math.ceil(k / SEARCH_PART_PROBE_SHARE)} as v),
      pv as (select ${rate}${late.length === 0 ? sql`` : sql` or ${crowded}`} as v),
      pd as (select w.id as id, w.date as date from (select m.id as id, m.date as date from messages m left join folder_state fs on fs.message_id = m.id
          where ${where} order by m.date desc nulls last, m.id desc limit ${far - bound} offset ${bound}) w
        where ${short} and ${full} and ${walkOn} and ${kept} order by w.date desc nulls last, w.id desc
        limit (case when ${page} - (select count(*) from pw) > 0 then ${page} - (select count(*) from pw) else 0 end))${sql.join(deep, sql``)}
      select id, date, 0 as rank, 0 as x from pw where (select count(*) from pw) >= ${k}
      union all
      select id, date, 0 as rank, 0 as x
      from (select id, date from (${sql.join(found, sql` union `)}) a
        order by (date is null), date desc, id desc limit ${k}) pm
      where ${short}
      union all
      select null, null, 0, 1 where ${short} and ${full} and (case when ${walkOn}
        then (select count(*) from pw) + (select count(*) from pd) >= ${page} or ${count(1, far)} > 0 else ${readFull} end))`;
  }

  /** Each branch's newest K matches under the filters, read off its own index (no index serves `(date is null)` first). */
  private matchedOf(where: SQL, branches: readonly Branch[], k: number): SQL {
    const read = (b: Branch): SQL => sql`select id, date from (select m.id as id, m.date as date ${this.from}
      where ${where} and ${b.pred} order by (m.date is null), m.date desc, m.id desc limit ${k}) r`;
    return sql`select id, date from (${sql.join(branches.map(read), sql` union all `)}) u group by id, date`;
  }

  /**
   * A BOUNDED ARM'S MATCHES AS ONE SET once its walk fell short (`short` gates every read here), off
   * the heap, named by `name`. The set is read whole: its per-branch read reads every match too, and
   * sorts them. Under K members, or with its K-th match expected past the walk's bound (`reach`, the
   * depth the probe predicts), each member is dated, a lookup each; else History is walked newest first
   * against the set (a hashed SubPlan: `is true` keeps it from becoming a join), index entries only, at
   * most {@link SEARCH_SET_WALK_PER_MEMBER} a member (`whole`: to its end), and every member is dated
   * when that walk stopped short of K with History left. Exactly one answer, each exact. `every` keeps
   * every account's matches beside the set, counted as `g`, and the walk's depth at its last row as `d`.
   */
  private setPath(where: SQL, k: number, o: {
    readonly short: SQL; readonly name: (s: string) => SQL; readonly branches?: readonly Branch[]; readonly set?: SQL;
    readonly reach?: SQL; readonly every?: boolean; readonly whole?: boolean; readonly distinct?: boolean;
  }): { named: SQL[]; rows: SQL } {
    const [a, s, n, h, c] = ["a", "s", "n", "h", "c"].map(o.name) as [SQL, SQL, SQL, SQL, SQL];
    const per = SEARCH_SET_WALK_PER_MEMBER;
    const size = sql`(select n from ${n})`;
    // Every member dated: under K of them, or its K-th match expected past the walk's bound.
    const lookups = o.reach === undefined ? sql`${size} < ${k}`
      : sql`(${size} < ${k} or coalesce(${o.reach} > ${per} * ${size}, false))`;
    // Off the heap the filters read `messages` alone: no folder, so no folder_state.
    const dated = sql`select t.id as id, d.date as date from (select ${o.distinct ? sql`distinct ` : sql``}id from ${s}) t
      cross join lateral (select m.date as date from messages m where m.id = t.id and ${where} offset 0) d`;
    // The documents' own predicates by themselves (`offset 0`), the account asked after: beside it the
    // planner read the account's documents and asked each one.
    const own = o.branches === undefined ? undefined : sql`select s.message_id as id, s.account_id as account from message_search s
      where (${sql.join(o.branches.map((b) => b.raw!), sql` or `)}) and ${o.short} offset 0`;
    const account = o.branches?.[0]?.account ?? "";
    const rn = o.every ? sql`, row_number() over (order by m.date desc nulls last, m.id desc) as rn` : sql``;
    // In History's own order: an order by over the walk would read it to its end.
    const history = sql`select m.id as id, m.date as date${rn} from messages m
      where ${where} and not ${lookups} order by m.date desc nulls last, m.id desc${o.whole ? sql`` : sql` limit ${per} * ${size}`}`;
    const named = [
      ...(o.every && own ? [sql`${a} as materialized (${own})`, sql`${s} as not materialized (select id from ${a} where account = ${account})`]
        : [sql`${s} as materialized (${own ? sql`select x.id as id from (${own}) x where x.account = ${account}` : sql`select id from (${o.set!}) u where ${o.short}`})`]),
      sql`${n} as (select count(*) as n${o.every ? sql`, (select count(*) from ${a}) as g` : sql``} from ${s})`,
      sql`${h} as (select w.id as id, w.date as date${o.every ? sql`, w.rn as rn` : sql``} from (${history}) w
        where (w.id in (select id from ${s})) is true limit ${k})`,
    ];
    // Walked to History's end, its rows are every member under the filters.
    if (o.whole) return { named, rows: sql`select id, date from ${h} union all ${dated} where ${lookups}` };
    // Short of K with History left past the walk's reach.
    const cut = sql`case when ${lookups} or count(*) >= ${k} then false
      else (select count(*) from (select 1 from messages m where ${where}
        order by m.date desc nulls last, m.id desc limit ${per} * ${size}) f) >= ${per} * ${size} end`;
    return {
      named: [...named, sql`${c} as (select ${cut} as cut${o.every ? sql`, max(rn) as d` : sql``} from ${h})`],
      rows: sql`select id, date from ${h} where not (select cut from ${c}) union all ${dated} where ${lookups} or (select cut from ${c})`,
    };
  }

  /** `after` holds for the message `id`: one document lookup, asked by itself. */
  private keeps(after: SQL, id: SQL): SQL {
    return sql`exists (select 1 from message_search s where s.message_id = ${id} and ${after} limit 1 offset 0)`;
  }

  /**
   * An arm that says it is cut apart from its count (`x`): the desktop's walk, and an arm held to an
   * excluded word ({@link boundedRead}'s row with no id), which may read fewer than K and still be cut.
   */
  private static capped(arm: Arm): boolean {
    return arm.local !== undefined || arm.branches.some((b) => b.after !== undefined || b.pos !== undefined);
  }

  /**
   * THE TYPO ARM'S NEWEST K, ranked. The newest K under the filters are asked first, and their hits
   * `h` say about how many messages hold K matches (K²/h): the walk reads them, each document asked
   * `walkPred` (the cheap condition, then the similarity), when that is at most
   * {@link SEARCH_TYPO_WALK_FACTOR} cuts and the mailbox has that many. Otherwise, or when the walk
   * holds fewer than K, the operator's matches are read off the trigram GIN. Either answer is the
   * newest K matches, and only those K are ranked.
   */
  private typoRead(where: SQL, b: Branch, { walkPred, vectors }: NonNullable<Arm["typo"]>, k: number): SQL {
    const newestOf = (n: SQL | number): SQL => sql`select m.id as id, m.date as date from messages m left join folder_state fs on fs.message_id = m.id
      where ${where} order by m.date desc nulls last, m.id desc limit ${n}`;
    // Each walked message's document asked by itself (`offset 0`), so the walk streams in its order
    // and stops at K: joined, a mailbox inside the bound was read whole and sorted. `lower` once each.
    // The vectors only for an excluded word, which the walk then asks of the whole letter.
    const tsv = vectors ? sql`, s.head_tsv, s.text_tsv` : sql``;
    const asked = (n: number): SQL => sql`(${newestOf(n)}) w cross join lateral (select s.account_id, s.terms, lower(s.terms) as t${tsv}
      from message_search s where s.message_id = w.id offset 0) s where ${walkPred}`;
    const h = sql`(select h from tp)`;
    const need = sql`((${k * k} + ${h} - 1) / (case when ${h} > 0 then ${h} else 1 end))`;
    const dense = sql`${h} >= ${Math.ceil(k / SEARCH_TYPO_WALK_FACTOR)}
      and (select count(*) from (${newestOf(need)}) n) >= ${need}`;
    const walked = sql`select w.id as id, w.date as date from ${asked(SEARCH_TYPO_WALK_FACTOR * k)} and ${dense}
      order by w.date desc nulls last, w.id desc limit ${k}`;
    const read = sql`select m.id as id, m.date as date ${this.from} where ${where} and ${b.pred}
      order by (m.date is null), m.date desc, m.id desc limit ${k}`;
    const rank = sql`(select ${b.rank} from message_search s where s.message_id = u.id)`;
    return sql`(with tp as (select count(*) as h from ${asked(k)}), tw as (${walked})
      select u.id, u.date, ${rank} as rank from (
        select id, date from tw where (select count(*) from tw) >= ${k}
        union all
        select id, date from (${read}) tm where (select count(*) from tw) < ${k}) u)`;
  }

  /** The union of every branch's id set — what `total` and the facets count over. */
  private unionSql(where: SQL, arms: readonly Arm[]): SQL {
    const selects = arms.flatMap((a) => a.branches)
      .map((b) => sql`select m.id as id ${this.from} where ${where} and ${b.pred}${b.after ? sql` and ${b.after}` : sql``}`);
    return sql.join(selects, sql` union `);
  }

  /**
   * One tier's arms as the named statements `a0…` cut at K, their `(id, r)` rows and each one's
   * size (named apart: positional rows collapse same-named columns on the server's driver). The
   * typo tier ranks its newest K only: every candidate costs one similarity, and the tier is a
   * guess list, where the closest recent guesses are the useful ones.
   */
  private fusedArms(
    d: Dialect, where: SQL, arms: readonly Arm[], tier: SearchTier, limit: number,
    opts: { prefix?: string; gate?: SQL } = {},
  ): { k: number; named: SQL; all: SQL; sizes: SQL[]; sizeNames: string[]; cutRow: SQL } {
    const k = SEARCH_ARM_FACTOR * limit;
    const window = tier === "similar" ? k : SEARCH_RANK_WINDOW_FACTOR * limit;
    const pre = opts.prefix ?? "";
    const walkName = sql.raw(pre + "lwalk");
    const walking = arms.some((x) => x.local);
    // A local arm's rows of the one shared walk ({@link sharedWalk}), newest first, at its cut.
    const walkOf = (i: number): SQL => sql`select id, date, ${sql.raw("r" + String(i))} as rank from ${walkName}
      where ${sql.raw("f" + String(i))} order by date desc nulls last, id desc limit ${arms[i]!.ranked ? window : k}`;
    const { named: tierNamed, of: tierOf } = this.tierWalk(where, arms, k, pre);
    const armSqls = arms.map((x, i) => this.armSql(where, x, k, window, x.local ? walkOf(i) : undefined, tierOf(i)));
    const a = (i: number): SQL => sql.raw(pre + "a" + String(i));
    const sizeNames = armSqls.map((_, i) => pre + "n" + String(i));
    // A gated arm is counted only when its gate holds, so a count never starts the arm either.
    // A local arm whose walk fell short counts as cut ({@link localRead}'s `x`), as does an arm an
    // exclusion cut short ({@link armSql}'s and {@link boundedRead}'s).
    const held = (i: number): SQL => (SearchService.capped(arms[i]!) ? sql`(select count(id) + ${k} * coalesce(max(x), 0) from ${a(i)})`
      : sql`(select count(*) from ${a(i)})`);
    const size = (i: number): SQL => (opts.gate === undefined ? held(i)
      : sql`(case when ${opts.gate} then ${held(i)} else 0 end)`);
    return {
      k,
      named: sql.join([
        ...(walking ? [sql`${walkName} as (${this.sharedWalk(where, arms, k)})`] : []),
        ...tierNamed,
        ...armSqls.map((x, i) => sql`${a(i)} as (${x})`),
      ], sql`, `),
      // Each row carries the date its arm read, so the fused candidates are ordered without being
      // looked up again: one read of a message per candidate, a disk read each on a cold page.
      all: sql.join(armSqls.map((_, i) => sql`select id, date, r from ${a(i)}${SearchService.capped(arms[i]!) ? sql` where id is not null` : sql``}`), sql` union all `),
      sizes: armSqls.map((_, i) => sql`${d.castInt(size(i))} as ${sql.raw(sizeNames[i]!)}`),
      sizeNames,
      // Some arm says it is cut apart from its rows: it may be cut with no row at all.
      cutRow: sql.join([sql`false`, ...armSqls.flatMap((_, i) => (SearchService.capped(arms[i]!) ? [sql`exists (select 1 from ${a(i)} where x = 1)`] : []))], sql` or `),
    };
  }

  /**
   * THE ESTIMATE of a cut match set, off the index and the statistics: an arm under its cut is
   * counted exactly by its own size, a cut arm by the planner's expected rows; the union is at
   * least its largest arm and at least the candidates it fused, and at most the planner's reading
   * of the mailbox under the filters (a join's estimate can exceed the table it reads: "about
   * 75,246" of 74,003). Every cut arm and the mailbox are asked in ONE plan. Never asked for the
   * typo tier: `<%` has no selectivity estimator, so its planner rows are a default, and a cut
   * typo arm is said as "at least" until the exact count lands.
   */
  private async estimateOf(
    ctx: ServiceContext, d: Dialect, where: SQL, arms: readonly Arm[], sizes: readonly number[], k: number, candidates: number,
  ): Promise<number> {
    const cut = arms.flatMap((_, i) => (sizes[i]! < k ? [] : [i]));
    const mailbox = sql`select m.id as id from messages m left join folder_state fs on fs.message_id = m.id where ${where}`;
    const read = await d.search.estimateRowsEach(ctx.db, [...cut.map((i) => this.unionSql(where, [arms[i]!])), mailbox]);
    const about = Math.max(candidates, ...arms.map((_, i) => (cut.includes(i) ? read[cut.indexOf(i)] ?? sizes[i]! : sizes[i]!)));
    const upper = read[cut.length] ?? null;
    return upper === null ? about : Math.max(candidates, Math.min(about, upper));
  }

  /**
   * ONE PAGE — the first response, with nothing counted on its path. Relevance: the arms' top-K,
   * fused by reciprocal rank and paged by `(score, date, id)`. A chosen order: the union of the
   * arms' predicates, walked by its own keyset. The tier is the exact tier unless it has no row.
   */
  async page(ctx: ServiceContext, opts: SearchOptions): Promise<SearchPage> {
    const q = SearchService.termOf(opts.q);
    if (!q) return { items: [], tier: "exact", nextCursor: null, bounded: false, candidates: 0, cut: false };
    const limit = SearchService.pageOf(opts.limit);
    const sort: SearchSort = opts.sort ?? "relevance";
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    const d = dialect(ctx.db);
    const where = this.whereSql(d, ctx.accountId, opts.filters ?? {});

    // ONE session for the page: its settings and the marker, the tier's rows joined into their
    // DTOs, and the typo tier in the same transaction when the exact tier is empty — on Postgres
    // in the same statement ({@link firstRelevancePage}).
    const { tier, got, importing } = await this.session(ctx, d, async (db, built) => {
      if (cursor === null && sort === "relevance" && d.name === "pg") {
        return this.firstRelevancePage(ctx, db, d, q, where, limit, built);
      }
      let t: SearchTier = cursor?.t ?? "exact";
      let rows = await this.pageRows(ctx, db, d, q, t, where, sort, limit, cursor, built);
      // In every order the tier the first relevance page answers: a cut exact tier with no row stays.
      if (cursor === null && t === "exact" && rows.items.length === 0 && !(await this.cutEmpty(ctx, db, d, q, where, limit, built))) {
        t = "similar";
        rows = await this.pageRows(ctx, db, d, q, t, where, sort, limit, null, built);
      }
      return { tier: t, got: rows };
    });
    const items = got.items;
    const nextCursor = got.next === null ? null : encodeCursor({ ...got.next, t: tier } as SearchCursor);
    const bounded = sort === "relevance" && nextCursor === null && got.cut;
    return { items, tier, nextCursor, bounded, candidates: got.candidates, cut: got.cut, ...(importing ? { importing } : {}) };
  }

  /**
   * THE FIRST RELEVANCE PAGE AND ITS TYPO TIER AS ONE STATEMENT, for a store where a statement is
   * a round trip: the typo arms sit behind a count of the exact tier's fused rows, which Postgres
   * plans as a one-time filter, so they never start when the exact tier answers and a closest-
   * words page costs the round trips of an exact one. No row at all answers as the typo tier,
   * unless an exact arm says it is cut with no row ({@link fusedArms}' `cutRow`: every newest match
   * held an excluded word): then no guess is read, and the answer is the exact tier, cut and empty,
   * so the count and the date orders read on. Its marker row (`t` 2) is the newest message under the
   * filters, which the materializing join keeps, and is never shown.
   */
  private async firstRelevancePage(
    ctx: ServiceContext, db: unknown, d: Dialect, q: string, where: SQL, limit: number, built: StoreFacts,
  ): Promise<{ tier: SearchTier; got: TierRows }> {
    const empty = sql`(select count(*) from fused_e) = 0`;
    const e = this.fusedArms(d, where, this.arms(ctx, d, q, "exact", built), "exact", limit);
    const none = sql`${empty} and not (${e.cutRow})`;
    const s = this.fusedArms(d, where, this.arms(ctx, d, q, "similar", built), "similar", limit, { prefix: "s", gate: none });
    const marker = sql`select m.id as id, m.date as date, 0 as score, 2 as t from messages m left join folder_state fs on fs.message_id = m.id
      where ${where} and ${empty} and (${e.cutRow}) order by m.date desc nulls last, m.id desc limit 1`;
    const score = d.castInt(sql`sum(${sql.raw(String(RRF_SCALE))} / (${sql.raw(String(RRF_K))} + r))`);
    const rows = await materializePage(db as Db, ctx.accountId, {
      rows: sql`
      with ${e.named}, fused_e as (select id, date, ${score} as score from (${e.all}) x group by id, date),
      ${s.named}, fused_s as (select id, date, ${score} as score from (${s.all}) x where ${none} group by id, date),
      fused as (select id, date, score, 0 as t from fused_e union all select id, date, score, 1 as t from fused_s
        union all select id, date, score, t from (${marker}) mk)
      select f.id as id, f.score as score, f.t as t, ${d.castInt(sql`(select count(*) from fused where t < 2)`)} as fused,
        ${sql.join([...e.sizes, ...s.sizes], sql`, `)}
      from fused f
      order by f.score desc, f.date desc nulls last, f.id desc
      limit ${limit + 1}`,
      keys: ["score", "t", "fused", ...e.sizeNames, ...s.sizeNames],
      order: sql`p.score desc, ${messages.date} desc nulls last, ${messages.id} desc`,
    });
    if (rows.length > 0 && Number(rows[0]!.keys[1]) === 2) {
      return { tier: "exact", got: { items: [], next: null, cut: true, candidates: 0 } };
    }
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const tier: SearchTier = rows.length > 0 && Number(rows[0]!.keys[1]) === 0 ? "exact" : "similar";
    const sizes = (rows[0]?.keys ?? []).slice(3).map((n) => Number(n));
    const own = tier === "exact" ? sizes.slice(0, e.sizes.length) : sizes.slice(e.sizes.length);
    return {
      tier,
      got: {
        items: page.map((r) => r.dto),
        next: rows.length > limit && last ? { k: "r", s: Number(last.keys[0]), d: millisOf(last.dto.date), i: last.dto.id } : null,
        cut: own.some((n) => n >= e.k),
        candidates: Number(rows[0]?.keys[2] ?? 0),
      },
    };
  }

  /**
   * Is the exact tier, read as the first relevance page reads it at `limit`, cut with no row
   * ({@link fusedArms}' `cutRow`)? Asked only once the exact tier holds nothing, so every answer —
   * a page in any order, the estimate, the summary — stays in the tier the first page answers in.
   */
  private async cutEmpty(
    ctx: ServiceContext, db: unknown, d: Dialect, q: string, where: SQL, limit: number, built: StoreFacts,
  ): Promise<boolean> {
    const e = this.fusedArms(d, where, this.arms(ctx, d, q, "exact", built), "exact", limit);
    const [row] = await d.exec(db, sql`with ${e.named} select case when ${e.cutRow} then 1 else 0 end as c`);
    return Number(row?.[0] ?? 0) === 1;
  }

  /**
   * The rows of one page of one tier as their DTOs, and the cursor after them — the tier's
   * statement is the source the materializing read joins, so the page is ONE statement on `db`.
   */
  private async pageRows(
    ctx: ServiceContext, db: unknown, d: Dialect, q: string, tier: SearchTier, where: SQL,
    sort: SearchSort, limit: number, cursor: SearchCursor | null, built: StoreFacts,
  ): Promise<TierRows> {
    const arms = this.arms(ctx, d, q, tier, built);
    // The page's arms read newest first off the History index or their own GIN — never a table
    // scan, which the planner picks for a word in a large share of the store (it does not price
    // the per-row vector read), so the page runs in the session that prices the scan out.
    const read = (source: MaterializeSource) => materializePage(db as Db, ctx.accountId, source);
    const dateOf = (dto: MessageDTO): number | null => millisOf(dto.date);
    if (sort === "relevance") {
      if (cursor !== null && cursor.k !== "r") throw new ServiceError("validation_failed", 400, "cursor belongs to another order");
      const { k, named, all, sizes } = this.fusedArms(d, where, arms, tier, limit);
      const after = cursor === null ? sql`` : sql`where (f.score < ${cursor.s} or (f.score = ${cursor.s} and ${afterDateDesc(d, cursor.d, cursor.i, sql`f.id`, sql`f.date`)}))`;
      const rows = await read({
        rows: sql`
        with ${named},
        fused as (select id, date, ${d.castInt(sql`sum(${sql.raw(String(RRF_SCALE))} / (${sql.raw(String(RRF_K))} + r))`)} as score from (${all}) x group by id, date)
        select f.id as id, f.score as score, ${d.castInt(sql`(select count(*) from fused)`)} as fused, ${sql.join(sizes, sql`, `)}
        from fused f
        ${after}
        order by f.score desc, f.date desc nulls last, f.id desc
        limit ${limit + 1}`,
        keys: ["score", "fused", ...sizes.map((_, i) => "n" + String(i))],
        order: sql`p.score desc, ${messages.date} desc nulls last, ${messages.id} desc`,
      });
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const sizesOf = (rows[0]?.keys ?? []).slice(2).map((n) => Number(n));
      const cut = sizesOf.some((n) => n >= k);
      const candidates = Number(rows[0]?.keys[1] ?? 0);
      return {
        items: page.map((r) => r.dto),
        next: rows.length > limit && last ? { k: "r", s: Number(last.keys[0]), d: dateOf(last.dto), i: last.dto.id } : null,
        cut, candidates,
      };
    }
    if (cursor !== null && (cursor.k !== "o" || cursor.o !== sort)) {
      throw new ServiceError("validation_failed", 400, "cursor belongs to another order");
    }
    const c = cursor as OrderedCursor | null;
    const { statement, key } = this.orderedPage(d, where, arms, sort, limit, c);
    const order = sort === "date_asc" ? sql`${messages.date} asc nulls last, ${messages.id} asc`
      : key === null ? sql`${messages.date} desc nulls last, ${messages.id} desc`
      : sql`p.k asc, ${messages.date} desc nulls last, ${messages.id} desc`;
    const rows = await read({ rows: statement, keys: ["k"], order });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => r.dto),
      next: rows.length > limit && last
        ? { k: "o", o: sort, x: key === null ? null : String(last.keys[0] ?? ""), d: dateOf(last.dto), i: last.dto.id }
        : null,
      // A date order walks the whole match set, so its page says nothing about the count.
      cut: true,
      candidates: page.length,
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
    return this.session(ctx, d, async (db, built) => {
      let tier: SearchTier = "exact";
      let counted = await this.facets(ctx, db, d, this.unionSql(where, this.arms(ctx, d, q, "exact", built)));
      await ctx.searchSupersede?.turn();
      // The page's tier: a first page cut with no row stayed exact, so its count is this one, 0.
      if (showSimilar(counted.total) && !(await this.cutEmpty(ctx, db, d, q, where, SearchService.pageOf(opts.limit), built))) {
        tier = "similar";
        counted = await this.facets(ctx, db, d, this.unionSql(where, this.arms(ctx, d, q, "similar", built)));
        await ctx.searchSupersede?.turn();
      }
      const { total, facets } = counted;
      const indexed = await this.indexing(ctx, db, built);
      return { total, facets, tier, ...(indexed ? { indexed } : {}) };
    }, true);
  }

  /**
   * THE SUMMARY'S FIRST ANSWER, at the page's cost — the count and facets over the tier's fused
   * candidates: the whole match set, exactly, when no arm was cut; otherwise the candidates as a
   * lower bound, `estimate` from the statistics, and the facets over those candidates. The tier
   * is the page's: exact unless it has no candidate.
   */
  async estimate(ctx: ServiceContext, opts: SearchOptions): Promise<SearchEstimate> {
    const q = SearchService.termOf(opts.q);
    if (!q) return { total: 0, facets: emptyFacets(), tier: "exact", exact: true, estimate: null };
    const limit = SearchService.pageOf(opts.limit);
    const d = dialect(ctx.db);
    const where = this.whereSql(d, ctx.accountId, opts.filters ?? {});
    const { tier, got, indexed, importing } = await this.session(ctx, d, async (db, built) => {
      const ofTier = async (t: SearchTier) => {
        const arms = this.arms(ctx, d, q, t, built);
        const { k, named, all, sizes } = this.fusedArms(d, where, arms, t, limit);
        const counted = await this.facets(ctx, db, d, sql`select id from (${all}) x group by id`, { named, extras: sizes });
        const cut = counted.extras.some((n) => n >= k);
        return { ...counted, arms, cut, estimateOf: cut && t !== "similar" ? (): Promise<number> => this.estimateOf(ctx, d, where, arms, counted.extras, k, counted.total) : null };
      };
      let t: SearchTier = "exact";
      let counted = await ofTier(t);
      await ctx.searchSupersede?.turn();
      if (counted.cut && counted.total === 0) {
        // A cut exact tier is never replaced by guesses, though no row survived. The planner's
        // reading counts the letters the walk found excluded, so it is no estimate here: the whole
        // set is counted, the summary's count — 0 when nothing matches, never "about N".
        counted = { ...(await this.facets(ctx, db, d, this.unionSql(where, counted.arms))), arms: counted.arms, cut: false, estimateOf: null };
        await ctx.searchSupersede?.turn();
      } else if (showSimilar(counted.total)) {
        t = "similar";
        counted = await ofTier(t);
        await ctx.searchSupersede?.turn();
      }
      return { tier: t, got: counted, indexed: await this.indexing(ctx, db, built) };
    }, true);
    // The planner's estimate reads statistics, outside the session and only for a cut arm.
    if (got.estimateOf !== null) await ctx.searchSupersede?.turn();
    const estimate = got.estimateOf === null ? null : await got.estimateOf();
    return {
      total: got.total, facets: got.facets, tier, exact: !got.cut, estimate,
      ...(indexed ? { indexed } : {}), ...(importing ? { importing } : {}),
    };
  }

  /** This account's search documents while something is still building them, else nothing. */
  private async indexing(ctx: ServiceContext, db: unknown, store: StoreFacts): Promise<{ done: number; total: number } | undefined> {
    if (store.built || !this.opts.indexFills) return undefined;
    const handle = ctx.db as unknown as object;
    const memo = progressRead.get(handle) ?? new Map<string, { at: number; p: { done: number; total: number } }>();
    progressRead.set(handle, memo);
    const now = ctx.now().getTime();
    const seen = memo.get(ctx.accountId);
    let p = seen !== undefined && now >= seen.at && now - seen.at < INDEX_PROGRESS_FRESH_MS ? seen.p : null;
    if (p === null) {
      p = await searchIndexProgress(db as never, ctx.accountId);
      if (memo.size >= MARKER_MEMO_MAX) memo.clear();
      memo.set(ctx.accountId, { at: now, p });
    }
    return p.done < p.total ? p : undefined;
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
    ctx.searchSupersede?.check();
    const t0 = performance.now();
    const parts: SearchParts = opts.parts ?? "both";
    const ms = (): number => Math.round(performance.now() - t0);
    // Each part reads the store's coverage in its own session statement; the latest part's stands.
    const cov = (p: Coverage) => (p.importing ? { importing: true as const } : {});
    if (parts === "summary") {
      const s = await this.summary(ctx, opts);
      return {
        items: [], facets: s.facets, total: s.total, tier: s.tier, totalExact: true,
        nextCursor: null, bounded: false, ...(s.indexed ? { indexed: s.indexed } : {}), ...cov(s), ms: ms(),
      };
    }
    if (parts === "estimate") {
      const e = await this.estimate(ctx, opts);
      return {
        items: [], facets: e.facets, total: e.total, tier: e.tier, totalExact: e.exact,
        ...(e.estimate !== null ? { totalEstimate: e.estimate } : {}),
        nextCursor: null, bounded: false, ...(e.indexed ? { indexed: e.indexed } : {}), ...cov(e), ms: ms(),
      };
    }
    const page = await this.page(ctx, opts);
    if (parts === "page") {
      return {
        items: page.items, facets: null, total: page.candidates, tier: page.tier, totalExact: !page.cut,
        nextCursor: page.nextCursor, bounded: page.bounded, ...cov(page), ms: ms(),
      };
    }
    const s = await this.summary(ctx, opts);
    return {
      items: page.items, facets: s.facets, total: s.total, tier: page.tier, totalExact: true,
      nextCursor: page.nextCursor, bounded: page.bounded, ...(s.indexed ? { indexed: s.indexed } : {}), ...cov(s), ms: ms(),
    };
  }

  /**
   * EVERY MESSAGE IN THE ARCHIVE FROM OR TO ONE ADDRESS — the address view's archive half. `from`:
   * `lower(m.from_address) = lower($1)` — byte-for-byte `whereSql`'s
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
    if (opts.direction !== "from") return this.searchByRecipient(ctx, d, where, { ...opts, address }, limit);
    const pred = sql`lower(m.from_address) = lower(${address})`;

    // The count carries the coverage fact in its own statement: no round trip for it.
    const [total, importing] = await this.count(ctx, d, sql`select m.id as id ${this.from} where ${where} and ${pred}`);
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
    // one statement for the page instead of one per hit on a `max: 1` pool.
    const byId = await materializeMessages(ctx.db, ctx.accountId, hitIds);
    const items: MessageDTO[] = [];
    for (const id of hitIds) {
      const dto = byId.get(id);
      if (dto) items.push(dto);
    }
    return { items, total, direction: opts.direction, ...(importing ? { importing: true as const } : {}) };
  }

  /**
   * `to` and `any` (mail 0154): one bounded arm whose branches are each index-served — the
   * recipient keys, and for `any` the from-branch beside it — merged as a union, never an OR. The
   * own address is in To of nearly every message, so the dense case walks the newest messages
   * under `whereSql` and the sparse case reads the index ({@link boundedRead}); PGlite's planner
   * has no fresh statistics to choose between them. `total` counts the union, each message once.
   * `whereSql` carries the account, and the server's key carries it too.
   */
  private async searchByRecipient(
    ctx: ServiceContext, d: Dialect, where: SQL, opts: AddressSearchOptions, limit: number,
  ): Promise<AddressSearchResult> {
    const branches: Branch[] = [{ pred: d.search.recipient({ accountId: ctx.accountId, address: opts.address }), rank: sql`0` }];
    if (opts.direction === "any") branches.push({ pred: sql`lower(m.from_address) = lower(${opts.address})`, rank: sql`0` });
    const arm: Arm = { name: "recipient", ranked: false, bounded: true, branches };
    const [total, importing] = await this.count(ctx, d, this.unionSql(where, [arm]));
    const hitRows = await d.exec(ctx.db, sql`
      select a.id from (${this.armSql(where, arm, limit, limit)}) a
      order by a.r
      limit ${limit}`);
    const hitIds = hitRows.map((r) => String(r[0]));
    const byId = await materializeMessages(ctx.db, ctx.accountId, hitIds);
    const items: MessageDTO[] = [];
    for (const id of hitIds) {
      const dto = byId.get(id);
      if (dto) items.push(dto);
    }
    return { items, total, direction: opts.direction, ...(importing ? { importing: true as const } : {}) };
  }

  // ── counts & facets over the union of the tier's arms ─────────────────────────────────

  /**
   * ONE TRANSACTION FOR A SEARCH ANSWER, shaped for its reads: the typo threshold (read only by
   * the typo tier's operator) and the word indexes kept over a table scan, the account's backfill
   * marker and whether its store is still importing — all in ONE statement, so an answer costs
   * begin, this, its reads and commit. A store with no session (the device) reads the marker and
   * the import on its own handle, no round trip away.
   */
  private async session<T extends object>(
    ctx: ServiceContext, d: Dialect, fn: (db: unknown, store: StoreFacts) => Promise<T>, followUp = false,
  ): Promise<T & Coverage> {
    const covered = (out: T, open: boolean): T & Coverage => (open ? { ...out, importing: true as const } : out);
    /* A SUPERSEDED SEARCH STOPS BEFORE ITS FIRST STATEMENT. A queued transaction is reached by
       microtasks right after the holder's statement, before the engine reads the next request: a
       count or a summary takes one loop turn first; a page only checks, its path unchanged. */
    const sup = ctx.searchSupersede;
    const gate = sup === undefined ? null : followUp ? () => sup.turn() : async () => sup.check();
    // Before the transaction: the probe runs on the handle, and memoized, once per handle.
    const trigram = await hasTrgm(ctx.db);
    const setup = d.search.searchSession({ typoThreshold: FUZZY_THRESHOLD, preferIndexes: true });
    if (setup === null) {
      if (gate) await gate();
      const [built, open] = await Promise.all([searchIndexBuilt(ctx.db as never, ctx.accountId), storeStillImporting(ctx)]);
      return covered(await fn(ctx.db, { built, trigram }), open);
    }
    const handle = ctx.db as unknown as object;
    const known = markerWritten.get(handle) ?? new Set<string>();
    markerWritten.set(handle, known);
    const tx = ctx.db as unknown as { transaction: <R>(f: (t: unknown) => Promise<R>) => Promise<R> };
    if (known.has(ctx.accountId)) {
      // The warm settings carry no parameter, so the import rides them with the account inlined.
      const warm = sql`select ${importOpen(d, ctx.accountId, ctx.now(), { inline: true })} as importing, s.* from (${setup}) s`;
      return tx.transaction(async (t) => {
        if (gate) await gate();
        const { out, settings } = await afterSettingsRead(t, d, warm, () => fn(t, { built: true, trigram }));
        return covered(out, truthy(settings[0]?.[0]));
      });
    }
    // Scoped by the caller's account like every read below: a marker is one account's fact.
    const marker = sql`exists (select 1 from ${accountSettings}
      where ${accountSettings.accountId} = ${ctx.accountId} and ${accountSettings.searchIndexBuiltAt} is not null)`;
    return tx.transaction(async (t) => {
      if (gate) await gate();
      const [row] = await d.exec(t, sql`select ${marker} as built, ${importOpen(d, ctx.accountId, ctx.now())} as importing, s.* from (${setup}) s`);
      const built = truthy(row?.[0]);
      if (built) {
        if (known.size >= MARKER_MEMO_MAX) known.clear();
        known.add(ctx.accountId);
      }
      return covered(await fn(t, { built, trigram }), truthy(row?.[1]));
    });
  }

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
    return tx.transaction((t) => afterSettings(t, d, setup, () => fn(t)));
  }

  /** How many messages the union matches — ONE count over the union, each branch on its index — and {@link importOpen}. */
  private async count(ctx: ServiceContext, d: Dialect, ids: SQL, tier: SearchTier = "exact"): Promise<[number, boolean]> {
    const rows = await this.inSession(ctx, d, { tier, preferIndexes: true }, (db) =>
      d.exec(db, sql`select ${d.castInt(sql`count(*)`)} as n, ${importOpen(d, ctx.accountId, ctx.now())} as importing from (${ids}) u`));
    return [Number(rows[0]?.[0] ?? 0), truthy(rows[0]?.[1])];
  }

  /**
   * `total` and the facets over one tier's match set in ONE statement, the set read once — three
   * statements read it three times, 0.3 s each for a broad word on the desktop's store. POSITIONAL
   * rows `(kind, key, n, order, eight scalars, extras…)`: kind 0 the scalars and the caller's extra
   * columns, 1 a folder, 2 a sender in the SQL's own order. `arms` names statements `ids` reads.
   */
  private async facets(
    ctx: ServiceContext, db: unknown, d: Dialect, ids: SQL,
    arms?: { named: SQL; extras: readonly SQL[] },
  ): Promise<{ total: number; facets: Facets; extras: number[] }> {
    const now = ctx.now();
    const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
    // The instant is a different literal on each store — an ISO string the server parses, a count
    // of milliseconds the device keeps — so it goes through the seam.
    const today = d.ts(todayStart);
    const d7 = d.ts(new Date(todayStart.getTime() - 7 * 86_400_000));
    const d30 = d.ts(new Date(todayStart.getTime() - 30 * 86_400_000));
    const n = (e: SQL): SQL => d.castInt(e);
    const extras = arms?.extras ?? [];
    // Typed: a subquery's bare `null` reads as text on the server, and a union refuses the mix.
    const nulls = sql.join(Array.from({ length: 8 + extras.length }, () => n(sql`null`)), sql`, `);
    const scalars = [
      sql`count(*) filter (where h.unread)`, sql`count(*) filter (where not h.unread)`,
      sql`count(*) filter (where h.att)`, sql`count(*) filter (where not h.att)`,
      sql`count(*) filter (where h.date >= ${today})`,
      sql`count(*) filter (where h.date >= ${d7} and h.date < ${today})`,
      sql`count(*) filter (where h.date >= ${d30} and h.date < ${d7})`,
      sql`count(*) filter (where h.date is null or h.date < ${d30})`,
    ].map((e, i) => sql`${n(e)} as ${sql.raw("c" + String(i))}`);
    const statement = sql`
      with ${arms ? sql`${arms.named}, ` : sql``}u as (${ids}),
      h as (select m.unread as unread, m.has_attachments as att, m.date as date, m.from_address as addr, ${this.folderExpr} as folder
            from u join messages m on m.id = u.id left join folder_state fs on fs.message_id = m.id)
      select 0 as k, null as key, ${n(sql`count(*)`)} as n, 0 as o, ${sql.join([...scalars, ...extras], sql`, `)} from h
      union all
      select 1, folder, ${n(sql`count(*)`)}, 0, ${nulls} from h group by folder
      union all
      select * from (
        select 2 as k, addr as key, ${n(sql`count(*)`)} as n, ${n(sql`row_number() over (order by count(*) desc, addr asc)`)} as o, ${nulls}
        from h group by addr order by count(*) desc, addr asc limit ${SENDER_FACET_LIMIT}) s`;
    const rows = await d.exec(db, statement);
    const num = (v: unknown): number => Number(v ?? 0);
    const head = rows.find((r) => num(r[0]) === 0) ?? [];
    const s = head.slice(4, 12).map(num);
    const folder: Record<string, number> = {};
    for (const r of rows) if (num(r[0]) === 1) folder[String(r[1])] = num(r[2]);
    const sender = rows.filter((r) => num(r[0]) === 2).sort((a, b) => num(a[3]) - num(b[3]))
      .map((r) => ({ address: String(r[1]), count: num(r[2]) }));
    return {
      total: num(head[2]),
      facets: {
        folder,
        sender,
        unread: { true: s[0] ?? 0, false: s[1] ?? 0 },
        hasAttachments: { true: s[2] ?? 0, false: s[3] ?? 0 },
        date: { today: s[4] ?? 0, last7: s[5] ?? 0, last30: s[6] ?? 0, older: s[7] ?? 0 },
      },
      extras: head.slice(12).map(num),
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
    const where = sql.join(preds, sql` and `);
    if (f.folder !== undefined || f.sender !== undefined || f.unread !== undefined || f.hasAttachments !== undefined) heapWhere.add(where);
    return where;
  }
}

export const searchService = new SearchService();
