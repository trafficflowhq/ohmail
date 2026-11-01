import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, users } from "@trafficflow/db";
import { authThrottle, invites } from "@trafficflow/db/cloud";
import { eq } from "drizzle-orm";
import {
  AuthService, makeTestAuthDeps, issueInvite, revokeInvitesFor, MailService, SpyMailer, throttleKeysFor,
  type AuthDeps, type Db, type ServiceContext, type ServiceError, type Tx,
} from "@trafficflow/services";

/**
 * Stage-2 OPEN REGISTRATION, and the four things about it that must not drift.
 *
 * The flag removes ONE gate. Every case here exists because the plausible wrong
 * implementation passes the happy path and fails exactly one of these:
 *
 *  1. **The gate opens** — no invite code, an account exists. (A flag nobody wired.)
 *  2. **An OFFERED code is still judged** — bad, used, expired and revoked all still
 *     refuse WITH THE GATE OPEN. This is the case the obvious implementation gets wrong:
 *     "public signup is on, so skip the invite logic" silently makes revocation a no-op,
 *     and revocation is the documented remedy for a leaked or misdirected invite.
 *  3. **The flag is OFF by default and the invite path is untouched.**
 *  4. **The limiter refuses cleanly** — 429, never a 500, and never the 423
 *     `account_locked` that used to be answered here.
 */

const PW = "pw-correct-horse";
const NOW = new Date("2026-07-31T12:00:00.000Z");
const asTx = (db: Db): Tx => db as unknown as Tx;

interface H {
  db: Db;
  svc: AuthService;
  deps: AuthDeps;
  /** the mailer the open path sends through. `null` when the harness built none. */
  spy: SpyMailer;
  ctx: (over?: Partial<ServiceContext>) => ServiceContext;
}

/**
 * the harness now builds a REAL `MailService` over a `SpyMailer`.
 *
 * The open path's continuation IS a mail (the response is constant, so there is nothing else it
 * could be), and `register` answers `503 signup_unavailable` when the deployment has none. A
 * harness with no mailer would therefore make every open-gate case in this file fail on a
 * configuration refusal rather than on its own subject.
 *
 * `SpyMailer` — never `ResendMailer`. `no-external-network.ts` blocks the socket suite-wide and
 * `ResendMailer` refuses to construct without an injected transport under a test runner, so this
 * is belt and braces; the point of the spy here is that the cases can ASSERT which template went
 * where, which is how the byte-identical-branches property is actually proven.
 *
 * `noMail: true` opts out, for the one case whose subject is the absent mailer.
 */
async function harness(
  over: Parameters<typeof makeTestAuthDeps>[0] & { noMail?: boolean } = {},
): Promise<H> {
  const { noMail, ...cfg } = over;
  const db = await makeTestDb();
  const spy = new SpyMailer();
  const mail = noMail ? null : new MailService({
    mailer: spy,
    config: {
      appUrl: "https://ohmail.app", siteUrl: "https://ohmail.app",
      supportEmail: "support@ohmail.app",
    },
    throttleKeys: throttleKeysFor(makeTestAuthDeps().keyProvider),
  });
  const deps = makeTestAuthDeps(cfg, mail);
  return {
    db,
    deps,
    spy,
    svc: new AuthService(deps),
    ctx: (o: Partial<ServiceContext> = {}): ServiceContext => ({
      db, accountId: "", userId: null, now: () => NOW, requestId: "r", ip: "1.2.3.4", ...o,
    }),
  };
}

/** The open path's ONLY successful shape — a constant, session-less acknowledgement. */
function expectPending(out: Awaited<ReturnType<AuthService["register"]>>): void {
  expect(out.status).toBe("verification_pending");
  // No credential of any kind. `enrollmentToken` on this branch would be the oracle wearing a
  // different hat: a caller who got one for a fresh address and not for a taken one has learned
  // exactly the fact the constant response exists to withhold.
  expect(out).not.toHaveProperty("enrollmentToken");
  expect(out).not.toHaveProperty("user");
}

const body = (email: string, inviteCode?: string): Parameters<AuthService["register"]>[1] => ({
  email, password: PW, displayName: "Stranger", ...(inviteCode === undefined ? {} : { inviteCode }),
});

