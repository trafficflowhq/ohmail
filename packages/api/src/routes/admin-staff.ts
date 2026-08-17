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
 * `POST /admin/staff/*` — THE LOGIN WALL BEHIND THE LOGIN WALL.
 *
 * The console has two credentials in series and they answer different questions.
 *
 *   1. `ADMIN_GATE_SECRET` — the URL knock in the console's middleware. It hides that the
 *      console EXISTS. It has no identity, so it can say who is allowed to look at the door
 *      and nothing at all about who walked through it. It stays.
 *   2. This — email, password, TOTP. It says WHO. It is what makes an audit row a fact about a
 *      person rather than a fact about a secret that several people and two hosting dashboards
 *      hold.
 *
 * The gate does not become redundant when this ships and must not be removed: a bare 404 for
 * anyone without the knock is what keeps the console un-probeable, and a login FORM is an
 * advertisement that there is something here worth logging in to.
 *
 * ══ WHY THIS IS NOT `AuthService` ══════════════════════════════════════════════════════════
 *
 * `AuthService` establishes CUSTOMER sessions against `users`. Pointing it at `staff_users`
 * would couple the two identities in the one place they must never be coupled — a session that
 * can read mail and a session that can suspend an account have to come from different tables,
 * verified by different code, or one bug is both. So this file re-uses the PRIMITIVES
 * (`scryptHasher`, the TOTP module, `generateToken`/`hashToken`, the `auth_throttle` table) and
 * none of the service. Every one of those primitives is imported, never re-implemented.
 *
 * ══ WHY IT RUNS ON `deps.db` AND WHAT THAT DOES NOT MEAN ═══════════════════════════════════
 *
 * The six admin READS run on `deps.adminDb` — the attested content-blind handle. This file
 * runs on the RUNTIME connection, because the blind role is read-only by construction and
 * holds nothing on `staff_users` (it is not on `STAFF_SELECT_GRANTS`, and the harden script
 * blanket-revokes what it does not grant). That is the design, not a workaround: **the role
 * that serves the console cannot read the credentials that protect it.**
 *
 * It also means this surface widens no grant and changes no attestation. Nothing here selects a
 * message, a subject, an address or a body — the only tables named in this file are
 * `staff_users`, `staff_sessions` and `auth_throttle`.
 *
 * ══ WHAT A FAILED SIGN-IN IS ALLOWED TO REVEAL: THE FACT, NEVER THE FACTOR ═════════════════
 *
 * Wrong email, wrong password and wrong TOTP code all answer 401 `invalid`. There is one
 * operator, so enumeration is close to meaningless here — but "which factor failed" is not an
 * enumeration question, it is a targeting question: it tells somebody holding a leaked password
 * that the password is good and only the second factor stands in the way, which is exactly the
 * moment to go after the phone instead. It costs nothing to not say.
 *
 * The unknown-email path still runs a full scrypt verify against a decoy hash. Without it the
 * response time answers the question the message refuses to.
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
 * COUNT ONE ATTEMPT AND DECIDE, in one statement — the admission gate.
 *
 * This replaces a `throttleCheck` that was a plain SELECT run BEFORE the scrypt and the TOTP
 * compare, with the increment landing only afterwards. That is a check-then-act pair, and making
 * one half atomic (which `throttleFail` already was, and says so) does not repair it: a hundred
 * simultaneous requests all read "unlocked", all spend a scrypt, and the five-guess window
 * becomes a hundred-guess one — plus a scrypt storm on the runtime connection the console shares
 * with mail operations. `AuthService.throttleReserve` is the same fix for the customer login and
 * carries the long-form argument.
 *
 * The arms, in order: a LIVE lock refuses without counting (counting would let an attacker slide
 * `locked_until` forward for ever and hold the operator out); a SERVED lock and a rolled window
 * both restart at 1; otherwise increment. The lock is installed here only by the attempt that
 * EXCEEDS the policy — reaching exactly `THROTTLE_MAX_FAILURES` is admitted, and the lock for
 * that is installed by {@link throttleFail} once the attempt has actually failed. That split is
 * what stops a CORRECT credential on the last permitted attempt from locking the account.
 *
 * ISO strings in every raw fragment; see {@link throttleFail} for what a `Date` costs here.
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
  // ── ISO STRINGS IN THE RAW FRAGMENTS, NEVER `Date`s ──────────────────────────────────────
  //
  // This cost a production incident on the day it shipped, in the exact shape the repo already
  // had written down twice (`ip-throttle.ts:40-43`, `auth-service.ts:throttleFailure`).
  // postgres-js serializes a raw-template parameter against the type Postgres describes for
  // `$n` in `$n::timestamptz` — TEXT — and hands a `Date` straight to `Buffer.byteLength`,
  // which throws. Every failed sign-in therefore answered 503 `admin_staff_failed` instead of
  // 401 `invalid`: the refusal was correct and the response was a server error, so the console
  // reported an outage for a wrong password.
  //
  // It was GREEN on PGlite through all 18 tests and only appeared against the live database.
  // The fix is the builder plus ISO strings, which is what `reserveIpSlot` already does.
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
 * The token that stands between "your password is right" and "your authenticator is set up".
 *
 * The obvious implementation is a short-lived `staff_sessions` row with a flag that keeps it
 * out of the authorised set. That was rejected: it puts a not-quite-session in the table every
 * authorised path queries, and it survives exactly as long as every one of those paths
 * remembers to filter on the flag.
 *
 * So an enrolment token is NOT a session and has no row at all. It is an HMAC over the staff id
 * and
 * an expiry, signed with the deployment's admin secret, and it authorises exactly two routes.
 * Nothing that reads `staff_sessions` can therefore be tricked into treating one as a login,
 * because there is no row for it to find — which is a stronger guarantee than a flag column
 * somebody has to remember to filter on.
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
 * Resolve a presented session token to the person it names, or null.
 *
 * `expires_at` is checked HERE, in the query, against the request's clock — never against the
 * cookie's `Max-Age`, which is an attribute the client controls and can strip. `revoked_at`
 * likewise: a sign-out has to take effect on the next request, not at the next expiry.
 *
 * Exported because the write routes are required to call it, and requiring them to
 * call THIS one is what keeps "the URL-key cookie alone authorises no write" a property of one
 * function rather than of five handlers' discipline.
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

  // ADVANCE THE STEP CONDITIONALLY — the compare-and-swap that makes single-use-per-timestep
  // survive CONCURRENCY. `verifyTotp` was handed `afterStep` from a row this call READ;
  // an unconditional write means two submissions of the same six digits inside one 30-second
  // window both read the old step, both verify, and both sign in.
  //
  // ── WHAT IS AND IS NOT COVERED, MEASURED ─────────────────────────────────────────────────
  // The SEQUENTIAL replay is stopped upstream, by `afterStep` inside `verifyTotp`, and
  // `test/admin-staff.test.ts` proves that: setting `afterStep: null` turns the second
  // submission of one code green ("expected 200 to be 401").
  //
  // This `where` clause is the CONCURRENT case. Removing it — replacing the predicate with
  // `eq(staffUsers.id, user.id)` — leaves every sequential test passing, because two truly
  // interleaved sign-ins are not something the one-connection PGlite suite can produce.
  // Concurrency claims need a real-Postgres test, and `test/admin-staff-concurrency.pg.test.ts`
  // is that test: two physical connections, a barrier that holds both requests until each has
  // done its READ, then release — one sign-in wins, the other is refused, same six digits.
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
 * WHO IS ASKING TO CHANGE THE AUTHENTICATOR, AND WHAT DID THEY HAVE TO PROVE?
 *
 * Both enrolment routes accept EITHER a live enrolment token (minted from a correct password
 * seconds earlier, and reachable only from `signIn`) or a live staff session. Only the second arm
 * needs anything more, and it needed something: a session ALONE authorised replacing the
 * authenticator, so a thief holding a stolen cookie could
 *
 *   1. call `totp/begin` and be HANDED a fresh TOTP secret in the response body,
 *   2. call `totp/confirm` with a code they can now generate,
 *   3. receive a brand-new session with a full 12-hour life, and
 *   4. repeat step 3 before every expiry, for ever —
 *
 * turning one stolen cookie into permanent staff access and locking the real operator out of
 * their own authenticator on the way. The 12-hour TTL exists because a stolen laptop is the named
 * threat; a route that re-mints it from the stolen credential itself gives that TTL away.
 *
 * So the session arm now costs a PASSWORD, verified here with the same scrypt and the same decoy
 * timing as `signIn`. That keeps the recovery this arm exists for — a lost phone is still not a
 * lost console — while making the cookie insufficient on its own. It also keeps the console
 * working unchanged: the console's sign-in screen only ever uses the ENROLMENT-TOKEN arm, so
 * nothing shipped calls this with a session today.
 *
 * `viaSession` travels back to the caller because it decides one more thing — see
 * {@link totpConfirm} on why a session-authorised confirmation must not mint a new session.
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
 * `POST /admin/staff/totp/begin` — show the secret, once.
 *
 * Authorised by EITHER a live enrolment token (first sign-in) or a live staff session PLUS the
 * password (re-enrolment). The second arm is the whole reason this route takes a session at all:
 * the product's own Security page shipped enrol-once-with-no-way-back and had to be fixed, and
 * repeating that here would mean a lost phone is a lost console with no recovery but SQL. See
 * {@link authorizeEnrollment} for why the password is not optional on it.
 *
 * Beginning an enrolment REPLACES any pending secret and always leaves `totp_activated` alone.
 * An abandoned enrolment therefore cannot lock anybody out: the previously activated secret
 * keeps working until a code from the NEW one is confirmed.
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
 * `POST /admin/staff/totp/confirm` — a code from the new secret, then it counts.
 *
 * Activation and the first consumed step are set together. A session is minted in the same call
 * ONLY on the enrolment-token arm: an operator who has just turned a password into a working
 * authenticator should not have to immediately prove both again, and they hold no session yet.
 *
 * A SESSION-authorised confirmation mints nothing, and that is the second half of the stolen-
 * cookie fix. The caller already has a session; re-minting one would reset its 12-hour clock from
 * the credential being presented, so a thief could keep a stolen cookie alive indefinitely by
 * re-enrolling before each expiry. Answering `reenrolled` leaves the presented session's own
 * expiry exactly where it was, so theft still runs out.
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

export const adminStaffRoutes: Route[] = [
  { method: "POST", pattern: "/admin/staff/session", cost: COST, options: OPTIONS, handler: staffRoute("session", signIn) },
  { method: "POST", pattern: "/admin/staff/totp/begin", cost: COST, options: OPTIONS, handler: staffRoute("totp/begin", totpBegin) },
  { method: "POST", pattern: "/admin/staff/totp/confirm", cost: COST, options: OPTIONS, handler: staffRoute("totp/confirm", totpConfirm) },
  { method: "POST", pattern: "/admin/staff/whoami", cost: COST, options: OPTIONS, handler: staffRoute("whoami", whoami) },
  { method: "POST", pattern: "/admin/staff/sign-out", cost: COST, options: OPTIONS, handler: staffRoute("sign-out", signOut) },
];
