import { sql, type SQL } from "drizzle-orm";
import type { ServiceContext, Db } from "./context.js";
import { materializeMessages } from "./dto/materialize.js";
import { clampLimit } from "./pagination.js";
import { ServiceError } from "./errors.js";
import type { MessageDTO } from "./dto/types.js";

/**
 * Hybrid search (lexical + fuzzy), the user's top HEY pain point
 * ("search is not fast/optimal/smart"). ONE fused SQL ranking over TWO
 * arms:
 *   • lexical — `websearch_to_tsquery('english', q)` against the DB-generated
 *     `subject_tsv` (subject+from) and `body_tsv` (redacted body), ranked by
 *     `ts_rank`. Core Postgres, present in PGlite too.
 *   • fuzzy   — pg_trgm `word_similarity(q, subject|from_address)` so a TYPO
 *     ("invoce" → "Invoice") still surfaces the right message a pure tsvector
 *     match MISSES. When pg_trgm is absent (PGlite), this arm DEGRADES to an
 *     ILIKE-contains so the service still works offline.
 * The arms are fused by Reciprocal-Rank Fusion in SQL — per-arm `row_number()`
 * over a bounded top-N window, fused score `sum(1/(k+rank))` — leaving room for a
 * third SEMANTIC (pgvector) arm to slot in later (deferred: needs an
 * EU-resident embedding source + a pgvector-capable image).
 *
 * Sensitivity: search runs ONLY over subject / from_address / the STORED
 * `message_bodies.text` (already redacted when sensitive) — it never re-derives a
 * secret and joins no raw-secret source. Everything is accountId-scoped.
 */

/** RRF constant (standard k=60): dampens the contribution of lower-ranked hits. */
const RRF_K = 60;
/** Per-arm candidate window — RRF fuses BOUNDED candidate lists. */
const ARM_LIMIT = 100;
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
  total: number;
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
  };
}