/** Mint a live invite bound to `email` and return the plaintext code. */
async function mint(h: H, email: string): Promise<string> {
  const { code } = await issueInvite(asTx(h.db), {
    email, now: NOW, expiresAt: new Date(NOW.getTime() + 7 * 24 * 3_600_000),
  });
  return code;
}

const refusal = async (p: Promise<unknown>): Promise<ServiceError> =>
  p.then(() => { throw new Error("expected a refusal, got success"); }, (e: ServiceError) => e);

describe("the gate opens, and ONLY the gate", () => {
  it("publicSignup: a stranger with NO invite code gets an account and a verification mail", async () => {
    const h = await harness({ publicSignup: true });
    const out = await h.svc.register(h.ctx(), body("stranger@example.com"));

    // a CONSTANT acknowledgement, and NO session. Under that change this returned an enrollment
    // session directly; it cannot any more, because a session on this branch and none on the
    // already-registered branch is exactly the account-existence oracle this slice removed.
    expectPending(out);

    // The account really was created, and the address is UNVERIFIED — the two facts the
    // constant response deliberately does not reveal, checked here from inside the boundary.
    const [user] = await h.db.select().from(users).where(eq(users.email, "stranger@example.com"));
    expect(user).toBeTruthy();
    expect(user!.emailVerifiedAt).toBeNull();

    // …and the continuation went to the inbox instead of into the response.
    expect(h.spy.only("email_verification").to).toBe("stranger@example.com");

    // …and no invite row was invented to make it work.
    expect(await h.db.select().from(invites)).toHaveLength(0);
  });

  it("an EMPTY or whitespace-only code is 'no code offered', not a wrong code", async () => {
    const h = await harness({ publicSignup: true });
    expectPending(await h.svc.register(h.ctx(), body("a@example.com", "")));
    expectPending(await h.svc.register(h.ctx(), body("b@example.com", "   ")));
  });

  it("DEFAULT IS OFF: the same body without the flag is still refused", async () => {
    const h = await harness();
    expect(h.deps.config.publicSignup).toBe(false);
    await expect(refusal(h.svc.register(h.ctx(), body("stranger@example.com"))))
      .resolves.toMatchObject({ code: "validation_failed", httpStatus: 400 });
  });
});

describe("an OFFERED code is judged exactly as before, gate open or shut", () => {
  it("a code that is not an invite at all still refuses WITH publicSignup ON", async () => {
    const h = await harness({ publicSignup: true, inviteCodes: new Set<string>() });
    await expect(refusal(h.svc.register(h.ctx(), body("x@example.com", "OHMAIL-ZZZZ-ZZZZ-ZZZZ"))))
      .resolves.toMatchObject({ code: "invite_invalid", httpStatus: 403 });
    // …and the refusal is real: no account was created behind it.
    expect(await h.db.select().from(accounts)).toHaveLength(0);
  });

  it("a REVOKED code still refuses with the gate open — the whole reason this is not a no-op", async () => {
    const h = await harness({ publicSignup: true, inviteCodes: new Set<string>() });
    const code = await mint(h, "revoked@example.com");
    await revokeInvitesFor(asTx(h.db), { email: "revoked@example.com", now: NOW });

    await expect(refusal(h.svc.register(h.ctx(), body("revoked@example.com", code))))
      .resolves.toMatchObject({ code: "invite_expired", httpStatus: 403 });
    expect(await h.db.select().from(accounts)).toHaveLength(0);
  });

  it("an EXPIRED code still refuses with the gate open", async () => {
    const h = await harness({ publicSignup: true, inviteCodes: new Set<string>() });
    // `issueInvite` refuses to MINT one already expired, so it is minted live and then aged
    // — which is what actually happens to an invite nobody redeemed in time.
    const code = await mint(h, "old@example.com");
    await h.db.update(invites)
      .set({ expiresAt: new Date(NOW.getTime() - 1) })
      .where(eq(invites.email, "old@example.com"));

    await expect(refusal(h.svc.register(h.ctx(), body("old@example.com", code))))
      .resolves.toMatchObject({ code: "invite_expired", httpStatus: 403 });
  });

  it("a USED code still refuses with the gate open", async () => {
    const h = await harness({ publicSignup: true, inviteCodes: new Set<string>() });
    const code = await mint(h, "twice@example.com");
    await h.svc.register(h.ctx(), body("twice@example.com", code));
    // Second redemption of the same code, by a second person.
    await expect(refusal(h.svc.register(h.ctx(), body("twice@example.com", code))))
      .resolves.toMatchObject({ code: "invite_used", httpStatus: 409 });
  });

  it("a code bound to SOMEBODY ELSE still refuses with the gate open", async () => {
    const h = await harness({ publicSignup: true, inviteCodes: new Set<string>() });
    const code = await mint(h, "owner@example.com");
    await expect(refusal(h.svc.register(h.ctx(), body("thief@example.com", code))))
      .resolves.toMatchObject({ code: "invite_invalid", httpStatus: 403 });
    // The rightful holder's invite survives the attempt — a probe must not burn it.
    const [row] = await h.db.select().from(invites).where(eq(invites.email, "owner@example.com"));
    expect(row!.consumedAt).toBeNull();
  });

  it("a VALID bound code still works, and is still CONSUMED, with the gate open", async () => {
    const h = await harness({ publicSignup: true, inviteCodes: new Set<string>() });
    const code = await mint(h, "invited@example.com");
    await expect(h.svc.register(h.ctx(), body("invited@example.com", code))).resolves.toBeTruthy();

    const [row] = await h.db.select().from(invites).where(eq(invites.email, "invited@example.com"));
    expect(row!.consumedAt, "an open gate must not turn consumption into a no-op").not.toBeNull();
    expect(row!.consumedByUserId).not.toBeNull();
  });

  it("the invite path is untouched when the flag is OFF", async () => {
    const h = await harness({ inviteCodes: new Set<string>() });
    const code = await mint(h, "gated@example.com");
    await expect(h.svc.register(h.ctx(), body("gated@example.com", code))).resolves.toBeTruthy();
    const [row] = await h.db.select().from(invites).where(eq(invites.email, "gated@example.com"));
    expect(row!.consumedAt).not.toBeNull();
  });
});

