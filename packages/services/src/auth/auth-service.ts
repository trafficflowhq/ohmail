import { randomInt, randomUUID } from "node:crypto";
// `lt` is imported UNDER AN ALIAS: `lt` is the local name every 2FA verify uses for its
// login-token row, and the shadowing turns a comparison into "call an object".
import { and, count, desc, eq, gt, isNull, lt as lessThan, or, sql } from "drizzle-orm";
import { accounts, users, devices, sessions, type Tx } from "@trafficflow/db";
import {
  credentials,
  webauthnCredentials,
  webauthnChallenges,
  totpSecrets,
  recoveryCodes,
  loginTokens,
  oauthAuthCodes,
  authEvents,
  authThrottle,
  invites,
  waitlist,
  pushSubscriptions,
} from "@trafficflow/db/cloud";
import type { ServiceContext } from "../context.js";
import { ServiceError } from "../errors.js";
import { consumeInvite, inviteError, normalizeInviteCode } from "../invites.js";
import { reserveIpSlot } from "../ip-throttle.js";
// The ONE definition of "a valid address" — see {@link requireEmail} for why registration
// borrows the mailer's predicate instead of growing a second one.
import { normalizeRecipient } from "../mail/port.js";
// The token `purpose` the mail service mints verification links under. Imported rather than
// re-spelled: a second literal here that drifted from the mail service's would make `verifyEmail`
// peek at rows `consumeEmailVerification` cannot consume, i.e. a link that validates and never
// works.
import { EMAIL_VERIFY_PURPOSE } from "../mail/mail-service.js";
import { generateToken, hashToken, sha256, type PasswordHasher } from "./crypto.js";
import type { AuthDeps, AuthConfig } from "./types.js";
import type {
  SessionUser, TwofaEnrolled, LoginResult, SessionEstablished, OAuthTokens,
  RecoveryCodesResp, AuthAuditEvent, DeviceKind,
  EnrollmentSessionEstablished, RegistrationResult, VerifyEmailResult,
} from "./types.js";
import type { SessionScope } from "./resolve-session.js";
import {
  buildRegistrationOptions, verifyRegistration,
  buildAuthenticationOptions, verifyAssertion,
  type StoredWebauthnCredential,
} from "./webauthn.js";
import {
  allowedOrigins, assertOriginConfig, resolveCeremonyOrigin, tryNormalizeOrigin,
} from "./origins.js";
import { newTotpSecret, totpUri, verifyTotp } from "./totp.js";
import { SessionLifecycle } from "./session-lifecycle.js";

type Method = "webauthn" | "totp" | "recovery_code";
const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/**
 * The platform-qualified desktop kinds — what a CURRENT desktop install declares itself as, on
 * the two seams where the desktop identifies itself: the link-claim and the password sign-in's
 * TOTP verify. A closed set on purpose, and NARROWER than the device vocabulary:
 *
 *  · `"web"` is excluded — the device staleness alarm excludes kind `web` by design (a closed
 *    browser is not an incident), so letting a desktop declare `web` would be an attribution
 *    dodge, not a vocabulary choice.
 *  · The mobile kinds are excluded — a phone arrives through the pairing redeem, never these
 *    doors, and a declaration that cannot be true is refused rather than recorded.
 *  · `"macos"` is excluded HERE and admitted separately where the legacy claim needs it (see
 *    {@link DESKTOP_CLAIM_KINDS}): on the verify seam `macos` is the one kind whose derived
 *    lifetime surface is `native`, so admitting it would let anonymous wire input choose the
 *    long window — the exact capability the declaration must not carry.
 */
const DESKTOP_DECLARED_KINDS: ReadonlySet<string> = new Set<DeviceKind>([
  "desktop-linux", "desktop-macos", "desktop-windows",
]);

/**
 * What `POST /auth/desktop-claim` may say it is: the declared desktop kinds plus the legacy
 * `"macos"` spelling — which is also the DEFAULT when the field is absent, because every
 * shipped desktop build claims without the field and its device rows have always said `macos`.
 * Admitting `macos` explicitly here is safe where it is not on the verify seam: the claim's
 * mint pins `surface: "native"` for every admissible kind (the transport truth — it answers a
 * bearer pair), so the declaration selects a row label and nothing about the credential.
 */
const DESKTOP_CLAIM_KINDS: ReadonlySet<string> = new Set<DeviceKind>([
  "macos", "desktop-linux", "desktop-macos", "desktop-windows",
]);

/** The one refusal sentence for a kind outside its seam's closed set. */
function invalidDeviceKind(admissible: ReadonlySet<string>): ServiceError {
  return new ServiceError("validation_failed", 400,
    `device kind must be one of ${[...admissible].map((k) => `"${k}"`).join(", ")}`);
}

/**
 * Require a non-blank string body field. The UNAUTHENTICATED auth routes are the
 * only surface reachable with no credential at all, and every one of them used to
 * destructure straight into `.trim()` / `hashToken()`: a `{}` body reached
 * `withErrorEnvelope`'s non-ServiceError branch and answered **500**. A malformed
 * request is a 400, and it must be one before any DB or crypto work happens.
 */
function requireField(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new ServiceError("validation_failed", 400, `${field} is required`);
  }
  return v;
}

/**
 * The challenge a submitted WebAuthn assertion was actually signed over, read from its own
 * `clientDataJSON` — the base64url value the browser wrote there verbatim from the options.
 * A SELECTOR for the challenge-row claim, never a proof: `verifyAssertion` still checks the
 * signature over the claimed row's challenge and origin, so lying here can only select a row
 * the signature then fails against. `null` for anything malformed — the caller treats that as
 * a failed factor, exactly as a garbled signature would land.
 */
function challengeOfAssertion(credential: unknown): string | null {
  try {
    const cdj = (credential as { response?: { clientDataJSON?: unknown } })?.response?.clientDataJSON;
    if (typeof cdj !== "string" || cdj.length === 0) return null;
    const parsed = JSON.parse(Buffer.from(cdj, "base64url").toString("utf8")) as { challenge?: unknown };
    return typeof parsed.challenge === "string" && parsed.challenge.length > 0 ? parsed.challenge : null;
  } catch {
    return null;
  }
}

/**
 * The advertised password rule, ENFORCED WHERE IT IS TRUE — on the server.
 *
 * `/join` renders `minLength={12}` and the copy says "at least 12 characters", and until
 * this function existed that HTML attribute was the entire enforcement: `register` called
 * `requireField`, which accepts any non-blank string, so a direct API caller (curl, a stale
 * client, a script) could register with `x`.
 *
 * That gap matters more here than the usual "the client validates, the server should too",
 * because of WHERE the password sits in this design. Between `register` and the first factor
 * the password is the ONLY credential, and `login` on a zero-factor user re-mints an
 * enrollment session (the re-entry path) — so a guessable password does not merely open
 * an account, it lets an attacker enroll THEIR passkey on it.
 *
 * The MAXIMUM is not tidiness either. `scrypt` is deliberately ~100 ms, it is run before the
 * transaction opens, and `register` is public: without a ceiling a caller can post a
 * multi-megabyte password and spend the host's CPU at will. 256 is far past any real
 * passphrase and far short of a payload worth sending.
 *
 * Length is counted in CODE POINTS (`[...s].length`), not UTF-16 units: a 12-emoji
 * passphrase is twelve characters to the person who typed it, and `"".length` would
 * disagree with them in the direction that lets a weaker secret through.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

function requirePassword(v: unknown): string {
  const password = requireField(v, "password");
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new ServiceError(
      "validation_failed", 400,
      `password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  return password;
}

/**
 * The same gap `requirePassword` closed, in the field next to it — and opening public signup
 * is what opened it.
 *
 * `register` normalized the address (`.trim().toLowerCase()`) and never checked its SHAPE, so
 * `POST /auth/register {"email":"not-an-email"}` created a real account. Not hypothetical: it
 * was hit in the wild immediately after public signup went live, and the account had to be
 * erased by hand.
 *
 * While signup was invite-only this was bounded without anyone deciding it: `consumeInvite`
 * matched the address
 * against an invite row an operator had minted FOR a real person, so the invite was doing
 * duty as an email validator nobody had written. Removing the gate removed that too. This is
 * the general shape worth remembering — a check that was only ever a side effect of another
 * check disappears silently when that one moves.
 *
 * It matters beyond tidiness because the address IS the account: it is the login identity,
 * the only recovery path, and what Stripe puts a receipt against. An account whose address
 * cannot receive mail is one nobody can recover and nobody can be told anything about.
 *
 * It DELEGATES to `normalizeRecipient` rather than carrying its own pattern, and that is the
 * point rather than an economy. A second definition of "a valid address" would eventually
 * disagree with the first, and the disagreement has a shape: an address good enough to hold
 * an invite but not to hold an account, or — worse — an account whose address the mailer
 * then refuses as `invalid_recipient`, so the person can register and can never be sent
 * anything. One predicate, used by invites, the waitlist, the mailer and now registration,
 * cannot drift against itself.
 *
 * `login` deliberately does NOT call this. Its answer must not depend on the shape of what
 * was typed, and any account that predates this rule must still be able to sign in and
 * delete itself.
 */
function requireEmail(v: unknown): string {
  const email = normalizeRecipient(requireField(v, "email"));
  if (!email) throw new ServiceError("validation_failed", 400, "email must be a valid address");
  return email;
}

/**
 * The one sentence a taken address gets, from both the read and the constraint.
 *
 * It takes the invite question as an argument, because the trailing reassurance
 * ("your invite is untouched") is a statement about an invite, and a public signup does not
 * have one. Telling somebody who never held a code that theirs is safe is a small lie, and
 * small lies in refusal copy are how a user concludes the product does not know what
 * happened to them.
 */
const emailTaken = (hadInvite: boolean): ServiceError => new ServiceError(
  "email_taken", 409,
  "There is already an ohmail account for this address. Sign in instead" +
  (hadInvite ? " — your invite is untouched if you need it later." : "."),
);

/**
 * The per-IP signup limit refused, as a slot claim rather than a lockout.
 *
 * 429, not the 423 `account_locked` this endpoint used to answer: there is no account (the
 * request is to create one) and nothing failed. See `ip-throttle.ts` for the full argument
 * and for why the counter itself is unchanged.
 */
const registrationRateLimited = (): ServiceError => new ServiceError(
  "rate_limited", 429,
  "Too many signups from this connection. Give it a few minutes and try again.",
);

/**
 * The lockout refusal — ONE spelling, used by every throttle arm.
 *
 * The status, the code and the sentence are identical wherever the lockout speaks, because a
 * difference between two of those arms is an account-existence oracle: the unknown-email branch
 * of `login` once answered 401 for ever while a registered one answered 423, which is an
 * unlimited and perfectly reliable enumeration signal.
 */
const lockedOut = (until: Date): ServiceError => new ServiceError(
  "account_locked", 423, "too many failed attempts",
  { retryAfter: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)) },
);

/**
 * The deployment cannot identify clients, so it will not accept anonymous account
 * creation.
 *
 * 503 rather than 429 on purpose: nothing about THIS caller is being rate-limited, and
 * saying "too many signups from your connection" to the first visitor of the day would be
 * a false explanation of a deployment fault. `clientIp` returns `""` when no trusted
 * platform header is present (see `packages/api/src/context.ts`), and with the invite gate
 * open there is nothing else bounding registration — so the open path closes and the invite
 * path, which an operator still controls, keeps working.
 */
const signupUnavailable = (): ServiceError => new ServiceError(
  "signup_unavailable", 503,
  "Open signup is unavailable on this deployment right now. If you have an invite code, " +
  "it still works — otherwise please try again later.",
);

/** The capacity valve tripped. The client routes to the waitlist on this code. */
const signupCapacityReached = (): ServiceError => new ServiceError(
  "signup_capacity", 503,
  "ohmail is full for now. Join the list and we will let you in as soon as a place opens.",
);

/**
 * ONE sentence for every way a verification link can fail to be a live one.
 *
 * Unknown, expired, already used, the wrong `purpose`, blank, and the loser of a concurrent
 * race all get this — because the remedy is the same in every case (ask for another link) and
 * because the distinctions are only ours to know. "Already used" in particular must not be
 * distinguishable: a token that appears in a mail also appears in mailbox-scanner logs and in
 * proxy access logs, and telling whoever presents it second that it *was* real confirms that the
 * address it was mailed to has an account — the oracle, reappearing one endpoint over.
 *
 * The same reasoning `invites.ts` applies to `revoked` vs `expired`, applied to a shorter list.
 */
const invalidVerification = (): ServiceError => new ServiceError(
  "invalid_token", 400,
  "This verification link is not valid any more. Links work once and expire; " +
  "sign in and we will send you a fresh one.",
);

/**
 * The `purpose` a desktop handoff code is stored under in `login_tokens`.
 *
 * The third value that column carries, beside `login` and `email_verify`. Every query that
 * reads the table filters on ONE of them, which is what makes the three mutually invisible:
 * {@link AuthService.peekLoginToken} sees only `login`, `MailService.consumeEmailVerification`
 * only `email_verify`, {@link AuthService.claimDesktopLink} only this. Exported so a second
 * literal cannot drift from it the way the import comment on {@link EMAIL_VERIFY_PURPOSE} warns.
 */
export const DESKTOP_LINK_PURPOSE = "desktop_link";

/**
 * ONE sentence for every way a desktop handoff code can fail to be a live one.
 *
 * Unknown, expired, already claimed, the wrong `purpose`, blank, over-long, and the loser of a
 * concurrent race all get this. Same rule as {@link invalidVerification}: the remedy is
 * identical in every case — ask the browser for a fresh code — and distinguishing "already
 * used" from "never existed" tells whoever presents a code second that it was real.
 *
 * 400 and not 401: nothing is being authenticated here that could be said to have failed, and
 * a 401 on a route the desktop app calls before it holds any session at all reads, to every
 * generic client in between, as "your session expired".
 */
const invalidDesktopCode = (): ServiceError => new ServiceError(
  "invalid_code", 400,
  "That code is not valid any more. Codes work once and expire after a couple of minutes; " +
  "ask for a fresh one in the browser.",
);

/** The per-IP attempt bound on the claim, as a slot claim. See `ip-throttle.ts` for the shape. */
const desktopClaimRateLimited = (): ServiceError => new ServiceError(
  "rate_limited", 429,
  "Too many attempts from this connection. Give it a few minutes and try again.",
);

/**
 * A PKCE S256 challenge, and nothing else: 43 characters of base64url, which is what the SHA-256
 * of anything is once base64url-encoded without padding.
 *
 * EXACT rather than a range, because there is exactly one thing this value may be. A caller that
 * sends 42 characters, or padding, or a hex digest, is a caller doing something other than S256,
 * and the honest answer is to say so — see {@link invalidDesktopChallenge} for why the tempting
 * alternative is dangerous.
 */
const DESKTOP_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The mint's refusal of a challenge it cannot use.
 *
 * ── WHY THIS IS A REFUSAL AND NOT A SHRUG ─────────────────────────────────────────────────
 *
 * The obvious implementation ignores a malformed challenge and mints an ordinary unbound code.
 * That is a SILENT DOWNGRADE: the app that sent the challenge believes the code on screen is
 * worthless without the verifier it is holding, and would then hand that code to a URL scheme any
 * program on the machine can claim. Every party ends up thinking the binding is on. Refusing
 * makes the disagreement visible at the only moment anybody can act on it.
 *
 * Distinct from {@link invalidDesktopCode}, and there is no enumeration concern in doing so: this
 * refusal is only reachable by a caller that has already presented a live session AND cleared the
 * step-up gate, and it names a fault in that caller's own request.
 */
const invalidDesktopChallenge = (): ServiceError => new ServiceError(
  "invalid_challenge", 400,
  "That link request is not one this browser can complete. Open the page again from the app.",
);

/**
 * The open path's "this address already has an account" signal, thrown INSIDE the
 * registering transaction and caught immediately outside it.
 *
 * ══ WHY A THROW AND NOT A RETURN VALUE ════════════════════════════════════════════════
 *
 * This was a `return null` from the transaction callback, and it produced a **500 in
 * production on concurrent duplicate signups** — found by
 * `invite-consumption.concurrency.pg.test.ts` and invisible to every PGlite test, because
 * PGlite is single-connection and the second registration always takes the SELECT branch
 * instead of the unique-violation one.
 *
 * The mechanism: once a statement inside a Postgres transaction fails, the transaction is
 * ABORTED and no further statement — including `COMMIT` — can succeed. Catching the
 * `users_email_unique_idx` violation and then returning normally therefore asked the driver
 * to commit an aborted transaction, and postgres-js surfaced the original `PostgresError`
 * from the commit. It is not a `ServiceError`, so `withErrorEnvelope` turned it into
 * `500 internal` — an unhandled 500 on the one endpoint reachable with no credential, and a
 * response that differs from the constant 202, i.e. the enumeration oracle reappearing as a
 * status code under concurrency.
 *
 * Throwing unwinds the transaction properly (the rollback is the driver's, not ours), and the
 * catch sits outside `inTransaction` so the taken branch is reached with no transaction open —
 * which is also where the mail has to be sent from anyway.
 *
 * It is a private sentinel and never reaches a caller: `register` is the only thrower and the
 * only catcher, and it converts it to `RegistrationPending` in the same expression.
 */
class AddressAlreadyRegistered extends Error {
  constructor() { super("address already registered"); }
}

