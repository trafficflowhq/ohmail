/**
 * THE PAGING QUERY SEAM — the shape of a caller-chosen count, decided ONCE.
 *
 * `firstMisshapenParam` does this for path parameters at the same seam and for the same reason:
 * a caller-chosen string reached a query. This is its twin for the query string, and it lives
 * here rather than in each handler because the fix for that class is to total the clamp at the
 * door: a per-route one closes the route it was reported on and leaves its siblings open. It decides SHAPE only; the BAND stays with the service that owns it
 * (`MAX_PAGE_LIMIT`, `BODIES_MAX_LIMIT`, `ADMIN_MAX_PAGE_SIZE`), so no product number moves here.
 */

/**
 * One code per KIND of paging number, because the two kinds have different floors. A `count` is
 * how many rows to answer with and nobody asks for none; a `position` is where to start, and page
 * 0 is the first page. The floors are the whole reason this is a union rather than a flag.
 */
export type QueryBoundKind = "count" | "position";

/**
 * The CLOSED set of paging query parameters this API accepts. `query-bounds-census.test.ts` holds
 * it against the route files: a paging parameter read outside {@link pagingNumber} is red by
 * file and line, and a name that no longer appears is red too.
 */
export const PAGING_QUERY_BOUNDS: readonly { readonly name: string; readonly kind: QueryBoundKind }[] = [
  { name: "limit", kind: "count" },
  { name: "pageSize", kind: "count" },
  { name: "page", kind: "position" },
  { name: "offset", kind: "position" },
];

const FLOOR: Record<QueryBoundKind, number> = { count: 1, position: 0 };

/**
 * A PRESENT-BUT-BLANK value is "I did not ask", not zero. `?limit=` is what a client emits for
 * `?limit=${state ?? ""}`, and `Number("")` is 0 — which every clamp in this repository raises to
 * 1, so the caller got a one-row page that reads as an almost-empty mailbox. `devices.ts` and
 * `sync.ts` carried this rule by hand on three routes out of twenty-one; it is the seam's now.
 */
const asked = (raw: string | null): string | null => {
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
};

/** A plain decimal integer and nothing else: no sign, no exponent, no dot, no `Infinity`. */
const DECIMAL_INTEGER = /^\d+$/;

/**
 * The first paging parameter whose value could never be a page — or `null` when every one is
 * fine. It runs at the single seam every request crosses, BEFORE any handler, so the refusal
 * names the field and the caller can narrow to it instead of receiving a silently defaulted page.
 */
export function firstMisshapenQuery(url: URL): { name: string; message: string } | null {
  for (const { name, kind } of PAGING_QUERY_BOUNDS) {
    const raw = asked(url.searchParams.get(name));
    if (raw === null) continue;
    const floor = FLOOR[kind];
    if (!DECIMAL_INTEGER.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < floor) {
      return { name, message: `${name} must be a whole number of at least ${floor}` };
    }
  }
  return null;
}

/**
 * What a handler does with the value it read. It takes the RAW READ rather than the URL so the
 * `searchParams.get("limit")` call stays where `input-bounds-census.test.ts` looks for it — a
 * census whose needle a refactor quietly removes is the shape this repository has already paid
 * for once. `undefined` means the caller did not ask, absent and blank alike, which is what lets
 * the service apply its own default rather than a zero the clamp raises to one. The shape is
 * already proven at the seam, so this converts and never refuses.
 */
export function pagingNumber(raw: string | null): number | undefined {
  const value = asked(raw);
  return value === null ? undefined : Number(value);
}
