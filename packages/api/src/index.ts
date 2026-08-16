export { API_VERSION } from "./version.js";

// Per-request container + session identity.
export type {
  ApiDeps, ApiServices, ResolvedSession, SessionVia, IdempotencyContext, SseConfig, HealthConfig,
  ChangeWakeHub,
  AiCreditGateFactory,
  AttachmentStagingPort, AttachmentStagingFactory, StagedUploadGrantWire,
} from "./deps.js";
export { DEFAULT_SSE } from "./deps.js";
/* THE HOSTED HALF OF THE DEPENDENCY SURFACE. Re-exporting from `deps-cloud.js` is what carries
 * its module augmentation into every program built from this barrel — so a hosted host sees the
 * identity, billing, funnel and operator members on `ApiDeps`/`ApiServices` exactly as before.
 * A local host imports `./local.js` instead, never loads this module, and correctly has no such
 * members rather than members that are always undefined. */
export type { AlertsConfig, AdminConfig } from "./deps-cloud.js";

// Service-context builder + web cookie helpers (slice B).
export { serviceContext } from "./context.js";
export { sessionCookies, enrollmentCookies, clearSessionCookies, ownerCookieValue, OWNER_COOKIE } from "./cookies.js";
/* Beside the guard that recomputes it, not beside the cookie set that carries it — see
 * `csrf.ts`. Verifying a CSRF token is work every host's request pipeline does; minting the
 * session cookies is work only a host with a sign-in ceremony does. */
export { csrfTokenFor } from "./csrf.js";

// Route groups: auth (§2) + slice C (sync/SSE/push/mailboxes/rules) + the full table.
export {
  authRoutes, apiRoutes,
  syncRoutesGroup, eventsRoutesGroup, pushRoutesGroup, mailboxRoutesGroup, rulesRoutesGroup,
  messageRoutesGroup, threadRoutesGroup,
  screenerRoutesGroup, approvalRoutesGroup, triageRoutesGroup, searchRoutesGroup, privacyRoutesGroup,
  unsubscribeRoutesGroup,
  contactsRoutesGroup, snippetsRoutesGroup, notifyRoutesGroup, awayRoutesGroup, attachmentRoutesGroup,
  kbRoutesGroup, draftsRoutesGroup, workflowsRoutesGroup, healthRoutesGroup, billingRoutesGroup,
  internalRoutesGroup, adminRoutesGroup,
} from "./routes/index.js";

// Shared-secret authentication for the two endpoints whose caller is a machine
// (`/internal/alerts`, `/admin/*`). Exported so its properties can be pinned by a test.
export { secretMatches, bearerOf, presentsSecret, secretRouteJson } from "./secret-auth.js";

// The path the host deployment's cron schedule points at. Exported so the deployment config
// and the router cannot disagree about it; a suite on the host side pins the agreement.
export { ALERT_CRON_PATH } from "./routes/internal.js";

// On-demand attachment adapter factory (decrypt mailbox creds → connected ImapAdapter).
export { makeOpenAdapter } from "./attachments-adapter.js";

// Send adapter factory — decrypt BOTH imap+smtp creds → connected ImapAdapter.
export { makeSendAdapter } from "./send-adapter.js";

// The add-time IMAP/SMTP probe's SSRF/port gate. The hosted deployment wires the enforcing policy
// on `ApiServices.probeHostGuard`; the desktop engine wires ALLOW_ANY (a LAN mail server is
// legitimate there). See `imap-probe.ts`.
export {
  makeProbeHostGuard, ALLOW_ANY_PROBE_HOST, MAIL_PROBE_PORTS, type ProbeHostGuard,
} from "./imap-probe.js";

// Routing.
export {
  matchRoute,
  // The declared cost class every route carries, and the predicate `withSpendGate`
  // judges it with. Exported so a guard can sweep the table rather than re-deriving the
  // permissive set from a copy of it — a copied predicate rots alone.
  UNVERIFIED_MAY_REACH, unverifiedMayReach,
  type CostClass,
  type Route, type RouteOptions, type RouteParams, type Handler, type MatchResult,
} from "./router.js";

// Responses.
export { jsonResponse, errorResponse, type JsonResponseInit } from "./responses.js";

// Middleware.
export {
  withRequestId, withErrorEnvelope, withRequestGuard, withSession, withStepUp, withSpendGate,
  withCsrf, withIdempotency,
  type Middleware,
} from "./middleware.js";

// Idempotency store.
export {
  recordIdempotent, lookupIdempotent, idempotencyExpiry,
  type StoredIdempotent, type RecordIdempotentInput,
} from "./idempotency.js";

// App factory.
export { createApp, type App } from "./app.js";
