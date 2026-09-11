import { matchSpec } from "./match-path.js";
import { MalformedPathError, normalizePathname } from "./canonical-path.js";

/**
 * Which routes a Cloud-mode install's write-through relay may forward to the server its door
 * names. A projection of `Route.relay`, not a second opinion — `relay-allowlist-census.test.ts`
 * fails if the two disagree either way. It is a file rather than a derivation because the sidecar
 * cannot import handlers: that would pull the IMAP adapter into an engine whose census keeps it
 * out. The matcher and canonicalizer imported here have no imports of their own.
 */

export interface RelaySpec {
  readonly method: string;
  readonly pattern: string;
}

/** The relayable routes, sorted. Generated from `Route.relay`; the census holds it in step. */
export const RELAY_ALLOWLIST: readonly RelaySpec[] = [
  { method: "DELETE", pattern: "/account" },
  { method: "DELETE", pattern: "/auth/2fa/totp" },
  { method: "DELETE", pattern: "/devices/:id" },
  { method: "DELETE", pattern: "/drafts/:id" },
  { method: "DELETE", pattern: "/drafts/:id/schedule" },
  { method: "DELETE", pattern: "/folders/:id" },
  { method: "DELETE", pattern: "/folders/:id/op" },
  { method: "DELETE", pattern: "/kb/:id" },
  { method: "DELETE", pattern: "/mailboxes/:id" },
  { method: "DELETE", pattern: "/messages/:id" },
  { method: "DELETE", pattern: "/notes/:id" },
  { method: "DELETE", pattern: "/notify-rules/:id" },
  { method: "DELETE", pattern: "/pair/:id" },
  { method: "DELETE", pattern: "/push/subscriptions/:id" },
  { method: "DELETE", pattern: "/rules/:id" },
  { method: "DELETE", pattern: "/snippets/:id" },
  { method: "DELETE", pattern: "/tags/:id" },
  { method: "DELETE", pattern: "/workflows/:id" },
  { method: "GET", pattern: "/account/access" },
  { method: "GET", pattern: "/account/ai" },
  { method: "GET", pattern: "/account/screening" },
  { method: "GET", pattern: "/approvals" },
  { method: "GET", pattern: "/attachments/:id" },
  { method: "GET", pattern: "/attachments/:id/meta" },
  { method: "GET", pattern: "/auth/audit" },
  { method: "GET", pattern: "/auth/session" },
  { method: "GET", pattern: "/away-responder" },
  { method: "GET", pattern: "/consent" },
  { method: "GET", pattern: "/consent/reset" },
  { method: "GET", pattern: "/consent/seed" },
  { method: "GET", pattern: "/contacts" },
  { method: "GET", pattern: "/contacts/:id" },
  { method: "GET", pattern: "/contacts/:id/notes" },
  { method: "GET", pattern: "/devices" },
  { method: "GET", pattern: "/drafts/:id" },
  { method: "GET", pattern: "/events" },
  { method: "GET", pattern: "/files" },
  { method: "GET", pattern: "/folders/:id/summary" },
  { method: "GET", pattern: "/health" },
  { method: "GET", pattern: "/hello" },
  { method: "GET", pattern: "/img" },
  { method: "GET", pattern: "/kb" },
  { method: "GET", pattern: "/kb/:id" },
  { method: "GET", pattern: "/mailboxes" },
  { method: "GET", pattern: "/mailboxes/:id" },
  { method: "GET", pattern: "/mailboxes/:id/organizer" },
  { method: "GET", pattern: "/mailboxes/:id/profile" },
  { method: "GET", pattern: "/mailboxes/:id/profile-import" },
  { method: "GET", pattern: "/mailboxes/oauth/microsoft/availability" },
  { method: "GET", pattern: "/mailboxes/oauth/microsoft/callback" },
  { method: "GET", pattern: "/messages" },
  { method: "GET", pattern: "/messages/:id" },
  { method: "GET", pattern: "/messages/:id/attachments" },
  { method: "GET", pattern: "/messages/:id/body" },
  { method: "GET", pattern: "/messages/:id/tracker-events" },
  { method: "GET", pattern: "/messages/bodies" },
  { method: "GET", pattern: "/notify-rules" },
  { method: "GET", pattern: "/pair" },
  { method: "GET", pattern: "/push/vapid-key" },
  { method: "GET", pattern: "/rules" },
  { method: "GET", pattern: "/rules/:id" },
  { method: "GET", pattern: "/screener" },
  { method: "GET", pattern: "/screener/junk" },
  { method: "GET", pattern: "/screener/junk/body" },
  { method: "GET", pattern: "/screener/junk/search" },
  { method: "GET", pattern: "/screener/junk/sweep" },
  { method: "GET", pattern: "/search" },
  { method: "GET", pattern: "/snippets" },
  { method: "GET", pattern: "/snippets/:id" },
  { method: "GET", pattern: "/sync" },
  { method: "GET", pattern: "/sync/snapshot" },
  { method: "GET", pattern: "/tags" },
  { method: "GET", pattern: "/threads/:id" },
  { method: "GET", pattern: "/threads/:id/notes" },
  { method: "GET", pattern: "/tracker-events" },
  { method: "GET", pattern: "/trash/window" },
  { method: "GET", pattern: "/trash/window/body" },
  { method: "GET", pattern: "/trash/window/search" },
  { method: "GET", pattern: "/triage" },
  { method: "GET", pattern: "/views/focus-reply" },
  { method: "GET", pattern: "/views/power-through" },
  { method: "GET", pattern: "/workflow-runs" },
  { method: "GET", pattern: "/workflows" },
  { method: "GET", pattern: "/workflows/:id" },
  { method: "GET", pattern: "/workflows/proposals" },
  { method: "PATCH", pattern: "/account/ai" },
  { method: "PATCH", pattern: "/account/screening" },
  { method: "PATCH", pattern: "/consent/settings" },
  { method: "PATCH", pattern: "/contacts/:id" },
  { method: "PATCH", pattern: "/folders/:id" },
  { method: "PATCH", pattern: "/mailboxes/:id" },
  { method: "PATCH", pattern: "/messages" },
  { method: "PATCH", pattern: "/messages/:id" },
  { method: "PATCH", pattern: "/notes/:id" },
  { method: "PATCH", pattern: "/rules/:id" },
  { method: "PATCH", pattern: "/tags/:id" },
  { method: "PATCH", pattern: "/threads/:id" },
  { method: "PATCH", pattern: "/workflows/:id" },
  { method: "POST", pattern: "/account/manage-link" },
  { method: "POST", pattern: "/approvals/:id" },
  { method: "POST", pattern: "/attachments/staging" },
  { method: "POST", pattern: "/auth/2fa/recovery-codes" },
  { method: "POST", pattern: "/auth/2fa/totp/activate" },
  { method: "POST", pattern: "/auth/2fa/totp/enroll" },
  { method: "POST", pattern: "/auth/2fa/webauthn/assert/options" },
  { method: "POST", pattern: "/auth/2fa/webauthn/register/options" },
  { method: "POST", pattern: "/auth/2fa/webauthn/register/verify" },
  { method: "POST", pattern: "/auth/logout" },
  { method: "POST", pattern: "/auth/step-up/totp" },
  { method: "POST", pattern: "/auth/step-up/webauthn/options" },
  { method: "POST", pattern: "/auth/step-up/webauthn/verify" },
  { method: "POST", pattern: "/auth/verify-email/resend" },
  { method: "POST", pattern: "/consent/reset" },
  { method: "POST", pattern: "/consent/seed" },
  { method: "POST", pattern: "/contacts/:id/notes" },
  { method: "POST", pattern: "/devices/revoke-web-sessions" },
  { method: "POST", pattern: "/drafts" },
  { method: "POST", pattern: "/drafts/:id/resolve" },
  { method: "POST", pattern: "/drafts/:id/schedule" },
  { method: "POST", pattern: "/drafts/:id/send" },
  { method: "POST", pattern: "/files/download-all" },
  { method: "POST", pattern: "/folders" },
  { method: "POST", pattern: "/kb" },
  { method: "POST", pattern: "/mailboxes" },
  { method: "POST", pattern: "/mailboxes/:id/inbound-quiet/dismiss" },
  { method: "POST", pattern: "/mailboxes/:id/organize" },
  { method: "POST", pattern: "/mailboxes/:id/organizer-notice/dismiss" },
  { method: "POST", pattern: "/mailboxes/:id/profile-import" },
  { method: "POST", pattern: "/mailboxes/:id/profile-import/decline" },
  { method: "POST", pattern: "/mailboxes/:id/release" },
  { method: "POST", pattern: "/mailboxes/:id/resync" },
  { method: "POST", pattern: "/mailboxes/oauth/microsoft/complete" },
  { method: "POST", pattern: "/mailboxes/oauth/microsoft/device/poll" },
  { method: "POST", pattern: "/mailboxes/oauth/microsoft/device/start" },
  { method: "POST", pattern: "/mailboxes/oauth/microsoft/start" },
  { method: "POST", pattern: "/mailboxes/probe" },
  { method: "POST", pattern: "/messages/:id/attachments/download-all" },
  { method: "POST", pattern: "/messages/:id/draft" },
  { method: "POST", pattern: "/messages/:id/load-remote" },
  { method: "POST", pattern: "/messages/:id/move" },
  { method: "POST", pattern: "/messages/:id/restore" },
  { method: "POST", pattern: "/messages/:id/tags" },
  { method: "POST", pattern: "/messages/:id/triage" },
  { method: "POST", pattern: "/messages/:id/unsubscribe" },
  { method: "POST", pattern: "/notify-rules" },
  { method: "POST", pattern: "/pair" },
  { method: "POST", pattern: "/push/subscriptions" },
  { method: "POST", pattern: "/rules" },
  { method: "POST", pattern: "/screener/:id" },
  { method: "POST", pattern: "/screener/junk/rescue" },
  { method: "POST", pattern: "/screener/junk/sweep" },
  { method: "POST", pattern: "/screener/suggest" },
  { method: "POST", pattern: "/snippets" },
  { method: "POST", pattern: "/sync/pull" },
  { method: "POST", pattern: "/tags" },
  { method: "POST", pattern: "/threads/:id/notes" },
  { method: "POST", pattern: "/threads/:id/rename" },
  { method: "POST", pattern: "/threads/merge" },
  { method: "POST", pattern: "/workflow-runs/:id/undo" },
  { method: "POST", pattern: "/workflows" },
  { method: "POST", pattern: "/workflows/:id/run" },
  { method: "POST", pattern: "/workflows/proposals/:id/dismiss" },
  { method: "PUT", pattern: "/away-responder" },
  { method: "PUT", pattern: "/drafts/:id" },
  { method: "PUT", pattern: "/kb/:id" },
  { method: "PUT", pattern: "/snippets/:id" },
];

/** The two hand-off routes, which earn their own sentence rather than a bare refusal. */
const HANDOFF = new Set(["POST /auth/desktop-claim", "POST /auth/desktop-link"]);

/**
 * What the relay should do with this request. `handoff` is a refusal too — it selects the wording,
 * decided on the CANONICAL path so every spelling of the hand-off route gets the sentence about
 * signing in instead. Case is not folded, so `/AUTH/Desktop-Claim` is refused as the 404 it is.
 */
export function relayVerdict(method: string, pathname: string): "forward" | "handoff" | "refuse" {
  let canonical: string;
  try {
    canonical = normalizePathname(pathname);
  } catch (err) {
    if (err instanceof MalformedPathError) return "refuse";
    throw err;
  }
  if (matchSpec(RELAY_ALLOWLIST, method, canonical).matched) return "forward";
  return HANDOFF.has(`${method.toUpperCase()} ${canonical}`) ? "handoff" : "refuse";
}

/** True when this request may be forwarded at all. */
export function mayRelay(method: string, pathname: string): boolean {
  return relayVerdict(method, pathname) === "forward";
}
