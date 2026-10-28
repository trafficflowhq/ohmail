import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq, desc, sql } from "drizzle-orm";
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

/**
 * Register, enrol TOTP, complete a 2FA login (declaring `kind` when given), and return the user id +
 * first refresh token. `signIn` is a later browser sign-in, a time step on, answering its session's id.
 */
async function establish(svc: AuthService, email: string, kind?: string): Promise<{
  userId: string; accountId: string; r1: string; signIn: () => Promise<string>;
}> {
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
  const est = await svc.totpVerify(at(), { loginToken: ch.loginToken, code: totp(secret), ...(kind ? { kind } : {}) });
  const signIn = async (): Promise<string> => {
    t = new Date(t.getTime() + 30_000);
    const again = await svc.login(at(), { email, password: "pw-correct-horse-password-password" });
    if (again.status !== "twofa_required") throw new Error(`expected a 2FA challenge, got ${again.status}`);
    await svc.totpVerify(at(), { loginToken: again.loginToken, code: totp(secret) });
    return latestSession();
  };
  return { userId: user.userId, accountId: user.accountId, r1: est.tokens!.refreshToken, signIn };
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
    const tail = (await svc.refresh(ctx(), { refreshToken: rot.tokens!.refreshToken }, { concurrentGrace: true }))
      .tokens!.refreshToken;
    // THE SWEPT FAMILY is the one r1 rotates in. The user holds a SECOND live family this test
    // must not sweep up in its assertions: the first-factor exchange at enrolment mints its own
    // full session + refresh row, and the sweep — correctly — does not touch it.
    const r2Hash = (await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId)))
      .find((row) => row.consumedAt !== null)!;
    const familyId = r2Hash.familyId;

    // The sweep's own refusal names its cause; any later presentation, r1 or the tail, does not.
    await expect(svc.refresh(pastGrace(), { refreshToken: r1 }, { concurrentGrace: true })).rejects
      .toMatchObject({ code: "refresh_revoked", message: "refresh token reuse detected", details: { cause: "reuse" } });
    for (const later of [r1, tail]) {
      const err = await svc.refresh(pastGrace(), { refreshToken: later }, { concurrentGrace: true }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "refresh_revoked", message: "invalid refresh token" });
      expect((err as { details?: unknown }).details, "a later presentation is no oracle").toBeUndefined();
    }
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
    // Postgres rollback semantics — the caller still sees the ordinary reuse 401, cause and all.
    await expect(svc.refresh(pastGrace(), { refreshToken: r1 }, { concurrentGrace: true }))
      .rejects.toMatchObject({ code: "refresh_revoked", details: { cause: "reuse" } });

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

  /* ── A FULL SIGN-IN AFTER A SWEEP IS TOLD IT, ONCE ─────────────────────────────────────────── */
  const as = (a: { userId: string; accountId: string }, sessionId: string): ServiceContext =>
    ctx({ userId: a.userId, accountId: a.accountId, sessionId });
  const eventRows = (userId: string, event: string) =>
    db.select().from(authEvents).where(and(eq(authEvents.userId, userId), eq(authEvents.event, event)));
  /** The first full session, the enrolment's exchange: it exists before any sweep. */
  const enrolled = async (userId: string): Promise<string> => (await db.select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.scope, "full"))).orderBy(asc(sessions.createdAt)).limit(1))[0]!.id;
  /** Rotate the family `r1` began, spend its tail, then present r1 again past the grace. */
  async function sweep(svc: AuthService, r1: string): Promise<void> {
    const rot = await svc.refresh(ctx(), { refreshToken: r1 }, { concurrentGrace: true });
    await svc.refresh(ctx(), { refreshToken: rot.tokens!.refreshToken }, { concurrentGrace: true });
    await expect(svc.refresh(pastGrace(), { refreshToken: r1 }, { concurrentGrace: true })).rejects
      .toMatchObject({ code: "refresh_revoked" });
  }

  it("a full sign-in after the sweep lists it with the swept client; nobody else is told", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const a = await establish(svc, `reuse-told-${randomUUID()}@lichtgrat.example`);
    const before = await enrolled(a.userId);
    await sweep(svc, a.r1);
    const [row] = await eventRows(a.userId, "refresh_reuse_revoked");
    const fresh = await a.signIn();
    expect((await svc.getSession(as(a, fresh))).reuseSweeps).toEqual([{ id: row!.id, at: row!.at.toISOString(), client: "web" }]);
    expect(await svc.getSession(as(a, before)), "a session older than the sweep").not.toHaveProperty("reuseSweeps");
    const b = await establish(svc, `reuse-other-${randomUUID()}@lichtgrat.example`);
    expect(await svc.getSession(as(b, await b.signIn())), "another account").not.toHaveProperty("reuseSweeps");
    await db.update(authEvents).set({ at: sql`now() - make_interval(days => 15)` }).where(eq(authEvents.id, row!.id));
    expect(await svc.getSession(as(a, fresh)), "a sweep 15 days back").not.toHaveProperty("reuseSweeps");
  });

  it("a desktop's swept session is named by its device's kind, and its native sweep says why", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const d = await establish(svc, `reuse-desktop-${randomUUID()}@lichtgrat.example`, "desktop-linux");
    await svc.refresh(ctx(), { refreshToken: d.r1, attemptId: "n-1" }, { surface: "native" });
    await expect(svc.refresh(ctx(), { refreshToken: d.r1, attemptId: "n-2" }, { surface: "native" })).rejects
      .toMatchObject({ code: "refresh_revoked", details: { cause: "reuse" } });
    const fresh = await d.signIn();
    expect((await svc.getSession(as(d, fresh))).reuseSweeps?.map((s) => s.client)).toEqual(["desktop-linux"]);
  });

  it("the acknowledgement counts only from a session minted after the sweep, and only once", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const a = await establish(svc, `reuse-ack-${randomUUID()}@lichtgrat.example`);
    const before = await enrolled(a.userId);
    await sweep(svc, a.r1);
    const [row] = await eventRows(a.userId, "refresh_reuse_revoked");
    const fresh = await a.signIn();
    await svc.acknowledgeReuseSweeps(as(a, before), { ids: [row!.id] });
    expect(await eventRows(a.userId, "refresh_reuse_acknowledged"), "an older session acknowledged it").toHaveLength(0);
    expect((await svc.getSession(as(a, fresh))).reuseSweeps).toHaveLength(1);
    await svc.acknowledgeReuseSweeps(as(a, fresh), { ids: [row!.id] });
    expect((await eventRows(a.userId, "refresh_reuse_acknowledged")).map((r) => r.device)).toEqual([`ack=${row!.id}`]);
    expect(await svc.getSession(as(a, fresh))).not.toHaveProperty("reuseSweeps");
    await svc.acknowledgeReuseSweeps(as(a, fresh), { ids: [row!.id] });
    expect(await eventRows(a.userId, "refresh_reuse_acknowledged"), "a second press wrote a second row").toHaveLength(1);
  });
});
