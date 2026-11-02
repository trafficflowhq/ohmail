import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq, desc, isNull } from "drizzle-orm";
import { generateSync } from "otplib";
// `sessions` lives on the MAIL half (the root barrel); `refresh_tokens` is Cloud.
import { refreshTokens, sessions } from "@trafficflow/db";
import { authEvents, schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  AuthService, makeTestAuthDeps, hashToken,
  type AuthDeps, type ServiceContext,
} from "@trafficflow/services";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE REFRESH-ROTATION RACE PGlite CANNOT SHOW YOU
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A browser shares ONE cookie jar across every tab and window, and the webapp single-flights
 * `POST /auth/refresh` only PER TAB (`apps/webapp/app/session-refresh.ts`). So the instant a
 * second tab, a second window, or the sync client and the REST client cross the fifteen-minute
 * access-token expiry together, they read the SAME `tf_refresh` out of the shared jar and present
 * it AT ONCE. That is a genuine race on one database row, and a sequential suite proves nothing
 * about it: run the two `refresh` calls one after another and the winner's `consumed_at` is always
 * committed by the time the second reads it.
 *
 * Against the pre-fix code this race REVOKED THE WHOLE FAMILY — the claim-first UPDATE picks one
 * winner, and the loser's presentation of the now-consumed token was read as reuse and burned
 * every session in the family. That is the "Sync stopped — this session is no longer authorized"
 * a signed-in user hit merely by opening a new tab. `rotateRefresh`'s grace window is the fix:
 * a re-presentation within `refreshReuseGraceMs` of a still-live family re-rotates rather than
 * revoking, and this file is the guard that the property holds on REAL Postgres locking.
 *
 * `describe.skipIf(!PG_UP)` + `PG_TEST_URL` are the repo's `*.pg.test.ts` contract;
 * `TF_REQUIRE_PG=1` turns the skip into a hard failure in CI.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

