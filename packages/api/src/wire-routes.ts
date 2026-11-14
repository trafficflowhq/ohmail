/**
 * EVERY MOUNTED ROUTE IS IN EXACTLY ONE OF THREE LISTS, and a test holds that against the four
 * route tables (`test/wire-routes-census.test.ts`).
 *
 *  · {@link WIRE_ROUTES}: both sides take their types from `@ohmail/wire`'s `Routes`. The server
 *    answers through `answer<"…">()(body)`, the client asks through its typed call.
 *  · {@link UNBOUND_CALLS}: a client of this tree calls it with types of its own. The wire names
 *    it (`UnboundCall`) and the file that spells it.
 *  · {@link SERVER_ONLY_ROUTES}: no client of this tree calls it, each with the reason.
 *
 * The first two are what the clients are known to ask for; the third is where a route nobody asks
 * for can be found. A route's place here changes nothing about how it is served.
 */
import type { Assert, Complete, RouteName, UnboundCall } from "@ohmail/wire";

/** The routes whose request and answer both sides take from the wire. */
export const WIRE_ROUTES = [
  "GET /attachments/:id", "POST /attachments/staging", "POST /drafts", "DELETE /drafts/:id", "GET /drafts/:id",
  "PUT /drafts/:id", "POST /drafts/:id/resolve", "DELETE /drafts/:id/schedule", "POST /drafts/:id/schedule",
  "POST /drafts/:id/schedule-with-files", "POST /drafts/:id/send", "GET /drafts/:id/send-attempt",
  "POST /folders", "DELETE /folders/:id", "PATCH /folders/:id", "DELETE /folders/:id/op", "GET /hello",
  "GET /messages", "PATCH /messages", "DELETE /messages/:id", "GET /messages/:id", "PATCH /messages/:id",
  "GET /messages/:id/attachments", "POST /messages/:id/attachments/download-all", "GET /messages/:id/body",
  "POST /messages/:id/move", "POST /messages/:id/restore", "POST /messages/:id/tags",
  "POST /messages/:id/triage", "POST /messages/:id/unsubscribe", "GET /messages/bodies",
  "GET /messages/timeline", "GET /organizer-requests", "POST /rules", "DELETE /rules/:id", "PATCH /rules/:id",
  "GET /screener", "POST /screener/:id", "GET /screener/auto-filed", "POST /screener/auto-filed/undo",
  "GET /screener/held-releases", "POST /screener/held-releases", "POST /screener/held-releases/dismiss",
  "GET /screener/stayed", "GET /screener/unscreened", "POST /screener/unscreened", "GET /search",
  "POST /sends/withdraw", "GET /sync", "POST /sync/pull", "GET /sync/snapshot", "POST /tags",
  "DELETE /tags/:id", "PATCH /tags/:id",
] as const satisfies readonly RouteName[];
type _WireRoutesComplete = Assert<Complete<RouteName, typeof WIRE_ROUTES>>;

