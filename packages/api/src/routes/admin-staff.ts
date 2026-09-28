import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  staffSessions, staffUsers, staffAuditLog, staffRoleGrants, authThrottle, STAFF_ROLES,
} from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import {
  scryptHasher, generateToken, hashToken, throttleKeysFor,
  newTotpSecret, totpUri, verifyTotp, isUuid, AUDIT_PATH_RE,
  STAFF_STEP_UP_WINDOW_SECONDS,
  type StaffAssertionAnswer, type StaffAuditAction, type StaffRole,
} from "@trafficflow/services";
import { presentsSecret, secretRouteJson as json } from "../secret-auth.js";
import {
  queryHmacOf, recordStaffEvents, adoptRequestId, rolesAdmit, StaffAuditWriteError,
  type StaffActor, type StaffEventInput,
} from "../staff-audit.js";
import {
  mintStaffAssertion, newJti, requestDigest, STAFF_ASSERTION_ISSUER,
  STAFF_ASSERTION_MAX_REQUESTS, STAFF_ASSERTION_READ_TTL_SECONDS, STAFF_ASSERTION_WRITE_TTL_SECONDS,
  type StaffAssertionClaims, type StaffAssertionTier,
} from "../staff-assertion.js";
import { clientIp } from "../context.js";
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
/**
 * How long a BEGUN enrolment stays confirmable (cloud 0036). Long enough to photograph a QR and
 * type six digits; short enough that a pending secret from last month is not a credential this
 * deployment still offers to promote.
 */
const PENDING_ENROLLMENT_TTL_SECONDS = 15 * 60;

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
 * The caller, as a keyed hash of the TRUSTED client IP (`clientIp`: the platform's own header or
 * the last forwarded hop). The first `x-forwarded-for` hop is whatever the caller wrote, so keying
 * on it minted a fresh bucket per request; `x-real-ip` is an ordinary header here.
 */
function ipKey(req: Request, deps: ApiDeps): string {
  return `staff:ip:${throttleKeysFor(deps.keyProvider).client(clientIp(req))}`;
}

/** The typed address, as a keyed hash — never stored as typed (`throttle-keys.ts`). */
const emailKey = (email: string, deps: ApiDeps): string =>
  `staff:email:${throttleKeysFor(deps.keyProvider).address(email)}`;

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
  db: Tx, staffId: string, now: Date,
): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  const token = generateToken(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  const sessionId = randomUUID();
  // `lastTwofaAt: now` and not a default: every path that reaches here has just verified a TOTP
  // code, so the stamp is a fact this call knows rather than one the column guesses.
  await db.insert(staffSessions).values({
    id: sessionId, staffUserId: staffId, tokenHash: hashToken(token), expiresAt, createdAt: now, lastTwofaAt: now,
  });
  return { token, expiresAt, sessionId };
}

/**
 * Mint a session and record the sign-in in ONE transaction: a sign-in the audit cannot record
 * hands out no token.
 */
async function mintAuditedSession(
  deps: ApiDeps, user: { id: string; email: string }, now: Date, requestId: string,
): Promise<{ token: string; expiresAt: Date }> {
  return (deps.db as unknown as Tx).transaction(async (tx) => {
    const minted = await mintSession(tx, user.id, now);
    const roles = await liveRolesOf(tx, user.id);
    await recordStaffEvents(tx, [{
      requestId, at: now, action: "staff.signin", outcome: "ok",
      actor: { staffId: user.id, sessionId: minted.sessionId, email: user.email, roles },
    }]);
    return { token: minted.token, expiresAt: minted.expiresAt };
  });
}

export interface StaffIdentity {
  staffId: string;
  /** The `staff_sessions` row this request presented. */
  sessionId: string;
  email: string;
  /** When this session's holder last proved a second factor — `staff_sessions.last_twofa_at`. */
  lastTwofaAt: Date;
  /** Read from `staff_role_grants` on every resolution (`revoked_at IS NULL`), never cached. */
  roles: StaffRole[];
}

/** The live roles of one staff member, in `STAFF_ROLES` order. A revocation counts at once. */
export async function liveRolesOf(db: Pick<Tx, "select">, staffId: string): Promise<StaffRole[]> {
  const rows = await db.select({ role: staffRoleGrants.role }).from(staffRoleGrants)
    .where(and(eq(staffRoleGrants.staffUserId, staffId), isNull(staffRoleGrants.revokedAt)));
  const held = new Set(rows.map((r) => r.role));
  return STAFF_ROLES.filter((r) => held.has(r));
}

