import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { sessions } from "@trafficflow/db";
import { webauthnChallenges } from "@trafficflow/db/cloud";
import {
  AuthService, makeAuthConfig, makeTestAuthDeps,
  allowedOrigins, defaultOrigin, isAllowedOrigin, normalizeOrigin, resolveCeremonyOrigin,
  type AuthConfig, type AuthDeps, type SessionUser, type ServiceContext, type SessionEstablished,
} from "../src/index.js";
import { SoftwareAuthenticator } from "./webauthn-authenticator.js";

/**
 * MULTI-ORIGIN WEBAUTHN.
 *
 * The topology under test is the shipped one: ONE rpID `ohmail.app` — the registrable
 * domain shared by every product host — and TWO first-party origins
 * (`https://ohmail.app`, the single product origin since that change, and
 * `https://admin.ohmail.app` for staff). Three properties, and they are genuinely
 * independent:
 *
 *  1. ONE credential store — a passkey enrolled on `ohmail.app` logs in on
 *     `admin.ohmail.app`. That is the point of that change; staff must not need a second
 *     passkey, and forking the credential store is what a review flagged.
 *  2. ADMISSION — an origin outside the allow-list never gets a challenge row, and
 *     learns so at OPTIONS time under its own error code.
 *  3. BINDING — a ceremony is pinned to the origin that OPENED it, even though both
 *     origins are allowed. This is the property a naive "expectedOrigin = the whole
 *     allow-list" implementation silently loses, so it is asserted in the exact
 *     shape that would PASS under that implementation.
 */

const RPID = "ohmail.app";
const APP = "https://ohmail.app";
/** A host that only 308s to {@link APP}. Never an auth origin — see NEVER_AUTH_HOSTS. */
const REDIRECT_ONLY = "https://app.ohmail.app";
const ADMIN = "https://admin.ohmail.app";
const PW = "pw-correct-horse";
const START = new Date("2026-07-30T00:00:00.000Z");

/** Assert a thrown/rejected {@link ServiceError}'s code + status (+ message). */
async function expectServiceError(
  run: () => unknown | Promise<unknown>,
  want: { code: string; httpStatus: number; message?: RegExp },
): Promise<void> {
  let caught: any;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  expect(caught, "expected a ServiceError, got none").toBeDefined();
  expect({ code: caught.code, httpStatus: caught.httpStatus })
    .toEqual({ code: want.code, httpStatus: want.httpStatus });
  if (want.message) expect(String(caught.message)).toMatch(want.message);
}

// ── Part 1: configuration is validated at CONSTRUCTION ───────────────────────

