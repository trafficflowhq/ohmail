import { and, desc, eq, lt, or } from "drizzle-orm";
import { accountSettings, messages, messageBodies, trackerEvents, type Tx } from "@trafficflow/db";
import { hostOf, isKnownTracker, isBeaconUrl } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { requireUuid } from "./ids.js";
import { clampLimit, decodeListCursor, encodeListCursor } from "./pagination.js";
import { assertPublicHttpUrl, type HostResolver } from "./ssrf-guard.js";
import { pinnedHttpRequest } from "./pinned-fetch.js";
import type { Page, TrackerEventDTO } from "./dto/types.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/**
 * The INJECTED server-side fetch port (mirrors ClassifierPort). Its signature takes the url and a
 * `pin` — the validated address(es) the socket must connect to — and NOTHING ELSE: no request
 * object, no headers bag. That absence is still the STRUCTURAL guarantee that the reader's IP /
 * cookies / referer can never be forwarded to the sender, because there is no parameter through
 * which a client header could travel. Tests pass a mock; production passes {@link nodeRemoteFetch}.
 *
 * ── WHY `pin` IS A SECOND PARAMETER AND NOT A WIDENING ────────────────────────────────────────
 *
 * `pin` is not client-supplied data — it is the output of {@link assertPublicHttpUrl}, the
 * addresses that gate already resolved and cleared. It is here so the port connects to a
 * PRE-VALIDATED address instead of re-resolving the hostname, which is the DNS-rebinding hole the
 * gate could not close on its own (validate here, re-resolve inside `fetch`, land on
 * `169.254.169.254`). The SNI and `Host` header still carry the hostname; only the packets'
 * destination is pinned. See `pinned-fetch.ts`.
 */
export interface RemoteFetch {
  fetch(url: string, pin: readonly string[], opts?: {
    /**
     * An upper bound on THIS fetch, so a caller following a redirect chain can hand down the
     * time the chain has left. Not caller data — it is the proxy's own budget — so it does not
     * weaken the "no headers bag" guarantee above.
     */
    timeoutMs?: number;
  }): Promise<{
    status: number; contentType: string | null; body: Uint8Array;
    /**
     * The raw `Location` header when `status` is a 3xx, so the caller can validate the hop
     * and follow it. Optional because the port used to drop it: a 3xx was a dead end, and a
     * header nobody could act on was not worth returning.
     */
    location?: string | null;
  }>;
}

/**
 * How many redirects one proxied image may take before we stop.
 *
 * Three covers every shape measured in real mail — `http`→`https`, apex→`www`, brand→CDN,
 * and the two of those that chain — while keeping a redirect loop from becoming an amplifier
 * aimed at us by anyone who can put an `<img>` in an email.
 */
const MAX_REDIRECT_HOPS = 3;

/**
 * The wall-clock budget for a whole redirect chain, checked before each hop after the first.
 * Deliberately close to one hop's own timeout (`REMOTE_TIMEOUT_MS`, 8 s): a chain that has
 * already spent that long is not a picture arriving slowly, it is a chain being used to hold
 * our socket open.
 */
const REDIRECT_CHAIN_BUDGET_MS = 10_000;

/**
 * ── THE STATUS WE SERVE WHEN SOMEBODY ELSE'S SERVER FAILS, AND WHY IT IS NOT 5xx ─────────
 *
 * This was **502**, and that one digit is the difference between an alarm worth reading and
 * an alarm nobody reads. Hosting platforms alert on a route's 5xx rate, and this route is
 * served by a catch-all (`/[[...path]]`), so every refused image is counted against *the
 * whole API*. A burst of 5xx here therefore reads as "the API is failing" when what actually
 * happened is that a sender's image host answered with a redirect.
 *
 * A 5xx is a claim that OUR server failed. Here our server did exactly what it was built to
 * do: it validated a url, fetched it, and found the answer unusable. The failure is the
 * dependency's. Reporting it as ours has two costs and no benefit — it burns the error
 * budget on other people's uptime, and it trains everyone to ignore the one alarm that is
 * supposed to mean "ohmail is broken". Measured over one week before this changed, three
 * quarters of every 5xx the API served came from this single route relaying other people's
 * failures.
 *
 * **424 Failed Dependency** says the true thing: the request failed because a resource it
 * depended on failed. It is a 4xx, so monitoring stops attributing it to us; it is not 404
 * (the message and the url are real) and not 400 (the caller's request was well-formed);
 * and no browser treats it differently from any other non-2xx for an `<img>`, which is the
 * only consumer that renders it.
 *
 * **This is deliberately NOT a soft-fail to a placeholder image.** Serving a 200 with a
 * transparent pixel would make the alarm quiet and the tracker feed dishonest — a fetch that
 * failed would be indistinguishable from a beacon we refused, in the one feature whose whole
 * subject is telling the reader which is which.
 */
const UPSTREAM_STATUS = 424;

/**
 * Settle `p`, or reject with an upstream refusal once `ms` has passed.
 *
 * Used to put the SSRF gate's DNS lookup under the same clock as the fetch. It does not CANCEL
 * the underlying work — the gate takes no signal — but it releases the request, which is what
 * the deadline is for: the caller stops waiting and the invocation ends.
 */
