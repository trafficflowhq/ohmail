import { describe, it, expect } from "vitest";
import { managedAddress } from "../../../test/support/fixture-credentials.js";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import { staffUsers, staffSessions, authThrottle } from "@trafficflow/db/cloud";
import { scryptHasher, totpNow, newTotpSecret } from "@trafficflow/services";
import { eq } from "drizzle-orm";
import { makeDeps, FIXED_NOW } from "./helpers.js";

/**
 * `POST /admin/staff/*` — the console's login wall.
 *
 * What has to be true here, and why each is a property somebody could get wrong quietly:
 *
 *  1. **A failure never says WHICH factor failed.** Wrong email, wrong password and wrong code
 *     answer one shape. Telling an attacker holding a leaked password that the password is good
 *     is a targeting hint, and it costs nothing to withhold.
 *  2. **A TOTP code is single-use inside its own 30-second window.** Without that the same six
 *     digits are a live credential for the rest of the step — which is a real sign-in for
 *     anyone who read them over a shoulder.
 *  3. **The session is a row, so revoking it works immediately** — not at the next expiry.
 *  4. **Nothing here leaks the sealed secret or the hash.** The TOTP secret is shown exactly
 *     once, at enrolment, and never again by any route.
 *  5. **The throttle bites**, on the email and on the (hashed) IP, and a clean sign-in clears
 *     it so yesterday's typos do not lock out today.
 */

const app = createApp(apiRoutes);
const SECRET = "admin-staff-console-fixture-token";
const ADMIN: AdminConfig = { secret: SECRET, environment: "test" };

const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

