import { and, desc, eq, lt, or } from "drizzle-orm";
import { accountSettings, messages, messageBodies, trackerEvents, type Tx } from "@trafficflow/db";
import { hostOf, isKnownTracker, isBeaconUrl } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
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
  fetch(url: string, pin: readonly string[]): Promise<{ status: number; contentType: string | null; body: Uint8Array }>;
}

export interface PrivacyServiceDeps {
  remote: RemoteFetch;
  /**
   * The SSRF gate's DNS port. **Required — there is no default**, because a
   * defaulted `node:dns` in a DNS-blocked sandbox would make every test take the
   * refuse branch and ship the permit branch unexecuted. See {@link HostResolver}.
   */
  resolver: HostResolver;
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
    const pin = await assertPublicHttpUrl(url, this.deps.resolver);

    // Fetch server-side, connected ONLY to the pinned address. The port takes the
    // url and the pin → no client header can ride along, and no second DNS lookup
    // can undo the gate. The sender sees OUR request, never the reader's.
    const fetched = await this.deps.remote.fetch(url, pin);

    // A 3xx that reached here is a REFUSAL, not a hop: the port does not follow
    // redirects, so the only honest thing to do with a Location nobody validated
    // is to stop. Any other non-2xx is an upstream failure whose body is not an
    // image and must not be relayed as one.
    if (fetched.status < 200 || fetched.status >= 300) {
      throw new ServiceError("upstream_failed", 502, `remote image responded ${fetched.status}`);
    }

    const dims = imageDimensions(fetched.body);
    const pixelByDims = dims != null && dims.w <= 1 && dims.h <= 1;
    const detected = trackerByUrl || pixelByDims;

    if (detected) {
      await asTx(ctx).insert(trackerEvents).values({
        accountId: ctx.accountId,
        messageId,
        kind: pixelByDims ? "pixel" : "remote_image",
        trackerHost: host || null,
        url,
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
 * **Redirects are never followed**, and with the stdlib client that is by construction — it does
 * not follow them at all, so a `302 Location: http://169.254.169.254/` comes back as a bare 3xx
 * with an empty body and `proxyImage` refuses it. No second request is ever made.
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
  return { async fetch(url: string, pin: readonly string[]) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
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

      // A redirect is a refusal. Drop the body unread — its `Location` names a url
      // the gate never saw, and reading it buys us nothing.
      if (res.status >= 300 && res.status < 400) {
        res.stream.destroy();
        return { status: res.status, contentType: null, body: new Uint8Array(0) };
      }

      const ct = res.headers["content-type"];
      const body = await readCapped(res.stream, res.headers["content-length"], maxBytes);
      return { status: res.status, contentType: typeof ct === "string" ? ct : null, body };
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
    throw new ServiceError("upstream_failed", 502, "remote image is too large");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const value = chunk as Uint8Array;
      total += value.byteLength;
      if (total > max) {
        stream.destroy();
        throw new ServiceError("upstream_failed", 502, "remote image is too large");
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    // A stream that errors mid-body (a reset, an abort) is an upstream failure, not an image.
    throw new ServiceError("upstream_failed", 502, "remote image could not be read");
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
