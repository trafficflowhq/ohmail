/**
 * The `/auth` entry — the session and pairing lifecycles, WITHOUT the ceremony, the barrel's side
 * effects, or the mail transports. Three entries, each a strict widening: `./mail` — session
 * RESOLUTION only; `./auth` — THIS FILE: `SessionLifecycle` plus the pairing-token lifecycle; `.`
 * — the whole hosted layer. Loading this entry does NOT register any default, load `nodemailer`,
 * load anything stripe-adjacent, or load the Cloud half — the load-bearing clause: the sidecar
 * imports this entry, so its graph ships in the public engine artifact, where the build census
 * refuses cloud-half inputs. `auth-entry-census.test.ts` pins every clause. `AuthService` is
 * deliberately not re-exported: its module names the Cloud schema.
 */

export {
  SessionLifecycle, makeSessionLifecycle, PAIRED_DEVICE_KINDS,
  assertWebSessionAge,
  REVOKE_WEB_SESSIONS_MIN_AGE_DAYS, REVOKE_WEB_SESSIONS_MAX_AGE_DAYS,
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
