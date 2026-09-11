/**
 * The auth configuration — the shape a deployment states, with nothing that performs a ceremony.
 * Apart from the ceremony DTOs because modules that merely READ a configuration are shared:
 * origin validation and the defaults builder run in every deployment, including a local install
 * that mints a per-launch session and runs no registration or second factor — those modules need
 * this interface, not the vocabulary of a ceremony they never run. A type-only import is erased
 * from the emitted JavaScript but visible in the source, which is where it counted. `types.ts`
 * re-exports this, so existing importers of `AuthConfig` need not move.
 */

/**
 * Which door a session came through, for the two decisions that differ by door. `cookie` — the
 * browser: `tf_refresh`, HttpOnly, host-only, one jar shared by every tab; the STRICT surface for
 * lifetimes and the DEFAULT wherever a surface is not stated (see `surfaceTtls`). `native` — a
 * bearer client holding its token privately: the desktop sidecar's body branch and the OAuth
 * `refresh_token` grant. NOT the same axis as `concurrentGrace`: their strict ends point in
 * OPPOSITE directions — the strict LIFETIME is the cookie one (shorter), the strict REUSE
 * response is the native one (no grace). One flag would weaken one of them, and deriving grace
 * from a cookie-defaulting surface would hand the OAuth grant a replay window.
 */
export type SessionSurface = "cookie" | "native";