/**
 * Is this a Postgres unique-violation on `constraint`?
 *
 * SQLSTATE `23505`, matched on the driver's own `code`/`constraint` fields rather than on
 * the message text, which is localised and version-dependent. PGlite and postgres-js both
 * surface these, and both spell them the same way; the `constraint` check is what keeps this
 * from swallowing an unrelated violation (a duplicate `credentials.user_id`, say) and
 * reporting it as a taken address.
 */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  if (err.code !== "23505") return false;
  const name = typeof err.constraint === "string" ? err.constraint
    : typeof err.constraint_name === "string" ? err.constraint_name : "";
  return name === constraint;
}

/**
 * The decoy password hash of the constant-time unknown-email path, memoized
 * PER HASHER rather than per service instance.
 *
 * It used to be a lazy per-instance field, and `apps/web` builds a fresh AuthService
 * per request: an unknown email therefore paid `hash()` + `verify()` (two scrypts)
 * on every request while a known email paid `verify()` only — a systematic ~2×
 * timing oracle for account existence, in the exact code path whose comment promises
 * constant time. The hasher is a process-wide singleton, so keying on it makes the
 * decoy a once-per-process cost that is already warm by the first login.
 */
const DECOY_HASHES = new WeakMap<PasswordHasher, Promise<string>>();
function decoyHashFor(hasher: PasswordHasher): Promise<string> {
  let p = DECOY_HASHES.get(hasher);
  if (!p) {
    p = hasher.hash(`decoy-${randomUUID()}`);
    // A rejected promise must not be cached forever, or every later unknown-email
    // login would 500 instead of 401.
    p.catch(() => DECOY_HASHES.delete(hasher));
    DECOY_HASHES.set(hasher, p);
  }
  return p;
}

/** OAuth authorize query. */
export interface AuthorizeQuery {
  response_type: "code";
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  state: string;
  scope?: string;
}
export interface TokenBodyAuthCode {
  grant_type: "authorization_code";
  code: string;
  redirect_uri: string;
  client_id: string;
  code_verifier: string;
}
export interface TokenBodyRefresh {
  grant_type: "refresh_token";
  refresh_token: string;
  client_id: string;
}

/**
 * AuthService — register, two-step login, WebAuthn + TOTP + recovery
 * codes, native OAuth2 PKCE, step-up, lockout, and audit. Constructed with
 * injectable {@link AuthDeps} (key provider, scrypt hasher) so the whole
 * surface is hermetic.
 *
 * The session MACHINERY — `establish`, refresh rotation with reuse detection,
 * family revocation, logout, devices, `establishPairedDevice` — lives on
 * {@link SessionLifecycle}, which this class extends and which the desktop
 * engine runs on its own (Phase 3; the base file's header carries the
 * boundary argument). This class is the identity CEREMONY on top of it, and
 * it overrides the base's three hosted hooks (`audit`, `throttleReset`,
 * `twofaEnrolled`) with the real cloud-half reads and writes, so every hosted
 * path behaves exactly as it did when the two were one file.
 */
export class AuthService extends SessionLifecycle {
  constructor(private readonly deps: AuthDeps) {
    super(deps);
    // Fail fast, at construction, on an unshippable WebAuthn config: zero
    // origins, a malformed one, or an `rpID` that is not a registrable-domain suffix
    // of every allowed origin. Every such deployment would answer 200 at options
    // time and then have the BROWSER refuse the ceremony — an outage that only
    // manifests on a user's device. `makeAuthConfig` validates too; this covers a
    // hand-built config literal.
    assertOriginConfig(deps.config);
    // Warm the decoy hash off the constructor (never awaited) so the unknown-email
    // path is never the one that pays for it. See {@link decoyHashFor}.
    void decoyHashFor(deps.passwordHasher);
  }

  // ── Registration & first factor ────────────────────────────────────────────

  /**
   * Create the account+user and mint the ENROLLMENT-SCOPED session that carries the
   * caller into 2FA enrollment. Before that session existed this returned a user and no
   * session, so there was no wire path from registration to a first session at all:
   * every 2FA-enrollment endpoint demands a session and login on a 2FA-less user
   * dead-ended. Minting here (rather than a separate `POST /auth/2fa/bootstrap` that
   * would have to accept a zero-method login token) is the recommended
   * shape: one round trip, no second single-use credential to leak or replay.
   *
   * ── THE INVITE IS A ROW NOW, AND IT IS CONSUMED IN THIS TRANSACTION ────────
   *
   * The first build shipped `inviteCodes.has()` as an explicit MITIGATION and named the
   * fix it was standing in for: "hashed, expiring, ideally email-bound invite rows
   * consumed transactionally with account creation. It needs a migration". Migration
   * 0020 is that migration, and this is that consumption. Three things follow:
   *
   *  1. **The account creation is now ONE transaction**, so a failure after the invite
   *     is burned un-burns it, and a half-created account (`accounts` + `users` with no
   *     `credentials` row — a user who could never log in and whose email was
   *     permanently taken) is no longer representable. The throttle writes stay OUTSIDE
   *     it on purpose: a rolled-back attempt counter is a free retry, which is the one
   *     thing the attempt limit exists to deny.
   *  2. **The invite is EMAIL-BOUND**, which is what stops the 201-vs-409 answer being
   *     an account-existence oracle for arbitrary addresses. See `invites.ts` and
   *     migration 0020's header.
   *  3. **`cfg.inviteCodes` survives as the OPERATOR BOOTSTRAP** and is consulted only
   *     when the invite table does not recognise the code at all. It is unbound and
   *     reusable — i.e. it still carries the oracle — so a deployment should run with
   *     `TF_INVITE_CODES` empty once the first invite row exists. Deleting it outright
   *     would leave a fresh deployment with no way to open its first account.
   *
   * ── THE INVITE BECAME OPTIONAL, UNDER A FLAG, AND NOTHING ELSE MOVED ───────────
   *
   * `AuthConfig.publicSignup` (default `false`; `TF_PUBLIC_SIGNUP=1` opens it) lets a
   * stranger open an account with no code. Three things are worth reading before changing
   * anything in here, because each of them is a place where the obvious edit is wrong:
   *
   *  4. **The branch is on whether a code was OFFERED, not on whether one was REQUIRED.**
   *     Skipping the invite logic "because the gate is open anyway" would let a REVOKED
   *     code succeed — and revocation is the documented remedy for a leaked or misdirected
   *     invite, so it would silently stop being one. An offered code takes the invite path in
   *     both modes, refusals and all.
   *  5. **The per-IP limit is now the whole bound, so it tightens and it stops being
   *     skippable.** `maxPublicRegistrationsPerWindow` replaces the invite-path cap, and an
   *     unknown client IP refuses (`signup_unavailable`) instead of bypassing the limit.
   *  6. ~~**Registration became an account-existence oracle, deliberately.**~~ **REVERSED —
   *     see below.** The open-gate revision accepted the 201-vs-409 split as a bounded risk
   *     and named the exact trigger for undoing it: "`MAIL_FROM` armed + a confirmation
   *     observed". Both happened, so the acceptance expired and the oracle is gone.
   *
   * ── THE PUBLIC PATH ANSWERS THE SAME THING ABOUT EVERY ADDRESS ─────────────────
   *
   *  7. **On the OPEN path there is no 201, no 409 and no session — only a constant 202.**
   *     `RegistrationPending` is returned for a fresh address and for one that already has an
   *     account, and the type deliberately carries no field that distinguishes them. The news
   *     a real user needs ("check your mail" / "you already have an account, sign in") moves
   *     into the INBOX, which only the address owner can read.
   *
   *     A constant response and a session are mutually exclusive, and that is not a limitation
   *     to be engineered around: a session can only be minted for a caller who proved
   *     something, a prober naming somebody else's address proved nothing, and any decoy would
   *     be unmasked by the wizard's very next call (`GET /auth/session`, 200 vs 401). So the
   *     open path returns no credential at all and the verification mail is the sole
   *     continuation — which is exactly the escape the open-gate revision named and could not
   *     take because the mailer was dark.
   *
   *  8. **THE INVITE PATH IS BYTE-IDENTICAL TO WHAT SHIPPED BEFORE**, 201 + enrollment session
   *     + 409 `email_taken` included. That 409 is not an oracle there and never was:
   *     `consumeInvite` is email-BOUND, so the only address a caller can put through the invite
   *     path is one an operator mailed them a code for, and the 409 therefore tells them a fact
   *     about themselves. Removing it would cost an invited user a true, useful sentence to
   *     protect information they already have.
   *
   *  9. **The invite path STAMPS `email_verified_at` only when the consumed ROW says it may,
   *     and the bootstrap path never does.** An email-bound invite that was MAILED to the
   *     address and then redeemed is proof the address receives mail and that the registrant
   *     read it — the same argument that lets a mailed verification link stamp the column. But
   *     not every invite row was mailed any more: the pairing-token redeem mints one for
   *     whatever address its redeemer typed, and receipt of nothing proves nothing. So the row
   *     itself carries the answer (`invites.confers_verified`, read in the same statement that
   *     consumed it): mailed invites and the first-boot setup token's invite confer, a user's
   *     pairing-minted invite does not, and those accounts verify later through the ordinary
   *     mailed flow. The condition is `outcome?.ok && outcome.confersVerified` — a consumed ROW
   *     that PROVES control — never "a code was offered", and never anything a caller sent.
   *     `cfg.inviteCodes` is unbound, reusable and non-expiring, so it proves nothing about an
   *     address and those registrations stay unverified.
   */
  async register(
    ctx: ServiceContext,
    b: { email: string; password: string; displayName: string; inviteCode?: string },
  ): Promise<RegistrationResult> {
    // Normalized AND shape-checked: while signup was invite-only the invite row was doing the
    // second job without being asked. See {@link requireEmail}.
    const email = requireEmail(b.email);
    // The 12-character minimum the signup form advertises, applied where a caller cannot
    // skip it, plus a ceiling so a public endpoint cannot be made to scrypt a megabyte.
    // See {@link requirePassword}.
    requirePassword(b.password);
    requireField(b.displayName, "displayName");

    // ── PUBLIC SIGNUP: THE ONE GATE THAT MOVED ──────────────────────────────────────────
    //
    // The branch is on whether a code was OFFERED, never on whether one was REQUIRED. That
    // distinction is the whole safety of this flag: "the gate is open, so skip the invite
    // logic" would make a REVOKED code succeed — and revocation is the documented remedy
    // for a leaked or misdirected invite, so it would quietly stop being one.
    //
    // `openGate` is therefore true only when public signup is on AND the caller offered
    // nothing. An offered code takes the invite path below, byte for byte, in both modes.
    const offeredCode = typeof b.inviteCode === "string" ? b.inviteCode.trim() : "";
    const openGate = this.cfg.publicSignup && offeredCode.length === 0;
    const inviteCode = openGate ? "" : normalizeInviteCode(requireField(b.inviteCode, "inviteCode"));

    const db = asTx(ctx);
    // RATE LIMIT, OUTSIDE the transaction below so a refusal is never rolled back — a
    // rolled-back attempt counter is a free retry, which is the one thing the limit exists
    // to deny. Every attempt counts, success or failure, against its own key namespace
    // (never the login keys).
    //
    // Public signup changed two things here and nothing else. (1) The counter is a SLOT CLAIM
    // answering 429 `rate_limited`, not the lockout counter answering 423 `account_locked`
    // "too many failed attempts" — which was false in every word on an endpoint whose
    // whole purpose is that there is no account yet and nothing has failed. See
    // `ip-throttle.ts`. (2) The cap is tighter when the gate is open, because an
    // email-bound invite row was what bounded a stranger before.
    //
    // ── AN UNKNOWN IP: SKIP WHEN GATED, REFUSE WHEN OPEN ────────────────────────────────
    //
    // `clientIp` returns `""` when no trusted platform header is present, and keying a
    // limiter on `""` is an outage, not a limit: one shared bucket for the whole deployment
    // means N requests from anywhere lock out every new signup on earth. The invite-era rule
    // was therefore "an unknown client is not rate-limited per-IP, it is limited by what does
    // not need an identity" — and for registration that other thing was the email-bound
    // invite row. With the gate OPEN there is no other thing, so the same reasoning inverts:
    // an unidentifiable client and an open gate is unbounded account creation, and the
    // deployment refuses rather than accepting it. The invite path still works.
    const ip = (ctx.ip ?? "").trim();
    if (ip.length > 0) {
      const claimed = await reserveIpSlot(db, {
        namespace: "register:ip",
        ip,
        now: ctx.now(),
        // ON `openGate`, NEVER ON `publicSignup` — the two disagree on exactly the case that
        // matters, and the comment above already states the intended rule ("the cap is tighter
        // when the gate is OPEN"). `publicSignup` is the deployment MODE; `openGate` is whether
        // THIS request is taking the open path. With the flag on, an offered invite code takes
        // the invite path "byte for byte" (see above) — and was nonetheless being metered
        // against the five-slot public ceiling, on the SAME `register:ip` counter the public
        // path fills. Five stranger attempts from one NAT therefore denied a live, operator-
        // issued invite for the whole window: the one signup path that is supposed to be
        // available when the public valve is closing was the first to shut.
        //
        // Sharing one counter across both paths is deliberate and stays: the counter means
        // "registrations from this client in this window" and only the CEILING is per-path, so
        // a public flood stops at five and still leaves fifteen slots the invite path can claim.
        max: openGate
          ? this.cfg.maxPublicRegistrationsPerWindow
          : this.cfg.maxRegistrationsPerWindow,
        windowMs: this.cfg.failureWindowMs,
      });
      if (!claimed) throw registrationRateLimited();
    } else if (openGate) {
      throw signupUnavailable();
    }

    // ── NO MAILER + OPEN GATE ⇒ REFUSE. The inversion of the open gate's own reasoning. ──
    //
    // The open gate originally shipped BECAUSE mail was dark: gating registration on a mail that
    // cannot send would have been "a signup page that silently accepts nobody". Now that the
    // mail IS the funnel — it carries the only continuation, since the response is constant —
    // the same reasoning points the other way. Creating an account whose verification link can
    // never be sent produces exactly what that revision feared, only worse: a row that looks
    // like a signup, cannot reach Checkout or a mailbox, and whose owner was told to check an
    // inbox nothing will arrive in.
    //
    // `signup_unavailable` is reused verbatim and it is the right sentence for the
    // right reason: nothing about THIS caller is being refused, the DEPLOYMENT cannot complete
    // an open signup, and the invite path — which needs no mail, because the invite already
    // proved the address — still works so an operator can still mint. Checked BEFORE the
    // password hash so a misconfigured deployment does not spend ~100 ms of scrypt per probe.
    if (openGate && !this.deps.mail) throw signupUnavailable();

    // Hash the password BEFORE the transaction opens: scrypt is deliberately slow
    // (~100 ms), and holding the invite row's write lock across it would serialize
    // every concurrent redemption of that code behind one CPU-bound operation.
    const passwordHash = await this.deps.passwordHasher.hash(b.password);

    // The transaction decides WHAT HAPPENED; the mail is sent afterwards, outside it.
    //
    // `null` means "the address was already registered", which on the open path is not an error
    // and must not be one: throwing would have to become a status code, and a status code is the
    // oracle. It is a value the code below turns into the same 202 a fresh signup gets.
    //
    // The sends are deliberately NOT inside `inTransaction`. A mail is a network call to Resend
    // with its own timeout, and holding an open Postgres transaction — and its connection, on a
    // serverless host with a small pool — across one is a self-inflicted outage under any load
    // at all. It also means a mail failure can never roll back a committed account, which is
    // the mail service's own rule stated from the caller's side.
    const created = await this.inTransaction(ctx, async (txCtx) => {
      const tx = asTx(txCtx);

      // (1) THE INVITE, consumed atomically — when one was offered. `consumedByUserId` is
      // filled in after the user exists; the row is claimed first so two racing redemptions
      // cannot both proceed to create an account.
      //
      // `openGate` skips this block entirely, and that is the ONLY thing public signup
      // changes here. When a code IS present the code below is unchanged in both modes, so
      // a used, expired, revoked or wrongly-bound invite refuses identically whether or not
      // the deployment would have let this person in without one.
      const outcome = openGate
        ? null
        : await consumeInvite(tx, { code: inviteCode, email, now: ctx.now() });
      if (outcome && !outcome.ok) {
        // The static bootstrap is reachable ONLY when no invite row carries this code.
        // A code that IS an invite — used, expired, or bound elsewhere — keeps its own
        // answer, so a bootstrap code can never launder a refusal into a success.
        if (!(outcome.refusal === "unknown" && this.cfg.inviteCodes.has(inviteCode))) {
          throw inviteError(outcome.refusal);
        }
      }

      // (1a) THE CAPACITY VALVE, on the open path only.
      //
      // An invited person was chosen by an operator, and minting the invite already WAS the
      // capacity decision; capping them here would close the valve on the wrong side. Past
      // the cap a stranger is sent to the waitlist, which is what the waitlist is for once
      // it is no longer the front door.
      //
      // SOFT, and said out loud rather than implied: this read and the insert below share a
      // transaction, but under READ COMMITTED two concurrent registrations both see
      // `cap - 1` and both proceed. A hard cap needs a serialized counter row — a write lock
      // on every signup, to enforce a number chosen as a rough limit.
      if (openGate && this.cfg.publicSignupCap !== null) {
        const [taken] = await tx.select({ n: count() }).from(accounts);
        if ((taken?.n ?? 0) >= this.cfg.publicSignupCap) throw signupCapacityReached();
      }

      // (2) The address. On the INVITE path this is reachable only by a caller who proved
      // they hold an invite for THIS address (or an operator bootstrap code) — see the
      // class doc above.
      //
      // ── ON THE OPEN PATH IT IS AN ACCOUNT-EXISTENCE ORACLE, AND THAT IS DECIDED ──────
      //
      // 201 for a fresh address and 409 for a registered one is a probe anyone can run once
      // the email binding is gone. It is not overlooked: it is inherent to self-service
      // signup (every answer that completes a real signup also completes the probe), the
      // only escape is a constant response plus an out-of-band mail this deployment cannot
      // yet be relied on to send, and it is bounded by the per-IP slot claim above — every
      // attempt, 201 and 409 alike, costs one. `POST /auth/login` keeps its constant
      // "invalid email or password" parity, so the oracle exists on exactly one endpoint. The
      // named trigger for reversing it — outbound mail proven — has since fired; see below.
      //
      // This READ is the polite refusal, not the guarantee. It cannot be: under READ
      // COMMITTED two concurrent registrations for one address both select nothing, and
      // `UNIQUE (account_id, email)` can never catch them because each inserts its own
      // fresh `accounts` row first. The guarantee is `users_email_unique_idx` (migration
      // 0021), and the catch below is what turns its violation back into this same sentence
      // instead of a 500.
      //
      // ON THE OPEN PATH A TAKEN ADDRESS IS NOT A REFUSAL. A refusal is a status code and
      // a status code is the oracle, so it becomes a private sentinel that the code after the
      // transaction turns into the same 202 a fresh signup gets.
      const existing = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (existing.length > 0) {
        // ON THE OPEN PATH THIS IS NOT AN ERROR, but it still has to unwind the
        // transaction rather than return: see {@link AddressAlreadyRegistered}. The invite path
        // keeps `emailTaken` (#8).
        throw openGate ? new AddressAlreadyRegistered() : emailTaken(true);
      }

      const [acct] = await tx.insert(accounts).values({ name: b.displayName }).returning();
      const [user] = await tx.insert(users).values({
        accountId: acct!.id, email, displayName: b.displayName,
        // #9 — a consumed ROW that PROVES control is the only thing that stamps: mailed invites
        // and the first-boot setup invite carry `confers_verified = true`, a user's
        // pairing-minted invite carries `false` (its holder typed the address; nothing was
        // mailed), the unbound `cfg.inviteCodes` bootstrap has no row at all, and an open-gate
        // signup certainly does not. The flag comes from the invite row's own RETURNING —
        // never from the request.
        emailVerifiedAt: outcome?.ok && outcome.confersVerified ? ctx.now() : null,
      }).returning().catch((e: unknown) => {
        // The race arrived here. One of the two transactions is rolling back — including
        // its invite consumption, which is exactly why `consumeInvite` runs inside this
        // transaction: the loser's invite is un-burned and works on the retry.
        //
        // THE LOSER MUST ANSWER LIKE EVERY OTHER TAKEN ADDRESS ON THE OPEN PATH. This
        // catch used to throw `emailTaken` unconditionally, which left the oracle alive in the
        // one branch nothing sequential can reach: two simultaneous open-path registrations for
        // one address, and the loser answers 409 while every prober gets 202. Both branches now
        // reach the same 202 — and the throw is what makes that WORK rather than 500, because
        // this statement has already aborted the transaction (see the sentinel's doc).
        if (isUniqueViolation(e, "users_email_unique_idx")) {
          throw openGate ? new AddressAlreadyRegistered() : emailTaken(true);
        }
        throw e;
      });
      await tx.insert(credentials).values({ userId: user!.id, passwordHash, algo: "scrypt" });

      if (outcome?.ok) {
        await tx.update(invites).set({ consumedByUserId: user.id }).where(eq(invites.id, outcome.inviteId));
      }
      // Close the funnel. A no-op for anyone who registered without ever signing up.
      await tx.update(waitlist)
        .set({ registeredAt: ctx.now(), updatedAt: ctx.now() })
        .where(eq(waitlist.email, email));

      // The INVITE path gets its session here, inside the transaction, exactly as before. The
      // open path does not get one at all, so it only needs to carry the new user out.
      return openGate
        ? { openUserId: user!.id }
        : await this.establishEnrollment(txCtx, user!);
    }).catch((e: unknown) => {
      // The ONLY thing caught here is the open path's "already registered" sentinel, and it is
      // caught OUTSIDE the transaction so the rollback has already happened. Everything else —
      // `emailTaken` on the invite path, an invite refusal, a driver fault — propagates.
      if (e instanceof AddressAlreadyRegistered) return null;
      throw e;
    });

    // ── The invite path: unchanged, and it returns before any mail is considered ────────
    if (created !== null && !("openUserId" in created)) return created;

    // ── The open path: ONE mail, then the SAME answer either way ───────────────────────
    //
    // `created === null` means the address was already registered — from the read OR from the
    // concurrent unique-violation, which is exactly why both throw the same sentinel: the two
    // ways of discovering it must not produce two different answers.
    //
    // Both branches send exactly one mail, through the same `unsolicited` per-recipient budget
    // (`MailQuota`), so the limiter's observable behaviour does not depend on which branch ran —
    // a constant response with a branch-dependent side effect is not constant. Both then return
    // the identical `RegistrationPending`.
    //
    // A FAILED send does not fail the request and does not strand the signup. The account (when
    // one was created) exists and is reachable by the re-entry path — `POST /auth/login` with
    // the password just chosen re-mints an enrollment session for a user with zero factors — and
    // the wizard's verify step offers a resend. So a Resend outage costs a new user one sign-in,
    // never their account. `mailed` is how a caller inside the trust boundary observes that; the
    // route must never put it on the wire.
    const mail = this.deps.mail!;
    const result = created === null
      ? await mail.sendAccountExists(ctx, { to: email })
      : await mail.issueEmailVerification(ctx, { userId: created.openUserId, to: email });
    return { status: "verification_pending", mailed: result.status === "sent" };
  }

