/**
 * `@trafficflow/api/local` — the API surface a LOCAL engine mounts.
 *
 * The default barrel re-exports `apiRoutes`, and `apiRoutes` imports every route module there is.
 * So a consumer that wanted `createApp` and the mail routes got the billing handler, the Stripe
 * webhook, the waitlist and the six cross-account admin reads as well — not as dead code a
 * bundler could drop, but as live modules in the graph.
 *
 * This entry point exists so the local engine can say what it actually mounts. It deliberately
 * re-exports from the individual modules rather than from `./index.js`: going through the default
 * barrel would pull `routes/index.js` back in and undo the whole point.
 *
 * Additive. `./index.js` is unchanged and still exports everything it did.
 */
export { API_VERSION } from "./version.js";
export type {
  ApiDeps, ApiServices, ResolvedSession, SessionVia, IdempotencyContext, SseConfig, HealthConfig,
  HelloConfig,
} from "./deps.js";
export { DEFAULT_SSE } from "./deps.js";
export { createApp, type App } from "./app.js";
export { localRoutes } from "./routes/local.js";
// The add-time probe's SSRF/port gate. The local engine wires ALLOW_ANY (a LAN mail server on a
// non-standard port is legitimate on a desktop install); the hosted deployment wires the enforcing
// `makeProbeHostGuard`. See `imap-probe.ts`.
export {
  ALLOW_ANY_PROBE_HOST, makeProbeHostGuard, MAIL_PROBE_PORTS, type ProbeHostGuard,
} from "./imap-probe.js";
export {
  matchRoute, UNVERIFIED_MAY_REACH, unverifiedMayReach,
  type CostClass, type Route, type RouteOptions, type RouteParams, type Handler, type MatchResult,
} from "./router.js";
export { jsonResponse, errorResponse, type JsonResponseInit } from "./responses.js";
// The per-request ServiceContext builder, for engine-side route modules (the sidecar's own
// tables — AI settings, the stdio pairing mint) that call services exactly as the shared
// handlers do. Mail-safe: it reads `deps.session` and the platform IP headers, nothing hosted.
export { serviceContext } from "./context.js";