describe("AuthConfig origins are validated at construction", () => {
  it("keeps a single-string origin working, unchanged, as a one-element allow-list", () => {
    const cfg = makeAuthConfig({ rpID: "localhost", origin: "http://localhost:3000" });
    expect(cfg.origin).toBe("http://localhost:3000");        // the literal is untouched
    expect(allowedOrigins(cfg)).toEqual(["http://localhost:3000"]);
    expect(defaultOrigin(cfg)).toBe("http://localhost:3000");
    expect(isAllowedOrigin(cfg, "http://localhost:3000")).toBe(true);
    expect(isAllowedOrigin(cfg, "http://localhost:3001")).toBe(false);
    expect(isAllowedOrigin(cfg, null)).toBe(false);
  });

  it("accepts an allow-list, canonicalizes it, and keeps the FIRST entry as the default", () => {
    const cfg = makeAuthConfig({ rpID: RPID, origin: [`${APP}/`, "HTTPS://ADMIN.OHMAIL.APP:443", APP] });
    expect(allowedOrigins(cfg)).toEqual([APP, ADMIN]);        // trailing slash, case, :443, duplicate
    expect(defaultOrigin(cfg)).toBe(APP);
    expect(isAllowedOrigin(cfg, `${ADMIN}/`)).toBe(true);
  });

  it("rejects an rpID that is not a registrable-domain suffix of EVERY origin", () => {
    expect(() => makeAuthConfig({ rpID: RPID, origin: [APP, ADMIN] })).not.toThrow();
    // A redirect-only host IS covered by the rpID, so rule 3 admits it — it is the
    // NEVER_AUTH_HOSTS pass that refuses it. Asserted here so the two checks are not
    // confused for one another (they were the same check before the single-domain
    // rename; see the test below).
    expect(() => makeAuthConfig({ rpID: RPID, origin: [APP, REDIRECT_ONLY] }))
      .toThrow(/REDIRECT-ONLY host/);
    // The inversion: an rpID more specific than the origin.
    expect(() => makeAuthConfig({ rpID: "admin.ohmail.app", origin: APP }))
      .toThrow(/registrable-domain suffix/);
    // A STRING suffix that is not a dot-boundary suffix — the classic off-by-one
    // that would hand `notohmail.app` the RP's credentials.
    expect(() => makeAuthConfig({ rpID: RPID, origin: "https://notohmail.app" }))
      .toThrow(/registrable-domain suffix/);
  });

  it("rejects the malformed shapes a deploy typo produces", () => {
    const USER = "u", PASS = "p";
    const bad: Array<[unknown, RegExp]> = [
      [[], /at least one origin/],
      ["", /non-empty/],
      ["app.ohmail.app", /absolute URL/],                     // scheme missing
      ["https://app.ohmail.app/api", /no path/],
      ["https://app.ohmail.app?x=1", /no path/],
      ["http://app.ohmail.app", /https/],                     // non-loopback http is no secure context
      [`https://${USER}:${PASS}@app.ohmail.app`, /credentials/],
      ["ftp://app.ohmail.app", /http/],
    ];
    for (const [origin, re] of bad) {
      expect(() => makeAuthConfig({ rpID: RPID, origin: origin as string }), String(origin)).toThrow(re);
    }
    expect(() => makeAuthConfig({ rpID: "", origin: APP })).toThrow(/rpID is required/);
    expect(() => makeAuthConfig({ rpID: "https://app.ohmail.app", origin: APP })).toThrow(/bare host/);
  });

  it("http is allowed on loopback only — the dev origin still boots", () => {
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(() => normalizeOrigin("http://staging.ohmail.app")).toThrow(/https/);
  });

  it("`new AuthService(...)` refuses a hand-built config that never went through makeAuthConfig", () => {
    // makeAuthConfig is not the only way to produce an AuthConfig — a deployment can
    // build the literal. Boot must still fail loudly rather than serve ceremonies the
    // BROWSER will refuse, on a user's device, after a green deploy.
    const base = makeTestAuthDeps();
    const broken: AuthDeps = {
      ...base,
      config: { ...base.config, rpID: RPID, origin: [APP, "https://evil.example"] },
    };
    expect(() => new AuthService(broken)).toThrow(/registrable-domain suffix/);
  });

  it("resolveCeremonyOrigin: absent ⇒ default, listed ⇒ itself, unlisted ⇒ origin_not_allowed (403)", async () => {
    const cfg = makeAuthConfig({ rpID: RPID, origin: [APP, ADMIN] });
    expect(resolveCeremonyOrigin(cfg, undefined)).toBe(APP);          // native: no Origin header
    expect(resolveCeremonyOrigin(cfg, "")).toBe(APP);
    expect(resolveCeremonyOrigin(cfg, `${ADMIN}/`)).toBe(ADMIN);
    for (const hostile of ["https://evil.example", "null", "https://app.ohmail.app", "not a url"]) {
      await expectServiceError(() => resolveCeremonyOrigin(cfg, hostile), {
        code: "origin_not_allowed", httpStatus: 403,
      });
    }
  });
});

// ── Part 1b: rpID validation is REGISTRABLE-DOMAIN aware (PSL) ───────────────
//
// A dot-boundary suffix test blocks `evil-ohmail.app` and `notohmail.app` but ACCEPTS a
// public-suffix rpID, and that is a live cross-origin hole rather than a cosmetic gap:
// under `rpID: "app"` both `app.ohmail.app` and `evil.app` satisfy `host.endsWith("." + rp)`,
// so `withRequestGuard` would treat a FOREIGN registrable domain as first-party and one
// credential store would span two owners. A browser refuses such an rpID at ceremony
// time — as it does malformed labels and IP literals — so the deployment would be green
// while every passkey on every device failed. All of it must fail at BOOT instead.