async function withDeadline<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ServiceError("upstream_failed", UPSTREAM_STATUS, why, undefined, false)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Is this the network failing, or is it us?
 *
 * Transport failures carry a `code` (`ECONNRESET`, `ENOTFOUND`, `ECONNREFUSED`, `EAI_AGAIN`,
 * TLS `CERT_*`, …) or arrive as the `AbortError` a timeout raises. A `TypeError` from our own
 * code has neither, and must NOT be dressed up as somebody else's outage — that is precisely
 * how a real fault becomes invisible to 5xx alerting.
 */
export function isTransportFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; name?: unknown };
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  if (typeof e.code !== "string") return false;
  // AN ALLOW-LIST, not "has a code". Node gives PROGRAMMING faults string codes too —
  // `ERR_INVALID_ARG_TYPE`, `ERR_OUT_OF_RANGE`, `ERR_ASSERTION` — so "any string code" would
  // put a bug of ours back into the upstream class and hide it from 5xx alerting, which is the
  // whole failure this predicate exists to prevent. A code nobody has classified is OURS until
  // someone says otherwise: absent by default rather than present by default, exactly as the
  // content-type allow-list on the route is.
  return TRANSPORT_ERROR_CODES.has(e.code) || /^(CERT_|ERR_TLS_|ERR_SSL_)/.test(e.code);
}

/** Socket- and DNS-level failures. TLS is matched by prefix above rather than enumerated. */
const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
  "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EPIPE", "EADDRNOTAVAIL", "EHOSTDOWN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "ERR_SOCKET_CONNECTION_TIMEOUT",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export interface PrivacyServiceDeps {
  remote: RemoteFetch;
  /**
   * The SSRF gate's DNS port. **Required — there is no default**, because a
   * defaulted `node:dns` in a DNS-blocked sandbox would make every test take the
   * refuse branch and ship the permit branch unexecuted. See {@link HostResolver}.
   */
  resolver: HostResolver;
  /**
   * The whole-chain redirect deadline, overridable for the reason `makeNodeRemoteFetch` takes
   * its own limits as parameters: **a limit nobody has seen trip is not evidence that it
   * trips**, and a test that had to wait out the production value would either be slow or
   * would assert the constant instead of the behaviour. Defaults to
   * {@link REDIRECT_CHAIN_BUDGET_MS}.
   */
  redirectBudgetMs?: number;
}

export interface ProxyImageInput {
  messageId: string;
  url: string;
}

export interface ProxyImageResult {
  contentType: string;
  body: Uint8Array;
}

// A 1×1 fully-transparent GIF — served in place of a detected tracking pixel so
// the reader's client renders nothing and the sender's chosen bytes are never
// relayed onward. 43 bytes.
const TRANSPARENT_GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
  0x44, 0x01, 0x00, 0x3b,
]);

const DAY_MS = 24 * 60 * 60 * 1000;

/** GIF/PNG intrinsic dimensions from the leading bytes, or null if unknown. */
function imageDimensions(body: Uint8Array): { w: number; h: number } | null {
  // GIF: "GIF87a"/"GIF89a", logical screen width/height at bytes 6..9 (LE).
  if (body.length >= 10 && body[0] === 0x47 && body[1] === 0x49 && body[2] === 0x46) {
    return { w: body[6]! | (body[7]! << 8), h: body[8]! | (body[9]! << 8) };
  }
  // PNG: \x89PNG\r\n\x1a\n then IHDR; width bytes 16..19, height 20..23 (BE).
  if (
    body.length >= 24 &&
    body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47
  ) {
    const be = (o: number): number =>
      (body[o]! << 24) | (body[o + 1]! << 16) | (body[o + 2]! << 8) | body[o + 3]!;
    return { w: be(16) >>> 0, h: be(20) >>> 0 };
  }
  return null;
}

/**
 * PrivacyService — the spy-pixel blocker.
 *
 * `proxyImage` is the heart: it fetches a remote image SERVER-SIDE through the
 * injected {@link RemoteFetch} (whose url-only signature is why the reader's IP is
 * never leaked), then — when the fetched bytes are a 1×1 pixel OR the url/host is a
 * known tracker/beacon — records a `tracker_events` row and returns a transparent
 * stub (for pixels) or the fetched bytes (for non-pixel remote images). Every
 * method is account-scoped: a cross-account message id is a 404 (IDOR).
 */
export class PrivacyService {
  constructor(private readonly deps: PrivacyServiceDeps) {}

