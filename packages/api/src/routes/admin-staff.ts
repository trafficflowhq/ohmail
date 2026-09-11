import { and, eq, isNull, sql } from "drizzle-orm";
import { staffSessions, staffUsers, authThrottle } from "@trafficflow/db/cloud";
import {
  scryptHasher, generateToken, hashToken,
  newTotpSecret, totpUri, verifyTotp,
} from "@trafficflow/services";
import { presentsSecret, secretRouteJson as json } from "../secret-auth.js";
import type { ApiDeps } from "../deps.js";
import type { Handler, Route } from "../router.js";

/**
 * `POST /admin/staff/*` — the login wall behind the login wall. `ADMIN_GATE_SECRET` hides that
 * the console exists (it stays — a login form is an advertisement); this — email, password, TOTP
 * — says who. Not `AuthService`: a session that can read mail and one that can suspend an account
 * must come from different tables verified by different code, or one bug is both; this reuses the
 * primitives (`scryptHasher`, the TOTP module, `generateToken`/`hashToken`, `auth_throttle`) and
 * none of the service. Runs on `deps.db`: the blind role holds nothing on `staff_users`. A failed
 * sign-in reveals the fact, never the factor: all three failures answer 401 `invalid`, and the
 * unknown-email path runs a full scrypt against a decoy hash.
 */

/* ── the shapes the console reads ──────────────────────────────────────────────────────── */

export type StaffSignInResult =
  /** Password (and TOTP, when enrolled) accepted. `token` goes in a host-only cookie. */
  | { ok: true; status: "signed_in"; token: string; email: string; expiresAt: string }
  /** Password accepted; this operator has no activated authenticator yet. */
  | { ok: false; status: "enrollment_required"; enrollToken: string }
  /** Password accepted, authenticator enrolled, no code supplied yet. */
  | { ok: false; status: "totp_required" }
  /** Anything wrong, anywhere. Deliberately one shape. */
  | { ok: false; status: "invalid" }
  | { ok: false; status: "throttled"; retryAfterSeconds: number };

/* ── policy ────────────────────────────────────────────────────────────────────────────── */

/** A staff session is a working day, not a fortnight. A stolen laptop is the threat. */
const SESSION_TTL_SECONDS = 12 * 60 * 60;
/**
 * The enrolment token is unprivileged — it can only reach the two enrolment routes — but it is
 * minted from a password alone, so it is short. Long enough to photograph a QR and type six
 * digits; not long enough to leave lying around.
 */
const ENROLL_TTL_SECONDS = 10 * 60;
/** TOTP skew tolerance, in 30s steps. One step each way is the standard, and enough. */
const TOTP_WINDOW = 1;

/** Failures allowed inside the window before the key locks. */
const THROTTLE_MAX_FAILURES = 5;
/** How long a locked key stays locked. */
const THROTTLE_LOCK_SECONDS = 15 * 60;
/** Failures older than this are forgotten — a typo last Tuesday is not evidence. */
const THROTTLE_WINDOW_SECONDS = 15 * 60;

/**
 * A scrypt hash of a value nobody knows, verified against when the email is unknown.
 *
 * `scryptHasher.verify` returns false for a malformed hash WITHOUT doing any work, so a
 * literal like `"decoy"` would defeat the purpose entirely — the unknown-email path would
 * return in microseconds and the timing would answer the question the 401 refuses to. This is
 * a real hash of a real random string, computed once per process at first use.
 */
let decoyHash: string | null = null;
async function decoy(): Promise<string> {
  decoyHash ??= await scryptHasher.hash(generateToken(32));
  return decoyHash;
}

/* ── the throttle ──────────────────────────────────────────────────────────────────────── */

/**
 * `auth_throttle` again, with a `staff:` prefix — the same table, window and lock the product's
 * own login uses.
 *
 * A SECOND throttle implementation for the same job is how two things that are supposed to
 * behave identically stop doing so, so this reuses the row shape rather than the code path
 * (the service's version is bound to `users`). The prefixes are `staff:email:<addr>` and
 * `staff:ip:<sha256 prefix>` — the IP is HASHED, because an operations table is not a place to
 * accumulate a log of where somebody was working from.
 */
