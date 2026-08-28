import type { KeyProvider, PasswordHasher } from "./crypto.js";

// ── Contract §2.1 shared auth DTOs ──

export interface TwofaEnrolled {
  webauthn: boolean;
  totp: boolean;
  recoveryCodes: boolean;
}

export interface SessionUser {
  userId: string;
  accountId: string;
  email: string;
  displayName: string;
  twofaEnrolled: TwofaEnrolled;
  /**
   * Has this address been proven (`users.email_verified_at` is set)?
   *
   * Published so `JoinScreen`'s `bootstrap()` can derive the `verify` step from SERVER state
   * like every other step, rather than from client memory of whether a mail was sent. A boolean
   * and not the timestamp: the client's only question is whether the gate will let it through,
   * and the exact instant is nobody's business but ours.
   */
  emailVerified: boolean;
}

export interface LoginChallenge {
  status: "twofa_required";
  loginToken: string;
  methods: Array<"webauthn" | "totp" | "recovery_code">;
}

/**
 * The first-session DTO of onboarding. `register` — and
 * a re-entry `login` by a user with ZERO enrolled 2FA methods — returns this: an
 * ENROLLMENT-SCOPED session (`sessions.scope='enrollment'`) that reaches only the
 * `enrollmentOk` routes, carries no `lastTwofaAt` (so step-up stays out of reach),
 * has NO refresh token (it cannot be extended) and expires in `loginTokenTtlMs`.
 *
 * Unlike {@link SessionEstablished}, the token is NOT stripped from the body on the
 * web route: pre-session there is no cookie and no bearer header, so the wire
 * carries no signal of client type and the API cannot know whether it is talking to
 * a browser or to a native client that will never read a `Set-Cookie`. The token is
 * therefore returned in the body AND mirrored into `tf_session`/`tf_csrf`. It is
 * named `enrollmentToken`, never `accessToken`, because it is not one: its entire
 * blast radius is the caller's own 2FA enrollment, for ~5 minutes, and it is revoked
 * the instant a first factor lands. The FULL session that replaces it obeys the
 * original rule exactly — cookie clients never see its token in a body.
 */
export interface EnrollmentSessionEstablished {
  status: "enrollment";
  user: SessionUser;
  /** The one thing this session may do. */
  next: "enroll_2fa";
  /** The enrollment-scoped bearer token (native), also set as `tf_session` (web). */
  enrollmentToken: string;
  /** Seconds until the enrollment session dies; no refresh can extend it. */
  expiresIn: number;
}

/**
 * The PUBLIC register path's outcome, which deliberately carries no session and no
 * information about the address.
 *
 * `POST /auth/register` answers this — and ONLY this — whenever the open gate was used
 * (`publicSignup` on, no invite code offered). It is returned identically whether the address
 * was fresh (an account was created and a verification mail sent) or already registered
 * (nothing was created and an `account_exists` mail was sent). `mailed` exists for the
 * operator smoke path and the suite, which read it from INSIDE the trust boundary; the route
 * MUST NOT put it on the wire — the same rule, and the same past mistake, as
 * `WaitlistService.join`'s `mailed` field (see `routes/waitlist.ts`).
 *
 * There is intentionally no field distinguishing the two branches, not even a private one the
 * route could accidentally serialise. The branch is not represented in this type at all.
 */
export interface RegistrationPending {
  status: "verification_pending";
  /** Did a mail physically go out? INTERNAL — never serialise this. */
  mailed: boolean;
}

/**
 * `POST /auth/register`. Two shapes, discriminated on `status`:
 *  - `enrollment` — the INVITE path: 201 + an enrollment-scoped session.
 *    Reachable only by a caller who proved they hold an invite bound to this address (or an
 *    operator bootstrap code), which is what keeps its 409 `email_taken` a fact about the
 *    caller themselves rather than an oracle.
 *  - `verification_pending` — the PUBLIC path. Constant 202, no session, no cookies.
 */
