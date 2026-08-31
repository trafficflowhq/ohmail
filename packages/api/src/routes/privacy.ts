import { ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { errorResponse, jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { privacy } from "./shared.js";

/**
 * §5.15 — the spy-pixel blocker surface (privacy, 4 endpoints).
 *
 * ── `GET /img` IS MOUNTED AGAIN, AND THIS IS WHAT DISCHARGED THE CONDITION ─────────
 *
 * It was unmounted once it was found to be a server-side request forgery with body
 * exfiltration: `proxyImage` validated the caller-supplied url with a scheme regex
 * and nothing else, the fetch followed redirects, and the route returned the body, so
 * an authenticated caller could read `169.254.169.254` or any internal service
 * through it.
 *
 * The condition written here for its return was **"it comes back when the blocker is
 * switched on in the reading path, and not before"**, because the endpoint had no
 * consumer and therefore no caller but an attacker. It has one now: the reading
 * surface builds the proxy url, hands it to the message renderer, and the sanitizer
 * rewrites every consented `<img src>` and CSS `url()` through it — asserted on the
 * rendered output, not merely on the existence of a function.
 *
 * Three independent gates stand between a caller and the network, and each is watched
 * failing on its own:
 *
 *  · **Consent**, in `PrivacyService.proxyImage` — 403 unless the reader has actually
 *    pressed "Show images" for this message (`message_bodies.loaded_remote_content`),
 *    refused BEFORE any fetch. Without it the blocker would be a client convention:
 *    the renderer is not a boundary, and a second client or a replayed url would make
 *    the sender's server see a request. It also keeps `TrackerEventDTO.blocked`
 *    (`!loadedRemoteContent`) from reporting an image we fetched as one we blocked, in
 *    the feed whose whole subject is who tried to spy on the reader.
 *  · **The request**, also in `proxyImage` — ownership of `mid` (a
 *    cross-account id is a 404 before a DNS lookup is spent), then
 *    `assertPublicHttpUrl` through an INJECTED resolver: userinfo, odd ports,
 *    `.onion`/`.local` and any host whose literal or RESOLVED address is
 *    loopback/private/link-local/CGNAT (and their IPv4-mapped forms) are refused
 *    before a socket opens. The manual-redirect port is the other half — it never
 *    follows a `Location` itself, so a hop is only ever taken by `proxyImage` AFTER
 *    that url has been through the same gate and pinned to its own addresses (capped
 *    at three hops, under one whole-chain deadline) — plus a streaming size cap.
 *  · **The response**, {@link imageResponse} below. The service's SSRF gate says
 *    nothing about what comes BACK, and what comes back is bytes and a Content-Type
 *    chosen by the sender, served from the origin that holds the session cookie.
 *
 * `POST /messages/:id/load-remote` flips the "load anyway" opt-in (idempotent-safe).
 * `GET /messages/:id/tracker-events` + `GET /tracker-events` are the account-scoped
 * "who tried to spy on you" feeds. Every read/write is account-scoped in the
 * service (cross-account id → 404).
 */

/**
 * THE IMAGE TYPES THIS ORIGIN WILL SERVE. An allow-list, so a type nobody has thought
 * about is absent by default rather than present by default.
 *
 * ── WHY A CONTENT-TYPE ALLOW-LIST IS NOT TIDINESS ─────────────────────────────────
 *
 * The bytes and the declared type both come from a host the SENDER chose, and this
 * route serves them from `ohmail.app` — the origin that holds `tf_session`. Relay a
 * sender-chosen `text/html` and a link to `/api/img?u=…` is stored XSS on the session
 * origin; the SSRF gate cannot see this, because the url it approved was perfectly
 * public.
 *
 * **`image/svg+xml` is REFUSED, not relayed, and it is the whole reason this list is
 * an allow-list.** SVG is a document format: it carries `<script>`, `<foreignObject>`
 * and external references, and a browser navigating to one executes it in this
 * origin. It is also the one entry a future editor would be most tempted to add,
 * because it is unambiguously "an image".
 *
 * There is deliberately **no `application/octet-stream` fallback**. `proxyImage`
 * returns exactly that when the upstream declared nothing, and a fallback would mean
 * an unlabelled body is served under a type the browser is most willing to sniff.
 * An image we cannot name is not an image we will serve.
 */
const PROXIED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/gif", "image/jpeg", "image/png", "image/webp", "image/avif",
  "image/bmp", "image/x-icon", "image/vnd.microsoft.icon", "image/apng",
]);

