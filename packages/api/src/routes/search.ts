import { SEARCH_SORTS, isSearchSort, type SearchFilters, type SearchOptions } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { errorResponse, jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { search } from "./shared.js";

/**
 * §5.7 — hybrid search. `GET /search?q=…` runs the lexical+fuzzy RRF ranking
 * (SearchService) and returns `{ items, facets, total }`, all accountId-scoped in
 * the service. Facet filters arrive as query params:
 *   folder, sender, unread, hasAttachments, dateFrom, dateTo.
 * An empty/absent `q` yields an empty result (no error). Session-protected (the
 * default pipeline populates `deps.session`; no `public` flag).
 *
 * ── `sort` IS VALIDATED, NOT COERCED ──────────────────────────────────────────────────────
 *
 * `?sort=` takes one of {@link SEARCH_SORTS} and an unknown value is a `400`, while an ABSENT
 * one means `relevance` and is the endpoint's whole prior behaviour. The two are deliberately
 * different: falling back to relevance on a typo'd or stale value would hand back a
 * confidently-ordered list that is not in the order the caller asked for, with nothing on the
 * wire to say so. A client that sends `sort=newest` should learn that today, from a status
 * code — not later, from a user who trusted the list.
 *
 * Every other param on this route is still lenient (`boolParam` drops what it cannot read) and
 * that stays: those NARROW a result set, so a dropped one returns a superset the caller can see
 * for itself. An order cannot be checked by looking at it.
 */

/** "true"/"1" → true, "false"/"0" → false, else undefined (filter omitted). */
function boolParam(v: string | null): boolean | undefined {
  if (v === null) return undefined;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

export const searchRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/search",
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const q = url.searchParams.get("q") ?? "";
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null ? Number(limitRaw) : undefined;

      // Before any work: an order we cannot honour is refused, never quietly re-read as
      // relevance. `null` (absent) falls through to the service's own default.
      const sortRaw = url.searchParams.get("sort");
      if (sortRaw !== null && !isSearchSort(sortRaw)) {
        return errorResponse(
          "validation_failed", 400,
          `sort must be one of ${SEARCH_SORTS.join(", ")}`,
        );
      }

      const filters: SearchFilters = {};
      const folder = url.searchParams.get("folder");
      const sender = url.searchParams.get("sender");
      const dateFrom = url.searchParams.get("dateFrom");
      const dateTo = url.searchParams.get("dateTo");
      const unread = boolParam(url.searchParams.get("unread"));
      const hasAttachments = boolParam(url.searchParams.get("hasAttachments"));
      if (folder) filters.folder = folder;
      if (sender) filters.sender = sender;
      if (dateFrom) filters.dateFrom = dateFrom;
      if (dateTo) filters.dateTo = dateTo;
      if (unread !== undefined) filters.unread = unread;
      if (hasAttachments !== undefined) filters.hasAttachments = hasAttachments;

      // Spread rather than `sort: sortRaw ?? undefined`: the service's default lives in the
      // service, and an omitted property is the only way to say "I did not ask" under
      // `exactOptionalPropertyTypes`.
      const opts: SearchOptions = { q, filters, limit, ...(sortRaw !== null ? { sort: sortRaw } : {}) };
      const result = await search(deps).search(serviceContext(deps, req), opts);
      return jsonResponse(result);
    },
  },
];
