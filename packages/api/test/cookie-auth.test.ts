import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, jsonResponse, type ApiDeps, type Route, csrfTokenFor } from "@trafficflow/api";
import { refreshTokens } from "@trafficflow/db";
import { hashToken, generateToken, type Db } from "@trafficflow/services";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * `ApiDeps.allowCookieAuth` — the mechanism the two API hosts differ by.
 *
 * ONE deployment serves both surfaces:
 *   • `api.ohmail.app`, behind the webapp's same-origin rewrite, where `tf_session` is a
 *     genuinely FIRST-PARTY cookie and the double-submit CSRF guard applies;
 *   • `api.ohmail.app`, the native/desktop surface, where the only credential is a bearer
 *     token from the OAuth2 PKCE flow. There the cookie must be IGNORED, which makes
 *     `withCsrf` unreachable by construction (`via` can never be `"cookie"`) rather than
 *     merely unnecessary.
 *
 * The host split wires the hosts; the mechanism and its teeth land here. Absent or `true` is the
 * historical behaviour, which is why no earlier test changed.
 */
const echo: Route["handler"] = async (_req, deps) =>
  jsonResponse({ via: deps.session?.via ?? null, accountId: deps.session?.accountId ?? null });

const routes: Route[] = [
  { method: "GET", pattern: "/me", handler: echo },
  { method: "POST", pattern: "/write", handler: echo },
];
const app = createApp(routes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, d);

describe("allowCookieAuth — default (absent / true) accepts either transport", () => {
  it("absent: a cookie authenticates", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("GET", "/me", { cookie: `tf_session=${s.token}` }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "cookie", accountId: s.accountId });
  });

  it("explicit true: a cookie authenticates", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("GET", "/me", { cookie: `tf_session=${s.token}` }), { ...deps, allowCookieAuth: true });
    expect(await res.json()).toEqual({ via: "cookie", accountId: s.accountId });
  });
});

describe("an EXPLICIT bearer outranks an AMBIENT cookie, on a dual-mode host", () => {
  /**
   * The precedence used to be the other way round — cookie first, header only when no cookie
   * was present — which is the classic ambient-authority bug. A browser sends a cookie whether
   * or not anyone meant to; an `Authorization` header is something a caller typed. When both
   * arrive naming DIFFERENT users, honouring the ambient one authenticates the request as
   * somebody the caller never asked to be, with a 200 and no error anywhere.
   *
   * It was unreachable while the host split kept cookie traffic and bearer traffic on
   * different registrable domains. The move to a single `ohmail.app` puts both on
   * `api.ohmail.app` — the webapp's `/api` rewrite sends cookies, native and scripted clients
   * send bearers — so a jar holding a stale or different-user `tf_session` is now ordinary.
   */
  it("resolves as the BEARER's user when a cookie names somebody else", async () => {
    const { db, deps } = await makeDeps();
    const cookieUser = await seedSession(db, { now: FIXED_NOW });
    const bearerUser = await seedSession(db, { now: FIXED_NOW });
    expect(cookieUser.accountId).not.toBe(bearerUser.accountId);

    const res = await H(
      req("GET", "/me", { cookie: `tf_session=${cookieUser.token}`, bearer: bearerUser.token }),
      // `allowCookieAuth` absent = the dual-mode host, where both credentials are accepted.
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "bearer", accountId: bearerUser.accountId });
  });

  it("a cookie-only browser request is untouched by the reordering", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("GET", "/me", { cookie: `tf_session=${s.token}` }), deps);
    expect(await res.json()).toEqual({ via: "cookie", accountId: s.accountId });
  });

  it("an EMPTY `Authorization: Bearer` is not a credential, and does not shadow the cookie", async () => {
    // Preferring the header must not mean "a malformed header 401s a working session".
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(
      req("GET", "/me", { cookie: `tf_session=${s.token}`, headers: { authorization: "Bearer   " } }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "cookie", accountId: s.accountId });
  });
});

