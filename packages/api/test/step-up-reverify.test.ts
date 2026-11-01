import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, csrfTokenFor, type ApiDeps } from "@trafficflow/api";
import { totpNow, type Db } from "@trafficflow/services";
import { sessions } from "@trafficflow/db";
import { SoftwareAuthenticator } from "../../services/test/webauthn-authenticator.js";
import { makeDeps, seedSessionFor, req, setCookieMap, type TestClock } from "./helpers.js";

/**
 * ═══ STEP-UP RE-VERIFICATION — the inline ceremony that replaced the dead end ═══
 *
 * The reported defect, verbatim: open Settings → Devices more than five minutes after signing
 * in, click "Add a device", and the mint's step-up gate answers 403 — for which the only
 * remedy the product offered was a FULL SIGN-OUT. `POST /auth/step-up/{totp,webauthn/*}`
 * re-runs the sign-in second factor against the session the caller already holds and
 * re-stamps `last_twofa_at`, so the gated verb succeeds on retry without a new session.
 *
 * What this suite pins, each one an auth-class invariant:
 *
 *  1. **The repaired path end-to-end**: stale window → 403 `step_up_required` → factor
 *     re-verify → the SAME session's retry succeeds. For both factors.
 *  2. **Zero Set-Cookie** on every step-up response — re-verification moves a timestamp on an
 *     existing session; nothing about it may mint, rotate or widen a cookie. (Planted a
 *     `Set-Cookie` on the totp handler's 200 → the census went red → removed. The guard has
 *     been watched failing.)
 *  3. **Single-use survives the second door.** The TOTP timestep consumed at sign-in is
 *     refused at step-up (same `lastConsumedStep` row, same conditional advance), and a
 *     sign-in WebAuthn challenge cannot be spent at the step-up verify (challenge rows are
 *     bound to `loginTokenId` XOR `userId`, and a NULL matches no equality).
 *  4. **Same throttle, same lockout.** Wrong codes here count the same `user:` key the
 *     sign-in door counts; five failures lock BOTH doors (423).
 *  5. **A failed factor moves nothing** — `last_twofa_at` is byte-identical after a wrong
 *     code. (Moved the stamp above the verify → this went red → restored. Watched failing.)
 *  6. **An enrollment session is refused at the door** (`withSession`: these routes are not
 *     `enrollmentOk`) — a password-only session must never earn step-up standing.
 */

const app = createApp(apiRoutes);
const PW = "pw-correct-horse";
const CSRF = csrfTokenFor;
const RPID = "localhost";
const ORIGIN = "http://localhost:3000";
const SIX_MIN = 6 * 60_000; // stepUpWindowMs is 5 min; six is unambiguously stale
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/** Register a user; returns identity + the enrollment session's cookie trio. */
async function register(deps: ApiDeps, email: string): Promise<{
  userId: string; accountId: string; cookie: string; csrf: string;
}> {
  const res = await H(
    req("POST", "/auth/register", { body: JSON.stringify({ email, password: PW, displayName: "Gil", inviteCode: "INVITE-OK" }) }),
    deps,
  );
  expect(res.status).toBe(201);
  const { user } = await res.clone().json();
  const c = setCookieMap(res);
  return {
    userId: user.userId, accountId: user.accountId,
    cookie: `tf_session=${c.tf_session}; tf_csrf=${c.tf_csrf}`, csrf: c.tf_csrf!,
  };
}

/** Enroll + activate TOTP off a seeded fresh session; returns the shared secret. */
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
  return secret;
}

/** Full TOTP sign-in; returns the web session's cookie trio. */
async function loginWithTotp(deps: ApiDeps, clock: TestClock, email: string, secret: string): Promise<{
  cookie: string; csrf: string; session: string;
}> {
  const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email, password: PW }) }), deps);
  expect(login.status).toBe(200);
  const { loginToken } = await login.json();
  const verify = await H(
    req("POST", "/auth/2fa/totp/verify", { body: JSON.stringify({ loginToken, code: totpNow(secret, clock.now()) }) }),
    deps,
  );
  expect(verify.status).toBe(200);
  const c = setCookieMap(verify);
  return { cookie: `tf_session=${c.tf_session}; tf_csrf=${c.tf_csrf}`, csrf: c.tf_csrf!, session: c.tf_session! };
}