  /**
   * PROVE AN ADDRESS: a token that was mailed to it, PLUS the account's password.
   *
   * ══ WHY BOTH, AND WHAT A TOKEN ALONE WOULD HAVE ALLOWED ═══════════════════════════════
   *
   * The obvious design is "the link proves the address, so consume it and let the holder in".
   * It is a full account-takeover primitive, and the chain is short enough to be worth writing
   * out so nobody simplifies this method back into it:
   *
   *   1. The attacker registers `victim@example.com` on the open path with a password THEY
   *      choose. The response is a constant 202 (it has to be), so this costs them nothing and
   *      tells them nothing — but the row now exists with their credential on it.
   *   2. They sign in via the re-entry path (zero factors ⇒ enrollment session) and enroll
   *      their OWN passkey or TOTP. The account is now fully 2FA'd, by the attacker, and parked
   *      against the verification gate.
   *   3. The victim receives the verification mail — which they did not ask for but which looks
   *      entirely legitimate — and clicks it.
   *
   * With a token-only design, step 3 stamps `email_verified_at` on the ATTACKER's account and
   * the gate opens: Checkout and `POST /mailboxes` on an account the attacker controls, under
   * the victim's address. In the variant where the attacker does not pre-enroll, the victim is
   * handed a session and onboards normally onto an account whose PASSWORD is the attacker's —
   * and since the password is the first factor of every future login, the victim loses the
   * account, and their IMAP credentials with it, the moment that session expires.
   *
   * Requiring the password closes both: the victim cannot verify the attacker's account because
   * they do not know its password, and the attacker cannot verify their own because they never
   * receive the mail. The two credentials are held by different people in every abusive case and
   * by the same person in every legitimate one. It also makes link-prefetching mail scanners
   * harmless — a scanner issues a GET and never posts a password — which is the residual risk
   * the verification-mail design named and could not otherwise answer.
   *
   * It is not friction invented here either: the caller chose this password minutes ago on the
   * previous screen, and anyone who has genuinely lost it can reach the same place by signing in
   * (the re-entry path) and using the wizard's resend.
   *
   * ══ THE THROTTLE IS MANDATORY, NOT DEFENCE IN DEPTH ═══════════════════════════════════
   *
   * This method verifies a password, so without the lockout it is a password-guessing endpoint
   * that bypasses `login`'s lockout entirely — an attacker holding a leaked token could
   * brute-force at will. It claims the SAME `user:` and `email:` keys `login` uses, so guesses
   * here and guesses there share one budget and neither is a way around the other.
   *
   * ══ THE SESSION IS MINTED ONLY AT ZERO FACTORS, BY LOGIN'S OWN RULE ══════════════════
   *
   * Byte-for-byte the `login` re-entry condition (`methods.length === 0`): for a user with no
   * second factor the password IS the only factor in existence, so handing its holder an
   * enrollment-scoped session lowers no bar. With a factor enrolled it would — a mailed link
   * plus a password must not skip a second factor somebody deliberately added — so that caller
   * gets `{status:"verified"}` and signs in normally.
   *
   * The token stays `purpose='email_verify'`, so the token-family separation still holds: it is
   * invisible to `peekLoginToken` and cannot be presented to `webauthnAssertOptions`,
   * `totpVerify` or `recoveryVerify` as a first factor. Consumption is the single-statement
   * `consumeEmailVerification`, so single-use survives concurrency.
   */
  async verifyEmail(
    ctx: ServiceContext, b: { token?: unknown; password?: unknown },
  ): Promise<VerifyEmailResult> {
    const mail = this.deps.mail;
    if (!mail) {
      throw new ServiceError(
        "mail_unconfigured", 503,
        "Email verification is not available on this deployment.",
      );
    }
    const token = typeof b.token === "string" ? b.token.trim() : "";
    const password = requireField(b.password, "password");
    // A blank token is refused before any work — and with the SAME sentence a wrong one gets,
    // so "no token" and "not a real token" are one answer.
    if (token === "") throw invalidVerification();

    const db = asTx(ctx);

    // PEEK first, so the password check has a user to run against. This reads the row WITHOUT
    // consuming it: a wrong password must not burn the link, or one mistyped attempt would cost
    // the user their only credential and force a resend.
    const [row] = await db.select({ userId: loginTokens.userId })
      .from(loginTokens)
      .where(and(
        eq(loginTokens.tokenHash, hashToken(token)),
        eq(loginTokens.purpose, EMAIL_VERIFY_PURPOSE),
        isNull(loginTokens.consumedAt),
        gt(loginTokens.expiresAt, ctx.now()),
      ))
      .limit(1);
    if (!row) throw invalidVerification();

    const user = await this.loadUser(db, row.userId);

    // The lockout, on BOTH keys `login` uses — see the header. Ahead of the scrypt verify, so a
    // locked-out attacker does not even get to spend our CPU, and RESERVED rather than merely
    // read so that concurrency cannot buy extra guesses ({@link throttleReserve}). This endpoint
    // takes a password, so leaving it on a check-then-act pair would have reopened the whole
    // bound the moment `login`'s was closed.
    await this.throttleReserve(db, `email:${user.email}`);
    await this.throttleReserve(db, `user:${user.id}`);

    const cred = (await db.select().from(credentials).where(eq(credentials.userId, user.id)).limit(1))[0];
    const ok = cred ? await this.deps.passwordHasher.verify(password, cred.passwordHash) : false;
    if (!ok) {
      await this.throttleLock(db, `user:${user.id}`);
      await this.throttleLock(db, `email:${user.email}`);
      await this.audit(db, user, "login_failed", "password", ctx);
      // `login`'s exact sentence. The token is still live and still single-use.
      throw new ServiceError("unauthorized", 401, "invalid email or password");
    }

    await this.throttleRefund(db, `user:${user.id}`);
    await this.throttleRefund(db, `email:${user.email}`);

    const methods = await this.enrolledMethods(db, user.id);

    return this.inTransaction(ctx, async (txCtx) => {
      const tx = asTx(txCtx);
      // CONSUME INSIDE the transaction that stamps, so the two cannot come apart: a crash
      // between them would otherwise spend the token without recording the proof, and the user
      // would hold a dead link for an account still refused at the gate.
      const consumed = await mail.consumeEmailVerification(txCtx, token);
      // Lost the race against another presentation of the same link. The single-statement
      // consumption guarantees exactly one winner; this is the loser.
      if (!consumed) throw invalidVerification();

      // `COALESCE` — verification is monotonic. A second (legitimately re-issued) link opened
      // later must not rewrite the instant the address was first proven.
      await tx.update(users)
        .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${ctx.now().toISOString()}::timestamptz)` })
        .where(eq(users.id, user.id));
      await this.audit(tx, user, "email_verified", "password", ctx);

      // Login's own re-entry rule. See the header for why a factor changes the answer.
      if (methods.length === 0) return this.establishEnrollment(txCtx, user);
      return { status: "verified" as const };
    });
  }

  /**
   * Send this session's owner another verification link.
   *
   * ══ IT IS AUTHENTICATED, AND THAT IS WHAT MAKES IT SAFE ══════════════════════════════
   *
   * The natural shape for "resend my verification mail" is an unauthenticated endpoint taking an
   * address, and it is two vulnerabilities at once: a mail-bomb aimed at anyone the caller can
   * name, and an enumeration oracle, because the honest implementation answers differently for
   * an address with no account. The mail service's standing rule is what this follows — invite
   * delivery stays authenticated work — and the generalisation is that no endpoint takes a
   * RECIPIENT from an anonymous caller.
   *
   * So the recipient is `users.email` for the session's own user and there is no parameter for
   * it. There is nothing to enumerate: the caller already holds a session for the account, so
   * the account's existence is not news to them. `issueEmailVerification` independently refuses
   * any `to` that is not the user's own address, which means even a future bug in this
   * method cannot mail one account's token to another inbox.
   *
   * Anyone whose mail never arrived reaches this through the re-entry path — sign in with the
   * password, land in the wizard, press the button — so no anonymous variant is needed to keep
   * a stranded signup recoverable.
   *
   * ══ BOTH LIMITERS, NEITHER NEW ═══════════════════════════════════════════════════════
   *
   * Per IP: `reserveIpSlot` under `verify:ip`, the same slot-claim primitive registration uses,
   * answering 429 (a slot claim, never the 423 lockout — see `ip-throttle.ts`). Per recipient:
   * whatever `MailService.guarded` already enforces on the `unsolicited` budget, reached by
   * construction because this can only send through `MailService`. No third limiter was written.
   *
   * An unknown client IP does NOT refuse here, unlike open registration: the caller is
   * authenticated, so the session is the identity the per-IP counter would otherwise stand in
   * for, and the per-recipient budget still bounds the mail itself.
   *
   * The response is deliberately uninformative — `{ ok: true }` whether the mail sent, was rate
   * limited, or was skipped because the address is already verified. It is the same rule
   * applied to an authenticated endpoint: `MailSendResult` is a readout of a limiter, and a
   * limiter readout on the wire is an oracle even when the caller is known.
   */
  async resendVerification(ctx: ServiceContext): Promise<{ ok: true }> {
    const userId = this.requireUser(ctx);
    const mail = this.deps.mail;
    if (!mail) {
      throw new ServiceError(
        "mail_unconfigured", 503,
        "Email verification is not available on this deployment.",
      );
    }
    const db = asTx(ctx);
    const ip = (ctx.ip ?? "").trim();
    if (ip.length > 0) {
      const claimed = await reserveIpSlot(db, {
        namespace: "verify:ip",
        ip,
        now: ctx.now(),
        max: this.cfg.maxPublicRegistrationsPerWindow,
        windowMs: this.cfg.failureWindowMs,
      });
      if (!claimed) throw registrationRateLimited();
    }
    const user = await this.loadUser(db, userId);
    // Already proven ⇒ mint nothing. Re-issuing a live credential for an address that needs no
    // proof is pure downside, and the constant response means the caller cannot tell (nor do
    // they need to — the wizard reads `emailVerified` from `GET /auth/session`).
    if (user.emailVerifiedAt === null) {
      await mail.issueEmailVerification(ctx, { userId, to: user.email });
    }
    return { ok: true };
  }

  async login(ctx: ServiceContext, b: { email: string; password: string }): Promise<LoginResult> {
    const db = asTx(ctx);
    const email = requireField(b.email, "email").trim().toLowerCase();
    requireField(b.password, "password");

    // THE ATTEMPT IS RESERVED ON THE EMAIL KEY FIRST — before the user lookup, so both
    // branches below are already behind the same gate. Checking only
    // `user:<id>` made the lockout itself an account-existence oracle: past
    // `maxFailures` a REGISTERED email answered 423 while an unregistered one kept
    // answering 401 forever, which is a clean, reliable, unlimited enumeration
    // signal — and the re-entry path (a password-only login) is built on exactly
    // this endpoint. Every attempt below counts against the email key too, so the two
    // paths also lock after the same number of guesses, not merely with the same
    // status.
    //
    // RESERVE, NOT CHECK, and that is the whole bound. This was `throttleCheck` — a pure
    // SELECT — with the increment landing only after the password verify, so N simultaneous
    // requests all read "not locked", all ran their scrypt, and the effective limit was the
    // attacker's concurrency rather than `maxFailures`. See {@link throttleReserve}.
    await this.throttleReserve(db, `email:${email}`);

    const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const user = rows[0];

    // Constant-time unknown-email path: ALWAYS run a full password verify —
    // against the real hash when the user exists, against a decoy otherwise — and
    // fail with the IDENTICAL error either way, so timing/response never leaks
    // whether the email is registered. The decoy is memoized per hasher
    // ({@link decoyHashFor}), so this path does not pay an extra `hash()` the known
    // path never pays.
    if (!user) {
      await this.deps.passwordHasher.verify(b.password, await decoyHashFor(this.deps.passwordHasher));
      await this.throttleLock(db, `email:${email}`);
      throw new ServiceError("unauthorized", 401, "invalid email or password");
    }

    await this.throttleReserve(db, `user:${user.id}`);

    const cred = (await db.select().from(credentials).where(eq(credentials.userId, user.id)).limit(1))[0];
    const ok = cred ? await this.deps.passwordHasher.verify(b.password, cred.passwordHash) : false;
    if (!ok) {
      await this.throttleLock(db, `user:${user.id}`);
      await this.throttleLock(db, `email:${email}`);
      await this.audit(db, user, "login_failed", "password", ctx);
      throw new ServiceError("unauthorized", 401, "invalid email or password");
    }

    // The password was right, so give the reservations back. Both paths below reach a
    // `throttleReset` on success, but the `twofa_required` return does NOT — and without a
    // refund a user who opens the 2FA screen `maxFailures` times without finishing would lock
    // an account on which nothing has failed. See {@link throttleRefund} for why this is a
    // decrement and never a reset.
    await this.throttleRefund(db, `user:${user.id}`);
    await this.throttleRefund(db, `email:${email}`);

    const methods = await this.enrolledMethods(db, user.id);

    // RE-ENTRY. Zero enrolled methods ⇒ there is no second factor to
    // challenge. This used to return `{twofa_required, methods: []}` and no endpoint
    // accepts a login token with zero methods, so a user who registered and closed
    // the tab was locked out permanently. The password holder instead gets the same
    // enrollment-scoped session `register` mints: it can do NOTHING but enroll a
    // first factor. This does not lower the bar — for a user with no second factor
    // the password IS the only factor in existence — and the per-user lockout
    // above still governs how many guesses that takes.
    if (methods.length === 0) return this.establishEnrollment(ctx, user);

    // First factor OK → mint a single-use, short-lived login token carrying the
    // user's enrolled 2FA methods (never a full session on step one).
    const rawToken = generateToken();
    await db.insert(loginTokens).values({
      userId: user.id,
      tokenHash: hashToken(rawToken),
      methods,
      purpose: "login",
      expiresAt: new Date(ctx.now().getTime() + this.cfg.loginTokenTtlMs),
    });
    return { status: "twofa_required", loginToken: rawToken, methods };
  }

  /**
   * Session introspection. `scope` tells a resuming client (native especially)
   * whether it holds a full session or is still mid-enrollment, so it can route
   * itself back into the 2FA step without guessing from `twofaEnrolled`. It is
   * INFORMATIONAL: the privilege gate itself lives in `withSession`.
   */
  async getSession(ctx: ServiceContext): Promise<{ user: SessionUser; scope: SessionScope }> {
    if (!ctx.userId) throw new ServiceError("unauthorized", 401, "no active session");
    const db = asTx(ctx);
    return { user: await this.sessionUser(db, ctx.userId), scope: await this.sessionScope(db, ctx.sessionId) };
  }

  // ── Handing a session to the desktop app ────────────────────────────────────

  /**
   * Mint the ONE-USE code a desktop install exchanges for a session of its own.
   *
   * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────────────────────
   *
   * The desktop app's hosted door asks for an address, a password and a six-digit code, and it
   * has to: it holds no browser, so it cannot run a ceremony. That is a password typed into a
   * native window, which is the one place a person cannot check the address bar. This is the
   * alternative — the ceremony happens in the browser, where the account already has a session
   * and where a password manager and a URL bar both work, and the app receives a value that is
   * worth nothing to anybody who is not holding it within the next two minutes.
   *
   * ── IT REUSES `login_tokens`, AND THAT IS THE POINT ───────────────────────────────────────
   *
   * This is the third `purpose` on the same table (`login`, `email_verify`, and now
   * `desktop_link`), storing `hashToken(raw)` with a short `expires_at` and a `consumed_at`
   * that makes it single-use. A new table would have re-derived every one of those decisions
   * and got one of them slightly different. The purposes are mutually invisible BY QUERY, in
   * both directions, and each direction is a real refusal rather than a convention:
   * {@link peekLoginToken} filters `purpose='login'`, `consumeEmailVerification` filters
   * `purpose='email_verify'`, and {@link claimDesktopLink} filters `purpose='desktop_link'`.
   * So a code displayed on a web page cannot be presented as a first factor, and a token
   * MAILED to an inbox cannot be exchanged for a native session.
   *
   * ── WHY THE ROUTE IS STEP-UP GATED, AND WHY THIS METHOD DOES NOT SAY SO ───────────────────
   *
   * `POST /auth/desktop-link` carries `stepUp: true` — the same gate `DELETE /devices/:id`
   * carries, and for the mirror-image reason: this ADDS a device, and a device holds a refresh
   * token good for `nativeRefreshTtlMs` on a machine the browser session knows nothing about. A
   * live browser session alone must not be able to grow itself a rolling four-hundred-day native
   * credential — a window four times its own, on hardware it cannot see.
   *
   * The gate lives on the route rather than here because `withStepUp` is where every other
   * step-up decision in this codebase is made, and a second implementation of it inside a
   * service is how the two drift. `requireStepUp` is not called again: the double-gating on
   * `DELETE /auth/2fa/totp` exists because that call is destructive and irreversible, and this
   * one is neither.
   *
   * ── `challenge` — THE OPTIONAL COMMITMENT, AND WHY BINDING IS DECIDED HERE ────────────────
   *
   * A desktop install can now receive its code over a registered URL scheme rather than through
   * a person's fingers. A scheme is claimed by whichever program on the machine registered it,
   * and nothing authenticates that, so a code that travels over one has to be worth nothing to
   * an interceptor. `challenge` is what makes that true: the app invents a 32-byte verifier,
   * keeps it, sends only `sha256(verifier)` here, and {@link claimDesktopLink} will not spend
   * the code for anyone who cannot produce the verifier the digest was made from.
   *
   * BINDING IS DECIDED AT MINT AND NEVER AFTERWARDS. A row is written with a `challengeHash` or
   * without one; nothing updates the column. So there is no sequence of calls in which a code
   * that was minted bound becomes claimable unbound — which is the only direction that would
   * matter, and the reason this is a column on the row rather than an argument to the claim.
   *
   * An ABSENT challenge is not a fault. It is the browser flow that has existed all along: a
   * person who opened this page themselves has no verifier to commit to, and their code stays
   * retypable exactly as before. A MALFORMED challenge is a fault, and a loud one — see
   * {@link invalidDesktopChallenge}, because the alternative is minting an unbound code for a
   * caller that believes it is bound.
   */
  async issueDesktopLink(
    ctx: ServiceContext,
    b: { challenge?: unknown } = {},
  ): Promise<{ code: string; expiresIn: number }> {
    const userId = this.requireUser(ctx);
    const now = ctx.now();
    const code = generateToken();

    // Absent and blank are the same thing — the unbound flow — and everything else must LOOK
    // like an S256 challenge or be refused. `trim()` before the test rather than inside it, so
    // that a value the page pasted with a stray newline is accepted rather than being reported
    // as a fault the person cannot see.
    const raw = typeof b?.challenge === "string" ? b.challenge.trim() : "";
    if (b?.challenge !== undefined && b?.challenge !== null && typeof b.challenge !== "string") {
      throw invalidDesktopChallenge();
    }
    if (raw.length > 0 && !DESKTOP_CHALLENGE_RE.test(raw)) throw invalidDesktopChallenge();
    const challengeHash = raw.length > 0 ? raw : null;

    // ── A MINT SUPERSEDES. AT MOST ONE DESKTOP CODE PER USER, AND IT IS A REAL BOUND. ────────
    //
    // Two things, and the second is why this is a DELETE rather than a mark-consumed:
    //
    //  · **Security.** Pressing "show me another code" has to mean the one on screen stops
    //    working. Without this it does not: the first code stays claimable for its full two
    //    minutes, so a code that was shown on a shared screen — which is the most likely reason
    //    somebody asks for a second one — outlives the decision to replace it. Same rule
    //    {@link establishEnrollment} applies to password-only sessions, and for the same reason:
    //    at most one live credential of a kind per user.
    //  · **Growth.** `login_tokens` has no reaper (the `login` rows are bounded by the login
    //    throttle and `email_verify` by `verify:ip`; this route has neither, and it is reachable
    //    as often as an authenticated caller likes). Deleting rather than consuming bounds the
    //    rows this route can ever produce at one per user, permanently, instead of one per press.
    //
    // Nothing is lost by deleting. The history is in `auth_events` — this issue, and the `login`
    // the claim writes from the other machine — and a spent handoff row carries nothing beyond
    // what those two already say.
    //
    // ── `FOR UPDATE` ON THE OWNER ROW, EXACTLY AS {@link generateRecoveryCodes} DOES ──────────
    //
    // Delete-then-insert is not a supersede under READ COMMITTED. Two concurrent mints — a
    // double-click, a retry, an attacker racing a victim — both delete, then both insert, and
    // BOTH codes survive, because neither delete can see a row the other transaction has not
    // committed. The user is shown a fresh code and told the old one is dead while it is still
    // a live way into their mail. A transaction alone does not fix that; the lock does, and the
    // transaction is only what makes the lock outlive its statement.
    //
    // The `users` row is the lock and NOT the token rows, because `FOR UPDATE` can only lock
    // rows that EXIST — a first mint has no token row to lock and would race exactly as before.
    // The user's own row is always there.
    //
    // A CLAIM of the old code racing this is correct in both orders: the claim's `UPDATE` takes
    // the row lock and completes, then the row goes; or the row goes first and the claim finds
    // nothing and answers `invalid_code`. Neither can produce a session from a superseded code
    // after this returns.
    await this.inTransaction(ctx, async (txCtx) => {
      const db = asTx(txCtx);
      await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1).for("update");
      await db.delete(loginTokens).where(and(
        eq(loginTokens.userId, userId),
        eq(loginTokens.purpose, DESKTOP_LINK_PURPOSE),
      ));
      await db.insert(loginTokens).values({
        userId,
        tokenHash: hashToken(code),
        methods: [],
        purpose: DESKTOP_LINK_PURPOSE,
        // NULL for the retype flow, the commitment for the deep-link flow. Stored as sent: this
        // is the PUBLIC half of a PKCE pair, so hashing it again would only mean the claim had
        // to hash twice, and sealing it would be a key version carried for a value the client
        // already published.
        challengeHash,
        expiresAt: new Date(now.getTime() + this.cfg.desktopLinkTtlMs),
      });
      // Recorded on the account's own audit trail, INSIDE the transaction: a code that exists
      // and an issue that was not written down is the pair a person reviewing "what happened to
      // my account" would be missing. A code minted here is the whole of the authority the claim
      // needs, and the claim's own `login` row lands later and from a different address — so
      // without this line the first sign of a second machine is the machine.
      await this.audit(db, await this.loadUser(db, userId), "desktop_link_issued", undefined, ctx);
    });
    return { code, expiresIn: Math.floor(this.cfg.desktopLinkTtlMs / 1000) };
  }

  /**
   * Exchange a live handoff code for a native session. NO SESSION REQUIRED — the code is the
   * credential, which is the entire mechanism.
   *
   * ── SINGLE-USE IS THE DATABASE'S JOB, NOT THIS PROCESS'S ──────────────────────────────────
   *
   * ONE statement: `UPDATE … WHERE token_hash = … AND purpose = … AND consumed_at IS NULL AND
   * expires_at > now RETURNING user_id`. A SELECT-then-check-then-UPDATE is a read-modify-write,
   * and two requests carrying the same code both read `consumed_at IS NULL`, both pass, and both
   * establish a session — a defect no sequential test can see and that PGlite, being one
   * connection, structurally cannot reach. `consumeEmailVerification` was fixed for exactly this
   * and this is the same statement; `desktop-link.pg.test.ts` runs it concurrently against real
   * Postgres.
   *
   * ── ONE SENTENCE FOR EVERY WAY IT CAN FAIL ────────────────────────────────────────────────
   *
   * Unknown, expired, already claimed, the wrong purpose, blank, and the loser of a race all get
   * {@link invalidDesktopCode}. The remedy is identical in every case (ask the browser for a
   * fresh one) and the distinctions are only ours to know — the same rule
   * {@link invalidVerification} states at more length.
   *
   * ── THE ATTEMPT BOUND, AND WHY AN UNKNOWN IP DOES NOT REFUSE ──────────────────────────────
   *
   * A slot claim per IP, not the lockout counter: nothing has FAILED in the sense
   * `account_locked` means, there is no account to name before the code is read, and a lockout
   * keyed on a value an attacker chooses is a denial of service. `reserveIpSlot` answers 429
   * — the shape `register` and `resendVerification` already use.
   *
   * When `ctx.ip` is blank the request is admitted, and that is the opposite of what
   * `register` does on its open path. The reasoning is `register`'s own, applied to a different
   * endpoint: an unidentifiable client is bounded by whatever does not need an identity, and
   * here that is a 128-bit single-use secret with a two-minute life. Refusing instead would take
   * the whole flow away on any deployment without a trusted client-IP header, to bound a search
   * space nobody can walk.
   *
   * ── `verifier` — THE OTHER HALF OF A COMMITMENT MADE AT MINT ──────────────────────────────
   *
   * A code minted with a challenge is spendable only by a caller that can produce the value the
   * challenge is the digest of. That is what lets the browser hand a code to a desktop install
   * over a URL scheme: any program on the machine may register `ohmail://`, and the one that
   * wins gets a code it cannot spend, because the verifier never left the process that invented
   * it. A code minted WITHOUT a challenge is unchanged — the retype flow, claimable by whoever
   * holds it, and byte-for-byte the behaviour that shipped before this parameter existed.
   *
   * ── THE BINDING IS INSIDE THE SAME SINGLE UPDATE, AND THAT IS NOT AN OPTIMISATION ─────────
   *
   * Reading the row, comparing the digest in this process, and then burning the code is a
   * read-modify-write with the same defect the single-use guard above exists to prevent: two
   * requests both read a live row, both find the binding satisfied, and both burn it. Making the
   * binding one more conjunct of the WHERE means the database decides both facts at once, under
   * one row lock, and there is no window between them at all.
   *
   * ── AN ABSENT `verifier` IS `challenge_hash IS NULL`, AND MUST NOT BE "NO CONDITION" ──────
   *
   * The shape that is easy to write and wrong is `if (verifier) where.push(binding)`: with no
   * verifier there is no predicate, so a BOUND code is claimable by anyone who omits the field.
   * The whole mechanism is then bypassed by sending less. So the predicate is unconditional and
   * only its SHAPE varies — with a verifier, "bound to exactly this digest"; without one,
   * "unbound", full stop. Neither form can match a bound row without the verifier, and the
   * second form is a real refusal rather than an accident of comparing against the digest of an
   * empty string (a challenge somebody could deliberately mint).
   *
   * ── A PRESENTED VERIFIER REQUIRES A BOUND MATCH — IT DOES NOT ALSO ADMIT UNBOUND CODES ─────
   *
   * The `verifier`-present arm is an EXACT match on `challenge_hash`, not "unbound OR bound to
   * this digest". Admitting an unbound code while a verifier is presented is login CSRF, and the
   * direction that bites is INJECTION, not theft: an attacker mints an UNBOUND code for their own
   * account and delivers `ohmail://link?code=…` to a victim whose install is mid browser-handoff
   * and therefore holding a verifier of its own. Under an `or(isNull(challenge_hash), …)` arm the
   * victim's verifier is irrelevant — the unbound attacker row satisfies `isNull` — and the claim
   * burns it and signs the victim's desktop into the ATTACKER's account (session fixation).
   *
   * Requiring the bound match closes it with no cost to any real client: the only caller that
   * ever presents a verifier is one that minted a challenge before opening the browser
   * (`apps/sidecar/src/cloud-engine.ts` keeps the verifier and publishes the challenge; the field
   * is OMITTED, never sent, when no challenge was minted — `cloud-signin.ts`), so a presented
   * verifier always accompanies a code the browser minted BOUND to that challenge. No legitimate
   * client claims an unbound code while presenting a verifier; the unbound retype path, which
   * presents no verifier, is unchanged.
   *
   * ── A FAILED BINDING DOES NOT BURN THE CODE ───────────────────────────────────────────────
   *
   * The predicate is on the UPDATE, so a claim whose verifier does not match matches no row and
   * changes nothing. The code stays live for the rest of its two minutes and the person whose
   * app is holding the right verifier can still use it. An implementation that consumed first
   * and compared afterwards would let any interceptor destroy a code it could not spend.
   *
   * ── AND THE REFUSAL IS THE SAME SENTENCE AS "NO SUCH CODE" ────────────────────────────────
   *
   * A wrong verifier, a missing verifier on a bound code, an unknown code and a spent one all
   * get {@link invalidDesktopCode}. Distinguishing them would tell a caller holding a code that
   * the code is real and only the proof is wrong, which is exactly the fact a scheme
   * interceptor would like to learn.
   */
  async claimDesktopLink(
    ctx: ServiceContext, b: { code?: unknown; verifier?: unknown; kind?: unknown },
  ): Promise<{ tokens: OAuthTokens }> {
    const db = asTx(ctx);
    const now = ctx.now();
    const raw = typeof b?.code === "string" ? b.code.trim() : "";
    const verifier = typeof b?.verifier === "string" ? b.verifier.trim() : "";
    // WHAT the claimant says it is — {@link DESKTOP_CLAIM_KINDS}, and ABSENT means the legacy
    // `"macos"`: every shipped desktop claims without the field, and its rows keep reading
    // exactly as they always have. Refused BEFORE the ip slot and BEFORE the burn — a
    // malformed declaration is the caller's bug and must cost neither an attempt from its
    // connection's budget nor the single-use code the browser is still showing.
    let kind: DeviceKind = "macos";
    if (b?.kind !== undefined) {
      if (typeof b.kind !== "string" || !DESKTOP_CLAIM_KINDS.has(b.kind)) {
        throw invalidDeviceKind(DESKTOP_CLAIM_KINDS);
      }
      kind = b.kind as DeviceKind;
    }
    const ip = (ctx.ip ?? "").trim();
    if (ip.length > 0) {
      const claimed = await reserveIpSlot(db, {
        namespace: "desktop_claim:ip",
        ip,
        now,
        max: this.cfg.maxDesktopClaimsPerWindow,
        windowMs: this.cfg.failureWindowMs,
      });
      if (!claimed) throw desktopClaimRateLimited();
    }
    // Bounded before it reaches `sha256`, for `requirePassword`'s reason: this value arrives
    // from an anonymous caller and an unbounded body is free work for whoever wants to send a
    // megabyte of it. A real code is `generateToken()`-shaped and nowhere near this.
    if (raw.length === 0 || raw.length > 512) throw invalidDesktopCode();
    // Bounded for the same reason the code is, and BEFORE `hashToken` runs over it. A verifier
    // this long is not one this flow produces (32 bytes, base64url, 43 characters), so the bound
    // costs a real client nothing.
    if (verifier.length > 512) throw invalidDesktopCode();

    // ONE predicate either way — see the header. `presented` is never "no condition".
    const binding = verifier.length > 0
      ? eq(loginTokens.challengeHash, hashToken(verifier))
      : isNull(loginTokens.challengeHash);

    const [row] = await db.update(loginTokens)
      .set({ consumedAt: now })
      .where(and(
        eq(loginTokens.tokenHash, hashToken(raw)),
        eq(loginTokens.purpose, DESKTOP_LINK_PURPOSE),
        isNull(loginTokens.consumedAt),
        gt(loginTokens.expiresAt, now),
        binding,
      ))
      .returning({ userId: loginTokens.userId });
    if (!row) throw invalidDesktopCode();

    const user = await this.loadUser(db, row.userId);
    // The device row is labelled for the app — the claimant's own declared kind, or the legacy
    // `"macos"` when it said nothing — so `GET /devices` shows the machine that claimed the code
    // and `DELETE /devices/:id` can take it away again. That revocation path is the reason the
    // handoff is safe to offer at all.
    //
    // `surface: "native"` is PINNED, not derived, and the pin is what makes the declaration
    // privilege-free: every admissible kind mints the identical credential — the bearer pair
    // this route answers with, on the native window this door has always issued (for the legacy
    // `"macos"` the pin and the derivation agree byte for byte). The kind therefore selects a
    // device row's spelling and nothing else. Without the pin the platform-qualified kinds
    // would fall to the derivation's strict side and shrink the window — a behavior change for
    // exactly the installs this field exists to name.
    //
    // NO `method`, so no `2fa_verified` row is written: no factor was asserted HERE. What was
    // asserted is on the mint side — the browser session cleared `withStepUp` less than
    // `desktopLinkTtlMs` ago — which is what makes the `lastTwofaAt: now` that `establish`
    // stamps an honest record rather than a laundered one.
    // `twofaAt: ctx.now()` — HONEST HERE, and the reason is the paragraph above: the mint side
    // cleared `withStepUp` less than `desktopLinkTtlMs` ago, so a factor really was asserted by
    // this person, within two minutes, on the browser that produced this code. That precondition
    // is what the PKCE door lacked until step-up was enforced on its mint; see {@link establish}.
    const established = await this.establish(ctx, user, { kind, twofaAt: ctx.now(), surface: "native" });
    // The pair and nothing else, the shape `POST /auth/refresh`'s native branch answers with.
    // The claimant is a desktop install; a `user` object it does not read, and a `Set-Cookie`
    // that would turn a code displayed on a screen into a browser session, are both things
    // this route deliberately does not hand back. The route sets no cookies either.
    return { tokens: established.tokens! };
  }

  // ── WebAuthn (primary 2FA) ──────────────────────────────────────────────────

  async webauthnRegisterOptions(ctx: ServiceContext): Promise<{ options: unknown }> {
    const userId = this.requireUser(ctx);
    // Origin admission, before the FIRST DATABASE READ — the only thing ahead of it is
    // `requireUser`, an in-memory `ctx.userId` presence check. The REQUEST's origin is
    // matched against the allow-list HERE, so an unlisted origin learns at options time
    // (403 `origin_not_allowed`) and never reaches a session read, key material, or a
    // challenge row. Ordered ahead of `requireEnrollmentOrStepUp` (a session-table READ)
    // deliberately, and identically to `webauthnAssertOptions`.
    const origin = resolveCeremonyOrigin(this.cfg, ctx.origin);
    await this.requireEnrollmentOrStepUp(ctx);
    const db = asTx(ctx);
    const user = await this.loadUser(db, userId);
    const existing = await this.webauthnCreds(db, userId);
    const options = await buildRegistrationOptions(this.cfg, user, existing);
    await db.insert(webauthnChallenges).values({
      userId, challenge: options.challenge, type: "registration",
      rpId: this.cfg.rpID, origin,
      expiresAt: new Date(ctx.now().getTime() + this.cfg.webauthnChallengeTtlMs),
    });
    return { options };
  }

  /**
   * Verify a passkey registration. `session` is present ONLY when the caller was an
   * enrollment-scoped session: enrolling the first factor EXCHANGES it for a full
   * one (see {@link exchangeEnrollmentSession}). `o.client` is the transport the
   * request arrived on, used to label the device the exchanged session registers.
   */
  async webauthnRegisterVerify(
    ctx: ServiceContext, b: { credential: any; label: string },
    o: { client?: "web" | "macos" } = {},
  ): Promise<{ credentialId: string; twofaEnrolled: TwofaEnrolled; session?: SessionEstablished }> {
    const userId = this.requireUser(ctx);
    await this.requireEnrollmentOrStepUp(ctx);
    // The challenge is consumed and the signature verified BEFORE the transaction
    // opens: single-use must survive a rolled-back enrollment (burning it on a failed
    // verify is the safe direction), and the crypto touches no rows.
    const ch = await this.consumeChallenge(asTx(ctx), ctx, { userId, type: "registration" });
    // `expectedOrigin` is the STORED origin, so a passkey created on one allow-listed
    // origin cannot land through a ceremony opened on another even
    // though both are allow-listed. A verification failure is a 401, not the 500 the
    // raw `@simplewebauthn` throw used to produce on the enrollment surface.
    let reg;
    try {
      reg = await verifyRegistration(this.cfg, b.credential, ch.challenge, ch.origin);
    } catch {
      throw new ServiceError("unauthorized", 401, "passkey registration verification failed");
    }

    // ONE transaction for "the factor lands ⇄ the enrollment session is retired".
    // Autocommitting them separately left a window in which the passkey existed and
    // the password-only session was still live (or vice versa).
    return this.inTransaction(ctx, async (tctx) => {
      const db = asTx(tctx);
      const [row] = await db.insert(webauthnCredentials).values({
        userId, credentialId: reg.credentialId, publicKey: reg.publicKey,
        counter: reg.counter, transports: reg.transports, label: b.label ?? "",
        deviceType: reg.deviceType, backedUp: reg.backedUp,
      }).returning();
      const twofaEnrolled = await this.twofaEnrolled(db, userId);
      const session = await this.exchangeEnrollmentSession(tctx, userId, "webauthn", o.client);
      return { credentialId: row!.id, twofaEnrolled, ...(session ? { session } : {}) };
    });
  }

  async webauthnAssertOptions(ctx: ServiceContext, b: { loginToken: string }): Promise<{ options: unknown }> {
    const db = asTx(ctx);
    requireField(b.loginToken, "loginToken");
    // Origin admission, before the FIRST DATABASE READ (`peekLoginToken`) — same ordering
    // as `webauthnRegisterOptions`. `asTx` above only unwraps the handle; it queries
    // nothing.
    const origin = resolveCeremonyOrigin(this.cfg, ctx.origin);
    const lt = await this.peekLoginToken(db, ctx, b.loginToken);
    const allow = await this.webauthnCreds(db, lt.userId);
    const options = await buildAuthenticationOptions(this.cfg, allow);
    await db.insert(webauthnChallenges).values({
      loginTokenId: lt.id, challenge: options.challenge, type: "authentication",
      rpId: this.cfg.rpID, origin,
      expiresAt: new Date(ctx.now().getTime() + this.cfg.webauthnChallengeTtlMs),
    });
    return { options };
  }

  async webauthnAssertVerify(
    ctx: ServiceContext, b: { loginToken: string; credential: any },
  ): Promise<SessionEstablished> {
    const db = asTx(ctx);
    requireField(b.loginToken, "loginToken");
    if (b.credential == null) throw new ServiceError("validation_failed", 400, "credential is required");
    const lt = await this.peekLoginToken(db, ctx, b.loginToken);
    const user = await this.loadUser(db, lt.userId);
    // RESERVED, not read — see {@link throttleReserve}. `peekLoginToken` deliberately does not
    // consume, so one live login token can be presented arbitrarily many times at once; with a
    // pure read in front of the verify the second factor had the same concurrency bound the
    // password did, which for a second factor means the whole 2FA gate.
    await this.throttleReserve(db, `user:${user.id}`);

    const ch = await this.consumeChallenge(db, ctx, { loginTokenId: lt.id, type: "authentication" });
    const credId = b.credential?.id as string | undefined;
    const stored = (await this.webauthnCreds(db, user.id)).find((c) => c.credentialId === credId);
    if (!stored) {
      await this.twofaFail(db, user, ctx);
      throw new ServiceError("unauthorized", 401, "unknown credential");
    }

    let result;
    try {
      // @simplewebauthn REJECTS a regressed signature counter (clone detection).
      result = await verifyAssertion(this.cfg, b.credential, ch.challenge, stored, ch.origin);
    } catch {
      await this.twofaFail(db, user, ctx);
      throw new ServiceError("unauthorized", 401, "two-factor verification failed");
    }

    await db.update(webauthnCredentials)
      .set({ counter: result.newCounter, lastUsedAt: ctx.now() })
      .where(eq(webauthnCredentials.credentialId, stored.credentialId));
    await this.consumeLoginToken(db, lt.id, ctx.now());
    // A WebAuthn assertion just succeeded, here. `now` is the factor's real time.
    return this.establish(ctx, user, { method: "webauthn", kind: "web", twofaAt: ctx.now() });
  }

  // ── TOTP (fallback 2FA) ─────────────────────────────────────────────────────

  /**
   * Begin a TOTP enrollment. Returns the shared secret and the `otpauth://` provisioning URI
   * — and NOT a QR image; see the note at the foot of `totp.ts` for what used to be here and
   * why a server-rendered one was both a lie and the wrong layer.
   */
  async totpEnroll(ctx: ServiceContext): Promise<{ secret: string; otpauthUrl: string }> {
    const userId = this.requireUser(ctx);
    await this.requireEnrollmentOrStepUp(ctx);
    const db = asTx(ctx);
    const user = await this.loadUser(db, userId);
    const secret = newTotpSecret();
    const { ciphertext, keyVersion } = await this.deps.keyProvider.encrypt(secret);

    await db.delete(totpSecrets).where(and(eq(totpSecrets.userId, userId), eq(totpSecrets.activated, false)));
    await db.insert(totpSecrets).values({ userId, secretEnc: ciphertext, keyVersion, activated: false });

    const otpauthUrl = totpUri({ issuer: this.cfg.totpIssuer, label: user.email, secret });
    return { secret, otpauthUrl };
  }

  /** Activate a pending TOTP secret. `session` semantics as in {@link webauthnRegisterVerify}. */
  async totpActivate(
    ctx: ServiceContext, b: { code: string }, o: { client?: "web" | "macos" } = {},
  ): Promise<{ twofaEnrolled: TwofaEnrolled; session?: SessionEstablished }> {
    const userId = this.requireUser(ctx);
    requireField(b.code, "code");
    await this.requireEnrollmentOrStepUp(ctx);
    // ONE transaction: activation, the single-use `lastConsumedStep` advance and the
    // enrollment-session exchange are the same privilege change. `FOR UPDATE` on the
    // secret row also serializes two concurrent activations of the same secret.
    return this.inTransaction(ctx, async (tctx) => {
      const db = asTx(tctx);
      const row = (await db.select().from(totpSecrets)
        .where(eq(totpSecrets.userId, userId)).limit(1).for("update"))[0];
      if (!row) throw new ServiceError("unprocessable", 422, "no TOTP enrollment in progress");
      const secret = await this.deps.keyProvider.decrypt(row.secretEnc, row.keyVersion);
      const v = verifyTotp({ secret, token: b.code, now: tctx.now(), window: this.cfg.totpWindow, afterStep: numOrNull(row.lastConsumedStep) });
      if (!v.valid) throw new ServiceError("unprocessable", 422, "invalid TOTP code");
      await db.update(totpSecrets)
        .set({ activated: true, lastConsumedStep: BigInt(v.timeStep!), updatedAt: tctx.now() })
        .where(eq(totpSecrets.userId, userId));
      const twofaEnrolled = await this.twofaEnrolled(db, userId);
      const session = await this.exchangeEnrollmentSession(tctx, userId, "totp", o.client);
      return { twofaEnrolled, ...(session ? { session } : {}) };
    });
  }

  /**
   * `b.kind` — the CALLER's own declaration of what it is, {@link DESKTOP_DECLARED_KINDS} or
   * absent, and it exists for one client: the desktop's cloud-door password sign-in, which
   * lands on this seam through a native process rather than a browser and used to mint a
   * DEVICELESS session — invisible to per-device staleness attribution, so the console could
   * see the account wedge but never say which install. A present declaration makes `establish`
   * auto-mint a device row of that kind (label from its map), exactly the row the desktop-link
   * claim has always minted.
   *
   * NO PRIVILEGE RIDES ON IT, and the set is why: the admissible kinds all derive the COOKIE
   * lifetime surface (none is `"macos"`, the one native-deriving kind — see the set's doc), so
   * a declared sign-in gets the same window, scope and factor stamp as an undeclared one, to
   * the byte. The only delta is `device_id` pointing at a row — vocabulary and attribution.
   * The row's consequences all point the safe direction: `GET /devices` names it,
   * `DELETE /devices/:id` can aim at it, and the device staleness alarm WATCHES it (including
   * the never-synced arm) instead of the weaker session rule. The one behavioral trade is that
   * `POST /devices/revoke-web-sessions` (a `device_id IS NULL` sweep) no longer catches it —
   * which is the standing semantics of every named device, paired ones included, and the
   * individually-aimable revoke is what replaces the sweep.
   *
   * Refused BEFORE the throttle reserve and the token peek: a malformed declaration is the
   * caller's bug and must burn neither a lockout slot nor the login token's window.
   */
  async totpVerify(
    ctx: ServiceContext, b: { loginToken: string; code: string; kind?: unknown },
  ): Promise<SessionEstablished> {
    const db = asTx(ctx);
    requireField(b.loginToken, "loginToken");
    requireField(b.code, "code");
    let kind: DeviceKind = "web";
    if (b.kind !== undefined) {
      if (typeof b.kind !== "string" || !DESKTOP_DECLARED_KINDS.has(b.kind)) {
        throw invalidDeviceKind(DESKTOP_DECLARED_KINDS);
      }
      kind = b.kind as DeviceKind;
    }
    const lt = await this.peekLoginToken(db, ctx, b.loginToken);
    const user = await this.loadUser(db, lt.userId);
    // RESERVED, not read: six digits behind a pure-read gate is a code an attacker can spray as
    // wide as their connection count. See {@link throttleReserve}.
    await this.throttleReserve(db, `user:${user.id}`);

    const row = (await db.select().from(totpSecrets)
      .where(and(eq(totpSecrets.userId, user.id), eq(totpSecrets.activated, true))).limit(1))[0];
    if (!row) {
      await this.twofaFail(db, user, ctx);
      throw new ServiceError("unauthorized", 401, "two-factor verification failed");
    }
    const secret = await this.deps.keyProvider.decrypt(row.secretEnc, row.keyVersion);
    // Single-use per timestep: reject any token whose step ≤ the last consumed one.
    const v = verifyTotp({ secret, token: b.code, now: ctx.now(), window: this.cfg.totpWindow, afterStep: numOrNull(row.lastConsumedStep) });
    if (!v.valid) {
      await this.twofaRefused(db, user, ctx, this.replayedTotp(secret, b.code, ctx.now()));
      throw new ServiceError("unauthorized", 401, "two-factor verification failed");
    }
    // ADVANCE THE STEP CONDITIONALLY — this is what makes "single-use per timestep"
    // true rather than merely intended. `verifyTotp` was given `afterStep` from a row this
    // call READ; an unconditional write means two submissions of the same six digits within
    // the same 30-second window both read the old step, both verify, and both establish a
    // session. `totpActivate` already got this right by holding `FOR UPDATE` inside a
    // transaction; the verify path is not in one, so the predicate has to do the work.
    const advanced = await db.update(totpSecrets)
      .set({ lastConsumedStep: BigInt(v.timeStep!), updatedAt: ctx.now() })
      .where(and(
        eq(totpSecrets.userId, user.id),
        eq(totpSecrets.activated, true),
        or(
          isNull(totpSecrets.lastConsumedStep),
          lessThan(totpSecrets.lastConsumedStep, BigInt(v.timeStep!)),
        ),
      ))
      .returning({ id: totpSecrets.id });
    if (advanced.length === 0) {
      // Somebody else consumed this timestep between our read and our write. Identical
      // answer to a wrong code — the caller must not learn that their code was right — but
      // it is a REPLAY by construction (the code verified; only the step was spent), so it
      // is not counted toward the lockout. See {@link twofaRefused}.
      await this.twofaRefused(db, user, ctx, true);
      throw new ServiceError("unauthorized", 401, "two-factor verification failed");
    }
    await this.consumeLoginToken(db, lt.id, ctx.now());
    // A TOTP code was just verified, here. `now` is the factor's real time. `kind` is the
    // caller's declaration or `"web"` — either way it derives the cookie window (see the
    // header), so the declaration reaches the device row and nothing else.
    return this.establish(ctx, user, { method: "totp", kind, twofaAt: ctx.now() });
  }

  async totpRemove(ctx: ServiceContext): Promise<void> {
    const userId = this.requireUser(ctx);
    await this.requireStepUp(ctx);
    const db = asTx(ctx);
    // "Cannot remove the last factor": TOTP may only go if a WebAuthn factor
    // remains (recovery codes are a break-glass fallback, not a standalone factor).
    const remainingWebauthn = (await this.webauthnCreds(db, userId)).length;
    if (remainingWebauthn < 1) {
      throw new ServiceError("unprocessable", 422, "cannot remove the last 2FA method");
    }
    await db.delete(totpSecrets).where(eq(totpSecrets.userId, userId));
  }

  // ── Step-up re-verification (the inline ceremony behind a stale 5-minute window) ────────
  //
  // `withStepUp` refuses a stale `last_twofa_at` with 403 `step_up_required`, and until these
  // methods existed the ONLY way to refresh the stamp was a full sign-out/sign-in round trip —
  // which turned every step-up-gated verb (mint a pairing code, revoke a device, remove a
  // factor) into a dead end the moment five minutes had passed. These are the sign-in second
  // factor, re-run against the session the caller already holds:
  //
  //  · **The factor is the whole proof.** Same verify, same single-use guards (the TOTP
  //    timestep advance, the challenge claim), same throttle key and lockout as the sign-in
  //    path — so a code spent at sign-in cannot be replayed here, and spraying codes at this
  //    door locks the same counter the sign-in door locks.
  //  · **The stamp is a GUARDED update** ({@link stampStepUp}): `revoked_at IS NULL AND
  //    scope = 'full'` re-checked in the write itself, `RETURNING` inspected, 401 on zero
  //    rows. An enrollment-scoped session can never re-stamp itself into step-up standing
  //    (`withSession` already refuses it these routes; the predicate refuses it again), and a
  //    session revoked mid-ceremony gets a refusal, never `{ok:true}` over an unstamped row.
  //  · **No new cookie surface.** The response is `{ok: true}` and nothing else — no tokens,
  //    no Set-Cookie, no session exchange. The session is the one the caller presented; only
  //    its factor clock moves.
  //  · A paired device's bearer (minted with `twofaAt: null` — see `establishPairedDevice`)
  //    MAY earn step-up standing here by asserting a real factor. That is the designed door:
  //    "this session cannot reach POST /pair until its holder asserts a factor of their own."

  /** Re-verify TOTP against the caller's own session and re-stamp its step-up clock. */
  async stepUpTotp(ctx: ServiceContext, b: { code: string }): Promise<{ ok: true }> {
    const userId = this.requireUser(ctx);
    requireField(b.code, "code");
    if (!ctx.sessionId) throw new ServiceError("unauthorized", 401, "no active session");
    const db = asTx(ctx);
    const user = await this.loadUser(db, userId);
    // RESERVED, not read — the sign-in verify's exact argument: six digits behind a pure-read
    // gate is a code an attacker can spray as wide as their connection count.
    await this.throttleReserve(db, `user:${user.id}`);

    const row = (await db.select().from(totpSecrets)
      .where(and(eq(totpSecrets.userId, user.id), eq(totpSecrets.activated, true))).limit(1))[0];
    if (!row) {
      await this.twofaFail(db, user, ctx);
      throw new ServiceError("unauthorized", 401, "two-factor verification failed");
    }
    const secret = await this.deps.keyProvider.decrypt(row.secretEnc, row.keyVersion);
    const v = verifyTotp({ secret, token: b.code, now: ctx.now(), window: this.cfg.totpWindow, afterStep: numOrNull(row.lastConsumedStep) });
    if (!v.valid) {
      await this.twofaRefused(db, user, ctx, this.replayedTotp(secret, b.code, ctx.now()));
      throw new ServiceError("unauthorized", 401, "two-factor verification failed");
    }
    // The conditional advance, INCLUDING the fail-on-zero-rows arm — `totpVerify`'s exact
    // shape, and the property it buys here is cross-door: a code consumed at sign-in (or at a
    // concurrent step-up) advanced the SAME row, so this write matches nothing and the replay
    // is refused with the wrong-code sentence.
    const advanced = await db.update(totpSecrets)
      .set({ lastConsumedStep: BigInt(v.timeStep!), updatedAt: ctx.now() })
      .where(and(
        eq(totpSecrets.userId, user.id),
        eq(totpSecrets.activated, true),
        or(
          isNull(totpSecrets.lastConsumedStep),
          lessThan(totpSecrets.lastConsumedStep, BigInt(v.timeStep!)),
        ),
      ))
      .returning({ id: totpSecrets.id });
    if (advanced.length === 0) {
      // A replay by construction — the code verified, the step was already spent. Same
      // sentence, no lockout slot burned. See {@link twofaRefused}.
      await this.twofaRefused(db, user, ctx, true);
      throw new ServiceError("unauthorized", 401, "two-factor verification failed");
    }
    // A TOTP code was just verified, here, by the holder of THIS session.
    return this.stampStepUp(ctx, db, user, "totp");
  }

  /**
   * Open a WebAuthn assertion for step-up. The challenge row is bound to the USER
   * (`userId` set, `loginTokenId` NULL) — the exact inverse of a sign-in assertion row
   * (`loginTokenId` set, `userId` NULL), so neither ceremony's consume predicate can ever
   * select the other's challenge: `consumeChallenge` ANDs the key it is given, and a NULL
   * column matches no equality. Origin admission runs before the first database read,
   * `webauthnAssertOptions`'s ordering exactly.
   */
  async stepUpWebauthnOptions(ctx: ServiceContext): Promise<{ options: unknown }> {
    const userId = this.requireUser(ctx);
    if (!ctx.sessionId) throw new ServiceError("unauthorized", 401, "no active session");
    const db = asTx(ctx);
    const origin = resolveCeremonyOrigin(this.cfg, ctx.origin);
    const allow = await this.webauthnCreds(db, userId);
    if (allow.length === 0) {
      throw new ServiceError("unprocessable", 422, "no passkey enrolled");
    }
    const options = await buildAuthenticationOptions(this.cfg, allow);
    await db.insert(webauthnChallenges).values({
      userId, challenge: options.challenge, type: "authentication",
      rpId: this.cfg.rpID, origin,
      expiresAt: new Date(ctx.now().getTime() + this.cfg.webauthnChallengeTtlMs),
    });
    return { options };
  }

  /** Verify the step-up assertion and re-stamp the caller's session. */
  async stepUpWebauthnVerify(ctx: ServiceContext, b: { credential: any }): Promise<{ ok: true }> {
    const userId = this.requireUser(ctx);
    if (!ctx.sessionId) throw new ServiceError("unauthorized", 401, "no active session");
    if (b.credential == null) throw new ServiceError("validation_failed", 400, "credential is required");
    const db = asTx(ctx);
    const user = await this.loadUser(db, userId);
    await this.throttleReserve(db, `user:${user.id}`);

    // The claim binds to the challenge THIS assertion was signed over — read from the
    // credential's own clientDataJSON — never merely "the user's newest". A user-only lookup
    // let two overlapping ceremonies (two tabs, or any second session of the same user) burn
    // each other: the older tab's legitimate assertion was matched against the newer tab's
    // challenge, failed, counted toward the SHARED lockout, and consumed the newer row —
    // repeatable into a factor lockout by anyone holding any session of the account. The
    // extracted value is only a row SELECTOR: `verifyAssertion` below still checks the signed
    // clientDataJSON against the claimed row's challenge and origin, so a forged selector can
    // only select a row the signature then has to actually match. `userId` stays in the
    // predicate NON-optionally — `consumeChallenge`'s keys are optional, and a call that
    // passed neither key would select ANY newest authentication challenge.
    const submitted = challengeOfAssertion(b.credential);
    if (!submitted) {
      await this.twofaFail(db, user, ctx);
      throw new ServiceError("unauthorized", 401, "two-factor verification failed");
    }
    // A claim that finds no row — a selector naming no open ceremony, an expired row, an
    // origin mismatch — is a FAILED FACTOR at this door and is finalized as one
    // (`twofaFail`: the `2fa_failed` audit and the lockout upgrade at the threshold).
    // The verification pass caught the escape: `consumeChallenge`'s own throw used to leave
    // the reserved attempt unfinalized, so the max-th bad assertion answered 401 with no
    // lock, and waiting out the failure window could skip the lockout entirely. The refusal
    // is re-spoken in the wrong-code sentence — the caller must not learn WHICH part failed.
    let ch;
    try {
      ch = await this.consumeChallenge(db, ctx, { userId: user.id, type: "authentication", challenge: submitted });
    } catch {
      await this.twofaFail(db, user, ctx);
      throw new ServiceError("unauthorized", 401, "two-factor verification failed");
    }
    const credId = b.credential?.id as string | undefined;
    const stored = (await this.webauthnCreds(db, user.id)).find((c) => c.credentialId === credId);
    if (!stored) {
      await this.twofaFail(db, user, ctx);
      throw new ServiceError("unauthorized", 401, "unknown credential");
    }
    let result;
    try {
      result = await verifyAssertion(this.cfg, b.credential, ch.challenge, stored, ch.origin);
    } catch {
      await this.twofaFail(db, user, ctx);
      throw new ServiceError("unauthorized", 401, "two-factor verification failed");
    }
    await db.update(webauthnCredentials)
      .set({ counter: result.newCounter, lastUsedAt: ctx.now() })
      .where(eq(webauthnCredentials.credentialId, stored.credentialId));
    // A WebAuthn assertion just succeeded, here, by the holder of THIS session.
    return this.stampStepUp(ctx, db, user, "webauthn");
  }

  /**
   * The one writer of a step-up RE-stamp (the mint-time writer is `establish`'s `twofaAt`).
   * Guarded in the statement itself — `revoked_at IS NULL AND scope = 'full'` — and judged by
   * `RETURNING`: zero rows is a refusal, never a success over an unstamped session. Reached
   * only from a factor verify that has already succeeded in this same call.
   */
  private async stampStepUp(
    ctx: ServiceContext, db: Tx, user: typeof users.$inferSelect, method: "totp" | "webauthn",
  ): Promise<{ ok: true }> {
    const now = ctx.now();
    const stamped = await db.update(sessions)
      .set({ lastTwofaAt: now, lastSeenAt: now })
      .where(and(
        eq(sessions.id, ctx.sessionId!),
        eq(sessions.userId, user.id),
        isNull(sessions.revokedAt),
        eq(sessions.scope, "full"),
      ))
      .returning({ id: sessions.id });
    if (stamped.length === 0) {
      throw new ServiceError("unauthorized", 401, "no active session");
    }
    await this.audit(db, user, "2fa_verified", method, ctx);
    await this.throttleReset(db, `user:${user.id}`);
    await this.throttleReset(db, `email:${user.email}`);
    return { ok: true };
  }

  // ── Recovery codes ──────────────────────────────────────────────────────────

  /**
   * Mint a fresh batch of ten break-glass codes and retire every earlier one.
   *
   * ── WHY THE LOCK, AND WHY A TRANSACTION ALONE IS NOT ENOUGH ───────────────────────────────
   *
   * This was a bare `delete` followed by a bare `insert` on the ambient handle, and the two
   * statements auto-committed separately. Two regenerations that overlap — a double-submitted
   * button, a retry, an attacker racing a victim — both delete, then both insert, and BOTH
   * batches survive: the delete cannot see rows the other transaction has not committed yet.
   * The user is shown a new sheet and told the old one is dead while ten retired codes remain
   * live second factors.
   *
   * Wrapping the pair in a transaction does NOT fix that under READ COMMITTED, which is why the
   * `FOR UPDATE` on the OWNER ROW is the mechanism and the transaction is only what makes the
   * lock outlive its statement. Two callers now serialize: the second one's delete runs after
   * the first one's insert is visible, so it removes those rows and exactly one batch is left.
   *
   * The `users` row is the lock and not the code rows themselves, because `FOR UPDATE` can only
   * lock rows that EXIST — two regenerations for a user who has no codes yet would lock nothing
   * and race exactly as before. The user's own row is always there.
   *
   * And that is still only half: {@link recoveryVerify} honours the NEWEST batch only, so a pair
   * of batches already sitting in the database from before this fix cannot both be valid either.
   */
  async generateRecoveryCodes(ctx: ServiceContext): Promise<RecoveryCodesResp> {
    const userId = this.requireUser(ctx);
    await this.requireStepUp(ctx);
    const codes: string[] = [];
    await this.inTransaction(ctx, async (txCtx) => {
      const db = asTx(txCtx);
      // Serializes regeneration per user. See the note above for why it is this row.
      await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1).for("update");
      // Regenerating invalidates the prior set.
      await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      const batchId = randomUUID();
      const values = [] as Array<typeof recoveryCodes.$inferInsert>;
      for (let i = 0; i < 10; i++) {
        const code = `${rand4()}-${rand4()}-${rand4()}`;
        codes.push(code);
        values.push({ userId, codeHash: hashToken(code), batchId });
      }
      await db.insert(recoveryCodes).values(values);
    });
    return { codes, generatedAt: ctx.now().toISOString() };
  }

  /**
   * The batch a user's recovery codes must belong to to count: the newest one they own.
   *
   * `batch_id` was WRITTEN by every regeneration and READ by nothing, anywhere in the repo — so
   * "regenerating invalidates the prior set" rested entirely on a delete having actually removed
   * the prior rows. This is what makes the column load-bearing: whatever rows exist, only the
   * most recently created batch is honoured, so a surplus batch left behind by a race, a partial
   * failure, or a hand-run SQL statement is inert rather than a live second factor.
   *
   * Ordered by `created_at` then `batch_id`: the tiebreak matters because ten rows of one batch
   * share an insert and can share a timestamp, and two batches written in the same millisecond
   * must still resolve to exactly ONE answer for every caller.
   */
  private async liveRecoveryBatch(db: Tx, userId: string): Promise<string | null> {
    const [row] = await db.select({ batchId: recoveryCodes.batchId })
      .from(recoveryCodes)
      .where(eq(recoveryCodes.userId, userId))
      .orderBy(desc(recoveryCodes.createdAt), desc(recoveryCodes.batchId))
      .limit(1);
    return row?.batchId ?? null;
  }

  async recoveryVerify(
    ctx: ServiceContext, b: { loginToken: string; code: string },
  ): Promise<SessionEstablished & { remainingCodes: number }> {
    const db = asTx(ctx);
    requireField(b.loginToken, "loginToken");
    requireField(b.code, "code");
    const lt = await this.peekLoginToken(db, ctx, b.loginToken);
    const user = await this.loadUser(db, lt.userId);
    // RESERVED, not read — {@link throttleReserve}.
    await this.throttleReserve(db, `user:${user.id}`);

    const hash = hashToken(b.code.trim());
    // SCOPED TO THE LIVE BATCH. Matching on user + hash + unused alone honoured every batch the
    // table happened to hold, which is what made a raced regeneration leave the superseded sheet
    // working. See {@link liveRecoveryBatch}.
    const batchId = await this.liveRecoveryBatch(db, user.id);
    if (batchId === null) {
      // No codes have ever been generated for this user. Refused exactly like a wrong code —
      // the caller must not learn which of the two it was.
      await this.twofaFail(db, user, ctx);
      throw new ServiceError("unauthorized", 401, "two-factor verification failed");
    }
    const row = (await db.select().from(recoveryCodes)
      .where(and(
        eq(recoveryCodes.userId, user.id),
        eq(recoveryCodes.batchId, batchId),
        eq(recoveryCodes.codeHash, hash),
        isNull(recoveryCodes.usedAt),
      ))
      .limit(1))[0];
    if (!row) {
      await this.twofaFail(db, user, ctx);
      throw new ServiceError("unauthorized", 401, "two-factor verification failed");
    }
    // Single-use — and the predicate is what makes it so. The SELECT above already
    // filtered on `used_at IS NULL`; without repeating it here, two presentations of one
    // recovery code race to the same row and both are honoured. These are the break-glass
    // credentials a user keeps on paper, so "used once" has to mean once.
    const burned = await db.update(recoveryCodes)
      .set({ usedAt: ctx.now() })
      .where(and(eq(recoveryCodes.id, row.id), isNull(recoveryCodes.usedAt)))
      .returning({ id: recoveryCodes.id });
    if (burned.length === 0) {
      await this.twofaFail(db, user, ctx);
      throw new ServiceError("unauthorized", 401, "two-factor verification failed");
    }
    await this.consumeLoginToken(db, lt.id, ctx.now());
    await this.audit(db, user, "recovery_used", "recovery_code", ctx);

    // The SAME batch scope the match used, so the number the user is shown counts codes that
    // would actually be accepted rather than every unused row the table holds.
    const remaining = (await db.select({ id: recoveryCodes.id }).from(recoveryCodes)
      .where(and(
        eq(recoveryCodes.userId, user.id),
        eq(recoveryCodes.batchId, batchId),
        isNull(recoveryCodes.usedAt),
      ))).length;
    // A recovery code was just burned, here — a real second factor. `now` is its real time.
    const est = await this.establish(ctx, user, { method: "recovery_code", kind: "web", twofaAt: ctx.now() });
    return { ...est, remainingCodes: remaining };
  }

  // ── Native OAuth2 (Authorization-Code + PKCE) ───────────────────────────────

  /**
   * Mint the native authorization code.
   *
   * ── THE GATE IS ON THE ROUTE, AND THIS METHOD DELIBERATELY DOES NOT REPEAT IT ─────────────
   *
   * `GET /oauth/authorize` carries `stepUp: true`. It is the same placement — and the same
   * argument — as {@link issueDesktopLink}: `withStepUp` is where every step-up decision in this
   * codebase is made, and a second implementation inside a service is how the two drift. The
   * flag is now actually enforced on `raw` routes; see `app.ts#RAW_PIPELINE`.
   *
   * So by the time this runs, the caller is a full session that asserted a second factor within
   * `stepUpWindowMs`. The old comment here asserted that as a premise about "the browser flow";
   * nothing made it true, and the register's step 2 is exactly the sequence in which it was not.
   *
   * ── WHAT IT READS THE SESSION ROW FOR, WHICH IS NOT THE GATE ──────────────────────────────
   *
   * The exchange at `POST /oauth/token` asserts no factor of its own — a code and a PKCE verifier
   * are not second factors — so the session it establishes has no honest `last_twofa_at` of its
   * own to write. The authorizing session has the real one, and this is the only point where both
   * are in scope. Reading a value to RECORD it is not re-implementing a gate: nothing below
   * branches on it, and a stale value here cannot admit anybody, because admission already
   * happened upstream.
   */
  async authorize(ctx: ServiceContext, q: AuthorizeQuery): Promise<{ redirect: string }> {
    const userId = this.requireUser(ctx);
    const client = this.cfg.oauthClients[q.client_id];
    if (!client || !client.redirectUris.includes(q.redirect_uri)) {
      throw new ServiceError("invalid_grant", 400, "unknown client or redirect_uri");
    }
    if (q.code_challenge_method !== "S256" || !q.code_challenge) {
      throw new ServiceError("validation_failed", 400, "PKCE S256 code_challenge required");
    }
    const db = asTx(ctx);
    // The authorizing session's REAL factor time, carried to the session this code will
    // establish. NULL when there is no session row to read — which the route's gate makes
    // unreachable, and which resolves to a session that cannot clear step-up if it ever is.
    const authorizing = ctx.sessionId
      ? (await db.select({ lastTwofaAt: sessions.lastTwofaAt }).from(sessions)
          .where(eq(sessions.id, ctx.sessionId)).limit(1))[0]
      : undefined;
    const rawCode = generateToken();
    await db.insert(oauthAuthCodes).values({
      userId, clientId: q.client_id, codeHash: hashToken(rawCode),
      codeChallenge: q.code_challenge, codeChallengeMethod: "S256",
      redirectUri: q.redirect_uri, scope: q.scope ?? "full",
      twofaAt: authorizing?.lastTwofaAt ?? null,
      expiresAt: new Date(ctx.now().getTime() + this.cfg.oauthCodeTtlMs),
    });
    const sep = q.redirect_uri.includes("?") ? "&" : "?";
    return { redirect: `${q.redirect_uri}${sep}code=${encodeURIComponent(rawCode)}&state=${encodeURIComponent(q.state)}` };
  }

  async token(ctx: ServiceContext, b: TokenBodyAuthCode | TokenBodyRefresh): Promise<OAuthTokens> {
    requireField(b.grant_type, "grant_type");
    if (b.grant_type === "refresh_token") {
      // STRICT, never grace: the OAuth `refresh_token` grant is a native/public client rotating
      // its own token serially over the wire, not a shared browser cookie jar. It has no
      // concurrent-tab race, so a re-presented consumed token is theft and revokes the family.
      //
      // `"native"` is the LIFETIME surface and is the opposite kind of statement: this grant is
      // the desktop app renewing itself, so it rolls the long window. The two arguments disagree
      // in strictness on purpose — see `refresh` and `SessionSurface`.
      return this.rotateRefresh(ctx, requireField(b.refresh_token, "refresh_token"), false, "native");
    }
    if (b.grant_type !== "authorization_code") {
      throw new ServiceError("unsupported_grant_type", 400, "unsupported grant_type");
    }
    requireField(b.code, "code");
    requireField(b.redirect_uri, "redirect_uri");
    requireField(b.client_id, "client_id");
    requireField(b.code_verifier, "code_verifier");
    const db = asTx(ctx);
    const row = (await db.select().from(oauthAuthCodes)
      .where(eq(oauthAuthCodes.codeHash, hashToken(b.code))).limit(1))[0];
    if (!row || row.consumedAt || row.expiresAt.getTime() <= ctx.now().getTime()) {
      throw new ServiceError("invalid_grant", 400, "invalid or expired authorization code");
    }
    // Bound to client_id + redirect_uri.
    if (row.clientId !== b.client_id || row.redirectUri !== b.redirect_uri) {
      throw new ServiceError("invalid_grant", 400, "client_id / redirect_uri mismatch");
    }
    // PKCE: S256(code_verifier) must equal the stored challenge.
    const computed = sha256(b.code_verifier).toString("base64url");
    if (computed !== row.codeChallenge) {
      throw new ServiceError("invalid_grant", 400, "PKCE verification failed");
    }
    // Single-use, and the predicate is the enforcement. The `row.consumedAt` check
    // twenty lines up is a READ; without repeating the condition in the write, two token
    // exchanges carrying one authorization code both pass it and both get a full native
    // session. RFC 6749 §4.1.2 requires a used code to be rejected AND to revoke what it
    // issued precisely because these codes travel through a redirect URI where a second
    // party can see them.
    const burned = await db.update(oauthAuthCodes)
      .set({ consumedAt: ctx.now() })
      .where(and(eq(oauthAuthCodes.id, row.id), isNull(oauthAuthCodes.consumedAt)))
      .returning({ id: oauthAuthCodes.id });
    if (burned.length === 0) {
      throw new ServiceError("invalid_grant", 400, "invalid or expired authorization code");
    }

    const user = await this.loadUser(db, row.userId);
    // NO `method`, so no `2fa_verified` row: no factor was asserted HERE, and a code plus a PKCE
    // verifier is not one. `twofaAt` therefore INHERITS the authorizing session's real
    // `last_twofa_at` off the code row instead of stamping `now` — the session this
    // mints ages out of step-up on the schedule of the factor it actually descends from, rather
    // than arriving with a full fresh window it never earned. NULL if the code carried none,
    // which fails step-up closed.
    const est = await this.establish(ctx, user, {
      method: undefined, kind: "macos", ip: ctx.ip, twofaAt: row.twofaAt,
    });
    return est.tokens!;
  }

  // ── The audit read (the lifecycle's device list/revoke moved to the base class) ──

  async listAudit(
    ctx: ServiceContext, opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: AuthAuditEvent[]; nextCursor: string | null }> {
    const userId = this.requireUser(ctx);
    const db = asTx(ctx);
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const rows = await db.select().from(authEvents)
      .where(eq(authEvents.userId, userId))
      .orderBy(desc(authEvents.at)).limit(limit);
    const items: AuthAuditEvent[] = rows.map((r) => ({
      at: r.at.toISOString(),
      event: r.event as AuthAuditEvent["event"],
      method: (r.method as AuthAuditEvent["method"]) ?? undefined,
      ip: r.ip ?? "",
      device: r.device ?? undefined,
    }));
    return { items, nextCursor: null };
  }

  /**
   * Authorization for the FACTOR-ENROLLMENT surface (`/auth/2fa/{webauthn/register,
   * totp/enroll,totp/activate}`). Two admissible callers, and they are not the same
   * caller — which is why these routes cannot simply carry the `stepUp` flag:
   *
   *  - an ENROLLMENT-scoped session: onboarding's FIRST factor. It has no
   *    `last_twofa_at` and by construction never will, so a plain step-up gate would
   *    lock onboarding out entirely.
   *  - a FULL session with a recent 2FA: the "add another factor later" path. Without
   *    this leg, ADDING a factor was strictly easier than REMOVING one — `DELETE
   *    /auth/2fa/totp` demands fresh 2FA, while any still-valid-but-old full session
   *    (an unattended browser, a stolen cookie, a long-lived native bearer) could
   *    plant an attacker-controlled passkey or TOTP secret and thereby obtain durable,
   *    independent access to the account. Same bar in both directions now.
   */
  private async requireEnrollmentOrStepUp(ctx: ServiceContext): Promise<void> {
    if (!ctx.sessionId) throw new ServiceError("step_up_required", 403, "recent 2FA re-assertion required");
    const db = asTx(ctx);
    const s = (await db.select().from(sessions).where(eq(sessions.id, ctx.sessionId)).limit(1))[0];
    if (!s || s.revokedAt) throw new ServiceError("unauthorized", 401, "no active session");
    if (s.scope === "enrollment") return;
    const last = s.lastTwofaAt?.getTime() ?? 0;
    if (ctx.now().getTime() - last > this.cfg.stepUpWindowMs) {
      throw new ServiceError("step_up_required", 403, "recent 2FA re-assertion required");
    }
  }

  // ── Internal: the enrollment mint (the full-session mint and refresh rotation live on the base class) ──

  /**
   * Mint the ENROLLMENT-SCOPED session. Deliberate properties, each one load-
   * bearing:
   *  - `scope='enrollment'` — `withSession` admits it on the `enrollmentOk` routes
   *    only (/auth/2fa/*, /auth/session, /auth/logout) and rejects it everywhere else.
   *  - `lastTwofaAt` STAYS NULL — a password-only session must never satisfy step-up,
   *    so device revocation, mailbox writes, TOTP removal and recovery-code generation
   *    remain unreachable until a real factor exists.
   *  - no `refresh_tokens` row and `refreshExpiresAt = accessExpiresAt` — nothing can
   *    extend it; it dies in `loginTokenTtlMs` (~5 min) whatever the client does.
   *  - no `devices` row — the enrollment session is not a device a user manages; the
   *    full session minted at exchange registers the real one.
   *  - it SUPERSEDES any earlier enrollment session of the same user. Re-entry used to
   *    accumulate live siblings, and the exchange only revoked the family it was
   *    handed — so a token captured during one password-only window stayed
   *    `scope='enrollment'` and fully usable after somebody else finished onboarding
   *    on a sibling, i.e. it could be replayed into a passkey of the holder's choosing
   *    plus a full session. At most one password-only session per user may be live.
   */
  private async establishEnrollment(
    ctx: ServiceContext, user: typeof users.$inferSelect,
  ): Promise<EnrollmentSessionEstablished> {
    const db = asTx(ctx);
    const now = ctx.now();
    const token = generateToken();
    const expiresAt = new Date(now.getTime() + this.cfg.loginTokenTtlMs);

    await this.revokeEnrollmentSessions(db, user.id, now);
    await db.insert(sessions).values({
      accountId: user.accountId, userId: user.id, deviceId: null, familyId: randomUUID(),
      scope: "enrollment",
      accessTokenHash: hashToken(token),
      accessExpiresAt: expiresAt,
      refreshExpiresAt: expiresAt,
      lastTwofaAt: null,
      lastSeenAt: now,
    });

    await this.audit(db, user, "enrollment_started", "password", ctx);
    await this.throttleReset(db, `user:${user.id}`);
    await this.throttleReset(db, `email:${user.email}`);

    return {
      status: "enrollment",
      user: await this.sessionUser(db, user.id),
      next: "enroll_2fa",
      enrollmentToken: token,
      expiresIn: Math.floor(this.cfg.loginTokenTtlMs / 1000),
    };
  }

  /**
   * EXCHANGE (not upgrade-in-place) the caller's enrollment session for a full one
   * the moment a first 2FA factor lands. Session-fixation hygiene: a privilege change
   * mints a NEW session id and a NEW refresh family, so a token that was observed
   * during the password-only window — it travelled in a JSON body, by design, so that
   * native clients can onboard — can never be replayed as a full-privilege credential.
   *
   * The revocation predicate is `user_id + scope='enrollment'`, NOT the presented
   * refresh family. Revoking only the caller's family was the original defect: every
   * enrollment session gets a fresh `familyId`, so two live siblings (register on the
   * laptop, re-entry login on the phone) shared nothing, and completing onboarding on
   * one left the other `scope='enrollment'` and fully usable — replayable into an
   * attacker-chosen passkey plus a full session on the victim's account. It runs
   * inside the caller's transaction, and {@link establish} repeats it so the invariant
   * does not depend on which door was used.
   *
   * Returns `undefined` when the caller is already a full session, which is the
   * ordinary "add another factor later" path: enrollment and re-enrollment therefore
   * share one handler, and "is this the FIRST factor?" needs no counting — an
   * enrollment-scoped session by construction had zero factors, and the first
   * exchange retires it.
   *
   * The scope is read from the session ROW under `FOR UPDATE`, never from the request:
   * the API's `withSession` gate and this privilege decision must not share a trust
   * path, and the row lock is what makes "the first exchange retires it" true against
   * two concurrent first-factor requests rather than merely likely.
   */
  private async exchangeEnrollmentSession(
    ctx: ServiceContext, userId: string,
    method: AuthAuditEvent["method"], client: "web" | "macos" = "web",
  ): Promise<SessionEstablished | undefined> {
    if (!ctx.sessionId) return undefined;
    const db = asTx(ctx);
    const s = (await db.select().from(sessions)
      .where(eq(sessions.id, ctx.sessionId)).limit(1).for("update"))[0];
    if (!s || s.revokedAt || s.scope !== "enrollment") return undefined;
    const user = await this.loadUser(db, userId);
    await this.revokeEnrollmentSessions(db, userId, ctx.now());
    // The FIRST factor just landed (this is the enrollment→full exchange, reached only from a
    // successful `register`/`activate`/`verify`), so `now` is that factor's real time.
    return this.establish(ctx, user, { method, kind: client, twofaAt: ctx.now() });
  }

  // ── Internal: login-token & challenge lifecycle ─────────────────────────────

  /**
   * Resolve a first-factor login token.
   *
   * **Scoped to `purpose='login'`.** Before verification mails existed the `login_tokens`
   * table held exactly one kind of row, so a hash match WAS a login token and this lookup did
   * not mention `purpose`. Email verification put a second kind in the same table — the
   * `purpose='email_verify'` token whose raw value is MAILED to an inbox — and an
   * unscoped lookup would make that mailed value presentable here: at minimum it mints
   * a WebAuthn challenge bound to the user (`webauthnAssertOptions`), and it turns
   * "read one email" into a live first factor for every 2FA endpoint. The predicate
   * below is what keeps the two token families from being interchangeable;
   * `mail-service.test.ts` ("a mailed verification token is not a login token") asserts
   * it bites, with a `purpose='login'` row of identical shape as the control.
   */
  private async peekLoginToken(
    db: Tx, ctx: ServiceContext, raw: string,
  ): Promise<{ id: string; userId: string; methods: Method[] }> {
    const row = (await db.select().from(loginTokens)
      .where(and(
        eq(loginTokens.tokenHash, hashToken(raw)),
        eq(loginTokens.purpose, "login"),
      )).limit(1))[0];
    if (!row || row.consumedAt || row.expiresAt.getTime() <= ctx.now().getTime()) {
      throw new ServiceError("unauthorized", 401, "login session expired");
    }
    return { id: row.id, userId: row.userId, methods: (row.methods as Method[]) ?? [] };
  }

  /**
   * Burn a first-factor login token, and REFUSE if somebody else burned it first.
   *
   * `peekLoginToken` reads the row and checks `consumedAt`; this used to be an unconditional
   * `UPDATE … WHERE id = $1`, so the pair was a read-modify-write. Two presentations of one
   * login token racing each other both peek an unconsumed row, both verify a factor, and
   * both get a session — from a token whose entire contract is that it is single-use.
   * The `consumed_at IS NULL` predicate makes the write the arbiter, exactly as it is in
   * `consumeInvite`, and the loser is told what a stale token is always told.
   *
   * Every caller awaits this BEFORE `establish`, so the loser never reaches a session.
   */
  private async consumeLoginToken(db: Tx, id: string, now: Date): Promise<void> {
    const claimed = await db.update(loginTokens)
      .set({ consumedAt: now })
      .where(and(eq(loginTokens.id, id), isNull(loginTokens.consumedAt)))
      .returning({ id: loginTokens.id });
    if (claimed.length === 0) {
      throw new ServiceError("unauthorized", 401, "login session expired");
    }
  }

  private async consumeChallenge(
    db: Tx, ctx: ServiceContext,
    // `challenge` narrows the claim to the ceremony the caller's assertion was actually signed
    // over (step-up passes it, from the assertion's own clientDataJSON) — without it, a caller
    // with several open ceremonies gets "the newest", which is how two overlapping step-ups
    // burned each other. It is a selector only: the signature check downstream still binds the
    // claimed row's challenge and origin.
    q: { userId?: string; loginTokenId?: string; type: string; challenge?: string },
  ): Promise<typeof webauthnChallenges.$inferSelect> {
    const preds = [eq(webauthnChallenges.type, q.type), isNull(webauthnChallenges.consumedAt)];
    if (q.userId) preds.push(eq(webauthnChallenges.userId, q.userId));
    if (q.loginTokenId) preds.push(eq(webauthnChallenges.loginTokenId, q.loginTokenId));
    if (q.challenge) preds.push(eq(webauthnChallenges.challenge, q.challenge));
    const row = (await db.select().from(webauthnChallenges)
      .where(and(...preds)).orderBy(desc(webauthnChallenges.createdAt)).limit(1))[0];
    if (!row || row.expiresAt.getTime() <= ctx.now().getTime()) {
      throw new ServiceError("unauthorized", 401, "webauthn challenge expired");
    }
    // Single-use + origin/RP-ID binding.
    //
    // `rpID` stays single-valued, so it is still an equality check. The ORIGIN is
    // now checked twice, and the two checks answer different questions:
    //
    //  (a) MEMBERSHIP — is the origin this challenge was minted for still one this
    //      deployment serves? A row written before an origin was removed from the
    //      allow-list (or by a differently-configured host sharing the database)
    //      must not be completable.
    //  (b) PIN — does the VERIFY request come from the same origin that OPENED the
    //      ceremony? A deployment may allow more than one origin, and
    //      without this check any of them could finish another's ceremony. Requests
    //      with no `Origin` header (native) skip it; for them the pin is still
    //      enforced downstream, because `expectedOrigin` is `row.origin` and
    //      `clientDataJSON.origin` is signed.
    if (row.rpId !== this.cfg.rpID || !allowedOrigins(this.cfg).includes(row.origin)) {
      throw new ServiceError("unauthorized", 401, "webauthn challenge origin mismatch");
    }
    if (ctx.origin != null && ctx.origin.trim() !== "" && tryNormalizeOrigin(ctx.origin) !== row.origin) {
      throw new ServiceError("unauthorized", 401, "webauthn challenge origin mismatch");
    }
    // CLAIM IT, do not merely mark it. The `isNull(consumedAt)` above is in the SELECT, so
    // an unconditional UPDATE here left the pair a read-modify-write: two verifies carrying
    // the same signed assertion both select the live challenge, both pass, and the
    // single-use property is gone — which for an authentication ceremony means one
    // captured `clientDataJSON` can be replayed. The predicate makes the write decide.
    const claimed = await db.update(webauthnChallenges)
      .set({ consumedAt: ctx.now() })
      .where(and(eq(webauthnChallenges.id, row.id), isNull(webauthnChallenges.consumedAt)))
      .returning({ id: webauthnChallenges.id });
    if (claimed.length === 0) {
      throw new ServiceError("unauthorized", 401, "webauthn challenge expired");
    }
    return row;
  }

  // ── Internal: throttle / lockout ────────────────────────────────────────────

  /**
   * The lockout READ, and it is NOT a gate.
   *
   * It reports whether `key` is locked RIGHT NOW and nothing else, so it is only ever correct
   * AFTER {@link throttleReserve} has atomically counted the attempt being answered — see
   * {@link twofaFail}, whose whole job is to upgrade a 401 into a 423 once the count it just
   * took crossed the threshold. Using it as the admission decision is the defect
   * {@link throttleReserve} exists to remove; do not reintroduce it in front of a verify.
   */
  private async throttleCheck(db: Tx, key: string): Promise<void> {
    const row = (await db.select().from(authThrottle).where(eq(authThrottle.key, key)).limit(1))[0];
    if (row?.lockedUntil && row.lockedUntil.getTime() > Date.now()) throw lockedOut(row.lockedUntil);
  }

  /**
   * ADMIT OR REFUSE ONE ATTEMPT, counting it in the SAME statement that decides.
   *
   * ── WHAT WAS WRONG, AND WHY THE ATOMIC INCREMENT ALONE DID NOT FIX IT ─────────────────────
   *
   * `throttleFailure` was made atomic because concurrent wrong passwords collapsed into one
   * recorded failure. The SEPARATE `throttleCheck` in front of the password verify was left as a
   * pure read, and that is the same defect one layer up: the gate answers from a counter that
   * the request being gated has not yet touched. N requests that arrive together all read "not
   * locked", all run their scrypt, and only then increment — so the real bound on guesses was
   * the attacker's chosen concurrency, not `maxFailures`. Measured on real Postgres in
   * `auth-throttle.pg.test.ts`: 40 simultaneous wrong passwords against `maxFailures: 5` all
   * reached the hasher.
   *
   * A check-then-act pair cannot be repaired by making one half atomic. So the count and the
   * decision are ONE `INSERT … ON CONFLICT DO UPDATE … RETURNING`: the row lock serializes
   * concurrent callers, each gets its own post-increment value back, and the attempt that
   * EXCEEDS the policy installs the lock and is refused before it costs a hash.
   *
   * ── THE FOUR ARMS, IN ORDER, AND WHY THAT ORDER ───────────────────────────────────────────
   *
   *  1. **A live lock refuses without counting.** It must not count, because an attacker who
   *     keeps hammering a locked key would otherwise slide `locked_until` forward for ever and
   *     hold the legitimate owner out — a denial of service handed to whoever is attacking.
   *  2. **An EXPIRED lock restarts the window at 1 and clears the lock.** Serving the lockout
   *     spends the count; the policy says `maxFailures` per window and then `lockoutMs`, and a
   *     user who has waited it out must get a real budget rather than a single attempt. (With
   *     the shipped config the window and the lockout are both 15 minutes, so arm 3 covers this
   *     anyway; the arm exists because both are injectable.)
   *  3. **A rolled window restarts at 1.**
   *  4. **Otherwise increment.**
   *
   * The lock is installed here ONLY when the post-increment count is strictly GREATER than
   * `maxFailures` — i.e. only on the attempt this call refuses. Reaching exactly `maxFailures`
   * is admitted, and the lock for that is installed by {@link throttleLock} after the attempt
   * has actually FAILED. That split is what keeps a correct password from locking an account
   * that was one attempt short: the reservation counts it, {@link throttleRefund} gives it back,
   * and no lock was ever written.
   *
   * ISO STRINGS, not `Date`s, inside every raw `sql` template — the rule `ip-throttle.ts:41-44`
   * states. postgres-js serializes a raw template parameter against the type Postgres describes
   * for `$n` in `$n::timestamptz`, which is TEXT, and hands a `Date` straight to
   * `Buffer.byteLength`. That is a 500 on every failed login on any postgres-js host, i.e.
   * production, and it is green on PGlite; `auth-throttle.pg.test.ts` is the net.
   */
  private async throttleReserve(db: Tx, key: string): Promise<void> {
    const now = new Date();
    const max = this.cfg.maxFailures;
    const nowIso = now.toISOString();
    const windowFloor = new Date(now.getTime() - this.cfg.failureWindowMs).toISOString();
    const lockUntilDate = new Date(now.getTime() + this.cfg.lockoutMs);
    const lockUntil = lockUntilDate.toISOString();

    const live = sql`(${authThrottle.lockedUntil} is not null and ${authThrottle.lockedUntil} > ${nowIso}::timestamptz)`;
    const served = sql`(${authThrottle.lockedUntil} is not null and ${authThrottle.lockedUntil} <= ${nowIso}::timestamptz)`;
    const rolled = sql`${authThrottle.windowStartedAt} < ${windowFloor}::timestamptz`;
    const next = sql`case when ${live} then ${authThrottle.failures}
                          when ${served} then 1
                          when ${rolled} then 1
                          else ${authThrottle.failures} + 1 end`;

    const [row] = await db.insert(authThrottle)
      .values({
        key, failures: 1, windowStartedAt: now, updatedAt: now,
        lockedUntil: 1 > max ? lockUntilDate : null,
      })
      .onConflictDoUpdate({
        target: authThrottle.key,
        set: {
          failures: next,
          windowStartedAt: sql`case when ${live} then ${authThrottle.windowStartedAt}
                                    when ${served} then ${nowIso}::timestamptz
                                    when ${rolled} then ${nowIso}::timestamptz
                                    else ${authThrottle.windowStartedAt} end`,
          lockedUntil: sql`case when ${live} then ${authThrottle.lockedUntil}
                                when (${next}) > ${max} then ${lockUntil}::timestamptz
                                when ${served} then null
                                when ${rolled} then null
                                else ${authThrottle.lockedUntil} end`,
          updatedAt: now,
        },
      })
      .returning({ failures: authThrottle.failures, lockedUntil: authThrottle.lockedUntil });

    // A missing row can only mean the write did not happen, and "we could not count this
    // attempt" must REFUSE rather than admit — `ip-throttle.ts:77-80` makes the same call for
    // the same reason. The other default leaves the endpoint unbounded exactly when its counter
    // is broken.
    if (!row) throw lockedOut(lockUntilDate);
    if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) throw lockedOut(row.lockedUntil);
    // The floor beneath arm 3: a `lockoutMs` of 0 would leave the statement's lock already
    // expired, so the count itself has to be able to refuse.
    if (row.failures > max) throw lockedOut(lockUntilDate);
  }