describe("the per-IP limiter is the whole bound, so it must not be dodgeable", () => {
  it("refuses the N+1th signup with a CLEAN 429, never a 500 and never a lockout", async () => {
    const h = await harness({ publicSignup: true, maxPublicRegistrationsPerWindow: 2 });
    await h.svc.register(h.ctx(), body("one@example.com"));
    await h.svc.register(h.ctx(), body("two@example.com"));

    const err = await refusal(h.svc.register(h.ctx(), body("three@example.com")));
    expect(err).toMatchObject({ code: "rate_limited", httpStatus: 429 });
    // Not the 423 this endpoint used to answer: there is no account and nothing failed.
    expect(err.httpStatus).not.toBe(423);
    expect(err.httpStatus).toBeLessThan(500);
  });

  it("the PUBLIC cap is what applies when the gate is open, not the invite-path cap", async () => {
    // Both are set, and they differ. If the wrong one is read this passes 20 signups.
    const h = await harness({
      publicSignup: true, maxPublicRegistrationsPerWindow: 1, maxRegistrationsPerWindow: 20,
    });
    await h.svc.register(h.ctx(), body("first@example.com"));
    await expect(refusal(h.svc.register(h.ctx(), body("second@example.com"))))
      .resolves.toMatchObject({ code: "rate_limited" });
  });

  it("an OFFERED invite gets the INVITE cap with the gate open — the public ceiling is not its ceiling", async () => {
    // The case the sibling above cannot see. Both tests set `publicSignup: true`; that one
    // offers no code, so `openGate` and `publicSignup` AGREE and either reading passes it.
    // Here a code IS offered, so `openGate` is false while `publicSignup` stays true — the one
    // arrangement in which the two disagree, and the arrangement production is actually in
    // (`GET /hello` answers `publicSignup: true`).
    //
    // The public ceiling is 1 and the invite ceiling is 20, each path on its own counter.
    // A stranger burns the public slot; the invited user then redeems from the same NAT. Under
    // the defect the invite is metered at 1, the counter is already at 1, and a live
    // operator-issued invite is refused 429 for the rest of the window.
    const h = await harness({
      publicSignup: true, maxPublicRegistrationsPerWindow: 1, maxRegistrationsPerWindow: 20,
    });
    await h.svc.register(h.ctx(), body("stranger@example.com"));
    const code = await mint(h, "invited@example.com");
    await expect(h.svc.register(h.ctx(), body("invited@example.com", code))).resolves.toBeTruthy();
  });

  it("the INVITE cap still bounds the invite path — a higher ceiling is not an absent one", async () => {
    // The inverse mistake this fix could have made: reading `openGate` and then giving the
    // invite path no limit at all. Two invites from one IP against a ceiling of one, and the
    // second must still be refused.
    const h = await harness({
      publicSignup: true, maxPublicRegistrationsPerWindow: 20, maxRegistrationsPerWindow: 1,
    });
    const first = await mint(h, "one@example.com");
    await h.svc.register(h.ctx(), body("one@example.com", first));
    const second = await mint(h, "two@example.com");
    await expect(refusal(h.svc.register(h.ctx(), body("two@example.com", second))))
      .resolves.toMatchObject({ code: "rate_limited", httpStatus: 429 });
  });

  it("a DIFFERENT IP has its own bucket — the limit is per client, not per deployment", async () => {
    const h = await harness({ publicSignup: true, maxPublicRegistrationsPerWindow: 1 });
    await h.svc.register(h.ctx({ ip: "10.0.0.1" }), body("a@example.com"));
    await expect(refusal(h.svc.register(h.ctx({ ip: "10.0.0.1" }), body("b@example.com"))))
      .resolves.toMatchObject({ code: "rate_limited" });
    await expect(h.svc.register(h.ctx({ ip: "10.0.0.2" }), body("c@example.com"))).resolves.toBeTruthy();
  });

  it("the raw IP is never stored — the counter keys on a hash", async () => {
    const h = await harness({ publicSignup: true });
    await h.svc.register(h.ctx({ ip: "203.0.113.9" }), body("hash@example.com"));
    const keys = (await h.db.select().from(authThrottle)).map((r) => r.key);
    expect(keys.some((k) => k.startsWith("register:ip:"))).toBe(true);
    expect(keys.join(" "), "a rate-limit table is not a place to accumulate visitor IPs")
      .not.toContain("203.0.113.9");
  });

  it("AN UNKNOWN CLIENT IP REFUSES on the open path, and still works on the invite path", async () => {
    // the rule was "skip the limit we cannot key" — correct while the email-bound invite
    // row bounded the request. With the gate open there is no other bound, so skipping is
    // unlimited account creation.
    const h = await harness({ publicSignup: true, inviteCodes: new Set<string>() });
    await expect(refusal(h.svc.register(h.ctx({ ip: "" }), body("noip@example.com"))))
      .resolves.toMatchObject({ code: "signup_unavailable", httpStatus: 503 });

    // The operator's path out of that state: an invite still opens an account.
    const code = await mint(h, "noip@example.com");
    await expect(h.svc.register(h.ctx({ ip: "" }), body("noip@example.com", code))).resolves.toBeTruthy();
  });

  it("EVERY attempt costs a slot, including the ones for a taken address", async () => {
    // Under that change this bounded the account-existence ORACLE (#3). The oracle is gone, and the
    // property is now what bounds the MAIL: every attempt sends one, so a free attempt would be
    // a free message into somebody's inbox. Same counter, same assertion, a better reason.
    const h = await harness({ publicSignup: true, maxPublicRegistrationsPerWindow: 3 });
    await h.svc.register(h.ctx(), body("real@example.com"));
    // Two more attempts on the SAME (now taken) address. Each answers the constant 202 — no
    // 409 any more — and each still pays a slot.
    for (let i = 0; i < 2; i++) {
      expectPending(await h.svc.register(h.ctx(), body("real@example.com")));
    }
    await expect(refusal(h.svc.register(h.ctx(), body("fresh@example.com"))))
      .resolves.toMatchObject({ code: "rate_limited" });
  });

  it("the limiter is claimed BEFORE the mail, so a rate-limited probe sends nothing", async () => {
    // Ordering matters here in a way it did not when the refusal was a 409: the slot claim is
    // what stands between `POST /auth/register` and an unbounded mail-bomb aimed at one address.
    // A limiter checked after the send would refuse the response and deliver the message anyway.
    const h = await harness({ publicSignup: true, maxPublicRegistrationsPerWindow: 1 });
    await h.svc.register(h.ctx(), body("one@example.com"));
    expect(h.spy.sent).toHaveLength(1);

    await expect(refusal(h.svc.register(h.ctx(), body("two@example.com"))))
      .resolves.toMatchObject({ code: "rate_limited" });
    expect(h.spy.sent, "a refused attempt must not send").toHaveLength(1);
  });
});