const mint = (deps: ApiDeps, s: { cookie: string; csrf: string }): Promise<Response> =>
  H(req("POST", "/pair", {
    cookie: s.cookie, headers: { "x-csrf-token": s.csrf },
    body: JSON.stringify({ grant: "device-pair", label: "Owner's phone" }),
  }), deps);

describe("the dead end, repaired — TOTP", () => {
  it("stale window → 403 on the mint → step-up re-verify → the SAME session mints", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const s = await loginWithTotp(deps, clock, "gil@x.example", secret);

    // Five minutes pass. The reported screenshot state: the mint refuses.
    clock.advance(SIX_MIN);
    const refused = await mint(deps, s);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("step_up_required");

    // The inline ceremony: one TOTP code against the session already held.
    const stepUp = await H(
      req("POST", "/auth/step-up/totp", {
        cookie: s.cookie, headers: { "x-csrf-token": s.csrf },
        body: JSON.stringify({ code: totpNow(secret, clock.now()) }),
      }),
      deps,
    );
    expect(stepUp.status).toBe(200);
    expect((await stepUp.json()).ok).toBe(true);
    // ZERO new cookie surface: the session is the one presented; only its factor clock moved.
    expect(stepUp.headers.getSetCookie()).toHaveLength(0);

    // The retry — same cookies, no sign-out, the QR's token arrives.
    const retried = await mint(deps, s);
    expect(retried.status).toBe(200);
    expect((await retried.json()).token).toBeTruthy();
  });

  it("a code spent at sign-in is refused at step-up — single-use survives the second door", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const s = await loginWithTotp(deps, clock, "gil@x.example", secret);

    // NO clock advance: the same 30-second timestep the sign-in verify just consumed.
    const replay = await H(
      req("POST", "/auth/step-up/totp", {
        cookie: s.cookie, headers: { "x-csrf-token": s.csrf },
        body: JSON.stringify({ code: totpNow(secret, clock.now()) }),
      }),
      deps,
    );
    expect(replay.status).toBe(401);
  });

  it("a failed factor moves nothing: last_twofa_at is byte-identical after a wrong code", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const s = await loginWithTotp(deps, clock, "gil@x.example", secret);
    clock.advance(SIX_MIN);

    const before = (await db.select().from(sessions).where(eq(sessions.userId, id.userId)))
      .filter((r) => r.revokedAt === null && r.scope === "full")
      .map((r) => r.lastTwofaAt?.toISOString());

    const failed = await H(
      req("POST", "/auth/step-up/totp", {
        cookie: s.cookie, headers: { "x-csrf-token": s.csrf },
        body: JSON.stringify({ code: "000000" }),
      }),
      deps,
    );
    expect(failed.status).toBe(401);
    expect(failed.headers.getSetCookie()).toHaveLength(0);

    const after = (await db.select().from(sessions).where(eq(sessions.userId, id.userId)))
      .filter((r) => r.revokedAt === null && r.scope === "full")
      .map((r) => r.lastTwofaAt?.toISOString());
    expect(after).toEqual(before);
  });

  it("five wrong codes lock the SAME counter the sign-in door uses (423 on both)", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const s = await loginWithTotp(deps, clock, "gil@x.example", secret);
    clock.advance(SIX_MIN);

    let last = 0;
    for (let i = 0; i < 5; i++) {
      const r = await H(
        req("POST", "/auth/step-up/totp", {
          cookie: s.cookie, headers: { "x-csrf-token": s.csrf },
          body: JSON.stringify({ code: "000000" }),
        }),
        deps,
      );
      last = r.status;
    }
    expect(last).toBe(423);

    // The lockout is the account's, not this door's: the sign-in second factor is locked too.
    const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "gil@x.example", password: PW }) }), deps);
    // The password step may itself already answer 423; if it still issues a challenge, the
    // verify must refuse with the lockout.
    if (login.status === 200) {
      const { loginToken } = await login.json();
      const verify = await H(
        req("POST", "/auth/2fa/totp/verify", { body: JSON.stringify({ loginToken, code: totpNow(secret, clock.now()) }) }),
        deps,
      );
      expect(verify.status).toBe(423);
    } else {
      expect(login.status).toBe(423);
    }
  });

  it("an enrollment session is refused at the door (403 enrollment_incomplete)", async () => {
    const { deps } = await makeDeps();
    const e = await register(deps, "gil@x.example");
    const res = await H(
      req("POST", "/auth/step-up/totp", {
        cookie: e.cookie, headers: { "x-csrf-token": e.csrf },
        body: JSON.stringify({ code: "123456" }),
      }),
      deps,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("enrollment_incomplete");
  });
});

