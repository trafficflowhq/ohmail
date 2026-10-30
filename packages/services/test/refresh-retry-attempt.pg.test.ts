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
 *  A RETRY OF AN UNANSWERED REFRESH IS NOT A REUSE — on real Postgres
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A phone's refresh SUCCEEDS and its response is lost. On reconnect the phone retries with the
 * token it still holds, the server reads a consumed token as theft, and the whole session family
 * — access, refresh and the pairing behind them — is revoked. An ordinary dropped response costs
 * the person their mailbox until they scan a fresh code.
 *
 * The discriminator is an ATTEMPT ID the client persists BEFORE it submits and repeats on every
 * retry of that same attempt. The claim stores it with the rotation, so a consumed token
 * presented again names the attempt that consumed it — or it does not, and that is theft. There
 * is no second clock: the retry is admitted while the PRESENTED token's own window stands, and
 * USE beats the id — a chain that moved on under another attempt is a captured replay.
 * PGlite proves nothing here: the replay takes the session lock and claims under it.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

/**
 * A FRESH IP PER CASE. `register` claims a per-IP signup slot (`register:ip`), so four cases
 * sharing one address exhaust the window and every one of them fails for a reason that has
 * nothing to do with rotation — and the suite would be reading its own throttle, not the door.
 */
let ipCell = 0;
const nextIp = (): string => `10.9.${(ipCell += 1)}.11`;
let ip = "10.9.0.11";

const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({
  db, accountId: "", userId: null, now: () => new Date(),
  requestId: "refresh-retry-pg", ip, ...over,
});

