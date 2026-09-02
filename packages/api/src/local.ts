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
  // The probe FACTORIES, on `serviceContext`'s own argument: an engine-side handler that calls a
  // credential-writing service must inject the same dial the shared handler does, or it becomes
  // the second door into `mailbox_credentials` that stores a password nothing has tried to log in
  // with — which is the defect `PATCH /mailboxes/:id`'s own comment records having had. The
  // sidecar's `PATCH /local/mailboxes/:id` is that caller; it exists because the shared route is
  // `stepUp: true` and this door's second factor expires five minutes after launch, for ever.
  makeImapProbe, makeSmtpProbe,
  // The probe's own dial seam. An engine configured to reach its mail server through a double must
  // reach the PROBE through it too — a probe is a login against the server somebody just typed, so
  // a composition that intercepted the sync adapter and not this one would still open a real
  // socket on the one path whose entire job is to try a password.
  type ProbeDialer, type SmtpProbeOptions,
} from "./imap-probe.js";
export {
  matchRoute, UNVERIFIED_MAY_REACH, unverifiedMayReach,
  type CostClass, type Route, type RouteOptions, type RouteParams, type Handler, type MatchResult,
} from "./router.js";
export { jsonResponse, errorResponse, type JsonResponseInit } from "./responses.js";
// THE SEND TRANSPORT, on the probe factories' own argument. The standalone engine used to build
// its own, because it had no stored `smtp` row to read — its submission server was a process
// setting. An install holding several mailboxes ends that: each mailbox stores its own credential
// pair, which is exactly what this function already reads, and a process-wide setting cannot
// describe two servers. Exported here rather than reached through the package barrel, which
// would pull the hosted route table's whole module graph into the desktop bundle; this module
// names only the credential table, the adapter and the shared errors, all of which the engine
// already carries.
export { makeSendAdapter } from "./send-adapter.js";
// The per-request ServiceContext builder, for engine-side route modules (the sidecar's own
// tables — AI settings, the stdio pairing mint) that call services exactly as the shared
// handlers do. Mail-safe: it reads `deps.session` and the platform IP headers, nothing hosted.
export { serviceContext } from "./context.js";
