import { describe, it, expect, vi } from "vitest";
import { createApp, authRoutes, type ApiDeps, csrfTokenFor } from "@trafficflow/api";
import { totpNow, ServiceError, type Db } from "@trafficflow/services";
import {
  makeDeps, seedSessionFor, seedDevice, req, setCookieMap, cookieMaxAge,
  type TestClock,
} from "./helpers.js";

const app = createApp(authRoutes);
const PW = "pw-correct-horse";
/** `jsonResponse` stamps this on every answer the error envelope builds; `json()` does not. */
const NOSNIFF = "nosniff";
// DERIVED from the session token, exactly as `sessionCookies` mints it — a literal
// constant is no longer a valid CSRF token for anybody. See `cookies.ts#csrfTokenFor`.
const CSRF = csrfTokenFor;

// Per-request container: `apps/web` builds a fresh `ApiDeps` per request, so the
// mutable `session`/`idempotency` never leak between calls. Tests reuse one `deps`
// (to keep the same PGlite db + services), so we clone-and-reset on every handle.
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/** Register a user over HTTP and return its identity (register establishes no session). */
async function register(deps: ApiDeps, email: string): Promise<{ userId: string; accountId: string }> {
  const res = await H(
    req("POST", "/auth/register", { body: JSON.stringify({ email, password: PW, displayName: "Gil", inviteCode: "INVITE-OK" }) }),
    deps,
  );
  expect(res.status).toBe(201);
  const { user, next } = await res.json();
  expect(next).toBe("enroll_2fa");
  return { userId: user.userId, accountId: user.accountId };
}

/** Seed an authenticated session + enroll & activate TOTP; return the shared secret. */
async function enrollTotp(deps: ApiDeps, db: Db, clock: TestClock, id: { userId: string; accountId: string }): Promise<string> {
  const { token } = await seedSessionFor(db, { ...id, now: clock.now(), lastTwofaAt: clock.now() });
  const cookie = `tf_session=${token}; tf_csrf=${CSRF(token)}`;
  const headers = { "x-csrf-token": CSRF(token) };
  const enroll = await H(req("POST", "/auth/2fa/totp/enroll", { cookie, headers }), deps);
  expect(enroll.status).toBe(200);
  const { secret } = await enroll.json();
  const activate = await H(
    req("POST", "/auth/2fa/totp/activate", { cookie, headers, body: JSON.stringify({ code: totpNow(secret, clock.now()) }) }),
    deps,
  );
  expect(activate.status).toBe(200);
  expect((await activate.json()).twofaEnrolled.totp).toBe(true);
  return secret;
}

/** Full first-factor → TOTP second-factor login; returns the verify response. */
async function loginWithTotp(deps: ApiDeps, clock: TestClock, email: string, secret: string): Promise<Response> {
  const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email, password: PW }) }), deps);
  expect(login.status).toBe(200);
  const { loginToken, methods } = await login.json();
  expect(methods).toContain("totp");
  return H(
    req("POST", "/auth/2fa/totp/verify", { body: JSON.stringify({ loginToken, code: totpNow(secret, clock.now()) }) }),
    deps,
  );
}