interface ThrottleVerdict { locked: boolean; retryAfterSeconds: number }

/**
 * Count one attempt and decide, in one statement — the admission gate, replacing a check-then-act
 * pair under which simultaneous requests all read "unlocked" (`AuthService.throttleReserve` is
 * the same fix for the customer login). The arms, in order: a live lock refuses without counting
 * (counting lets an attacker slide `locked_until` forward forever); a served lock and a rolled
 * window restart at 1; otherwise increment. The lock is installed only by the attempt that
 * exceeds the policy — reaching exactly `THROTTLE_MAX_FAILURES` is admitted, and {@link
 * throttleFail} installs the lock after the attempt failed, which stops a correct credential on
 * the last permitted attempt from locking the account. ISO strings in every raw fragment.
 */
async function throttleReserve(
  db: ApiDeps["db"], key: string, now: Date,
): Promise<ThrottleVerdict> {
  const floorIso = new Date(now.getTime() - THROTTLE_WINDOW_SECONDS * 1000).toISOString();
  const nowIso = now.toISOString();
  const lockIso = new Date(now.getTime() + THROTTLE_LOCK_SECONDS * 1000).toISOString();
  const live = sql`(${authThrottle.lockedUntil} is not null and ${authThrottle.lockedUntil} > ${nowIso}::timestamptz)`;
  const served = sql`(${authThrottle.lockedUntil} is not null and ${authThrottle.lockedUntil} <= ${nowIso}::timestamptz)`;
  const rolled = sql`${authThrottle.windowStartedAt} < ${floorIso}::timestamptz`;
  const next = sql`case when ${live} then ${authThrottle.failures}
                        when ${served} then 1
                        when ${rolled} then 1
                        else ${authThrottle.failures} + 1 end`;

  const [row] = await db.insert(authThrottle)
    .values({ key, failures: 1, windowStartedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: authThrottle.key,
      set: {
        failures: next,
        windowStartedAt: sql`case when ${live} then ${authThrottle.windowStartedAt}
                                  when ${served} then ${nowIso}::timestamptz
                                  when ${rolled} then ${nowIso}::timestamptz
                                  else ${authThrottle.windowStartedAt} end`,
        lockedUntil: sql`case when ${live} then ${authThrottle.lockedUntil}
                              when (${next}) > ${THROTTLE_MAX_FAILURES} then ${lockIso}::timestamptz
                              when ${served} then null
                              when ${rolled} then null
                              else ${authThrottle.lockedUntil} end`,
        updatedAt: now,
      },
    })
    // No projection: this handle's builder types `returning()` with no arguments, so the whole
    // row comes back and the two columns are read off it.
    .returning();

  // No row can only mean the write did not happen, and "we could not count this attempt" must
  // REFUSE rather than admit — `ip-throttle.ts:77-80` makes the same call.
  if (!row) return { locked: true, retryAfterSeconds: THROTTLE_LOCK_SECONDS };
  const remaining = row.lockedUntil ? (row.lockedUntil.getTime() - now.getTime()) / 1000 : 0;
  if (remaining > 0) return { locked: true, retryAfterSeconds: Math.ceil(remaining) };
  // The floor beneath the statement, for a lock window of zero.
  if (row.failures > THROTTLE_MAX_FAILURES) {
    return { locked: true, retryAfterSeconds: THROTTLE_LOCK_SECONDS };
  }
  return { locked: false, retryAfterSeconds: 0 };
}

/**
 * Install the lock if the attempt {@link throttleReserve} already counted has now FAILED.
 *
 * It does NOT increment — the reservation did that, and counting twice would halve the budget.
 * The threshold comparison is made server-side against the row's own column, so two concurrent
 * failures cannot disagree about whether the line was crossed, and a live lock is left as it is
 * rather than extended.
 */
