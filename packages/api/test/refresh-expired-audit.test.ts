import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { refreshTokens, sessions } from "@trafficflow/db";
import { authEvents } from "@trafficflow/db/cloud";
import { generateToken, hashToken, type Db } from "@trafficflow/services";
import { makeDeps, seedSession, req, setCookieMap, FIXED_NOW } from "./helpers.js";

/**
 * A SIGN-OUT NOBODY REVOKED IS COUNTED. `refresh_expired` used to answer and record nothing, so the
 * late-answer shape (two presentations of one token, the first rotation's answer landing last, the
 * jar then idle past the grace) signed a browser out with no row anywhere. It now writes
 * `refresh_expired` with `cause=superseded` or `cause=lapsed`, naming the family and never a token,
 * and a bookkeeping fault never turns the refusal into a 500.
 */

const real = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => real.handle(r, { ...d, session: null, idempotency: null });

/** A refresh row in the SESSION'S OWN family, as `establish` writes it: one window on both, seen at `now`. */
async function jarFor(
  db: Db, now: Date, windowMs = 2 * 60 * 60 * 1000,
): Promise<{ refresh: string; accountId: string; familyId: string; sessionId: string }> {
  const s = await seedSession(db, { now });
  const expiresAt = new Date(now.getTime() + windowMs);
  // `seedSession` leaves last_seen_at at the database's clock, which the reaper would read.
  await db.update(sessions).set({ lastSeenAt: now, refreshExpiresAt: expiresAt }).where(eq(sessions.id, s.sessionId));
  const [row] = await db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, s.sessionId));
  const refresh = generateToken();
  await db.insert(refreshTokens).values({
    accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: row!.familyId,
    tokenHash: hashToken(refresh), expiresAt, createdAt: now,
  });
  return { refresh, accountId: s.accountId, familyId: row!.familyId, sessionId: s.sessionId };
}

const refresh = (deps: ApiDeps, token: string): Promise<Response> =>
  H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${token}` }), deps);

async function codeOf(res: Response): Promise<string | undefined> {
  try {
    return ((await res.clone().json()) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

async function expiredRows(db: Db, accountId: string): Promise<Array<string | null>> {
  return (await db.select().from(authEvents)
    .where(and(eq(authEvents.accountId, accountId), eq(authEvents.event, "refresh_expired"))))
    .map((e) => e.device);
}

describe("POST /auth/refresh: an expiry refusal is recorded", () => {
  it("THE LATE ANSWER: a superseded token presented 70 s later is refused AND counted, and the family lives", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    const first = await refresh(deps, j.refresh);
    const late = setCookieMap(first).tf_refresh!;
    const second = await refresh(deps, j.refresh);
    expect(second.status, "the second presentation converges in the grace").toBe(204);
    const live = setCookieMap(second).tf_refresh!;

    clock.advance(70_000);
    const res = await refresh(deps, late);
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("refresh_expired");
    const rows = await expiredRows(db, j.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe(`family=${j.familyId} session=${rows[0]!.match(/session=(\S+)/)![1]} cause=superseded`);
    for (const token of [j.refresh, late, live]) expect(rows[0], "a token reached the row").not.toContain(token);
    expect((await refresh(deps, live)).status, "nothing was revoked: the live line rotates on").toBe(204);
  });

  it("a token whose rolling window closed is refused and counted as lapsed", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    clock.advance(2 * 60 * 60 * 1000 + 60_000);
    const res = await refresh(deps, j.refresh);
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("refresh_expired");
    const rows = await expiredRows(db, j.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^family=\S+ session=\S+ cause=lapsed$/);
  });

  it("a fault writing the row leaves the refusal as it was: 401, never a 500", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const auth = deps.services!.auth as unknown as { audit: (...a: unknown[]) => Promise<void> };
    vi.spyOn(auth, "audit").mockRejectedValue(new Error("the audit sink is unreachable"));
    const j = await jarFor(db, clock.now());
    clock.advance(2 * 60 * 60 * 1000 + 60_000);
    const res = await refresh(deps, j.refresh);
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("refresh_expired");
  });
});

const DAY = 24 * 60 * 60 * 1000;
const SECRET = "s".repeat(32);

describe("the reaper keeps the 90-day window, and a jar it reaped hears expired", () => {
  it.each([["Cloud", apiRoutes], ["self-host", selfHostRoutes]])("%s", async (_host, routes) => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const app = createApp(routes);
    const armed: ApiDeps = { ...deps, alerts: { secret: SECRET, sinks: [] }, session: null, idempotency: null };
    const send = (r: Request): Promise<Response> => app.handle(r, armed);
    const usedDaysAgo = (d: number) => jarFor(db, new Date(clock.now().getTime() - d * DAY), 90 * DAY);
    const a = await usedDaysAgo(91);
    const b = await usedDaysAgo(61);

    const reap = await send(req("GET", "/internal/sessions/reap", { bearer: SECRET }));
    expect(((await reap.json()) as { reaped?: number }).reaped).toBe(1);
    expect((await send(req("POST", "/auth/refresh", { cookie: `tf_refresh=${b.refresh}` }))).status, "29 days left").toBe(204);
    const res = await send(req("POST", "/auth/refresh", { cookie: `tf_refresh=${a.refresh}` }));
    expect([res.status, await codeOf(res)]).toEqual([401, "refresh_expired"]);
    expect(await expiredRows(db, a.accountId)).toEqual([`family=${a.familyId} session=${a.sessionId} cause=lapsed`]);
  });
});
