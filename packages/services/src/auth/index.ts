export {
  AuthService, makeAuthService, DESKTOP_LINK_PURPOSE,
  type AuthorizeQuery, type TokenBodyAuthCode, type TokenBodyRefresh,
} from "./auth-service.js";
// The session MACHINERY `AuthService` extends — carved out in Phase 3 so the desktop engine
// can run it without the ceremony. See `session-lifecycle.ts`'s header for the boundary.
export {
  SessionLifecycle, makeSessionLifecycle, PAIRED_DEVICE_KINDS,
  type SessionLifecycleDeps, type PairedDeviceKind,
} from "./session-lifecycle.js";
// The stale-web-session reaper — HOSTED-barrel only, deliberately: `src/auth.ts` (the engine
// entry) must not re-export it, because a hosted maintenance pass has no business in the
// public engine artifact's graph. Its one caller is `GET /internal/sessions/reap`.
export { reapStaleWebSessions, type ReapResult } from "./session-reaper.js";
export {
  scryptHasher, generateToken, hashToken, sha256,
  StaticKeyProvider,
  type PasswordHasher, type KeyProvider,
} from "./crypto.js";
export { DEFAULT_AUTH_CONFIG, makeAuthConfig, surfaceTtls, type SurfaceTtls } from "./config.js";
export type { SessionSurface } from "./config-types.js";
/* The test fixture moved out of `config.ts` so that the module every deployment loads no longer
 * names the hosted mailer through `AuthDeps`. Re-exported here so no test import changed. */
export { makeTestAuthDeps } from "./test-deps.js";
// The multi-origin WebAuthn allow-list. `packages/api` needs
// `isAllowedOrigin` for the cross-site guard; the rest is the ceremony contract.
export {
  allowedOrigins, assertOriginConfig, defaultOrigin, isAllowedOrigin,
  normalizeOrigin, tryNormalizeOrigin, resolveCeremonyOrigin,
} from "./origins.js";
// TOTP helper re-exported so the HTTP/test layer (1f) can compute a valid code
// without depending on otplib directly.
//
// Widened to the whole primitive set for staff sign-in. The admin console performs its
// own enrolment and verification against `staff_users` — a table the product's AuthService
// deliberately never queries (see `packages/db/src/schema.ts:staffUsers`) — so it needs the
// primitives rather than the service. Exported HERE rather than importing `otplib` a second
// time in `packages/api`, so there stays exactly one TOTP implementation in the repository and
// the replay guard cannot be re-derived slightly differently by a second caller.
export { totpNow, newTotpSecret, totpUri, verifyTotp, type TotpVerification } from "./totp.js";
export { resolveSession, type ResolvedSessionCore, type SessionScope } from "./resolve-session.js";
export type {
  AuthConfig, AuthDeps,
  SessionUser, TwofaEnrolled, LoginChallenge, SessionEstablished, OAuthTokens,
  RecoveryCodesResp, Device, AuthAuditEvent,
  // The enrollment-scoped first session.
  EnrollmentSessionEstablished, RegistrationResult, LoginResult,
  // The public register path's constant acknowledgement, and the two shapes
  // `POST /auth/verify-email` answers with.
  RegistrationPending, VerifyEmailResult, EmailVerified,
} from "./types.js";