  async proxyImage(ctx: ServiceContext, input: ProxyImageInput): Promise<ProxyImageResult> {
    const { messageId, url } = input;
    // LENGTH FIRST — `.length` is O(1) and every step after this is not. See
    // {@link PROXY_URL_MAX_CHARS}: the value is sender-chosen, it reaches `new URL()`, the SSRF
    // gate's resolution, a DNS lookup and an outbound fetch, and nothing bounded it. The request
    // door does not: it bounds a request BODY and this is a GET query string.
    if (url.length > PROXY_URL_MAX_CHARS) {
      throw new ServiceError(
        "validation_failed", 400,
        `u is ${url.length} characters; the limit is ${PROXY_URL_MAX_CHARS}`,
      );
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new ServiceError("validation_failed", 400, "u must be an http(s) url");
    }
    // Ownership BEFORE the SSRF gate, so an unauthorised caller cannot make us
    // spend a DNS lookup on a name of their choosing. Cheap syntactic refusals
    // (the scheme test above) stay in front of both.
    await this.requireOwnedMessage(ctx, messageId);

    /**
     * ── AUTHORIZATION IS ENFORCED HERE, OR IT IS NOT ENFORCED AT ALL ─────────────
     *
     * Two grants, either one sufficient, both SERVER facts:
     *
     *   · the reader pressed "Show images" for THIS message
     *     (`message_bodies.loaded_remote_content` — `POST /messages/:id/load-remote`);
     *   · the ACCOUNT loads images automatically (mail 0048:
     *     `account_settings.block_remote_images_at` NULL, and an absent row IS the
     *     default — every account that never changed anything is on auto).
     *
     * The second grant is what makes the product default WORK at this boundary. The
     * client's auto mode points every image at this route without a per-message
     * press, and a gate that only knew the press answered 403 to all of it — the
     * shipped default was authorized nowhere server-side. The account column is a
     * server fact exactly like the flag: an opted-out account's urls are refused
     * here whatever a client claims, and nothing that reaches this route — a second
     * client, a replayed url, a bug in the renderer's `pixel` branch — can make the
     * sender's server see a request the account's own settings forbid.
     *
     * It also keeps the tracker feed honest: `TrackerEventDTO.blocked` derives from
     * these same two facts (see {@link listTrackerEvents}), so an image fetched
     * under either grant is never reported to the user as "blocked" in the very
     * feed whose subject is who tried to spy on them.
     *
     * 403 and not 404: the message is real and the caller owns it, and pretending
     * otherwise would make a legitimate client's bug indistinguishable from an
     * IDOR. `retryable: false` — no amount of retrying changes it; the client's
     * remedy is `POST /messages/:id/load-remote`, which is a user action.
     */
    const [body] = await ctx.db
      .select({ loaded: messageBodies.loadedRemoteContent })
      .from(messageBodies)
      .where(eq(messageBodies.messageId, messageId))
      .limit(1);
    const grants = await this.imageGrants(ctx);
    if (body?.loaded !== true && !grants.auto) {
      throw new ServiceError(
        "remote_content_not_loaded", 403,
        "remote content for this message has not been loaded by the reader",
        undefined, false,
      );
    }

    /**
     * ── THE PIXEL PREFERENCE IS ENFORCED BEFORE THE FETCH, FOR THE TRACKERS THE SERVER
     *    KNOWS ─────────────────────────────────────────────────────────────────────────
     *
     * The client's own pixel refusal reads the message (declared 1×1s, beacon-shaped
     * urls) and cannot know this list; a tracker url that declares no dimensions and
     * wears no beacon path — an ESP's click/open host serving `r/abc.jpg` — sails past
     * it and arrives here as "a picture". Classifying it AFTER `remote.fetch`, which is
     * what this method used to do with the knowledge, refuses the caller the bytes and
     * has already told the sender about the open — the one event "Block tracking pixels"
     * exists to prevent, defeated for exactly the trackers we can name in advance.
     *
     * So a server-known tracker host or beacon-shaped url is refused the FETCH itself
     * while the account's pixel switch stands (mail 0072), whatever the images grant
     * says. The reader is handed the same transparent stub a fetched 1×1 gets — the
     * client believed this was a picture, and a broken glyph would punish the reader
     * for the sender's tracker — and the event is recorded so the feed can say who
     * tried. An account that turned the switch OFF takes the fetch branch below,
     * exactly as it asked to.
     *
     * The post-fetch dimension check stays: it is the half of the classification that
     * needs the bytes (an unknown host's undeclared 1×1), and by then the open has been
     * reported only for senders NO list could have named — the honest limit of the
     * feature, which the switch's copy states.
     */
    const host = hostOf(url);
    const trackerByUrl = isKnownTracker(host) || isBeaconUrl(url);
    if (trackerByUrl && !grants.pixels) {
      await asTx(ctx).insert(trackerEvents).values({
        accountId: ctx.accountId,
        messageId,
        kind: isBeaconUrl(url) ? "pixel" : "remote_image",
        trackerHost: host || null,
        url,
        detectedAt: ctx.now(),
      });
      return { contentType: "image/gif", body: TRANSPARENT_GIF };
    }

    // The SSRF gate. Refuses userinfo, odd ports, `.onion`/`.local`, and any
    // host whose LITERAL or RESOLVED address is loopback/private/link-local/CGNAT
    // (and their IPv4-mapped forms). Throws before a socket is opened; the
    // `redirect: "manual"` in nodeRemoteFetch is the other half, since this can
    // only speak about the url it was given. It RETURNS the validated addresses,
    // and pinning the fetch to them is what closes the DNS-rebind window — without
    // the pin the port would re-resolve the name and a rebinding server could send
    // the second lookup to a private address.
    /**
     * ── A REDIRECT IS A HOP THROUGH THE GATE AGAIN, NOT A REFUSAL ────────────────────────
     *
     * This loop used to be a single fetch, and a 3xx was a hard refusal — the reasoning
     * being that the `Location` names a url the gate never saw. That reasoning is right
     * about the DANGER and wrong about the REMEDY: the answer to "nobody validated this
     * url" is to validate it, which is the same gate, unchanged, run again.
     *
     * **What the refusal cost, measured against real mail.** Every remote image in an
     * ordinary inbox failed this way. `services.google.com` serves a plain `http://` url
     * that 301s to `https://`; `gstatic.com` 301s from the apex to `www.`; `slack.com` 302s
     * to `a.slack-edge.com`; `www.facebook.com/ads/image` 302s to `fbcdn.net`. Those four
     * shapes — scheme canonicalisation, apex-to-www, brand-to-CDN, id-to-CDN — are how
     * ordinary marketing mail serves ordinary pictures. Refusing them did not block a single
     * tracker; it blocked the pictures and left the trackers working, because a beacon points
     * straight at its own host and needs no redirect.
     *
     * **The safety property is preserved exactly, because it is enforced per hop.** Every
     * url this function connects to has passed {@link assertPublicHttpUrl} and is fetched
     * PINNED to the addresses that gate resolved. Hop 2 is not trusted more than hop 1: it
     * is refused for userinfo, odd ports, `.onion`/`.local` and any literal-or-resolved
     * private address exactly as hop 1 is, and the DNS-rebinding window stays closed
     * because the new pin comes from the new validation rather than from a re-resolve.
     *
     * Three further conditions, each load-bearing:
     *
     *  · **The scheme is re-checked.** `assertPublicHttpUrl` is an http(s) gate, but a
     *    `Location: file:///etc/passwd` or `gopher://` must be refused as a MALFORMED hop
     *    rather than reach it, so the same `^https?://` test the caller-supplied url gets is
     *    applied to every `Location` after it is resolved against its base.
     *  · **The tracker classification runs on every hop.** Without this, a redirect is a
     *    clean bypass of the pixel switch: point at an innocuous host, 302 to the beacon,
     *    and the gate that refuses known trackers pre-fetch never sees the tracker. The
     *    per-hop check makes the redirect chain no weaker than a direct url.
     *  · **The hop count is capped.** A redirect loop is otherwise an amplifier pointed at
     *    us by anyone who can put an `<img>` in an email.
     */
    let currentUrl = url;
    let currentHost = host;
    let sawTracker = trackerByUrl;
    /* The host that CLASSIFIED as a tracker, which is not always the host the chain ends on.
       `ct.sendgrid.net` redirecting to `cdn.example.com` is a sendgrid beacon; recording the
       CDN would name the wrong party in the one feed whose entire subject is who tried to
       spy on the reader. Set once, at the hop that tripped the classifier. */
    let trackerHost = trackerByUrl ? host : null;
    /* The URL that tripped the classifier, kept with its host for the same reason: the schema
       documents `tracker_events.url` as the remote url that was classified, and storing the
       host of one hop beside the url of another would make the row describe two parties. */
    let trackerUrl = trackerByUrl ? url : null;
    let fetched: Awaited<ReturnType<RemoteFetch["fetch"]>> | undefined;

    /**
     * A deadline for the WHOLE chain, not just for each hop.
     *
     * The hop cap bounds how many REQUESTS we make; it does not bound how long we hold the
     * socket. The port's timeout is per-fetch, so a four-fetch chain of servers that each
     * stall just under it holds a serverless invocation for four times the intended budget —
     * a 4× amplification that the hop cap alone does not touch, handed to anyone who can put
     * an `<img>` in an email. Checking elapsed time before STARTING another hop bounds the
     * whole operation at roughly this budget plus one hop's timeout.
     */
    const startedAt = Date.now();

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const budget = this.deps.redirectBudgetMs ?? REDIRECT_CHAIN_BUDGET_MS;
      const remaining = budget - (Date.now() - startedAt);
      if (hop > 0 && remaining <= 0) {
        throw new ServiceError(
          "upstream_failed", UPSTREAM_STATUS, "remote image took too long to redirect", undefined, false,
        );
      }

      /* THE LOOKUP IS INSIDE THE DEADLINE TOO, and it is the half that was missed first time.
         Handing the remaining budget to the fetch bounds the SOCKET; it says nothing about
         `assertPublicHttpUrl`, which resolves the hostname before any socket exists. A sender
         who redirects to a fresh name whose DNS simply never answers could therefore hold the
         invocation open indefinitely — no SSRF, but a resource-exhaustion primitive handed to
         anyone who can put an `<img>` in an email, and invisible to a test whose resolver
         answers instantly. `withDeadline` covers the gate as well as the fetch. */
      const pin = await withDeadline(
        assertPublicHttpUrl(currentUrl, this.deps.resolver),
        Math.max(1, remaining),
        "remote image host took too long to resolve",
      );

      // Fetch server-side, connected ONLY to the pinned address. The port takes the
      // url and the pin → no client header can ride along, and no second DNS lookup
      // can undo the gate. The sender sees OUR request, never the reader's.
      /* RE-READ THE CLOCK. `remaining` above was measured BEFORE the gate, and the gate does
         DNS — so handing that stale number to the fetch grants the socket a budget that was
         already spent on the lookup. A name that resolves just inside the deadline would then
         get a whole fresh timeout of its own, and DNS-plus-fetch could run to nearly twice the
         chain budget. One clock, read at each point it is used. */
      const leftForFetch = budget - (Date.now() - startedAt);
      if (leftForFetch <= 0) {
        throw new ServiceError(
          "upstream_failed", UPSTREAM_STATUS, "remote image took too long to redirect", undefined, false,
        );
      }
      fetched = await this.deps.remote.fetch(currentUrl, pin, { timeoutMs: leftForFetch });

      if (fetched.status < 300 || fetched.status >= 400) break;

      if (hop === MAX_REDIRECT_HOPS) {
        throw new ServiceError(
          "upstream_failed", UPSTREAM_STATUS,
          `remote image redirected more than ${MAX_REDIRECT_HOPS} times`, undefined, false,
        );
      }

      const location = fetched.location ?? null;
      if (!location) {
        throw new ServiceError(
          "upstream_failed", UPSTREAM_STATUS,
          `remote image responded ${fetched.status} with no Location`, undefined, false,
        );
      }
      // THE SAME CEILING ON EVERY HOP, because a redirect target is the same kind of value
      // arriving from a different party — and the one the caller never saw. Bounding only the
      // entry url would leave the chain able to grow one, which is the shape of a bound that
      // stops at the first door. See {@link PROXY_URL_MAX_CHARS}.
      if (location.length > PROXY_URL_MAX_CHARS) {
        throw new ServiceError(
          "upstream_failed", UPSTREAM_STATUS,
          "remote image redirected to an over-long url", undefined, false,
        );
      }

      // Resolved against the url that produced it, so a relative `Location: /img/x.png`
      // — which is legal and common — is a hop rather than a parse failure.
      let next: string;
      try {
        next = new URL(location, currentUrl).toString();
      } catch {
        throw new ServiceError(
          "upstream_failed", UPSTREAM_STATUS, "remote image redirected to an unparseable url", undefined, false,
        );
      }
      if (next.length > PROXY_URL_MAX_CHARS) {
        // The RESOLVED url too: a short relative `Location` against a long base is a long url.
        throw new ServiceError(
          "upstream_failed", UPSTREAM_STATUS, "remote image redirected to an over-long url", undefined, false,
        );
      }
      if (!/^https?:\/\//i.test(next)) {
        throw new ServiceError(
          "upstream_failed", UPSTREAM_STATUS, "remote image redirected to a non-http(s) url", undefined, false,
        );
      }

      currentUrl = next;
      currentHost = hostOf(next);
      // The pixel switch applies to where the chain LANDS, not only to where it started.
      if (isKnownTracker(currentHost) || isBeaconUrl(next)) {
        sawTracker = true;
        trackerHost ??= currentHost;
        trackerUrl ??= next;
        if (!grants.pixels) {
          await asTx(ctx).insert(trackerEvents).values({
            accountId: ctx.accountId,
            messageId,
            kind: isBeaconUrl(next) ? "pixel" : "remote_image",
            trackerHost: trackerHost || null,
            url: trackerUrl ?? next,
            detectedAt: ctx.now(),
          });
          return { contentType: "image/gif", body: TRANSPARENT_GIF };
        }
      }
    }

