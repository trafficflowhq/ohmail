import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createApp, apiRoutes, csrfTokenFor, type ApiDeps } from "@trafficflow/api";
import { refreshTokens, sessions } from "@trafficflow/db";
import { authEvents } from "@trafficflow/db/cloud";
import { AuthService, generateToken, hashToken, makeTestAuthDeps, type Db } from "@trafficflow/services";
import { ServiceError } from "@trafficflow/services/mail";
import { makeDeps, seedSession, req, setCookieMap, FIXED_NOW } from "./helpers.js";

/**
 * THE WEB'S SIGN-OUT ENDS THE FAMILY THE JAR'S REFRESH COOKIE NAMES. One tab renews and its
 * answer is lost, so the jar keeps a replaced `tf_session` and a spent `tf_refresh`; Sign out in
 * another tab then pressed `/auth/logout`, which 401s at `withSession` before its handler, and the
 * resume splash signed the browser back in through the grace. The door below the refresh path
 * receives the cookie that still names the family. Driven over the real route table on PGlite;
 * the transactional half is `packages/services/test/logout-by-refresh.pg.test.ts`.
 */

const real = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => real.handle(r, { ...d, session: null, idempotency: null });

/** Every name a cleared jar is told to drop. */
const CLEARED = ["tf_csrf", "tf_family", "tf_owner", "tf_refresh", "tf_resume", "tf_session"];

interface Jar { access: string; refresh: string }

/** A refresh row in the SESSION'S OWN family, as `establish` writes it. */
async function jarFor(db: Db, now: Date): Promise<Jar & { accountId: string; familyId: string }> {
  const s = await seedSession(db, { now });
  const [row] = await db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, s.sessionId));
  const refresh = generateToken();
  await db.insert(refreshTokens).values({
    accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: row!.familyId,
    tokenHash: hashToken(refresh), expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000), createdAt: now,
  });
  return { access: s.token, refresh, accountId: s.accountId, familyId: row!.familyId };
}

/** What a browser sends below `/auth/refresh`: every cookie, and the CSRF header `api()` adds. */
const atRefreshPath = (j: Jar) => ({
  cookie: `tf_session=${j.access}; tf_refresh=${j.refresh}; tf_csrf=${csrfTokenFor(j.access)}`,
  headers: { "x-csrf-token": csrfTokenFor(j.access) },
});
/** …and anywhere else: `tf_refresh` is `Path=/auth/refresh`, so it is not sent. */
const elsewhere = (j: Jar) => ({
  cookie: `tf_session=${j.access}; tf_csrf=${csrfTokenFor(j.access)}`,
  headers: { "x-csrf-token": csrfTokenFor(j.access) },
});

const clearFor = (jar: Jar, family: string) => {
  const wire = atRefreshPath(jar);
  return req("POST", "/auth/refresh/logout", {
    cookie: `${wire.cookie}; tf_owner=signed_out_pending; tf_family=${family}`,
    headers: { ...wire.headers, "X-Ohmail-Clear-Logout": "1", "X-Ohmail-Expected-Family": family },
  });
};

async function codeOf(res: Response): Promise<{ code?: string; message?: string }> {
  try {
    return ((await res.clone().json()) as { error?: { code?: string; message?: string } }).error ?? {};
  } catch {
    return {};
  }
}

function expectCleared(res: Response, what: string): void {
  const lines = res.headers.getSetCookie();
  expect(lines.map((l) => l.split("=")[0]).sort(), `${what}: the cleared names`).toEqual(CLEARED);
  for (const l of lines) {
    expect(l, what).toMatch(/Max-Age=0/);
    expect(l, what).not.toMatch(/Domain=/i);
  }
  expect(lines.find((l) => l.startsWith("tf_refresh=")), `${what}: the refresh clear keeps its path`)
    .toMatch(/Path=\/auth\/refresh(;|$)/);
  // Chrome holds an answer carrying the cache clear, its cookie clears too, for a walk of its whole
  // disk cache: the press gave up at its deadline and named a confirmed sign-out unconfirmed.
  expect(res.headers.get("clear-site-data"), `${what}: held for a cache walk`).toBeNull();
}

