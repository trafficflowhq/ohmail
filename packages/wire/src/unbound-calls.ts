/**
 * ROUTES A CLIENT OF THIS TREE CALLS WITH TYPES OF ITS OWN, by name: the web app, the phone, the
 * desktop's window and the desktop's engine as a client of its account's server. Each moves into
 * `Routes` (`routes.ts`) when its client's wire is written against this package, both sides in
 * one change. The comment is one file that spells the route's path; it was found by reading the
 * clients' source, which is a second witness beside a log of what a running client asks for and
 * never a proof on its own: a path a client composes at run time is not found this way.
 */
export type UnboundCall =
  // apps/webapp/app/api-client.ts
  | "DELETE /account"
  | "GET /account/access"
  | "GET /account/ai"
  | "PATCH /account/ai"
  | "POST /account/checkout/confirm"
  | "GET /account/export"
  // apps/webapp/app/manage-handoff.ts
  | "POST /account/manage-link"
  // apps/webapp/app/api-client.ts
  | "POST /account/manage-link/change"
  | "GET /account/screening"
  | "PATCH /account/screening"
  | "PATCH /account/storage"
  | "POST /auth/2fa/recovery-codes"
  | "POST /auth/2fa/recovery-codes/verify"
  | "DELETE /auth/2fa/totp"
  | "POST /auth/2fa/totp/activate"
  | "POST /auth/2fa/totp/enroll"
  | "POST /auth/2fa/totp/verify"
  | "POST /auth/2fa/webauthn/assert/options"
  | "POST /auth/2fa/webauthn/assert/verify"
  | "POST /auth/2fa/webauthn/register/options"
  | "POST /auth/2fa/webauthn/register/verify"
  // apps/sidecar/src/cloud-signin.ts
  | "POST /auth/desktop-approval"
  // apps/webapp/app/api-client.ts
  | "GET /auth/desktop-approval/:id"
  | "POST /auth/desktop-approval/:id/confirm"
  | "POST /auth/desktop-approval/:id/deny"
  // apps/mobile/src/net/bearer.ts
  | "POST /auth/desktop-approval/claim"
  // apps/webapp/app/api-client.ts
  | "POST /auth/desktop-claim"
  | "POST /auth/desktop-link"
  | "POST /auth/login"
  | "POST /auth/logout"
  | "POST /auth/password"
  // apps/webapp/app/csrf.ts
  | "POST /auth/refresh"
  // apps/webapp/app/sign-out.ts
  | "POST /auth/refresh/logout"
  // apps/webapp/app/csrf.ts
  | "POST /auth/register"
  // apps/webapp/app/api-client.ts
  | "POST /auth/reuse-sweeps/ack"
  // apps/webapp/app/session-gate.ts
  | "GET /auth/session"
  // apps/webapp/app/api-client.ts
  | "POST /auth/step-up/recovery-code"
  | "POST /auth/step-up/totp"
  | "POST /auth/step-up/webauthn/options"
  | "POST /auth/step-up/webauthn/verify"
  | "POST /auth/verify-email"
  | "POST /auth/verify-email/resend"
  | "GET /away-responder"
  | "PUT /away-responder"
  | "GET /consent"
  | "GET /consent/reset"
  | "POST /consent/reset"
  | "GET /consent/seed"
  | "POST /consent/seed"
  | "PATCH /consent/settings"
  | "GET /devices"
  | "DELETE /devices/:id"
  | "POST /devices/revoke-web-sessions"
  // apps/webapp/app/shell/engine-config.ts
  | "GET /events"
  // apps/webapp/app/shell/FoldersRailGroup.tsx
  | "GET /folders/:id/summary"
  // apps/webapp/app/api-client.ts
  | "GET /health"
  | "GET /img"
  | "GET /mailboxes"
  | "POST /mailboxes"
  | "DELETE /mailboxes/:id"
  | "GET /mailboxes/:id"
  | "PATCH /mailboxes/:id"
  | "GET /mailboxes/:id/filings"
  | "POST /mailboxes/:id/filings/leave"
  | "POST /mailboxes/:id/filings/retry"
  | "POST /mailboxes/:id/gap-letters"
  | "POST /mailboxes/:id/inbound-quiet/dismiss"
  | "POST /mailboxes/:id/organize"
  | "GET /mailboxes/:id/organizer"
  | "POST /mailboxes/:id/organizer-notice/dismiss"
  // apps/sidecar/src/engine.ts
  | "GET /mailboxes/:id/profile"
  // apps/webapp/app/api-client.ts
  | "GET /mailboxes/:id/profile-import"
  | "POST /mailboxes/:id/profile-import"
  | "POST /mailboxes/:id/profile-import/decline"
  | "POST /mailboxes/:id/profile-import/replace"
  | "GET /mailboxes/:id/profile-import/status"
  | "POST /mailboxes/:id/release"
  | "POST /mailboxes/:id/resync"
  | "GET /mailboxes/:id/self-check"
  | "POST /mailboxes/discover"
  | "GET /mailboxes/oauth/microsoft/availability"
  // apps/webapp/app/(product)/mailbox/oauth-return.ts
  | "GET /mailboxes/oauth/microsoft/callback"
  // apps/webapp/app/api-client.ts
  | "POST /mailboxes/oauth/microsoft/complete"
  | "POST /mailboxes/oauth/microsoft/device/poll"
  | "POST /mailboxes/oauth/microsoft/device/start"
  | "POST /mailboxes/oauth/microsoft/start"
  | "POST /mailboxes/probe"
  // apps/webapp/app/shell/shell-verbs.ts
  | "POST /messages/:id/draft"
  // apps/webapp/app/shell/live-body.ts
  | "GET /messages/:id/live-body"
  // apps/webapp/app/api-client.ts
  | "POST /messages/:id/load-remote"
  | "GET /oauth/authorize"
  | "POST /oauth/authorize"
  | "GET /oauth/authorize/request"
  | "POST /oauth/token"
  | "GET /pair"
  | "POST /pair"
  | "DELETE /pair/:id"
  | "POST /pair/redeem"
  // apps/sidecar/src/cloud-probe.ts
  | "POST /pair/state"
  // apps/webapp/app/api-client.ts
  | "POST /push/subscriptions"
  | "DELETE /push/subscriptions/:id"
  | "GET /push/vapid-key"
  // apps/webapp/app/shell/sender-screening.ts
  | "GET /rules"
  // apps/webapp/app/shell/SubjectRuleSheet.tsx
  | "GET /rules/:id"
  // apps/webapp/app/api-client.ts
  | "GET /screener/junk"
  | "GET /screener/junk/body"
  | "POST /screener/junk/rescue"
  | "DELETE /screener/junk/rescue/:id"
  | "GET /screener/junk/search"
  | "GET /screener/junk/sweep"
  | "POST /screener/junk/sweep"
  | "POST /screener/suggest"
  | "GET /screener/unscreened/count"
  | "GET /screener/waiting/count"
  // apps/webapp/app/shell/shell-verbs.ts
  | "GET /tags"
  // apps/sidecar/src/cloud-engine.ts
  | "GET /threads/:id"
  | "PATCH /threads/:id"
  // apps/webapp/app/api-client.ts
  | "GET /trash/window"
  | "GET /trash/window/body"
  // apps/webapp/app/shell/routing.ts
  | "GET /triage";