describe("the dead end, repaired — a recovery code, for an authenticator that is gone", () => {
  /** A TOTP sign-in, ten codes minted while its window is fresh, then the window goes stale. */
  async function staleWithCodes(): Promise<{
    deps: ApiDeps; db: Db; clock: TestClock; s: { cookie: string; csrf: string }; codes: string[]; secret: string; userId: string;
  }> {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const s = await loginWithTotp(deps, clock, "gil@x.example", secret);
    const minted = await H(req("POST", "/auth/2fa/recovery-codes", { cookie: s.cookie, headers: { "x-csrf-token": s.csrf } }), deps);
    expect(minted.status).toBe(200);
    const { codes } = await minted.json();
    clock.advance(SIX_MIN);
    return { deps, db, clock, s, codes, secret, userId: id.userId };
  }
  const withCode = (deps: ApiDeps, s: { cookie: string; csrf: string }, code: string): Promise<Response> =>
    H(req("POST", "/auth/step-up/recovery-code", {
      cookie: s.cookie, headers: { "x-csrf-token": s.csrf }, body: JSON.stringify({ code }),
    }), deps);
  const stamps = async (db: Db, userId: string): Promise<Array<string | undefined>> =>
    (await db.select().from(sessions).where(eq(sessions.userId, userId)))
      .filter((r) => r.revokedAt === null && r.scope === "full")
      .map((r) => r.lastTwofaAt?.toISOString());

  it("stale window → 403 → one code → the SAME session mints; the answer counts what is left, and sets no cookie", async () => {
    const { deps, s, codes } = await staleWithCodes();
    expect((await mint(deps, s)).status).toBe(403);
    const stepUp = await withCode(deps, s, `  ${codes[0]}  `);
    expect(stepUp.status, await stepUp.clone().text()).toBe(200);
    expect(await stepUp.json()).toEqual({ ok: true, remainingCodes: 9 });
    expect(stepUp.headers.getSetCookie()).toHaveLength(0);
    expect((await mint(deps, s)).status).toBe(200);
  });

  it("a spent code and a code of an earlier sheet are refused with the wrong-code sentence", async () => {
    const { deps, s, codes, clock } = await staleWithCodes();
    expect((await withCode(deps, s, codes[0]!)).status).toBe(200);
    const again = await withCode(deps, s, codes[0]!);
    expect(again.status).toBe(401);
    expect((await again.json()).error).toMatchObject({ code: "credential_refused", message: "two-factor verification failed" });
    // A new sheet, minted inside the window the first code earned: the old sheet is dead.
    expect((await H(req("POST", "/auth/2fa/recovery-codes", { cookie: s.cookie, headers: { "x-csrf-token": s.csrf } }), deps)).status).toBe(200);
    clock.advance(SIX_MIN);
    const old = await withCode(deps, s, codes[1]!);
    expect(old.status).toBe(401);
    expect((await old.json()).error.message).toBe("two-factor verification failed");
  });

  it("a wrong code moves nothing: the stamp is byte-identical and every code is still there", async () => {
    const { deps, db, s, codes, userId } = await staleWithCodes();
    const before = await stamps(db, userId);
    expect((await withCode(deps, s, "AAAA-BBBB-CCCC")).status).toBe(401);
    expect(await stamps(db, userId)).toEqual(before);
    expect(await (await withCode(deps, s, codes[0]!)).json()).toEqual({ ok: true, remainingCodes: 9 });
  });

  it("five wrong codes lock the SAME counter the TOTP step-up uses (423 on both)", async () => {
    const { deps, s, secret, clock } = await staleWithCodes();
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await withCode(deps, s, `WRNG-${i}000-0000`)).status;
    expect(last).toBe(423);
    const totp = await H(req("POST", "/auth/step-up/totp", {
      cookie: s.cookie, headers: { "x-csrf-token": s.csrf }, body: JSON.stringify({ code: totpNow(secret, clock.now()) }),
    }), deps);
    expect(totp.status).toBe(423);
  });

  it("an enrollment session is refused at the door (403 enrollment_incomplete)", async () => {
    const { deps } = await makeDeps();
    const e = await register(deps, "gil@x.example");
    const res = await withCode(deps, e, "AAAA-BBBB-CCCC");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("enrollment_incomplete");
  });
});