// A per-run source address: the shared pg database keeps the per-IP registration throttle
// across runs, so a FIXED address here rate-limits the suite's own registrations after enough
// consecutive invocations (measured while iterating on this file) — a 429 that looks like a
// product regression and is only the counter.
const RUN_IP = `10.9.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({
  db, accountId: "", userId: null, now: () => new Date(),
  requestId: "refresh-race-pg", ip: RUN_IP, ...over,
});

/** A clock only the test moves: every window is measured on `ctx.now`, so load cannot cross one. */
function movableClock(): { at: () => ServiceContext; pass: (ms: number) => void } {
  let t = Date.now();
  return { at: () => ctx({ now: () => new Date(t) }), pass: (ms) => { t += ms; } };
}

/** Register, enrol TOTP, complete a 2FA login, and return the user id + first refresh token. */
async function establish(svc: AuthService, email: string): Promise<{ userId: string; r1: string }> {
  // TOTP is single-use per 30-second step, so the enrol/activate and the login/verify must sit in
  // different windows — a movable clock, exactly as the recovery-code race test does it.
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

/** The cookie surface, stated: the grace branch AND the window this browser's rotation issues. */
const COOKIE = { concurrentGrace: true, surface: "cookie" } as const;

/** The family a presented token belongs to. */
async function familyOf(token: string): Promise<string> {
  const [row] = await db.select({ familyId: refreshTokens.familyId }).from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(token))).limit(1);
  return row!.familyId;
}

/** How many credentials of this family a client could still spend. */
async function liveTails(familyId: string): Promise<number> {
  const rows = await db.select({ id: refreshTokens.id }).from(refreshTokens).where(and(
    eq(refreshTokens.familyId, familyId),
    isNull(refreshTokens.consumedAt),
    isNull(refreshTokens.revokedAt),
  ));
  return rows.length;
}

describe.skipIf(!PG_UP)("refresh rotation race on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // Enough connections that the presentations genuinely overlap rather than queueing behind one.
    client = postgres(PG_TEST_URL, { max: 20 });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  /**
   * FIVE SIMULTANEOUS PRESENTATIONS OF ONE TOKEN LEAVE THE FAMILY ALIVE.
   *
   * Remove the grace branch in `rotateRefresh` (revoke unconditionally on a consumed token) and
   * this goes red: exactly one caller succeeds, the other four throw 401, and every refresh-token
   * row and session in the family carries a `revoked_at`.
   */
  it("concurrent refreshes with the same token do not revoke the family", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const email = `refresh-race-${randomUUID()}@lichtgrat.example`;
    const { userId, r1 } = await establish(svc, email);

    const N = 5;
    // `concurrentGrace` is the cookie surface — the one with the shared-jar multi-tab race.
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        svc.refresh(ctx(), { refreshToken: r1 }, { concurrentGrace: true })
          .then((r) => r.tokens!.refreshToken).catch((e) => e as Error)),
    );

    // Every caller got a usable refresh token — one won the claim, the rest re-rotated under grace.
    const tokens = results.filter((r): r is string => typeof r === "string");
    expect(tokens).toHaveLength(N);
    // …and they are all distinct: a rotation mints a fresh token, never echoes the presented one.
    expect(new Set([...tokens, r1]).size).toBe(N + 1);

    // The family is ALIVE. Nothing was signed out. Scoped to THIS user: the shared pg database
    // carries other tests' families (the late-replay test below deliberately revokes one), so a
    // table-wide sweep would see unrelated revocations. Pre-fix, the race set `revoked_at` on
    // every refresh token and full session of the family; both are asserted clear.
    const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
    expect(rows.length).toBeGreaterThanOrEqual(N + 1);
    expect(rows.every((row) => row.revokedAt === null)).toBe(true);
    // The full sessions live too. (Onboarding's enrollment session is exchanged away for a full
    // one and is not the subject here, so the check is scoped to `full`.)
    const sess = await db.select().from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.scope, "full")));
    expect(sess.length).toBeGreaterThan(0);
    expect(sess.every((s) => s.revokedAt === null)).toBe(true);

    // And each freshly-issued token still rotates — the family did not merely survive, it works.
    for (const tok of tokens) {
      await expect(svc.refresh(ctx(), { refreshToken: tok }, { concurrentGrace: true })).resolves.toBeTruthy();
    }
  }, 60_000);

  /**
   * THE WINDOW EVERY CONCURRENT WINNER AND GRACE-LOSER GETS IS THE COOKIE ONE.
   * Lifetimes are per surface (90 days for a browser, 400 for the desktop app), and the
   * concurrent case exercises both writers at once: the hot path claims the row, the losers reach
   * `mintRotation` from the grace path with a different base row. Real row locking is the only
   * arrangement where "the loser resolved its window elsewhere" shows up. It catches
   * `mintRotation` reading `this.cfg` instead of the resolved `ttls`, or a surface argument that
   * stops reaching the grace branch — both leave every OTHER assertion here green while a browser
   * walks away with a credential four times the intended length.
   */
  it("every concurrent rotation issues the 90-day cookie window, never the native one", async () => {
    const deps = makeTestAuthDeps();
    const svc = new AuthService(deps);
    const email = `refresh-window-${randomUUID()}@lichtgrat.example`;
    const { r1 } = await establish(svc, email);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        svc.refresh(ctx(), { refreshToken: r1 }, COOKIE).then((r) => r.tokens!.refreshToken)),
    );

    // THE WINDOW IS READ FROM THE ROW'S OWN MINT STAMP: convergence overwrites the expiry of
    // every answer it collapses (the kill signature), so a killed row can no longer say what
    // window it was issued with. Each answer is asked what it can still answer — a live one its
    // window, a converged one its kill — and the deterministic arm below measures the GRACE
    // path's window, which is the hazard, on the one arrangement where its mint survives.
    let live = 0;
    for (const tok of results) {
      const [row] = await db.select().from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(tok))).limit(1);
      if (row!.consumedAt === null) {
        live += 1;
        const days = (row!.expiresAt.getTime() - row!.createdAt.getTime()) / 86_400_000;
        // A minute of slack for the round trips; the two candidate windows are 310 days apart, so
        // this cannot confuse them.
        expect(days).toBeGreaterThan(90 - 1 / 1440);
        expect(days).toBeLessThan(90 + 1 / 1440);
      } else {
        expect(row!.expiresAt.getTime(), "a converged answer carries the kill stamp")
          .toBeLessThanOrEqual(row!.consumedAt.getTime());
      }
    }
    expect(live, "the herd leaves the family at least one live credential").toBeGreaterThan(0);

    // AND THE GRACE PATH'S OWN WINDOW, DETERMINISTICALLY. Above, which of the five answers is
    // still live depends on the interleaving, so the hazard this test exists for — the loser's
    // `mintRotation` resolving a window from somewhere other than the passed `ttls` — needs one
    // arrangement where the grace path's mint is certainly the one left standing: a winner, then
    // a loser inside the window. The loser converges the winner away and its own answer is the
    // family's live tail.
    const second = await establish(svc, `refresh-window-grace-${randomUUID()}@lichtgrat.example`);
    await svc.refresh(ctx(), { refreshToken: second.r1 }, COOKIE);
    const loser = await svc.refresh(ctx(), { refreshToken: second.r1 }, COOKIE);
    const [graceRow] = await db.select().from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(loser.tokens!.refreshToken))).limit(1);
    expect(graceRow!.consumedAt, "the grace path's mint is the live tail").toBeNull();
    const graceDays = (graceRow!.expiresAt.getTime() - graceRow!.createdAt.getTime()) / 86_400_000;
    expect(graceDays).toBeGreaterThan(90 - 1 / 1440);
    expect(graceDays).toBeLessThan(90 + 1 / 1440);

    // Stated as its own assertion so the failure message names the actual hazard.
    expect(deps.config.nativeRefreshTtlMs / 86_400_000).toBe(400);
  }, 60_000);

  /**
   * DETECTION IS INTACT: a token replayed AFTER the grace window, with its chain in LIVE USE,
   * still burns the family. The race fix must not become a licence to replay an old token —
   * this is the property on real PG. (A wholly-dormant tail instead takes the lost-response
   * recovery — the tests below.)
   */
  it("a token replayed past the grace window still revokes the family (used tail)", async () => {
    const svc = new AuthService(makeTestAuthDeps({ refreshReuseGraceMs: 50 }));
    const email = `refresh-late-${randomUUID()}@lichtgrat.example`;
    const { r1 } = await establish(svc, email);
    const clock = movableClock();

    const rot = await svc.refresh(clock.at(), { refreshToken: r1 }, { concurrentGrace: true });
    const r2 = rot.tokens!.refreshToken;
    // The chain is USED past r1: whoever holds it rotated again and kept going.
    clock.pass(60); // distinct consumption stamps
    const rot2 = await svc.refresh(clock.at(), { refreshToken: r2 }, { concurrentGrace: true });
    const r3 = rot2.tokens!.refreshToken;

    clock.pass(120);   // > the 50 ms grace
    // Grace ENABLED, yet past the window the family still burns — the boundary is real.
    await expect(svc.refresh(clock.at(), { refreshToken: r1 }, { concurrentGrace: true }))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
    await expect(svc.refresh(clock.at(), { refreshToken: r3 }, { concurrentGrace: true }))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
  }, 60_000);

  /**
   * ═══ THE LOST-RESPONSE RECOVERY, RACED ON REAL POSTGRES ═══
   *
   * The production shape (a real account, two mornings running): a rotation
   * commits, its response never reaches the jar, and at machine wake SEVERAL tabs re-present
   * the stale token together, far outside any grace window. The recovery's atomic claim must
   * pick exactly ONE winner (the dormant tail's consumption is the claim), the losers must
   * converge like grace-losers — never 401, because a cookie-branch 401 clears the jar the
   * winner just refilled — and the whole family must stay alive with exactly one live tip.
   */
  it("concurrent stale re-presentations after a LOST rotation all recover; one claim, no revocation", async () => {
    // 500 ms grace: the herd's LOSERS converge through the fresh-consumption grace of the
    // winner's claim. 100 ms access window: recovery is idle-bound to a full access window (an
    // awake client must have rotated by then). Both are read on the test's clock.
    const deps = makeTestAuthDeps({ refreshReuseGraceMs: 500, accessTtlMs: 100 });
    const svc = new AuthService(deps);
    const email = `refresh-recover-${randomUUID()}@lichtgrat.example`;
    const { userId, r1 } = await establish(svc, email);
    const clock = movableClock();

    // The lost rotation: r2 exists server-side; nobody ever received it.
    await svc.refresh(clock.at(), { refreshToken: r1 }, { concurrentGrace: true });
    clock.pass(800);   // far past the 500 ms grace

    // The wake herd: five tabs present the stale r1 at once.
    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        svc.refresh(clock.at(), { refreshToken: r1 }, { concurrentGrace: true })
          .then((r) => r.tokens!.refreshToken).catch((e) => e as Error)),
    );
    const tokens = results.filter((r): r is string => typeof r === "string");
    expect(tokens, "every stale presenter recovered — none was 401'd into a cleared jar").toHaveLength(N);

    // Nothing revoked; the family works.
    const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
    expect(rows.every((row) => row.revokedAt === null)).toBe(true);
    await expect(svc.refresh(clock.at(), { refreshToken: tokens[0]! }, { concurrentGrace: true }))
      .resolves.toBeTruthy();

    // EXACTLY ONE recovery was audited — the claim serialized the herd into one re-admission.
    const events = await db.select().from(authEvents).where(eq(authEvents.userId, userId));
    expect(events.filter((e) => e.event === "refresh_recovered")).toHaveLength(1);
    expect(events.filter((e) => e.event === "refresh_reuse_revoked")).toHaveLength(0);
  }, 60_000);

  /**
   * A STALE PRESENTER RACING THE LIVE TAIL never burns the family (a review finding, on real locking).
   * The hot path's claim once autocommitted without the session lock and could spend the tail
   * between recovery's classification and its claim; it now takes that lock first, the order
   * recovery takes, so the two serialize — and a hot path that claimed first would deadlock with
   * recovery here. Repeated to let the interleavings actually happen.
   */
  it("a stale presentation racing the live tail's own rotation revokes nothing", async () => {
    // The windows are chosen so the stale presentation is PAST BOTH the direct grace path
    // (400 ms on the clock > 200 ms grace — round 3 of the review caught the first version sitting
    // inside it, never reaching recovery at all) and the idle bound (> 100 ms accessTtl), so
    // every round genuinely enters `recoverLostRotation`; the racing pair present at one instant,
    // so their own spends read as fresh to each other's classification.
    const deps = makeTestAuthDeps({ refreshReuseGraceMs: 200, accessTtlMs: 100 });
    const svc = new AuthService(deps);
    const email = `refresh-crossrace-${randomUUID()}@lichtgrat.example`;
    const { userId, r1 } = await establish(svc, email);
    const clock = movableClock();

    let stale = r1;
    const rot = await svc.refresh(clock.at(), { refreshToken: stale }, { concurrentGrace: true });
    let tail = rot.tokens!.refreshToken;   // delivered — and about to sit idle past accessTtl
    for (let round = 0; round < 5; round++) {
      clock.pass(400);   // idle: > grace(200) AND > accessTtl(100)
      const [staleRes, tailRes] = await Promise.all([
        svc.refresh(clock.at(), { refreshToken: stale }, { concurrentGrace: true })
          .then((r) => ({ ok: true as const, tok: r.tokens!.refreshToken }))
          .catch((e) => ({ ok: false as const, err: e as Error })),
        svc.refresh(clock.at(), { refreshToken: tail }, { concurrentGrace: true })
          .then((r) => ({ ok: true as const, tok: r.tokens!.refreshToken }))
          .catch((e) => ({ ok: false as const, err: e as Error })),
      ]);
      // The LIVE tail's rotation must always succeed; the stale presenter may converge (204)
      // or, in some interleavings, be refused — but NEVER by burning the family.
      expect(tailRes.ok, `round ${round}: the live rotation survived`).toBe(true);
      const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
      expect(rows.every((row) => row.revokedAt === null),
        `round ${round}: nothing revoked`).toBe(true);
      stale = tail;                     // yesterday's tail is tomorrow's stale presentation
      tail = (tailRes as { tok: string }).tok;
    }
  }, 60_000);

  /** Recovery is SINGLE-USE per presented token, on real locking: the second stale wave of the
   *  SAME token — after a recovery already consumed the dormant tail — is the sweep. */
  it("a second stale wave of the same token after recovery burns the family", async () => {
    const svc = new AuthService(makeTestAuthDeps({ refreshReuseGraceMs: 50, accessTtlMs: 100 }));
    const email = `refresh-recover2-${randomUUID()}@lichtgrat.example`;
    const { r1 } = await establish(svc, email);
    const clock = movableClock();

    await svc.refresh(clock.at(), { refreshToken: r1 }, { concurrentGrace: true });
    clock.pass(150);
    await expect(svc.refresh(clock.at(), { refreshToken: r1 }, { concurrentGrace: true }))
      .resolves.toBeTruthy();      // the recovery

    clock.pass(150);
    await expect(svc.refresh(clock.at(), { refreshToken: r1 }, { concurrentGrace: true }))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
    const [row] = await db.select().from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(r1))).limit(1);
    expect(row!.revokedAt, "the family burned on the replay-after-recovery").not.toBeNull();
  }, 60_000);

  /**
   * ══ ONE LOST ANSWER, N RETRIES, ONE LIVE TAIL ══
   *
   * The cookie surface carries no attempt id, so a retry of a lost answer looks exactly like a
   * multi-tab race: one consumed token presented again inside the window. The arm MINTED per
   * presentation, so five retries left six live credentials — five of them orphans nobody holds,
   * none ever colliding with the reuse detector. It now converges like the native attempt arm,
   * so the LAST answer is the live one and the shared jar keeps it. Mutation: give the arm back
   * its bare `mintRotation(existing)` and this reads 6.
   */
  it("five retries of one lost answer leave exactly ONE live tail", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const email = `refresh-converge-${randomUUID()}@lichtgrat.example`;
    const { userId, r1 } = await establish(svc, email);
    const familyId = await familyOf(r1);

    // The rotation whose answer never lands, then five retries of the retained token — all well
    // inside the default 60 s grace window, which is what a browser's own retries look like.
    await svc.refresh(ctx(), { refreshToken: r1 }, COOKIE);
    const answers: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      answers.push((await svc.refresh(ctx(), { refreshToken: r1 }, COOKIE)).tokens!.refreshToken);
    }

    expect(await liveTails(familyId), "one lost answer, five retries, one live credential").toBe(1);
    // …and the live one is the LAST answer — the one the jar ends up holding.
    const [tail] = await db.select().from(refreshTokens).where(and(
      eq(refreshTokens.familyId, familyId), isNull(refreshTokens.consumedAt)));
    expect(tail!.tokenHash, "the live tail is the last answer").toBe(hashToken(answers.at(-1)!));

    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.every((row) => row.revokedAt === null), "convergence is not a sweep").toBe(true);
    // Every converged-away row carries the kill signature `recoverLostRotation` classifies by, so
    // a later stale presentation reads them as kills rather than as a second holder's spends. The
    // presented token itself is excluded: the HOT path consumed it and never kill-stamps.
    const converged = fam.filter((row) => row.consumedAt !== null && row.tokenHash !== hashToken(r1));
    expect(converged.length).toBeGreaterThanOrEqual(5);
    expect(converged.every((row) => row.expiresAt.getTime() <= row.consumedAt!.getTime()),
      "a converged tail is kill-stamped, not left looking like a spend").toBe(true);

    // Every convergence is visible: `refresh_replayed` is what the replay alert rule counts.
    const events = await db.select().from(authEvents).where(eq(authEvents.userId, userId));
    expect(events.filter((e) => e.event === "refresh_replayed"), "every replay is audited")
      .toHaveLength(5);
    expect(events.filter((e) => e.event === "refresh_reuse_revoked"),
      "a retry inside the window is never theft").toHaveLength(0);
  }, 60_000);

  /**
   * THE HERD RESTS ON ONE LIVE TAIL. The hot path and every converger take the session lock
   * first, so a concurrent herd is serialized: the winner's successor is committed before any
   * converger sweeps, and the herd alone leaves one live tail. It once took the jar's next
   * presentation to collapse a second one; that presentation still converges.
   */
  /**
   * THE RESIDUAL, MEASURED RATHER THAN REASONED ABOUT. The jar keeps whichever answer lands last,
   * which under convergence is the live one — but responses can arrive out of order, and a jar
   * left holding an EARLIER answer past the window holds a converged-away token. It must get the
   * PLAIN refusal: a kill names no second holder of the chain, and sweeping would revoke the line
   * the convergence just established. Inside the window it converges again.
   */
  it("an answer converged away is refused PLAINLY past the window — never swept", async () => {
    const svc = new AuthService(makeTestAuthDeps({ refreshReuseGraceMs: 50 }));
    const email = `refresh-converged-late-${randomUUID()}@lichtgrat.example`;
    const { r1 } = await establish(svc, email);
    const familyId = await familyOf(r1);
    const clock = movableClock();

    const first = await svc.refresh(clock.at(), { refreshToken: r1 }, COOKIE);
    const second = await svc.refresh(clock.at(), { refreshToken: r1 }, COOKIE);   // converges the first
    clock.pass(120);                                                              // > the 50 ms window

    await expect(svc.refresh(clock.at(), { refreshToken: first.tokens!.refreshToken }, COOKIE))
      .rejects.toMatchObject({ code: "refresh_expired", httpStatus: 401 });
    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.every((row) => row.revokedAt === null), "a kill is not a second holder").toBe(true);
    // The line the convergence established is untouched and still rotates.
    await expect(svc.refresh(clock.at(), { refreshToken: second.tokens!.refreshToken }, COOKIE))
      .resolves.toBeTruthy();
  }, 60_000);

  it("a concurrent herd is collapsed to one live tail by the next stale presentation", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const email = `refresh-herd-${randomUUID()}@lichtgrat.example`;
    const { r1 } = await establish(svc, email);
    const familyId = await familyOf(r1);

    await Promise.all(Array.from({ length: 5 }, () =>
      svc.refresh(ctx(), { refreshToken: r1 }, COOKIE).catch((e) => e as Error)));
    expect(await liveTails(familyId), "the herd alone leaves one live tail").toBe(1);
    // The jar still holds the stale token and tries once more, inside the window.
    await expect(svc.refresh(ctx(), { refreshToken: r1 }, COOKIE)).resolves.toBeTruthy();

    expect(await liveTails(familyId), "the family rests on one live credential").toBe(1);
  }, 60_000);
});
