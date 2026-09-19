import { serviceContext } from "../context.js";
import { unsubscribeLinkRefusal } from "../probe-host-refusal.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { unsubscribes } from "./shared.js";

/**
 * `POST /messages/:id/unsubscribe`: RFC 8058 one-click, performed by this server. A route, not a
 * browser fetch: the URL belongs to the sender, and a fetch from the reader's tab hands them the
 * reader's IP and the moment they read — the feature backwards; the service's signature makes the
 * client's identity structurally unable to travel. `cost: "connection"`, the honest class: a
 * socket to a caller-influenced host — `GET /img`'s shape — though it returns only a status, so
 * no exfiltration channel even if the SSRF gate were defeated. The URL is never taken from the
 * caller: the body carries nothing; it is read from the message's stored headers. Not
 * `idempotent`-marked: the effect lives at a third party where a replay is not ours to promise.
 */
export const unsubscribeRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/messages/:id/unsubscribe",
    relay: true,
    cost: "connection",
    handler: async (req, deps, params) => {
      try {
        const result = await unsubscribes(deps).unsubscribe(serviceContext(deps, req), params.id!);
        return jsonResponse(result);
      } catch (err) {
        // The SSRF gate's own refusal names `u` — a parameter this route does not have; the URL
        // came out of the sender's stored headers. Re-said at the seam that answers a person,
        // the mailbox connect form's arrangement (`probe-host-refusal.ts`).
        throw unsubscribeLinkRefusal(err);
      }
    },
  },
];