describe("the dead end, repaired — WebAuthn", () => {
  /** Enroll a passkey as the FIRST factor (exchanges the enrollment session for a full one). */
  async function enrollPasskey(deps: ApiDeps, e: { cookie: string; csrf: string }): Promise<{
    authenticator: SoftwareAuthenticator; cookie: string; csrf: string;
  }> {
    const opts = await H(
      req("POST", "/auth/2fa/webauthn/register/options", { cookie: e.cookie, headers: { "x-csrf-token": e.csrf } }),
      deps,
    );
    expect(opts.status).toBe(200);
    const { options } = await opts.json();
    const authenticator = new SoftwareAuthenticator();
    const credential = authenticator.register({ rpID: RPID, challenge: options.challenge, origin: ORIGIN });
    const verify = await H(
      req("POST", "/auth/2fa/webauthn/register/verify", {
        cookie: e.cookie, headers: { "x-csrf-token": e.csrf },
        body: JSON.stringify({ credential, label: "test key" }),
      }),
      deps,
    );
    expect(verify.status).toBe(200);
    const c = setCookieMap(verify);
    // The first factor exchanged the enrollment session for a full one — fresh cookies.
    expect(c.tf_session).toBeTruthy();
    return { authenticator, cookie: `tf_session=${c.tf_session}; tf_csrf=${c.tf_csrf}`, csrf: c.tf_csrf! };
  }

  it("stale window → options → assertion → verify → the gated verb succeeds; zero Set-Cookie", async () => {
    const { deps, clock } = await makeDeps();
    const e = await register(deps, "gil@x.example");
    const s = await enrollPasskey(deps, e);

    clock.advance(SIX_MIN);
    const refused = await mint(deps, s);
    expect(refused.status).toBe(403);

    const opts = await H(
      req("POST", "/auth/step-up/webauthn/options", { cookie: s.cookie, headers: { "x-csrf-token": s.csrf }, body: JSON.stringify({}) }),
      deps,
    );
    expect(opts.status).toBe(200);
    expect(opts.headers.getSetCookie()).toHaveLength(0);
    const { options } = await opts.json();

    const assertion = s2Assert(s, options.challenge);
    const verify = await H(
      req("POST", "/auth/step-up/webauthn/verify", {
        cookie: s.cookie, headers: { "x-csrf-token": s.csrf },
        body: JSON.stringify({ credential: assertion }),
      }),
      deps,
    );
    expect(verify.status).toBe(200);
    expect((await verify.json()).ok).toBe(true);
    expect(verify.headers.getSetCookie()).toHaveLength(0);

    const retried = await mint(deps, s);
    expect(retried.status).toBe(200);

    function s2Assert(sess: { authenticator: SoftwareAuthenticator }, challenge: string): unknown {
      return sess.authenticator.assert({ rpID: RPID, challenge, origin: ORIGIN });
    }
  });

  it("a SIGN-IN challenge cannot be spent at the step-up verify — the bindings are disjoint", async () => {
    const { deps, clock } = await makeDeps();
    const e = await register(deps, "gil@x.example");
    const s = await enrollPasskey(deps, e);
    clock.advance(SIX_MIN);

    // Open a SIGN-IN assertion (login-token-bound challenge row)…
    const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "gil@x.example", password: PW }) }), deps);
    expect(login.status).toBe(200);
    const { loginToken } = await login.json();
    const signInOpts = await H(
      req("POST", "/auth/2fa/webauthn/assert/options", { body: JSON.stringify({ loginToken }) }),
      deps,
    );
    expect(signInOpts.status).toBe(200);
    const { options } = await signInOpts.json();

    // …and present a VALID assertion over it at the step-up door. The challenge row is
    // `loginTokenId`-bound with `userId` NULL, and the step-up consume selects on `userId` —
    // a NULL matches no equality, so there is nothing for it to spend: 401.
    const assertion = s.authenticator.assert({ rpID: RPID, challenge: options.challenge, origin: ORIGIN });
    const crossed = await H(
      req("POST", "/auth/step-up/webauthn/verify", {
        cookie: s.cookie, headers: { "x-csrf-token": s.csrf },
        body: JSON.stringify({ credential: assertion }),
      }),
      deps,
    );
    expect(crossed.status).toBe(401);
  });

  it("two overlapping ceremonies: the verify binds to ITS OWN challenge, and neither burns the other", async () => {
    // The gate finding this pins: `consumeChallenge` keyed on the USER alone takes the NEWEST
    // open challenge, so with two tabs mid-ceremony the OLDER tab's legitimate assertion was
    // matched against the newer tab's challenge — the verify failed (counting toward the
    // shared lockout) AND the newer ceremony was burned. Any session of the same user could
    // repeat that to force failures into a factor lockout. The claim now binds to the
    // challenge the submitted assertion was actually signed over (its own clientDataJSON).
    const { deps, clock } = await makeDeps();
    const e = await register(deps, "gil@x.example");
    const s = await enrollPasskey(deps, e);
    clock.advance(SIX_MIN);

    const openCeremony = async (): Promise<string> => {
      const res = await H(
        req("POST", "/auth/step-up/webauthn/options", { cookie: s.cookie, headers: { "x-csrf-token": s.csrf }, body: JSON.stringify({}) }),
        deps,
      );
      expect(res.status).toBe(200);
      return (await res.json()).options.challenge;
    };
    const verify = (assertion: unknown): Promise<Response> =>
      H(
        req("POST", "/auth/step-up/webauthn/verify", {
          cookie: s.cookie, headers: { "x-csrf-token": s.csrf },
          body: JSON.stringify({ credential: assertion }),
        }),
        deps,
      );

    const c1 = await openCeremony();
    const c2 = await openCeremony(); // the newer row — the one the old lookup would grab

    // The OLDER ceremony's assertion succeeds against its own challenge…
    const a1 = s.authenticator.assert({ rpID: RPID, challenge: c1, origin: ORIGIN });
    expect((await verify(a1)).status).toBe(200);
    // …and the newer ceremony is still whole: its own assertion also succeeds.
    const a2 = s.authenticator.assert({ rpID: RPID, challenge: c2, origin: ORIGIN });
    expect((await verify(a2)).status).toBe(200);
    // Single-use survives the binding change: replaying the first assertion finds no row.
    expect((await verify(a1)).status).toBe(401);
  });

  it("an assertion over a challenge that matches NO open ceremony is a FAILED FACTOR — the lockout fires on schedule", async () => {
    // The verification pass caught this: a valid clientDataJSON naming a challenge with no
    // open row made `consumeChallenge` throw BEFORE `twofaFail` ran — the attempt was
    // reserved but never finalized as a failure, so no `2fa_failed` audit and, at exactly
    // the max-failures boundary, no lockout upgrade (waiting out the window could then skip
    // the lockout entirely). The branch now counts like every other failed factor: the
    // fifth unmatched assertion answers 423, exactly as five wrong TOTP codes do.
    const { deps, clock } = await makeDeps();
    const e = await register(deps, "gil@x.example");
    const s = await enrollPasskey(deps, e);
    clock.advance(SIX_MIN);

    // One ceremony IS open — the attack shape is a selector that names a different value.
    await H(
      req("POST", "/auth/step-up/webauthn/options", { cookie: s.cookie, headers: { "x-csrf-token": s.csrf }, body: JSON.stringify({}) }),
      deps,
    );
    const bogus = Buffer.from("never-minted-challenge-value").toString("base64url");
    let last = 0;
    for (let i = 0; i < 5; i++) {
      const assertion = s.authenticator.assert({ rpID: RPID, challenge: bogus, origin: ORIGIN });
      const r = await H(
        req("POST", "/auth/step-up/webauthn/verify", {
          cookie: s.cookie, headers: { "x-csrf-token": s.csrf },
          body: JSON.stringify({ credential: assertion }),
        }),
        deps,
      );
      last = r.status;
    }
    expect(last).toBe(423);
  });

  it("with no passkey enrolled the options endpoint says so (422), not a broken ceremony", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);
    const s = await loginWithTotp(deps, clock, "gil@x.example", secret);

    const res = await H(
      req("POST", "/auth/step-up/webauthn/options", { cookie: s.cookie, headers: { "x-csrf-token": s.csrf }, body: JSON.stringify({}) }),
      deps,
    );
    expect(res.status).toBe(422);
  });
});