describe("auth — registration & enrollment", () => {
  it("registers (201), rejects duplicate (409) and a bad invite (403)", async () => {
    const { db, deps, clock } = await makeDeps();
    await register(deps, "gil@x.example");

    const dup = await H(
      req("POST", "/auth/register", { body: JSON.stringify({ email: "gil@x.example", password: PW, displayName: "G", inviteCode: "INVITE-OK" }) }),
      deps,
    );
    expect(dup.status).toBe(409);
    // A later change renamed the generic `conflict` to a code a client can act on: "sign in instead".
    expect((await dup.json()).error.code).toBe("email_taken");

    const bad = await H(
      req("POST", "/auth/register", { body: JSON.stringify({ email: "new@x.example", password: PW, displayName: "N", inviteCode: "NOPE" }) }),
      deps,
    );
    expect(bad.status).toBe(403);
    // `forbidden` said nothing a user could act on. `invite_invalid` is one of three
    // distinct invite refusals (`invites.ts`); the other two are 409 `invite_used` and
    // 403 `invite_expired`, both covered in `onboarding-flow.test.ts`.
    expect((await bad.json()).error.code).toBe("invite_invalid");
    void db; void clock;
  });

  it("enrolls TOTP: enroll returns a secret+otpauthUrl, activate flips twofaEnrolled.totp", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const { token } = await seedSessionFor(db, { ...id, now: clock.now(), lastTwofaAt: clock.now() });
    const cookie = `tf_session=${token}; tf_csrf=${CSRF(token)}`;
    const enroll = await H(req("POST", "/auth/2fa/totp/enroll", { cookie, headers: { "x-csrf-token": CSRF(token) } }), deps);
    const body = await enroll.json();
    expect(body.secret).toBeTruthy();
    expect(body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
  });
});

describe("auth — login → 2FA establishes the web session (cookies, no tokens in body)", () => {
  it("login returns a challenge; totp/verify sets tf_session+tf_csrf+tf_refresh and strips tokens", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000); // move past the step consumed at activation

    const verify = await loginWithTotp(deps, clock, "gil@x.example", secret);
    expect(verify.status).toBe(200);

    const cookies = setCookieMap(verify);
    expect(cookies.tf_session).toBeTruthy();
    expect(cookies.tf_csrf).toBeTruthy();
    expect(cookies.tf_refresh).toBeTruthy();

    const body = await verify.json();
    expect(body.status).toBe("authenticated");
    expect(body.user.email).toBe("gil@x.example");
    expect(body.tokens).toBeUndefined(); // web session lives in cookies
  });
});