// pg_trgm presence is a property of the physical database, not the request; memoize
// per Db handle so we probe `to_regprocedure` at most once per connection object.
const trgmCache = new WeakMap<object, Promise<boolean>>();
function hasTrgm(db: Db): Promise<boolean> {
  const key = db as unknown as object;
  let p = trgmCache.get(key);
  if (!p) {
    p = db.execute(sql`select to_regprocedure('word_similarity(text,text)') is not null as ok`)
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
    const q = (opts.q ?? "").trim();
    if (!q) return emptyResult();
    const limit = clampLimit(opts.limit);
    // The DEFAULT BRANCH, stated once. An absent `sort` is `relevance` and takes the fused
    // query below with nothing changed — see the `hitQuery` ternary.
    const sort: SearchSort = opts.sort ?? "relevance";

    // ── shared predicates ──────────────────────────────────────────────────
    const where = this.whereSql(ctx.accountId, opts.filters ?? {});
    const tsq = sql`websearch_to_tsquery('english', ${q})`;
    const lexPred = sql`(m.subject_tsv @@ ${tsq} or b.body_tsv @@ ${tsq})`;

    const trgm = await hasTrgm(ctx.db);
    const like = `%${q}%`;
    // Fuzzy arm: pg_trgm word_similarity (typo-tolerant) or the offline ILIKE degrade.
    const fuzzPred = trgm
      ? sql`(word_similarity(${q}, m.subject) >= ${FUZZY_THRESHOLD} or word_similarity(${q}, m.from_address) >= ${FUZZY_THRESHOLD})`
      : sql`(m.subject ilike ${like} or m.from_address ilike ${like})`;
    const fuzzRank = trgm
      ? sql`greatest(word_similarity(${q}, m.subject), word_similarity(${q}, m.from_address))`
      : sql`coalesce(extract(epoch from m.date), 0)`;   // no relevance signal offline → recency
    const lexRank = sql`greatest(ts_rank(m.subject_tsv, ${tsq}), ts_rank(coalesce(b.body_tsv, to_tsvector('')), ${tsq}))`;

    // ── ONE fused ranking query ─────────────────────────────────────
    // Each arm produces a BOUNDED top-N candidate list; per-arm row_number() feeds
    // RRF (sum of 1/(k+rank)); a message ranked by BOTH arms accumulates both terms.
    const matchPred = sql`(${lexPred} or ${fuzzPred})`;
    const fusion = sql`
      with lex as (
        select m.id, ${lexRank} as rank
        ${this.from}
        where ${where} and ${lexPred}
        order by rank desc
        limit ${ARM_LIMIT}
      ),
      fuz as (
        select m.id, ${fuzzRank} as rank
        ${this.from}
        where ${where} and ${fuzzPred}
        order by rank desc
        limit ${ARM_LIMIT}
      ),
      ranked as (
        select id, row_number() over (order by rank desc) as rn from lex
        union all
        select id, row_number() over (order by rank desc) as rn from fuz
      ),
      fused as (
        select id, sum(1.0 / (${RRF_K} + rn)) as score
        from ranked group by id
      )
      select f.id
      from fused f
      join messages m on m.id = f.id
      order by f.score desc, m.date desc nulls last
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
     * So a non-relevance sort runs its own arm over the SAME predicates (`where` + `matchPred`,
     * the identical match set facets and total are counted over) with no candidate window at
     * all — the sort key decides which `limit` rows come back. `search-sort.r12.test.ts` plants
     * a low-relevance newest match and watches this exact difference.
     */
    const hitQuery = sort === "relevance" ? fusion : this.orderedArm(where, matchPred, sort, limit);
    const hitRows = rowsOf<{ id: string }>(await ctx.db.execute(hitQuery));

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

    const facets = await this.facets(ctx, where, matchPred);
    const total = await this.total(ctx, where, matchPred);
    return { items, facets, total };
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

  private async total(ctx: ServiceContext, where: SQL, matchPred: SQL): Promise<number> {
    const r = await ctx.db.execute(sql`select count(*)::int as n ${this.from} where ${where} and ${matchPred}`);
    return rowsOf<{ n: number }>(r)[0]?.n ?? 0;
  }

  private async facets(ctx: ServiceContext, where: SQL, matchPred: SQL): Promise<Facets> {
    const now = ctx.now();
    const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
    // Bind timestamp bounds as ISO strings with an explicit ::timestamptz cast:
    // postgres-js will not serialize a bare Date through drizzle's raw `sql`.
    const today = todayStart.toISOString();
    const d7 = new Date(todayStart.getTime() - 7 * 86_400_000).toISOString();
    const d30 = new Date(todayStart.getTime() - 30 * 86_400_000).toISOString();

    // Scalars (unread / hasAttachments / recency buckets) in one aggregate pass.
    const scalarSql = sql`
      select
        count(*) filter (where m.unread)::int as unread_t,
        count(*) filter (where not m.unread)::int as unread_f,
        count(*) filter (where m.has_attachments)::int as att_t,
        count(*) filter (where not m.has_attachments)::int as att_f,
        count(*) filter (where m.date >= ${today}::timestamptz)::int as d_today,
        count(*) filter (where m.date >= ${d7}::timestamptz and m.date < ${today}::timestamptz)::int as d_7,
        count(*) filter (where m.date >= ${d30}::timestamptz and m.date < ${d7}::timestamptz)::int as d_30,
        count(*) filter (where m.date is null or m.date < ${d30}::timestamptz)::int as d_older
      ${this.from}
      where ${where} and ${matchPred}`;

    const folderSql = sql`
      select ${this.folderExpr} as folder, count(*)::int as c
      ${this.from}
      where ${where} and ${matchPred}
      group by 1`;

    const senderSql = sql`
      select m.from_address as address, count(*)::int as c
      ${this.from}
      where ${where} and ${matchPred}
      group by 1
      order by c desc, address asc
      limit ${SENDER_FACET_LIMIT}`;

    const [scalarR, folderR, senderR] = await Promise.all([
      ctx.db.execute(scalarSql),
      ctx.db.execute(folderSql),
      ctx.db.execute(senderSql),
    ]);

    const s = rowsOf<Record<string, number>>(scalarR)[0] ?? {};
    const folder: Record<string, number> = {};
    for (const row of rowsOf<{ folder: string; c: number }>(folderR)) folder[row.folder] = row.c;

    return {
      folder,
      sender: rowsOf<{ address: string; c: number }>(senderR).map((r) => ({ address: r.address, count: r.c })),
      unread: { true: s.unread_t ?? 0, false: s.unread_f ?? 0 },
      hasAttachments: { true: s.att_t ?? 0, false: s.att_f ?? 0 },
      date: { today: s.d_today ?? 0, last7: s.d_7 ?? 0, last30: s.d_30 ?? 0, older: s.d_older ?? 0 },
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

  private whereSql(accountId: string, f: SearchFilters): SQL {
    // `deleted_at is null` unconditionally (mail 0065): search is a living view, and a deleted
    // or fully-expunged message must not come back as a hit over its stored (husked) headers.
    const preds: SQL[] = [sql`m.account_id = ${accountId}`, sql`m.deleted_at is null`];
    if (f.folder !== undefined) preds.push(sql`${this.folderExpr} = ${f.folder}`);
    if (f.sender !== undefined) preds.push(sql`lower(m.from_address) = lower(${f.sender})`);
    if (f.unread !== undefined) preds.push(sql`m.unread = ${f.unread}`);
    if (f.hasAttachments !== undefined) preds.push(sql`m.has_attachments = ${f.hasAttachments}`);
    if (f.dateFrom !== undefined) {
      preds.push(sql`m.date >= ${SearchService.instantOr400(f.dateFrom, "dateFrom")}::timestamptz`);
    }
    if (f.dateTo !== undefined) {
      preds.push(sql`m.date <= ${SearchService.instantOr400(f.dateTo, "dateTo")}::timestamptz`);
    }
    return sql.join(preds, sql` and `);
  }
}

export const searchService = new SearchService();
