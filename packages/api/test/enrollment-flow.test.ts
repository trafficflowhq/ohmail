import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { totpNow } from "@trafficflow/services";
import { SoftwareAuthenticator } from "../../services/test/webauthn-authenticator.js";
import { makeDeps, req, setCookieMap, cookieMaxAge, sweepPath } from "./helpers.js";

/**
 * Stage-2 ONBOARDING OVER THE WIRE, with no seeded session.
 *
 * Every pre-S2 auth test had to insert a `sessions` row directly to reach the 2FA
 * enrollment endpoints, because register minted no session and login on a 2FA-less
 * user returned `{twofa_required, methods: []}` — a state no endpoint accepts. That
 * DB bridge is the bug, so its ABSENCE from this file is one of the assertions
 * (`the fixture bridge is gone`, below, greps this very source).
 *
 * The full table is mounted (not just `authRoutes`) because half of what the slice
 * must prove is what an enrollment session CANNOT reach: /sync, /mailboxes, /drafts,
 * /messages.
 */
const app = createApp(apiRoutes);
const PW = "pw-correct-horse";
const RPID = "localhost";        // makeTestAuthDeps
const ORIGIN = "http://localhost:3000";
const FIVE_MIN = 5 * 60_000;     // = DEFAULT_AUTH_CONFIG.loginTokenTtlMs

/** Fresh per-request container per call, exactly as `apps/web` builds one. */
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

interface Enrollment {
  token: string;              // the enrollment token (bearer for native)
  cookie: string;             // "tf_session=…; tf_csrf=…" (browser)
  csrf: string;
  userId: string;
  accountId: string;
  res: Response;
}

/** `POST /auth/register` — the only way in. No DB writes from the test. */
async function register(deps: ApiDeps, email: string): Promise<Enrollment> {
  const res = await H(
    req("POST", "/auth/register", {
      body: JSON.stringify({ email, password: PW, displayName: "Gil", inviteCode: "INVITE-OK" }),
    }),
    deps,
  );
  expect(res.status).toBe(201);
  const body = await res.clone().json();
  const c = setCookieMap(res);
  return {
    token: body.enrollmentToken, cookie: `tf_session=${c.tf_session}; tf_csrf=${c.tf_csrf}`,
    csrf: c.tf_csrf!, userId: body.user.userId, accountId: body.user.accountId, res,
  };
}

/** Drive the whole passkey ceremony over HTTP with the given credential (cookie or bearer). */
async function enrollPasskey(
  deps: ApiDeps, cred: { cookie?: string; bearer?: string; headers?: Record<string, string> },
): Promise<{ authenticator: SoftwareAuthenticator; res: Response }> {
  const opts = await H(req("POST", "/auth/2fa/webauthn/register/options", cred), deps);
  expect(opts.status).toBe(200);
  const { options } = await opts.json();
  const authenticator = new SoftwareAuthenticator();
  const credential = authenticator.register({ rpID: RPID, challenge: options.challenge, origin: ORIGIN });
  const res = await H(
    req("POST", "/auth/2fa/webauthn/register/verify", { ...cred, body: JSON.stringify({ credential, label: "MacBook" }) }),
    deps,
  );
  return { authenticator, res };
}