async function reuseRows(db: Db, accountId: string): Promise<number> {
  const rows = await db.select({ id: authEvents.id }).from(authEvents)
    .where(and(eq(authEvents.accountId, accountId), eq(authEvents.event, "refresh_reuse_revoked")));
  return rows.length;
}

/** Tab 1's renewal: 204 with the successor jar, which a lost answer keeps from the browser. */
async function rotate(deps: ApiDeps, j: Jar): Promise<Jar> {
  const res = await H(req("POST", "/auth/refresh", atRefreshPath(j)), deps);
  expect(res.status, "the renewal the defect needs").toBe(204);
  const set = setCookieMap(res);
  return { access: set.tf_session!, refresh: set.tf_refresh! };
}

describe("a sign-out after another tab lost its renewal answer", () => {
  it("the stale jar at the door revokes the family; neither jar signs back in", async () => {
    const { db, deps, clock } = await makeDeps();
    const stale = await jarFor(db, FIXED_NOW);
    const successor = await rotate(deps, stale);

    clock.advance(1_000);
    const out = await H(req("POST", "/auth/refresh/logout", atRefreshPath(stale)), deps);
    expect(out.status, JSON.stringify(await codeOf(out))).toBe(204);
    expect(out.headers.getSetCookie()).toEqual([]);
    expectCleared(await H(clearFor(stale, stale.familyId), deps), "the stale family's serialized clear");

    // Inside the grace, where the resume splash used to converge the spent token into a mint.
    clock.advance(4_000);
    const back = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${stale.refresh}` }), deps);
    expect(back.status).toBe(401);
    expect(await codeOf(back)).toEqual({ code: "refresh_revoked", message: "invalid refresh token" });
    expect(setCookieMap(back).tf_session, "no session was minted").toBe("");
    const tail = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${successor.refresh}` }), deps);
    expect(tail.status).toBe(401);
    expect((await codeOf(tail)).message).toBe("invalid refresh token");
    for (const access of [stale.access, successor.access]) {
      expect((await H(req("GET", "/auth/session", { bearer: access }), deps)).status).toBe(401);
    }
    expect(await reuseRows(db, stale.accountId), "a sign-out is not a theft").toBe(0);
  });

  it("BASE SHAPE, kept as a statement: `/auth/logout` never sees the family, and the grace mints", async () => {
    const { db, deps, clock } = await makeDeps();
    const stale = await jarFor(db, FIXED_NOW);
    await rotate(deps, stale);

    clock.advance(1_000);
    const out = await H(req("POST", "/auth/logout", { ...elsewhere(stale), body: "{}" }), deps);
    expect(out.status, "the replaced access token is refused before the handler").toBe(401);

    clock.advance(4_000);
    const back = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${stale.refresh}` }), deps);
    expect(back.status, "the web's old door left the family live: the browser signs back in").toBe(204);
    expect(setCookieMap(back).tf_session).toBeTruthy();
  });
});

describe("the ordinary sign-out through the door", () => {
  it("a live jar: 204, the jar cleared, the family revoked, one `logout` row", async () => {
    const { db, deps } = await makeDeps();
    const live = await jarFor(db, FIXED_NOW);
    const out = await H(req("POST", "/auth/refresh/logout", atRefreshPath(live)), deps);
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()).toEqual([]);
    expectCleared(await H(clearFor(live, live.familyId), deps), "the revoked family's serialized clear");

    expect((await H(req("GET", "/auth/session", { bearer: live.access }), deps)).status).toBe(401);
    // A saved copy of the jar is refused plainly: the revoked family never reaches the sweep.
    const copy = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${live.refresh}` }), deps);
    expect(copy.status).toBe(401);
    expect((await codeOf(copy)).message).toBe("invalid refresh token");
    const events = await db.select({ event: authEvents.event, device: authEvents.device }).from(authEvents)
      .where(eq(authEvents.accountId, live.accountId));
    expect(events.filter((e) => e.event === "logout")).toEqual([
      { event: "logout", device: expect.stringMatching(new RegExp(`^family=${live.familyId} session=\\S+ by=refresh$`)) },
    ]);
    expect(events.filter((e) => e.event === "refresh_reuse_revoked")).toEqual([]);
  });

  it("a LIVE session still needs its CSRF header, and a refused press revokes nothing", async () => {
    const { db, deps } = await makeDeps();
    const live = await jarFor(db, FIXED_NOW);
    const bare = await H(req("POST", "/auth/refresh/logout", { cookie: atRefreshPath(live).cookie }), deps);
    expect(bare.status).toBe(403);
    expect((await codeOf(bare)).code).toBe("csrf_failed");
    expect(bare.headers.getSetCookie(), "a refused press keeps the jar").toEqual([]);
    // CONTROL: the family is alive — the same cookie still renews.
    expect((await H(req("POST", "/auth/refresh", atRefreshPath(live)), deps)).status).toBe(204);
  });

  it("a jar that names nothing: our 401 and no cookie write", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("POST", "/auth/refresh/logout"), deps);
    expect(res.status).toBe(401);
    expect((await codeOf(res)).code).toBe("unauthorized");
    expect(res.headers.getSetCookie()).toEqual([]);
    // A token never minted names nothing: 401, nothing revoked. One ever minted answers 204 in any
    // state and ends its family — the door tells a holder whether the token in hand was minted.
    const unknown = await H(req("POST", "/auth/refresh/logout", { cookie: `tf_refresh=${generateToken()}` }), deps);
    expect(unknown.status).toBe(401);
    expect(await codeOf(unknown)).toEqual({ code: "unauthorized", message: "nothing to sign out" });
    expect(unknown.headers.getSetCookie()).toEqual([]);
  });

  it("a FAULT keeps the jar, so the retry has the cookie to present", async () => {
    const { db, deps } = await makeDeps();
    const live = await jarFor(db, FIXED_NOW);
    const failing = (thrown: unknown): ApiDeps => ({
      ...deps,
      services: {
        ...deps.services,
        auth: new Proxy(deps.services!.auth!, {
          get: (t, k) => (k === "logout" ? async () => { throw thrown; } : Reflect.get(t, k)),
        }),
      },
    } as ApiDeps);
    for (const thrown of [new Error("driver down"), new ServiceError("db_busy", 503, "busy", undefined, true)]) {
      const res = await H(req("POST", "/auth/refresh/logout", atRefreshPath(live)), failing(thrown));
      expect(res.status, String(thrown)).toBeGreaterThanOrEqual(500);
      expect(res.headers.getSetCookie(), `${String(thrown)}: a fault cleared the jar`).toEqual([]);
    }
    // CONTROL: the press that follows, with nothing failing, ends the session.
    expect((await H(req("POST", "/auth/refresh/logout", atRefreshPath(live)), deps)).status).toBe(204);
  });

  it("a sign-out during enrollment ends that session too (the door is `enrollmentOk`)", async () => {
    const { db, deps } = await makeDeps();
    const enrolling = await seedSession(db, { now: FIXED_NOW, scope: "enrollment" });
    expect((await H(req("GET", "/auth/session", { bearer: enrolling.token }), deps)).status,
      "CONTROL: the enrollment session is live").toBe(200);
    // An enrollment jar holds no `tf_refresh`, so the resolved session is all the door can end.
    const out = await H(req("POST", "/auth/refresh/logout", {
      cookie: `tf_session=${enrolling.token}; tf_csrf=${csrfTokenFor(enrolling.token)}`,
      headers: { "x-csrf-token": csrfTokenFor(enrolling.token) },
    }), deps);
    expect(out.status, JSON.stringify(await codeOf(out))).toBe(204);
    expect(out.headers.getSetCookie()).toEqual([]);
    const [row] = await db.select({ revokedAt: sessions.revokedAt, familyId: sessions.familyId }).from(sessions)
      .where(eq(sessions.id, enrolling.sessionId));
    const clear = await H(req("POST", "/auth/refresh/logout", {
      cookie: `tf_session=${enrolling.token}; tf_owner=signed_out_pending; tf_family=${row!.familyId}`,
      headers: { "X-Ohmail-Clear-Logout": "1", "X-Ohmail-Expected-Family": row!.familyId },
    }), deps);
    expect(clear.status).toBe(204);
    expectCleared(clear, "the enrollment family's serialized clear");
    expect(row!.revokedAt, "the enrollment session outlived its sign-out").toBeInstanceOf(Date);
    expect((await H(req("GET", "/auth/session", { bearer: enrolling.token }), deps)).status).toBe(401);
  });

  it("a FAILING wake prune never undoes the sign-out: 204, the family revoked, the failure logged once", async () => {
    const { db, deps, mail } = await makeDeps();
    const live = await jarFor(db, FIXED_NOW);
    class PruneDown extends AuthService {
      protected override async pruneWakeRegistrations(): Promise<void> {
        throw new Error("push table unreachable");
      }
    }
    const pruneDown = { ...deps, services: { ...deps.services, auth: new PruneDown({ ...makeTestAuthDeps(), mail }) } };
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const out = await H(req("POST", "/auth/refresh/logout", atRefreshPath(live)), pruneDown as ApiDeps);
      expect(out.status, JSON.stringify(await codeOf(out))).toBe(204);
      expect(out.headers.getSetCookie()).toEqual([]);
      expectCleared(await H(clearFor(live, live.familyId), deps), "the clear after a failed prune");
      expect(logged.mock.calls.filter((c) => String(c[0]).includes("\"event\":\"auth_logout_wake_prune_failed\"")))
        .toHaveLength(1);
    } finally {
      logged.mockRestore();
    }
    expect((await H(req("GET", "/auth/session", { bearer: live.access }), deps)).status).toBe(401);
    const copy = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${live.refresh}` }), deps);
    expect(copy.status, "the family survived a failed prune").toBe(401);
  });

  it("a body token that is not a string is refused, and nothing is cleared", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("POST", "/auth/refresh/logout", { body: JSON.stringify({ refreshToken: 42 }) }), deps);
    expect(res.status).toBe(400);
    expect((await codeOf(res)).code).toBe("validation_failed");
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("`/auth/logout` keeps its own arms", () => {
  it("a `refreshToken` in its body names nothing: only the session's own family ends", async () => {
    const { db, deps } = await makeDeps();
    const mine = await jarFor(db, FIXED_NOW);
    const other = await jarFor(db, FIXED_NOW);
    const res = await H(req("POST", "/auth/logout", {
      bearer: mine.access, body: JSON.stringify({ refreshToken: other.refresh }),
    }), deps);
    expect(res.status).toBe(204);
    expect((await H(req("GET", "/auth/session", { bearer: mine.access }), deps)).status).toBe(401);
    // The other family was never this door's to end.
    expect((await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${other.refresh}` }), deps)).status).toBe(204);
  });
});