export interface AuthConfig {
  /**
   * WebAuthn Relying-Party id (bare host, no scheme, no port). SINGLE-valued by
   * design: it is what a credential is scoped to, so `app.ohmail.app` covers
   * `app.ohmail.app` AND every `*.app.ohmail.app` origin with ONE credential store.
   * Validated at construction to be a registrable-domain suffix of every entry in
   * {@link origin} — see `origins.ts`.
   */
  rpID: string;
  rpName: string;
  /**
   * Expected browser origin(s) for WebAuthn ceremonies (scheme+host+port).
   *
   * Either ONE string, or an ALLOW-LIST. The canonical form is `allowedOrigins(cfg)`;
   * a ceremony is admitted only from a listed origin and is then BOUND to the one that
   * opened it. A host that only ever REDIRECTS must never appear here — a browser follows
   * the redirect, so no ceremony can begin or complete on one. See `origins.ts` for both
   * rules, the redirect-host list, and the rpID-suffix requirement.
   */
  origin: string | string[];
  /** Accepted registration invite codes (single-tenant, invite-gated). */
  inviteCodes: Set<string>;
  /**
   * Open registration. `false` — the default: `POST /auth/register` demands an invite code.
   * `true` makes the code OPTIONAL, and that is the whole change: an OFFERED code is still
   * consumed and validated — a revoked code must refuse. The per-IP limit tightens to {@link
   * maxPublicRegistrationsPerWindow}, and an UNKNOWN client IP refuses instead of skipping the
   * limit. No account-existence oracle: the open path answers a CONSTANT 202 with no session,
   * byte-identical for fresh and registered addresses — the news arrives in the verification
   * mail. The INVITE path still answers 409 `email_taken`: `consumeInvite` is email-BOUND, so
   * that 409 tells the caller a fact about themselves.
   */
  publicSignup: boolean;
  /**
   * The capacity valve. `null` = uncapped. When {@link publicSignup} is on and the deployment
   * already holds this many accounts, the OPEN path answers `signup_capacity` (503) and the
   * visitor goes to the waitlist — which is what the waitlist is for once it is no longer the
   * front door. The invite path is never capped: an operator who mints an invite has already made
   * the capacity decision, and a cap that locked out invited people would close the valve on the
   * wrong side. A SOFT cap: the count and the insert share a transaction, but READ COMMITTED lets
   * two concurrent registrations both read `cap - 1` — a hard cap needs a serialized counter row,
   * a write lock on every signup, to enforce a rough limit.
   */
  publicSignupCap: number | null;
  /** Registered native OAuth clients → their allowed redirect URIs. */
  oauthClients: Record<string, { redirectUris: string[] }>;
  // Lifetimes (ms)
  accessTtlMs: number;
  /**
   * The ROLLING refresh window of the COOKIE surface — and the value every unqualified reader
   * gets, deliberately: it is the SHORTER of the two, so a caller that never learned about
   * surfaces cannot hand out the long one. `cookies.ts` reads exactly this for the `tf_refresh` /
   * `tf_resume` / `tf_owner` `Max-Age`, so the browser's copy and the stored refresh row can
   * never describe different windows. Rolling means rolling: every rotation re-issues it from
   * NOW, and with {@link sessionAbsoluteTtlMs} null nothing bounds the chain. See `config.ts` for
   * the number and the argument.
   */
  refreshTtlMs: number;
  /**
   * The same window for the NATIVE/BEARER surface. Longer, because the desktop app rotates on
   * every launch and being signed out of your own mail client is the failure this exists to
   * prevent; see `config.ts`.
   */
  nativeRefreshTtlMs: number;
  loginTokenTtlMs: number;
  webauthnChallengeTtlMs: number;
  oauthCodeTtlMs: number;
  /**
   * How long a `POST /auth/desktop-link` code stays claimable.
   *
   * It is the ONE bound that is not about an attacker's search space: 128 bits of entropy
   * cannot be guessed, so what this limits is the window in which a code that has been SEEN —
   * over a shoulder, in a screen share, in a screenshot somebody kept — is still worth
   * anything. See `config.ts` for why two minutes and not less.
   */
  desktopLinkTtlMs: number;
  stepUpWindowMs: number;      // 5 min
  /**
   * Hard ceiling on a rolling COOKIE session, measured from `sessions.created_at` —
   * or `null` for NO ceiling, which is what a genuinely rolling window means and what
   * ohmail.app runs. See `config.ts` for why the cookie surface gives its ceiling up.
   *
   * `null` is not "unset". `rotateRefresh` reads it as an explicit decision and skips the cap
   * entirely; any non-null value is still enforced, on whichever surface carries it, and
   * `session-lifetime.test.ts` pins that enforcement against a config that sets one — so this
   * staying null on the shipped surfaces never becomes a quietly dead code path.
   */
  sessionAbsoluteTtlMs: number | null;
  /** The same ceiling for the NATIVE/BEARER surface. `null` — see `config.ts`. */
  nativeSessionAbsoluteTtlMs: number | null;
  /**
   * How long after a refresh token is CONSUMED a second presentation reads as a benign CONCURRENT
   * rotation rather than theft — on the COOKIE surface ONLY (`AuthService.rotateRefresh` applies
   * it when the `/auth/refresh` cookie branch passes `concurrentGrace`). Reuse detection cannot,
   * at one instant, tell "two tabs refreshing together" from "a stolen token replayed" —
   * byte-identical on the wire — so the distinction is keyed on TIME-SINCE-CONSUMED: a duplicate
   * inside the window (a second tab or client sharing one jar races structurally) is re-rotated
   * off the live family; anything after it still revokes the whole family. Native/bearer and the
   * OAuth grant never pass grace: they stay strict.
   */
  refreshReuseGraceMs: number;
  // Lockout
  maxFailures: number;
  lockoutMs: number;
  failureWindowMs: number;
  /**
   * How many `POST /auth/register` attempts one client may make per `failureWindowMs`.
   * `inviteCodes` is a reusable shared secret, so this — not the invite code — is what
   * bounds account creation and email-existence probing from a leaked bootstrap code.
   *
   * The counter is a SLOT CLAIM (`reserveIpSlot`) answering **429 `rate_limited`**
   * rather than the lockout counter's 423 `account_locked` "too many failed attempts",
   * which was false in every word on this endpoint. See `ip-throttle.ts`.
   */
  maxRegistrationsPerWindow: number;
  /**
   * The same limit, for the OPEN path, and it is tighter for a reason.
   *
   * With {@link publicSignup} on, this per-IP counter is the only thing bounding both
   * account creation and the mail the open path sends to whatever address a caller types.
   * A real person needs one signup and maybe a retry; a sweep needs thousands. Five per
   * `failureWindowMs` costs a legitimate visitor nothing and prices a single-IP sweep at
   * ~480 addresses a day, which is the difference between a nuisance and a bulk mailer.
   */
  maxPublicRegistrationsPerWindow: number;
  /**
   * How many `POST /auth/desktop-claim` attempts one client may make per `failureWindowMs`. A
   * SLOT CLAIM answering 429, never the 423 lockout: the claim names no account until the code
   * has been read, so there is nothing to lock, and a counter keyed on a value the caller chooses
   * is a denial of service handed to the attacker. Ten, because this is a value a person RETYPES:
   * a mistyped code, one that expired while they looked for the window, and a retry after each is
   * four before anything went wrong. It is not the guess bound — the code's 128 bits are — it
   * bounds an anonymous caller's ability to make this endpoint do database work.
   */
  maxDesktopClaimsPerWindow: number;
  // TOTP
  totpIssuer: string;
  totpWindow: number;          // ± steps of clock-skew tolerance
}
