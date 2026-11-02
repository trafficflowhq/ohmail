import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, unverifiedMayReach, type ApiDeps } from "@trafficflow/api";
import { users } from "@trafficflow/db";
import { loginTokens, authThrottle } from "@trafficflow/db/cloud";
import { eq } from "drizzle-orm";
import { makeAuthService, makeMailService, makeTestAuthDeps, throttleKeysFor } from "@trafficflow/services";
import {
  makeDeps, seedSession, req, setCookieMap, cookieMaxAge, FIXED_NOW,
} from "./helpers.js";

/**
 * Stage-2 EMAIL VERIFICATION: the gate, the token scheme, and the pre-hijack it closes.
 *
 * Everything here is over HTTP, because all three subjects are decided at the pipeline and not
 * inside a service:
 *
 *  · The GATE is a route option consumed by `withVerifiedEmail`. A service-level test cannot
 *    tell whether a route actually carries the option, which is the only way this can rot — a
 *    future money route that forgets `verifiedEmail: true` is a hole no service test sees.
 *  · The ORDER of `withStepUp` and `withVerifiedEmail` decides which sentence a caller missing
 *    both privileges is given, and ordering exists only in the composed chain.
 *  · The TOKEN endpoints have to answer with real status codes and a parseable envelope;
 *    hardening #16 found four 500s on exactly this kind of pre-session surface.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

const PW = "pw-correct-horse-battery-password";
const IP = "198.51.100.7";
const IMAP = { host: "imap.example", port: 993, secure: true, user: "mila", pass: "s3cr3t-imap-password-password" };

const envelope = async (res: Response): Promise<{ code: string; message: string }> => {
  const body = await res.json() as { error?: { code: string; message: string } };
  expect(body.error, `expected an error envelope, got ${JSON.stringify(body)}`).toBeDefined();
  return body.error!;
};

/** Register through the OPEN path and dig the mailed token out of the spy. */
async function openRegister(
  deps: ApiDeps, mailer: { only: (t: "email_verification") => { data: { verifyUrl: string } } },
  email: string, password = PW,
): Promise<string> {
  const res = await H(req("POST", "/auth/register", {
    headers: { "x-vercel-forwarded-for": IP },
    body: JSON.stringify({ email, password, displayName: "A Stranger" }),
  }), deps);
  expect(res.status).toBe(202);
  return new URL(mailer.only("email_verification").data.verifyUrl).searchParams.get("token")!;
}