it("a sign-out for a different family leaves the current browser session intact", async () => {
  const { db, deps } = await makeDeps();
  const confirmed = await jarFor(db, FIXED_NOW);
  const current = await jarFor(db, FIXED_NOW);
  const out = await H(req("POST", "/auth/refresh/logout", {
    cookie: `tf_refresh=${current.refresh}`,
    headers: { "X-Ohmail-Expected-Family": confirmed.familyId },
  }), deps);
  expect(out.status).toBe(409);
  expect(out.headers.has("set-cookie")).toBe(false);
  expect((await H(req("GET", "/auth/session", elsewhere(current)), deps)).status).toBe(200);
});

it("the account a browser request expects must match before a write handler runs", async () => {
  const { db, deps } = await makeDeps();
  const current = await jarFor(db, FIXED_NOW);
  const handler = vi.fn(async () => new Response(null, { status: 204 }));
  const app = createApp([{ method: "POST", pattern: "/write", relay: true, cost: "ceremony", handler }]);
  const wire = elsewhere(current);
  const res = await app.handle(req("POST", "/write", {
    ...wire,
    headers: { ...wire.headers, "X-Ohmail-Expected-Account": "other-account" },
  }), { ...deps, session: null, idempotency: null });
  expect(res.status).toBe(409);
  expect(handler).not.toHaveBeenCalled();
});


