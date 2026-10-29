import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { refreshTokens, sessions } from "@trafficflow/db";
import { authEvents } from "@trafficflow/db/cloud";
import { generateToken, hashToken, type Db } from "@trafficflow/services";
import { makeDeps, seedSession, req, setCookieMap, FIXED_NOW } from "./helpers.js";

/**
 * A BROWSER NAMES ITS ROTATION. The cookie branch of `POST /auth/refresh` reads the body's `attemptId`,
 * the native branch's field, so a renewal whose answer never landed and comes back past the 60 s grace
 * under the SAME name is re-admitted instead of swept. With no name, another name, or after the chain
 * moved on it is still a reuse. Over the real route table on PGlite; the arm on Postgres is
 * `packages/services/test/refresh-retry-attempt.pg.test.ts`.
 */

const real = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => real.handle(r, { ...d, session: null, idempotency: null });

/** A refresh row in the SESSION'S OWN family, as `establish` writes it. */
async function jarFor(db: Db, now: Date): Promise<{ refresh: string; accountId: string; familyId: string }> {
  const s = await seedSession(db, { now });
  const [row] = await db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, s.sessionId));
  const refresh = generateToken();
  await db.insert(refreshTokens).values({
    accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: row!.familyId,
    tokenHash: hashToken(refresh), expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000), createdAt: now,
  });
  return { refresh, accountId: s.accountId, familyId: row!.familyId };
}

