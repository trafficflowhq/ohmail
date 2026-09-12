import { randomInt, randomUUID } from "node:crypto";
// `lt` is imported UNDER AN ALIAS: `lt` is the local name every 2FA verify uses for its
// login-token row, and the shadowing turns a comparison into "call an object".
import { and, count, desc, eq, gt, inArray, isNull, lt as lessThan, or, sql } from "drizzle-orm";
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
import { clampPageLimit } from "../pagination.js";
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
import { SessionLifecycle, refuseCrossAccountCredential } from "./session-lifecycle.js";

type Method = "webauthn" | "totp" | "recovery_code";
const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/**
 * The platform-qualified desktop kinds — what a CURRENT desktop declares on the two seams where
 * it identifies itself: the link-claim and the password sign-in's TOTP verify. Narrower than the
 * device vocabulary on purpose: `"web"` is excluded (the staleness alarm excludes kind `web`, so
 * declaring it would be an attribution dodge); the mobile kinds are excluded (a phone arrives
 * through the pairing redeem, so the declaration cannot be true); `"macos"` is excluded HERE and
 * admitted separately in {@link DESKTOP_CLAIM_KINDS} — on the verify seam it is the one kind
 * whose derived lifetime surface is `native`, and anonymous wire input must not choose the long
 * window.
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
 * The advertised password rule, enforced where it is true — on the server. `/join` renders
 * `minLength={12}`, and that HTML attribute used to be the entire enforcement: a direct API
 * caller could register with `x`. It matters because between `register` and the first factor the
 * password is the ONLY credential, and `login` on a zero-factor user re-mints an enrollment
 * session — a guessable password lets an attacker enroll THEIR passkey. The MAXIMUM is not
 * tidiness: scrypt is ~100 ms on a public route, so without a ceiling a caller spends the host's
 * CPU at will; 256 is past any real passphrase. Length is counted in CODE POINTS: a 12-emoji
 * passphrase is twelve characters to the person who typed it.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/**
 * The longest `state` `GET /oauth/authorize` will echo into its redirect.
 *
 * RFC 6749 sets no maximum — `state` is opaque to us, and that is the point of it — so this is a
 * practical ceiling rather than a derived one: 2 048 characters is what a whole URL has been
 * expected to fit in for two decades, and the value is going into a `Location` header. Unbounded
 * it was a caller-chosen header value, which the proxy in front answers with a 431 or a 502 for
 * what is plainly a bad request.
 */
export const OAUTH_STATE_MAX_CHARS = 2048;

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
 * The same gap `requirePassword` closed, in the field next to it. `register` normalized the
 * address and never checked its SHAPE, so `{"email":"not-an-email"}` created a real account — hit
 * in the wild immediately after public signup opened. Invite-only signup had bounded this by
 * accident: `consumeInvite` was an email validator nobody had written, and a check that is only a
 * side effect of another check disappears silently when that one moves. The address IS the
 * account: login identity, only recovery path, receipt target. It DELEGATES to
 * `normalizeRecipient` — one predicate cannot drift against itself. `login` deliberately does NOT
 * call this: an account predating the rule must still sign in.
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
 * The deployment cannot identify clients, so it will not accept anonymous account creation. 503
 * rather than 429 on purpose: nothing about THIS caller is being rate-limited, and "too many
 * signups from your connection" to the first visitor of the day would be a false explanation of a
 * deployment fault. `clientIp` returns `""` when no trusted platform header is present, and with
 * the gate open nothing else bounds registration — so the open path closes and the invite path,
 * which an operator controls, keeps working.
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
 * ONE sentence for every way a verification link can fail to be live. Unknown, expired, already
 * used, the wrong `purpose`, blank, and the loser of a race all get this: the remedy is the same
 * in every case (ask for another link), and the distinctions are only ours to know. "Already
 * used" especially must not be distinguishable — a token that appears in a mail also appears in
 * scanner and proxy logs, and telling whoever presents it second that it WAS real confirms the
 * address has an account: the oracle, one endpoint over. The same reasoning `invites.ts` applies
 * to `revoked` vs `expired`.
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
 * ONE sentence for every way a desktop handoff code can fail to be live. Unknown, expired,
 * already claimed, wrong `purpose`, blank, over-long, and the loser of a race all get this — same
 * rule as {@link invalidVerification}: the remedy is identical (ask the browser for a fresh
 * code), and distinguishing "already used" from "never existed" tells the second presenter it was
 * real. 400 and not 401: nothing is being authenticated, and a 401 on a route the desktop calls
 * before it holds any session reads, to every generic client in between, as "your session
 * expired".
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
 * The mint's refusal of a challenge it cannot use. The obvious implementation ignores a malformed
 * challenge and mints an ordinary unbound code — a SILENT DOWNGRADE: the app believes the code is
 * worthless without its verifier and hands it to a URL scheme any program can claim, with every
 * party thinking the binding is on. Refusing makes the disagreement visible at the only moment
 * anybody can act on it. Distinct from {@link invalidDesktopCode} with no enumeration concern:
 * this is only reachable by a caller holding a live session past the step-up gate, and it names a
 * fault in that caller's own request.
 */