    /* istanbul ignore next — the loop always assigns before it exits. */
    if (!fetched) throw new ServiceError("upstream_failed", UPSTREAM_STATUS, "remote image was never fetched");

    // Any remaining non-2xx is an upstream failure whose body is not an image and must not
    // be relayed as one. See {@link UPSTREAM_STATUS} for why this is not a 5xx.
    if (fetched.status < 200 || fetched.status >= 300) {
      throw new ServiceError(
        "upstream_failed", UPSTREAM_STATUS,
        `remote image responded ${fetched.status}`, undefined, false,
      );
    }

    const dims = imageDimensions(fetched.body);
    const pixelByDims = dims != null && dims.w <= 1 && dims.h <= 1;
    const detected = sawTracker || pixelByDims;

    if (detected) {
      await asTx(ctx).insert(trackerEvents).values({
        accountId: ctx.accountId,
        messageId,
        kind: pixelByDims ? "pixel" : "remote_image",
        // A pixel detected only by its BYTES has no classifying host — the url it came from
        // is the honest answer there; a url-classified tracker keeps the host that tripped it.
        trackerHost: trackerHost ?? currentHost ?? null,
        // A pixel detected only by its BYTES has no classifying url — the hop it arrived on is
        // the honest answer; a url-classified tracker keeps the url that tripped it.
        url: trackerUrl ?? currentUrl,
        detectedAt: ctx.now(),
      });
    }