/** The staff member a resolved session names, as the audit records them. */
export const actorOf = (who: StaffIdentity): StaffActor =>
  ({ staffId: who.staffId, sessionId: who.sessionId, email: who.email, roles: who.roles });

/**
 * THE ONE READ of a staff write's session token. `withStaffStepUp` judges the token it finds at
 * `body.sessionToken`; a handler reading the token anywhere else (a header, another field) would
 * still demand a live session while silently skipping the step-up recency check. So the spelling
 * lives here alone, the middleware and every step-up-carrying handler call this, and the census
 * (`staff-token-one-door-census.test.ts`) refuses a second read or a header-fed resolution.
 */
export function staffTokenOf(body: Record<string, unknown>): string | undefined {
  const t = body.sessionToken;
  return typeof t === "string" && t ? t : undefined;
}

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
  // The live roles ride the same statement: one read per request, never a cached grant.
  const [row] = await db
    .select({
      id: staffUsers.id, email: staffUsers.email, sessionId: staffSessions.id,
      expiresAt: staffSessions.expiresAt, lastTwofaAt: staffSessions.lastTwofaAt,
      roles: sql<string[] | null>`array(select ${staffRoleGrants.role} from ${staffRoleGrants}
        where ${staffRoleGrants.staffUserId} = ${staffUsers.id} and ${staffRoleGrants.revokedAt} is null)`,
    })
    .from(staffSessions)
    .innerJoin(staffUsers, eq(staffUsers.id, staffSessions.staffUserId))
    .where(and(eq(staffSessions.tokenHash, hashToken(token)), isNull(staffSessions.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  const held = new Set(row.roles ?? []);
  const roles = STAFF_ROLES.filter((r) => held.has(r));
  return { staffId: row.id, sessionId: row.sessionId, email: row.email, lastTwofaAt: row.lastTwofaAt, roles };
}

/**
 * Consume one TOTP code for a staff member: verified against the active secret, single-use per
 * timestep by the compare-and-swap on `totp_last_consumed_step` (two presentations of one code
 * cannot both win). The caller throttles and answers; this only says what happened.
 */
async function consumeStaffTotp(
  deps: ApiDeps, staffId: string, code: string, now: Date,
): Promise<"ok" | "invalid" | "no_enrollment"> {
  const [user] = await deps.db.select().from(staffUsers).where(eq(staffUsers.id, staffId)).limit(1);
  if (!user?.totpActivated || !user.totpSecretEnc || user.totpKeyVersion === null) return "no_enrollment";
  const totpSecret = await deps.keyProvider.decrypt(user.totpSecretEnc, user.totpKeyVersion);
  const v = verifyTotp({
    secret: totpSecret, token: code, now, window: TOTP_WINDOW,
    afterStep: user.totpLastConsumedStep === null ? null : Number(user.totpLastConsumedStep),
  });
  if (!v.valid) return "invalid";
  const advanced = await deps.db.update(staffUsers)
    .set({ totpLastConsumedStep: BigInt(v.timeStep!), updatedAt: now })
    .where(and(
      eq(staffUsers.id, user.id),
      user.totpLastConsumedStep === null
        ? isNull(staffUsers.totpLastConsumedStep)
        : eq(staffUsers.totpLastConsumedStep, user.totpLastConsumedStep),
    ))
    .returning();
  return advanced.length === 0 ? "invalid" : "ok";
}

/**
 * The sign-out's record, and nothing else's: a sign-out removes access, and removing access never
 * waits on its row. Every other staff act, a refusal included, answers only once its row is
 * written; a failed write throws {@link StaffAuditWriteError} and the wrapper answers
 * `503 audit_failed`.
 */
async function recordSignOut(deps: ApiDeps, event: StaffEventInput): Promise<void> {
  try {
    await recordStaffEvents(deps.db, [event]);
  } catch (err) {
    deps.logger?.child({ route: "/admin/staff" }).error("staff_audit_failed", { err, action: event.action });
  }
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
      if (err instanceof StaffAuditWriteError) {
        log?.error("admin_audit_failed", { err: err.cause });
        return json(503, { error: { code: "audit_failed" } });
      }
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
  const keys = [emailKey(email, deps), ipKey(req, deps)];
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

  const requestId = adoptRequestId(req, deps);
  // A failure is recorded against a staff member only when the address names one: the row's
  // `staff_user_id` is a key, and an unknown address is nobody to record.
  const failed = async (step: "password" | "totp"): Promise<void> => {
    if (!user) return;
    await recordStaffEvents(deps.db, [{
      requestId, at: now, action: "staff.signin_failed", outcome: "refused", refusalCode: "invalid",
      actor: { staffId: user.id, sessionId: null, email: user.email, roles: await liveRolesOf(deps.db as unknown as Tx, user.id) },
      detail: { step },
    }]);
  };

  if (!user || !passwordOk) {
    for (const key of keys) await throttleFail(deps.db, key, now);
    await failed("password");
    return { status: 401, body: { ok: false, status: "invalid" } };
  }
  // The customer door's rule (`AuthService.rehashIfStale`): a verified password under an older
  // cost is written again, a compare-and-set on the old hash, best-effort.
  if (scryptHasher.needsRehash?.(user.passwordHash)) {
    try {
      await deps.db.update(staffUsers).set({ passwordHash: await scryptHasher.hash(password) })
        .where(and(eq(staffUsers.id, user.id), eq(staffUsers.passwordHash, user.passwordHash)));
    } catch {
      /* the stored hash still verifies; the next sign-in rehashes */
    }
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
    await failed("totp");
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
    await failed("totp");
    return { status: 401, body: { ok: false, status: "invalid" } };
  }

  for (const key of keys) await throttleClear(deps.db, key);
  const { token, expiresAt } = await mintAuditedSession(deps, user, now, requestId);
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

  const session = await resolveStaffSession(deps.db, staffTokenOf(body), now);
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
 * `POST /admin/staff/totp/begin` — show the secret, once. Authorised by a live enrolment token
 * (first sign-in) or a live staff session plus the password (re-enrolment); see {@link
 * authorizeEnrollment} for why the password is not optional.
 *
 * IT WRITES THE PENDING PAIR AND NEVER THE LIVE ONE (cloud 0036). Writing `totp_secret_enc`
 * directly left `totp_activated` true over a secret nobody held whenever a second tab's begin
 * landed after a confirm and its response was lost. A second begin supersedes the pending pair
 * only; the authenticator in use keeps working until {@link totpConfirm} promotes a new one.
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
    .set({
      totpPendingSecretEnc: ciphertext, totpPendingKeyVersion: keyVersion,
      totpPendingStartedAt: now, updatedAt: now,
    })
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
 * `POST /admin/staff/totp/confirm` — a code from the PENDING secret, then it counts. The
 * promotion is ONE statement (pending pair, activation and first consumed step together), and its
 * `where` pins the ciphertext this call verified, so a `begin` that superseded it makes the
 * promotion a no-op (409) instead of activating a secret this operator never saw.
 *
 * A session is minted only on the enrolment-token arm, where the operator holds none. A
 * session-authorised confirmation mints nothing: that would reset the 12-hour clock from the
 * credential presented, which is how a thief keeps a stolen cookie alive by re-enrolling.
 */
async function totpConfirm(
  body: Record<string, unknown>, deps: ApiDeps, req: Request,
): Promise<{ status: number; body: unknown }> {
  const now = deps.now();
  const code = str(body.code).replace(/\s+/g, "");
  const authorized = await authorizeEnrollment(body, deps, now);
  if (!authorized) return { status: 401, body: { error: { code: "unauthorized" } } };
  const staffId = authorized.staffId;

  const ip = ipKey(req, deps);
  // RESERVED, not read — the same fix as `signIn`'s. A pure read in front of the TOTP compare
  // makes the six-digit code sprayable as wide as the caller's connection count.
  const verdict = await throttleReserve(deps.db, ip, now);
  if (verdict.locked) {
    return { status: 429, body: { ok: false, status: "throttled", retryAfterSeconds: verdict.retryAfterSeconds } };
  }

  const [user] = await deps.db.select().from(staffUsers).where(eq(staffUsers.id, staffId)).limit(1);
  const pending = user?.totpPendingSecretEnc;
  const pendingFresh = user?.totpPendingStartedAt != null
    && now.getTime() - user.totpPendingStartedAt.getTime() <= PENDING_ENROLLMENT_TTL_SECONDS * 1000;
  if (!user || !pending || user.totpPendingKeyVersion === null || !pendingFresh) {
    return { status: 409, body: { error: { code: "no_enrollment" } } };
  }

  const totpSecret = await deps.keyProvider.decrypt(pending, user.totpPendingKeyVersion);
  const v = verifyTotp({ secret: totpSecret, token: code, now, window: TOTP_WINDOW, afterStep: null });
  if (!v.valid) {
    await throttleFail(deps.db, ip, now);
    return { status: 401, body: { ok: false, status: "invalid" } };
  }

  // THE PROMOTION. One statement, and its `where` is the compare-and-swap described above.
  const promoted = await deps.db.update(staffUsers)
    .set({
      totpSecretEnc: pending, totpKeyVersion: user.totpPendingKeyVersion,
      totpPendingSecretEnc: null, totpPendingKeyVersion: null, totpPendingStartedAt: null,
      totpActivated: true, totpLastConsumedStep: BigInt(v.timeStep!),
      lastLoginAt: now, updatedAt: now,
    })
    .where(and(eq(staffUsers.id, staffId), eq(staffUsers.totpPendingSecretEnc, pending)))
    .returning();
  if (promoted.length === 0) {
    return { status: 409, body: { error: { code: "enrollment_superseded" } } };
  }
  await throttleClear(deps.db, ip);
  await throttleClear(deps.db, emailKey(user.email, deps));

  // No new session on the session arm — see the note on this function.
  if (authorized.viaSession) {
    return { status: 200, body: { ok: true, status: "reenrolled", email: user.email } };
  }

  const { token, expiresAt } = await mintAuditedSession(deps, { id: staffId, email: user.email }, now, adoptRequestId(req, deps));
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
  const now = deps.now();
  const who = await resolveStaffSession(deps.db, str(body.token) || undefined, now);
  // `stepUpWindowSeconds` travels with the identity so the console's sentences render from the
  // value the API enforces. It is a policy number and names nobody, so it is safe on a refusal
  // too — and the sign-in screen needs it before it holds a session.
  return who
    ? {
      status: 200,
      body: {
        ok: true,
        email: who.email,
        roles: who.roles,
        stepUpWindowSeconds: STAFF_STEP_UP_WINDOW_SECONDS,
        stepUpFresh: now.getTime() - who.lastTwofaAt.getTime() <= STAFF_STEP_UP_WINDOW_SECONDS * 1000,
      },
    }
    : { status: 401, body: { ok: false, stepUpWindowSeconds: STAFF_STEP_UP_WINDOW_SECONDS } };
}

/**
 * `POST /admin/staff/step-up` — prove the second factor again, without minting anything.
 *
 * A staff WRITE asks for a factor proved in the last {@link STAFF_STEP_UP_WINDOW_SECONDS}
 * seconds; this is the route that supplies one. It re-stamps `last_twofa_at` and touches nothing
 * else — no new token, `expires_at` untouched — so stepping up cannot extend a stolen cookie past
 * the twelve-hour cap. The code is single-use per timestep by the same compare-and-swap `signIn`
 * uses, the failure is throttled on the hashed IP, and nothing here can turn a session that is
 * not live into one.
 */
async function stepUp(
  body: Record<string, unknown>, deps: ApiDeps, req: Request,
): Promise<{ status: number; body: unknown }> {
  const now = deps.now();
  const token = str(body.token) || undefined;
  const code = str(body.code).replace(/\s+/g, "");
  const session = await resolveStaffSession(deps.db, token, now);
  if (!session) return { status: 401, body: { ok: false, status: "signed_out" } };

  const ip = ipKey(req, deps);
  const verdict = await throttleReserve(deps.db, ip, now);
  if (verdict.locked) {
    return { status: 429, body: { ok: false, status: "throttled", retryAfterSeconds: verdict.retryAfterSeconds } };
  }

  const requestId = adoptRequestId(req, deps);
  const consumed = await consumeStaffTotp(deps, session.staffId, code, now);
  if (consumed === "no_enrollment") {
    return { status: 409, body: { error: { code: "no_enrollment" } } };
  }
  if (consumed === "invalid") {
    await throttleFail(deps.db, ip, now);
    await recordStaffEvents(deps.db, [{
      requestId, at: now, action: "staff.stepup_failed", outcome: "refused", refusalCode: "invalid",
      actor: actorOf(session),
    }]);
    return { status: 401, body: { ok: false, status: "invalid" } };
  }

  // The fresh stamp and its record, together: a step-up the audit cannot record grants nothing.
  await (deps.db as unknown as Tx).transaction(async (tx) => {
    await tx.update(staffSessions)
      .set({ lastTwofaAt: now })
      .where(and(eq(staffSessions.tokenHash, hashToken(token!)), isNull(staffSessions.revokedAt)));
    await recordStaffEvents(tx, [{ requestId, at: now, action: "staff.stepup", outcome: "ok", actor: actorOf(session) }]);
  });
  await throttleClear(deps.db, ip);

  return {
    status: 200,
    body: {
      ok: true,
      status: "stepped_up",
      email: session.email,
      stepUpWindowSeconds: STAFF_STEP_UP_WINDOW_SECONDS,
      freshUntil: new Date(now.getTime() + STAFF_STEP_UP_WINDOW_SECONDS * 1000).toISOString(),
    },
  };
}

/** A note or an operator name shorter than this is refused — the admin writes' own floor. */
const MIN_RESET_FIELD = 8;

/**
 * `POST /admin/staff/totp/reset` — THE RECOVERY, an operator command and deliberately not a
 * console button: a "disable 2FA" control would be a second door into the staff surface.
 *
 * Somebody whose authenticator is gone and whose session has expired cannot enrol a new one, and
 * the only way back used to be a database console. Its authority is the deployment's shared admin
 * secret and it grants no access: the account returns to "not enrolled", so signing in still
 * costs the password and then a fresh enrolment. Live sessions are revoked in the same breath and
 * every run leaves a `staff_audit_log` row. The deployment's staff TOTP reset script is the
 * command.
 */
async function totpReset(
  body: Record<string, unknown>, deps: ApiDeps,
): Promise<{ status: number; body: unknown }> {
  const now = deps.now();
  const email = normalizeEmail(body.email);
  const operator = str(body.operator).trim();
  const note = str(body.note).trim();
  // A typed confirmation, because this is a destructive act run from a shell with the deployment
  // secret in the environment: a mis-fired command must not be able to clear anybody's factor.
  if (str(body.confirm).trim() !== "reset-second-factor") {
    return { status: 400, body: { error: { code: "confirm_required" } } };
  }
  if (operator.length < MIN_RESET_FIELD) return { status: 400, body: { error: { code: "operator_required" } } };
  if (note.length < MIN_RESET_FIELD) return { status: 400, body: { error: { code: "note_required" } } };
  if (!email) return { status: 400, body: { error: { code: "email_required" } } };

  const [user] = await deps.db.select().from(staffUsers).where(eq(staffUsers.email, email)).limit(1);
  // An address that matches no row is the operator's mistake, not a no-op: a 200 over a typo
  // reads as "done" and leaves the person still locked out.
  if (!user) return { status: 404, body: { error: { code: "staff_not_found" } } };

  await deps.db.update(staffUsers)
    .set({
      totpSecretEnc: null, totpKeyVersion: null,
      totpPendingSecretEnc: null, totpPendingKeyVersion: null, totpPendingStartedAt: null,
      totpActivated: false, totpLastConsumedStep: null,
      updatedAt: now,
    })
    .where(eq(staffUsers.id, user.id));
  const revoked = await deps.db.update(staffSessions)
    .set({ revokedAt: now })
    .where(and(eq(staffSessions.staffUserId, user.id), isNull(staffSessions.revokedAt)))
    .returning();
  await deps.db.insert(staffAuditLog).values({
    staffUserId: user.id, action: "staff.totp.reset", actor: operator, note, createdAt: now,
  });
  // The structured record beside the old table's note: the operator's name is the label (no
  // staff session is presented to this command), the note stays in `staff_audit_log` alone.
  await recordStaffEvents(deps.db, [{
    requestId: randomUUID(), at: now, action: "staff.totp_reset", outcome: "ok",
    actor: { staffId: user.id, sessionId: null, email: operator.slice(0, 64), roles: await liveRolesOf(deps.db as unknown as Tx, user.id) },
    detail: { sessionsRevoked: revoked.length },
  }]);

  return {
    status: 200,
    body: {
      ok: true,
      action: "staff.totp.reset",
      email: user.email,
      sessionsRevoked: revoked.length,
      at: now.toISOString(),
    },
  };
}

/** `POST /admin/staff/sign-out` — revoke now, not at expiry. Idempotent. */
async function signOut(
  body: Record<string, unknown>, deps: ApiDeps, req: Request,
): Promise<{ status: number; body: unknown }> {
  const token = str(body.token);
  if (token) {
    const now = deps.now();
    const who = await resolveStaffSession(deps.db, token, now);
    await deps.db.update(staffSessions)
      .set({ revokedAt: now })
      .where(and(eq(staffSessions.tokenHash, hashToken(token)), isNull(staffSessions.revokedAt)));
    // After the revoke, and best-effort: a sign-out must never fail for want of its record.
    if (who) {
      await recordSignOut(deps, { requestId: adoptRequestId(req, deps), at: now, action: "staff.signout", outcome: "ok", actor: actorOf(who) });
    }
  }
  return { status: 200, body: { ok: true } };
}

/* ── the staff assertion mint ─────────────────────────────────────────────────────────── */

const AUDIENCE_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const BODY_SHA_RE = /^[0-9a-f]{64}$/;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type AssertMethod = (typeof METHODS)[number];

interface AssertRequest { method: AssertMethod; path: string; pathname: string; query: string; bodySha256: string }

/** One request of the mint's list, or null. The path's query is hashed, never recorded. */
function assertRequestOf(v: unknown): AssertRequest | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const method = str(r.method).toUpperCase();
  const path = str(r.path);
  const bodySha256 = str(r.bodySha256).toLowerCase();
  if (!(METHODS as readonly string[]).includes(method) || !BODY_SHA_RE.test(bodySha256)) return null;
  if (path.length === 0 || path.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(path)) return null;
  const q = path.indexOf("?");
  const pathname = q < 0 ? path : path.slice(0, q);
  if (!AUDIT_PATH_RE.test(pathname)) return null;
  return { method: method as AssertMethod, path, pathname, query: q < 0 ? "" : path.slice(q + 1), bodySha256 };
}

/**
 * `POST /admin/staff/assertion` — signed statements for another program, one per request, bound
 * to that request's method, path and body. `scope: "write"` needs a factor proved inside the
 * step-up window (tier 1) or a TOTP consumed by this call (tier 2); a read is tier 0. One
 * `assert.external` row per request is written before any assertion is returned.
 */
async function mintAssertions(
  body: Record<string, unknown>, deps: ApiDeps, req: Request,
): Promise<{ status: number; body: unknown }> {
  const now = deps.now();
  const who = await resolveStaffSession(deps.db, staffTokenOf(body), now);
  if (!who) return { status: 401, body: { error: { code: "staff_session_required" } } };
  const key = deps.admin?.assertion ?? null;
  if (!key) return { status: 503, body: { error: { code: "assertion_unarmed" } } };

  // The console names the request id in the body: it is the id the other program's audit joins
  // on, so it wins over the header and becomes this request's id.
  const requestId = isUuid(body.requestId)
    ? (deps.requestId = body.requestId.toLowerCase())
    : adoptRequestId(req, deps);
  const audience = str(body.audience);
  const scope = str(body.scope);
  const list = Array.isArray(body.requests) ? body.requests.map(assertRequestOf) : [];
  const requests = list.filter((r): r is AssertRequest => r !== null);
  const secret = deps.admin!.secret;
  const rowsFor = (outcome: "ok" | "refused", refusalCode: string | null, tier: StaffAssertionTier): StaffEventInput[] =>
    (requests.length > 0 ? requests : [null]).map((r, index): StaffEventInput => ({
      requestId, at: now, action: "assert.external" as StaffAuditAction, outcome, refusalCode,
      actor: actorOf(who), audience: AUDIENCE_RE.test(audience) ? audience : null,
      queryHmac: r && r.query ? queryHmacOf(secret, r.query) : null,
      detail: r
        ? { method: r.method, path: r.pathname, scope: scope === "write" ? "write" : "read", tier, index }
        : undefined,
    }));
  const refuse = async (status: number, code: string): Promise<{ status: number; body: unknown }> => {
    await recordStaffEvents(deps.db, [rowsFor("refused", code, 0)[0]!]);
    return { status, body: { error: { code } } };
  };

  if (!rolesAdmit(who.roles, "any")) return refuse(403, "role_required");
  if (!AUDIENCE_RE.test(audience)) return refuse(400, "audience_invalid");
  if (scope !== "read" && scope !== "write") return refuse(400, "scope_invalid");
  if (list.length === 0 || list.length > STAFF_ASSERTION_MAX_REQUESTS || requests.length !== list.length) {
    return refuse(400, "requests_invalid");
  }
  if (scope === "read" && requests.some((r) => r.method !== "GET")) return refuse(400, "scope_mismatch");

  let tier: StaffAssertionTier = 0;
  const code = str(body.totp).replace(/\s+/g, "");
  if (code) {
    const ip = ipKey(req, deps);
    const verdict = await throttleReserve(deps.db, ip, now);
    if (verdict.locked) {
      return { status: 429, body: { ok: false, status: "throttled", retryAfterSeconds: verdict.retryAfterSeconds } };
    }
    const consumed = await consumeStaffTotp(deps, who.staffId, code, now);
    if (consumed !== "ok") {
      await throttleFail(deps.db, ip, now);
      return refuse(401, "totp_invalid");
    }
    await deps.db.update(staffSessions).set({ lastTwofaAt: now }).where(eq(staffSessions.id, who.sessionId));
    await throttleClear(deps.db, ip);
    tier = 2;
  } else if (scope === "write") {
    if (now.getTime() - who.lastTwofaAt.getTime() > STAFF_STEP_UP_WINDOW_SECONDS * 1000) {
      return refuse(403, "step_up_required");
    }
    tier = 1;
  }

  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + (scope === "write" ? STAFF_ASSERTION_WRITE_TTL_SECONDS : STAFF_ASSERTION_READ_TTL_SECONDS);
  const assertions = requests.map((r) => {
    const claims: StaffAssertionClaims = {
      v: 1, iss: STAFF_ASSERTION_ISSUER, aud: audience, sub: who.staffId, sid: who.sessionId,
      label: who.email.slice(0, 200), roles: [...who.roles], tier, rid: requestId,
      req: requestDigest(r.method, r.path, r.bodySha256), iat, exp, jti: newJti(),
    };
    return mintStaffAssertion(claims, key);
  });
  // BEFORE the answer, all rows or none: an assertion nobody recorded is never handed out.
  await recordStaffEvents(deps.db, rowsFor("ok", null, tier));
  const answer: StaffAssertionAnswer = {
    assertions, expiresAt: new Date(exp * 1000).toISOString(), kid: key.kid, tier,
  };
  return { status: 200, body: answer };
}

/* ── staff roles ──────────────────────────────────────────────────────────────────────── */

/**
 * `POST /admin/staff/roles` — an owner grants or revokes one role, with a TOTP consumed by this
 * call (tier 2). Nobody changes their own roles. Inside the transaction every live owner grant is
 * locked `FOR UPDATE` and the caller must still be among them: two owners revoking each other at
 * once serialize, the second finds it is no owner any more, and the last owner stays.
 */
async function changeRole(
  body: Record<string, unknown>, deps: ApiDeps, req: Request,
): Promise<{ status: number; body: unknown }> {
  const now = deps.now();
  const who = await resolveStaffSession(deps.db, staffTokenOf(body), now);
  if (!who) return { status: 401, body: { error: { code: "staff_session_required" } } };
  const requestId = adoptRequestId(req, deps);
  const op = str(body.op);
  const role = str(body.role) as StaffRole;
  const action: StaffAuditAction = op === "revoke" ? "staff.role_revoke" : "staff.role_grant";
  const refuse = async (status: number, code: string, target?: string): Promise<{ status: number; body: unknown }> => {
    await recordStaffEvents(deps.db, [{
      requestId, at: now, action, outcome: "refused", refusalCode: code, actor: actorOf(who),
      detail: target && (STAFF_ROLES as readonly string[]).includes(role) ? { role, targetStaffUserId: target } : {},
    }]);
    return { status, body: { error: { code } } };
  };

  if (!rolesAdmit(who.roles, ["owner"])) return refuse(403, "role_required");
  if (op !== "grant" && op !== "revoke") return refuse(400, "op_invalid");
  if (!(STAFF_ROLES as readonly string[]).includes(role)) return refuse(400, "role_invalid");
  const code = str(body.totp).replace(/\s+/g, "");
  if (!code) return refuse(401, "totp_required");
  const ip = ipKey(req, deps);
  const verdict = await throttleReserve(deps.db, ip, now);
  if (verdict.locked) {
    return { status: 429, body: { ok: false, status: "throttled", retryAfterSeconds: verdict.retryAfterSeconds } };
  }
  if (await consumeStaffTotp(deps, who.staffId, code, now) !== "ok") {
    await throttleFail(deps.db, ip, now);
    return refuse(401, "totp_invalid");
  }
  await throttleClear(deps.db, ip);
  await deps.db.update(staffSessions).set({ lastTwofaAt: now }).where(eq(staffSessions.id, who.sessionId));

  const email = normalizeEmail(body.staffEmail);
  const [target] = email
    ? await deps.db.select({ id: staffUsers.id }).from(staffUsers).where(eq(staffUsers.email, email)).limit(1)
    : [];
  if (!target) return refuse(404, "staff_not_found");
  if (target.id === who.staffId) return refuse(409, "self_change_refused", target.id);

  const outcome = await (deps.db as unknown as Tx).transaction(async (tx) => {
    const record = (o: "ok" | "no_change" | "refused", refusalCode: string | null): Promise<void> =>
      recordStaffEvents(tx, [{
        requestId, at: now, action, outcome: o, refusalCode, actor: actorOf(who),
        detail: { role, targetStaffUserId: target.id },
      }]);
    // The caller's authority, re-read under the lock every concurrent change also takes.
    const owners = await tx.select({ id: staffRoleGrants.staffUserId }).from(staffRoleGrants)
      .where(and(eq(staffRoleGrants.role, "owner"), isNull(staffRoleGrants.revokedAt)))
      .for("update");
    if (!owners.some((o) => o.id === who.staffId)) { await record("refused", "role_required"); return "role_required" as const; }
    const live = await tx.select({ grantedAt: staffRoleGrants.grantedAt }).from(staffRoleGrants)
      .where(and(eq(staffRoleGrants.staffUserId, target.id), eq(staffRoleGrants.role, role), isNull(staffRoleGrants.revokedAt)))
      .for("update");
    if (op === "grant") {
      if (live.length > 0) { await record("no_change", null); return "no_change" as const; }
      await tx.insert(staffRoleGrants).values({ staffUserId: target.id, role, grantedBy: who.staffId, grantedAt: now });
      await record("ok", null);
      return "ok" as const;
    }
    if (live.length === 0) { await record("no_change", null); return "no_change" as const; }
    await tx.update(staffRoleGrants).set({ revokedAt: now, revokedBy: who.staffId })
      .where(and(eq(staffRoleGrants.staffUserId, target.id), eq(staffRoleGrants.role, role), isNull(staffRoleGrants.revokedAt)));
    await record("ok", null);
    return "ok" as const;
  });
  if (outcome === "role_required") return { status: 403, body: { error: { code: "role_required" } } };
  return { status: 200, body: { ok: true, op, role, changed: outcome === "ok", at: now.toISOString() } };
}

/**
 * Every one is `public + anonymous + raw`, exactly as the reads are, and for the same
 * reason: `ANONYMOUS_PIPELINE` resolves no customer session, so there is no `users` row whose
 * state could be confused with a staff one. The authority is the shared secret plus, inside the
 * handler, `staff_users`.
 *
 * NONE of them carries `staffStepUp`, and that is the point: this group IS the second factor.
 * `admin-step-up-census.test.ts` classifies every `/admin/*` route as identity, read or write and
 * requires the flag on exactly the writes, so neither list can drift in silence.
 */
const OPTIONS = { public: true, anonymous: true, raw: true } as const;
const COST = "unauthenticated" as const;

/* `relay: false` throughout: the hosted console's own surface, never forwarded by a Cloud-mode
 * install's relay. Declared per route because the field has no default. */
export const adminStaffRoutes: Route[] = [
  { method: "POST", pattern: "/admin/staff/session", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("session", signIn) },
  { method: "POST", pattern: "/admin/staff/totp/begin", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("totp/begin", totpBegin) },
  { method: "POST", pattern: "/admin/staff/totp/confirm", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("totp/confirm", totpConfirm) },
  { method: "POST", pattern: "/admin/staff/step-up", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("step-up", stepUp) },
  { method: "POST", pattern: "/admin/staff/totp/reset", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("totp/reset", totpReset) },
  { method: "POST", pattern: "/admin/staff/whoami", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("whoami", whoami) },
  { method: "POST", pattern: "/admin/staff/sign-out", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("sign-out", signOut) },
  // Both verify their own factor: the mint by the session's step-up stamp or a TOTP in its body,
  // the roles change by a TOTP in its body alone. Neither carries `withStaffStepUp`.
  { method: "POST", pattern: "/admin/staff/assertion", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("assertion", mintAssertions) },
  { method: "POST", pattern: "/admin/staff/roles", relay: false, cost: COST, options: OPTIONS, handler: staffRoute("roles", changeRole) },
];