describe("allowCookieAuth: false — the bearer-only host (api.ohmail.app)", () => {
  it("401s a cookie-only request that the SAME session would pass as a bearer", async () => {
    // Both halves matter: the 401 proves the cookie was not consulted, and the 200 proves
    // the session itself is perfectly valid — so the refusal is about the TRANSPORT.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const bearerOnly: ApiDeps = { ...deps, allowCookieAuth: false };

    const viaCookie = await H(req("GET", "/me", { cookie: `tf_session=${s.token}` }), { ...bearerOnly, session: null });
    expect(viaCookie.status).toBe(401);
    expect((await viaCookie.json()).error.code).toBe("unauthorized");

    const viaBearer = await H(req("GET", "/me", { bearer: s.token }), { ...bearerOnly, session: null });
    expect(viaBearer.status).toBe(200);
    expect(await viaBearer.json()).toEqual({ via: "bearer", accountId: s.accountId });
  });

  it("a request presenting BOTH resolves as bearer, never as cookie", async () => {
    // If the cookie were merely deprioritised, `via` would still be able to become "cookie"
    // and `withCsrf` would become reachable on a host that has no CSRF story.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW });
    const res = await H(
      req("GET", "/me", { cookie: `tf_session=${other.token}`, bearer: s.token }),
      { ...deps, allowCookieAuth: false },
    );
    const body = await res.json();
    expect(body.via).toBe("bearer");
    expect(body.accountId).toBe(s.accountId);       // the BEARER's account, not the cookie's
    expect(body.accountId).not.toBe(other.accountId);
  });

  it("a cookie-authenticated POST cannot exist there, so CSRF is unreachable, not skipped", async () => {
    // On the cookie host this same request 403s `csrf_failed`. On the bearer-only host it
    // 401s: there is no ambient credential to protect, which is the point of the design.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const onCookieHost = await H(
      req("POST", "/write", { cookie: `tf_session=${s.token}`, body: "{}" }),
      { ...deps, session: null },
    );
    expect(onCookieHost.status).toBe(403);
    expect((await onCookieHost.json()).error.code).toBe("csrf_failed");

    const onBearerHost = await H(
      req("POST", "/write", { cookie: `tf_session=${s.token}`, body: "{}" }),
      { ...deps, session: null, allowCookieAuth: false },
    );
    expect(onBearerHost.status).toBe(401);

    // …and a bearer POST needs no CSRF header on either host.
    const bearerWrite = await H(
      req("POST", "/write", { bearer: s.token, body: "{}" }),
      { ...deps, session: null, allowCookieAuth: false },
    );
    expect(bearerWrite.status).toBe(200);
  });

  it("public routes still work anonymously (a probe carries neither credential)", async () => {
    const { deps } = await makeDeps();
    const pub = createApp([{ method: "GET", pattern: "/p", options: { public: true }, handler: echo }]);
    const res = await pub.handle(req("GET", "/p"), { ...deps, allowCookieAuth: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: null, accountId: null });
  });
});

/**
 * `allowCookieAuth: false` HAS TO MEAN THE HOST REFUSES COOKIES — in and out.
 *
 * Gating `readSessionToken` alone made the flag true of ONE cookie. `POST /auth/refresh` is
 * a `public` route, so `withSession` never runs on it: it read `tf_refresh` off the header
 * on any host, rotated the family and answered with a full `sessionCookies(...)` set. And
 * every public auth completion emitted `Set-Cookie` unconditionally. The bearer-only
 * boundary therefore rested on browsers never pointing at those hosts — a deployment fact,
 * not a mechanism, and one the whole host split exists to stop relying on.
 *
 * These run against the REAL route table, so they fail if the gate is removed from either
 * side. The hosted host-split test proves the same thing again with the
 * hostname (rather than the flag) doing the selecting.
 */