/** The routes a client of this tree calls with types of its own; the wire's `UnboundCall` says where. */
export const UNBOUND_CALLS = [
  "DELETE /account", "GET /account/access", "GET /account/ai", "PATCH /account/ai",
  "POST /account/checkout/confirm", "GET /account/export", "POST /account/manage-link",
  "POST /account/manage-link/change", "GET /account/screening", "PATCH /account/screening",
  "PATCH /account/storage", "POST /auth/2fa/recovery-codes", "POST /auth/2fa/recovery-codes/verify",
  "DELETE /auth/2fa/totp", "POST /auth/2fa/totp/activate", "POST /auth/2fa/totp/enroll",
  "POST /auth/2fa/totp/verify", "POST /auth/2fa/webauthn/assert/options",
  "POST /auth/2fa/webauthn/assert/verify", "POST /auth/2fa/webauthn/register/options",
  "POST /auth/2fa/webauthn/register/verify", "POST /auth/desktop-approval", "GET /auth/desktop-approval/:id",
  "POST /auth/desktop-approval/:id/confirm", "POST /auth/desktop-approval/:id/deny",
  "POST /auth/desktop-approval/claim", "POST /auth/desktop-claim", "POST /auth/desktop-link",
  "POST /auth/login", "POST /auth/logout", "POST /auth/password", "POST /auth/refresh",
  "POST /auth/refresh/logout", "POST /auth/register", "POST /auth/reuse-sweeps/ack", "GET /auth/session",
  "POST /auth/step-up/recovery-code", "POST /auth/step-up/totp", "POST /auth/step-up/webauthn/options",
  "POST /auth/step-up/webauthn/verify", "POST /auth/verify-email", "POST /auth/verify-email/resend",
  "GET /away-responder", "PUT /away-responder", "GET /consent", "GET /consent/reset", "POST /consent/reset",
  "GET /consent/seed", "POST /consent/seed", "PATCH /consent/settings", "GET /devices", "DELETE /devices/:id",
  "POST /devices/revoke-web-sessions", "GET /events", "GET /folders/:id/summary", "GET /health", "GET /img",
  "GET /mailboxes", "POST /mailboxes", "DELETE /mailboxes/:id", "GET /mailboxes/:id", "PATCH /mailboxes/:id",
  "GET /mailboxes/:id/filings", "POST /mailboxes/:id/filings/leave", "POST /mailboxes/:id/filings/retry",
  "POST /mailboxes/:id/gap-letters", "POST /mailboxes/:id/inbound-quiet/dismiss",
  "POST /mailboxes/:id/organize", "GET /mailboxes/:id/organizer",
  "POST /mailboxes/:id/organizer-notice/dismiss", "GET /mailboxes/:id/profile",
  "GET /mailboxes/:id/profile-import", "POST /mailboxes/:id/profile-import",
  "POST /mailboxes/:id/profile-import/decline", "POST /mailboxes/:id/profile-import/replace",
  "GET /mailboxes/:id/profile-import/status", "POST /mailboxes/:id/release", "POST /mailboxes/:id/resync",
  "GET /mailboxes/:id/self-check", "POST /mailboxes/discover", "GET /mailboxes/oauth/microsoft/availability",
  "GET /mailboxes/oauth/microsoft/callback", "POST /mailboxes/oauth/microsoft/complete",
  "POST /mailboxes/oauth/microsoft/device/poll", "POST /mailboxes/oauth/microsoft/device/start",
  "POST /mailboxes/oauth/microsoft/start", "POST /mailboxes/probe", "POST /messages/:id/draft",
  "GET /messages/:id/live-body", "POST /messages/:id/load-remote", "GET /oauth/authorize",
  "POST /oauth/authorize", "GET /oauth/authorize/request", "POST /oauth/token", "GET /pair", "POST /pair",
  "DELETE /pair/:id", "POST /pair/redeem", "POST /pair/state", "POST /push/subscriptions",
  "DELETE /push/subscriptions/:id", "GET /push/vapid-key", "GET /rules", "GET /rules/:id",
  "GET /screener/junk", "GET /screener/junk/body", "POST /screener/junk/rescue",
  "DELETE /screener/junk/rescue/:id", "GET /screener/junk/search", "GET /screener/junk/sweep",
  "POST /screener/junk/sweep", "POST /screener/suggest", "GET /screener/unscreened/count",
  "GET /screener/waiting/count", "GET /tags", "GET /threads/:id", "PATCH /threads/:id", "GET /trash/window",
  "GET /trash/window/body", "GET /triage",
] as const satisfies readonly UnboundCall[];
type _UnboundCallsComplete = Assert<Complete<UnboundCall, typeof UNBOUND_CALLS>>;

/**
 * Why no client of this tree calls a route.
 *  · `operator`: the operator's console and tools ask it; they are not in this repository.
 *  · `platform`: a clock, the worker or an alert drill asks it, with a shared secret.
 *  · `site`: the public site's form asks it.
 *  · `no-caller-found`: no client's source spells its path. A candidate for removal, once a log
 *    of what running clients ask for agrees.
 */
export type ServerOnlyReason = "operator" | "platform" | "site" | "no-caller-found";

