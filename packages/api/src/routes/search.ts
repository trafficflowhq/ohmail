import {
  ADDRESS_DIRECTIONS,
  isAddressSearchDirection,
  SEARCH_SORTS,
  isSearchSort,
  type AddressSearchOptions,
  type SearchFilters,
  type SearchOptions,
} from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { errorResponse, jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { search } from "./shared.js";

/**
 * Hybrid search: lexical+fuzzy RRF, account-scoped; facets ride query params; an empty `q` yields
 * an empty result. `sort` is validated, not coerced: unknown is a 400, absent means `relevance` —
 * a fallback on a typo hands back a confidently-ordered list not in the order asked (the other
 * params stay lenient because they narrow: a dropped one returns a visible superset). `?address=`
 * is a different question on the same path, handled before `q`. `direction` is validated for a
 * sharper reason: two of the three directions cannot be served from an index today, so the
 * service refuses them by name — defaulting to `from` would answer "mail I sent" with mail they
 * sent to me: a different answer, not a partial one.
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
        const addrLimitRaw = url.searchParams.get("limit");
        // The service refuses a direction it cannot serve from an index; that refusal is a
        // `ServiceError` and reaches the client through `withErrorEnvelope` as its own code,
        // never re-spelled here — one refusal, one place, so the desktop door
        // (`apps/sidecar/src/cloud-read.ts` calls the service directly) gets the same answer.
        const addrOpts: AddressSearchOptions = {
          address,
          direction: directionRaw,
          ...(addrLimitRaw != null ? { limit: Number(addrLimitRaw) } : {}),
        };
        return jsonResponse(await search(deps).searchByAddress(serviceContext(deps, req), addrOpts));
      }

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