export type RegistrationResult = EnrollmentSessionEstablished | RegistrationPending;

/**
 * `POST /auth/verify-email`. Two shapes, discriminated on `status`:
 *  - `enrollment` — the address is now proven AND the user has no enrolled factor, so the
 *    same enrollment session `login`'s re-entry path would have minted is returned and the
 *    wizard continues straight into the passkey step.
 *  - `verified` — the address is now proven and the user already has a factor. No session is
 *    minted: a mailed link must not be able to hand out a credential for an account that is
 *    already protected by a second factor. The caller signs in normally.
 */
export interface EmailVerified {
  status: "verified";
}

export type VerifyEmailResult = EnrollmentSessionEstablished | EmailVerified;

/**
 * `POST /auth/login` (200). Two outcomes, discriminated on `status`:
 *  - `twofa_required` — the normal path: a login token + the enrolled methods.
 *  - `enrollment` — the RE-ENTRY path: the password was correct but the user has no
 *    enrolled method, so there is no second factor to challenge. Returning
 *    `{twofa_required, methods: []}` (pre-S2 behaviour) was an unrecoverable dead
 *    end — no endpoint accepts a login token with zero methods.
 */
export type LoginResult = LoginChallenge | EnrollmentSessionEstablished;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
}

export interface SessionEstablished {
  status: "authenticated";
  user: SessionUser;
  tokens?: OAuthTokens;   // native (bearer); web moves these to cookies + strips (1f)
}

export interface RecoveryCodesResp {
  codes: string[];
  generatedAt: string;
}

/**
 * `devices.kind`'s CLOSED vocabulary — what a device row says it is, so the staleness alarm
 * and the admin/device views can name WHICH install went dark rather than "a macos".
 *
 * `"macos"` is the LEGACY spelling and stays admissible for ever: every pre-vocabulary device
 * row carries it, the shipped desktop's link-claim still declares it, and a closed set that
 * refuses its own history would 400 the installed base. It reads as "a native desktop of
 * unrecorded platform". New clients declare the platform-qualified kinds; the server accepts
 * both and never rewrites a row. `"web"` keeps its structural meaning everywhere (the one kind
 * the device staleness alarm excludes — a closed browser is not an incident).
 *
 * Clients DECLARE the platform-qualified kinds on three seams: the desktop-link claim and the
 * TOTP verify carry an optional `kind` (the desktop's two cloud doors — whitelist-gated per
 * seam in `AuthService`, never able to choose a lifetime surface), and the pairing redeem's
 * `kind` is the redeemer's own word (the mobile app sends its platform). Absent stays what it
 * always was: `"macos"` on the claim, deviceless `"web"` on the verify, `"web"` on the redeem —
 * an old client keeps minting exactly the rows it always has.
 */
export type DeviceKind =
  | "web"
  | "macos"
  | "desktop-linux" | "desktop-macos" | "desktop-windows"
  | "mobile-android" | "mobile-ios";

export interface Device {
  id: string;
  kind: DeviceKind;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string;
  current: boolean;
  /**
   * Does a `devices` row back this session? `true` = a NAMED device (a pairing redeem's
   * mint, the desktop's macos claim) — listed individually and revoked by its device id.
   * `false` = a plain browser sign-in (`device_id IS NULL`) — a client may collapse these
   * into one group, and `POST /devices/revoke-web-sessions` sweeps exactly this set.
   */
  named: boolean;
  pushToken?: { transport: "apns" | "webpush"; registeredAt: string } | null;
}