/**
 * THE ACCOUNT-EXISTENCE ORACLE, CLOSED.
 *
 * #3 recorded the 201-vs-409 split as an ACCEPTED risk and named the exact trigger for
 * reversing it: "`MAIL_FROM` armed + a confirmation observed". Both happened, so these are the
 * cases that make the reversal real rather than documented.
 *
 * The mutation each of them catches is the same one: restoring `throw emailTaken(...)` on the
 * open path. That is a two-character edit away at all times, which is why the byte-identity is
 * asserted on the VALUE rather than on a status code somebody could keep in step by hand.
 */
describe("a fresh address and a taken one are indistinguishable on the open path", () => {
  it("the register RESULT is byte-identical for a fresh and an already-registered address", async () => {
    const h = await harness({ publicSignup: true, maxPublicRegistrationsPerWindow: 50 });

    const fresh = await h.svc.register(h.ctx(), body("taken@example.com"));
    // Same address again — this one HAS an account now.
    const taken = await h.svc.register(h.ctx(), body("taken@example.com"));
    // A never-seen address, as the control.
    const other = await h.svc.register(h.ctx(), body("never-seen@example.com"));

    // Deep equality on the whole value, not a status-code comparison: `mailed` and every other
    // field has to agree too, because the route serialises from this object.
    expect(taken).toEqual(fresh);
    expect(taken).toEqual(other);
    expect(JSON.stringify(taken)).toBe(JSON.stringify(fresh));
  });

  it("a taken address creates NOTHING — no second account, no user, no credential", async () => {
    const h = await harness({ publicSignup: true, maxPublicRegistrationsPerWindow: 50 });
    await h.svc.register(h.ctx(), body("taken@example.com"));
    const accountsAfterFirst = (await h.db.select().from(accounts)).length;

    // Three more attempts with a DIFFERENT password and display name — the shape of somebody
    // trying to take over rather than probe.
    for (let i = 0; i < 3; i++) {
      expectPending(await h.svc.register(h.ctx(), {
        email: "taken@example.com", password: "different-password-99", displayName: "Attacker",
      }));
    }

    expect(await h.db.select().from(accounts)).toHaveLength(accountsAfterFirst);
    const rows = await h.db.select().from(users).where(eq(users.email, "taken@example.com"));
    expect(rows).toHaveLength(1);
    // The original display name survived: nothing about the existing account was overwritten.
    expect(rows[0]!.displayName).toBe("Stranger");
  });

  it("the NEWS goes to the inbox: a taken address gets `account_exists`, a fresh one gets the link", async () => {
    const h = await harness({ publicSignup: true, maxPublicRegistrationsPerWindow: 50 });

    await h.svc.register(h.ctx(), body("taken@example.com"));
    expect(h.spy.sent.map((s) => s.template)).toEqual(["email_verification"]);

    await h.svc.register(h.ctx(), body("taken@example.com"));
    expect(h.spy.sent.map((s) => s.template))
      .toEqual(["email_verification", "account_exists"]);
    // Both to the address itself and nowhere else — the whole design rests on only its owner
    // being able to read the difference.
    expect(h.spy.sent.every((s) => s.to === "taken@example.com")).toBe(true);
  });

  it("BOTH branches send exactly ONE mail, so the count does not leak the branch either", async () => {
    const h = await harness({ publicSignup: true, maxPublicRegistrationsPerWindow: 50 });
    await h.svc.register(h.ctx(), body("a@example.com"));
    const afterFresh = h.spy.sent.length;

    await h.svc.register(h.ctx(), body("a@example.com"));
    expect(h.spy.sent.length - afterFresh).toBe(1);
  });

  it("THE INVITE PATH KEEPS ITS 409 — it is a fact about the caller, not an oracle", async () => {
    // `consumeInvite` is email-BOUND, so the only address reachable through the invite path is
    // one an operator mailed a code for. Telling that caller "you already have an account" tells
    // them about themselves. Flattening this to a 202 would cost an invited person a true and
    // actionable sentence in order to protect information they already hold.
    const h = await harness({ publicSignup: true, inviteCodes: new Set<string>() });
    await h.svc.register(h.ctx(), body("dual@example.com", await mint(h, "dual@example.com")));

    const err = await refusal(h.svc.register(
      h.ctx(), body("dual@example.com", await mint(h, "dual@example.com")),
    ));
    expect(err).toMatchObject({ code: "email_taken", httpStatus: 409 });
  });

  it("an INVITE-path registration starts VERIFIED; an open one and a bootstrap code do not", async () => {
    // §6's argument, and the reason it is scoped to a consumed ROW. An email-bound invite was
    // mailed to the address and redeemed from it, which is proof. `cfg.inviteCodes` is unbound,
    // reusable and non-expiring — it proves nothing about an address — so those stay unverified,
    // and so does every open signup.
    const h = await harness({ publicSignup: true, inviteCodes: new Set(["BOOTSTRAP-OK"]) });

    await h.svc.register(h.ctx(), body("invited@example.com", await mint(h, "invited@example.com")));
    const [invited] = await h.db.select().from(users).where(eq(users.email, "invited@example.com"));
    expect(invited!.emailVerifiedAt).not.toBeNull();

    await h.svc.register(h.ctx(), body("boot@example.com", "BOOTSTRAP-OK"));
    const [boot] = await h.db.select().from(users).where(eq(users.email, "boot@example.com"));
    expect(boot!.emailVerifiedAt, "an unbound bootstrap code proves nothing about an address")
      .toBeNull();

    await h.svc.register(h.ctx(), body("open@example.com"));
    const [open] = await h.db.select().from(users).where(eq(users.email, "open@example.com"));
    expect(open!.emailVerifiedAt).toBeNull();
  });

  it("OPEN GATE + NO MAILER ⇒ 503, because the mail is the only continuation", async () => {
    // The inversion of the earlier reasoning. The first version shipped the open gate BECAUSE mail was dark;
    // now that the response is constant, an account created without a sendable verification link
    // is one whose owner was told to check an inbox nothing will arrive in.
    const h = await harness({ publicSignup: true, noMail: true, inviteCodes: new Set<string>() });
    await expect(refusal(h.svc.register(h.ctx(), body("nomail@example.com"))))
      .resolves.toMatchObject({ code: "signup_unavailable", httpStatus: 503 });
    // Nothing was created by the refused attempt.
    expect(await h.db.select().from(users)).toHaveLength(0);

    // …and the invite path still works in that state, which is the operator's way out. It needs
    // no mail precisely because the invite already proved the address.
    const code = await mint(h, "nomail@example.com");
    await expect(h.svc.register(h.ctx(), body("nomail@example.com", code))).resolves.toBeTruthy();
  });

  it("a FAILED send does not fail the request or roll back the account", async () => {
    // Drop-on-failure, from the caller's side. The account must survive a Resend outage:
    // the re-entry path plus the wizard's resend is what recovers it, and rolling back here
    // would turn a provider blip into a lost signup that the user cannot even retry (their
    // address would be free again, but they would have been told nothing at all).
    const h = await harness({ publicSignup: true });
    const failing = new MailService({
      mailer: {
        send: async () => ({ status: "failed" as const, retryable: true, error: "provider_down" }),
      },
      config: {
        appUrl: "https://ohmail.app", siteUrl: "https://ohmail.app",
        supportEmail: "support@ohmail.app",
      },
      throttleKeys: throttleKeysFor(makeTestAuthDeps().keyProvider),
    });
    const svc = new AuthService(makeTestAuthDeps({ publicSignup: true }, failing));

    const out = await svc.register(h.ctx(), body("unlucky@example.com"));
    // The SAME constant shape — a send failure is not visible to the caller either.
    expectPending(out);
    // `mailed` is how the inside of the boundary sees it. It is never serialised.
    expect((out as { mailed: boolean }).mailed).toBe(false);
    // And the account is there, so the re-entry path can reach it.
    expect(await h.db.select().from(users).where(eq(users.email, "unlucky@example.com")))
      .toHaveLength(1);
  });
});