describe("auth — session, logout, refresh", () => {
  it("GET /auth/session returns the user with the cookie, 401 without it", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const verify = await loginWithTotp(deps, clock, "gil@x.example", secret);
    const access = setCookieMap(verify).tf_session!;

    const ok = await H(req("GET", "/auth/session", { cookie: `tf_session=${access}` }), deps);
    expect(ok.status).toBe(200);
    expect((await ok.json()).user.email).toBe("gil@x.example");

    const missing = await H(req("GET", "/auth/session"), deps);
    expect(missing.status).toBe(401);
  });

  it("POST /auth/logout → 204 and clears all three cookies (Max-Age=0)", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const verify = await loginWithTotp(deps, clock, "gil@x.example", secret);
    const c = setCookieMap(verify);

    const out = await H(
      req("POST", "/auth/logout", { cookie: `tf_session=${c.tf_session}; tf_csrf=${c.tf_csrf}`, headers: { "x-csrf-token": c.tf_csrf! } }),
      deps,
    );
    expect(out.status).toBe(204);
    expect(cookieMaxAge(out, "tf_session")).toBe(0);
    expect(cookieMaxAge(out, "tf_refresh")).toBe(0);
    expect(cookieMaxAge(out, "tf_csrf")).toBe(0);
  });

  it("POST /auth/refresh via tf_refresh cookie rotates → new tf_session; LATE reuse revokes the family (401)", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const verify = await loginWithTotp(deps, clock, "gil@x.example", secret);
    const r1 = setCookieMap(verify).tf_refresh!;

    const rotated = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${r1}` }), deps);
    expect(rotated.status).toBe(204);
    const rotatedCookies = setCookieMap(rotated);
    expect(rotatedCookies.tf_session).toBeTruthy();
    expect(rotatedCookies.tf_refresh).toBeTruthy();
    expect(rotatedCookies.tf_refresh).not.toBe(r1);
    // The rotated token is USED — the jar demonstrably took the rotation and carried on. That
    // is what makes a later replay of r1 the theft case rather than the lost-response shape
    // (a wholly-dormant tail), which `rotateRefresh` now recovers instead of revoking.
    clock.advance(1_000);
    const carriedOn = await H(
      req("POST", "/auth/refresh", { cookie: `tf_refresh=${rotatedCookies.tf_refresh}` }), deps);
    expect(carriedOn.status).toBe(204);
    const tip = setCookieMap(carriedOn).tf_refresh!;

    // A token replayed AFTER the rotation grace window, with its chain in live use, is a token
    // that was KEPT. Step clear of the window, then present it → the whole family burns.
    clock.advance(deps.authConfig.refreshReuseGraceMs + 1_000);
    const reuse = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${r1}` }), deps);
    expect(reuse.status).toBe(401);
    // The live tip (same family) is now dead too.
    const dead = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${tip}` }), deps);
    expect(dead.status).toBe(401);
  });

  it("GET /auth/session tells a full session minted after a sweep, once; POST /auth/reuse-sweeps/ack takes it off", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const first = setCookieMap(await loginWithTotp(deps, clock, "gil@x.example", secret));
    const read = (access: string): Promise<Response> => H(req("GET", "/auth/session", { cookie: `tf_session=${access}` }), deps);
    // Nothing to tell: the answer keeps its old shape.
    expect(Object.keys(await (await read(first.tf_session!)).json()).sort()).toEqual(["scope", "user"]);

    const r2 = setCookieMap(await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${first.tf_refresh}` }), deps)).tf_refresh!;
    clock.advance(1_000);
    await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${r2}` }), deps);
    clock.advance(deps.authConfig.refreshReuseGraceMs + 1_000);
    expect((await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${first.tf_refresh}` }), deps)).status).toBe(401);

    clock.advance(30_000);
    const access = setCookieMap(await loginWithTotp(deps, clock, "gil@x.example", secret)).tf_session!;
    const told = (await (await read(access)).json()) as { reuseSweeps?: Array<Record<string, unknown>> };
    expect(told.reuseSweeps).toHaveLength(1);
    expect(Object.keys(told.reuseSweeps![0]!).sort(), "no evidence on the wire").toEqual(["at", "client", "id"]);
    expect(told.reuseSweeps![0]!.client).toBe("web");

    const ack = (body: unknown, cookie = `tf_session=${access}; tf_csrf=${CSRF(access)}`): Promise<Response> =>
      H(req("POST", "/auth/reuse-sweeps/ack", { cookie, headers: { "x-csrf-token": CSRF(access) }, body: JSON.stringify(body) }), deps);
    for (const bad of [{}, { ids: [] }, { ids: ["not-a-uuid"] }, { ids: "x" }]) {
      const res = await ack(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error.code).toBe("validation_failed");
    }
    expect((await ack({ ids: [told.reuseSweeps![0]!.id] }, "")).status, "no session").toBe(401);
    expect((await ack({ ids: [told.reuseSweeps![0]!.id] })).status).toBe(204);
    expect(await (await read(access)).json()).not.toHaveProperty("reuseSweeps");
  });

  it("POST /auth/refresh: a stale cookie whose rotation response was LOST recovers the session (204)", async () => {
    // The lid-close shape, end to end over the cookie handler: a rotation commits server-side,
    // its Set-Cookie never lands, and the browser re-presents the old token half an hour later.
    // The family's tail was never used by anyone, so this is recovered — 204, fresh cookies —
    // not answered 401 with a cleared jar.
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const verify = await loginWithTotp(deps, clock, "gil@x.example", secret);
    const r1 = setCookieMap(verify).tf_refresh!;

    const lost = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${r1}` }), deps);
    expect(lost.status).toBe(204);   // committed server-side; the response "never arrived"

    clock.advance(30 * 60_000);      // far outside the grace window
    const back = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${r1}` }), deps);
    expect(back.status).toBe(204);
    const cookies = setCookieMap(back);
    expect(cookies.tf_session).toBeTruthy();
    expect(cookies.tf_refresh).toBeTruthy();
    expect(cookies.tf_refresh).not.toBe(r1);

    // The recovered credential is a working one.
    clock.advance(61_000);
    const onward = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${cookies.tf_refresh}` }), deps);
    expect(onward.status).toBe(204);
  });

  it("POST /auth/refresh: a re-presentation WITHIN the grace window re-rotates, family stays live", async () => {
    // The multi-tab / multi-client case: one browser jar, two callers crossing the access-token
    // expiry together both present the same `tf_refresh`. One wins; the other lands inside the
    // grace window. Pre-fix that revoked the family and signed a working session out on a new tab.
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const verify = await loginWithTotp(deps, clock, "gil@x.example", secret);
    const r1 = setCookieMap(verify).tf_refresh!;

    const winner = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${r1}` }), deps);
    expect(winner.status).toBe(204);
    const r2 = setCookieMap(winner).tf_refresh!;

    // The grace-loser still held r1 (the shared jar had not taken the winner's cookie yet). No
    // clock advance: it is well inside the window. It re-rotates instead of revoking, and hands
    // back a full set of session cookies so the browser recovers rather than being signed out.
    const loser = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${r1}` }), deps);
    expect(loser.status).toBe(204);
    const loserCookies = setCookieMap(loser);
    expect(loserCookies.tf_session).toBeTruthy();
    expect(loserCookies.tf_refresh).toBeTruthy();
    expect(loserCookies.tf_refresh).not.toBe(r1);
    expect(loserCookies.tf_refresh).not.toBe(r2);

    // The family is ALIVE: both the winner's token and the grace-loser's still rotate.
    const w2 = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${r2}` }), deps);
    expect(w2.status).toBe(204);
    const l2 = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${loserCookies.tf_refresh}` }), deps);
    expect(l2.status).toBe(204);
  });

  /*
   * ═══ A FAULT IS NOT A REFUSAL — the jar survives what the server could not answer ═══════════
   *
   * The cookie branch's `catch` took EVERY thrown value and answered a
   * coded `401` with `clearSessionCookies()`. A busy connection pool, a driver error, a bug —
   * each destroyed the browser's only copy of a refresh token the server still honours, and the
   * client reads a coded 401 from THIS route as the one definitive "your session is gone"
   * (`apps/webapp/app/session-refresh.ts`). One database blip signed out every browser whose
   * access cookie happened to expire during it.
   *
   * The service call is replaced rather than the database broken: the route's contract is about
   * what it does with a thrown value, and a real pool timeout arrives here as exactly this.
   */
  async function refreshMeeting(err: unknown): Promise<Response> {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const verify = await loginWithTotp(deps, clock, "gil@x.example", secret);
    const r1 = setCookieMap(verify).tf_refresh!;
    const spy = vi.spyOn(deps.services!.auth!, "refresh").mockRejectedValue(err);
    try {
      return await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${r1}` }), deps);
    } finally {
      spy.mockRestore();
    }
  }

  it("a BUSY connection pool answers 503 db_busy and KEEPS the jar", async () => {
    // The measured shape: the instance had a connection, it was busy for the whole ceiling, and
    // this statement never began. `withErrorEnvelope` has answered that 503-fast for every other
    // route since it was written — this catch was in front of it.
    const res = await refreshMeeting(
      Object.assign(new Error("pool acquire timed out"), { name: "DbAcquireTimeoutError" }),
    );
    expect(res.status, "a blip was answered as a dead session").toBe(503);
    expect((await res.json()).error.code).toBe("db_busy");
    expect(res.headers.getSetCookie(),
      "the browser's only copy of a token the server still honours was destroyed").toEqual([]);
    expect(res.headers.get("x-content-type-options")).toBe(NOSNIFF);
  });

  it("an UNCLASSIFIED throw is surfaced as a fault, never mapped onto a refusal", async () => {
    const res = await refreshMeeting(new Error("the pool went away"));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("internal");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("x-content-type-options")).toBe(NOSNIFF);
  });

  it("a 5xx ServiceError is a fault too — the status decides, not the class", async () => {
    const res = await refreshMeeting(new ServiceError("internal", 500, "auth service not configured"));
    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie()).toEqual([]);
    // WHICH ANSWER IT IS, not just which status: a status alone cannot tell a rethrow from a
    // refusal relayed at the same number. `withErrorEnvelope` builds through `jsonResponse`,
    // which stamps this on every answer it makes; the catch's own `json()` does not — so this
    // is the assertion that the fault LEFT the handler rather than being dressed up inside it.
    expect(res.headers.get("x-content-type-options"),
      "a 5xx was relayed by the catch instead of being rethrown to the envelope").toBe(NOSNIFF);
  });

  it("a REFUSAL still clears the jar — and now NAMES which refusal it was", async () => {
    // The positive control for the arm above, and the second half of the fix: one sentence
    // ("this session cannot be resumed") was given for a replayed token, an expired one, an
    // unknown one, a revoked session and a capped one alike, so neither the person nor the log
    // could tell a theft sweep from an ordinary expiry.
    const res = await refreshMeeting(new ServiceError("unauthorized", 401, "refresh token reuse detected"));
    expect(res.status).toBe(401);
    expect(cookieMaxAge(res, "tf_refresh"), "a real refusal must still clear the jar").toBe(0);
    expect(cookieMaxAge(res, "tf_session")).toBe(0);
    expect((await res.json()).error, "the door answered with a catch-all sentence").toMatchObject({
      code: "unauthorized", message: "refresh token reuse detected",
    });
  });

  it("an EXPIRED token is named as expired — a different refusal, told apart", async () => {
    const res = await refreshMeeting(new ServiceError("unauthorized", 401, "refresh token expired"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe("refresh token expired");
    expect(cookieMaxAge(res, "tf_refresh")).toBe(0);
  });

  it("a 409 about the REQUEST does not sign this browser out", async () => {
    // `refuseCrossAccountCredential`: a live session for A posting B's refresh cookie. Both
    // credentials are valid and nothing was decided about A's session — clearing the jar there
    // signs A out for a request A's own token was never spent on.
    const res = await refreshMeeting(
      new ServiceError("session_conflict", 409, "this request carries a credential for another account"),
    );
    expect(res.status).toBe(409);
    expect(res.headers.getSetCookie(), "a request refusal cleared a live session's jar").toEqual([]);
    // The other side of the discriminator above: this one IS relayed by the catch, so it carries
    // no envelope stamp. A 409 that started answering with one would mean the arm had moved.
    expect(res.headers.get("x-content-type-options")).toBeNull();
  });
});