  /**
   * The attempt {@link throttleReserve} counted has now FAILED: install the lock if that count
   * has reached the policy.
   *
   * One statement, and the comparison is made server-side against the row's own column, so two
   * concurrent failures cannot disagree about whether the threshold was crossed. It does not
   * increment — the reservation already did, and counting twice would halve the budget.
   *
   * A live lock is left exactly as it is rather than extended, for arm 1's reason above.
   * There is no INSERT arm: every call site reserves the same key first, so the row exists.
   */
  private async throttleLock(db: Tx, key: string): Promise<void> {
    const now = new Date();
    const nowIso = now.toISOString();
    const lockUntil = new Date(now.getTime() + this.cfg.lockoutMs).toISOString();
    await db.update(authThrottle)
      .set({
        lockedUntil: sql`case
          when ${authThrottle.lockedUntil} is not null and ${authThrottle.lockedUntil} > ${nowIso}::timestamptz
            then ${authThrottle.lockedUntil}
          when ${authThrottle.failures} >= ${this.cfg.maxFailures} then ${lockUntil}::timestamptz
          else ${authThrottle.lockedUntil} end`,
        updatedAt: now,
      })
      .where(eq(authThrottle.key, key));
  }

  /**
   * Give back the ONE attempt this request reserved, because the credential was RIGHT.
   *
   * Not {@link throttleReset}: a full reset here would launder the second-factor counter. An
   * attacker holding the password but not the factor could otherwise loop — correct password
   * (zeroes `user:<id>`), wrong TOTP, repeat — and never reach the 2FA lockout at all. So this
   * decrements by exactly what was reserved and clears the lock only if the remaining count is
   * back under the policy. `throttleReset` still runs on a COMPLETED login (`establish`), where
   * zeroing both counters is the right thing.
   *
   * Without this, a password that is right but whose second factor is still outstanding would
   * spend budget: five visits to the 2FA screen would lock an account on which nothing failed.
   */
  private async throttleRefund(db: Tx, key: string): Promise<void> {
    const back = sql`greatest(${authThrottle.failures} - 1, 0)`;
    await db.update(authThrottle)
      .set({
        failures: back,
        lockedUntil: sql`case when (${back}) >= ${this.cfg.maxFailures} then ${authThrottle.lockedUntil} else null end`,
        updatedAt: new Date(),
      })
      .where(eq(authThrottle.key, key));
  }

