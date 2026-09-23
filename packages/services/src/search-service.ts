import { sql, type SQL } from "drizzle-orm";
import { holdsPunctuation, showSimilar, type SearchTier } from "@trafficflow/core/search-rank";
import type { ServiceContext, Db } from "./context.js";
import { dialect, pgOnly, type Dialect } from "@trafficflow/db/dialect";
import { materializeMessages } from "./dto/materialize.js";
import { clampLimit } from "./pagination.js";
import { ServiceError } from "./errors.js";
import { instantRefusal, readInstant } from "./instant.js";
import type { MessageDTO } from "./dto/types.js";

/**
 * Hybrid search in TWO TIERS. The EXACT tier fuses two literal arms by RRF: lexical
 * (`websearch_to_tsquery` over `subject_tsv`/`body_tsv`, `ts_rank`) and substring (the query's
 * characters inside the subject or sender, so `axa` finds `myAXA`). The SIMILAR tier — pg_trgm
 * `word_similarity` typo guesses — runs ONLY when the exact tier found nothing, and is never
 * fused: RRF ranks by position, so a guess at rank one beat a real match at rank five
 * (`graphite` returned "Grat" mail above the body that says graphite). A substring row is not a
 * guess — the characters are there. Tier rule: `@trafficflow/core/search-rank`, shared with the
 * client index. Search reads only subject / from_address / the STORED redacted body.
 */

/** pg_trgm word-similarity floor for the fuzzy arm (Postgres default is 0.3). */
const FUZZY_THRESHOLD = 0.3;
/** The RRF constant: an arm's row at position `r` contributes `1 / (RRF_K + r)`. */
const RRF_K = 60;
/** Each arm's cut is `max(FUSE_K_MIN, page × FUSE_K_PER_PAGE)` rows. */
const FUSE_K_PER_PAGE = 4;
const FUSE_K_MIN = 200;

/** A page of ids and what it says about the rest of the match set. */
interface Page { ids: string[]; seen: number; cut: boolean }
/** The substring arm's width floor — a trigram's, below which its index cannot select. */
const SUBSTRING_MIN_CHARS = 3;

/**
 * Does the substring arm run for this query? Shut for a quoted phrase or a `-term` — the reader
 * asking for exactness, which the lexical arm gives — and below a trigram's width unless the
 * query is punctuated (the verbatim case this arm grew out of: `pha/Bet` inside `Alpha/Beta`).
 */