const invalidDesktopChallenge = (): ServiceError => new ServiceError(
  "invalid_challenge", 400,
  "That link request is not one this browser can complete. Open the page again from the app.",
);

/**
 * The open path's "this address already has an account" signal — thrown INSIDE the registering
 * transaction, caught immediately outside. A `return null` produced a 500 on concurrent duplicate
 * signups (`invite-consumption.concurrency.pg.test.ts`; invisible on single-connection PGlite):
 * once a statement fails, the Postgres transaction is ABORTED and even `COMMIT` fails, so
 * catching the `users_email_unique_idx` violation and returning asked the driver to commit an
 * aborted transaction — a 500 on the one credential-free endpoint, the enumeration oracle as a
 * status code. Throwing unwinds properly, and the catch sits outside `inTransaction`, where the
 * mail must be sent from anyway. A private sentinel: `register` is the only thrower and catcher.
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
 * The decoy password hash of the constant-time unknown-email path, memoized PER HASHER rather
 * than per instance. It was a lazy per-instance field, and `apps/web` builds a fresh AuthService
 * per request: an unknown email paid `hash()` + `verify()` (two scrypts) per request while a
 * known one paid `verify()` only — a systematic ~2× timing oracle for account existence, in the
 * code path whose comment promises constant time. The hasher is a process-wide singleton, so
 * keying on it makes the decoy a once-per-process cost, warm by the first login.
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
 * AuthService — register, two-step login, WebAuthn + TOTP + recovery codes, native OAuth2 PKCE,
 * step-up, lockout, and audit; constructed with injectable {@link AuthDeps} so the surface is
 * hermetic. The session MACHINERY (establish, refresh rotation with reuse detection, family
 * revocation, logout, devices, `establishPairedDevice`) lives on {@link SessionLifecycle}, which
 * this class extends and the desktop engine runs on its own. This class is the identity CEREMONY
 * on top, overriding the base's three hosted hooks (`audit`, `throttleReset`, `twofaEnrolled`)
 * with the real cloud-half reads and writes.
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
   * Create the account+user and mint the ENROLLMENT-SCOPED session for 2FA enrollment. The invite
   * is a ROW consumed in THIS transaction (migration 0020, email-bound): a failure un-burns it;
   * the throttle writes stay OUTSIDE (a rolled-back counter is a free retry). `cfg.inviteCodes`
   * is only the operator bootstrap. Under `publicSignup` the branch is on whether a code was
   * OFFERED — a revoked code must still refuse. The OPEN path answers a constant 202
   * (`RegistrationPending`, no session); the INVITE path is unchanged, 201/409 included — email
   * binding makes that 409 a fact about the caller. `email_verified_at` is stamped only when the
   * consumed ROW confers it; the bootstrap never stamps.
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
    // Rate limit, OUTSIDE the transaction below so a refusal is never rolled back — a rolled-back
    // attempt counter is a free retry. Every attempt counts against its own key namespace, never
    // the login keys. The counter is a SLOT CLAIM answering 429 `rate_limited`, not the lockout's
    // 423 `account_locked` — "too many failed attempts" was false in every word on an endpoint
    // whose purpose is that no account exists yet (`ip-throttle.ts`). An unknown IP: skip when
    // gated, refuse when open. `clientIp` is `""` without a trusted platform header, and keying a
    // limiter on `""` is an outage — one shared bucket for the whole deployment. Invite-era
    // registration was bounded by the email-bound invite row instead; with the gate OPEN there is
    // no other bound, so an unidentifiable client refuses. The invite path still works.
    const ip = (ctx.ip ?? "").trim();
    if (ip.length > 0) {
      const claimed = await reserveIpSlot(db, {
        namespace: "register:ip",
        ip,
        now: ctx.now(),
        // On `openGate`, never on `publicSignup` — they disagree on exactly the case that
        // matters. `publicSignup` is the deployment MODE; `openGate` is whether THIS request
        // takes the open path. With the flag on, an offered invite code takes the invite path
        // byte for byte — yet it was metered against the five-slot public ceiling on the SAME
        // `register:ip` counter, so five stranger attempts from one NAT denied a live,
        // operator-issued invite for the whole window. Sharing one counter across both paths
        // stays: the counter means "registrations from this client in this window" and only the
        // CEILING is per-path — a public flood stops at five and leaves the invite path its
        // slots.
        max: openGate
          ? this.cfg.maxPublicRegistrationsPerWindow
          : this.cfg.maxRegistrationsPerWindow,
        windowMs: this.cfg.failureWindowMs,
      });
      if (!claimed) throw registrationRateLimited();
    } else if (openGate) {
      throw signupUnavailable();
    }

    // No mailer + open gate: refuse — the inversion of the open gate's own reasoning. The gate
    // originally shipped BECAUSE mail was dark; now the mail is the funnel (the response is
    // constant, the mail carries the only continuation), so creating an account whose
    // verification link can never be sent is a row that looks like a signup and whose owner was
    // told to check an inbox nothing will arrive in. `signup_unavailable` is the right sentence:
    // the DEPLOYMENT cannot complete an open signup, and the invite path — which needs no mail —
    // still works. Checked BEFORE the password hash so a misconfigured deployment does not spend
    // ~100 ms of scrypt per probe.
    if (openGate && !this.deps.mail) throw signupUnavailable();

    // Hash the password BEFORE the transaction opens: scrypt is deliberately slow
    // (~100 ms), and holding the invite row's write lock across it would serialize
    // every concurrent redemption of that code behind one CPU-bound operation.
    const passwordHash = await this.deps.passwordHasher.hash(b.password);

    // The transaction decides WHAT HAPPENED; the mail is sent afterwards, outside it. `null`
    // means "already registered", which on the open path is not an error and must not be one — a
    // throw becomes a status code, and a status code is the oracle; the code below turns it into
    // the same 202 a fresh signup gets. The sends are NOT inside `inTransaction`: a mail is a
    // network call with its own timeout, and holding a Postgres transaction (and its connection,
    // on a small serverless pool) across one is a self-inflicted outage — and a mail failure can
    // then never roll back a committed account.
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

      // The capacity valve, on the open path only. An invited person was chosen by an operator —
      // minting the invite WAS the capacity decision; past the cap a stranger goes to the
      // waitlist. SOFT, said out loud: this read and the insert share a transaction, but under
      // READ COMMITTED two concurrent registrations both see `cap - 1` and both proceed. A hard
      // cap needs a serialized counter row — a write lock on every signup, to enforce a number
      // chosen as a rough limit.
      if (openGate && this.cfg.publicSignupCap !== null) {
        const [taken] = await tx.select({ n: count() }).from(accounts);
        if ((taken?.n ?? 0) >= this.cfg.publicSignupCap) throw signupCapacityReached();
      }

      // The address. On the INVITE path this is reachable only by a caller who proved they hold
      // an invite for THIS address. On the OPEN path a taken address is NOT a refusal — a refusal
      // is a status code and a status code is the oracle — so it becomes the private sentinel the
      // code after the transaction turns into the same 202. This READ is the polite refusal, not
      // the guarantee: under READ COMMITTED two concurrent registrations both select nothing, and
      // `UNIQUE (account_id, email)` can never catch them because each inserts its own fresh
      // `accounts` row first. The guarantee is `users_email_unique_idx` (migration 0021), and the
      // catch below turns its violation back into the same sentence instead of a 500.
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

    // The open path: ONE mail, then the SAME answer either way. `created === null` means already
    // registered — from the read OR the concurrent unique-violation, which is why both throw the
    // same sentinel. Both branches send exactly one mail through the same `unsolicited`
    // per-recipient budget (`MailQuota`) — a constant response with a branch-dependent side
    // effect is not constant — then return identical `RegistrationPending`. A FAILED send does
    // not fail the request or strand the signup: the account is reachable by the re-entry path
    // (`POST /auth/login` re-mints an enrollment session at zero factors) and the wizard offers a
    // resend, so a mail outage costs one sign-in, never an account. `mailed` is for callers
    // inside the trust boundary; the route must never put it on the wire.
    const mail = this.deps.mail!;
    const result = created === null
      ? await mail.sendAccountExists(ctx, { to: email })
      : await mail.issueEmailVerification(ctx, { userId: created.openUserId, to: email });
    return { status: "verification_pending", mailed: result.status === "sent" };
  }

  /**
   * Prove an address: a token MAILED to it PLUS the account's password. Token-only is an
   * account-takeover primitive: an attacker registers the victim's address with a chosen
   * password, enrolls their own factor via re-entry, and the victim's innocent click stamps
   * `email_verified_at` on the ATTACKER's account. The password closes it — the two credentials
   * are held by different people in every abuse — and makes link-prefetching scanners harmless.
   * The throttle is MANDATORY: this verifies a password, so it claims the SAME keys `login` uses.
   * The session is minted only at zero factors; otherwise `{status:"verified"}`. The token stays
   * `purpose='email_verify'`; consumption is `consumeEmailVerification`.
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
   * Send this session's owner another verification link. AUTHENTICATED, and that is what makes it
   * safe: the natural unauthenticated address-taking endpoint is a mail-bomb and an enumeration
   * oracle at once — no endpoint takes a RECIPIENT from an anonymous caller. The recipient is
   * `users.email` for the session's own user; there is no parameter, and `issueEmailVerification`
   * refuses any other `to`. Both limiters, neither new: `reserveIpSlot` under `verify:ip` (429)
   * and the `unsolicited` per-recipient budget. An unknown IP does NOT refuse here: the session
   * is the identity. The response is uninformative — `{ ok: true }` whether sent, limited, or
   * already verified: a limiter readout on the wire is an oracle.
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
    /**
     * {@link PASSWORD_MAX_LENGTH} applies here too, and it did not. Its rationale is about THIS
     * path's cost — scrypt is ~100 ms, run before the transaction, on a public route — yet
     * `login`, equally public and reached far more often, called `requireField` alone. Only the
     * MAXIMUM, not `requirePassword`'s minimum: a stored password shorter than today's policy
     * must still sign in, and nothing about the length of a SUBMITTED guess is a fact about the
     * account. Before the throttle reservation, so a malformed request burns no attempt, and
     * before scrypt, which is the cost being refused.
     */
    const password = requireField(b.password, "password");
    if ([...password].length > PASSWORD_MAX_LENGTH) {
      throw new ServiceError(
        "validation_failed", 400,
        `password must be at most ${PASSWORD_MAX_LENGTH} characters`,
      );
    }

    // The attempt is reserved on the EMAIL key first — before the user lookup, so both branches
    // are behind the same gate. Checking only `user:<id>` made the lockout an account-existence
    // oracle: past `maxFailures` a registered email answered 423 while an unregistered one
    // answered 401 for ever. RESERVE, not check: `throttleCheck` was a pure SELECT with the
    // increment landing after the verify, so N simultaneous requests all read "not locked" and
    // the effective limit was the attacker's concurrency, not `maxFailures`. See {@link
    // throttleReserve}.
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
   * Mint the ONE-USE code a desktop install exchanges for a session: the ceremony happens in the
   * browser, and the app receives a value worth nothing to anyone not holding it within two
   * minutes. It reuses `login_tokens` as a third `purpose` (`desktop_link`), mutually invisible
   * BY QUERY: a code shown on a page cannot be a first factor, a mailed token cannot become a
   * native session. The route carries `stepUp: true` — a live browser session must not grow
   * itself a rolling native credential. `challenge` is the optional commitment for URL-scheme
   * delivery: the app keeps a 32-byte verifier, sends `sha256(verifier)`; binding is decided at
   * MINT, never afterwards. Absent = the browser flow; malformed refuses.
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

    // A mint SUPERSEDES: at most one desktop code per user, and it is a real bound. Security —
    // "show me another code" must kill the one on screen (most likely shown on a shared screen).
    // Growth — `login_tokens` has no reaper and this route has no throttle, so DELETE rather than
    // mark-consumed bounds the rows at one per user; nothing is lost, the history is in
    // `auth_events`. `FOR UPDATE` on the OWNER row, exactly as {@link generateRecoveryCodes}:
    // delete-then-insert is not a supersede under READ COMMITTED — two concurrent mints both
    // delete then both insert and BOTH codes survive; the lock serializes them, and the `users`
    // row is locked because `FOR UPDATE` can only lock rows that EXIST (a first mint has no token
    // row). A racing claim of the old code is correct in both orders: claim then delete, or
    // delete then `invalid_code`.
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
   * Exchange a live handoff code for a native session — no session required; the code is the
   * credential. Single-use is the DATABASE's job: one `UPDATE … consumed_at IS NULL … RETURNING`
   * (`desktop-link.pg.test.ts` runs it concurrently). Every failure gets {@link
   * invalidDesktopCode}. A slot claim per IP bounds attempts; a blank IP is ADMITTED — the search
   * space is a 128-bit two-minute secret. `verifier` completes the mint's commitment, one more
   * conjunct of the SAME UPDATE. An absent verifier means `challenge_hash IS NULL`, never "no
   * condition"; a presented verifier requires an EXACT bound match — an unbound row admitted is
   * session fixation. A failed binding matches no row, so it does not burn the code.
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
    // The cheap refusals and the cross-account check come BEFORE the throttle, deliberately:
    // `reserveIpSlot` MUTATES, so a 409 raised after it charged the caller for a request that did
    // nothing, and with the window nearly full the advice "sign out and try again" met a 429. No
    // oracle opens: the peek matches an exact `generateToken()` hash, so a caller learns only
    // about a code it already holds, and the length bounds are string tests reaching neither the
    // database nor `sha256`. Bounded before `sha256` for `requirePassword`'s reason: an unbounded
    // anonymous body is free work, and a real code is nowhere near 512.
    if (raw.length === 0 || raw.length > 512) throw invalidDesktopCode();
    // Bounded for the same reason the code is, and BEFORE `hashToken` runs over it. A verifier
    // this long is not one this flow produces (32 bytes, base64url, 43 characters), so the bound
    // costs a real client nothing.
    if (verifier.length > 512) throw invalidDesktopCode();

    // ONE predicate either way — see the header. `presented` is never "no condition".
    const binding = verifier.length > 0
      ? eq(loginTokens.challengeHash, hashToken(verifier))
      : isNull(loginTokens.challengeHash);

    // BEFORE THE BURN, and only when there is something to compare. This door consumes its code
    // in the same statement that resolves it, so the cross-account refusal cannot live at
    // `establish` — by the time that runs the code is spent, and a 409 would leave the claimant
    // unable to retry after signing out. The extra read costs a lookup on the token hash and
    // happens only for a caller who already holds a session; the sessionless claim, which is
    // every shipped desktop's, is untouched. A row consumed between this read and the write
    // below still loses there, on `consumed_at IS NULL`.
    if (ctx.accountId) {
      const [peek] = await db.select({ userId: loginTokens.userId }).from(loginTokens)
        .where(and(
          eq(loginTokens.tokenHash, hashToken(raw)),
          eq(loginTokens.purpose, DESKTOP_LINK_PURPOSE),
          isNull(loginTokens.consumedAt),
          gt(loginTokens.expiresAt, now),
          binding,
        )).limit(1);
      if (peek) refuseCrossAccountCredential(ctx, (await this.loadUser(db, peek.userId)).accountId);
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
    // The device row is labelled for the app — the claimant's declared kind, or legacy `"macos"`
    // when it said nothing — so `GET /devices` shows the machine and `DELETE /devices/:id` can
    // take it away; that revocation path is what makes the handoff safe to offer. `surface:
    // "native"` is PINNED, not derived, which makes the declaration privilege-free: every
    // admissible kind mints the identical credential, and the kind selects a device row's
    // spelling and nothing else. No `method`, so no `2fa_verified` row: no factor was asserted
    // HERE. `twofaAt: ctx.now()` is honest — the mint side cleared `withStepUp` less than
    // `desktopLinkTtlMs` ago, on the browser that produced this code.
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
    // BEFORE THE CREDENTIAL IS SPENT. `peekLoginToken` reads without consuming, so refusing here
    // burns nothing: the login token, the factor's replay window and the recovery code are all
    // still intact, and clearing the ambient session and retrying succeeds. Placed at the peek
    // rather than inside `establish` because `establish` runs after the consume — a 409 from
    // there answered correctly and destroyed the credential on the way out.
    refuseCrossAccountCredential(ctx, user.accountId);
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
   * `b.kind` — the caller's own declaration, {@link DESKTOP_DECLARED_KINDS} or absent, for one
   * client: the desktop's cloud-door password sign-in, which used to mint a DEVICELESS session,
   * invisible to staleness attribution. A present declaration makes `establish` auto-mint a
   * device row of that kind. NO PRIVILEGE rides on it: the admissible kinds all derive the COOKIE
   * lifetime surface, so a declared sign-in gets the same window, scope and factor stamp — the
   * only delta is `device_id`. `GET /devices` names it, `DELETE /devices/:id` can aim at it, the
   * staleness alarm watches it. Refused BEFORE the throttle reserve and token peek: a malformed
   * declaration burns nothing.
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
    // BEFORE THE CREDENTIAL IS SPENT. `peekLoginToken` reads without consuming, so refusing here
    // burns nothing: the login token, the factor's replay window and the recovery code are all
    // still intact, and clearing the ambient session and retrying succeeds. Placed at the peek
    // rather than inside `establish` because `establish` runs after the consume — a 409 from
    // there answered correctly and destroyed the credential on the way out.
    refuseCrossAccountCredential(ctx, user.accountId);
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

  // Step-up re-verification — the inline ceremony behind a stale 5-minute window. `withStepUp`
  // refuses a stale `last_twofa_at` with 403; before these methods the only refresh was a full
  // sign-out/sign-in, a dead end for every step-up-gated verb after five minutes. These are the
  // sign-in second factor re-run against the caller's own session: same verify, same single-use
  // guards, same throttle key and lockout — a spent code cannot replay here, and spraying codes
  // locks the same counter. The stamp is a GUARDED update ({@link stampStepUp}): `revoked_at IS
  // NULL AND scope = 'full'` re-checked in the write, `RETURNING` inspected, 401 on zero rows —
  // an enrollment session can never re-stamp itself. No new cookie surface: `{ok: true}` and
  // nothing else. A paired device's bearer (minted `twofaAt: null`) MAY earn standing here by
  // asserting a real factor — the designed door.

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
    // credential's own clientDataJSON — never merely "the user's newest". A user-only lookup let
    // two overlapping ceremonies burn each other: the older tab's legitimate assertion was
    // matched against the newer tab's challenge, failed, counted toward the SHARED lockout, and
    // consumed the newer row — repeatable into a factor lockout by anyone holding any session of
    // the account. The extracted value is only a row SELECTOR: `verifyAssertion` still checks the
    // signed clientDataJSON against the claimed row's challenge and origin. `userId` stays in the
    // predicate NON-optionally — a call passing neither key would select ANY newest challenge.
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
   * Mint a fresh batch of ten break-glass codes and retire every earlier one. A bare delete +
   * insert auto-committed separately: two overlapping regenerations both delete then both insert
   * and BOTH batches survive — ten retired codes stay live second factors. A transaction alone
   * does not fix that under READ COMMITTED; the `FOR UPDATE` on the OWNER ROW is the mechanism,
   * and the transaction only makes the lock outlive its statement. The `users` row is the lock,
   * not the code rows: `FOR UPDATE` can only lock rows that EXIST, and a first mint has no code
   * rows. Still only half: {@link recoveryVerify} honours the NEWEST batch only, so a
   * pre-existing surplus pair cannot both be valid either.
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
   * The batch a user's recovery codes must belong to: the newest one they own. `batch_id` was
   * WRITTEN by every regeneration and READ by nothing, so "regenerating invalidates the prior
   * set" rested entirely on a delete having worked. Now only the most recently created batch is
   * honoured, so a surplus batch left by a race, a partial failure or a hand-run statement is
   * inert rather than a live second factor. Ordered by `created_at` then `batch_id`: ten rows of
   * one batch can share a timestamp, and two batches in one millisecond must still resolve to
   * exactly ONE answer for every caller.
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
    // BEFORE THE CREDENTIAL IS SPENT. `peekLoginToken` reads without consuming, so refusing here
    // burns nothing: the login token, the factor's replay window and the recovery code are all
    // still intact, and clearing the ambient session and retrying succeeds. Placed at the peek
    // rather than inside `establish` because `establish` runs after the consume — a 409 from
    // there answered correctly and destroyed the credential on the way out.
    refuseCrossAccountCredential(ctx, user.accountId);
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
   * Mint the native authorization code. The gate is on the ROUTE (`GET /oauth/authorize` carries
   * `stepUp: true`) and this method deliberately does not repeat it — `withStepUp` is where every
   * step-up decision is made, and a second implementation is how the two drift; the flag is
   * enforced on `raw` routes (`app.ts#RAW_PIPELINE`). What the session row IS read for is not the
   * gate: `POST /oauth/token` asserts no factor of its own, so the session it establishes has no
   * honest `last_twofa_at` to write — the authorizing session has the real one, and this is the
   * only point where both are in scope. Reading a value to RECORD it is not re-implementing a
   * gate: nothing below branches on it.
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
    /**
     * The two opaque values are bounded, and neither was. `client_id` and `redirect_uri` are
     * checked by EQUALITY against a registered value, so their size costs one comparison; these
     * two are not: `code_challenge` is STORED on the code row, and RFC 7636 §4.2 makes an S256
     * challenge the base64url of a SHA-256 digest — exactly 43 characters, so anything else can
     * never verify; `state` is ECHOED into the redirect's `Location` header — unbounded, it is a
     * caller-chosen header value the proxy answers 431/502 for. RFC 6749 sets no maximum; {@link
     * OAUTH_STATE_MAX_CHARS} is the practical one every URL shares.
     */
    if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) {
      throw new ServiceError(
        "validation_failed", 400,
        "code_challenge must be the base64url SHA-256 digest an S256 challenge is",
      );
    }
    if (q.state.length > OAUTH_STATE_MAX_CHARS) {
      throw new ServiceError(
        "validation_failed", 400,
        `state is ${q.state.length} characters; the limit is ${OAUTH_STATE_MAX_CHARS}`,
      );
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
    // BEFORE THE BURN, for the reason the verify ceremonies give: a cross-account exchange must
    // not spend the code on its way to a 409. The row is already read above, so this costs one
    // user lookup and only for a caller who holds a session — a native exchange, which is every
    // real one, carries none.
    if (ctx.accountId) refuseCrossAccountCredential(ctx, (await this.loadUser(db, row.userId)).accountId);

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
    // THE TOTAL CLAMP, not the arithmetic. `Math.min(Math.max(1, x), 200)` is correct for every
    // number and wrong for the two values that are not numbers in the arithmetic sense: `NaN`
    // survives it and drizzle then OMITS the limit clause entirely, and a fraction survives it and
    // reaches `bigint` as `invalid input syntax`. This route reads `Number(url.searchParams
    // .get("limit"))`, so the caller picks the double — it is the exemplar's own defect, on the
    // one page-limit path the sweep's first pass did not convert. See `clampPageLimit`.
    const limit = clampPageLimit(opts.limit, 50, 200);
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
   * Authorization for the FACTOR-ENROLLMENT surface. Two admissible callers, not the same caller
   * — why these routes cannot simply carry `stepUp`: an ENROLLMENT-scoped session (onboarding's
   * FIRST factor — no `last_twofa_at`, never will have one, so a plain step-up gate would lock
   * onboarding out), and a FULL session with recent 2FA ("add another factor later"). Without the
   * second leg, ADDING a factor was strictly easier than REMOVING one: any still-valid-but-old
   * session could plant an attacker-controlled passkey and obtain durable independent access.
   * Same bar in both directions now.
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
   * Mint the ENROLLMENT-SCOPED session; each property load-bearing: `scope='enrollment'` —
   * admitted only on the `enrollmentOk` routes; `lastTwofaAt` stays NULL — a password-only
   * session must never satisfy step-up; no `refresh_tokens` row and `refreshExpiresAt =
   * accessExpiresAt` — it dies in ~5 min whatever the client does; no `devices` row. It
   * SUPERSEDES any earlier enrollment session of the same user: re-entry used to accumulate live
   * siblings, so a token captured during one password-only window stayed usable after somebody
   * finished onboarding on a sibling — replayable into a passkey of the holder's choosing. At
   * most one password-only session per user may be live.
   */
  private async establishEnrollment(
    ctx: ServiceContext, user: typeof users.$inferSelect,
  ): Promise<EnrollmentSessionEstablished> {
    // BEFORE ANY WRITE, and `establish`'s guard does not cover this: an enrollment session is
    // minted here rather than there, so a live session for A submitting B's correct password to
    // `/auth/login` — with B holding no factor — reached the zero-factor arm and walked out with
    // B's enrollment session and its bearer token. The two mints needed the same refusal; only one
    // had it.
    refuseCrossAccountCredential(ctx, user.accountId);
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

    // AN ENROLLMENT SESSION IS STILL A SESSION. This mint does not go through `establish` — it
    // writes its own row — so it needs its own report, and without one the zero-factor arms of
    // `/auth/login`, `/auth/verify-email` and `/auth/register` answered with an enrollment
    // credential and named nobody. Success tail, and inside a transaction the report is buffered
    // to the commit by `inTransaction`.
    ctx.noteCredentialAccount?.(user.accountId);
    return {
      status: "enrollment",
      user: await this.sessionUser(db, user.id),
      next: "enroll_2fa",
      enrollmentToken: token,
      expiresIn: Math.floor(this.cfg.loginTokenTtlMs / 1000),
    };
  }

  /**
   * EXCHANGE (not upgrade-in-place) the enrollment session for a full one when the first factor
   * lands — session-fixation hygiene: a privilege change mints a NEW session id and refresh
   * family, so a token observed during the password-only window can never replay as a full
   * credential. The revocation predicate is `user_id + scope='enrollment'`, NOT the presented
   * family: revoking only the caller's family left a sibling live and replayable into an
   * attacker-chosen passkey. Returns `undefined` for an already-full session. The scope is read
   * from the ROW under `FOR UPDATE`, never from the request: the gate and this privilege decision
   * must not share a trust path, and the lock makes the retirement true under concurrency.
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
   * Resolve a first-factor login token — scoped to `purpose='login'`. Email verification put a
   * second kind of row in this table (a `purpose='email_verify'` token whose raw value is MAILED
   * to an inbox), and an unscoped lookup would make that mailed value presentable here — turning
   * "read one email" into a live first factor for every 2FA endpoint. The predicate keeps the two
   * token families non-interchangeable; `mail-service.test.ts` ("a mailed verification token is
   * not a login token") asserts it bites, with a `purpose='login'` row of identical shape as the
   * control.
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
   * `peekLoginToken` reads and checks `consumedAt`; an unconditional `UPDATE … WHERE id` made the
   * pair a read-modify-write — two racing presentations both peek unconsumed, both verify, both
   * get a session from a single-use token. The `consumed_at IS NULL` predicate makes the write
   * the arbiter (as in `consumeInvite`); the loser is told what a stale token is always told.
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
    // Single-use + origin/RP-ID binding. `rpID` stays single-valued — an equality check. The
    // ORIGIN is checked twice, answering different questions: (a) MEMBERSHIP — is the origin this
    // challenge was minted for still one this deployment serves? A row written before an origin
    // was removed (or by a differently-configured host sharing the database) must not be
    // completable. (b) PIN — does the verify request come from the same origin that OPENED the
    // ceremony? A deployment may allow several origins, and without this any of them could finish
    // another's ceremony. Native requests with no `Origin` header skip (b); their pin is still
    // enforced downstream, because `expectedOrigin` is `row.origin` and `clientDataJSON.origin`
    // is signed.
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
   * Admit or refuse ONE attempt, counting it in the SAME statement that decides. `throttleCheck`
   * was a pure read, so the real bound was the attacker's concurrency (`auth-throttle.pg.test.ts`
   * measured 40 concurrent guesses all reaching the hasher). Count and decision are ONE `INSERT …
   * ON CONFLICT DO UPDATE … RETURNING`. A live lock refuses WITHOUT counting (else hammering
   * slides `locked_until` for ever); an expired lock or rolled window restarts at 1; otherwise
   * increment. The lock installs only when the count EXCEEDS `maxFailures`: reaching it exactly
   * is admitted, and {@link throttleRefund} keeps a correct password one short from ever locking.
   * Raw `sql` templates take ISO strings, never `Date`s — a 500 on every failed login otherwise.
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
   * The attempt {@link throttleReserve} counted has now FAILED: install the lock if the count
   * reached the policy. One statement, compared server-side against the row's own column, so two
   * concurrent failures cannot disagree about the threshold. It does not increment — the
   * reservation did, and counting twice would halve the budget. A live lock is left as it is
   * rather than extended (arm 1's reason). No INSERT arm: every call site reserves the same key
   * first, so the row exists.
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
   * Give back the ONE attempt this request reserved, because the credential was RIGHT. Not {@link
   * throttleReset}: a full reset would launder the second-factor counter — correct password
   * (zeroes `user:<id>`), wrong TOTP, repeat, never reaching the 2FA lockout. So this decrements
   * exactly what was reserved and clears the lock only if the remainder is back under policy;
   * `throttleReset` still runs on a COMPLETED login. Without this, a right password whose second
   * factor is outstanding would spend budget: five visits to the 2FA screen would lock an account
   * on which nothing failed.
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
   * Finalize a refused TOTP presentation — a counted failure, or a REPLAY that must not burn a
   * lockout slot. The single-use-per-timestep guard means the code that just signed someone in
   * FAILS when retyped seconds later at the step-up sheet. Counting those as attempts locked real
   * people out: measured, five presentations of one just-consumed code in eleven seconds produced
   * a fifteen-minute lockout with nothing guessed. The lockout prices GUESSING, and a replay is
   * not a guess: reaching this arm requires a code that VERIFIES against the secret. The outward
   * refusal is byte-identical to the wrong-code arm, so no oracle; the audit row says
   * `2fa_failed` with a replay detail.
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
   * `push_subscriptions` rows carry the registering session's `device_id`, so revoking a paired
   * phone must also stop the worker POSTing wakes to its UnifiedPush endpoint — a revoked device
   * still receiving "something changed" is a take-back that did not take everything. The prune
   * runs AFTER the base revoke so a step-up refusal deletes nothing, and lives HERE because the
   * base class also serves the desktop engine, whose mail-only database has no push table.
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

  /**
   * Signing out a device takes its wake registration with it — {@link revokeDevice}'s rule, on
   * the door people actually use. The base `logout` revoked the session family only, so a phone
   * that forgot a server kept a live row: the endpoint answers 2xx for ever and the prune-on-410
   * never fires. HERE, not `SessionLifecycle`: the desktop-host door's database has no push
   * table. AFTER `super.logout` (a step-up refusal deletes nothing), in ONE transaction: the
   * revoked family is the only credential that could retry — a crash between autocommitted
   * statements leaves the row live and unremovable. A session with NO device row prunes nothing:
   * web-push rows carry `device_id = NULL`, and deleting them all would silence another browser.
   */
  override async logout(ctx: ServiceContext, b: { allDevices?: boolean } = {}): Promise<void> {
    await this.inTransaction(ctx, async (txCtx) => {
      await super.logout(txCtx, b);
      const db = asTx(txCtx);
      if (b.allDevices) {
        // ── SCOPED TO THIS USER'S DEVICES, because that is what the base logout revoked ───────
        //
        // `super.logout`'s mass arm revokes sessions and refresh families for `ctx.userId`
        // alone; an account can hold several users, and deleting every push row on the ACCOUNT
        // took another user's registrations down while that user stayed signed in — a take-back
        // reaching past the thing it was taking back. The device rows carry the user, so the
        // prune follows the same scope the revoke used.
        //
        // Deviceless rows (a browser's web-push) are not reached, and cannot be: nothing on them
        // names a user. That is the residue named on its own row, not a gap to guess at here.
        const mine = txCtx.userId;
        if (!mine) return;
        await db.delete(pushSubscriptions).where(and(
          eq(pushSubscriptions.accountId, txCtx.accountId),
          inArray(
            pushSubscriptions.deviceId,
            db.select({ id: devices.id }).from(devices)
              .where(and(eq(devices.accountId, txCtx.accountId), eq(devices.userId, mine))),
          ),
        ));
        return;
      }
      if (!txCtx.sessionId) return;
      const row = (await db.select({ deviceId: sessions.deviceId }).from(sessions)
        .where(eq(sessions.id, txCtx.sessionId)).limit(1))[0];
      const deviceId = row?.deviceId ?? null;
      if (deviceId === null) return;
      await db.delete(pushSubscriptions).where(and(
        eq(pushSubscriptions.accountId, txCtx.accountId),
        eq(pushSubscriptions.deviceId, deviceId),
      ));
    });
  }

}

/**
 * One four-digit group of a recovery code. `randomInt`, NOT `Math.random()`, which stood here: a
 * recovery code stands in for the whole second factor, so the generator must be the cryptographic
 * one — `Math.random()` is a plain PRNG whose internal state is recoverable from a run of
 * outputs, and every group of every code a process issues comes from that one state: "unguessable
 * until somebody has seen enough of it". The range is unchanged (`randomInt(1000, 10000)`,
 * uniform over 1000-9999). Codes are stored as hashes, so nothing already issued is affected —
 * only where the next code's bits come from changes.
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
