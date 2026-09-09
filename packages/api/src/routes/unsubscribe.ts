import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { unsubscribes } from "./shared.js";

/**
 * `POST /messages/:id/unsubscribe`: RFC 8058 one-click, performed by THIS SERVER.
 *
 * ── WHY IT IS A ROUTE AND NOT A BROWSER FETCH ────────────────────────────────────────────────
 *
 * The unsubscribe URL belongs to the sender. A `fetch` from the reader's tab would hand them the
 * reader's IP and the exact moment they read the message — for a product whose pitch is that the
 * sender learns nothing, that is the whole feature backwards. `UnsubscribeService` holds the
 * outbound port and its signature makes the client's identity structurally unable to travel.
 *
 * ── `cost: "connection"`, WHICH IS THE HONEST CLASS ──────────────────────────────────────────
 *
 * This process opens a socket to a caller-influenced host. That is the same shape as `GET /img`
 * and it carries the same cost class rather than the softer `"work"`, so it is gated for an
 * unverified account and it appears where somebody auditing outbound connections will look.
 * Unlike `GET /img` it returns no upstream bytes at all — only a status — so there is no
 * exfiltration channel even if the SSRF gate were defeated.
 *
 * ── THE URL IS NEVER TAKEN FROM THE CALLER ───────────────────────────────────────────────────
 *
 * The body carries nothing. The only input is the message id in the path, and the URL is read
 * from that message's STORED headers, parsed by `rules.ts#oneClickUnsubscribeUri`. A caller
 * cannot name a host, which is what keeps this from being the server-side request forgery
 * `GET /img` once was.
 *
 * Not `idempotent`-marked: `withIdempotency` replays a stored response, and this route's effect
 * lives at a third party where a replay is not ours to promise. A repeat POST re-sends the same
 * RFC 8058 request, which is exactly what a mail client's own unsubscribe button does.
 */
export const unsubscribeRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/messages/:id/unsubscribe",
    relay: true,
    cost: "connection",
    handler: async (req, deps, params) => {
      const result = await unsubscribes(deps).unsubscribe(serviceContext(deps, req), params.id!);
      return jsonResponse(result);
    },
  },
];
