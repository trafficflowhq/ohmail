import type { ServiceContext } from "./context.js";

/**
 * THE PUSH SEAM — the shapes and the port, no implementation and no table behind them.
 * Registrations are a hosted concern: the table exists only in the hosted journal, so the real
 * service cannot work in a local install. What IS shared is the vocabulary — transport union,
 * request body, result — because routes and client shapes are the same code in both deployments,
 * and a local install answers the same endpoints with a stand-in that refuses. Splitting shapes
 * from service keeps the mail half from naming the module that touches the hosted table: a value
 * import pulls the hosted schema in behind it; a type import does not, but still names a private
 * module — the disclosure this split removes.
 */

export type PushTransport = "webpush" | "apns" | "unifiedpush";

/**
 * Flat push-subscription body. Web Push needs `endpoint` plus `p256dh`/`auth`; APNs needs
 * `deviceToken` (optional bundle id and environment). UnifiedPush needs `endpoint` ALONE — no
 * keys, deliberately: the wake the worker POSTs is a closed constant (`{"type":"wake"}`), so
 * there is nothing to encrypt. The distributor hands the app the endpoint URL; registering it is
 * the whole ceremony. Payloads are content-free wake signals only — a push says something
 * changed, never what, so a notification cannot carry mail through a third party's servers.
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