it("a renewal for another account leaves the presented family usable", async () => {
  const { db, deps } = await makeDeps();
  const current = await jarFor(db, FIXED_NOW);
  const cookie = `tf_refresh=${current.refresh}`;
  const refused = await H(req("POST", "/auth/refresh", {
    cookie,
    headers: { "X-Ohmail-Expected-Account": "other-account" },
  }), deps);
  expect(refused.status).toBe(409);
  expect(refused.headers.has("set-cookie")).toBe(false);

  const renewed = await H(req("POST", "/auth/refresh", {
    cookie,
    headers: { "X-Ohmail-Expected-Account": current.accountId, "X-Ohmail-Expected-Family": current.familyId },
  }), deps);
  expect(renewed.status).toBe(204);
  expect(renewed.headers.get("X-Ohmail-Account")).toBe(current.accountId);
  expect(setCookieMap(renewed).tf_family).toBe(current.familyId);
});

it("a background sign-out only revokes the confirmed family", async () => {
  const { db, deps } = await makeDeps();
  const current = await jarFor(db, FIXED_NOW);
  const res = await H(req("POST", "/auth/refresh/logout", {
    cookie: `tf_refresh=${current.refresh}`,
    headers: {
      "X-Ohmail-Expected-Family": current.familyId,
    },
  }), deps);
  expect(res.status).toBe(204);
  expect(res.headers.has("set-cookie")).toBe(false);
  expect((await H(req("GET", "/auth/session", elsewhere(current)), deps)).status).toBe(401);
});


