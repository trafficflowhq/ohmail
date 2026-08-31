/**
 * Opaque list cursors (contract §1.5) — independent from the `/sync` seq cursor.
 * A list cursor encodes the last entity id returned; the next page selects rows
 * with a greater id under a stable ascending-id ordering.
 */
export function encodeListCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export function decodeListCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/**
 * The page ceiling, TOTAL over every double the wire can carry.
 *
 * ── WHY THE ARITHMETIC IS NOT ENOUGH, MEASURED ────────────────────────────────────────────
 *
 * This used to be `Math.min(Math.max(1, limit ?? DEFAULT), MAX)`, which is correct for every
 * number and wrong for the two values that are not numbers in the arithmetic sense. Every
 * caller reaches it from `Number(url.searchParams.get("limit"))`, so the caller chooses the
 * double:
 *
 *  · `?limit=abc` ⇒ `NaN`. `??` does not fire (NaN is not nullish), `Math.max(1, NaN)` is NaN,
 *    `Math.min(NaN, 200)` is NaN — and **drizzle-orm omits the `limit` clause entirely for a
 *    falsy value**, so the query it builds is `select … from …` with NO CEILING. Verified
 *    against drizzle 0.36.4: `.limit(NaN).toSQL()` returns `{sql: 'select "id" from "t"',
 *    params: []}` while `.limit(200)` returns `… limit $1`. It is a query-BUILDER fact, so it
 *    holds identically for an in-process PGlite and for a Postgres server. `?limit=-1e999`
 *    (`-Infinity`) is the same shape.
 *  · `?limit=1.5` ⇒ a fractional param reaches Postgres and raises
 *    `invalid input syntax for type bigint`, a 500 for a plainly bad request. `?limit=1e999`
 *    (`Infinity`) raises the same.
 *
 * The unbounded arm is the one that matters. Every caller then does `rows.slice(0, limit)`,
 * and `slice(0, NaN)` is EMPTY — so the database is asked for the account's entire table, the
 * rows are materialized in the process, and the response is a page of nothing. `getBodies`
 * is the sharp case: its `BODIES_BYTE_BUDGET` is consulted inside that empty loop, so the one
 * guard written to bound that response never runs while the bytes it exists to bound have
 * already been fetched.
 *
 * So the clamp is total: anything that is not a finite number is the DEFAULT (the same answer
 * an absent `limit` gets — the caller named no usable page size), and a finite one is floored
 * into `[1, max]` before it can reach a `bigint` parameter.
 */
export function clampPageLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(1, Math.floor(limit)), max);
}

export function clampLimit(limit: number | undefined): number {
  return clampPageLimit(limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
}