function substringOpen(q: string): boolean {
  if (q.includes('"') || /(^|\s)-\S/.test(q)) return false;
  return [...q].length >= SUBSTRING_MIN_CHARS || holdsPunctuation(q);
}
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
  /** `null` when only the page was asked for (`parts: "page"`). */
  facets: Facets | null;
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
  /** `false` when `total` is a lower bound: the page alone was asked for and an arm was cut. */
  totalExact: boolean;
  /** This answer's server time in milliseconds. */
  ms: number;
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
    totalExact: true,
    ms: 0,
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
    // scoped-by: reads a Postgres catalog only — an extension probe, no account rows
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
    const started = performance.now();
    // THE CEILING IS CONSULTED BEFORE ANYTHING SCANS THE STRING. `.length` is O(1); `.trim()` is
    // O(n) and would scan a ten-megabyte caller string before the ceiling ran — and an
    // all-whitespace one would pay the scan and return a silent empty result. So the RAW length
    // decides, and the refusal reports it — the number the caller has to bring down. It allows
    // exactly ONE character over: one trailing space on a term at the ceiling, the only case the
    // trim was for. Two spaces are refused — the alternatives are trimming first (the unbounded
    // scan) or slicing first (silently ACCEPTING a truncated query).
    const raw = opts.q ?? "";
    /**
     * THE RAW LENGTH DECIDES, and the version that sliced first was silently wrong. Slicing to
     * the ceiling PLUS ONE and then trimming looks equivalent and is not: a term of exactly `MAX`
     * characters followed by a space and more text slices to `MAX + 1`, trims the boundary space,
     * and passes — the caller's search ran against a PREFIX of what they typed, with a 200 and no
     * indication. The silent truncation this bound's own docstring refuses, produced by the
     * bound. So the raw LENGTH is consulted first (O(1)), allowing exactly ONE character over —
     * one trailing space at the ceiling. Two over cannot trim back without losing a non-space, so
     * it is refused. Neither path truncates.
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
    // The DEFAULT BRANCHES, stated once: `relevance` and `both` are what an absent option means.
    const sort: SearchSort = opts.sort ?? "relevance";
    const parts: SearchParts = opts.parts ?? "both";

    // BOTH STORES THROUGH THE SEAM: a generated `tsvector` column here, full-text tables joined by
    // `rowid` on the device, and neither spelling parses on the other.
    const d = dialect(ctx.db);
    const where = this.whereSql(d, ctx.accountId, opts.filters ?? {});
    const trgm = await hasTrgm(ctx.db);
    // Typo tolerance where the extension exists; without it the seam's substring degrade, ranked
    // by recency — offline there is no relevance signal left.
    const fuzz = d.search.fuzzy(q, "mail", { trigram: trgm, threshold: FUZZY_THRESHOLD });

    /**
     * EVERY ARM READS ITS OWN INDEX: the word arm is two arms (subject tsv, body tsv), and the
     * SUBSTRING arm is the query as characters inside the subject or the sender — `axa` in
     * `myAXA Portal` or `news@axa.example` — ILIKE over the two columns the trigram GINs serve
     * (`search-setup.ts`); recipients have no index and stay out. The match set is their UNION,
     * never an OR across the body join, which no index serves (a sequential scan on a large
     * mailbox). The fs join is there for the folder filter and is removed when none is given.
     */
    const armFrom = sql`from messages m left join folder_state fs on fs.message_id = m.id`;
    const like = `%${q}%`;
    const arms = [
      ...d.search.lexicalArms(q, armFrom, where),
      ...(substringOpen(q)
        ? [sql`select m.id, m.date ${armFrom} where ${where}
            and (${d.ilike(sql`m.subject`, like)} or ${d.ilike(sql`m.from_address`, like)})`]
        : []),
    ];
    const exactPred = sql`m.id in (select u.id from (${sql.join(arms, sql` union `)}) u)`;
    const rank = fuzz.rank;
    const guessPage = (): SQL => (sort === "relevance"
      ? sql`select m.id ${this.from} where ${where} and ${fuzz.pred}
          order by ${rank} desc, m.date desc nulls last, m.id desc limit ${limit}`
      : this.orderedArm(where, fuzz.pred, sort, limit));
    const exactPage = (): Promise<Page> => (sort === "relevance"
      ? this.fusedPage(ctx, d, arms, limit)
      : this.plainPage(ctx, d, this.orderedArm(where, exactPred, sort, limit), limit));

    let tier: SearchTier;
    let total: number;
    let totalExact = true;
    let facets: Facets | null = null;
    let ids: string[] = [];
    if (parts === "page") {
      /* THE PAGE ALONE, at index speed: no count and no facets on this answer. The tier is read
         off the fused candidates themselves, and `total` is their count — exact only when no arm
         was cut at its K; the caller asks `summary` for the rest. */
      const page = await exactPage();
      tier = showSimilar(page.seen) ? "similar" : "exact";
      const got = tier === "exact" ? page : await this.plainPage(ctx, d, guessPage(), limit);
      ids = got.ids;
      total = got.seen;
      totalExact = !got.cut;
    } else {
      /* THE TIER IS DECIDED BEFORE A ROW IS RANKED: the exact union's count is `total` whenever
         non-zero, and the fuzzy count is paid only on a query the store does not literally
         answer. `showSimilar` holds the floor in one place (`@trafficflow/core/search-rank`). */
      const exactTotal = await this.count(ctx, d, where, exactPred);
      tier = showSimilar(exactTotal) ? "similar" : "exact";
      const matchPred = tier === "exact" ? exactPred : fuzz.pred;
      total = tier === "exact" ? exactTotal : await this.count(ctx, d, where, fuzz.pred);
      facets = await this.facets(ctx, d, where, matchPred);
      if (parts === "both") {
        ids = (tier === "exact" ? await exactPage() : await this.plainPage(ctx, d, guessPage(), limit)).ids;
      }
    }

    /**
     * Re-materialize the hits into canonical MessageDTOs, preserving order; `materializeMessages`
     * re-checks accountId. The BATCH form — 4 statements per page on a `max: 1` pool, never 4 per
     * hit awaited serially, and never fired concurrently (the admin console deadlock's shape).
     */
    const byId = ids.length === 0 ? new Map<string, MessageDTO>() : await materializeMessages(ctx.db, ctx.accountId, ids);
    const items: MessageDTO[] = [];
    for (const id of ids) {
      const dto = byId.get(id);
      if (dto) items.push(dto);
    }
    return { items, facets, total, tier, totalExact, ms: Math.round(performance.now() - started) };
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

  // ── the fused relevance order ────────────────────────────────────────────

  /**
   * RECIPROCAL-RANK FUSION over each arm's TOP K. Every arm is cut at K by the reading order
   * (`messages_account_msg_order_idx`), so it reads its own index and stops — never its whole
   * match set, which for a broad word is most of the mailbox; a row scores `Σ 1 / (RRF_K + r)`
   * over the arms that hold it, recency then id breaking ties. A subject word is in two arms
   * (word and substring), so it leads a body-only hit. `seen` is the fused candidates' count and
   * `cut` says an arm stopped at K, so `seen` is then a lower bound on the match set.
   */
  private async fusedPage(ctx: ServiceContext, d: Dialect, arms: SQL[], limit: number): Promise<Page> {
    const k = Math.max(FUSE_K_MIN, limit * FUSE_K_PER_PAGE);
    const ranked = arms.map((a) => sql`
      select x.id, x.date, row_number() over (order by x.date desc nulls last, x.id desc) as r
      from (${a} order by m.date desc nulls last, m.id desc limit ${k}) x`);
    // The fused rows are aliased `m`, so the order clause is `SQL_RANK_ORDER` spelled as everywhere.
    const rank = sql`m.score`;
    const rows = await d.exec(ctx.db, sql`
      with arms as (${sql.join(ranked, sql` union all `)}),
      fused as (select id, max(date) as date, sum(1.0 / (${sql.raw(String(RRF_K))} + r)) as score from arms group by id)
      select m.id, (select count(*) from fused) as seen, (select max(r) from arms) as deepest
      from fused m
      order by ${rank} desc, m.date desc nulls last, m.id desc
      limit ${limit}`);
    const seen = Number(rows[0]?.[1] ?? 0);
    return { ids: rows.map((r) => String(r[0])), seen, cut: Number(rows[0]?.[2] ?? 0) >= k };
  }

  /** One statement's ids, in its order; `cut` when the page came back full. */
  private async plainPage(ctx: ServiceContext, d: Dialect, statement: SQL, limit: number): Promise<Page> {
    const ids = (await d.exec(ctx.db, statement)).map((r) => String(r[0]));
    return { ids, seen: ids.length, cut: ids.length >= limit };
  }

  // ── the user-chosen orders ────────────────────────────────────────────────

  /**
   * ONE ARM, over the whole match set, ordered by the key the caller asked for. No migration, no
   * new index: every key is an existing column, the `tsv` GINs still carry the MATCH (`where` +
   * `matchPred`, the same predicates `total` and `facets` run over), and the sort happens across
   * the rows that match. THE JOIN IS `left`, DELIBERATELY: `mailbox_id` is NOT NULL, so an inner
   * join is equivalent today — but the invariant worth protecting is that a sort never changes
   * WHICH rows match, only their order; an inner join makes the ordering clause capable of
   * dropping a hit. `nulls last` on the address is the other half. Every order ends in `m.id`, so
   * ties come back in a fixed order rather than reshuffling between calls.
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
    if (f.unread !== undefined) preds.push(sql`m.unread = ${f.unread}`);
    if (f.hasAttachments !== undefined) preds.push(sql`m.has_attachments = ${f.hasAttachments}`);
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