describe("rpID is validated against the Public Suffix List", () => {
  it("THE HOLE: an rpID that is a public suffix cannot span two registrable domains", () => {
    // `app` + {app.ohmail.app, evil.app} — the exact config the dot-boundary check admitted.
    expect(() => makeAuthConfig({ rpID: "app", origin: [APP, "https://evil.app"] }))
      .toThrow(/no dot/);
    // `co.uk` + {acme.co.uk, evil.co.uk} — the multi-label suffix, which a "must contain
    // a dot" rule alone would have waved through.
    expect(() => makeAuthConfig({ rpID: "co.uk", origin: ["https://acme.co.uk", "https://evil.co.uk"] }))
      .toThrow(/PUBLIC SUFFIX/);
    // …and it is not special-casing: even a SINGLE origin under such an rpID is refused,
    // because the rpID itself is the defect.
    expect(() => makeAuthConfig({ rpID: "app", origin: APP })).toThrow(/no dot/);
    expect(() => makeAuthConfig({ rpID: "co.uk", origin: "https://acme.co.uk" }))
      .toThrow(/PUBLIC SUFFIX/);
  });

  it("counts PRIVATE-section suffixes too — the stricter, safer reading", () => {
    // github.io and a hosting platform's app domain are PSL private-section entries: `foo.github.io` and
    // `bar.github.io` are different owners, so `github.io` must not be an rpID either.
    for (const [rpID, origin] of [
      ["github.io", "https://foo.github.io"],
      ["netlify.app", "https://ohmail-staging.netlify.app"],
    ] as const) {
      expect(() => makeAuthConfig({ rpID, origin }), rpID).toThrow(/PUBLIC SUFFIX/);
    }
    // A single-label TLD is caught one rule earlier, by "no dot".
    for (const rpID of ["io", "app", "com", "localhost1"]) {
      expect(() => makeAuthConfig({ rpID, origin: APP }), rpID).toThrow(/no dot/);
    }
  });

  it("rejects an origin whose REGISTRABLE DOMAIN differs from the rpID's, even when the suffix matches", () => {
    // `amazonaws.com` structurally "covers" `bucket.s3.amazonaws.com` — but
    // `s3.amazonaws.com` is a public suffix, so the origin's registrable domain is the
    // WHOLE host: a different owner. This is the half of the rule that the public-suffix
    // check on the rpID alone does not give you.
    expect(() => makeAuthConfig({
      rpID: "amazonaws.com", origin: "https://bucket.s3.amazonaws.com",
    })).toThrow(/must not span a foreign registrable domain/);
    // The shipped topology is unaffected: both origins have registrable domain ohmail.app.
    expect(() => makeAuthConfig({ rpID: RPID, origin: [APP, ADMIN] })).not.toThrow();
  });

  it("rejects IP literals — a browser will not accept one as an rpID", () => {
    for (const rpID of ["1.2.3.4", "10.0.0.1", "192.168.10.10", "[2001:db8::1]"]) {
      expect(() => makeAuthConfig({ rpID, origin: APP }), rpID).toThrow(/IP literal/);
    }
  });

  it("rejects malformed DNS labels", () => {
    const bad: Array<[string, RegExp]> = [
      ["-bad.example.com", /invalid DNS label/],                 // leading hyphen
      ["bad-.example.com", /invalid DNS label/],                 // trailing hyphen
      ["foo_bar.example.com", /invalid DNS label/],              // non-LDH
      ["föö.example.com", /invalid DNS label/],                  // IDN must be punycode
      ["foo..example.com", /empty DNS label/],                   // doubled dot
      ["app.ohmail.app.", /empty DNS label/],                        // trailing dot
      [`${"a".repeat(64)}.example.com`, /longer than 63/],       // label too long
      [`${`${"a".repeat(63)}.`.repeat(4)}com`, /longer than 253/],  // 259 chars total
    ];
    for (const [rpID, re] of bad) {
      expect(() => makeAuthConfig({ rpID, origin: APP }), rpID).toThrow(re);
    }
    // Punycode IS a valid label, so an IDN deployment is not blocked.
    expect(() => makeAuthConfig({ rpID: "xn--80ak6aa92e.com", origin: "https://xn--80ak6aa92e.com" }))
      .not.toThrow();
  });

  it("keeps the NARROW dev exemption: localhost and the loopback literals still boot", () => {
    // The PSL treats `localhost` as a public suffix, so rules 2–3 would reject the config
    // the whole suite and `pnpm dev` use. `makeTestAuthDeps` defaults to exactly this.
    expect(() => makeAuthConfig({ rpID: "localhost", origin: "http://localhost:3000" })).not.toThrow();
    expect(() => makeAuthConfig({ rpID: "localhost", origin: "http://localhost" })).not.toThrow();
    expect(() => makeAuthConfig({ rpID: "localhost", origin: "http://app.localhost:3000" })).not.toThrow();
    expect(() => makeAuthConfig({ rpID: "127.0.0.1", origin: "http://127.0.0.1:8080" })).not.toThrow();
    expect(() => makeAuthConfig({ rpID: "app.localhost", origin: "http://app.localhost:3000" })).not.toThrow();

    // The exemption skips only rule 1's IP/label checks and rule 3's registrable-domain
    // half — the SUFFIX relation still holds, so a dev rpID cannot reach a real origin.
    expect(() => makeAuthConfig({ rpID: "localhost", origin: APP }))
      .toThrow(/registrable-domain suffix/);
    expect(() => makeAuthConfig({ rpID: "127.0.0.1", origin: APP }))
      .toThrow(/registrable-domain suffix/);
    expect(() => makeAuthConfig({ rpID: "localhost", origin: "http://127.0.0.1:8080" }))
      .toThrow(/registrable-domain suffix/);
  });

  it("MECHANICAL: no REDIRECT-ONLY host can be an auth origin (re-derived)", () => {
    // The assertion the prod-config path owes. It lives in the config validator, so
    // it holds for `makeAuthConfig` AND for a hand-built literal — the shape a prod
    // config takes — on every host, with no deployment flag to forget.
    //
    // WHAT THIS TEST USED TO ASSERT, AND WHY IT NO LONGER CAN. THE rule was "the landing
    // is never an auth origin", and it was total while the landing had its own
    // registrable domain. Since that change the landing and the product are ONE origin —
    // `https://ohmail.app` serves the marketing page to a stranger and the mail client to
    // a session — so there is no landing host distinct from the product host left to
    // refuse, and the rule has no subject. `origins.ts` (NEVER_AUTH_HOSTS) writes out the
    // full history and names what was lost.
    //
    // What survives is narrower and true: hosts that only ever 308 are refused, because a
    // browser cannot complete a ceremony through a redirect.
    for (const redirectOnly of ["https://www.ohmail.app", "https://app.ohmail.app"]) {
      expect(() => makeAuthConfig({ rpID: "ohmail.app", origin: redirectOnly }), redirectOnly)
        .toThrow(/REDIRECT-ONLY host/);
      // …and it cannot be smuggled in alongside a legitimate one.
      expect(() => makeAuthConfig({ rpID: "ohmail.app", origin: [APP, redirectOnly] }), redirectOnly)
        .toThrow(/REDIRECT-ONLY host/);
    }

    const base = makeTestAuthDeps();
    expect(() => new AuthService({
      ...base, config: { ...base.config, rpID: "ohmail.app", origin: REDIRECT_ONLY },
    })).toThrow(/REDIRECT-ONLY host/);

    // THE REVERSAL, asserted rather than assumed: the apex that this list used to refuse
    // outright is now the product's own origin and MUST be admitted, together with the
    // console it shares a credential store with.
    expect(() => makeAuthConfig({ rpID: "ohmail.app", origin: [APP, ADMIN] })).not.toThrow();
    expect(allowedOrigins(makeAuthConfig({ rpID: "ohmail.app", origin: [APP, ADMIN] })))
      .toEqual(["https://ohmail.app", "https://admin.ohmail.app"]);

    // The rpID the product actually ships is the shared registrable domain, and it is
    // legal precisely because the check no longer lives on the rpID.
    expect(makeAuthConfig({ rpID: "ohmail.app", origin: [APP, ADMIN] }).rpID).toBe("ohmail.app");
  });
});