    // A detected pixel → transparent stub (never relay the beacon's bytes). Any
    // other image (incl. a real image from a tracker host) → the fetched bytes.
    if (pixelByDims) {
      return { contentType: "image/gif", body: TRANSPARENT_GIF };
    }
    return { contentType: fetched.contentType ?? "application/octet-stream", body: fetched.body };
  }

  /**
   * THE ACCOUNT'S TWO GRANTS, IN ONE READ. `auto` is mail 0048's opt-out inverted: NULL —
   * and an ABSENT ROW, which is every account that never changed anything — is the product
   * default, images load without a press. `pixels` is mail 0072's opt-out read straight:
   * NULL/absent means tracking pixels are refused, a stored instant means the account asked
   * for them. Kept as one method because two call sites (the proxy gate and the tracker
   * feed's `blocked` flag) must answer identically or the feed lies about what the gate did.
   */
  private async imageGrants(ctx: ServiceContext): Promise<{ auto: boolean; pixels: boolean }> {
    const [row] = await ctx.db
      .select({
        blockedAt: accountSettings.blockRemoteImagesAt,
        pixelsAt: accountSettings.loadTrackingPixelsAt,
      })
      .from(accountSettings)
      .where(eq(accountSettings.accountId, ctx.accountId))
      .limit(1);
    return {
      auto: (row?.blockedAt ?? null) === null,
      pixels: (row?.pixelsAt ?? null) !== null,
    };
  }

  /**
   * "Load anyway": flip `message_bodies.loadedRemoteContent = true` so
   * getBody returns remote content unblocked. Idempotent-safe (a second call is a
   * no-op). 404 if the message is not owned by the account.
   */
  async loadRemote(ctx: ServiceContext, messageId: string): Promise<void> {
    await this.requireOwnedMessage(ctx, messageId);
    await asTx(ctx).update(messageBodies)
      .set({ loadedRemoteContent: true })
      .where(eq(messageBodies.messageId, messageId));
  }

  /**
   * The "who tried to spy on you" feed. Account-scoped, newest-first,
   * optionally filtered to a single message. Keyset-paginated by (detectedAt, id).
   */
  async listTrackerEvents(
    ctx: ServiceContext,
    opts: { messageId?: string; cursor?: string; limit?: number } = {},
  ): Promise<Page<TrackerEventDTO>> {
    const limit = clampLimit(opts.limit);
    const filters = [eq(trackerEvents.accountId, ctx.accountId)];
    if (opts.messageId) filters.push(eq(trackerEvents.messageId, opts.messageId));
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      filters.push(or(
        lt(trackerEvents.detectedAt, c.detectedAt),
        and(eq(trackerEvents.detectedAt, c.detectedAt), lt(trackerEvents.id, c.id)),
      )!);
    }

    // Join the message (sender + account scope) and its body (blocked flag).
    //
    // THE JOIN CARRIES ITS OWN ACCOUNT PREDICATE, and this comment used to say it did not need
    // one: "the account filter on tracker_events already scopes; the join adds from_address."
    // That is true of every row this service writes — both `trackerEvents` inserts run behind
    // `requireOwnedMessage`, so the two account ids agree by construction today — and it is the
    // wrong shape of argument for the invariant it is holding up. Account isolation is required
    // to be STRUCTURAL rather than a projection someone remembers to keep narrow, and this
    // projection reads a COUNTERPARTY ADDRESS off the joined row. A single inconsistent but
    // schema-valid `tracker_events` row — a future writer, a backfill, a restore, a repair
    // script — would put another account's sender address into this feed, and nothing in the
    // query would object.
    //
    // The predicate is free: `tracker_events_account_message_idx` is already `(account_id,
    // message_id)` and `messages` is reached by primary key, so this adds a comparison on a row
    // the plan was fetching anyway. Correctness that costs nothing does not need a risk argument
    // to justify it — it needs only that the alternative is a comment promising a property the
    // SQL does not state.
    const rows = await ctx.db.select({
      id: trackerEvents.id,
      messageId: trackerEvents.messageId,
      kind: trackerEvents.kind,
      trackerHost: trackerEvents.trackerHost,
      detectedAt: trackerEvents.detectedAt,
      fromAddress: messages.fromAddress,
      loaded: messageBodies.loadedRemoteContent,
    }).from(trackerEvents)
      .innerJoin(messages, and(
        eq(messages.id, trackerEvents.messageId),
        eq(messages.accountId, ctx.accountId),
      ))
      .leftJoin(messageBodies, eq(messageBodies.messageId, trackerEvents.messageId))
      .where(and(...filters))
      .orderBy(desc(trackerEvents.detectedAt), desc(trackerEvents.id))
      .limit(limit + 1);

    const pageRows = rows.slice(0, limit);
    // The SAME grants the proxy gate checks, so `blocked` states the account's CURRENT posture
    // toward this tracker: refused unless an images grant exists AND the pixel switch is off.
    const grants = pageRows.length > 0
      ? await this.imageGrants(ctx)
      : { auto: false, pixels: false };
    const items = pageRows.map((r) => toDTO(r, grants));
    const last = pageRows[pageRows.length - 1];
    const nextCursor = rows.length > limit && last
      ? encodeCursor(last.detectedAt, last.id)
      : null;
    return { items, nextCursor };
  }

  /** Prove the message belongs to the caller's account (IDOR → 404). */
  private async requireOwnedMessage(ctx: ServiceContext, messageId: string): Promise<void> {
    // SHAPE before ownership. `?mid=` is caller-chosen on `GET /img` and reaches `messages.id`;
    // a malformed one was 22P02 and a 500 rather than the 400 it plainly is. See `ids.ts`.
    requireUuid(messageId, "mid");
    const [m] = await ctx.db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.accountId, ctx.accountId))).limit(1);
    if (!m) throw new ServiceError("not_found", 404, "message not found");
  }
}