  protected override async throttleReset(db: Tx, key: string): Promise<void> {
    await db.update(authThrottle).set({ failures: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(authThrottle.key, key));
  }

  /**
   * A second factor was presented and refused.
   *
   * The attempt was already COUNTED by the `throttleReserve` at the top of the verify — this
   * only installs the lock if that count reached the threshold, and then re-reads it so the
   * refusal that crossed the line answers 423 itself rather than 401 followed by a 423 on the
   * next try.
   */
  private async twofaFail(db: Tx, user: typeof users.$inferSelect, ctx: ServiceContext): Promise<void> {
    await this.throttleLock(db, `user:${user.id}`);
    await this.audit(db, user, "2fa_failed", undefined, ctx);
    // Surface lockout immediately if this failure crossed the threshold.
    await this.throttleCheck(db, `user:${user.id}`);
  }

  /**
   * Was this refused code a REPLAY — a code that verifies against the secret but whose
   * timestep the single-use guard already spent? The open verify (`afterStep: null`) is the
   * same HMAC walk the guarded one just did, so the two can only disagree on the step bound.
   */
  private replayedTotp(secret: string, code: string, now: Date): boolean {
    return verifyTotp({ secret, token: code, now, window: this.cfg.totpWindow, afterStep: null }).valid;
  }

  /**
   * Finalize a refused TOTP presentation — as a counted failure, or as a REPLAY that must not
   * burn a lockout slot.
   *
   * ── WHY A REPLAY DOES NOT COUNT, AND WHY THAT OPENS NO DOOR ────────────────────────────────
   *
   * The single-use-per-timestep guard means the code that just signed someone in FAILS when
   * they type it again seconds later at the step-up sheet — correct security, and the sentence
   * deliberately does not say why ("the caller must not learn that their code was right"). But
   * counting those refusals as failed ATTEMPTS locked real people out: measured in production
   * 2026-08-28 — five presentations of one just-consumed code inside eleven seconds, the same
   * six digits still showing in the authenticator — reached `maxFailures` and produced a
   * fifteen-minute lockout with nothing guessed by anybody.
   *
   * The lockout exists to price GUESSING, and a replay is not a guess: reaching this arm
   * requires presenting a code that VERIFIES against the secret — exactly as hard as knowing
   * the current code, i.e. holding the factor. Refunding the reserved slot therefore hands an
   * attacker nothing a guesser could use (a guesser's wrong codes still count), and the
   * OUTWARD refusal is byte-identical to the wrong-code arm, so no response oracle appears.
   * The trail keeps the truth for investigations: the audit row says `2fa_failed` with a
   * detail naming the replay, so five of these in a log read as a person re-typing a spent
   * code, not as five guesses.
   */
  private async twofaRefused(
    db: Tx, user: typeof users.$inferSelect, ctx: ServiceContext, replayed: boolean,
  ): Promise<void> {
    if (!replayed) return this.twofaFail(db, user, ctx);
    await this.throttleRefund(db, `user:${user.id}`);
    await this.audit(db, user, "2fa_failed", undefined, ctx, "single-use timestep replayed");
  }

  // ── Internal: user / factor helpers ─────────────────────────────────────────

  private async webauthnCreds(db: Tx, userId: string): Promise<StoredWebauthnCredential[]> {
    const rows = await db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId));
    return rows.map((r) => ({
      credentialId: r.credentialId, publicKey: r.publicKey,
      counter: r.counter, transports: (r.transports as string[]) ?? [],
    }));
  }

  private async enrolledMethods(db: Tx, userId: string): Promise<Method[]> {
    const e = await this.twofaEnrolled(db, userId);
    const methods: Method[] = [];
    if (e.webauthn) methods.push("webauthn");
    if (e.totp) methods.push("totp");
    if (e.recoveryCodes) methods.push("recovery_code");
    return methods;
  }

  protected override async twofaEnrolled(db: Tx, userId: string): Promise<TwofaEnrolled> {
    const wa = (await db.select({ id: webauthnCredentials.id }).from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId)).limit(1)).length > 0;
    const totp = (await db.select({ id: totpSecrets.id }).from(totpSecrets)
      .where(and(eq(totpSecrets.userId, userId), eq(totpSecrets.activated, true))).limit(1)).length > 0;
    const rc = (await db.select({ id: recoveryCodes.id }).from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt))).limit(1)).length > 0;
    return { webauthn: wa, totp, recoveryCodes: rc };
  }

  protected override async audit(
    db: Tx, user: typeof users.$inferSelect | null,
    event: AuthAuditEvent["event"], method: AuthAuditEvent["method"] | undefined, ctx: ServiceContext,
    detail?: string,
  ): Promise<void> {
    await db.insert(authEvents).values({
      accountId: user?.accountId ?? null, userId: user?.id ?? null,
      // `detail` displaces the user agent when the writer has something sharper for this slot
      // (the reuse row's `family=… session=…`) — see the base hook's doc.
      event, method: method ?? null, ip: ctx.ip ?? null, device: detail ?? ctx.userAgent ?? null,
    });
  }

  /**
   * The hosted revoke takes the device's WAKE REGISTRATIONS down with its sessions.
   *
   * `push_subscriptions` rows are stamped with the registering session's `device_id`
   * (push-service.ts), so revoking a paired phone from the Devices pane must also stop the
   * worker POSTing wakes to that phone's UnifiedPush endpoint — a revoked device that keeps
   * receiving "something changed" signals is a credential take-back that did not take
   * everything back. The prune runs AFTER the base revoke so a step-up refusal never deletes
   * anything, and it lives HERE rather than in `SessionLifecycle` because the base class also
   * serves the desktop engine, whose mail-only database has no push table to prune.
   */
  override async revokeDevice(
    ctx: ServiceContext, deviceId: string, opts: { requireStepUp?: boolean } = {},
  ): Promise<void> {
    await super.revokeDevice(ctx, deviceId, opts);
    await asTx(ctx).delete(pushSubscriptions).where(and(
      eq(pushSubscriptions.accountId, ctx.accountId),
      eq(pushSubscriptions.deviceId, deviceId),
    ));
  }

}

/**
 * One four-digit group of a recovery code.
 *
 * `randomInt` and NOT `Math.random()`, which is what stood here. A recovery code is a
 * break-glass credential that stands in for the whole second factor, so the generator behind
 * it has to be the cryptographic one. `Math.random()` is a plain PRNG whose internal state is
 * recoverable from a run of its outputs, and every group of every code a process issues comes
 * from that one state — so the guarantee it offers is not "unguessable", it is "unguessable
 * until somebody has seen enough of it".
 *
 * The range is unchanged: `randomInt(1000, 10000)` is uniform over 1000-9999, the same span
 * the previous arithmetic produced. Codes are stored as hashes, so nothing already issued is
 * affected — this only changes where the next code's bits come from.
 */
function rand4(): string {
  return randomInt(1000, 10000).toString();
}
function numOrNull(v: bigint | null): number | null {
  return v == null ? null : Number(v);
}

export function makeAuthService(deps: AuthDeps): AuthService {
  return new AuthService(deps);
}