// ── Part 2: the ceremonies, end to end, across two origins ───────────────────

interface Harness {
  db: Awaited<ReturnType<typeof makeTestDb>>;
  svc: AuthService;
  cfg: AuthConfig;
  ctxFor(over?: Partial<ServiceContext>): ServiceContext;
}

async function harness(
  origin: string | string[] = [APP, ADMIN], rpID = RPID,
): Promise<Harness> {
  const db = await makeTestDb();
  const deps = makeTestAuthDeps({ rpID, origin });
  const svc = new AuthService(deps);
  const now = (): Date => START;
  return {
    db, svc, cfg: deps.config,
    ctxFor: (over = {}) => ({
      db, accountId: "", userId: null, now, requestId: "r", ip: "1.2.3.4", ...over,
    }),
  };
}

async function registerUser(h: Harness, email = "gil@x.example"): Promise<SessionUser> {
  const { user } = await h.svc.register(h.ctxFor(), {
    email, password: PW, displayName: "Gil", inviteCode: "INVITE-OK",
  });
  return user;
}

/** A full, step-up'd session ctx — the authorized "adding a factor" caller (#11). */
async function stepUppedCtx(h: Harness, user: SessionUser, origin?: string): Promise<ServiceContext> {
  const [row] = await h.db.insert(sessions).values({
    accountId: user.accountId, userId: user.userId, familyId: randomUUID(), scope: "full",
    accessExpiresAt: new Date(START.getTime() + 3_600_000),
    refreshExpiresAt: new Date(START.getTime() + 7_200_000),
    lastTwofaAt: START, lastSeenAt: START,
  }).returning();
  return h.ctxFor({ userId: user.userId, accountId: user.accountId, sessionId: row!.id, origin });
}

