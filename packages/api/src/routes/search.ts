import {
  ADDRESS_DIRECTIONS,
  isAddressSearchDirection,
  SEARCH_PARTS,
  SEARCH_SORTS,
  isSearchParts,
  isSearchSort,
  type AddressSearchOptions,
  type SearchFilters,
  type SearchOptions,
} from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { errorResponse, jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { search } from "./shared.js";
import { pagingNumber } from "../query-bounds.js";

/**
 * Search over the store's search documents, paged by `cursor`; `parts=page` is the fast first
 * answer, `parts=summary` the exact `total`, facets and indexing progress, absent both. `sort` is
 * validated, not coerced: a fallback on a typo hands back a confidently-ordered list not in the
 * order asked (the filters stay lenient because they narrow: a dropped one returns a visible
 * superset). `?address=` is a different question on the same path, handled before `q`; its
 * `direction` is refused by name where an index cannot serve it — defaulting to `from` would
 * answer "mail I sent" with mail they sent to me.
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
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);

      // ── the address arm, ahead of `q` ──────────────────────────────────────────────────
      //
      // `address` present at all selects this arm, whatever else the query string carries: it
      // is a different question, not a narrowing of the text search. A caller that sends both
      // gets the address answer, which is the one it named a value for.
      const address = url.searchParams.get("address");
      if (address !== null) {
        const directionRaw = url.searchParams.get("direction");
        if (!isAddressSearchDirection(directionRaw)) {
          return errorResponse(
            "validation_failed", 400,
            `direction must be one of ${ADDRESS_DIRECTIONS.join(", ")}`,
          );
        }
        const addrLimit = pagingNumber(url.searchParams.get("limit"));
        // The service refuses a direction it cannot serve from an index; that refusal is a
        // `ServiceError` and reaches the client through `withErrorEnvelope` as its own code,
        // never re-spelled here — one refusal, one place, so the desktop door
        // (`apps/sidecar/src/cloud-read.ts` calls the service directly) gets the same answer.
        const addrOpts: AddressSearchOptions = {
          address,
          direction: directionRaw,
          ...(addrLimit !== undefined ? { limit: addrLimit } : {}),
        };
        return jsonResponse(await search(deps).searchByAddress(serviceContext(deps, req), addrOpts));
      }

      const q = url.searchParams.get("q") ?? "";
      const limit = pagingNumber(url.searchParams.get("limit"));

      // Before any work: an order we cannot honour is refused, never quietly re-read as
      // relevance. `null` (absent) falls through to the service's own default.
      const sortRaw = url.searchParams.get("sort");
      if (sortRaw !== null && !isSearchSort(sortRaw)) {
        return errorResponse(
          "validation_failed", 400,
          `sort must be one of ${SEARCH_SORTS.join(", ")}`,
        );
      }

      const filters = filtersOf(url);

      // Spread rather than `sort: sortRaw ?? undefined`: the service's default lives in the
      // service, and an omitted property is the only way to say "I did not ask" under
      // `exactOptionalPropertyTypes`.
      // Refused by name, as `sort` is: an unknown value would silently answer `both`.
      const partsRaw = url.searchParams.get("parts");
      if (partsRaw !== null && !isSearchParts(partsRaw)) {
        return errorResponse("validation_failed", 400, `parts must be one of ${SEARCH_PARTS.join(", ")}`);
      }
      const cursor = url.searchParams.get("cursor");
      const opts: SearchOptions = {
        q, filters, limit,
        ...(sortRaw !== null ? { sort: sortRaw } : {}),
        ...(partsRaw !== null ? { parts: partsRaw } : {}),
        ...(cursor ? { cursor } : {}),
      };
      return jsonResponse(await search(deps).search(serviceContext(deps, req), opts));
    },
  },
];

/** The facet filters a search URL carries. */
function filtersOf(url: URL): SearchFilters {
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
  return filters;
}
