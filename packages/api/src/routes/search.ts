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
 *
 * ── `?address=` IS A DIFFERENT QUESTION ON THE SAME PATH ───────────────────────────────────
 *
 * `GET /search?address=<addr>&direction=from` answers "every message from this address",
 * newest first, by `lower(from_address)` EQUALITY. It is handled BEFORE `q` is read, and it is
 * not a filter on the text search: `SearchService.search` requires words and answers an empty
 * result without them, so `?address=x` with no `q` would otherwise be a silent empty page —
 * the one shape a caller cannot debug.
 *
 * `direction` is VALIDATED AND NOT COERCED, on `sort`'s rule one paragraph up and for a
 * sharper reason. Two of the three directions cannot be served from an index today (the
 * recipients live in two JSONB columns with no index on either — see
 * `SearchService.searchByAddress`), so the service refuses them **by name** with
 * `search_direction_unsupported`. Defaulting a missing or unknown `direction` to `from` would
 * answer `direction=to` — "mail I sent to this person" — with mail they sent to ME, which is
 * not a partial answer but a different one; and answering it with an empty list would read as
 * "you have never written to them". Absent is refused for the same reason: there is no
 * direction this door can safely assume.
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