describe("auth — session lifetimes on the wire", () => {
  const DAY_S = 24 * 60 * 60;

  /**
   * WHAT THE BROWSER IS ACTUALLY TOLD TO KEEP. The service-level guards
   * (`packages/services/test/session-lifetime.test.ts`) pin the row in `refresh_tokens`; this pins
   * the `Max-Age` that decides whether the jar still HOLDS the token when the row is still valid.
   * A server window the browser has already dropped is a session that ends early with nothing
   * failing anywhere — the two numbers have to be one number.
   */
  it("the refresh cookie carries the 90-day rolling window, and no Domain=", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const verify = await loginWithTotp(deps, clock, "gil@x.example", secret);

    expect(cookieMaxAge(verify, "tf_refresh")).toBe(90 * DAY_S);
    // The two markers exist for exactly as long as a resume could succeed, so they follow the
    // refresh window rather than the fifteen-minute access one.
    expect(cookieMaxAge(verify, "tf_resume")).toBe(90 * DAY_S);
    expect(cookieMaxAge(verify, "tf_owner")).toBe(90 * DAY_S);
    // The access pair is untouched by any of this — a long refresh window is not a long access
    // token, and conflating them is how a fifteen-minute credential becomes a ninety-day one.
    expect(cookieMaxAge(verify, "tf_session")).toBe(15 * 60);
    expect(cookieMaxAge(verify, "tf_csrf")).toBe(15 * 60);

    // The cookie's posture is frozen (`apps/webapp/test/api-rewrite.test.ts` greps the source).
    // Asserted again on the WIRE here, because that guard reads a file and this reads a header:
    // a `Domain=` would widen the session to `admin.` and to every future subdomain.
    for (const raw of verify.headers.getSetCookie()) expect(raw).not.toContain("Domain=");
  });

  it("a rotation RE-ISSUES the full window — the browser's copy rolls too", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const verify = await loginWithTotp(deps, clock, "gil@x.example", secret);
    const r1 = setCookieMap(verify).tf_refresh!;

    // Sixty days later the token is still live, and the rotation must hand the jar a FULL ninety
    // days again rather than the remainder. If this ever returns 30 * DAY_S, the cookie is
    // counting down from the original sign-in and "rolling" is a claim the product cannot make.
    clock.advance(60 * DAY_S * 1000);
    const rotated = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${r1}` }), deps);
    expect(rotated.status).toBe(204);
    expect(cookieMaxAge(rotated, "tf_refresh")).toBe(90 * DAY_S);
    expect(cookieMaxAge(rotated, "tf_resume")).toBe(90 * DAY_S);
  });

  it("the native branch answers a token pair and sets NO cookie at all", async () => {
    // The 400-day native window never reaches a browser jar: the body branch replies with JSON.
    // This is why lengthening the native lifetime could not widen anything the browser holds.
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const verify = await loginWithTotp(deps, clock, "gil@x.example", secret);
    const r1 = setCookieMap(verify).tf_refresh!;

    const native = await H(
      req("POST", "/auth/refresh", { body: JSON.stringify({ refreshToken: r1 }) }),
      { ...deps, allowCookieAuth: false },
    );
    expect(native.status).toBe(200);
    expect(native.headers.getSetCookie()).toHaveLength(0);
    const { tokens } = await native.json();
    expect(tokens.refreshToken).toBeTruthy();
  });
});

describe("auth — devices & audit", () => {
  it("lists devices (current included) and revokes another only WITH fresh step-up", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const verify = await loginWithTotp(deps, clock, "gil@x.example", secret);
    const c = setCookieMap(verify);

    const list = await H(req("GET", "/devices", { cookie: `tf_session=${c.tf_session}` }), deps);
    expect(list.status).toBe(200);
    const { items } = await list.json();
    expect(items.some((d: { current: boolean }) => d.current)).toBe(true);

    // A second device belonging to the same user.
    const otherDevice = await seedDevice(db, { accountId: id.accountId, userId: id.userId, kind: "macos" });
    await seedSessionFor(db, { ...id, now: clock.now(), deviceId: otherDevice });

    // WITHOUT fresh step-up (a stale caller session) → 403.
    const stale = await seedSessionFor(db, { ...id, now: clock.now(), lastTwofaAt: null });
    const denied = await H(
      req("DELETE", `/devices/${otherDevice}`, { cookie: `tf_session=${stale.token}; tf_csrf=${CSRF(stale.token)}`, headers: { "x-csrf-token": CSRF(stale.token) } }),
      deps,
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("step_up_required");

    // WITH fresh step-up (the freshly-verified session) → 204.
    const ok = await H(
      req("DELETE", `/devices/${otherDevice}`, { cookie: `tf_session=${c.tf_session}; tf_csrf=${c.tf_csrf}`, headers: { "x-csrf-token": c.tf_csrf! } }),
      deps,
    );
    expect(ok.status).toBe(204);
  });

  it("GET /auth/audit returns a Page of events", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const verify = await loginWithTotp(deps, clock, "gil@x.example", secret);
    const access = setCookieMap(verify).tf_session!;

    const audit = await H(req("GET", "/auth/audit?limit=10", { cookie: `tf_session=${access}` }), deps);
    expect(audit.status).toBe(200);
    const page = await audit.json();
    expect(Array.isArray(page.items)).toBe(true);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page).toHaveProperty("nextCursor");
    expect(page.items[0]).toHaveProperty("event");
    expect(page.items[0]).toHaveProperty("at");
  });
});
