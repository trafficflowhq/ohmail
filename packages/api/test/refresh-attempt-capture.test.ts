import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { refreshTokens, sessions } from "@trafficflow/db";
import { authEvents } from "@trafficflow/db/cloud";
import { generateToken, hashToken, type Db } from "@trafficflow/services";
import { makeDeps, seedSession, req, setCookieMap, cookieMaxAge, FIXED_NOW } from "./helpers.js";

/**
 * A CAPTURED RENEWAL REQUEST DOES NOT TAKE OVER THE SESSION. A browser's renewal carries its attempt
 * name beside `tf_refresh`, so a captured request is the token and the name together. The name
 * re-admits one lost answer, soon: on the cookie surface only within one access window of the
 * rotation it named, and the person's own next presentation of the line the replay killed sweeps
 * the family (`refresh_attempt_revoked`). The review's probe, in five steps, with its readings asserted.
 */

const real = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => real.handle(r, { ...d, session: null, idempotency: null });
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** A refresh row in the SESSION'S OWN family, with the cookie surface's real 90-day window. */
async function jarFor(db: Db, now: Date): Promise<{ refresh: string; accountId: string; familyId: string; sessionId: string }> {
  const s = await seedSession(db, { now });
  const [row] = await db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, s.sessionId));
  const refresh = generateToken();
  await db.insert(refreshTokens).values({
    accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: row!.familyId,
    tokenHash: hashToken(refresh), expiresAt: new Date(now.getTime() + 90 * DAY), createdAt: now,
  });
  return { refresh, accountId: s.accountId, familyId: row!.familyId, sessionId: s.sessionId };
}
const refresh = (deps: ApiDeps, token: string, name?: string): Promise<Response> =>
  H(req("POST", "/auth/refresh", {
    cookie: `tf_refresh=${token}`, ...(name === undefined ? {} : { body: JSON.stringify({ attemptId: name }) }),
  }), deps);