async function throttleFail(db: ApiDeps["db"], key: string, now: Date): Promise<void> {
  // ISO strings in the raw fragments, never `Date`s: postgres-js serializes a raw-template
  // parameter against the type Postgres describes for `$n` in `$n::timestamptz` — TEXT — and
  // hands a `Date` to `Buffer.byteLength`, which throws. Every failed sign-in then answered 503
  // `admin_staff_failed` instead of 401 `invalid`: the refusal was correct and the response was a
  // server error. Green on PGlite through all 18 tests, red only against live Postgres. The fix
  // is the builder plus ISO strings, as `reserveIpSlot` already does.
  const nowIso = now.toISOString();
  const lockIso = new Date(now.getTime() + THROTTLE_LOCK_SECONDS * 1000).toISOString();

  await db.update(authThrottle)
    .set({
      lockedUntil: sql`case
        when ${authThrottle.lockedUntil} is not null and ${authThrottle.lockedUntil} > ${nowIso}::timestamptz
          then ${authThrottle.lockedUntil}
        when ${authThrottle.failures} >= ${THROTTLE_MAX_FAILURES} then ${lockIso}::timestamptz
        else ${authThrottle.lockedUntil} end`,
      updatedAt: now,
    })
    .where(eq(authThrottle.key, key));
}

/** A clean sign-in forgets the failures. Otherwise yesterday's typos lock out today. */
async function throttleClear(db: ApiDeps["db"], key: string): Promise<void> {
  await db.delete(authThrottle).where(eq(authThrottle.key, key));
}

/**
 * Give back the attempt this request reserved, because the PASSWORD was right and the request is
 * being asked to come back with more.
 *
 * Without it the console's own two-call sign-in — `{email,password}` for `totp_required`, then
 * `{email,password,code}` — would spend two of five attempts every time an operator signs in, so
 * the second clean sign-in of the day would lock the account. A decrement and not a
 * {@link throttleClear}: clearing on a correct password would let somebody holding the password
 * but not the phone wipe the TOTP failures between guesses.
 */
async function throttleRefund(db: ApiDeps["db"], key: string, now: Date): Promise<void> {
  const back = sql`greatest(${authThrottle.failures} - 1, 0)`;
  await db.update(authThrottle)
    .set({
      failures: back,
      lockedUntil: sql`case when (${back}) >= ${THROTTLE_MAX_FAILURES} then ${authThrottle.lockedUntil} else null end`,
      updatedAt: now,
    })
    .where(eq(authThrottle.key, key));
}

/**
 * The caller's IP, hashed and truncated.
 *
 * Truncated because the throttle needs an identity, not an address: 16 hex characters is far
 * more than enough to keep two operators apart and cannot be reversed into somebody's home
 * network by whoever reads this table next.
 */
function ipKey(req: Request): string {
  const raw = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")?.trim()
    || "unknown";
  return `staff:ip:${hashToken(raw).slice(0, 16)}`;
}

const emailKey = (email: string): string => `staff:email:${email}`;

/* ── enrolment tokens ──────────────────────────────────────────────────────────────────── */

/**
 * The token that stands between "your password is right" and "your authenticator is set up". The
 * obvious implementation — a short-lived `staff_sessions` row with a flag keeping it out of the
 * authorised set — was rejected: it puts a not-quite-session in the table every authorised path
 * queries, surviving exactly as long as every path remembers the filter. An enrolment token is
 * not a session and has no row: an HMAC over the staff id and an expiry, signed with the
 * deployment's admin secret, authorising exactly two routes. Nothing that reads `staff_sessions`
 * can be tricked into treating one as a login, because there is no row to find.
 */