/** The declared type with its parameters dropped — `image/png; charset=x` is `image/png`. */
function baseType(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

/**
 * The bytes, under headers that make them un-navigable and inert.
 *
 * Three, and none of them is redundant with another:
 *
 *  · `X-Content-Type-Options: nosniff` — the declared type is the ONLY type. Without
 *    it a browser may sniff a `image/png` that is really markup and act on what it
 *    found, which turns the allow-list above into a suggestion.
 *  · `Content-Security-Policy: default-src 'none'; sandbox` — what a person who
 *    NAVIGATES to this url gets. `img-src` in the message frame governs the
 *    subresource load; it says nothing about the top-level document a pasted url
 *    produces, and `sandbox` with no tokens is an opaque origin with no scripting.
 *  · `Content-Disposition: inline` with no filename — this is a subresource, and the
 *    sender does not get to name a file on the reader's disk.
 *
 * `Cache-Control: private` keeps a shared cache from holding one account's image
 * under a url another account could ask for.
 */
function imageResponse(contentType: string, body: Uint8Array): Response {
  const type = baseType(contentType);
  if (!PROXIED_IMAGE_TYPES.has(type)) {
    throw new ServiceError(
      "unsupported_media_type", 415,
      "that url did not answer with an image type this proxy will serve", undefined, false,
    );
  }
  return new Response(toBody(body), {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(body.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=300",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/** `Uint8Array` → a body type every runtime this deploys to accepts. */
function toBody(body: Uint8Array): ArrayBuffer {
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

export const privacyRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/img",
    /**
     * `connection`: it opens a socket to a host the SENDER named and fetches on the
     * reader's behalf. `router.ts`'s `CostClass` already names this route as the third
     * shape of that class and says it carries this cost again if it is ever remounted.
     * It is, and it does.
     */
    cost: "connection",
    /* `raw` for the reason the attachment byte routes are: the response is bytes, not
       the JSON envelope. Still session-gated — RAW_PIPELINE keeps `withSession`, which
       is what makes `mid` an authorisation rather than a parameter. */
    options: { raw: true },
    handler: async (req, deps) => {
      /* `raw` SKIPS THE JSON ERROR ENVELOPE, so this route builds its own — the same
         shape the attachment byte routes use, and for the same reason. Without it a
         refusal (a 404 for a cross-account `mid`, a 400 from the SSRF gate, the 415
         below) escapes the handler as an unhandled throw and the caller gets a 500,
         which reports our own correct refusals as our own bug. */
      try {
        const url = new URL(req.url);
        const target = url.searchParams.get("u") ?? "";
        const messageId = url.searchParams.get("mid") ?? "";
        const { contentType, body } = await privacy(deps).proxyImage(
          serviceContext(deps, req), { messageId, url: target },
        );
        return imageResponse(contentType, body);
      } catch (err) {
        if (err instanceof ServiceError) {
          return errorResponse(err.code, err.httpStatus, err.message, err.details, err.retryable);
        }
        /* ── WHAT REACHES HERE IS OUR OWN FAULT, AND IT MUST STAY A 5xx ──────────────────
           Tempting to answer 424 here, since this slice moved every upstream refusal off the
           5xx class. That would be wrong, and dangerously so: the `try` above encloses the
           ownership check, the consent read, the grants read and a `tracker_events` insert, so
           a database outage or a `TypeError` in our own code would take the same "somebody
           else's dependency" label — and Vercel's 5xx alerting, which the 424 exists to keep
           honest, would then ignore a real ohmail outage. That is this slice's own incident,
           inverted.
           Transport failures are named where they happen instead (`makeNodeRemoteFetch` wraps
           DNS/TLS/reset/timeout as a 424 `ServiceError`), so anything still unknown at this
           point is a bug in ours and says so. */
        return errorResponse("internal_error", 500, "the image proxy failed unexpectedly");
      }
    },
  },
  {
    method: "POST",
    pattern: "/messages/:id/load-remote",
    cost: "work",
    handler: async (req, deps, params) => {
      await privacy(deps).loadRemote(serviceContext(deps, req), params.id!);
      return jsonResponse({ remoteContent: "loaded" });
    },
  },
  {
    method: "GET",
    pattern: "/messages/:id/tracker-events",
    cost: "read",
    handler: async (req, deps, params) => {
      const url = new URL(req.url);
      const page = await privacy(deps).listTrackerEvents(serviceContext(deps, req), {
        messageId: params.id!,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.get("limit") != null ? Number(url.searchParams.get("limit")) : undefined,
      });
      return jsonResponse({ items: page.items });
    },
  },
  {
    method: "GET",
    pattern: "/tracker-events",
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const page = await privacy(deps).listTrackerEvents(serviceContext(deps, req), {
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.get("limit") != null ? Number(url.searchParams.get("limit")) : undefined,
      });
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
];
