/**
 * THE AUTH CONFIGURATION — the shape a deployment states, with nothing that performs a ceremony.
 *
 * It sits apart from the ceremony DTOs next door for one reason: modules that merely READ a
 * configuration are shared. Origin validation and the defaults builder run in every deployment,
 * including a local install that mints and resolves a per-launch session and performs no
 * registration, no passkey enrolment and no second factor at all. Those modules need this
 * interface; they must not need the vocabulary of a ceremony they never run.
 *
 * A type-only import is erased from the emitted JavaScript and is still perfectly visible in the
 * source, which is where it counted — the shared modules named the ceremony's own module in order
 * to describe their argument. `types.ts` re-exports this, so nothing that already imports
 * `AuthConfig` from there has to move.
 */

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
   * **OPEN REGISTRATION.** `false` — the default, and what every test runs against:
   * `POST /auth/register` demands an invite code and refuses without one.
   *
   * `true` makes the invite code OPTIONAL, and that is the whole of the change to the
   * authorization decision. What does NOT change:
   *
   *  · a code that IS supplied is still consumed and validated exactly as before — used,
   *    expired, revoked and bound-elsewhere each keep their own refusal. The tempting
   *    reading ("the gate is open, so anything goes") would let a REVOKED code succeed,
   *    which would make revocation — the documented remedy for a leaked or misdirected
   *    invite — a no-op the moment this flag flipped. The branch is therefore on whether a
   *    code was OFFERED, never on whether one was REQUIRED;
   *  · every ceremony downstream: the enrollment-scoped session, 2FA enrollment,
   *    recovery codes behind their own independent step-up, and the step-up +
   *    mailbox-allowance gate on `POST /mailboxes`. One gate is removed, not the ceremony;
   *  · `consumeInvite`'s transaction semantics and every billing-ledger path.
   *
   * Two things it DOES change, both because the invite row was silently carrying them:
   *
   *  · the per-IP registration limit tightens to {@link maxPublicRegistrationsPerWindow},
   *    because an email-bound invite row was what bounded a stranger before;
   *  · an UNKNOWN client IP stops meaning "skip the limit" and starts meaning "refuse".
   *    Under invite-gating an unkeyable limiter was a bounded loss — the invite row still
   *    bounded the request. With the gate open there is nothing else, and "no IP ⇒
   *    unlimited account creation" is the entire abuse surface.
   *
   * **What it must NOT open is an account-existence oracle, and closing that took work.**
   * An earlier version of the open path answered 201 for a fresh address and 409
   * `email_taken` for a registered one; with no email binding to constrain which address a
   * caller may type, that split is a probe anyone can run over any address they like. The
   * open path therefore answers a CONSTANT 202 with no session and no `Set-Cookie`,
   * byte-identically for a fresh address and for one that already has an account. The news
   * a real person needs — "check your mail", or "you already have an account, sign in" — is
   * delivered by the verification mail instead, which only the address owner can read.
   * `AuthService.register` documents the full shape.
   *
   * The INVITE path is unchanged and still answers 409 `email_taken`. That is not an oracle:
   * `consumeInvite` is email-BOUND, so the only address a caller can put through it is one
   * an operator mailed them a code for, and the 409 tells them a fact about themselves.
   *
   * {@link maxPublicRegistrationsPerWindow} still bounds the open endpoint — but it now
   * bounds outbound MAIL rather than a probe.
   */
  publicSignup: boolean;
  /**
   * The CAPACITY VALVE. `null` ⇒ uncapped.
   *
   * When {@link publicSignup} is on and the deployment already holds this many accounts,
   * the OPEN path answers `signup_capacity` (503) and the client sends the visitor to the
   * waitlist — which is what the waitlist is for once it is no longer the front door.
   *
   * **The invite path is never capped.** An operator who mints an invite has already made
   * the capacity decision by hand, and a cap that locked out the people we invited would be
   * the valve closing on the wrong side.
   *
   * A SOFT cap, and documented as one: the count and the insert share a transaction, but
   * READ COMMITTED lets two concurrent registrations both read `cap - 1`, so the real
   * ceiling is "cap, plus however many signups land in the same instant". A hard cap needs
   * a serialized counter row — a write lock on every signup, to enforce a number an
   * operator picked as a rough limit.
   */
  publicSignupCap: number | null;
  /** Registered native OAuth clients → their allowed redirect URIs. */
  oauthClients: Record<string, { redirectUris: string[] }>;
  // Lifetimes (ms)
  accessTtlMs: number;
  refreshTtlMs: number;
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
  /** Hard ceiling on a sliding session, from `sessions.created_at`. 90 d — see config.ts. */
  sessionAbsoluteTtlMs: number;
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
   * How many `POST /auth/desktop-claim` attempts one client may make per `failureWindowMs`.
   *
   * A SLOT CLAIM answering 429 `rate_limited`, never the 423 lockout: the claim names no
   * account until the code has already been read, so there is nothing to lock, and a counter
   * keyed on a value the caller chooses is a denial of service handed to whoever is attacking.
   *
   * Ten, because this is a value a person RETYPES: a mistyped code, a code that expired while
   * they looked for the window, and a second attempt after each is four before anything has
   * gone wrong. It is not the guess bound — the code's own 128 bits are — it is the bound on
   * an anonymous caller's ability to make this endpoint do database work.
   */
  maxDesktopClaimsPerWindow: number;
  // TOTP
  totpIssuer: string;
  totpWindow: number;          // ± steps of clock-skew tolerance
}