async function signEnrollToken(secret: string, staffId: string, expiresAt: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`ohmail-staff-enroll:v1:${staffId}:${expiresAt}`),
  );
  return `${staffId}.${expiresAt}.${Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function readEnrollToken(
  secret: string, token: string | undefined, now: Date,
): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [staffId, expiresRaw, mac] = parts as [string, string, string];
  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt)) return null;
  const expected = await signEnrollToken(secret, staffId, expiresAt);
  // Constant-time over the whole token, so neither the id nor the MAC leaks through timing.
  if (!timingSafeEqualStr(expected, token)) return null;
  return expiresAt * 1000 > now.getTime() ? staffId : null;
}

/** Length-invariant compare; the edge runtime has no `crypto.timingSafeEqual`. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/* ── sessions ──────────────────────────────────────────────────────────────────────────── */

/**
 * Mint a session: a 32-byte opaque token to the caller, its SHA-256 to the table.
 *
 * The plaintext exists in exactly two places — the response, and the operator's cookie jar. A
 * database dump, or a read-only injection anywhere in the product, yields digests.
 */
async function mintSession(
  db: ApiDeps["db"], staffId: string, now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  await db.insert(staffSessions).values({
    staffUserId: staffId, tokenHash: hashToken(token), expiresAt, createdAt: now,
  });
  return { token, expiresAt };
}

export interface StaffIdentity { staffId: string; email: string }

/**
 * Resolve a presented session token to the person it names, or null. `expires_at` is checked
 * here, in the query, against the request's clock — never against the cookie's `Max-Age`, an
 * attribute the client controls and can strip. `revoked_at` likewise: a sign-out takes effect on
 * the next request, not the next expiry. Exported because the write routes are required to call
 * it — requiring them to call this one is what keeps "the URL-key cookie alone authorises no
 * write" a property of one function rather than of five handlers' discipline.
 */
export async function resolveStaffSession(
  db: ApiDeps["db"], token: string | undefined, now: Date,
): Promise<StaffIdentity | null> {
  if (!token || token.length < 16) return null;
  const [row] = await db
    .select({ id: staffUsers.id, email: staffUsers.email, expiresAt: staffSessions.expiresAt })
    .from(staffSessions)
    .innerJoin(staffUsers, eq(staffUsers.id, staffSessions.staffUserId))
    .where(and(eq(staffSessions.tokenHash, hashToken(token)), isNull(staffSessions.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  return { staffId: row.id, email: row.email };
}

/* ── the routes ────────────────────────────────────────────────────────────────────────── */

/**
 * The wrapper: the shared secret, the JSON body, and `no-store`, applied identically to all
 * four — the same shape `adminRoute` gives the reads, for the same reason.
 *
 * There is deliberately NO injectable session verifier with a permissive default. A wrapper
 * whose auth can be defaulted away by a test harness is this codebase's named failure shape;
 * the only way to be authorised here is to present the secret.
 */
function staffRoute(name: string, run: (body: Record<string, unknown>, deps: ApiDeps, req: Request) => Promise<{ status: number; body: unknown }>): Handler {
  return async (req, deps) => {
    const cfg = deps.admin;
    const log = deps.logger?.child({ route: `/admin/staff/${name}` });
    if (!cfg || cfg.secret.trim().length === 0) return json(404, { error: { code: "not_found" } });
    if (!presentsSecret(req, cfg.secret)) {
      log?.warn("admin_staff_unauthorized", {});
      return json(401, { error: { code: "unauthorized" } });
    }
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: { code: "bad_request" } });
    }
    try {
      const out = await run(body ?? {}, deps, req);
      return json(out.status, out.body);
    } catch (err) {
      log?.error("admin_staff_failed", { err });
      return json(503, { error: { code: "admin_staff_failed" } });
    }
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const normalizeEmail = (v: unknown): string => str(v).trim().toLowerCase().slice(0, 320);

/**
 * `POST /admin/staff/session` — the whole sign-in, in one round trip once enrolled.
 *
 * The console posts `{ email, password }` first. If an authenticator is enrolled it gets
 * `totp_required` and posts again with `code`; the password is re-verified on that second call
 * rather than carried in a token, because a "password was already checked" token is a
 * credential in its own right and this flow does not need one.
 */
async function signIn(
  body: Record<string, unknown>, deps: ApiDeps, req: Request,
): Promise<{ status: number; body: StaffSignInResult }> {
  const now = deps.now();
  const email = normalizeEmail(body.email);
  const password = str(body.password);
  const code = str(body.code).replace(/\s+/g, "");
  const secret = deps.admin!.secret;

  // Both keys, RESERVED before any work: an attacker who can rotate one must not get a fresh
  // budget by doing so, and — see {@link throttleReserve} — a reservation is what makes the
  // five-attempt window a bound on GUESSES rather than a bound on how fast one client can read a
  // row. This was a pure SELECT with the increment after the scrypt and the TOTP compare.
  const keys = [emailKey(email), ipKey(req)];
  for (const key of keys) {
    const verdict = await throttleReserve(deps.db, key, now);
    if (verdict.locked) {
      return { status: 429, body: { ok: false, status: "throttled", retryAfterSeconds: verdict.retryAfterSeconds } };
    }
  }

  const [user] = email
    ? await deps.db.select().from(staffUsers).where(eq(staffUsers.email, email)).limit(1)
    : [];

  // ALWAYS a full scrypt verify, even with no such row. See `decoy()`.
  const passwordOk = await scryptHasher.verify(password, user?.passwordHash ?? (await decoy()));

  if (!user || !passwordOk) {
    for (const key of keys) await throttleFail(deps.db, key, now);
    return { status: 401, body: { ok: false, status: "invalid" } };
  }

  // Password is right and there is no authenticator yet: hand out the short unprivileged
  // enrolment token. Note this is NOT a session and cannot be used as one — it is not a row.
  //
  // The reservation is REFUNDED on both of these "come back with more" answers: the console signs
  // in with two calls, so charging each of them would spend two of five attempts on every clean
  // sign-in. See {@link throttleRefund}.
  if (!user.totpActivated || !user.totpSecretEnc || user.totpKeyVersion === null) {
    for (const key of keys) await throttleRefund(deps.db, key, now);
    const enrollToken = await signEnrollToken(
      secret, user.id, Math.floor(now.getTime() / 1000) + ENROLL_TTL_SECONDS,
    );
    return { status: 200, body: { ok: false, status: "enrollment_required", enrollToken } };
  }

  if (!code) {
    for (const key of keys) await throttleRefund(deps.db, key, now);
    return { status: 200, body: { ok: false, status: "totp_required" } };
  }

  const totpSecret = await deps.keyProvider.decrypt(user.totpSecretEnc, user.totpKeyVersion);
  const v = verifyTotp({
    secret: totpSecret, token: code, now, window: TOTP_WINDOW,
    afterStep: user.totpLastConsumedStep === null ? null : Number(user.totpLastConsumedStep),
  });
  if (!v.valid) {
    for (const key of keys) await throttleFail(deps.db, key, now);
    return { status: 401, body: { ok: false, status: "invalid" } };
  }

  // Advance the step conditionally — the compare-and-swap that makes single-use-per-timestep
  // survive concurrency. `verifyTotp` was handed `afterStep` from a row this call read; an
  // unconditional write means two submissions of the same six digits inside one 30-second window
  // both read the old step, both verify, both sign in. The sequential replay is stopped upstream
  // by `afterStep` inside `verifyTotp` (`test/admin-staff.test.ts` proves it). This `where`
  // clause is the concurrent case: removing it leaves every sequential test passing, because a
  // one-connection PGlite suite cannot interleave. `test/admin-staff-concurrency.pg.test.ts` is
  // the real-Postgres test: two connections, a barrier, one sign-in wins.
  const advanced = await deps.db.update(staffUsers)
    .set({ totpLastConsumedStep: BigInt(v.timeStep!), lastLoginAt: now, updatedAt: now })
    .where(and(
      eq(staffUsers.id, user.id),
      user.totpLastConsumedStep === null
        ? isNull(staffUsers.totpLastConsumedStep)
        : eq(staffUsers.totpLastConsumedStep, user.totpLastConsumedStep),
    ))
    .returning();
  if (advanced.length === 0) {
    // Somebody else consumed this step between the read and the write. That is the replay this
    // guard exists for, and it is refused exactly like a wrong code.
    for (const key of keys) await throttleFail(deps.db, key, now);
    return { status: 401, body: { ok: false, status: "invalid" } };
  }

  for (const key of keys) await throttleClear(deps.db, key);
  const { token, expiresAt } = await mintSession(deps.db, user.id, now);
  return {
    status: 200,
    body: { ok: true, status: "signed_in", token, email: user.email, expiresAt: expiresAt.toISOString() },
  };
}

/**
 * Who is asking to change the authenticator, and what did they prove? Both enrolment routes
 * accept a live enrolment token (minted from a correct password seconds earlier) or a live staff
 * session — and the session arm needed more: a session alone authorised replacing the
 * authenticator, so a stolen cookie could mint a fresh TOTP secret, confirm it, and re-mint
 * sessions before every expiry — permanent access, the operator locked out. The session arm now
 * costs a password, verified with the same scrypt and decoy timing as `signIn`. The console's
 * sign-in screen only uses the enrolment-token arm. `viaSession` travels back because it decides
 * one more thing — see {@link totpConfirm}.
 */
async function authorizeEnrollment(
  body: Record<string, unknown>, deps: ApiDeps, now: Date,
): Promise<{ staffId: string; viaSession: boolean } | null> {
  const secret = deps.admin!.secret;
  const fromToken = await readEnrollToken(secret, str(body.enrollToken) || undefined, now);
  if (fromToken) return { staffId: fromToken, viaSession: false };

  const session = await resolveStaffSession(deps.db, str(body.sessionToken) || undefined, now);
  if (!session) return null;

  // RE-ASSERT THE PASSWORD. Always a full scrypt, against the decoy when the row has somehow
  // gone, so a wrong password and a vanished operator cost the same time.
  const [user] = await deps.db.select().from(staffUsers)
    .where(eq(staffUsers.id, session.staffId)).limit(1);
  const ok = await scryptHasher.verify(str(body.password), user?.passwordHash ?? (await decoy()));
  if (!user || !ok) return null;
  return { staffId: session.staffId, viaSession: true };
}

/**
 * `POST /admin/staff/totp/begin` — show the secret, once. Authorised by either a live enrolment
 * token (first sign-in) or a live staff session plus the password (re-enrolment); the second arm
 * is the whole reason this route takes a session at all — without it a lost phone is a lost
 * console with no recovery but SQL. See {@link authorizeEnrollment} for why the password is not
 * optional. Beginning an enrolment replaces any pending secret and always leaves `totp_activated`
 * alone, so an abandoned enrolment cannot lock anybody out: the previously activated secret keeps
 * working until a code from the new one is confirmed.
 */
async function totpBegin(
  body: Record<string, unknown>, deps: ApiDeps,
): Promise<{ status: number; body: unknown }> {
  const now = deps.now();
  const authorized = await authorizeEnrollment(body, deps, now);
  if (!authorized) return { status: 401, body: { error: { code: "unauthorized" } } };
  const staffId = authorized.staffId;

  const [user] = await deps.db.select().from(staffUsers).where(eq(staffUsers.id, staffId)).limit(1);
  if (!user) return { status: 401, body: { error: { code: "unauthorized" } } };

  const totpSecret = newTotpSecret();
  const { ciphertext, keyVersion } = await deps.keyProvider.encrypt(totpSecret);
  await deps.db.update(staffUsers)
    .set({ totpSecretEnc: ciphertext, totpKeyVersion: keyVersion, updatedAt: now })
    .where(eq(staffUsers.id, staffId));

  return {
    status: 200,
    body: {
      secret: totpSecret,
      otpauthUrl: totpUri({ issuer: "ohmail Admin", label: user.email, secret: totpSecret }),
    },
  };
}

/**
 * `POST /admin/staff/totp/confirm` — a code from the new secret, then it counts. Activation and
 * the first consumed step are set together. A session is minted in the same call only on the
 * enrolment-token arm: an operator who just turned a password into a working authenticator holds
 * no session yet. A session-authorised confirmation mints nothing — the second half of the
 * stolen-cookie fix: re-minting would reset the 12-hour clock from the credential being
 * presented, letting a thief keep a stolen cookie alive indefinitely by re-enrolling. Answering
 * `reenrolled` leaves the presented session's expiry where it was, so theft still runs out.
 */
async function totpConfirm(
  body: Record<string, unknown>, deps: ApiDeps, req: Request,
): Promise<{ status: number; body: unknown }> {
  const now = deps.now();
  const code = str(body.code).replace(/\s+/g, "");
  const authorized = await authorizeEnrollment(body, deps, now);
  if (!authorized) return { status: 401, body: { error: { code: "unauthorized" } } };
  const staffId = authorized.staffId;

  const ip = ipKey(req);
  // RESERVED, not read — the same fix as `signIn`'s. A pure read in front of the TOTP compare
  // makes the six-digit code sprayable as wide as the caller's connection count.
  const verdict = await throttleReserve(deps.db, ip, now);
  if (verdict.locked) {
    return { status: 429, body: { ok: false, status: "throttled", retryAfterSeconds: verdict.retryAfterSeconds } };
  }

  const [user] = await deps.db.select().from(staffUsers).where(eq(staffUsers.id, staffId)).limit(1);
  if (!user?.totpSecretEnc || user.totpKeyVersion === null) {
    return { status: 409, body: { error: { code: "no_enrollment" } } };
  }

  const totpSecret = await deps.keyProvider.decrypt(user.totpSecretEnc, user.totpKeyVersion);
  const v = verifyTotp({ secret: totpSecret, token: code, now, window: TOTP_WINDOW, afterStep: null });
  if (!v.valid) {
    await throttleFail(deps.db, ip, now);
    return { status: 401, body: { ok: false, status: "invalid" } };
  }

  await deps.db.update(staffUsers)
    .set({
      totpActivated: true, totpLastConsumedStep: BigInt(v.timeStep!),
      lastLoginAt: now, updatedAt: now,
    })
    .where(eq(staffUsers.id, staffId));
  await throttleClear(deps.db, ip);
  await throttleClear(deps.db, emailKey(user.email));

  // No new session on the session arm — see the note on this function.
  if (authorized.viaSession) {
    return { status: 200, body: { ok: true, status: "reenrolled", email: user.email } };
  }

  const { token, expiresAt } = await mintSession(deps.db, staffId, now);
  return {
    status: 200,
    body: { ok: true, status: "signed_in", token, email: user.email, expiresAt: expiresAt.toISOString() },
  };
}

/**
 * `POST /admin/staff/whoami` — is this token live, and whose is it?
 *
 * The admin deployment holds no database, so this is how its middleware and its proxy learn
 * whether the cookie in front of them is a session. It answers from `staff_sessions` every
 * time: caching "yes" anywhere would reintroduce exactly the un-revocable credential the table
 * exists to avoid.
 */
async function whoami(
  body: Record<string, unknown>, deps: ApiDeps,
): Promise<{ status: number; body: unknown }> {
  const who = await resolveStaffSession(deps.db, str(body.token) || undefined, deps.now());
  return who
    ? { status: 200, body: { ok: true, email: who.email } }
    : { status: 401, body: { ok: false } };
}

/** `POST /admin/staff/sign-out` — revoke now, not at expiry. Idempotent. */
async function signOut(
  body: Record<string, unknown>, deps: ApiDeps,
): Promise<{ status: number; body: unknown }> {
  const token = str(body.token);
  if (token) {
    await deps.db.update(staffSessions)
      .set({ revokedAt: deps.now() })
      .where(and(eq(staffSessions.tokenHash, hashToken(token)), isNull(staffSessions.revokedAt)));
  }
  return { status: 200, body: { ok: true } };
}

/**
 * All five are `public + anonymous + raw`, exactly as the six reads are, and for the same
 * reason: `ANONYMOUS_PIPELINE` resolves no customer session, so there is no `users` row whose
 * state could be confused with a staff one. The authority is the shared secret plus, inside the
 * handler, `staff_users`.
 */
const OPTIONS = { public: true, anonymous: true, raw: true } as const;
const COST = "unauthenticated" as const;

/* `relay: false` throughout: the hosted console's own surface, never forwarded by a Cloud-mode
 * install's relay. Declared per route because the field has no default. */
export const adminStaffRoutes: Route[] = [
  { method: "POST", pattern: "/admin/staff/session", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("session", signIn) },
  { method: "POST", pattern: "/admin/staff/totp/begin", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("totp/begin", totpBegin) },
  { method: "POST", pattern: "/admin/staff/totp/confirm", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("totp/confirm", totpConfirm) },
  { method: "POST", pattern: "/admin/staff/whoami", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("whoami", whoami) },
  { method: "POST", pattern: "/admin/staff/sign-out", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("sign-out", signOut) },
];