describe("the gate: an unverified account cannot spend money or connect a mailbox", () => {
  it("POST /mailboxes is 403 email_unverified for an unverified account, 201 for a verified one", async () => {
    const { db, deps } = await makeDeps();
    // Everything else this route needs is satisfied, so the ONLY thing under test is the
    // address: a recent second factor (step-up) and a live subscription (the allowance gate).
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false });

    const refused = await H(req("POST", "/mailboxes", {
      bearer: s.token,
      body: JSON.stringify({ provider: "imap", address: "mila@lichtgrat.example", imap: IMAP }),
    }), deps);
    expect(refused.status).toBe(403);
    const err = await envelope(refused);
    expect(err.code).toBe("email_unverified");
    // The sentence has to tell somebody what to do — this refusal is the end of onboarding for
    // them until they act on it.
    expect(err.message).toMatch(/email/i);

    // The ONLY change: prove the address. Same session, same everything else.
    await db.update(users).set({ emailVerifiedAt: FIXED_NOW }).where(eq(users.id, s.userId));
    const allowed = await H(req("POST", "/mailboxes", {
      bearer: s.token,
      body: JSON.stringify({ provider: "imap", address: "mila@lichtgrat.example", imap: IMAP }),
    }), deps);
    expect(allowed.status).toBe(201);
  });

  it("the READ side is deliberately open, so the wizard can still explain itself", async () => {
    // Gating `GET /account/access` or `GET /mailboxes` would blank the very screens that tell
    // an unverified user what to do next. Nothing is spent by reading.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false });

    expect((await H(req("GET", "/mailboxes", { bearer: s.token }), deps)).status).toBe(200);
    expect((await H(req("GET", "/auth/session", { bearer: s.token }), deps)).status).toBe(200);
  });

  it("GET /auth/session publishes `emailVerified`, so the wizard derives the step from the server", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false });

    const before = await H(req("GET", "/auth/session", { bearer: s.token }), deps);
    expect((await before.json() as { user: { emailVerified: boolean } }).user.emailVerified).toBe(false);

    await db.update(users).set({ emailVerifiedAt: FIXED_NOW }).where(eq(users.id, s.userId));
    const after = await H(req("GET", "/auth/session", { bearer: s.token }), deps);
    expect((await after.json() as { user: { emailVerified: boolean } }).user.emailVerified).toBe(true);
  });

  it("STEP-UP IS REPORTED FIRST when a caller is missing both privileges", async () => {
    // Ordering, asserted. It is the cheaper thing to fix and the one a client can act on
    // automatically, so telling somebody to go and verify their email when they will then be
    // asked for a second factor anyway would be two round trips of bad advice.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: null, emailVerified: false });

    const res = await H(req("POST", "/mailboxes", {
      bearer: s.token,
      body: JSON.stringify({ provider: "imap", address: "mila@lichtgrat.example", imap: IMAP }),
    }), deps);
    expect(res.status).toBe(403);
    expect((await envelope(res)).code).toBe("step_up_required");
  });

  it("an ENROLLMENT-scoped session is still refused first of all", async () => {
    // `withSession` is upstream of both, so the enrollment fence is unchanged by this slice.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, {
      now: FIXED_NOW, lastTwofaAt: null, scope: "enrollment", emailVerified: false,
    });
    const res = await H(req("POST", "/mailboxes", {
      bearer: s.token,
      body: JSON.stringify({ provider: "imap", address: "x@y.example", imap: IMAP }),
    }), deps);
    expect(res.status).toBe(403);
    expect((await envelope(res)).code).toBe("enrollment_incomplete");
  });

  it("EVERY route that spends money or takes a mailbox credential is in a gated class", async () => {
    // The anti-rot assertion, and a later change turned it inside out. The first version expressed it as "these two routes
    // carry the flag", which is a rule about a LIST somebody has to extend — and most
    // routes were never on it. The rule is now a property of the table itself: `Route.cost` is
    // required, and the permissive classes are the frozen census in `spend-gate.test.ts`.
    //
    // What stays HERE is the narrower claim the first version owes, named by route. `POST /billing/checkout`
    // was the other member and this server has no such door — the money moved out — so what is
    // left is the one that takes a CREDENTIAL, plus the manage link, which is the surviving
    // route a person reaches to change what they pay for.
    const MUST_GATE = ["POST /mailboxes", "POST /account/manage-link"];
    for (const entry of MUST_GATE) {
      const [method, pattern] = entry.split(" ");
      const route = apiRoutes.find((r) => r.method === method && r.pattern === pattern);
      expect(route, `${entry} is not in the route table`).toBeDefined();
      expect(unverifiedMayReach(route!.cost), `${entry} must refuse an unproven address`).toBe(false);
    }
  });
});