async function codeOf(res: Response): Promise<string> {
  try { return ((await res.clone().json()) as { error?: { code?: string } }).error?.code ?? "-"; } catch { return "-"; }
}
const answer = async (res: Response | null): Promise<string> => (res ? `${res.status}/${await codeOf(res)}` : "none");
/** The answer's whole envelope: `details` is the field that says why, and only a sweep's own 401 has one. */
const envelope = async (res: Response): Promise<unknown> => ((await res.clone().json()) as { error?: unknown }).error;
const REUSE = { code: "refresh_revoked", message: "refresh token reuse detected", details: { cause: "reuse" } };
const PLAIN = { code: "refresh_revoked", message: "invalid refresh token" };
async function familyRevoked(db: Db, sessionId: string): Promise<boolean> {
  const [s] = await db.select({ r: sessions.revokedAt }).from(sessions).where(eq(sessions.id, sessionId));
  return s?.r != null;
}
/** The account's auth trail as `event(cause)xN`, the probe's own reading. */
async function trail(db: Db, accountId: string): Promise<string> {
  const rows = await db.select().from(authEvents).where(and(eq(authEvents.accountId, accountId)));
  const tally = new Map<string, number>();
  for (const r of rows) {
    const cause = /cause=(\w+)/.exec(r.device ?? "")?.[1];
    const k = cause ? `${r.event}(${cause})` : r.event;
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  return [...tally].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}x${n}`).join(",") || "none";
}
/** The name each KILLED row of the family carries: `named` or `null`, in mint order. */
async function killNames(db: Db, familyId: string): Promise<string[]> {
  const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
  return rows
    .filter((r) => r.consumedAt !== null && r.expiresAt.getTime() === r.consumedAt.getTime())
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((r) => (r.consumedByAttempt === null ? "null" : "named"));
}

describe("a captured renewal request (the review's probe, five cases)", () => {
  it("replayed 5 min after the answer landed, the person's return at 12 min sweeps and the thief's line is refused", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    const r1 = await refresh(deps, j.refresh, "w-legit-1");
    const t1 = setCookieMap(r1).tf_refresh!;
    clock.advance(5 * MIN);
    const r2 = await refresh(deps, j.refresh, "w-legit-1");
    const t2 = setCookieMap(r2).tf_refresh;
    clock.advance(7 * MIN);
    const r3 = await refresh(deps, t1, "w-legit-2");
    clock.advance(1 * MIN);
    const r4 = t2 ? await refresh(deps, t2, "w-thief-2") : null;
    console.log(`PROBE 1 legit=${await answer(r1)} thief@5m=${await answer(r2)} legit@12m=${await answer(r3)} ` +
      `thief-line@13m=${await answer(r4)} sessionRevoked=${await familyRevoked(db, j.sessionId)} events=${await trail(db, j.accountId)}`);
    expect(await answer(r1)).toBe("204/-");
    expect(await answer(r3), "the person's return names a second holder").toBe("401/refresh_revoked");
    expect(await answer(r4), "the thief's line dies with the family").not.toMatch(/^204/);
    expect(await familyRevoked(db, j.sessionId)).toBe(true);
    expect(await trail(db, j.accountId)).toContain("refresh_attempt_revoked(attempt_mismatch)x1");
    expect(await trail(db, j.accountId)).not.toContain("refresh_reuse_revoked");
  });

  it("past one access window the pair is an unnamed presentation, exactly as before names existed", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    const r1 = await refresh(deps, j.refresh, "w-legit-1");
    const t1 = setCookieMap(r1).tf_refresh!;
    clock.advance(30 * DAY);
    const r2 = await refresh(deps, j.refresh, "w-legit-1");
    const t2 = setCookieMap(r2).tf_refresh;
    clock.advance(1 * DAY);
    const r3 = await refresh(deps, t1, "w-legit-2");
    clock.advance(1 * MIN);
    const r4 = t2 ? await refresh(deps, t2, "w-thief-2") : null;
    console.log(`PROBE 2 legit=${await answer(r1)} thief@30d=${await answer(r2)} legit@31d=${await answer(r3)} ` +
      `thief-line@31d=${await answer(r4)} sessionRevoked=${await familyRevoked(db, j.sessionId)} events=${await trail(db, j.accountId)}`);
    // The base reading, through recovery and not the replay arm: the quiet tail is recovered once.
    expect(await answer(r2)).toBe("204/-");
    expect(await answer(r3)).toBe("401/refresh_expired");
    expect(await trail(db, j.accountId)).toBe("refresh_expired(superseded)x1,refresh_recoveredx1");
  });

  it("the token without its name, or under another, is swept as it always was", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    const r1 = await refresh(deps, j.refresh, "w-legit-1");
    clock.advance(5 * MIN);
    const r2 = await refresh(deps, j.refresh, "w-thief-own");
    const r2b = await refresh(deps, j.refresh);
    console.log(`PROBE 3 legit=${await answer(r1)} thief-own-name@5m=${await answer(r2)} thief-no-name@5m=${await answer(r2b)} ` +
      `sessionRevoked=${await familyRevoked(db, j.sessionId)} events=${await trail(db, j.accountId)}`);
    expect(await answer(r2)).toBe("401/refresh_revoked");
    expect(await answer(r2b)).toBe("401/refresh_revoked");
    expect(await trail(db, j.accountId)).toBe("refresh_reuse_revokedx1");
  });

  it("replayed twice while quiet, past the window: recovered once, the second swept", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    const r1 = await refresh(deps, j.refresh, "w-legit-1");
    clock.advance(20 * MIN);
    const r2 = await refresh(deps, j.refresh, "w-legit-1");
    clock.advance(2 * MIN);
    const r3 = await refresh(deps, j.refresh, "w-legit-1");
    console.log(`PROBE 4 legit=${await answer(r1)} replay1@20m=${await answer(r2)} replay2@22m=${await answer(r3)} ` +
      `sessionRevoked=${await familyRevoked(db, j.sessionId)} events=${await trail(db, j.accountId)}`);
    expect(await answer(r2)).toBe("204/-");
    expect(await answer(r3)).toBe("401/refresh_revoked");
    expect(await familyRevoked(db, j.sessionId)).toBe(true);
    expect(await trail(db, j.accountId)).toBe("refresh_recoveredx1,refresh_reuse_revokedx1");
  });

  it("one superseded token presented 50 times writes ONE row, and the family lives", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    const first = await refresh(deps, j.refresh);
    const late = setCookieMap(first).tf_refresh!;
    const second = await refresh(deps, j.refresh);
    clock.advance(70_000);
    const codes = new Map<string, number>();
    for (let i = 0; i < 50; i += 1) {
      const k = await answer(await refresh(deps, late));
      codes.set(k, (codes.get(k) ?? 0) + 1);
    }
    console.log(`PROBE 5 first=${first.status} second=${second.status} answers=${[...codes].map(([k, n]) => `${k}x${n}`).join(",")} ` +
      `sessionRevoked=${await familyRevoked(db, j.sessionId)} events=${await trail(db, j.accountId)}`);
    expect([...codes]).toEqual([["401/refresh_expired", 50]]);
    expect(await familyRevoked(db, j.sessionId)).toBe(false);
    expect(await trail(db, j.accountId)).toBe("refresh_expired(superseded)x1,refresh_replayedx1");
  });
});

describe("which kills carry a name", () => {
  it("only the replay arm names the row it kills; convergence and recovery leave it null", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    // Convergence: the same token twice inside the grace, unnamed.
    const c = await jarFor(db, clock.now());
    await refresh(deps, c.refresh);
    await refresh(deps, c.refresh);
    expect(await killNames(db, c.familyId), "a convergence kill").toEqual(["null"]);
    // Recovery: a lost answer past the access window, the tail never used.
    const r = await jarFor(db, clock.now());
    await refresh(deps, r.refresh);
    clock.advance(20 * MIN);
    await refresh(deps, r.refresh);
    expect(await killNames(db, r.familyId), "a recovery kill").toEqual(["null"]);
    // Replay: the same name inside the window.
    const p = await jarFor(db, clock.now());
    await refresh(deps, p.refresh, "w-one");
    clock.advance(2 * MIN);
    await refresh(deps, p.refresh, "w-one");
    expect(await killNames(db, p.familyId), "a replay kill").toEqual(["named"]);
  });

  it("an UNNAMED kill presented under a live name is refused plainly: only a named kill names a second holder", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    const a = await refresh(deps, j.refresh, "w-tab-a");
    const late = setCookieMap(a).tf_refresh!;
    await refresh(deps, j.refresh, "w-tab-b");
    expect(await killNames(db, j.familyId), "another name inside the grace converges").toEqual(["null"]);
    clock.advance(70_000);
    const res = await refresh(deps, late, "w-next");
    expect(await answer(res)).toBe("401/refresh_expired");
    expect(await familyRevoked(db, j.sessionId)).toBe(false);
  });

  it("THE LATE ANSWER is classified by its own cause: a named kill sweeps as attempt_mismatch, an unnamed one expires", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    // Two presentations under one shared name: the second replays, the first's answer lands last.
    const n = await jarFor(db, clock.now());
    const firstNamed = await refresh(deps, n.refresh, "w-shared");
    const lateNamed = setCookieMap(firstNamed).tf_refresh!;
    await refresh(deps, n.refresh, "w-shared");
    clock.advance(70_000);
    const named = await refresh(deps, lateNamed, "w-next");
    expect(await answer(named)).toBe("401/refresh_revoked");
    // Its usual cause is a late answer inside one client: no "used again from a copy" for it.
    expect(await envelope(named)).toEqual({ code: "refresh_revoked", message: "refresh token reuse detected" });
    expect(await trail(db, n.accountId)).toContain("refresh_attempt_revoked(attempt_mismatch)x1");
    // The same race with no names: the second converges, the late answer expires.
    const u = await jarFor(db, clock.now());
    const firstPlain = await refresh(deps, u.refresh);
    const latePlain = setCookieMap(firstPlain).tf_refresh!;
    await refresh(deps, u.refresh);
    clock.advance(70_000);
    const plain = await refresh(deps, latePlain);
    expect(await answer(plain)).toBe("401/refresh_expired");
    expect(await trail(db, u.accountId)).toContain("refresh_expired(superseded)x1");
    expect(await familyRevoked(db, u.sessionId)).toBe(false);
  });
});

/**
 * THE SWEEP SAYS WHY, AND ONLY THE SWEEP. Its own 401 carries `details.cause` on both branches, the
 * cookie one still clearing the jar without Clear-Site-Data; the swept family's tail and an unknown
 * token answer as they always did, so the door tells nobody whether a token was ever minted.
 */
describe("the sweep's own refusal names its cause", () => {
  it("cookie branch: the cause, the jar cleared, no Clear-Site-Data; the tail and an unknown token carry none", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    const tail = setCookieMap(await refresh(deps, j.refresh, "w-legit-1")).tf_refresh!;
    clock.advance(5 * MIN);
    const swept = await refresh(deps, j.refresh, "w-other");
    expect(swept.status).toBe(401);
    expect(await envelope(swept)).toEqual(REUSE);
    expect(cookieMaxAge(swept, "tf_refresh"), "the jar keeps a swept token").toBe(0);
    expect(swept.headers.get("clear-site-data")).toBeNull();
    for (const later of [tail, generateToken()]) {
      const res = await refresh(deps, later, "w-later");
      expect(res.status).toBe(401);
      expect(await envelope(res)).toEqual(PLAIN);
    }
  });

  it("native branch: the sweep's 401 carries the same cause", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    const native = (name: string): Promise<Response> =>
      H(req("POST", "/auth/refresh", { body: JSON.stringify({ refreshToken: j.refresh, attemptId: name }) }), deps);
    expect((await native("n-1")).status).toBe(200);
    const swept = await native("n-2");
    expect(swept.status).toBe(401);
    expect(await envelope(swept)).toEqual(REUSE);
  });
});