// ── (detectedAt, id) keyset cursor — mirrors MessageService's (date, id). ──
function encodeCursor(detectedAt: Date, id: string): string {
  return encodeListCursor(`${detectedAt.getTime()}:${id}`);
}
function decodeCursor(cursor: string): { detectedAt: Date; id: string } {
  const raw = decodeListCursor(cursor);
  const i = raw.indexOf(":");
  return { detectedAt: new Date(Number(raw.slice(0, i))), id: raw.slice(i + 1) };
}

const KIND_MAP: Record<string, TrackerEventDTO["kind"]> = {
  pixel: "tracking_pixel",
  remote_image: "remote_beacon",
  read_receipt: "read_receipt",
};

function toDTO(r: {
  id: string; messageId: string; kind: string; trackerHost: string | null;
  detectedAt: Date; fromAddress: string; loaded: boolean | null;
}, grants: { auto: boolean; pixels: boolean }): TrackerEventDTO {
  return {
    id: r.id,
    messageId: r.messageId,
    sender: { name: null, address: r.fromAddress },
    pixelHost: r.trackerHost ?? "",
    detectedAt: r.detectedAt.toISOString(),
    kind: KIND_MAP[r.kind] ?? "remote_beacon",
    // The gate's own arithmetic, re-derived at read time: a tracker is currently blocked for
    // this account unless an images grant exists (the press or auto mode) AND the pixel switch
    // is off. `!loaded` alone reported auto-mode fetches as "blocked"; images grants alone
    // would report a pixel the gate refuses pre-fetch as loaded.
    blocked: !(((r.loaded ?? false) || grants.auto) && grants.pixels),
  };
}