describe("the token: single-use, expiring, hashed at rest, and bound to the password", () => {
  it("the happy path verifies the address and continues into 2FA enrollment", async () => {
    const { db, deps, mailer } = await makeDeps(undefined, { publicSignup: true });
    const token = await openRegister(deps, mailer, "fresh@example.com");

    const res = await H(req("POST", "/auth/verify-email", {
      headers: { "x-vercel-forwarded-for": IP },
      body: JSON.stringify({ token, password: PW }),
    }), deps);

    expect(res.status).toBe(200);
    const out = await res.json() as { status: string; enrollmentToken?: string };
    // Zero enrolled factors, so this is `login`'s own re-entry answer — the wizard lands on the
    // passkey step rather than being sent back to a sign-in form.
    expect(out.status).toBe("enrollment");
    expect(out.enrollmentToken).toBeTruthy();
    const cookies = setCookieMap(res);
    expect(cookies.tf_session).toBeTruthy();
    // Still an enrollment session: no refresh token, so it cannot be extended (#7). The one
    // tf_refresh line expires an earlier family's.
    expect(cookies.tf_refresh).toBe("");
    expect(cookieMaxAge(res, "tf_refresh")).toBe(0);

    const [user] = await db.select().from(users).where(eq(users.email, "fresh@example.com"));
    expect(user!.emailVerifiedAt).not.toBeNull();
  });

  it("ONLY THE HASH IS STORED — the mailed value never appears in the database", async () => {
    const { db, deps, mailer } = await makeDeps(undefined, { publicSignup: true });
    const token = await openRegister(deps, mailer, "hashed@example.com");

    const rows = await db.select().from(loginTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
    // …and it is purpose-scoped, which is what keeps a MAILED value out of `peekLoginToken` and
    // therefore unpresentable as a first factor (#5).
    expect(rows[0]!.purpose).toBe("email_verify");
  });

  it("A USED TOKEN IS REFUSED, and the second presentation is told nothing extra", async () => {
    const { deps, mailer } = await makeDeps(undefined, { publicSignup: true });
    const token = await openRegister(deps, mailer, "once@example.com");

    const body = JSON.stringify({ token, password: PW });
    const first = await H(req("POST", "/auth/verify-email", {
      headers: { "x-vercel-forwarded-for": IP }, body,
    }), deps);
    expect(first.status).toBe(200);

    const second = await H(req("POST", "/auth/verify-email", {
      headers: { "x-vercel-forwarded-for": IP }, body,
    }), deps);
    expect(second.status).toBe(400);
    const reused = await envelope(second);
    expect(reused.code).toBe("invalid_token");

    // And it is the SAME answer a token that never existed gets. "Already used" must not be
    // distinguishable: a link appears in mailbox-scanner and proxy logs, so telling whoever
    // presents it second that it WAS real confirms the address has an account.
    const never = await H(req("POST", "/auth/verify-email", {
      headers: { "x-vercel-forwarded-for": IP },
      body: JSON.stringify({ token: "not-a-real-token-at-all", password: PW }),
    }), deps);
    expect(never.status).toBe(second.status);
    expect(await envelope(never)).toEqual(reused);
  });

  it("AN EXPIRED TOKEN IS REFUSED", async () => {
    const { db, deps, mailer } = await makeDeps(undefined, { publicSignup: true });
    const token = await openRegister(deps, mailer, "stale@example.com");
    // Age the row past its TTL rather than moving the harness clock, so this case is about the
    // token's own expiry and nothing else.
    await db.update(loginTokens).set({ expiresAt: new Date(FIXED_NOW.getTime() - 1_000) });

    const res = await H(req("POST", "/auth/verify-email", {
      headers: { "x-vercel-forwarded-for": IP },
      body: JSON.stringify({ token, password: PW }),
    }), deps);
    expect(res.status).toBe(400);
    expect((await envelope(res)).code).toBe("invalid_token");
  });

  it("THE PRE-HIJACK: a token alone cannot verify, and a wrong password does not burn it", async () => {
    // THE CASE THIS ENDPOINT'S DESIGN EXISTS FOR. An attacker registers a victim's address with
    // a password THEY choose (the constant 202 makes that free and silent), then waits for the
    // victim to click the perfectly legitimate-looking verification mail. If the token alone were
    // enough, the victim's click would verify the ATTACKER's account.
    const { db, deps, mailer } = await makeDeps(undefined, { publicSignup: true });
    const token = await openRegister(deps, mailer, "victim@example.com", "attacker-password-1");

    // The victim clicks and supplies what they know — which is not the attacker's password.
    const asVictim = await H(req("POST", "/auth/verify-email", {
      headers: { "x-vercel-forwarded-for": "203.0.113.99" },
      body: JSON.stringify({ token, password: "the-victims-own-password" }),
    }), deps);
    expect(asVictim.status).toBe(401);
    expect((await envelope(asVictim)).code).toBe("credential_refused");

    // NOTHING was verified.
    const [user] = await db.select().from(users).where(eq(users.email, "victim@example.com"));
    expect(user!.emailVerifiedAt).toBeNull();

    // …and the token was NOT consumed by the failed attempt: a mistyped password must not cost
    // a legitimate user their only credential.
    const [row] = await db.select().from(loginTokens);
    expect(row!.consumedAt).toBeNull();

    // A missing password is refused too — the field cannot be optional-by-omission.
    const noPassword = await H(req("POST", "/auth/verify-email", {
      headers: { "x-vercel-forwarded-for": IP }, body: JSON.stringify({ token }),
    }), deps);
    expect(noPassword.status).toBe(400);
    expect((await envelope(noPassword)).code).toBe("validation_failed");
  });

  it("A WRONG PASSWORD IS THROTTLED on the same keys `login` uses", async () => {
    // Without this, `/auth/verify-email` is a password-guessing endpoint that bypasses the
    // lockout entirely: an attacker holding a leaked token could brute-force at will. The keys
    // must be the SAME ones, or the two endpoints are two independent budgets.
    const { db, deps, mailer } = await makeDeps(undefined, {
      publicSignup: true, maxFailures: 3,
    });
    const token = await openRegister(deps, mailer, "brute@example.com");

    for (let i = 0; i < 3; i++) {
      const res = await H(req("POST", "/auth/verify-email", {
        headers: { "x-vercel-forwarded-for": IP },
        body: JSON.stringify({ token, password: `guess-${i}-password` }),
      }), deps);
      expect(res.status).toBe(401);
    }

    // Locked out, and the CORRECT password now gets the lockout too — proof the counter governs
    // this endpoint rather than merely being written by it.
    const locked = await H(req("POST", "/auth/verify-email", {
      headers: { "x-vercel-forwarded-for": IP },
      body: JSON.stringify({ token, password: PW }),
    }), deps);
    expect(locked.status).toBe(423);
    expect((await envelope(locked)).code).toBe("account_locked");

    // The keys are `login`'s, spelled as `login` spells them: this client's bucket at this address
    // (`throttle-keys.ts`), so the lock above is the one `/auth/login` meets from the same client.
    const k = throttleKeysFor(deps.keyProvider);
    const keys = (await db.select().from(authThrottle)).map((r) => r.key);
    expect(keys).toContain(`pw:${k.address("brute@example.com")}:${k.client(IP)}`);
    expect(keys.filter((key) => key.includes("@")), "a typed address in a key").toEqual([]);
    const viaLogin = await H(req("POST", "/auth/login", {
      headers: { "x-vercel-forwarded-for": IP },
      body: JSON.stringify({ email: "brute@example.com", password: PW }),
    }), deps);
    expect(viaLogin.status, "the two endpoints kept two budgets").toBe(423);
    // A password failure is not a second-factor failure: `user:` is the factor's key.
    const factor = (await db.select().from(authThrottle)).filter((r) => r.key.startsWith("user:"));
    expect(factor.every((r) => r.failures === 0 && r.lockedUntil === null)).toBe(true);
  });

  it("verification is MONOTONIC — a later link never rewrites the first proof", async () => {
    const { db, deps, mailer } = await makeDeps(undefined, { publicSignup: true });
    const token = await openRegister(deps, mailer, "mono@example.com");
    await H(req("POST", "/auth/verify-email", {
      headers: { "x-vercel-forwarded-for": IP },
      body: JSON.stringify({ token, password: PW }),
    }), deps);

    const [first] = await db.select().from(users).where(eq(users.email, "mono@example.com"));
    const stamped = first!.emailVerifiedAt!;

    // Force a second live token for the same user, as a resend would, and consume it later.
    await db.update(loginTokens).set({ consumedAt: null });
    await H(req("POST", "/auth/verify-email", {
      headers: { "x-vercel-forwarded-for": IP },
      body: JSON.stringify({ token, password: PW }),
    }), deps);

    const [again] = await db.select().from(users).where(eq(users.email, "mono@example.com"));
    expect(again!.emailVerifiedAt!.getTime()).toBe(stamped.getTime());
  });
});

describe("a failed verification send is OBSERVABLE, and still not a request failure", () => {
  it("logs `verification_mail_failed` at error, with NO address in the line", async () => {
    // The one way this endpoint can leave somebody holding an account they cannot finish: the
    // response is constant, so a failed send means the caller was told to check an inbox that
    // stays empty. It must not fail the request (re-entry + resend recovers it) and it must not
    // be silent either.
    const { deps } = await makeDeps(undefined, { publicSignup: true });
    const lines: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
    const rec = (level: string) => (event: string, fields?: Record<string, unknown>) =>
      { lines.push({ level, event, fields }); };
    const logger = {
      level: "info" as const,
      child() { return this; },
      debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error"),
    };
    // A mailer whose transport always fails, injected the same way production injects Resend.
    const failing = makeMailService({
      mailer: { send: async () => ({ status: "failed" as const, retryable: true, error: "provider_down" }) },
      config: {
        appUrl: "http://localhost:3001", siteUrl: "http://localhost:3000",
        supportEmail: "support@ohmail.app",
      },
      throttleKeys: throttleKeysFor(deps.keyProvider),
    });
    const withFailingMail: ApiDeps = {
      ...deps,
      logger: logger as unknown as ApiDeps["logger"],
      services: { ...deps.services, auth: makeAuthService({ ...makeTestAuthDeps({ publicSignup: true }), mail: failing }) },
    };

    const res = await H(req("POST", "/auth/register", {
      headers: { "x-vercel-forwarded-for": IP },
      body: JSON.stringify({ email: "unlucky@example.com", password: PW, displayName: "Unlucky" }),
    }), withFailingMail);

    // STILL the constant 202 — a mail outage is not visible to the caller and does not lose the
    // account.
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('{"status":"ok"}');

    const failure = lines.find((l) => l.event === "verification_mail_failed");
    expect(failure, `expected a verification_mail_failed line, got ${JSON.stringify(lines)}`)
      .toBeDefined();
    expect(failure!.level).toBe("error");
    // NO ADDRESS. A rate is what an operator acts on; a list of addresses is what a log becomes
    // if this field is added "to help debugging".
    expect(JSON.stringify(failure)).not.toContain("unlucky@example.com");
    expect(JSON.stringify(failure)).not.toMatch(/@example\.com/);
  });

  it("a SUCCESSFUL send logs nothing — the line means something", async () => {
    const { deps } = await makeDeps(undefined, { publicSignup: true });
    const lines: string[] = [];
    const rec = () => (event: string) => { lines.push(event); };
    const logger = {
      level: "info" as const, child() { return this; },
      debug: rec(), info: rec(), warn: rec(), error: rec(),
    };
    const res = await H(req("POST", "/auth/register", {
      headers: { "x-vercel-forwarded-for": IP },
      body: JSON.stringify({ email: "lucky@example.com", password: PW, displayName: "Lucky" }),
    }), { ...deps, logger: logger as unknown as ApiDeps["logger"] });
    expect(res.status).toBe(202);
    expect(lines).not.toContain("verification_mail_failed");
  });
});

describe("the resend endpoint has no oracle and refuses cleanly", () => {
  it("it requires a session, so there is no recipient an anonymous caller can name", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("POST", "/auth/verify-email/resend", { body: "{}" }), deps);
    expect(res.status).toBe(401);
    expect((await envelope(res)).code).toBe("unauthorized");
  });

  it("it mails the SESSION's address and ignores any address in the body", async () => {
    // The property that makes it neither a mail bomb nor an enumeration oracle. Even if a future
    // edit read a field from the body, `issueEmailVerification` independently refuses any
    // recipient that is not the user's own address (#14).
    const { db, deps, mailer } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false });
    const [me] = await db.select().from(users).where(eq(users.id, s.userId));

    const res = await H(req("POST", "/auth/verify-email/resend", {
      bearer: s.token,
      headers: { "x-vercel-forwarded-for": IP },
      body: JSON.stringify({ email: "somebody-else@example.com" }),
    }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(me!.email);
    expect(mailer.sent[0]!.to).not.toBe("somebody-else@example.com");
  });

  it("THE PER-IP LIMITER REFUSES WITH A CLEAN 429, never a 500 and never a lockout", async () => {
    const { db, deps } = await makeDeps(undefined, { maxPublicRegistrationsPerWindow: 2 });
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false });

    const send = (): Promise<Response> => H(req("POST", "/auth/verify-email/resend", {
      bearer: s.token, headers: { "x-vercel-forwarded-for": IP }, body: "{}",
    }), deps);

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    const res = await send();
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const err = await envelope(res);
    expect(err.code).toBe("rate_limited");
    // A slot claim, never the 423 `account_locked` "too many failed attempts": nothing failed
    // and there is nothing to unlock. See `ip-throttle.ts`.
    expect(res.status).not.toBe(423);
    expect(res.status).toBeLessThan(500);
  });

  it("the counter keys on a HASH of the IP, and its namespace is swept", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false });
    await H(req("POST", "/auth/verify-email/resend", {
      bearer: s.token, headers: { "x-vercel-forwarded-for": "203.0.113.42" }, body: "{}",
    }), deps);

    const keys = (await db.select().from(authThrottle)).map((r) => r.key);
    expect(keys.some((k) => k.startsWith("verify:ip:"))).toBe(true);
    expect(keys.join(" "), "a rate-limit table is not a place to accumulate visitor IPs")
      .not.toContain("203.0.113.42");
  });

  it("an ALREADY-VERIFIED caller gets the same `{ok:true}` and no new credential", async () => {
    // The response must not vary with state the caller could otherwise infer things from, and
    // re-minting a live 24-hour credential for an address that needs no proof is pure downside.
    const { db, deps, mailer } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    const res = await H(req("POST", "/auth/verify-email/resend", {
      bearer: s.token, headers: { "x-vercel-forwarded-for": IP }, body: "{}",
    }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mailer.sent).toHaveLength(0);
    expect(await db.select().from(loginTokens)).toHaveLength(0);
  });

  it("the resend is NOT on the enrollment surface — that surface stays narrow", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, {
      now: FIXED_NOW, lastTwofaAt: null, scope: "enrollment", emailVerified: false,
    });
    const res = await H(req("POST", "/auth/verify-email/resend", {
      bearer: s.token, headers: { "x-vercel-forwarded-for": IP }, body: "{}",
    }), deps);
    expect(res.status).toBe(403);
    expect((await envelope(res)).code).toBe("enrollment_incomplete");
  });
});