it("the clear refuses a live or replaced family without revoking it", async () => {
  const { db, deps } = await makeDeps();
  const original = await jarFor(db, FIXED_NOW);
  const replacement = await jarFor(db, FIXED_NOW);
  for (const call of [clearFor(original, original.familyId), clearFor(replacement, original.familyId)]) {
    const res = await H(call, deps);
    expect(res.status).toBe(409);
    expect(res.headers.getSetCookie()).toEqual([]);
  }
  expect((await H(req("GET", "/auth/session", elsewhere(original)), deps)).status).toBe(200);
  expect((await H(req("GET", "/auth/session", elsewhere(replacement)), deps)).status).toBe(200);
});

it("requires the captured account when browser logout has only the access cookie", async () => {
  const { db, deps } = await makeDeps();
  const current = await jarFor(db, FIXED_NOW);
  const prior = await jarFor(db, FIXED_NOW);
  const wire = elsewhere(current);
  const request = (account: string) => req("POST", "/auth/refresh/logout", {
    ...wire,
    headers: {
      ...wire.headers,
      "X-Ohmail-Expected-Family": current.familyId,
      "X-Ohmail-Expected-Account": account,
    },
  });
  const refusal = await H(request(prior.accountId), deps);
  expect(refusal.status).toBe(409);
  expect(refusal.headers.getSetCookie()).toEqual([]);
  expect((await H(req("GET", "/auth/session", wire), deps)).status).toBe(200);

  const accepted = await H(request(current.accountId), deps);
  expect(accepted.status).toBe(204);
  expect(accepted.headers.getSetCookie()).toEqual([]);
});
