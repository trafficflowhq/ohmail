import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, desc } from "drizzle-orm";
import { generateSync } from "otplib";
import { refreshTokens, sessions } from "@trafficflow/db";
import { authEvents, schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  AuthService, makeTestAuthDeps,
  type ServiceContext,
} from "@trafficflow/services";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE REUSE SWEEP'S TRANSACTION, ON REAL POSTGRES
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * PGlite green means nothing for transactional code — the repo's own standing rule, and this
 * slice's change is EXACTLY transactional: the reuse branch of `rotateRefresh` now commits the
 * family sweep and its `auth_events` record in one transaction, with a redo-the-sweep-alone
 * fallback when that transaction cannot commit (both directions of the failure trade are argued
 * at the branch). Two properties have to hold against real Postgres locking and rollback, not
 * PGlite's approximation of them:
 *
 *   1. THE ORDINARY PATH IS ATOMIC — a replayed token past the grace window leaves the family
 *      revoked AND exactly one record, committed together.
 *   2. A BOOKKEEPING FAULT NEVER VETOES THE SWEEP — an audit sink that throws inside the
 *      transaction still ends with every token and session of the family revoked (the fallback
 *      redoes the sweep on the autocommitting handle), no half-written record, and the caller
 *      still gets the ordinary reuse 401. This is what a second review found: on the
 *      cookie surface the HTTP handler clears the jar on error, so "the client will re-present
 *      and retry" is false precisely where most refreshes happen — the sweep must stand alone.
 *
 * `describe.skipIf(!PG_UP)` + `PG_TEST_URL` are the repo's `*.pg.test.ts` contract;
 * `TF_REQUIRE_PG=1` turns the skip into a hard failure in CI.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({
  db, accountId: "", userId: null, now: () => new Date(),
  requestId: "reuse-sweep-pg", ip: "10.9.9.10", ...over,
});

/** Register, enrol TOTP, complete a 2FA login, and return the user id + first refresh token. */
async function establish(svc: AuthService, email: string): Promise<{ userId: string; r1: string }> {
  let t = new Date();
  const at = (over: Partial<ServiceContext> = {}): ServiceContext => ctx({ now: () => t, ...over });
  const totp = (secret: string): string => generateSync({ secret, epoch: Math.floor(t.getTime() / 1000) });

  const { user } = await svc.register(at(), {
    email, password: "pw-correct-horse-password-password", displayName: "Gil", inviteCode: "INVITE-OK",
  });
  const latestSession = async (): Promise<string> =>
    (await db.select({ id: sessions.id }).from(sessions)
      .where(eq(sessions.userId, user.userId)).orderBy(desc(sessions.createdAt)).limit(1))[0]!.id;

  const enrollCtx = at({ userId: user.userId, accountId: user.accountId, sessionId: await latestSession() });
  const { secret } = await svc.totpEnroll(enrollCtx);
  await svc.totpActivate(enrollCtx, { code: totp(secret) });

  t = new Date(t.getTime() + 30_000);
  const ch = await svc.login(at(), { email, password: "pw-correct-horse-password-password" });
  if (ch.status !== "twofa_required") throw new Error(`expected a 2FA challenge, got ${ch.status}`);
  const est = await svc.totpVerify(at(), { loginToken: ch.loginToken, code: totp(secret) });
  return { userId: user.userId, r1: est.tokens!.refreshToken };
}

/** A clock far enough past the grace window that a re-presentation is the theft case. */
const pastGrace = (): ServiceContext =>
  ctx({ now: () => new Date(Date.now() + makeTestAuthDeps().config.refreshReuseGraceMs + 60_000) });

describe.skipIf(!PG_UP)("the reuse sweep's transaction on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 5 });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("the ordinary sweep commits revocation and record TOGETHER — one row, family dead", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const email = `reuse-atomic-${randomUUID()}@lichtgrat.example`;
    const { userId, r1 } = await establish(svc, email);
    const rot = await svc.refresh(ctx(), { refreshToken: r1 }, { concurrentGrace: true });
    // Spend the rotated token: a USED tail is what makes the late replay below the theft case
    // rather than the lost-response shape the recovery path re-admits.
    await svc.refresh(ctx(), { refreshToken: rot.tokens!.refreshToken }, { concurrentGrace: true });
    // THE SWEPT FAMILY is the one r1 rotates in. The user holds a SECOND live family this test
    // must not sweep up in its assertions: the first-factor exchange at enrolment mints its own
    // full session + refresh row, and the sweep — correctly — does not touch it.
    const r2Hash = (await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId)))
      .find((row) => row.consumedAt !== null)!;
    const familyId = r2Hash.familyId;

    await expect(svc.refresh(pastGrace(), { refreshToken: r1 }, { concurrentGrace: true }))
      .rejects.toMatchObject({ code: "refresh_revoked" });
    expect(rot.tokens).toBeTruthy();

    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.length).toBeGreaterThanOrEqual(2);
    expect(fam.every((row) => row.revokedAt !== null), "the presented token's family is swept").toBe(true);
    const rows = await db.select().from(authEvents)
      .where(eq(authEvents.userId, userId));
    const reuse = rows.filter((r) => r.event === "refresh_reuse_revoked");
    expect(reuse, "exactly one record, committed with the sweep").toHaveLength(1);
    expect(reuse[0]!.device).toContain(`family=${familyId}`);
    expect(reuse[0]!.device, "the depth, read through postgres-js").toMatch(/ depth=2 tail_age_s=\d+$/);
  });

  it("an audit sink that dies inside the transaction does NOT save the family", async () => {
    class AuditFailsOnReuse extends AuthService {
      protected override async audit(
        ...args: Parameters<AuthService["audit"]>
      ): Promise<void> {
        if (args[2] === "refresh_reuse_revoked") throw new Error("audit sink down");
        return super.audit(...args);
      }
    }
    const svc = new AuditFailsOnReuse(makeTestAuthDeps());
    const email = `reuse-fallback-${randomUUID()}@lichtgrat.example`;
    const { userId, r1 } = await establish(svc, email);
    const rot = await svc.refresh(ctx(), { refreshToken: r1 }, { concurrentGrace: true });
    // A USED tail — the theft reading; a dormant one would take the recovery path instead.
    await svc.refresh(ctx(), { refreshToken: rot.tokens!.refreshToken }, { concurrentGrace: true });
    const familyId = (await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId)))
      .find((row) => row.consumedAt !== null)!.familyId;

    // The transaction aborts on the audit write; the fallback redoes the sweep alone, on real
    // Postgres rollback semantics — the caller still sees the ordinary reuse 401.
    await expect(svc.refresh(pastGrace(), { refreshToken: r1 }, { concurrentGrace: true }))
      .rejects.toMatchObject({ code: "refresh_revoked" });

    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.every((row) => row.revokedAt !== null),
      "a bookkeeping fault must never leave a compromised family alive").toBe(true);
    const sess = await db.select().from(sessions).where(eq(sessions.familyId, familyId));
    expect(sess.every((s) => s.revokedAt !== null),
      "the family's sessions die with their tokens").toBe(true);
    // The record is the documented cost — LOST, not half-written: the aborted transaction's
    // insert must not have survived in any form.
    const rows = await db.select().from(authEvents).where(eq(authEvents.userId, userId));
    expect(rows.filter((r) => r.event === "refresh_reuse_revoked")).toHaveLength(0);
  });
});