export interface AuthAuditEvent {
  at: string;
  event:
    | "login" | "login_failed" | "2fa_verified" | "2fa_failed"
    | "logout" | "device_revoked" | "recovery_used" | "lockout"
    // An ENROLLMENT-scoped session was issued on the password factor alone
    // (register, or a re-entry login with zero enrolled methods). Recorded so the
    // audit trail shows every password-only session issuance, not just full logins.
    | "enrollment_started"
    // This user's address was PROVEN — a mailed single-use token was presented together
    // with the account password. Audited because it is a privilege change (it is what opens
    // Checkout and `POST /mailboxes` via `withVerifiedEmail`), and because the pre-hijack
    // `verifyEmail` is built to prevent would, if it were ever reachable again, be visible
    // here as a verification whose `ip` does not match the registration's.
    | "email_verified"
    // A one-use desktop handoff code was minted from a step-up-cleared browser session
    // (`POST /auth/desktop-link`). Recorded because holding that code IS holding the session
    // for the next two minutes: the `login` row the claim writes carries the DESKTOP's ip and
    // would otherwise be the first and only sign that a second machine now has a rolling 400-day
    // credential. Seeing the pair — an issue here, a login from elsewhere moments later — is
    // what tells the account's owner whether that machine was theirs.
    | "desktop_link_issued"
    // Refresh-token REUSE DETECTION revoked a whole session family: a consumed token was
    // presented again outside the concurrency grace (`rotateRefresh`'s reuse branch). Recorded
    // because the sweep is otherwise SILENT on every surface — the client just starts getting
    // 401s and the server keeps no record of why (the Aug-21 incident was reconstructed from
    // raw session rows). Either a stolen token was replayed or a client's rotation is broken;
    // both are worth a row. The `device` field carries `family=<id> session=<id>` — the
    // machine-readable half an investigation starts from — instead of a user agent, which the
    // reuse presentation does not reliably have.
    | "refresh_reuse_revoked"
    // The LOST-RESPONSE RECOVERY in `rotateRefresh` re-admitted a stale cookie presentation:
    // a consumed token was re-presented outside the concurrency grace, but its family's tail
    // had NEVER been used — the shape a browser leaves when a rotation committed server-side
    // and the response never landed (lid closed mid-refresh; measured twice on one account,
    // 2026-08-27/28). The dormant tail is consumed in the same act and a fresh rotation
    // issued, so exactly one live tip exists afterwards. Recorded because recovery is the one
    // place a stale token buys a working credential, and an investigation must be able to see
    // every such re-admission next to the reuse sweeps. The `device` field carries
    // `family=<id> session=<id>`, the reuse row's exact convention.
    | "refresh_recovered";
  method?: "webauthn" | "totp" | "recovery_code" | "password";
  ip: string;
  device?: string;
}

// ── Configuration & dependency injection ──

/* THE CONFIGURATION SHAPE lives in `config-types.ts`, and this file keeps the ceremony. The
 * split is about who may NAME what: origin validation and the defaults builder run in every
 * deployment, including one that performs no registration, no passkey enrolment and no second
 * factor, and they must be able to describe a configuration without naming the DTOs of a
 * ceremony they never run. Re-exported, so no existing import moves. */
export type { AuthConfig } from "./config-types.js";
import type { AuthConfig } from "./config-types.js";

export interface AuthDeps {
  config: AuthConfig;
  keyProvider: KeyProvider;
  passwordHasher: PasswordHasher;
  /**
   * The customer mailer, or absent/null on a deployment with none.
   *
   * OPTIONAL, and its absence is a first-class state rather than a misconfiguration — the same
   * shape `WaitlistService` uses, and for the same reason: recording a signup must not depend on
   * Resend being reachable. It is typed as the POLICY object (`MailService`) and never as a bare
   * `MailerPort`, because a service holding the port holds an unthrottled mail-bomb primitive
   * (see `mail/port.ts`).
   *
   * One consequence is enforced rather than documented: with `publicSignup` on and this absent,
   * `register` refuses `503 signup_unavailable` instead of creating accounts whose only
   * continuation is a mail that cannot be sent. See that method.
   */
  mail?: import("../mail/mail-service.js").MailService | null;
}