/** Enrol a passkey through the real ceremony, opened AND completed on `origin`. */
async function enrollOn(
  h: Harness, user: SessionUser, origin: string, rpID = RPID,
): Promise<SoftwareAuthenticator> {
  const ctx = await stepUppedCtx(h, user, origin);
  const auth = new SoftwareAuthenticator();
  const { options } = await h.svc.webauthnRegisterOptions(ctx);
  const cred = auth.register({ rpID, challenge: (options as any).challenge, origin });
  await h.svc.webauthnRegisterVerify(ctx, { credential: cred, label: "MacBook" });
  return auth;
}

/** Password step of login; returns the login token (the user must have a factor). */
async function loginToken(h: Harness, origin?: string): Promise<string> {
  const ch = await h.svc.login(h.ctxFor({ origin }), { email: "gil@x.example", password: PW });
  expect(ch.status).toBe("twofa_required");
  return (ch as any).loginToken as string;
}

describe("one rpID, two origins: the ceremonies", () => {
  it("THE ONE-RPID POINT: a passkey enrolled on app.ohmail.app logs in on admin.ohmail.app", async () => {
    const h = await harness();
    const user = await registerUser(h);
    const auth = await enrollOn(h, user, APP);

    // …and the WHOLE login now happens on the ADMIN origin, with no second passkey
    // and no second credential row. Pre-S3 this was impossible by construction.
    const lt = await loginToken(h, ADMIN);
    const { options } = await h.svc.webauthnAssertOptions(h.ctxFor({ origin: ADMIN }), { loginToken: lt });
    const assertion = auth.assert({ rpID: RPID, challenge: (options as any).challenge, origin: ADMIN });
    const est = await h.svc.webauthnAssertVerify(
      h.ctxFor({ origin: ADMIN }), { loginToken: lt, credential: assertion },
    ) as SessionEstablished;

    expect(est.status).toBe("authenticated");
    expect(est.tokens?.accessToken).toBeTruthy();
    expect(est.user.twofaEnrolled.webauthn).toBe(true);
    // ONE credential store: the assertion was verified against the credential the
    // OTHER origin enrolled.
    expect((await h.db.select().from(webauthnChallenges)).map((r) => r.origin).sort())
      .toEqual([ADMIN, APP]);   // registration on APP, assertion on ADMIN, one credential
  });

  it("the ceremony is PINNED to the origin that opened it, even though both are allowed", async () => {
    const h = await harness();
    const user = await registerUser(h);
    const auth = await enrollOn(h, user, APP);
    const lt = await loginToken(h);

    // Options requested from APP ⇒ the challenge row is bound to APP.
    const { options } = await h.svc.webauthnAssertOptions(h.ctxFor({ origin: APP }), { loginToken: lt });

    // The authenticator signs clientDataJSON with ADMIN — an ALLOWED origin — and the
    // verify request carries NO Origin header, so the request-header pin cannot fire.
    // Only `expectedOrigin = the STORED origin` rejects this; handing the allow-list
    // to `expectedOrigin` (the naive multi-origin implementation, which
    // @simplewebauthn happily accepts) would let it through.
    const assertion = auth.assert({ rpID: RPID, challenge: (options as any).challenge, origin: ADMIN });
    await expectServiceError(
      () => h.svc.webauthnAssertVerify(h.ctxFor(), { loginToken: lt, credential: assertion }),
      { code: "credential_refused", httpStatus: 401 },
    );
  });

  it("a verify request arriving FROM the other allowed origin is 401 origin mismatch, before any crypto", async () => {
    const h = await harness();
    const user = await registerUser(h);
    const auth = await enrollOn(h, user, APP);
    const lt = await loginToken(h);
    const { options } = await h.svc.webauthnAssertOptions(h.ctxFor({ origin: APP }), { loginToken: lt });
    const assertion = auth.assert({ rpID: RPID, challenge: (options as any).challenge, origin: APP });

    await expectServiceError(
      () => h.svc.webauthnAssertVerify(h.ctxFor({ origin: ADMIN }), { loginToken: lt, credential: assertion }),
      { code: "credential_refused", httpStatus: 401, message: /origin mismatch/ },
    );
  });

  it("registration is pinned the same way: a passkey may not land through another origin's ceremony", async () => {
    const h = await harness();
    const user = await registerUser(h);
    const ctx = await stepUppedCtx(h, user, ADMIN);
    const auth = new SoftwareAuthenticator();
    const { options } = await h.svc.webauthnRegisterOptions(ctx);            // opened on ADMIN
    const cred = auth.register({ rpID: RPID, challenge: (options as any).challenge, origin: APP });

    // No Origin header at verify ⇒ the pin is the STORED origin alone. And it is a
    // 401, not the 500 the raw @simplewebauthn throw used to produce on the
    // enrollment surface (the one surface a half-onboarded user can reach).
    const nativeCtx = await stepUppedCtx(h, user);
    await expectServiceError(
      () => h.svc.webauthnRegisterVerify(nativeCtx, { credential: cred, label: "x" }),
      { code: "credential_refused", httpStatus: 401 },
    );
  });

  it("ADMISSION: an unlisted origin is refused at OPTIONS time and writes no challenge row", async () => {
    const h = await harness();
    const user = await registerUser(h);
    await enrollOn(h, user, APP);
    const before = (await h.db.select().from(webauthnChallenges)).length;

    await expectServiceError(
      async () => h.svc.webauthnRegisterOptions(await stepUppedCtx(h, user, "https://evil.example")),
      { code: "origin_not_allowed", httpStatus: 403 },
    );
    const lt = await loginToken(h);
    await expectServiceError(
      () => h.svc.webauthnAssertOptions(h.ctxFor({ origin: "https://evil.example" }), { loginToken: lt }),
      { code: "origin_not_allowed", httpStatus: 403 },
    );

    // The refusal is BEFORE the write: nothing was minted for a foreign origin, and
    // the login token is still unspent (the failure costs the user nothing).
    const rows = await h.db.select().from(webauthnChallenges);
    expect(rows).toHaveLength(before);
    expect(rows.every((r) => allowedOrigins(h.cfg).includes(r.origin))).toBe(true);
  });

  it("ADMISSION IS FIRST: the origin is checked before the session read, on BOTH options routes", async () => {
    // The ordering claim, made to bite. `register/options` used to run
    // `requireEnrollmentOrStepUp` — a `sessions` READ — before resolving the origin, so an
    // unlisted origin was answered with a session error and only reached
    // `origin_not_allowed` when its session happened to be valid. Swapping the two lines
    // back turns each 403 below into a 401.
    const h = await harness();
    const user = await registerUser(h);

    // A ctx whose session does NOT exist ⇒ `requireEnrollmentOrStepUp` would 401.
    const stale = h.ctxFor({
      userId: user.userId, accountId: user.accountId, sessionId: randomUUID(),
      origin: "https://evil.example",
    });
    await expectServiceError(() => h.svc.webauthnRegisterOptions(stale), {
      code: "origin_not_allowed", httpStatus: 403,
    });
    // …and the same ctx on an ALLOWED origin does reach the session check, so the 403
    // above is the ORIGIN talking and not a blanket refusal.
    await expectServiceError(
      () => h.svc.webauthnRegisterOptions({ ...stale, origin: APP }),
      { code: "unauthorized", httpStatus: 401 },
    );

    // Symmetric on the assertion leg: a garbage login token would 401 in
    // `peekLoginToken` (also a DB read), but the unlisted origin answers first.
    await expectServiceError(
      () => h.svc.webauthnAssertOptions(
        h.ctxFor({ origin: "https://evil.example" }), { loginToken: "not-a-token" },
      ),
      { code: "origin_not_allowed", httpStatus: 403 },
    );
    await expectServiceError(
      () => h.svc.webauthnAssertOptions(h.ctxFor({ origin: APP }), { loginToken: "not-a-token" }),
      { code: "credential_refused", httpStatus: 401 },
    );

    // Nothing was minted on any of those four attempts.
    expect(await h.db.select().from(webauthnChallenges)).toHaveLength(0);
  });

  it("MEMBERSHIP: a challenge minted for an origin no longer served cannot be completed", async () => {
    const h = await harness();
    const user = await registerUser(h);
    const auth = await enrollOn(h, user, APP);
    const lt = await loginToken(h);
    const { options } = await h.svc.webauthnAssertOptions(h.ctxFor({ origin: APP }), { loginToken: lt });

    // Simulate the origin being dropped from the allow-list between options and
    // verify — a redeploy, or a differently-configured host sharing the database.
    await h.db.update(webauthnChallenges).set({ origin: "https://retired.ohmail.app" })
      .where(eq(webauthnChallenges.type, "authentication"));
    const assertion = auth.assert({ rpID: RPID, challenge: (options as any).challenge, origin: APP });

    await expectServiceError(
      () => h.svc.webauthnAssertVerify(h.ctxFor(), { loginToken: lt, credential: assertion }),
      { code: "credential_refused", httpStatus: 401, message: /origin mismatch/ },
    );
  });

  it("a native client (no Origin header) gets the deployment's DEFAULT origin — pre-S3 behaviour exactly", async () => {
    const h = await harness();
    const user = await registerUser(h);
    await h.svc.webauthnRegisterOptions(await stepUppedCtx(h, user));        // ctx.origin undefined
    const [row] = await h.db.select().from(webauthnChallenges);
    expect(row!.origin).toBe(APP);                                          // the FIRST entry
    expect(row!.rpId).toBe(RPID);                                           // rpID stays single-valued
  });

  it("the stored origin is the one the ceremony was opened on", async () => {
    const h = await harness();
    const user = await registerUser(h);
    await h.svc.webauthnRegisterOptions(await stepUppedCtx(h, user, ADMIN));
    const rows = await h.db.select().from(webauthnChallenges).where(eq(webauthnChallenges.userId, user.userId));
    expect(rows.map((r) => r.origin)).toEqual([ADMIN]);
  });
});

describe("the single-origin deployment is unchanged", () => {
  it("stores, binds and verifies exactly as before when `origin` is one string", async () => {
    const h = await harness("http://localhost:3000", "localhost");
    expect(allowedOrigins(h.cfg)).toEqual(["http://localhost:3000"]);
    const user = await registerUser(h);
    const auth = await enrollOn(h, user, "http://localhost:3000", "localhost");
    const lt = await loginToken(h);
    const { options } = await h.svc.webauthnAssertOptions(h.ctxFor(), { loginToken: lt });
    const assertion = auth.assert({
      rpID: "localhost", challenge: (options as any).challenge, origin: "http://localhost:3000",
    });
    const est = await h.svc.webauthnAssertVerify(
      h.ctxFor(), { loginToken: lt, credential: assertion },
    ) as SessionEstablished;
    expect(est.status).toBe("authenticated");
    const rows = await h.db.select().from(webauthnChallenges);
    expect(rows.map((r) => [r.rpId, r.origin])).toEqual([
      ["localhost", "http://localhost:3000"], ["localhost", "http://localhost:3000"],
    ]);
  });
});