describe("allowCookieAuth: false — cookie INGRESS and EGRESS are both refused", () => {
  const real = createApp(apiRoutes);

  /** A live, rotatable refresh token attached to a seeded session. */
  async function seedRefresh(db: Db, s: { accountId: string; userId: string; sessionId: string }): Promise<string> {
    const refresh = generateToken();
    await db.insert(refreshTokens).values({
      accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: randomUUID(),
      tokenHash: hashToken(refresh),
      expiresAt: new Date(FIXED_NOW.getTime() + 2 * 60 * 60 * 1000),
    });
    return refresh;
  }

  const refreshReq = (cookie: string): Request =>
    req("POST", "/auth/refresh", { cookie: `tf_refresh=${cookie}`, body: "{}" });

  it("a VALID tf_refresh cookie rotates on the cookie host and is IGNORED on the bearer host", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);

    // Bearer-only: not read at all, so the route sees "no token" → 401, and nothing is set.
    const bearerHost = await real.handle(refreshReq(refresh), { ...deps, allowCookieAuth: false });
    expect(bearerHost.status).toBe(401);
    expect(bearerHost.headers.getSetCookie()).toEqual([]);

    // The SAME cookie on a cookie host: 204 + a fresh session. That is what makes the
    // refusal above about the host rather than about the credential.
    const cookieHost = await real.handle(refreshReq(refresh), { ...deps });
    expect(cookieHost.status).toBe(204);
    expect(cookieHost.headers.getSetCookie().join("\n")).toMatch(/tf_session=/);
  });

  it("the body token still works on the bearer host — native refresh is unaffected", async () => {
    // The gate must remove the COOKIE path, not the route.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);
    const res = await real.handle(
      req("POST", "/auth/refresh", { body: JSON.stringify({ refreshToken: refresh }) }),
      { ...deps, allowCookieAuth: false },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).tokens.accessToken).toEqual(expect.any(String));
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("POST /auth/register emits NO Set-Cookie on the bearer host, and keeps the token in the body", async () => {
    // Pre-session there is no client-type signal on the wire at all — no cookie, no bearer,
    // no prior session — so only the HOST can decide the transport.
    const body = JSON.stringify({
      email: `s5-${randomUUID()}@lichtgrat.example`, password: "correct-horse-battery-password-password",
      displayName: "Gil", inviteCode: "TEST-INVITE",
    });
    const { deps } = await makeDeps(FIXED_NOW, { inviteCodes: new Set(["TEST-INVITE"]) });

    const bearerHost = await real.handle(req("POST", "/auth/register", { body }), {
      ...deps, allowCookieAuth: false,
    });
    expect(bearerHost.status).toBe(201);
    expect(bearerHost.headers.getSetCookie()).toEqual([]);
    expect((await bearerHost.json()).enrollmentToken).toEqual(expect.any(String));
  });

  it("the sign-out door on the bearer host: a tf_refresh COOKIE names nothing, the BODY token revokes", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);
    const bearerHost = { ...deps, allowCookieAuth: false };
    const revokedAt = async () => (await db.select({ at: refreshTokens.revokedAt }).from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(refresh))))[0]?.at ?? null;

    const viaCookie = await real.handle(
      req("POST", "/auth/refresh/logout", { cookie: `tf_refresh=${refresh}` }), bearerHost,
    );
    expect(viaCookie.status, "the cookie is not read here, so nothing is named").toBe(401);
    expect(viaCookie.headers.getSetCookie()).toEqual([]);
    expect(await revokedAt(), "a refused cookie revoked the family").toBeNull();

    const viaBody = await real.handle(
      req("POST", "/auth/refresh/logout", { body: JSON.stringify({ refreshToken: refresh }) }), bearerHost,
    );
    expect(viaBody.status).toBe(204);
    expect(viaBody.headers.getSetCookie()).toEqual([]);
    expect(await revokedAt()).toBeInstanceOf(Date);
    const after = await real.handle(
      req("POST", "/auth/refresh", { body: JSON.stringify({ refreshToken: refresh }) }), bearerHost,
    );
    expect(after.status, "the revoked token still rotates").toBe(401);
  });

  it("POST /auth/logout clears nothing it never set", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await real.handle(req("POST", "/auth/logout", { bearer: s.token, body: "{}" }), {
      ...deps, allowCookieAuth: false,
    });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual([]);

    // …and on the cookie host the same logout DOES clear all three.
    const s2 = await seedSession(db, { now: FIXED_NOW });
    const onCookieHost = await real.handle(
      req("POST", "/auth/logout", {
        cookie: `tf_session=${s2.token}; tf_csrf=${csrfTokenFor(s2.token)}`,
        headers: { "x-csrf-token": csrfTokenFor(s2.token) }, body: "{}",
      }),
      { ...deps },
    );
    expect(onCookieHost.status).toBe(204);
    // FOUR since the resume marker joined the set (`packages/api/src/cookies.ts`): a logout
    // that left `tf_resume` behind would send the next visit to the resume splash, fail there,
    // and bounce back to the landing — a flickering way of arriving where logout already meant
    // to put them. Enumerated rather than counted so a cookie going MISSING is also caught.
    //
    // FIVE since the OWNER marker joined it, and that one has to be cleared for a sharper
    // reason: it is the name the web client opens a local mail mirror from BEFORE asking who is
    // signed in. Left behind on a shared machine it would have the app paint a signed-out
    // person's chrome from a database the sign-out was meant to end.
    //
    // TEN since the writes took the `__Host-` spelling: each of the five is expired in both.
    const five = ["tf_csrf", "tf_owner", "tf_refresh", "tf_resume", "tf_session"];
    expect(onCookieHost.headers.getSetCookie()).toHaveLength(10);
    expect(onCookieHost.headers.getSetCookie().map((c) => c.split("=")[0]).sort())
      .toEqual([...five.map((n) => `__Host-${n}`), ...five]);
  });
});
