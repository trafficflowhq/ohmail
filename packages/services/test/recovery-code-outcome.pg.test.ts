import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { generateSync } from "otplib";
import { brandDialect } from "@trafficflow/db/dialect";
import { refreshTokens, sessions } from "@trafficflow/db";
import { schema, authEvents, loginTokens, recoveryCodes } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  AuthService, makeTestAuthDeps, hashToken, type ServiceContext, type SessionUser,
} from "../src/index.js";

/**
 * ═══ A RECOVERY CODE IS SPENT BY THE SESSION IT BUYS — ON REAL POSTGRES ═══
 *
 * The burn used to auto-commit and the session to follow in a commit of its own. A person
 * signing in with their LAST code through an outage therefore lost the code AND got no
 * session: nothing left to present, ever. The fix makes the burn, the login token, the audit
 * and the session ONE transaction, so a failure anywhere leaves the code exactly as it was.
 *
 * REAL POSTGRES, not PGlite, and not by preference: the subject IS a transaction boundary, and
 * PGlite's single in-process connection cannot tell a rollback from a program that never wrote.
 * The fault is injected the way production fails — the database REFUSES the session insert (a
 * `NOT VALID` CHECK on `sessions`, which binds new rows and leaves existing ones alone), so the
 * refusal lands inside `establish` after the burn, exactly where an outage lands.
 *
 * THE MUTATION EACH CASE IS WATCHED RED BY is named in its own header. The shared one:
 * `recoveryVerify`'s `this.inTransaction(ctx, (txCtx) => this.spendRecoveryCode(txCtx, …))`
 * collapsed to `this.spendRecoveryCode(ctx, …)` — the two-commit shape this file exists for.
 */

const PG_UP = await realPgAvailable();
const START = new Date("2026-07-27T00:00:00.000Z");

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let svc: AuthService;