function post(path: string, body: unknown, opts: { bearer?: string; ip?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  return new Request(`https://api.test${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const EMAIL = managedAddress("fixture.ops");
const PASSWORD = "admin-staff-sign-in-fixture-password";

/** A staff row with a password and, optionally, an ACTIVATED authenticator. */
async function seedStaff(
  deps: ApiDeps,
  opts: { activated?: boolean; secret?: string } = {},
): Promise<{ id: string; totpSecret: string }> {
  const totpSecret = opts.secret ?? newTotpSecret();
  const sealed = await deps.keyProvider.encrypt(totpSecret);
  const [row] = await deps.db.insert(staffUsers).values({
    email: EMAIL,
    passwordHash: await scryptHasher.hash(PASSWORD),
    ...(opts.activated
      ? { totpSecretEnc: sealed.ciphertext, totpKeyVersion: sealed.keyVersion, totpActivated: true }
      : {}),
  }).returning();
  return { id: (row as { id: string }).id, totpSecret };
}

async function deps0() {
  const { deps } = await makeDeps();
  return { ...deps, admin: ADMIN } as ApiDeps;
}

describe("staff sign-in — the surface only exists where it is configured", () => {
  it("404s when the host carries no admin secret — not 401, which would advertise it", async () => {
    const { deps } = await makeDeps();
    const res = await H(post("/admin/staff/session", { email: EMAIL, password: PASSWORD }), deps);
    expect(res.status).toBe(404);
  });

  it("401s without the shared secret, on every one of the five", async () => {
    const deps = await deps0();
    for (const path of [
      "/admin/staff/session", "/admin/staff/totp/begin", "/admin/staff/totp/confirm",
      "/admin/staff/whoami", "/admin/staff/sign-out",
    ]) {
      const res = await H(post(path, {}), deps);
      expect(res.status, path).toBe(401);
    }
  });
});

describe("staff sign-in — a failure never names the factor", () => {
  it("answers the same shape for an unknown email and a wrong password", async () => {
    const deps = await deps0();
    await seedStaff(deps, { activated: true });

    const unknown = await H(post("/admin/staff/session",
      { email: managedAddress("fixture.unknown"), password: PASSWORD }, { bearer: SECRET }), deps);
    const wrongPassword = await H(post("/admin/staff/session",
      { email: EMAIL, password: "not the password" }, { bearer: SECRET, ip: "10.0.0.2" }), deps);

    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(await unknown.json()).toEqual({ ok: false, status: "invalid" });
    expect(await wrongPassword.json()).toEqual({ ok: false, status: "invalid" });
  });

  it("answers the same shape for a wrong TOTP code as for a wrong password", async () => {
    const deps = await deps0();
    await seedStaff(deps, { activated: true });
    const res = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD, code: "000000" }, { bearer: SECRET }), deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, status: "invalid" });
  });
});

describe("staff sign-in — the happy path, and what it hands back", () => {
  it("asks for the second factor before it gives anything", async () => {
    const deps = await deps0();
    await seedStaff(deps, { activated: true });
    const res = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD }, { bearer: SECRET }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, status: "totp_required" });
  });

  it("signs in with a valid code and returns a token that whoami recognises", async () => {
    const deps = await deps0();
    const { id, totpSecret } = await seedStaff(deps, { activated: true });

    const res = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD, code: totpNow(totpSecret, FIXED_NOW) },
      { bearer: SECRET }), deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; token: string; email: string };
    expect(body.ok).toBe(true);
    expect(body.email).toBe(EMAIL);
    expect(body.token.length).toBeGreaterThan(32);

    const who = await H(post("/admin/staff/whoami", { token: body.token }, { bearer: SECRET }), deps);
    // EXACT, still: whoami answers with the identity and the step-up POLICY (cloud 0036 — the
    // console renders its sentences from `stepUpWindowSeconds` rather than repeating "five
    // minutes" in its own copy) and with nothing else. A field appearing here is a field the
    // browser gets.
    // Cloud 0047 adds `roles`, read live; this fixture holds none, and says so.
    // `staffId` is the id the staff audit records the caller under, so the console can name its
    // own rows; an id, never a credential.
    expect(await who.json()).toEqual({
      ok: true, staffId: id, email: EMAIL, roles: [], stepUpWindowSeconds: 300, stepUpFresh: true,
    });
  });

  it("stores the session as a HASH — the token itself is never written down", async () => {
    const deps = await deps0();
    const { totpSecret } = await seedStaff(deps, { activated: true });
    const res = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD, code: totpNow(totpSecret, FIXED_NOW) },
      { bearer: SECRET }), deps);
    const { token } = await res.json() as { token: string };

    const rows = await deps.db.select().from(staffSessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.tokenHash).not.toContain(token);
  });
});

describe("staff sign-in — a code is single-use inside its own window", () => {
  it("refuses the SAME six digits a second time, at the same instant", async () => {
    const deps = await deps0();
    const { totpSecret } = await seedStaff(deps, { activated: true });
    const code = totpNow(totpSecret, FIXED_NOW);

    const first = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD, code }, { bearer: SECRET }), deps);
    expect(first.status).toBe(200);

    // Same code, same clock — a replay, and the only thing standing in its way is that the
    // consumed step was advanced by the first call.
    const second = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD, code }, { bearer: SECRET, ip: "10.0.0.9" }), deps);
    expect(second.status).toBe(401);
    expect(await second.json()).toEqual({ ok: false, status: "invalid" });
  });
});

describe("staff enrolment — the first sign-in sets up the authenticator", () => {
  it("hands out an enrolment token instead of a session when nothing is enrolled", async () => {
    const deps = await deps0();
    await seedStaff(deps);
    const res = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD }, { bearer: SECRET }), deps);
    const body = await res.json() as { ok: boolean; status: string; enrollToken: string };
    expect(body.ok).toBe(false);
    expect(body.status).toBe("enrollment_required");
    expect(body.enrollToken.length).toBeGreaterThan(20);
  });

  it("an enrolment token is NOT a session — whoami refuses it", async () => {
    const deps = await deps0();
    await seedStaff(deps);
    const res = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD }, { bearer: SECRET }), deps);
    const { enrollToken } = await res.json() as { enrollToken: string };

    const who = await H(post("/admin/staff/whoami", { token: enrollToken }, { bearer: SECRET }), deps);
    expect(who.status).toBe(401);
  });

  it("shows the secret once, then activates only on a code from it", async () => {
    const deps = await deps0();
    const { id } = await seedStaff(deps);
    const start = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD }, { bearer: SECRET }), deps);
    const { enrollToken } = await start.json() as { enrollToken: string };

    const begun = await H(post("/admin/staff/totp/begin", { enrollToken }, { bearer: SECRET }), deps);
    const { secret, otpauthUrl } = await begun.json() as { secret: string; otpauthUrl: string };
    expect(secret.length).toBeGreaterThan(10);
    expect(otpauthUrl).toContain("otpauth://totp/");
    expect(otpauthUrl).toContain("ohmail");

    // A wrong code does not activate.
    const bad = await H(post("/admin/staff/totp/confirm",
      { enrollToken, code: "000000" }, { bearer: SECRET }), deps);
    expect(bad.status).toBe(401);
    const [beforeRow] = await deps.db.select().from(staffUsers).where(eq(staffUsers.email, EMAIL));
    expect(beforeRow!.totpActivated).toBe(false);

    // A right one activates AND signs in — having just proved possession, the operator should
    // not immediately have to prove it again.
    const good = await H(post("/admin/staff/totp/confirm",
      { enrollToken, code: totpNow(secret, FIXED_NOW) }, { bearer: SECRET }), deps);
    expect(good.status).toBe(200);
    const body = await good.json() as { ok: boolean; token: string };
    expect(body.ok).toBe(true);

    const who = await H(post("/admin/staff/whoami", { token: body.token }, { bearer: SECRET }), deps);
    // EXACT, still: whoami answers with the identity and the step-up POLICY (cloud 0036 — the
    // console renders its sentences from `stepUpWindowSeconds` rather than repeating "five
    // minutes" in its own copy) and with nothing else. A field appearing here is a field the
    // browser gets.
    // Cloud 0047 adds `roles`, read live; this fixture holds none, and says so.
    expect(await who.json()).toEqual({
      ok: true, staffId: id, email: EMAIL, roles: [], stepUpWindowSeconds: 300, stepUpFresh: true,
    });
  });

  it("seals the secret at rest — the stored column is not the secret", async () => {
    const deps = await deps0();
    await seedStaff(deps);
    const start = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD }, { bearer: SECRET }), deps);
    const { enrollToken } = await start.json() as { enrollToken: string };
    const begun = await H(post("/admin/staff/totp/begin", { enrollToken }, { bearer: SECRET }), deps);
    const { secret } = await begun.json() as { secret: string };

    // The PENDING pair, because `begin` writes there and never over the live one (cloud 0036).
    const [row] = await deps.db.select().from(staffUsers).where(eq(staffUsers.email, EMAIL));
    expect(row!.totpPendingSecretEnc).not.toBe(secret);
    expect(row!.totpPendingSecretEnc).not.toContain(secret);
    expect(row!.totpPendingKeyVersion).not.toBeNull();
    // And the live pair is untouched by a begun enrolment — the property that keeps an abandoned
    // one from locking anybody out.
    expect(row!.totpSecretEnc).toBeNull();
    expect(row!.totpActivated).toBe(false);
  });

  it("refuses to begin an enrolment without a token — a bare POST enrols nobody", async () => {
    const deps = await deps0();
    await seedStaff(deps);
    const res = await H(post("/admin/staff/totp/begin", {}, { bearer: SECRET }), deps);
    expect(res.status).toBe(401);
  });

  it("refuses a FORGED enrolment token", async () => {
    const deps = await deps0();
    const { id } = await seedStaff(deps);
    const forged = `${id}.${Math.floor(FIXED_NOW.getTime() / 1000) + 600}.${"a".repeat(64)}`;
    const res = await H(post("/admin/staff/totp/begin", { enrollToken: forged }, { bearer: SECRET }), deps);
    expect(res.status).toBe(401);
  });
});

describe("staff sessions — revocable, which is the whole reason they are rows", () => {
  it("sign-out kills the session immediately, not at its expiry", async () => {
    const deps = await deps0();
    const { totpSecret } = await seedStaff(deps, { activated: true });
    const res = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD, code: totpNow(totpSecret, FIXED_NOW) },
      { bearer: SECRET }), deps);
    const { token } = await res.json() as { token: string };

    expect((await H(post("/admin/staff/whoami", { token }, { bearer: SECRET }), deps)).status).toBe(200);
    await H(post("/admin/staff/sign-out", { token }, { bearer: SECRET }), deps);
    expect((await H(post("/admin/staff/whoami", { token }, { bearer: SECRET }), deps)).status).toBe(401);
  });

  it("refuses a token that was never issued", async () => {
    const deps = await deps0();
    await seedStaff(deps, { activated: true });
    const res = await H(post("/admin/staff/whoami",
      { token: "b".repeat(64) }, { bearer: SECRET }), deps);
    expect(res.status).toBe(401);
  });
});

describe("staff sign-in — the throttle", () => {
  it("locks after five failures, on a key the IP cannot be read out of", async () => {
    const deps = await deps0();
    await seedStaff(deps, { activated: true });

    for (let i = 0; i < 5; i += 1) {
      await H(post("/admin/staff/session",
        { email: EMAIL, password: "wrong" }, { bearer: SECRET, ip: "203.0.113.7" }), deps);
    }
    const locked = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD }, { bearer: SECRET, ip: "203.0.113.7" }), deps);
    expect(locked.status).toBe(429);
    const body = await locked.json() as { status: string; retryAfterSeconds: number };
    expect(body.status).toBe("throttled");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);

    // The right password is refused too — that is the point of a lock.
    const rows = await deps.db.select().from(authThrottle);
    const keys = rows.map((r) => r.key);
    expect(keys.some((k) => k.startsWith("staff:email:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("staff:ip:"))).toBe(true);
    // The address itself is NOT in the table. An ops table is not a record of where somebody
    // was working from.
    expect(rows.some((r) => r.key.includes("203.0.113.7"))).toBe(false);
  });

  it("keys the client on the trusted hop: a first x-forwarded-for hop the caller wrote mints no bucket", async () => {
    const deps = await deps0();
    await seedStaff(deps, { activated: true });
    const hit = (i: number) => H(new Request("https://api.test/admin/staff/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${SECRET}`,
        // A new invented first hop and a new address every time; the proxy's last hop is one.
        "x-forwarded-for": `10.66.${i}.1, 203.0.113.50`,
      },
      body: JSON.stringify({ email: `nobody-${i}@ohmail.app`, password: "wrong" }),
    }), deps);
    for (let i = 0; i < 5; i += 1) expect((await hit(i)).status).toBe(401);
    expect((await hit(5)).status, "each invented first hop bought a fresh bucket").toBe(429);
    const keys = (await deps.db.select().from(authThrottle)).map((r) => r.key);
    expect(keys.filter((k) => k.startsWith("staff:ip:"))).toHaveLength(1);
    expect(keys.filter((k) => k.includes("@")), "a typed staff address in a key").toEqual([]);
  });

  it("a clean sign-in clears the failures, so yesterday's typos do not lock out today", async () => {
    const deps = await deps0();
    const { totpSecret } = await seedStaff(deps, { activated: true });

    for (let i = 0; i < 3; i += 1) {
      await H(post("/admin/staff/session",
        { email: EMAIL, password: "wrong" }, { bearer: SECRET, ip: "198.51.100.4" }), deps);
    }
    expect((await deps.db.select().from(authThrottle)).length).toBeGreaterThan(0);

    const ok = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD, code: totpNow(totpSecret, FIXED_NOW) },
      { bearer: SECRET, ip: "198.51.100.4" }), deps);
    expect(ok.status).toBe(200);
    expect(await deps.db.select().from(authThrottle)).toHaveLength(0);
  });

  /**
   * THE CONSOLE SIGNS IN WITH TWO CALLS, AND THAT MUST COST ONE ATTEMPT, NOT TWO.
   *
   * The gate reserves an attempt BEFORE the scrypt (that is what makes the five-attempt window a
   * bound on guesses rather than on how fast one client can read a row), so the
   * `{email,password}` → `totp_required` half has to give its reservation back. Without the
   * refund each clean sign-in spends two of five and the third one of the day is locked out.
   * Remove the `throttleRefund` calls on the `totp_required` / `enrollment_required` returns and
   * this goes red.
   */
  it("the two-call sign-in spends nothing: three round trips do not eat the budget", async () => {
    const deps = await deps0();
    const { totpSecret } = await seedStaff(deps, { activated: true });

    for (let i = 0; i < 3; i += 1) {
      const first = await H(post("/admin/staff/session",
        { email: EMAIL, password: PASSWORD }, { bearer: SECRET, ip: "198.51.100.9" }), deps);
      expect((await first.json() as { status: string }).status).toBe("totp_required");
    }
    const rows = await deps.db.select().from(authThrottle);
    for (const r of rows) {
      expect(r.failures).toBe(0);
      expect(r.lockedUntil).toBeNull();
    }

    // …and the second half still signs in, which is what proves nothing was spent.
    const ok = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD, code: totpNow(totpSecret, FIXED_NOW) },
      { bearer: SECRET, ip: "198.51.100.9" }), deps);
    expect(ok.status).toBe(200);
  });
});