/** Register, enrol TOTP, complete a 2FA login, and return the user id + first refresh token. */
async function establish(svc: AuthService, email: string): Promise<{ userId: string; r1: string }> {
  ip = nextIp();
  let t = new Date();
  const at = (over: Partial<ServiceContext> = {}): ServiceContext => ctx({ now: () => t, ...over });
  const totp = (secret: string): string => generateSync({ secret, epoch: Math.floor(t.getTime() / 1000) });

  // NARROWED, not asserted away: `register` answers two shapes, and only the enrolment one
  // carries the user this helper goes on to enrol and sign in.
  const registered = await svc.register(at(), {
    email, password: "pw-correct-horse-password-password", displayName: "Gil", inviteCode: "INVITE-OK",
  });
  if (registered.status !== "enrollment") {
    throw new Error(`expected an enrolment session, got ${registered.status}`);
  }
  const user = registered.user;
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

/** The native/bearer surface the phone rotates on: no concurrent grace, the long window. */
const native = { surface: "native" } as const;

/** The family the given token rotates in, read off the row it consumed. */
async function familyOf(userId: string): Promise<string> {
  const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
  return rows.find((r) => r.consumedAt !== null)!.familyId;
}

/** How many of a family's rows are still spendable — the "exactly one live line" reading. */
async function liveTails(familyId: string): Promise<number> {
  const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
  return rows.filter((r) => r.consumedAt === null && r.revokedAt === null).length;
}

describe.skipIf(!PG_UP)("a retry of an unanswered refresh, on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 5 });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("the response is lost and the phone retries the SAME attempt — one live tail, family alive", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `retry-same-${randomUUID()}@lichtgrat.example`);
    const attemptId = `a-${randomUUID()}`;

    // The rotation the phone never hears about.
    const lost = await svc.refresh(ctx(), { refreshToken: r1, attemptId }, native);
    expect(lost.tokens?.refreshToken, "the server did rotate").toBeTruthy();
    const familyId = await familyOf(userId);

    // The retry: the same token it still holds, carrying the same attempt id.
    const retried = await svc.refresh(ctx(), { refreshToken: r1, attemptId }, native);
    expect(retried.tokens?.refreshToken, "the retry is answered with a spendable pair").toBeTruthy();

    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.some((r) => r.revokedAt !== null), "nothing in the family was revoked").toBe(false);
    const sess = await db.select().from(sessions).where(eq(sessions.familyId, familyId));
    expect(sess.every((s) => s.revokedAt === null), "the session survives the lost response").toBe(true);
    expect(await liveTails(familyId), "one attempt, one live line — never a second tail").toBe(1);

    // And what the retry handed back is the line that is live: it rotates once more.
    const next = await svc.refresh(ctx(), { refreshToken: retried.tokens!.refreshToken }, native);
    expect(next.tokens?.accessToken, "the answered pair is the family's live line").toBeTruthy();
  });

  it("a DIFFERENT attempt on a consumed token is theft and still revokes the family", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `retry-other-${randomUUID()}@lichtgrat.example`);
    await svc.refresh(ctx(), { refreshToken: r1, attemptId: `a-${randomUUID()}` }, native);
    const familyId = await familyOf(userId);

    await expect(svc.refresh(ctx(), { refreshToken: r1, attemptId: `a-${randomUUID()}` }, native))
      .rejects.toMatchObject({ code: "refresh_revoked" });

    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.every((r) => r.revokedAt !== null), "the theft arm still sweeps").toBe(true);
  });

  it("a consumed token with NO attempt id is theft — the id-less presentation never passes", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `retry-none-${randomUUID()}@lichtgrat.example`);
    await svc.refresh(ctx(), { refreshToken: r1, attemptId: `a-${randomUUID()}` }, native);
    const familyId = await familyOf(userId);

    await expect(svc.refresh(ctx(), { refreshToken: r1 }, native))
      .rejects.toMatchObject({ code: "refresh_revoked" });

    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.every((r) => r.revokedAt !== null), "no attempt id, no re-admission").toBe(true);
  });

  it("past the PRESENTED token's own expiry the same attempt is swept — the window is the token's", async () => {
    // No knob to read: the bound is the rolling refresh window the presented token was minted
    // with, the same one `recoverLostRotation` uses. BOTH TTLs are shortened — the first token of
    // a session is minted by the sign-in, on the cookie window, and shortening only the native
    // one left this case presenting a token with ninety days on it and measuring nothing.
    const svc = new AuthService(makeTestAuthDeps({
      refreshTtlMs: 20_000, nativeRefreshTtlMs: 20_000,
    }));
    const { userId, r1 } = await establish(svc, `retry-expired-${randomUUID()}@lichtgrat.example`);
    const attemptId = `a-${randomUUID()}`;
    await svc.refresh(ctx(), { refreshToken: r1, attemptId }, native);
    const familyId = await familyOf(userId);

    const late = ctx({ now: () => new Date(Date.now() + 60_000) });
    await expect(svc.refresh(late, { refreshToken: r1, attemptId }, native))
      .rejects.toMatchObject({ code: "refresh_revoked" });

    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.every((r) => r.revokedAt !== null), "past its own window it is a kept token").toBe(true);
  });

  it("USE BEATS THE ID — the same attempt on a chain that moved on is a captured replay", async () => {
    // The residual's own fence. The phone DID get its answer and rotated again under a NEW
    // attempt; a later presentation of the original token with the original id is therefore
    // somebody else holding a captured wire, whatever the clock says.
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `retry-movedon-${randomUUID()}@lichtgrat.example`);
    const attemptId = `a-${randomUUID()}`;
    const first = await svc.refresh(ctx(), { refreshToken: r1, attemptId }, native);
    const familyId = await familyOf(userId);
    // The client adopted and rotated on, naming a DIFFERENT attempt.
    await svc.refresh(ctx(), {
      refreshToken: first.tokens!.refreshToken, attemptId: `a-${randomUUID()}`,
    }, native);

    await expect(svc.refresh(ctx(), { refreshToken: r1, attemptId }, native))
      .rejects.toMatchObject({ code: "refresh_revoked" });

    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.every((r) => r.revokedAt !== null), "use beats the id").toBe(true);
  });

  it("every replay is audited, and the row names no attempt id", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `retry-audit-${randomUUID()}@lichtgrat.example`);
    const attemptId = `a-${randomUUID()}`;
    await svc.refresh(ctx(), { refreshToken: r1, attemptId }, native);
    const familyId = await familyOf(userId);
    await svc.refresh(ctx(), { refreshToken: r1, attemptId }, native);

    const rows = (await db.select().from(authEvents).where(eq(authEvents.userId, userId)))
      .filter((r) => r.event === "refresh_replayed");
    expect(rows, "a spent token buying a credential is always visible").toHaveLength(1);
    expect(rows[0]!.device).toContain(`family=${familyId}`);
    expect(rows[0]!.device, "the client's own string never reaches the row").not.toContain(attemptId);
  });

  /* THE SAME ARM ON THE COOKIE SURFACE. A browser now names its renewal too, and the arm is checked
   * before the 60 s grace, so a lost answer retried past the grace and inside one access window (where
   * a quiet tail is not yet recovered) is re-admitted by its name; without one it is still swept. */
  const cookie = { concurrentGrace: true, surface: "cookie" } as const;
  const past = (): ServiceContext => ctx({ now: () => new Date(Date.now() + 117_000) });

  it("on the COOKIE surface a lost answer retried 117 s later under the SAME name is re-admitted", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `cookie-same-${randomUUID()}@lichtgrat.example`);
    const attemptId = `w-${randomUUID()}`;
    await svc.refresh(ctx(), { refreshToken: r1, attemptId }, cookie);
    const familyId = await familyOf(userId);

    const back = await svc.refresh(past(), { refreshToken: r1, attemptId }, cookie);
    expect(back.tokens?.refreshToken, "the retry is answered").toBeTruthy();
    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.some((r) => r.revokedAt !== null), "nothing in the family was revoked").toBe(false);
    expect(await liveTails(familyId), "one attempt, one live line").toBe(1);
  });

  it("on the COOKIE surface the same retry with NO name is swept — what a browser met before it named one", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `cookie-none-${randomUUID()}@lichtgrat.example`);
    await svc.refresh(ctx(), { refreshToken: r1, attemptId: `w-${randomUUID()}` }, cookie);
    const familyId = await familyOf(userId);

    await expect(svc.refresh(past(), { refreshToken: r1 }, cookie)).rejects.toMatchObject({ code: "refresh_revoked" });
    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.every((r) => r.revokedAt !== null), "no name, no re-admission past the grace").toBe(true);
  });

  it("on the COOKIE surface use beats the name: the chain moved on, the old name is a replay", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `cookie-movedon-${randomUUID()}@lichtgrat.example`);
    const attemptId = `w-${randomUUID()}`;
    const first = await svc.refresh(ctx(), { refreshToken: r1, attemptId }, cookie);
    const familyId = await familyOf(userId);
    await svc.refresh(ctx(), { refreshToken: first.tokens!.refreshToken, attemptId: `w-${randomUUID()}` }, cookie);

    await expect(svc.refresh(past(), { refreshToken: r1, attemptId }, cookie)).rejects.toMatchObject({ code: "refresh_revoked" });
    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.every((r) => r.revokedAt !== null), "use beats the name").toBe(true);
  });

  const at = (ms: number): ServiceContext => ctx({ now: () => new Date(Date.now() + ms) });
  const eventsOf = async (userId: string): Promise<string[]> =>
    (await db.select().from(authEvents).where(eq(authEvents.userId, userId))).map((r) => r.event).sort();

  it("on the COOKIE surface the name is answered for ONE access window only; later it is unnamed", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `cookie-window-${randomUUID()}@lichtgrat.example`);
    const attemptId = `w-${randomUUID()}`;
    await svc.refresh(ctx(), { refreshToken: r1, attemptId }, cookie);
    const back = await svc.refresh(at(20 * 60_000), { refreshToken: r1, attemptId }, cookie);
    expect(back.tokens?.refreshToken, "a quiet tail past the window is recovered, as with no name").toBeTruthy();
    const events = await eventsOf(userId);
    expect(events).toContain("refresh_recovered");
    expect(events).not.toContain("refresh_replayed");
  });

  it("a row the replay killed, back under ANOTHER name, sweeps the family as refresh_attempt_revoked", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `cookie-capture-${randomUUID()}@lichtgrat.example`);
    const attemptId = `w-${randomUUID()}`;
    const legit = await svc.refresh(ctx(), { refreshToken: r1, attemptId }, cookie);
    const familyId = await familyOf(userId);
    const thief = await svc.refresh(at(5 * 60_000), { refreshToken: r1, attemptId }, cookie);
    expect(thief.tokens?.refreshToken, "inside the window the captured pair is answered").toBeTruthy();
    await expect(svc.refresh(at(12 * 60_000), { refreshToken: legit.tokens!.refreshToken, attemptId: `w-${randomUUID()}` }, cookie))
      .rejects.toMatchObject({ code: "refresh_revoked" });
    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.every((r) => r.revokedAt !== null), "the thief's line goes with the family").toBe(true);
    expect(await eventsOf(userId)).toContain("refresh_attempt_revoked");
    expect(await eventsOf(userId)).not.toContain("refresh_reuse_revoked");
  });

  /* SCENARIO X. Two presentations of one token race; X is the first answer, T the second, and X's row is
   * killed. Past the grace nothing tells the jar a late X overwrote from a thief holding X's wire, so X
   * stays refused there for ever (the server arm that re-admitted it was reverted before it landed); the
   * web's live tab presents a late X again INSIDE the grace instead, which is the control. */
  const refreshTrail = async (userId: string): Promise<string[]> =>
    (await db.select().from(authEvents).where(eq(authEvents.userId, userId)))
      .filter((r) => r.event.startsWith("refresh_"))
      .map((r) => {
        const cause = /cause=(\w+)/.exec(r.device ?? "")?.[1];
        return cause ? `${r.event}(${cause})` : r.event;
      })
      .sort();

  it("SCENARIO X: the race's first answer, back 70 s later, is refused plainly and the person's line stays in", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `late-x-${randomUUID()}@lichtgrat.example`);
    const x = (await svc.refresh(ctx(), { refreshToken: r1 }, cookie)).tokens!.refreshToken;
    const t = (await svc.refresh(ctx(), { refreshToken: r1 }, cookie)).tokens!.refreshToken;

    await expect(svc.refresh(at(70_000), { refreshToken: x }, cookie)).rejects.toMatchObject({ code: "refresh_expired" });
    expect(await refreshTrail(userId)).toEqual(["refresh_expired(superseded)", "refresh_replayed"]);
    const kept = await svc.refresh(at(200_000), { refreshToken: t }, cookie);
    expect(kept.tokens?.refreshToken, "the person's own line rotates on").toBeTruthy();
    await expect(svc.refresh(at(201_000), { refreshToken: x }, cookie)).rejects.toMatchObject({ code: "refresh_expired" });
    expect(await refreshTrail(userId), "no recovery of X, ever").not.toContain("refresh_recovered");
  });

  it("SCENARIO X, named: X back under another name past the grace sweeps the family, today's theft detection", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `late-x-named-${randomUUID()}@lichtgrat.example`);
    const shared = `w-${randomUUID()}`;
    const x = (await svc.refresh(ctx(), { refreshToken: r1, attemptId: shared }, cookie)).tokens!.refreshToken;
    const t = (await svc.refresh(ctx(), { refreshToken: r1, attemptId: shared }, cookie)).tokens!.refreshToken;

    await expect(svc.refresh(at(70_000), { refreshToken: x, attemptId: `w-${randomUUID()}` }, cookie))
      .rejects.toMatchObject({ code: "refresh_revoked" });
    expect(await refreshTrail(userId)).toEqual(["refresh_attempt_revoked(attempt_mismatch)", "refresh_replayed"]);
    await expect(svc.refresh(at(71_000), { refreshToken: t }, cookie)).rejects.toMatchObject({ code: "refresh_revoked" });
  });

  it("CONTROL: X back 30 s later is answered, unnamed or under the race's own name: the door the repair uses", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const plain = await establish(svc, `late-x-30-${randomUUID()}@lichtgrat.example`);
    const x = (await svc.refresh(ctx(), { refreshToken: plain.r1 }, cookie)).tokens!.refreshToken;
    await svc.refresh(ctx(), { refreshToken: plain.r1 }, cookie);
    const back = await svc.refresh(at(30_000), { refreshToken: x }, cookie);
    expect(back.tokens?.refreshToken, "an unnamed X inside the grace converges").toBeTruthy();

    const named = await establish(svc, `late-x-30-named-${randomUUID()}@lichtgrat.example`);
    const shared = `w-${randomUUID()}`;
    const xn = (await svc.refresh(ctx(), { refreshToken: named.r1, attemptId: shared }, cookie)).tokens!.refreshToken;
    await svc.refresh(ctx(), { refreshToken: named.r1, attemptId: shared }, cookie);
    const repaired = await svc.refresh(at(30_000), { refreshToken: xn, attemptId: shared }, cookie);
    expect(repaired.tokens?.refreshToken, "the repair's presentation inside the grace converges").toBeTruthy();
    expect(await refreshTrail(named.userId), "the race's replay and the repair, and nothing else")
      .toEqual(["refresh_replayed", "refresh_replayed"]);
    const next = await svc.refresh(at(31_000), { refreshToken: repaired.tokens!.refreshToken }, cookie);
    expect(next.tokens?.refreshToken, "what the repair handed back is the live line").toBeTruthy();
  });

  /* A BROWSER KILLED BEFORE IT STORED ITS RENEWED COOKIE: its restored tabs present the spent token under
   * the name it went out with, at once. The replay serializes on the session lock and converges. */
  it("on the COOKIE surface two presentations of the spent token AT ONCE under its name: both answered, one live line", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `cookie-killed-${randomUUID()}@lichtgrat.example`);
    const attemptId = `w-${randomUUID()}`;
    await svc.refresh(ctx(), { refreshToken: r1, attemptId }, cookie);
    const familyId = await familyOf(userId);

    const restart = at(76_000);
    const [a, b] = await Promise.all([
      svc.refresh(restart, { refreshToken: r1, attemptId }, cookie),
      svc.refresh(restart, { refreshToken: r1, attemptId }, cookie),
    ]);
    expect(a.tokens?.refreshToken && b.tokens?.refreshToken, "both tabs are answered").toBeTruthy();
    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.some((r) => r.revokedAt !== null), "nothing in the family was revoked").toBe(false);
    expect(await liveTails(familyId), "one attempt, one live line").toBe(1);
    expect(await eventsOf(userId)).not.toContain("refresh_reuse_revoked");
  });

  it("on the COOKIE surface a token two rotations back, under a name the jar spent its next token with, is swept", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `cookie-reused-${randomUUID()}@lichtgrat.example`);
    const attemptId = `w-${randomUUID()}`;
    const first = await svc.refresh(ctx(), { refreshToken: r1, attemptId }, cookie);
    const familyId = await familyOf(userId);
    await svc.refresh(at(30_000), { refreshToken: first.tokens!.refreshToken, attemptId }, cookie);

    await expect(svc.refresh(at(147_000), { refreshToken: r1, attemptId }, cookie))
      .rejects.toMatchObject({ code: "refresh_revoked" });
    const fam = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
    expect(fam.every((r) => r.revokedAt !== null), "a real spend under the name moved the chain on").toBe(true);
    expect(await eventsOf(userId)).toContain("refresh_reuse_revoked");
  });
});