describe("the capacity valve", () => {
  it("past the cap the OPEN path refuses with signup_capacity, and an INVITE still gets in", async () => {
    const h = await harness({ publicSignup: true, publicSignupCap: 1, inviteCodes: new Set<string>() });
    await h.svc.register(h.ctx(), body("first@example.com"));

    await expect(refusal(h.svc.register(h.ctx(), body("second@example.com"))))
      .resolves.toMatchObject({ code: "signup_capacity", httpStatus: 503 });

    // The valve closes on strangers, never on the people an operator chose.
    const code = await mint(h, "invited@example.com");
    await expect(h.svc.register(h.ctx(), body("invited@example.com", code))).resolves.toBeTruthy();
  });

  it("null is uncapped, and is the default", async () => {
    const h = await harness({ publicSignup: true });
    expect(h.deps.config.publicSignupCap).toBeNull();
    expectPending(await h.svc.register(h.ctx(), body("a@example.com")));
    expectPending(await h.svc.register(h.ctx(), body("b@example.com")));
  });
});

/**
 * The address is the account: the login identity, the only recovery path, and what Stripe
 * puts a receipt against. Under that change nobody had to write this check — `consumeInvite` matched
 * the address against a row an operator had minted for a real person, so the invite was
 * serving as an email validator by accident. Opening the gate removed that, and production
 * accepted `not-an-email` as an address minutes after public signup went live.
 */
