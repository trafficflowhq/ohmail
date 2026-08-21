import type { ServiceContext } from "./context.js";

/**
 * THE PUSH SEAM — the shapes and the port, with no implementation and no table behind them.
 *
 * Push registrations are a hosted concern: they live in a table the hosted journal creates and a
 * local database therefore does not have, so the real service could not work in a local install
 * even if it were shipped there. What IS shared is the vocabulary — the transport union, the
 * request body, the result — because the routes and the client shapes that describe a
 * registration are the same code in both deployments, and a local install answers the same
 * endpoints with a stand-in that refuses.
 *
 * Splitting the shapes from the service is what lets that be true without the mail half naming
 * the module that reads and writes the hosted table. A value import of the service pulls the
 * hosted schema in behind it; a type import does not, but it still names a private module in the
 * source, which is the disclosure this split removes.
 */

export type PushTransport = "webpush" | "apns" | "unifiedpush";

/**
 * Flat push-subscription body. Web Push needs `endpoint` plus the `p256dh`/`auth` keys; APNs
 * needs `deviceToken`, optionally with a bundle id and environment. UnifiedPush needs `endpoint`
 * ALONE — no keys, deliberately: the wake the worker POSTs to that endpoint is a closed constant
 * (`{"type":"wake"}`), so there is no content to encrypt and no key whose loss could matter. The
 * device's UnifiedPush distributor hands the app the endpoint URL; registering it here is the
 * whole ceremony.
 *
 * Payloads are content-free wake signals only — a push tells a device that something changed and
 * never what changed, so a notification cannot carry mail through a third party's servers.
 */
export interface PushSubscribeBody {
  transport: PushTransport;
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  deviceToken?: string;
  bundleId?: string;
  environment?: string;
  deviceId?: string;
}

/**
 * The idempotency handle a route hands in when the request carried an idempotency key. The
 * service writes the record INSIDE its own mutation transaction, so a commit-then-crash retry
 * replays verbatim rather than registering a second device.
 */
export interface PushIdempotency {
  key: string;
  requestHash: string;
}

export interface PushSubscribeResult {
  id: string;
  transport: PushTransport;
}

/**
 * The port every caller sees: register a device, or forget one.
 *
 * The hosted implementation declares `implements` against this interface, and that clause is the
 * drift guard — it is compiled as part of the package's own sources, so the two cannot diverge
 * silently the way a hand-copied interface would. A local install supplies a stand-in that
 * satisfies the same port by refusing, which is what lets one route table serve both.
 */
export interface PushService {
  subscribe(
    ctx: ServiceContext,
    body: PushSubscribeBody,
    opts?: { idempotency?: PushIdempotency | null },
  ): Promise<PushSubscribeResult>;
  unsubscribe(ctx: ServiceContext, id: string): Promise<void>;
}