/** How long the whole proxied fetch may take, headers and body together. */
const REMOTE_TIMEOUT_MS = 8_000;
/** The most body we will ever buffer for one proxied image. */
const REMOTE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * THE LONGEST `?u=` THE IMAGE PROXY WILL PARSE.
 *
 * The value is sender-chosen — it comes out of a stranger's HTML — and it reaches `new URL()`,
 * the SSRF gate's host resolution, a DNS lookup, redirect handling and an outbound fetch. It had
 * no application ceiling at all, and the input-bounds census wrongly recorded it as bounded by
 * the request door: `JSON_BODY_MAX_BYTES` bounds a request BODY, and this is a query string on a
 * GET. What actually bounded it was whatever request-line limit the host in front happened to
 * impose, which is a different number on every deployment and none on a direct socket.
 *
 * 8 192 characters. Comfortably past every real image URL — the practical browser and proxy
 * ceiling for a whole request line has been ~8 KB for two decades, so a longer one is not
 * fetchable by anything else either — and small enough that parsing and resolving it is bounded
 * work. Applied to each REDIRECT target too: a redirect chain is the same value arriving from a
 * different party.
 */
export const PROXY_URL_MAX_CHARS = 8192;

/**
 * Production {@link RemoteFetch}: a stdlib `http(s).request` PINNED to the address the SSRF gate
 * validated (see `pinned-fetch.ts`), forwarding NO client headers (no cookie, no referer, a
 * neutral UA only), so the upstream sender only ever sees OUR server's request from OUR chosen
 * address.
 *
 * **The pin is load-bearing, not defensive.** {@link assertPublicHttpUrl} can only ever validate
 * the name it was handed; a fetch that re-resolves that name would let a DNS-rebinding server send
 * the second lookup to `169.254.169.254` after the gate cleared a public one. Connecting only to
 * the pinned address is what removes that window.
 *
 * **This port never follows a redirect**, and with the stdlib client that is by construction — it
 * does not follow them at all. A `302 Location: http://169.254.169.254/` comes back as a bare 3xx
 * with an empty body and the `Location` string, and the SECOND request — if there is one — is made
 * by `proxyImage` only after that url has been through {@link assertPublicHttpUrl} and been pinned
 * to its own validated addresses. That split is the design: the port cannot open a socket to an
 * address the gate has not cleared, because it is never the thing that decides where to go next.
 *
 * The **timeout** and **size cap** are not tidiness either: without them one authenticated caller
 * can hold a serverless socket open indefinitely, or make us buffer a multi-gigabyte body into the
 * function's memory.
 */