/** The routes no client of this tree calls, each with its reason. */
export const SERVER_ONLY_ROUTES: Readonly<Record<string, ServerOnlyReason>> = Object.freeze({
  "GET /approvals": "no-caller-found",
  "POST /approvals/:id": "no-caller-found",
  "GET /attachments/:id/meta": "no-caller-found",
  "GET /auth/audit": "no-caller-found",
  "GET /contacts": "no-caller-found",
  "GET /contacts/:id": "no-caller-found",
  "PATCH /contacts/:id": "no-caller-found",
  "GET /contacts/:id/notes": "no-caller-found",
  "POST /contacts/:id/notes": "no-caller-found",
  "GET /files": "no-caller-found",
  "POST /files/download-all": "no-caller-found",
  "GET /kb": "no-caller-found",
  "POST /kb": "no-caller-found",
  "DELETE /kb/:id": "no-caller-found",
  "GET /kb/:id": "no-caller-found",
  "PUT /kb/:id": "no-caller-found",
  "GET /messages/:id/tracker-events": "no-caller-found",
  "DELETE /notes/:id": "no-caller-found",
  "PATCH /notes/:id": "no-caller-found",
  "GET /notify-rules": "no-caller-found",
  "POST /notify-rules": "no-caller-found",
  "DELETE /notify-rules/:id": "no-caller-found",
  "GET /snippets": "no-caller-found",
  "POST /snippets": "no-caller-found",
  "DELETE /snippets/:id": "no-caller-found",
  "GET /snippets/:id": "no-caller-found",
  "PUT /snippets/:id": "no-caller-found",
  "GET /threads/:id/notes": "no-caller-found",
  "POST /threads/:id/notes": "no-caller-found",
  "POST /threads/:id/rename": "no-caller-found",
  "POST /threads/merge": "no-caller-found",
  "GET /tracker-events": "no-caller-found",
  "GET /trash/window/search": "no-caller-found",
  "GET /views/focus-reply": "no-caller-found",
  "GET /views/power-through": "no-caller-found",
  "GET /workflow-runs": "no-caller-found",
  "POST /workflow-runs/:id/undo": "no-caller-found",
  "GET /workflows": "no-caller-found",
  "POST /workflows": "no-caller-found",
  "DELETE /workflows/:id": "no-caller-found",
  "GET /workflows/:id": "no-caller-found",
  "PATCH /workflows/:id": "no-caller-found",
  "POST /workflows/:id/run": "no-caller-found",
  "GET /workflows/proposals": "no-caller-found",
  "POST /workflows/proposals/:id/dismiss": "no-caller-found",
  "GET /admin/accounts": "operator",
  "GET /admin/accounts/:id": "operator",
  "POST /admin/accounts/:id/billing-link": "operator",
  "GET /admin/accounts/:id/staff-activity": "operator",
  "GET /admin/actions": "operator",
  "GET /admin/alerts/history": "operator",
  "GET /admin/connect-attempts": "operator",
  "GET /admin/engagement": "operator",
  "GET /admin/funnel": "operator",
  "POST /admin/mailboxes/resync": "operator",
  "POST /admin/oauth/microsoft": "operator",
  "POST /admin/oauth/microsoft/save": "operator",
  "GET /admin/overview": "operator",
  "GET /admin/search": "operator",
  "GET /admin/staff-activity": "operator",
  "POST /admin/staff/assertion": "operator",
  "POST /admin/staff/list": "operator",
  "POST /admin/staff/roles": "operator",
  "POST /admin/staff/session": "operator",
  "POST /admin/staff/sign-out": "operator",
  "POST /admin/staff/step-up": "operator",
  "POST /admin/staff/totp/begin": "operator",
  "POST /admin/staff/totp/confirm": "operator",
  "POST /admin/staff/totp/reset": "operator",
  "POST /admin/staff/whoami": "operator",
  "GET /admin/storage": "operator",
  "GET /admin/sync-roster": "operator",
  "GET /admin/worker": "operator",
  "GET /internal/account-lifecycle/erase": "platform",
  "GET /internal/account-lifecycle/run": "platform",
  "GET /internal/alerts": "platform",
  "POST /internal/alerts": "platform",
  "GET /internal/alerts/drill": "platform",
  "POST /internal/alerts/drill": "platform",
  "GET /internal/alerts/drill/ack": "platform",
  "POST /internal/alerts/drill/ack": "platform",
  "GET /internal/alerts/run": "platform",
  "GET /internal/away/run": "platform",
  "POST /internal/fault": "platform",
  "GET /internal/mailboxes/smtp-size": "platform",
  "GET /internal/security-notices/run": "platform",
  "GET /internal/sends/reconcile/run": "platform",
  "GET /internal/sends/scheduled/run": "platform",
  "GET /internal/sends/sent-copies/run": "platform",
  "GET /internal/sessions/reap": "platform",
  "GET /internal/storage-mails/run": "platform",
  "GET /internal/unsubscribe/drain": "platform",
  "POST /waitlist": "site",
});