/** Second-factor login with a passkey, over HTTP. Returns the assert/verify response. */
async function loginWithPasskey(
  deps: ApiDeps, email: string, authenticator: SoftwareAuthenticator,
): Promise<Response> {
  const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email, password: PW }) }), deps);
  expect(login.status).toBe(200);
  const challenge = await login.json();
  expect(challenge.status).toBe("twofa_required");
  expect(challenge.methods).toContain("webauthn");

  const opts = await H(
    req("POST", "/auth/2fa/webauthn/assert/options", { body: JSON.stringify({ loginToken: challenge.loginToken }) }),
    deps,
  );
  const { options } = await opts.json();
  const assertion = authenticator.assert({ rpID: RPID, challenge: options.challenge, origin: ORIGIN });
  return H(
    req("POST", "/auth/2fa/webauthn/assert/verify", {
      body: JSON.stringify({ loginToken: challenge.loginToken, credential: assertion }),
    }),
    deps,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe("HTTP-only onboarding: register → enrollment session → passkey → codes → login", () => {
  // THE GATE, as one uninterrupted sequence: register → enrollment session → enroll
  // passkey → enroll TOTP → recovery codes → logout → full login, with no seeded row.
  it("walks the whole ceremony over the wire: passkey → TOTP → recovery codes → logout → full login", async () => {
    const { deps, clock } = await makeDeps();

    // 1 ── register mints the enrollment session: token in the body (native) AND in
    // tf_session (browser), tf_csrf for the double-submit guard, and NO refresh token —
    // nothing may extend an enrollment session. Its one tf_refresh line expires an earlier one.
    const e = await register(deps, "gil@x.example");
    const registered = await e.res.json();
    expect(registered.status).toBe("enrollment");
    expect(registered.next).toBe("enroll_2fa");
    expect(registered.user.twofaEnrolled).toEqual({ webauthn: false, totp: false, recoveryCodes: false });
    expect(e.token).toBeTruthy();
    expect(registered.expiresIn).toBe(FIVE_MIN / 1000);
    const regCookies = setCookieMap(e.res);
    expect(regCookies.tf_session).toBe(e.token);
    expect(regCookies.tf_csrf).toBeTruthy();
    expect(regCookies.tf_refresh).toBe("");
    expect(cookieMaxAge(e.res, "tf_refresh")).toBe(0);
    expect(cookieMaxAge(e.res, "tf_session")).toBe(FIVE_MIN / 1000);

    // 2 ── /auth/session introspects it: a resuming client learns it is mid-enrollment.
    const intro = await H(req("GET", "/auth/session", { cookie: e.cookie }), deps);
    expect(intro.status).toBe(200);
    const introBody = await intro.json();
    expect(introBody.scope).toBe("enrollment");
    expect(introBody.user.email).toBe("gil@x.example");

    // 3 ── the passkey ceremony, cookie-authenticated with CSRF, no seeded session.
    const { authenticator, res: verify } = await enrollPasskey(deps, {
      cookie: e.cookie, headers: { "x-csrf-token": e.csrf },
    });
    expect(verify.status).toBe(200);
    const enrolled = await verify.json();
    expect(enrolled.twofaEnrolled.webauthn).toBe(true);
    expect(enrolled.credentialId).toBeTruthy();

    // …and the enrollment session is EXCHANGED, not upgraded: a brand-new full
    // session comes back, in cookies, with the tokens stripped from the body.
    expect(enrolled.session.status).toBe("authenticated");
    expect(enrolled.session.tokens).toBeUndefined();
    const full = setCookieMap(verify);
    expect(full.tf_session).toBeTruthy();
    expect(full.tf_session).not.toBe(e.token);   // new session id ⇒ no session fixation
    expect(full.tf_refresh).toBeTruthy();        // a full session CAN be refreshed

    // The enrollment credential is dead the moment it bought a full one.
    const replay = await H(req("GET", "/auth/session", { cookie: `tf_session=${e.token}` }), deps);
    expect(replay.status).toBe(401);

    // 4 ── the full session reaches the product surface the enrollment one could not.
    const sync = await H(req("GET", "/sync", { cookie: `tf_session=${full.tf_session}` }), deps);
    expect(sync.status).toBe(200);
    const fullIntro = await H(req("GET", "/auth/session", { cookie: `tf_session=${full.tf_session}` }), deps);
    expect((await fullIntro.json()).scope).toBe("full");

    const fullCookie = `tf_session=${full.tf_session}; tf_csrf=${full.tf_csrf}`;
    const fullHeaders = { "x-csrf-token": full.tf_csrf! };

    // 5 ── the SECOND factor, on the exchanged full session. No further exchange
    // happens (`session` absent) — that path is byte-identical to pre-S2 — and the
    // caller passes the step-up gate on `enroll`/`activate` because the exchange it
    // just completed IS a fresh 2FA.
    const totpEnroll = await H(req("POST", "/auth/2fa/totp/enroll", { cookie: fullCookie, headers: fullHeaders }), deps);
    expect(totpEnroll.status).toBe(200);
    const { secret } = await totpEnroll.json();
    const totpActivate = await H(
      req("POST", "/auth/2fa/totp/activate", {
        cookie: fullCookie, headers: fullHeaders, body: JSON.stringify({ code: totpNow(secret, clock.now()) }),
      }),
      deps,
    );
    expect(totpActivate.status).toBe(200);
    const bothFactors = await totpActivate.clone().json();
    expect(bothFactors.twofaEnrolled).toEqual({ webauthn: true, totp: true, recoveryCodes: false });
    expect(bothFactors.session).toBeUndefined();                  // no churn on the ordinary path
    expect(totpActivate.headers.getSetCookie()).toEqual([]);

    // 6 ── recovery codes: step-up-gated, and satisfied by the exchange's fresh 2FA.
    const codes = await H(
      req("POST", "/auth/2fa/recovery-codes", { cookie: fullCookie, headers: fullHeaders }),
      deps,
    );
    expect(codes.status).toBe(200);
    expect((await codes.json()).codes).toHaveLength(10);

    // 7 ── exactly ONE device is on the account, and no ghost session behind it: the
    // enrollment session had `device_id = NULL`, so it could never be listed by
    // `GET /devices` nor targeted by `revokeDevice` — it is safe only because a live
    // enrollment session and a live full session can no longer coexist for one user.
    const devices = await H(req("GET", "/devices", { cookie: fullCookie }), deps);
    expect(devices.status).toBe(200);
    const listed = (await devices.json()).items;
    expect(listed).toHaveLength(1);
    expect(listed[0].current).toBe(true);
    // DEVICES: a plain browser sign-in is DEVICE-LESS — no auto-minted "Web" row (that per-
    // sign-in row is what flooded the pane), so the projection says `named: false` and the
    // label is empty. The client renders the kind word; the row is still the caller's own,
    // pinned by `current` above.
    expect(listed[0].named).toBe(false);
    expect(listed[0].label).toBe("");

    // 8 ── logout, then a real two-factor login from scratch.
    const out = await H(req("POST", "/auth/logout", { cookie: fullCookie, headers: fullHeaders }), deps);
    expect(out.status).toBe(204);

    const relogin = await loginWithPasskey(deps, "gil@x.example", authenticator);
    expect(relogin.status).toBe(200);
    const session = await relogin.json();
    expect(session.status).toBe("authenticated");
    expect(session.tokens).toBeUndefined();
    const reCookies = setCookieMap(relogin);
    expect(reCookies.tf_session).toBeTruthy();
    const afterLogin = await H(req("GET", "/sync", { cookie: `tf_session=${reCookies.tf_session}` }), deps);
    expect(afterLogin.status).toBe(200);
  });

  it("TOTP variant: enroll + activate exchanges the session, then a full TOTP login", async () => {
    const { deps, clock } = await makeDeps();
    const e = await register(deps, "totp@x.example");
    const headers = { "x-csrf-token": e.csrf };

    const enroll = await H(req("POST", "/auth/2fa/totp/enroll", { cookie: e.cookie, headers }), deps);
    expect(enroll.status).toBe(200);
    const { secret } = await enroll.json();
    expect(secret).toBeTruthy();

    const activate = await H(
      req("POST", "/auth/2fa/totp/activate", {
        cookie: e.cookie, headers, body: JSON.stringify({ code: totpNow(secret, clock.now()) }),
      }),
      deps,
    );
    expect(activate.status).toBe(200);
    const activated = await activate.clone().json();
    expect(activated.twofaEnrolled.totp).toBe(true);
    expect(activated.session.status).toBe("authenticated");
    const full = setCookieMap(activate);
    expect(full.tf_session).not.toBe(e.token);
    expect(full.tf_refresh).toBeTruthy();

    // Recovery codes right after, on the exchanged session (step-up is fresh).
    const codes = await H(
      req("POST", "/auth/2fa/recovery-codes", {
        cookie: `tf_session=${full.tf_session}; tf_csrf=${full.tf_csrf}`,
        headers: { "x-csrf-token": full.tf_csrf! },
      }),
      deps,
    );
    expect(codes.status).toBe(200);

    // Logout, then log in properly with the code (past the consumed timestep).
    const out = await H(
      req("POST", "/auth/logout", {
        cookie: `tf_session=${full.tf_session}; tf_csrf=${full.tf_csrf}`,
        headers: { "x-csrf-token": full.tf_csrf! },
      }),
      deps,
    );
    expect(out.status).toBe(204);
    clock.advance(30_000);

    const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "totp@x.example", password: PW }) }), deps);
    const challenge = await login.json();
    expect(challenge.status).toBe("twofa_required");
    expect(challenge.methods).toContain("totp");
    const verify = await H(
      req("POST", "/auth/2fa/totp/verify", {
        body: JSON.stringify({ loginToken: challenge.loginToken, code: totpNow(secret, clock.now()) }),
      }),
      deps,
    );
    expect(verify.status).toBe(200);
    expect((await verify.json()).status).toBe("authenticated");
  });

  it("bearer works everywhere cookies do: native onboarding never touches Set-Cookie", async () => {
    const { deps, clock } = await makeDeps();
    const e = await register(deps, "native@x.example");

    // No cookie, no CSRF header — bearer is CSRF-exempt by construction.
    const intro = await H(req("GET", "/auth/session", { bearer: e.token }), deps);
    expect(intro.status).toBe(200);
    expect((await intro.json()).scope).toBe("enrollment");

    const blocked = await H(req("GET", "/sync", { bearer: e.token }), deps);
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.code).toBe("enrollment_incomplete");

    const enroll = await H(req("POST", "/auth/2fa/totp/enroll", { bearer: e.token }), deps);
    expect(enroll.status).toBe(200);
    const { secret } = await enroll.json();
    const activate = await H(
      req("POST", "/auth/2fa/totp/activate", { bearer: e.token, body: JSON.stringify({ code: totpNow(secret, clock.now()) }) }),
      deps,
    );
    expect(activate.status).toBe(200);
    const activated = await activate.clone().json();

    // A bearer client gets the exchanged tokens IN THE BODY — the only place it can
    // read them — and no cookies are set at all.
    expect(activated.session.tokens.accessToken).toBeTruthy();
    expect(activated.session.tokens.refreshToken).toBeTruthy();
    expect(activate.headers.getSetCookie()).toEqual([]);
    expect(activated.session.tokens.accessToken).not.toBe(e.token);

    const sync = await H(req("GET", "/sync", { bearer: activated.session.tokens.accessToken }), deps);
    expect(sync.status).toBe(200);
    // The enrollment bearer is revoked by the exchange.
    expect((await H(req("GET", "/auth/session", { bearer: e.token }), deps)).status).toBe(401);
  });
});