describe("staff enrolment — replacing the authenticator is not a cookie-only power", () => {
  /** A live session for the seeded operator, obtained the ordinary way. */
  async function signedIn(deps: ApiDeps, totpSecret: string): Promise<string> {
    const res = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD, code: totpNow(totpSecret, FIXED_NOW) },
      { bearer: SECRET, ip: "203.0.113.44" }), deps);
    expect(res.status).toBe(200);
    return (await res.json() as { token: string }).token;
  }

  /**
   * A STOLEN SESSION ALONE CANNOT BE TURNED INTO A NEW AUTHENTICATOR.
   *
   * `totp/begin` returns the new secret in its response body, so authorising it from a session
   * alone meant one stolen cookie was worth: a fresh TOTP secret, an activation, a brand-new
   * 12-hour session, and the real operator locked out of their own authenticator. Delete the
   * password verification in `authorizeEnrollment` and this goes red.
   */
  it("refuses totp/begin from a live session with no password", async () => {
    const deps = await deps0();
    const { totpSecret } = await seedStaff(deps, { activated: true });
    const token = await signedIn(deps, totpSecret);

    const res = await H(post("/admin/staff/totp/begin",
      { sessionToken: token }, { bearer: SECRET }), deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized" } });

    // A WRONG password is refused identically — the session is not the thing being doubted.
    const wrong = await H(post("/admin/staff/totp/begin",
      { sessionToken: token, password: "not the password" }, { bearer: SECRET }), deps);
    expect(wrong.status).toBe(401);
    // Password hashes and a store, no wait of its own: 1.2 s as a rule, 2.6 s once on a loaded CI VM,
    // 41 s under 10% of a CPU.
  }, 90_000);

  it("allows re-enrolment with the session AND the password — a lost phone is still recoverable", async () => {
    const deps = await deps0();
    const { totpSecret } = await seedStaff(deps, { activated: true });
    const token = await signedIn(deps, totpSecret);

    const begun = await H(post("/admin/staff/totp/begin",
      { sessionToken: token, password: PASSWORD }, { bearer: SECRET }), deps);
    expect(begun.status).toBe(200);
    const { secret: fresh } = await begun.json() as { secret: string };
    expect(fresh).not.toBe(totpSecret);

    const confirmed = await H(post("/admin/staff/totp/confirm",
      { sessionToken: token, password: PASSWORD, code: totpNow(fresh, FIXED_NOW) },
      { bearer: SECRET }), deps);
    expect(confirmed.status).toBe(200);
    const body = await confirmed.json() as { ok: boolean; status: string; token?: string };
    expect(body.ok).toBe(true);
    // NO NEW SESSION. Re-minting one would restart the 12-hour clock from the credential being
    // presented, so a thief who also had the password could keep a stolen cookie alive for ever
    // by re-enrolling before each expiry. Remove the `viaSession` arm in `totpConfirm` and this
    // goes red with a `token` in the body.
    expect(body.status).toBe("reenrolled");
    expect(body.token).toBeUndefined();
    // Exactly the one session that existed before the re-enrolment.
    expect(await deps.db.select().from(staffSessions)).toHaveLength(1);
  });

  /** The FIRST enrolment still mints one: that caller holds no session yet. */
  it("still mints a session for the enrolment-token arm", async () => {
    const deps = await deps0();
    await seedStaff(deps, { activated: false });
    const first = await H(post("/admin/staff/session",
      { email: EMAIL, password: PASSWORD }, { bearer: SECRET }), deps);
    const { enrollToken } = await first.json() as { enrollToken: string };

    const begun = await H(post("/admin/staff/totp/begin", { enrollToken }, { bearer: SECRET }), deps);
    expect(begun.status).toBe(200);
    const { secret: fresh } = await begun.json() as { secret: string };

    const confirmed = await H(post("/admin/staff/totp/confirm",
      { enrollToken, code: totpNow(fresh, FIXED_NOW) }, { bearer: SECRET }), deps);
    expect(confirmed.status).toBe(200);
    const body = await confirmed.json() as { status: string; token?: string };
    expect(body.status).toBe("signed_in");
    expect(typeof body.token).toBe("string");
  });
});