describe("the address must be an address, now that no invite vouches for it", () => {
  const MALFORMED = [
    "not-an-email",          // the one production actually accepted
    "no-at-sign.example.com",
    "@example.com",          // no local part
    "someone@",              // no domain
    "someone@localhost",     // no dot in the domain
    "two@@example.com",
    "spaces in@example.com",
  ];

  for (const email of MALFORMED) {
    it(`refuses ${JSON.stringify(email)} with 400 validation_failed, and writes nothing`, async () => {
      const h = await harness({ publicSignup: true });
      const err = await refusal(h.svc.register(h.ctx(), body(email)));
      expect(err.code).toBe("validation_failed");
      expect(err.httpStatus).toBe(400);
      // A refusal that still created the account would be the defect wearing an error message.
      expect(await h.db.select().from(accounts)).toHaveLength(0);
    });
  }

  it("accepts the shapes real people actually have", async () => {
    // ONE database for the five. A harness is a PGlite initdb plus every migration (~0.7 s on a
    // quiet host), and five of them held this case at 4 s of its 5 s under a shared CPU. The
    // addresses stay distinct after trim and case-fold, so each takes the fresh-address branch,
    // and the stored rows say so where the constant response cannot.
    const h = await harness({ publicSignup: true, maxPublicRegistrationsPerWindow: 50 });
    for (const email of [
      "a@b.example", "first.last@sub.domain.example", "user+tag@example.org", "UPPER@EXAMPLE.COM",
      "  padded@example.com  ", // trim runs first, so surrounding space is not a malformed address
    ]) {
      expectPending(await h.svc.register(h.ctx(), body(email)));
    }
    expect((await h.db.select().from(users)).map((r) => r.email).sort()).toEqual([
      "a@b.example", "first.last@sub.domain.example", "padded@example.com", "upper@example.com",
      "user+tag@example.org",
    ]);
  });

  it("normalizes before storing, so Case@ and case@ are one account", async () => {
    const h = await harness({ publicSignup: true, maxPublicRegistrationsPerWindow: 50 });
    expectPending(await h.svc.register(h.ctx(), body("  MiXeD@Example.COM  ")));

    // asserted on the STORED ROW rather than on the response, because the open path no
    // longer returns a user. That is the stronger form of this test's own claim ("normalizes
    // before STORING") and it does not depend on what the response happens to echo.
    const rows = await h.db.select().from(users);
    expect(rows.map((r) => r.email)).toEqual(["mixed@example.com"]);

    // And the point of normalizing: a differently-cased spelling is the SAME account, so it
    // takes the already-registered branch and creates nothing.
    expectPending(await h.svc.register(h.ctx(), body("MIXED@EXAMPLE.COM")));
    expect(await h.db.select().from(users)).toHaveLength(1);
    expect(h.spy.sent.map((s) => s.template)).toEqual(["email_verification", "account_exists"]);
  });

  it("registration and the invite mint share ONE predicate — neither can admit what the other refuses", async () => {
    const h = await harness({ publicSignup: true });
    for (const bad of MALFORMED) {
      // The mint refuses it...
      const minted = await refusal(issueInvite(asTx(h.db), {
        email: bad, now: NOW, expiresAt: new Date(NOW.getTime() + 3_600_000),
      }));
      expect(minted.code).toBe("validation_failed");
      // ...and so does registration. If these two ever disagree, the gap is an address that
      // can hold an account but can never be sent an invite, or the reverse.
      const registered = await refusal(h.svc.register(h.ctx(), body(bad)));
      expect(registered.code).toBe("validation_failed");
    }
  });
});