const refresh = (deps: ApiDeps, token: string, body?: string): Promise<Response> =>
  H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${token}`, ...(body === undefined ? {} : { body }) }), deps);
const named = (attemptId: unknown): string => JSON.stringify({ attemptId });

async function codeOf(res: Response): Promise<string | undefined> {
  try {
    return ((await res.clone().json()) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

async function revoked(db: Db, familyId: string): Promise<boolean> {
  const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
  return rows.every((r) => r.revokedAt !== null);
}

async function eventsOf(db: Db, accountId: string): Promise<string[]> {
  return (await db.select().from(authEvents).where(and(eq(authEvents.accountId, accountId)))).map((e) => e.event);
}

describe("POST /auth/refresh, cookie branch: a browser names its rotation", () => {
  it("a lost answer retried 117 s later under the SAME name is re-admitted, and the jar it gets works", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    const lost = await refresh(deps, j.refresh, named("w-one"));
    expect(lost.status, "the rotation whose answer never landed").toBe(204);

    clock.advance(117_000);
    const back = await refresh(deps, j.refresh, named("w-one"));
    expect(back.status, "the retry under its own name is answered").toBe(204);
    const fresh = setCookieMap(back).tf_refresh!;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(j.refresh);
    expect(await revoked(db, j.familyId), "the family survives its lost answer").toBe(false);
    const events = await eventsOf(db, j.accountId);
    expect(events).toContain("refresh_replayed");
    expect(events).not.toContain("refresh_reuse_revoked");

    clock.advance(61_000);
    expect((await refresh(deps, fresh, named("w-two"))).status, "the re-admitted line rotates on").toBe(204);
  });

  it("THE BASE SHAPE, for a client that names nothing: the same retry is swept and the jar cleared", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    expect((await refresh(deps, j.refresh)).status).toBe(204);
    clock.advance(117_000);
    const back = await refresh(deps, j.refresh);
    expect(back.status).toBe(401);
    expect(await codeOf(back)).toBe("refresh_revoked");
    expect(setCookieMap(back).tf_refresh, "a refused jar is cleared").toBe("");
    expect(await revoked(db, j.familyId)).toBe(true);
    expect(await eventsOf(db, j.accountId)).toContain("refresh_reuse_revoked");
  });

  it("another name on the spent token is theft, and it is swept", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    expect((await refresh(deps, j.refresh, named("w-one"))).status).toBe(204);
    clock.advance(117_000);
    const back = await refresh(deps, j.refresh, named("w-guessed"));
    expect(back.status).toBe(401);
    expect(await codeOf(back)).toBe("refresh_revoked");
    expect(await revoked(db, j.familyId)).toBe(true);
  });

  it("USE BEATS THE NAME: the same name after the chain moved on under another is swept", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    const first = await refresh(deps, j.refresh, named("w-one"));
    const next = setCookieMap(first).tf_refresh!;
    clock.advance(5_000);
    expect((await refresh(deps, next, named("w-two"))).status, "the browser got its answer and rotated on").toBe(204);
    clock.advance(117_000);
    const replay = await refresh(deps, j.refresh, named("w-one"));
    expect(replay.status, "a captured token and name, replayed").toBe(401);
    expect(await codeOf(replay)).toBe("refresh_revoked");
    expect(await revoked(db, j.familyId)).toBe(true);
  });

  it("a malformed name is refused 400 before anything is spent, and the jar is not cleared", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    for (const bad of [named(7), named(""), named("x".repeat(129))]) {
      const res = await refresh(deps, j.refresh, bad);
      expect(res.status, bad.slice(0, 40)).toBe(400);
      expect(await codeOf(res)).toBe("validation_failed");
      expect(setCookieMap(res).tf_refresh, "a request refusal clears nothing").toBeUndefined();
    }
    expect((await refresh(deps, j.refresh, named("w-ok"))).status, "the token was never spent").toBe(204);
  });

  it("a body that is not JSON is refused 400, and the jar is not cleared", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    const res = await refresh(deps, j.refresh, "{not json");
    expect(res.status).toBe(400);
    expect(setCookieMap(res).tf_refresh).toBeUndefined();
    expect((await refresh(deps, j.refresh)).status, "the token was never spent").toBe(204);
  });
});

const TIERS = [["Cloud", apiRoutes], ["self-host", selfHostRoutes]] as const;
const doorOf = (table: typeof apiRoutes) => table.find((r) => r.method === "POST" && r.pattern === "/auth/refresh");

async function liveTails(db: Db, familyId: string): Promise<number> {
  const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
  return rows.filter((r) => r.consumedAt === null && r.revokedAt === null).length;
}

/* A BROWSER KILLED BEFORE IT STORED ITS RENEWED COOKIE comes back holding the spent token. The web client
 * keeps the name it went out under past the 204, so the restart presents it under that name. */
describe.each(TIERS)("POST /auth/refresh on %s: a browser killed before it stored the renewed cookie", (_tier, table) => {
  const app = createApp(table);
  const post = (deps: ApiDeps, token: string, body: string): Promise<Response> =>
    app.handle(req("POST", "/auth/refresh", { cookie: `tf_refresh=${token}`, body }), { ...deps, session: null, idempotency: null });

  it("the spent token back 76 s later under the name it went out with gets one live successor", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    expect((await post(deps, j.refresh, named("w-before-kill"))).status, "the answer the browser never stored").toBe(204);
    clock.advance(76_000);
    const back = await post(deps, j.refresh, named("w-before-kill"));
    expect(back.status).toBe(204);
    expect(await revoked(db, j.familyId)).toBe(false);
    expect(await liveTails(db, j.familyId), "the unused successor is dead, one line lives").toBe(1);
    expect(await eventsOf(db, j.accountId)).not.toContain("refresh_reuse_revoked");
    clock.advance(61_000);
    expect((await post(deps, setCookieMap(back).tf_refresh!, named("w-next"))).status, "it rotates on").toBe(204);
  });

  it("two restored tabs presenting it back to back under the name: both answered, one live successor", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    expect((await post(deps, j.refresh, named("w-before-kill"))).status).toBe(204);
    clock.advance(76_000);
    expect((await post(deps, j.refresh, named("w-before-kill"))).status).toBe(204);
    expect((await post(deps, j.refresh, named("w-before-kill"))).status, "a kill under the name is not a spend").toBe(204);
    expect(await revoked(db, j.familyId)).toBe(false);
    expect(await liveTails(db, j.familyId)).toBe(1);
  });

  it("a token two rotations back, under a name the jar spent its next token with too, is swept", async () => {
    const { db, deps, clock } = await makeDeps(FIXED_NOW);
    const j = await jarFor(db, clock.now());
    const t1 = setCookieMap(await post(deps, j.refresh, named("w-reused"))).tf_refresh!;
    clock.advance(30_000);
    expect((await post(deps, t1, named("w-reused"))).status, "the next token spent under the same name").toBe(204);
    clock.advance(117_000);
    const stale = await post(deps, j.refresh, named("w-reused"));
    expect(stale.status, "the chain moved on: a real spend under the name counts").toBe(401);
    expect(await codeOf(stale)).toBe("refresh_revoked");
    expect(await revoked(db, j.familyId)).toBe(true);
    expect(await eventsOf(db, j.accountId)).toContain("refresh_reuse_revoked");
  });
});

it("Cloud and self-host mount the same /auth/refresh route object", () => {
  expect(doorOf(selfHostRoutes)).toBeDefined();
  expect(doorOf(selfHostRoutes)).toBe(doorOf(apiRoutes));
});
