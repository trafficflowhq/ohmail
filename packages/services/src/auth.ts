/**
 * ═══ THE `/auth` ENTRY — the session LIFECYCLE and the pairing lifecycle, WITHOUT the ceremony,
 *     without the barrel's side effects, and without the transactional-mail transports ═════════
 *
 * Three entries now tell one story, each a strict widening of the last:
 *
 *  · `./mail`  — session RESOLUTION only (`resolveSession`): look a session up. The engine
 *    barrel; its header owns the argument for everything it excludes.
 *  · `./auth`  — THIS FILE: the session lifecycle (`SessionLifecycle`: establish, refresh
 *    rotation with reuse detection, family revocation, logout, devices, the paired-device
 *    mint) plus the pairing-token lifecycle (mint/list/revoke/consume, the device-pair
 *    redeem). What a session IS once it exists, and how a new device becomes one.
 *  · `.`       — the whole hosted service layer: the identity CEREMONY (`AuthService`),
 *    invites, billing, the SMTP transport, and the paid-gate registration side effect.
 *
 * WHY IT EXISTS (Phase 3 — the barrel-creep obligation): `routes/pair.ts` imported the FULL
 * barrel, so the day the desktop-host door mounted a pairing route, `nodemailer` (via the
 * barrel's `SmtpMailer` re-export) and the paid-gate registration (the barrel's ONE side
 * effect, lines it performs at import) would have entered the shipped engine bundle. This entry
 * is the import pair.ts and the host modules use instead, and it is defined by what loading it
 * does NOT do:
 *
 *  · **no side effects** — nothing here registers a default anywhere; the paid gate is declared
 *    by the FULL barrel because loading that barrel is what makes a process a hosted one.
 *  · **no `nodemailer`**, no transactional-mail barrel, no `SmtpMailer`.
 *  · **no stripe-adjacent module** — nothing under `entitlements/`, no `mailbox-allowance`.
 *  · **no Cloud half** — no `@trafficflow/db/cloud`, no `context-cloud`, no `invites.ts`, no
 *    `pairing-invite.ts` (the invite-grant redeem is the one pairing arm that queries the
 *    Cloud-half `invites` table; it stays full-barrel-only, and the desktop-host door refuses
 *    the grant instead). This is stricter than the no-nodemailer obligation and it is the
 *    load-bearing half: the sidecar's service bag imports this entry, so this entry's module
 *    graph ships in the public engine artifact, where the build census refuses any cloud-half
 *    input outright.
 *
 * `auth-entry-census.test.ts` walks this file's resolved graph and pins every clause above,
 * with the mutations named beside the assertions. The identity ceremony itself — `AuthService`,
 * register/login/factors/PKCE — is deliberately NOT here even as a re-export: its module names
 * the Cloud schema, so one `export { AuthService }` line would put the private half back into
 * every consumer of this entry. Hosted code keeps importing it from the barrel.
 */

export {
  SessionLifecycle, makeSessionLifecycle,
  type SessionLifecycleDeps, type PairedDeviceKind,
} from "./auth/session-lifecycle.js";
export {
  mintPairingToken, listPairingTokens, revokePairingToken, consumePairingToken,
  redeemDevicePair, pairingInvalid,
  PAIRING_TTL_BOUNDS, PAIRING_LABEL_MAX, PAIRING_LIVE_TOKENS_MAX,
  type PairingGrant, type PairingTokenMinted, type PairingTokenListed, type PairingTokenStatus,
  type PairingConsumed, type PairedDeviceSessionMinter,
} from "./pairing.js";
// The leaves the lifecycle is built from, so a consumer of this entry never needs the barrel
// for them: the crypto primitives, the config constructor, and session resolution — the same
// set `./mail` exports, because the two entries must agree on what a token and a config are.
export {
  scryptHasher, generateToken, hashToken, sha256,
  StaticKeyProvider,
  type PasswordHasher, type KeyProvider,
} from "./auth/crypto.js";
export { DEFAULT_AUTH_CONFIG, makeAuthConfig, surfaceTtls, type SurfaceTtls } from "./auth/config.js";
export type { AuthConfig, SessionSurface } from "./auth/config-types.js";
export { resolveSession, type ResolvedSessionCore, type SessionScope } from "./auth/resolve-session.js";
export { ServiceError } from "./errors.js";
export type { ServiceContext, Db } from "./context.js";
export type {
  OAuthTokens, Device, SessionUser, TwofaEnrolled, SessionEstablished, AuthDeps, AuthAuditEvent,
} from "./auth/types.js";