export const nodeRemoteFetch: RemoteFetch = makeNodeRemoteFetch();

/**
 * The same port with the two limits as parameters. Exists so a test can watch the
 * timeout and the cap actually fire in under a second instead of waiting out the
 * production values — a limit nobody has seen trip is not evidence that it trips.
 */
export function makeNodeRemoteFetch(
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): RemoteFetch {
  const timeoutMs = opts.timeoutMs ?? REMOTE_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? REMOTE_MAX_BYTES;
  return { async fetch(url: string, pin: readonly string[], opts: { timeoutMs?: number } = {}) {
    const ac = new AbortController();
    /* The chain's REMAINING budget, never more than this port's own limit. Without it the
       whole-chain deadline could only refuse to START another hop, so a chain of three quick
       redirects followed by one hop that stalls for the full transport timeout still held the
       invocation for the budget PLUS a whole timeout. Taking the smaller of the two makes the
       deadline bound the socket, not merely the loop. */
    const effective = Math.max(1, Math.min(timeoutMs, opts.timeoutMs ?? timeoutMs));
    const timer = setTimeout(() => ac.abort(), effective);
    try {
      const res = await pinnedHttpRequest(url, {
        pin,
        signal: ac.signal,
        // Leaves the building on every proxied image, so it is a PUBLIC brand surface — the one
        // string in this file a sender's analytics can see and log. It said "TrafficFlowMail",
        // the pre-rename name, which the string guard missed because the guard looked for
        // "TrafficFlow Mail" with a space.
        headers: { "user-agent": "ohmail-ImageProxy/1.0" },
      });

      // A redirect's BODY is still dropped unread — a 3xx entity is never the image, and
      // buffering it would be work spent on bytes nobody reads. The `Location` header is
      // returned rather than discarded so `proxyImage` can put it back through the SSRF
      // gate and follow it; this port still never follows one itself, which is what keeps
      // "every socket we open went to an address the gate cleared" true by construction.
      if (res.status >= 300 && res.status < 400) {
        res.stream.destroy();
        const loc = res.headers.location;
        return {
          status: res.status,
          contentType: null,
          body: new Uint8Array(0),
          location: typeof loc === "string" ? loc : null,
        };
      }

      const ct = res.headers["content-type"];
      const body = await readCapped(res.stream, res.headers["content-length"], maxBytes);
      return { status: res.status, contentType: typeof ct === "string" ? ct : null, body };
    } catch (err) {
      /* ── THE TRANSPORT NAMES ITS OWN FAILURES, SO THE ROUTE DOES NOT HAVE TO GUESS ──────
         DNS failure, TLS failure, a connection reset, the abort that fires on the timeout:
         these are the DEPENDENCY failing, and only this layer can tell them apart from a bug
         in ours. Labelling them here is what lets the route stop treating EVERY unknown throw
         as an upstream problem — a blanket 424 up there would have swallowed a database error
         in the ownership check or a `TypeError` in our own code and reported a real outage of
         OURS as somebody else's failed dependency — the same confusion the 424 exists to end,
         pointed the other way. A `ServiceError` (the size cap, say) already knows what it is
         and passes through untouched. */
      if (err instanceof ServiceError) throw err;
      /* ONLY TRANSPORT-SHAPED FAILURES ARE RELABELLED. The first version of this catch took
         every non-`ServiceError`, which put a `TypeError` from our own response handling into
         the 424 class and hid it from the 5xx alerting — the same mistake the route-level
         catch had just been fixed for, one layer down. A programming fault has no `code` and
         is not an abort, so it propagates untouched and surfaces as the 500 it is. */
      if (!isTransportFailure(err)) throw err;
      throw new ServiceError(
        "upstream_unavailable", UPSTREAM_STATUS,
        "the remote image could not be fetched", undefined, false,
      );
    } finally {
      clearTimeout(timer);
    }
  } };
}

/**
 * Read at most `max` bytes from a Node response stream and ABORT the moment the cap is passed.
 * Streaming rather than buffering the whole body is the point: a cap applied after a full read
 * would be a cap on what we RETURN, not on what we ALLOCATE.
 */
async function readCapped(
  stream: import("node:http").IncomingMessage, contentLength: string | string[] | undefined, max: number,
): Promise<Uint8Array> {
  const declared = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
  if (Number.isFinite(declared) && declared > max) {
    stream.destroy();
    throw new ServiceError("upstream_failed", UPSTREAM_STATUS, "remote image is too large");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const value = chunk as Uint8Array;
      total += value.byteLength;
      if (total > max) {
        stream.destroy();
        throw new ServiceError("upstream_failed", UPSTREAM_STATUS, "remote image is too large");
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    // A stream that errors mid-body (a reset, an abort) is an upstream failure, not an image.
    throw new ServiceError("upstream_failed", UPSTREAM_STATUS, "remote image could not be read");
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** Construct a PrivacyService with an injected RemoteFetch (mock in tests). */
export function makePrivacyService(deps: PrivacyServiceDeps): PrivacyService {
  return new PrivacyService(deps);
}