describe("an enrollment session is fenced to the enrollment surface", () => {
  it("403 enrollment_incomplete on /sync, /mailboxes, /drafts and /messages", async () => {
    const { deps } = await makeDeps();
    const e = await register(deps, "fenced@x.example");

    const fenced: Array<[string, string]> = [
      ["GET", "/sync"],
      ["GET", "/mailboxes"],
      ["GET", `/drafts/${randomUUID()}`],
      ["GET", "/messages"],
      ["GET", "/messages?view=imbox"],
      ["GET", "/devices"],
      ["GET", "/auth/audit"],
      ["GET", `/threads/${randomUUID()}`],
      ["GET", "/search?q=x"],
    ];
    for (const [method, path] of fenced) {
      const res = await H(req(method, path, { cookie: e.cookie }), deps);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).error.code, `${method} ${path}`).toBe("enrollment_incomplete");
    }

    // A write path too: the scope gate fires before step-up and before CSRF, so the
    // handler is never reached even with a valid CSRF header.
    const write = await H(
      req("POST", "/mailboxes", {
        cookie: e.cookie, headers: { "x-csrf-token": e.csrf },
        body: JSON.stringify({ provider: "imap", address: "x@y.z" }),
      }),
      deps,
    );
    expect(write.status).toBe(403);
    expect((await write.json()).error.code).toBe("enrollment_incomplete");
  });

  it("cannot mint a native OAuth code: /oauth/authorize is public, so the identity is dropped → 401", async () => {
    const { deps } = await makeDeps();
    const e = await register(deps, "escalate@x.example");
    const q = new URLSearchParams({
      response_type: "code", client_id: "tf-macos", redirect_uri: "trafficflow://auth",
      code_challenge: "x".repeat(43), code_challenge_method: "S" + "256", state: "s",
    });
    const res = await H(req("GET", `/oauth/authorize?${q}`, { cookie: e.cookie }), deps);
    expect(res.status).toBe(401);            // not a 302 with a code
    expect(res.headers.get("location")).toBeNull();
  });

  it("cannot generate recovery codes: step-up is untouched by enrollmentOk", async () => {
    const { deps } = await makeDeps();
    const e = await register(deps, "nocodes@x.example");
    const res = await H(
      req("POST", "/auth/2fa/recovery-codes", { cookie: e.cookie, headers: { "x-csrf-token": e.csrf } }),
      deps,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("step_up_required");
  });

  // Factor REMOVAL is not part of the enrollment surface, so it is fenced by the SCOPE
  // gate — the one built for this — and not merely by step-up. It used to carry
  // `enrollmentOk` (unreachable in practice, but that made a destructive route's safety
  // rest entirely on `lastTwofaAt` staying NULL for enrollment sessions).
  it("cannot remove a factor: DELETE /auth/2fa/totp is not part of the enrollment surface", async () => {
    const { deps } = await makeDeps();
    const e = await register(deps, "noremove@x.example");
    const res = await H(
      req("DELETE", "/auth/2fa/totp", { cookie: e.cookie, headers: { "x-csrf-token": e.csrf } }),
      deps,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("enrollment_incomplete");
  });

  /**
   * THE EXACT ALLOWLIST, asserted against the whole route table rather than a
   * hand-picked handful of paths. A future route that silently gains `enrollmentOk`
   * fails here — a public one included, since on a public route the flag is what keeps
   * the enrollment identity (`withSession` drops it otherwise; `middleware.test.ts`).
   */
  it("exactly eight routes carry enrollmentOk — 2FA enrollment, session, the two sign-outs", () => {
    const flagged = apiRoutes
      .filter((r) => r.options?.enrollmentOk)
      .map((r) => `${r.method} ${r.pattern}`)
      .sort();
    expect(flagged).toEqual([
      "GET /auth/session",
      "POST /auth/2fa/recovery-codes",
      "POST /auth/2fa/totp/activate",
      "POST /auth/2fa/totp/enroll",
      "POST /auth/2fa/webauthn/register/options",
      "POST /auth/2fa/webauthn/register/verify",
      "POST /auth/logout",
      "POST /auth/refresh/logout",
    ]);
    // ONE public route keeps an enrollment session, by name: the web's sign-out door, which ends
    // whatever the jar holds and must not leave a half-enrolled session live behind its 401.
    expect(apiRoutes.filter((r) => r.options?.public && r.options?.enrollmentOk)
      .map((r) => `${r.method} ${r.pattern}`)).toEqual(["POST /auth/refresh/logout"]);
  });

  it("403s on EVERY protected route that is not on the allowlist (whole-table sweep)", async () => {
    const { deps } = await makeDeps();
    const e = await register(deps, "sweep@x.example");
    const id = randomUUID();
    const fenced = apiRoutes.filter((r) => !r.options?.public && !r.options?.enrollmentOk);
    expect(fenced.length).toBeGreaterThan(80);           // the sweep is not vacuous

    for (const route of fenced) {
      const path = sweepPath(route, id);
      const res = await H(
        req(route.method, path, { cookie: e.cookie, headers: { "x-csrf-token": e.csrf } }),
        deps,
      );
      expect(res.status, `${route.method} ${path}`).toBe(403);
      expect((await res.json()).error.code, `${route.method} ${path}`).toBe("enrollment_incomplete");
    }
  });

  it("still obeys CSRF: a cookie-authenticated enrollment POST without the header 403s", async () => {
    const { deps } = await makeDeps();
    const e = await register(deps, "csrf@x.example");
    const res = await H(req("POST", "/auth/2fa/webauthn/register/options", { cookie: e.cookie }), deps);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("csrf_failed");
  });

  it("expires: the same request that worked is rejected once the clock passes the TTL", async () => {
    const { deps, clock } = await makeDeps();
    const e = await register(deps, "expiring@x.example");

    const before = await H(req("GET", "/auth/session", { bearer: e.token }), deps);
    expect(before.status).toBe(200);

    // EXACTLY the TTL, not TTL+1: `resolveSession` compares `gt(accessExpiresAt, now)`,
    // so the boundary instant is already dead. Asserting the boundary rather than a
    // point past it is what makes an off-by-one in that comparison fail here.
    clock.advance(FIVE_MIN);
    const after = await H(req("GET", "/auth/session", { bearer: e.token }), deps);
    expect(after.status).toBe(401);
    // …and it cannot be revived, by either transport: no refresh token was ever minted.
    expect((await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${e.token}` }), deps)).status).toBe(401);
    expect((await H(req("POST", "/auth/refresh", { body: JSON.stringify({ refreshToken: e.token }) }), deps)).status).toBe(401);
    // Nor can it still enroll.
    const enroll = await H(req("POST", "/auth/2fa/totp/enroll", { bearer: e.token }), deps);
    expect(enroll.status).toBe(401);
  });
});

describe("re-entry: a registered-but-unenrolled user resumes through login", () => {
  it("login with the right password and zero methods mints a FRESH enrollment session", async () => {
    const { deps } = await makeDeps();
    const first = await register(deps, "resume@x.example");

    // The tab was closed; a new client posts credentials.
    const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "resume@x.example", password: PW }) }), deps);
    expect(login.status).toBe(200);
    const body = await login.clone().json();
    expect(body.status).toBe("enrollment");     // NOT {twofa_required, methods: []}
    expect(body.next).toBe("enroll_2fa");
    expect(body.loginToken).toBeUndefined();
    expect(body.enrollmentToken).toBeTruthy();
    expect(body.enrollmentToken).not.toBe(first.token);
    const c = setCookieMap(login);
    expect(c.tf_session).toBe(body.enrollmentToken);
    // No refresh token: the one tf_refresh line expires an earlier family's.
    expect(c.tf_refresh).toBe("");
    expect(cookieMaxAge(login, "tf_refresh")).toBe(0);

    // The resumed session finishes onboarding.
    const { res: verify } = await enrollPasskey(deps, {
      cookie: `tf_session=${c.tf_session}; tf_csrf=${c.tf_csrf}`, headers: { "x-csrf-token": c.tf_csrf! },
    });
    expect(verify.status).toBe(200);
    const enrolled = await verify.json();
    expect(enrolled.twofaEnrolled.webauthn).toBe(true);
    expect(enrolled.session.status).toBe("authenticated");
    const sync = await H(req("GET", "/sync", { cookie: `tf_session=${setCookieMap(verify).tf_session}` }), deps);
    expect(sync.status).toBe(200);
  });

  it("a stale enrollment cookie does not block the login that replaces it", async () => {
    const { deps } = await makeDeps();
    const e = await register(deps, "stale@x.example");
    // /auth/login is public: the enrollment identity is DROPPED rather than 403'd,
    // otherwise a browser holding the cookie could never re-enter.
    const login = await H(
      req("POST", "/auth/login", { cookie: e.cookie, body: JSON.stringify({ email: "stale@x.example", password: PW }) }),
      deps,
    );
    expect(login.status).toBe(200);
    expect((await login.json()).status).toBe("enrollment");
  });

  it("a wrong password still fails identically — re-entry is not a bypass", async () => {
    const { deps } = await makeDeps();
    await register(deps, "guard@x.example");
    const res = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "guard@x.example", password: "WRONG" }) }), deps);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("credential_refused");
  });

  it("once a factor exists, login goes back to the two-step challenge", async () => {
    const { deps } = await makeDeps();
    const e = await register(deps, "enrolled@x.example");
    await enrollPasskey(deps, { cookie: e.cookie, headers: { "x-csrf-token": e.csrf } });

    const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "enrolled@x.example", password: PW }) }), deps);
    const body = await login.json();
    expect(body.status).toBe("twofa_required");
    expect(body.enrollmentToken).toBeUndefined();
    expect(body.loginToken).toBeTruthy();
    expect(login.headers.getSetCookie()).toEqual([]);   // no session on step one
  });
});

/**
 * THE REPLAY THE SLICE ORIGINALLY SHIPPED. Every enrollment session gets a fresh
 * `familyId`, and the exchange revoked only the family it was handed, so two live
 * siblings (register on the laptop, re-entry login on the phone) shared nothing:
 * finishing onboarding on one left the other `scope='enrollment'` and fully usable —
 * i.e. the holder of a token captured during the password-only window (it travels in a
 * readable JSON body by design: HAR exports, body-capturing error SDKs, service-worker
 * caches, XSS) could register an attacker-controlled passkey on the victim's account
 * and walk out with a full session. The revocation predicate is now
 * `user_id + scope='enrollment'`.
 */
describe("a password-only session can never be replayed as a full credential", () => {
  it("re-entry SUPERSEDES: the older enrollment token is dead the moment a newer one is minted", async () => {
    const { deps } = await makeDeps();
    const e1 = await register(deps, "sibling@x.example");

    const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "sibling@x.example", password: PW }) }), deps);
    const e2 = await login.json();
    expect(e2.status).toBe("enrollment");
    expect(e2.enrollmentToken).not.toBe(e1.token);

    // At most ONE live password-only session per user.
    expect((await H(req("GET", "/auth/session", { bearer: e1.token }), deps)).status).toBe(401);
    expect((await H(req("GET", "/auth/session", { bearer: e2.enrollmentToken }), deps)).status).toBe(200);
  });

  it("a sibling token cannot enroll a factor after onboarding completes on another one", async () => {
    const { deps } = await makeDeps();
    const e1 = await register(deps, "replay@x.example");
    const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "replay@x.example", password: PW }) }), deps);
    const c = setCookieMap(login);

    // The legitimate user finishes onboarding on the SECOND session.
    const { res: verify } = await enrollPasskey(deps, {
      cookie: `tf_session=${c.tf_session}; tf_csrf=${c.tf_csrf}`, headers: { "x-csrf-token": c.tf_csrf! },
    });
    expect(verify.status).toBe(200);
    expect((await verify.json()).session.status).toBe("authenticated");

    // The first token is inert on the WHOLE enrollment surface — not merely on /sync —
    // so it cannot mint an attacker passkey and a second full session.
    expect((await H(req("GET", "/auth/session", { bearer: e1.token }), deps)).status).toBe(401);
    const fenced: Array<[string, string]> = [
      ["POST", "/auth/2fa/webauthn/register/options"],
      ["POST", "/auth/2fa/webauthn/register/verify"],
      ["POST", "/auth/2fa/totp/enroll"],
      ["POST", "/auth/2fa/totp/activate"],
    ];
    for (const [method, path] of fenced) {
      const res = await H(req(method, path, { bearer: e1.token, body: JSON.stringify({ credential: {}, label: "attacker", code: "000000" }) }), deps);
      expect(res.status, path).toBe(401);
    }
  });

  it("the revocation is keyed on the USER: a bystander's enrollment session is untouched", async () => {
    const { deps } = await makeDeps();
    const a = await register(deps, "a@x.example");
    const bystander = await register(deps, "b@x.example");

    // A completes onboarding — which sweeps A's enrollment sessions.
    const { res: verify } = await enrollPasskey(deps, { cookie: a.cookie, headers: { "x-csrf-token": a.csrf } });
    expect(verify.status).toBe(200);
    // …and a full two-factor login by A likewise.
    const relogin = await loginWithPasskey(deps, "a@x.example", (await enrollPasskey(deps, {
      cookie: `tf_session=${setCookieMap(verify).tf_session}; tf_csrf=${setCookieMap(verify).tf_csrf}`,
      headers: { "x-csrf-token": setCookieMap(verify).tf_csrf! },
    })).authenticator);
    expect(relogin.status).toBe(200);

    // B is mid-onboarding on their own account and is entirely unaffected.
    const intro = await H(req("GET", "/auth/session", { bearer: bystander.token }), deps);
    expect(intro.status).toBe(200);
    expect((await intro.json()).scope).toBe("enrollment");
  });
});

describe("adding a factor is no easier than removing one", () => {
  it("a still-valid but STALE full session cannot enroll a new factor (403 step_up_required)", async () => {
    const { deps, clock } = await makeDeps();
    const e = await register(deps, "stale-full@x.example");
    const { res: verify } = await enrollPasskey(deps, { cookie: e.cookie, headers: { "x-csrf-token": e.csrf } });
    const full = setCookieMap(verify);
    const cookie = `tf_session=${full.tf_session}; tf_csrf=${full.tf_csrf}`;
    const headers = { "x-csrf-token": full.tf_csrf! };

    // Fresh: enrolling a second factor is allowed.
    expect((await H(req("POST", "/auth/2fa/totp/enroll", { cookie, headers }), deps)).status).toBe(200);

    // Past the step-up window but well inside accessTtlMs — a stolen cookie, an
    // unattended browser, a long-lived native bearer. Adding a factor would grant
    // durable independent access, so it needs a recent 2FA exactly like REMOVING one.
    clock.advance(6 * 60_000);
    for (const [method, path] of [
      ["POST", "/auth/2fa/totp/enroll"],
      ["POST", "/auth/2fa/webauthn/register/options"],
    ] as Array<[string, string]>) {
      const res = await H(req(method, path, { cookie, headers }), deps);
      expect(res.status, path).toBe(403);
      expect((await res.json()).error.code, path).toBe("step_up_required");
    }
    // The verify legs too, not just the options legs.
    const verifyLeg = await H(
      req("POST", "/auth/2fa/webauthn/register/verify", {
        cookie, headers, body: JSON.stringify({ credential: {}, label: "x" }),
      }),
      deps,
    );
    expect(verifyLeg.status).toBe(403);
    expect((await verifyLeg.json()).error.code).toBe("step_up_required");

    // …and the session is otherwise perfectly alive.
    expect((await H(req("GET", "/sync", { cookie }), deps)).status).toBe(200);
  });
});

/**
 * LOGIN CSRF / SESSION FIXATION on the two PUBLIC routes taught to set cookies.
 * `withCsrf` cannot help: it only fires for cookie-authenticated requests, and these
 * carry no session. `SameSite=Strict` does not stop a cookie being STORED from a
 * top-level cross-site response, so without a guard an attacker could plant THEIR
 * account's enrollment session in a victim's browser and have the victim connect their
 * mailbox to it.
 */
describe("the cookie-minting public routes reject cross-site requests", () => {
  const BODY = JSON.stringify({ email: "victim@x.example", password: PW, displayName: "V", inviteCode: "INVITE-OK" });

  it("a form-encodable content type is refused (415) — that is how a cross-site POST carries a body", async () => {
    const { deps } = await makeDeps();
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      for (const path of ["/auth/register", "/auth/login"]) {
        const res = await H(req("POST", path, { headers: { "content-type": ct }, body: BODY }), deps);
        expect(res.status, `${path} ${ct}`).toBe(415);
        expect((await res.json()).error.code).toBe("unsupported_media_type");
        expect(res.headers.getSetCookie(), `${path} ${ct}`).toEqual([]);   // and NO cookie is planted
      }
    }
  });

  it("a hostile Origin or a cross-site Sec-Fetch-Site is refused (403), with no Set-Cookie", async () => {
    const { deps } = await makeDeps();
    const hostile: Array<Record<string, string>> = [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "none" },
    ];
    for (const headers of hostile) {
      for (const path of ["/auth/register", "/auth/login"]) {
        const res = await H(req("POST", path, { headers, body: BODY }), deps);
        expect(res.status, `${path} ${JSON.stringify(headers)}`).toBe(403);
        expect((await res.json()).error.code).toBe("cross_site_denied");
        expect(res.headers.getSetCookie()).toEqual([]);
      }
    }
  });

  it("the first-party shapes still work: the configured Origin, same-origin, and no Origin at all (native)", async () => {
    const { deps } = await makeDeps();
    const ok = await H(
      req("POST", "/auth/register", {
        headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" }, body: BODY,
      }),
      deps,
    );
    expect(ok.status).toBe(201);
    expect(setCookieMap(ok).tf_session).toBeTruthy();
    // Native: no Origin, no Sec-Fetch-* — unaffected, and not a CSRF target anyway.
    const native = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "victim@x.example", password: PW }) }), deps);
    expect(native.status).toBe(200);
  });

  it("the guard covers authenticated mutations too, not just the auth routes", async () => {
    const { deps } = await makeDeps();
    const e = await register(deps, "guarded@x.example");
    const { res: verify } = await enrollPasskey(deps, { cookie: e.cookie, headers: { "x-csrf-token": e.csrf } });
    const full = setCookieMap(verify);
    const res = await H(
      req("POST", "/mailboxes", {
        cookie: `tf_session=${full.tf_session}; tf_csrf=${full.tf_csrf}`,
        headers: { "x-csrf-token": full.tf_csrf!, origin: "https://evil.example" },
        body: JSON.stringify({ provider: "imap", address: "x@y.z" }),
      }),
      deps,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("cross_site_denied");
  });
});

describe("the unauthenticated auth surface answers 400, never 500, on a malformed body", () => {
  it("an empty JSON object on every public credential route → 400 validation_failed", async () => {
    const { deps } = await makeDeps();
    const routes: Array<[string, string]> = [
      ["POST", "/auth/register"],
      ["POST", "/auth/login"],
      ["POST", "/auth/2fa/webauthn/assert/options"],
      ["POST", "/auth/2fa/webauthn/assert/verify"],
      ["POST", "/auth/2fa/totp/verify"],
      ["POST", "/auth/2fa/recovery-codes/verify"],
      ["POST", "/oauth/token"],
    ];
    for (const [method, path] of routes) {
      const res = await H(req(method, path, { body: "{}" }), deps);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect((await res.json()).error.code, `${method} ${path}`).toBe("validation_failed");
    }
  });

  it("malformed JSON is still a 400, and /auth/refresh with nothing is still a 401", async () => {
    const { deps } = await makeDeps();
    const bad = await H(req("POST", "/auth/login", { body: "{not json" }), deps);
    expect(bad.status).toBe(400);
    const refresh = await H(req("POST", "/auth/refresh", { body: "{}" }), deps);
    expect(refresh.status).toBe(401);
  });
});

describe("the fixture bridge is gone", () => {
  it("this file never seeds a session row: the whole flow is HTTP", () => {
    const src = readFileSync(fileURLToPath(new URL(import.meta.url)), "utf8");
    // Assembled from parts so the needle itself is not a false positive.
    expect(src.includes(["seed", "Session", "For"].join(""))).toBe(false);
    expect(src.includes(["seed", "Session"].join(""))).toBe(false);
    expect(src.includes(["db", ".", "insert"].join(""))).toBe(false);
    // Guard against a vacuous assertion: the flow it replaces really is exercised here.
    expect(src).toContain("/auth/register");
    expect(src).toContain("/auth/2fa/webauthn/register/verify");
  });
});
