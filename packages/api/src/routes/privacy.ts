import { ServiceError } from "@trafficflow/services/mail";
import { silentLogger } from "@trafficflow/core/mail";
import { serviceContext } from "../context.js";
import { errorResponse, jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { privacy } from "./shared.js";

/**
 * The spy-pixel blocker surface (4 endpoints). `GET /img` is mounted again; its return condition
 * is discharged: the sanitizer rewrites every consented `<img src>` and CSS `url()` through the
 * proxy, asserted on rendered output. Three gates, each watched failing: consent (403 unless the
 * reader pressed "Show images", refused before any fetch — what also keeps
 * `TrackerEventDTO.blocked` honest); the request (ownership of `mid` before a DNS lookup, then
 * `assertPublicHttpUrl` through an injected resolver, redirects re-gated per hop, capped at three
 * under one deadline, a streaming size cap); the response ({@link imageResponse}). `POST
 * /messages/:id/load-remote` flips the opt-in; the tracker feeds are account-scoped.
 */

/**
 * The image types this origin will serve — an allow-list, so a type nobody has thought about is
 * absent by default. The bytes and declared type come from a host the sender chose, served from
 * the origin that holds the session cookie: relay a sender-chosen `text/html` and `/api/img?u=…`
 * is stored XSS on the session origin. `image/svg+xml` is refused — SVG is a document format
 * (`<script>`, `<foreignObject>`) and the one entry a future editor is most tempted to add. No
 * `application/octet-stream` fallback: an unlabelled body under the type browsers most willingly
 * sniff. An image we cannot name is not an image we will serve.
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
 * The bytes, under headers that make them un-navigable and inert. Three, none redundant:
 * `X-Content-Type-Options: nosniff` — the declared type is the only type; without it the
 * allow-list is a suggestion. `Content-Security-Policy: default-src 'none'; sandbox` — what a
 * person who navigates to this url gets: an opaque origin with no scripting (`img-src` in the
 * message frame governs only the subresource load). `Content-Disposition: inline` with no
 * filename — a subresource; the sender does not get to name a file on the reader's disk.
 * `Cache-Control: private` keeps a shared cache from holding one account's image under a url
 * another account could ask for.
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
    relay: true,
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
        /**
         * Every refusal says which arm it was. This catch used to answer and log nothing, so a
         * census of the route's 5xx found `logs[]` empty — the status in the platform's log, the
         * reason nowhere. `code` names the arm (`consent_required`, the cross-account 404, the
         * SSRF refusal, the 415, the transport 424). Deliberately absent: the `u` parameter, the
         * resolved host, and the error message — the sender chose the url, and keeping readers'
         * senders out of our logs is why this proxy exists; the `requestId` ties the line to the
         * request. Level follows the envelope: 4xx warn, 5xx error.
         */
        const log = deps.logger ?? silentLogger;
        if (err instanceof ServiceError) {
          const at = { method: req.method, route: "/img", status: err.httpStatus, code: err.code };
          if (err.httpStatus >= 500) log.error("request_failed", at);
          else log.warn("request_failed", at);
          return errorResponse(err.code, err.httpStatus, err.message, err.details, err.retryable);
        }
        /* The unknown arm keeps the repo-wide event name for "not a refusal, a bug", so the
           two are still distinguishable by name rather than only by status. */
        log.error("request_unhandled", { method: req.method, route: "/img", status: 500, err });
        /**
         * What reaches here is our own fault, and it must stay a 5xx. Tempting to answer 424,
         * since every upstream refusal now sits off the 5xx class — wrong, dangerously: the `try`
         * above encloses the ownership check, the consent read, the grants read and a
         * `tracker_events` insert, so a database outage or a `TypeError` in our own code would
         * take the "somebody else's dependency" label, and the platform's 5xx alerting would
         * ignore a real outage of ours. Transport failures are named where they happen
         * (`makeNodeRemoteFetch` wraps DNS/TLS/reset/timeout as a 424 `ServiceError`), so
         * anything still unknown here is a bug of ours and says so.
         */
        return errorResponse("internal_error", 500, "the image proxy failed unexpectedly");
      }
    },
  },
  {
    method: "POST",
    pattern: "/messages/:id/load-remote",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      await privacy(deps).loadRemote(serviceContext(deps, req), params.id!);
      return jsonResponse({ remoteContent: "loaded" });
    },
  },
  {
    method: "GET",
    pattern: "/messages/:id/tracker-events",
    relay: true,
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
    relay: true,
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