const ctxFor = (over: Partial<ServiceContext> = {}): ServiceContext => ({
  db, accountId: "", userId: null, now: () => START, requestId: "recovery-outcome-pg",
  ip: `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  ...over,
});

/** A step-up'd full session for `user`, seeded directly — the "already signed in" caller. */
async function steppedUpCtx(user: SessionUser): Promise<ServiceContext> {
  const [row] = await db.insert(sessions).values({
    accountId: user.accountId, userId: user.userId, familyId: randomUUID(), scope: "full",
    accessExpiresAt: new Date(START.getTime() + 60 * 60_000),
    refreshExpiresAt: new Date(START.getTime() + 120 * 60_000),
    lastTwofaAt: START, lastSeenAt: START,
  }).returning();
  return ctxFor({ userId: user.userId, accountId: user.accountId, sessionId: row!.id });
}

/**
 * A registered user with TOTP enrolled and a fresh sheet of ten codes, `leave` of them unused.
 *
 * `leave: 1` is the LAST-CODE fixture — the subject that HAS the property under test. The other
 * nine are stamped used directly, which is precisely the state of somebody who has worked
 * through their sheet; the one that remains is the only thing standing between them and a
 * locked account.
 */
async function personWithCodes(leave: number): Promise<{
  user: SessionUser; codes: string[]; password: string; email: string;
}> {
  const email = `rec-${randomUUID()}@lichtgrat.example`;
  const password = "account-signin-password";
  // Narrowed on `status`, not asserted away: both results are unions, and a fixture that got the
  // other arm has not built the person this file is about — say so rather than read `undefined`.
  const reg = await svc.register(ctxFor(), {
    email, password, displayName: "Gil", inviteCode: "INVITE-OK",
  });
  if (reg.status !== "enrollment") throw new Error("an invite-gated register must mint an enrollment session");
  const user = reg.user;
  const sctx = await steppedUpCtx(user);
  const { secret } = await svc.totpEnroll(sctx);
  await svc.totpActivate(sctx, {
    code: generateSync({ secret, epoch: Math.floor(START.getTime() / 1000) }),
  });
  const { codes } = await svc.generateRecoveryCodes(await steppedUpCtx(user));
  const spend = codes.slice(0, codes.length - leave);
  if (spend.length > 0) {
    await db.update(recoveryCodes).set({ usedAt: START }).where(and(
      eq(recoveryCodes.userId, user.userId),
      inArray(recoveryCodes.codeHash, spend.map((c) => hashToken(c))),
    ));
  }
  return { user, codes: codes.slice(codes.length - leave), password, email };
}

async function loginToken(email: string, password: string): Promise<string> {
  const out = await svc.login(ctxFor(), { email, password });
  if (out.status !== "twofa_required") throw new Error("a person with TOTP enrolled must be challenged");
  return out.loginToken;
}

const unusedCodes = async (userId: string): Promise<number> => (await db.select({ id: recoveryCodes.id })
  .from(recoveryCodes)
  .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))).length;

const sessionCount = async (userId: string): Promise<number> => (await db.select({ id: sessions.id })
  .from(sessions).where(eq(sessions.userId, userId))).length;

const auditEvents = async (userId: string): Promise<string[]> => (await db.select({ event: authEvents.event })
  .from(authEvents).where(eq(authEvents.userId, userId))).map((r) => r.event);

/**
 * Make the session insert FAIL, the way a database refuses one. `NOT VALID` skips the rows
 * already there (this person holds the seeded step-up session) and binds every new one, so the
 * refusal arrives inside `establish` — after the burn, which is the whole point.
 */
async function withRefusedSessionInsert<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const name = `fix0191_no_session_${userId.replace(/-/g, "")}`;
  await client.unsafe(
    `ALTER TABLE sessions ADD CONSTRAINT ${name} CHECK (user_id <> '${userId}'::uuid) NOT VALID`,
  );
  try {
    return await fn();
  } finally {
    await client.unsafe(`ALTER TABLE sessions DROP CONSTRAINT ${name}`);
  }
}

describe.skipIf(!PG_UP)("a recovery code is spent by the session it buys", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 5 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    svc = new AuthService(makeTestAuthDeps());
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  /**
   * CONTROL 1 — the lockout itself, on the LAST-code fixture (CONTROL 3's subject).
   *
   * Session creation fails after the burn. The code must come back unspent and the person must
   * be able to walk in with it once the fault clears. Collapse the transaction in
   * `recoveryVerify` to a bare `this.spendRecoveryCode(ctx, …)` and this goes red on the first
   * assertion: the code is gone and there is no session — which is a person locked out for good.
   */
  it("an outage between the burn and the session leaves the LAST code usable", async () => {
    const p = await personWithCodes(1);
    expect(await unusedCodes(p.user.userId), "the fixture has exactly one code left").toBe(1);
    const before = await sessionCount(p.user.userId);
    const token = await loginToken(p.email, p.password);

    await withRefusedSessionInsert(p.user.userId, async () => {
      await expect(svc.recoveryVerify(ctxFor(), { loginToken: token, code: p.codes[0]! }))
        .rejects.toThrow();
    });

    // THE LOAD-BEARING HALF: the credential survived the attempt that bought nothing.
    expect(await unusedCodes(p.user.userId), "the last code is still usable").toBe(1);
    expect(await sessionCount(p.user.userId), "no session was left behind").toBe(before);
    expect(await auditEvents(p.user.userId), "nothing claims the code was used")
      .not.toContain("recovery_used");
    const [lt] = await db.select({ consumedAt: loginTokens.consumedAt })
      .from(loginTokens).where(eq(loginTokens.tokenHash, hashToken(token)));
    expect(lt!.consumedAt, "the login token rolled back with it, so the retry below works").toBeNull();

    // …and the person gets in, with the same code and the same login token.
    const est = await svc.recoveryVerify(ctxFor(), { loginToken: token, code: p.codes[0]! });
    expect(est.status).toBe("authenticated");
    expect(est.remainingCodes).toBe(0);
    expect(await sessionCount(p.user.userId), "one session, the one the code bought").toBe(before + 1);
  }, 60_000);

  /**
   * CONTROL 2 — the positive control, and the reason consumption exists at all. Delete the
   * `isNull(recoveryCodes.usedAt)` predicate from the burn in `spendRecoveryCode` and the replay
   * arm goes red: the same code mints a second session.
   */
  it("an ordinary recovery consumes exactly once, and a replay mints no second session", async () => {
    const p = await personWithCodes(10);
    const before = await sessionCount(p.user.userId);

    const est = await svc.recoveryVerify(
      ctxFor(), { loginToken: await loginToken(p.email, p.password), code: p.codes[0]! });
    expect(est.status).toBe("authenticated");
    expect(est.remainingCodes).toBe(9);
    const after = await sessionCount(p.user.userId);
    expect(after).toBe(before + 1);

    await expect(svc.recoveryVerify(
      ctxFor(), { loginToken: await loginToken(p.email, p.password), code: p.codes[0]! }))
      .rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });
    expect(await sessionCount(p.user.userId), "the replay bought nothing").toBe(after);
    expect(await unusedCodes(p.user.userId), "and spent nothing either").toBe(9);
  }, 60_000);

  /**
   * CONTROL 3 — the LAST-code fixture on its own, so case 1's subject is proved ordinary when
   * nothing fails. Nine used, one left, and that one signs the person in and says so.
   */
  it("the last code still signs a person in, and reports nothing left", async () => {
    const p = await personWithCodes(1);
    expect(await unusedCodes(p.user.userId)).toBe(1);
    const est = await svc.recoveryVerify(
      ctxFor(), { loginToken: await loginToken(p.email, p.password), code: p.codes[0]! });
    expect(est.status).toBe("authenticated");
    expect(est.remainingCodes).toBe(0);
    expect(await unusedCodes(p.user.userId)).toBe(0);
    expect(await auditEvents(p.user.userId)).toContain("recovery_used");
  }, 60_000);

  /**
   * CONTROL 4 — a wrong code is still a counted 2FA failure, unchanged by the move. Delete the
   * `await this.twofaFail(db, user, ctx)` from `recoveryVerify`'s `if (!row)` arm and the
   * `2fa_failed` assertion goes red: guessing would then be free. The sheet is untouched either
   * way, because a wrong code never reaches the burn.
   */
  it("a wrong code counts a 2FA failure, and the sheet is untouched", async () => {
    const p = await personWithCodes(10);
    const before = await sessionCount(p.user.userId);

    await expect(svc.recoveryVerify(
      ctxFor(), { loginToken: await loginToken(p.email, p.password), code: "9999-9999-9999" }))
      .rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });

    expect(await auditEvents(p.user.userId), "the failure was counted").toContain("2fa_failed");
    expect(await unusedCodes(p.user.userId), "and cost the person no code").toBe(10);
    expect(await sessionCount(p.user.userId)).toBe(before);
  }, 60_000);

  /**
   * The race's loser keeps their code, and is still counted. Two presentations of one code: the
   * second reaches the burn, the `used_at IS NULL` predicate refuses it, and the whole spend
   * unwinds. Two mutations, two reds: delete that predicate and both presentations win; move the
   * `twofaFail` out of `recoveryVerify`'s catch arm into `spendRecoveryCode` and the counted
   * failure rolls back with the spend, which is the reason the catch arm is outside.
   */
  it("two presentations of one code: one session, one spend, and the loser is told", async () => {
    const p = await personWithCodes(2);
    const before = await sessionCount(p.user.userId);
    const t1 = await loginToken(p.email, p.password);
    const t2 = await loginToken(p.email, p.password);

    const settled = await Promise.allSettled([
      svc.recoveryVerify(ctxFor(), { loginToken: t1, code: p.codes[0]! }),
      svc.recoveryVerify(ctxFor(), { loginToken: t2, code: p.codes[0]! }),
    ]);
    const won = settled.filter((s) => s.status === "fulfilled");
    expect(won, "exactly one presentation may win").toHaveLength(1);
    expect(await sessionCount(p.user.userId)).toBe(before + 1);
    expect(await unusedCodes(p.user.userId), "one spend, and the second code untouched").toBe(1);
    expect(await auditEvents(p.user.userId), "the loser's refusal was counted, not rolled back")
      .toContain("2fa_failed");
  }, 60_000);
});
