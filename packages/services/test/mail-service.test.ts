import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { authThrottle, loginTokens } from "@trafficflow/db/cloud";
import {
  AuthService, makeTestAuthDeps, MailService, SpyMailer, disabledMailer,
  EMAIL_VERIFY_PURPOSE, hashToken, formatUtc, safeUrl, throttleKeysFor,
  type MailContext, type MailerPort, type MailSendResult, type ServiceContext,
} from "../src/index.js";

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const START = new Date("2026-08-01T09:05:00.000Z");
const CONFIG = {
  appUrl: "https://app.ohmail.app",
  siteUrl: "https://ohmail.app",
  supportEmail: "support@ohmail.app",
};
/** The deployment's throttle keyer: a recipient is counted under its keyed hash. */
const KEYS = throttleKeysFor(makeTestAuthDeps().keyProvider);

class Clock {
  constructor(public t: Date = new Date(START)) {}
  now = (): Date => this.t;
  advance(ms: number): void { this.t = new Date(this.t.getTime() + ms); }
}

interface Harness {
  db: Db;
  clock: Clock;
  spy: SpyMailer;
  svc: MailService;
  ctx: MailContext;
}

async function harness(over: Partial<ConstructorParameters<typeof MailService>[0]["config"]> = {}): Promise<Harness> {
  const db = await makeTestDb();
  const clock = new Clock();
  const spy = new SpyMailer();
  const svc = new MailService({ mailer: spy, config: { ...CONFIG, ...over }, throttleKeys: KEYS });
  return { db, clock, spy, svc, ctx: { db, now: clock.now } };
}

/** A real user row, so the `login_tokens.user_id` FK is satisfied. */
async function seedUser(db: Db, email = "gil@example.com"): Promise<{ userId: string; email: string }> {
  const auth = new AuthService(makeTestAuthDeps());
  const ctx: ServiceContext = {
    db, accountId: "", userId: null, now: () => START, requestId: "r", ip: "1.2.3.4",
  };
  const { user } = await auth.register(ctx, {
    email, password: "mail-service-password", displayName: "Gil", inviteCode: "INVITE-OK",
  });
  return { userId: user.userId, email };
}

// ─────────────────────────────────────────────────────────────────────────────
// The "Testing bar" invariant — the suite performs no external request.
//
// Not a claim, a trap: `globalThis.fetch` is replaced for the whole file with a
// function that fails the test if anything calls it. `MailService` only ever holds a
// `MailerPort`, and `SpyMailer` contains no HTTP client at all, so the trap must
// stay untouched through every case below.
// ─────────────────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let fetchCalls: unknown[][] = [];

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = ((...args: unknown[]) => {
    fetchCalls.push(args);
    throw new Error(`no-network rule violated: the mail path called globalThis.fetch(${String(args[0])})`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  expect(fetchCalls, "an external request escaped the mail suite").toEqual([]);
});

describe("MailService — the four beta sends", () => {
  it("waitlist confirmation reaches the spy with the landing URL and the chosen tier", async () => {
    const h = await harness();
    const res = await h.svc.sendWaitlistConfirmation(h.ctx, { to: "  New.Signer@Example.COM ", tier: "solo" });

    expect(res).toEqual({ status: "sent", providerId: "spy-1" });
    const send = h.spy.only("waitlist_confirmation");
    expect(send.to).toBe("new.signer@example.com");     // normalised before the wire
    expect(send.data.siteUrl).toBe("https://ohmail.app");
    expect(send.data.tier).toBe("solo");
    expect(send.rendered.subject).toBe("You're on the ohmail waitlist");
    expect(send.rendered.headers?.["List-Unsubscribe"]).toContain("support@ohmail.app");
  });

  it("the waitlist and sign-in mails carry event-derived idempotency keys too", async () => {
    // Only `invite` used to. A serverless invocation the platform re-drives, or a
    // double-submitted form, is ONE event and must be one mail — the sign-in notice
    // especially, because it is the one mail a user cannot re-trigger and a duplicated
    // security warning is how you train someone to ignore the real one.
    const h = await harness();
    await h.svc.sendWaitlistConfirmation(h.ctx, { to: "s@example.com", tier: "solo" });
    await h.svc.sendWaitlistConfirmation(h.ctx, { to: "s@example.com", tier: "pro" });
    await h.svc.sendNewDeviceSignIn(h.ctx, { to: "s@example.com", device: "Web", ip: "1.1.1.1", at: START });
    await h.svc.sendNewDeviceSignIn(h.ctx, { to: "s@example.com", device: "Web", ip: "9.9.9.9", at: START });

    const keys = h.spy.sent.map((s) => s.idempotencyKey!);
    expect(keys.every((k) => typeof k === "string" && k.length > 10)).toBe(true);
    expect(keys[0]).toBe(`waitlist:${hashToken("s@example.com|solo")}`);
    expect(keys[0]).not.toBe(keys[1]);                    // a different tier is a different signup
    expect(keys[2]).toBe(`signin:${hashToken(`s@example.com|Web|${START.toISOString()}`)}`);
    expect(keys[2], "same sign-in event ⇒ same key").toBe(keys[3]);
  });

  it("email verification carries NO idempotency key — each mint is a new credential", async () => {
    // Deduping this one would strand the user holding a link for a token they never
    // received. The REQUEST has to be made idempotent one level up.
    const h = await harness();
    const { userId, email } = await seedUser(h.db);
    await h.svc.issueEmailVerification(h.ctx, { userId, to: email });
    expect(h.spy.only("email_verification").idempotencyKey).toBeUndefined();
  });

  it("invite carries the code, a redeem URL built from config, and a stable idempotency key", async () => {
    const h = await harness();
    const expiresAt = new Date("2026-08-08T09:05:00.000Z");
    await h.svc.sendInvite(h.ctx, { to: "invitee@example.com", code: "OH-7QR4", expiresAt });

    const send = h.spy.only("invite");
    expect(send.data.code).toBe("OH-7QR4");
    expect(send.data.redeemUrl).toBe("https://app.ohmail.app/join?code=OH-7QR4");
    expect(send.data.expiresAt).toBe("8 August 2026, 09:05 UTC");
    expect(send.idempotencyKey).toBe(`invite:${hashToken("OH-7QR4|invitee@example.com")}`);
    expect(send.rendered.text).toContain("OH-7QR4");
  });

  it("the invite idempotency key is a pure function of (code, recipient)", async () => {
    const a = await harness();
    const b = await harness();
    const at = new Date("2026-08-08T09:05:00.000Z");
    await a.svc.sendInvite(a.ctx, { to: "x@example.com", code: "c1", expiresAt: at });
    await b.svc.sendInvite(b.ctx, { to: "x@example.com", code: "c1", expiresAt: at });
    await b.svc.sendInvite(b.ctx, { to: "y@example.com", code: "c1", expiresAt: at });
    expect(a.spy.sent[0]!.idempotencyKey).toBe(b.spy.sent[0]!.idempotencyKey);
    expect(b.spy.sent[1]!.idempotencyKey).not.toBe(b.spy.sent[0]!.idempotencyKey);
  });

  it("the sign-in notice renders the device, the IP and a UTC timestamp", async () => {
    const h = await harness();
    await h.svc.sendNewDeviceSignIn(h.ctx, {
      to: "gil@example.com", device: "Web", ip: "203.0.113.24", at: START,
    });
    const send = h.spy.only("new_device_signin");
    expect(send.data).toMatchObject({
      device: "Web", ip: "203.0.113.24", at: "1 August 2026, 09:05 UTC",
      devicesUrl: "https://app.ohmail.app/settings/devices",
    });
    // It must never carry an action link that changes state — that is a phishing template.
    expect(send.rendered.html).not.toMatch(/revoke\?|logout\?|token=/i);
  });

  it("the sign-in notice degrades gracefully on a missing device label or IP", async () => {
    const h = await harness();
    await h.svc.sendNewDeviceSignIn(h.ctx, { to: "gil@example.com", device: "   ", ip: null, at: START });
    expect(h.spy.only("new_device_signin").data).toMatchObject({ device: "Unknown device", ip: "unknown" });
  });

  it("formatUtc is stable regardless of the host timezone", () => {
    expect(formatUtc(new Date("2026-01-09T23:04:00.000Z"))).toBe("9 January 2026, 23:04 UTC");
    expect(formatUtc(new Date("2026-12-31T00:00:00.000Z"))).toBe("31 December 2026, 00:00 UTC");
  });

  it("the billing link points at the app's own /account/manage door, in the account's language", async () => {
    // The door mints the billing page's link after sign-in; the mail itself carries no credential.
    const h = await harness();
    const res = await h.svc.sendBillingLink(h.ctx, { to: " Owner@Example.COM ", locale: "de", anchor: START });
    expect(res.status).toBe("sent");
    const send = h.spy.only("billing_link");
    expect(send.to).toBe("owner@example.com");
    expect(send.data).toEqual({
      locale: "de", billingUrl: "https://app.ohmail.app/account/manage", supportEmail: "support@ohmail.app",
    });
    expect(send.idempotencyKey).toBe(`billing:${hashToken(`owner@example.com|${START.toISOString()}`)}`);
    // The transactional budget: the per-recipient limiter is the same one the notices spend.
    const [slot] = await h.db.select().from(authThrottle)
      .where(eq(authThrottle.key, `mail:transactional:${KEYS.address("owner@example.com")}`));
    expect(slot?.failures).toBe(1);
  });
});

describe("MailService — the lifecycle notices' links", () => {
  it("a notice for an account with no mailbox links to sign-in, which resumes the signup wizard; every notice's account link opens the app", async () => {
    const h = await harness();
    const base = { locale: "en" as const, anchor: START, erasureAt: null };
    await h.svc.sendLifecycleNotice(h.ctx, { ...base, to: "bare@example.com", kind: "trial_two_days", noMailbox: true });
    await h.svc.sendLifecycleNotice(h.ctx, { ...base, to: "kept@example.com", kind: "trial_two_days" });
    const [bare, kept] = h.spy.sent;
    // `/login?next=join`, which the web app resolves (`join-step-up-in-place.test.tsx`).
    expect(bare!.data).toMatchObject({
      noMailbox: true,
      setupUrl: "https://app.ohmail.app/login?next=join",
      accountUrl: "https://app.ohmail.app/#/settings/account",
    });
    expect(bare!.rendered.text).toContain("https://app.ohmail.app/login?next=join");
    expect(bare!.rendered.html).toContain('href="https://app.ohmail.app/login?next=join"');
    expect(kept!.data).toMatchObject({ noMailbox: false });
    expect(kept!.rendered.text).toContain("https://app.ohmail.app/#/settings/account");
  });
});

describe("MailService — the connect reminder", () => {
  it("advises by the recipient's own login domain, links to the mailbox step through sign-in, and carries no address", async () => {
    const h = await harness();
    // Joined at run time: the domain is what the advice reads.
    const [gmail, hotmail, other] = [["ann", "gmail.com"], ["Bob", "Hotmail.de"], ["cy", "example.com"]].map((p) => p.join("@"));
    for (const to of [gmail!, hotmail!, other!]) {
      expect((await h.svc.sendConnectReminder(h.ctx, { to, locale: "de", anchor: START })).status).toBe("sent");
    }
    const sends = h.spy.ofTemplate("connect_reminder");
    const common = { locale: "de", setupUrl: "https://app.ohmail.app/login?next=join", supportEmail: "support@ohmail.app" };
    expect(sends.map((s) => s.data)).toEqual([
      { ...common, provider: "gmail" }, { ...common, provider: "microsoft" }, { ...common, provider: "other" },
    ]);
    expect(sends[0]!.rendered.replyTo).toBe("support@ohmail.app");
    // Keyed on the recipient and the trial's start: a re-driven send is one mail.
    expect(sends[1]!.idempotencyKey).toBe(`connect:${hashToken(`${hotmail!.toLowerCase()}|${START.toISOString()}`)}`);
    const [slot] = await h.db.select().from(authThrottle)
      .where(eq(authThrottle.key, `mail:transactional:${KEYS.address(gmail!)}`));
    expect(slot?.failures).toBe(1);
  });
});

describe("MailService — recipient hygiene", () => {
  it("refuses an address that cannot be a recipient, without touching the mailer", async () => {
    const h = await harness();
    for (const bad of [
      "", "   ", "nodomain", "@example.com", "user@", "a b@example.com",
      "user@example", "user@-bad.com", "victim@example.com\r\nbcc: everyone@example.com",
      "<script>@example.com",
    ]) {
      const res = await h.svc.sendWaitlistConfirmation(h.ctx, { to: bad, tier: "undecided" });
      expect(res, JSON.stringify(bad)).toEqual({ status: "skipped", reason: "invalid_recipient" });
    }
    expect(h.spy.sent).toHaveLength(0);
    // …and no throttle row was burned on garbage input.
    expect(await h.db.select().from(authThrottle)).toHaveLength(0);
  });

  it("a CRLF header-injection attempt never reaches the transport", async () => {
    const h = await harness();
    const res = await h.svc.sendInvite(h.ctx, {
      to: "ok@example.com\nBcc: victim@example.com", code: "C", expiresAt: START,
    });
    expect(res).toEqual({ status: "skipped", reason: "invalid_recipient" });
  });
});

describe("MailService — per-recipient rate limit", () => {
  it("allows the window's budget and then refuses, without calling the mailer again", async () => {
    const h = await harness({ ratePerWindow: 3, rateWindowMs: 60_000 });
    const to = "loop@example.com";
    for (let i = 0; i < 3; i++) {
      expect((await h.svc.sendWaitlistConfirmation(h.ctx, { to, tier: "solo" })).status).toBe("sent");
    }
    for (let i = 0; i < 20; i++) {
      expect(await h.svc.sendWaitlistConfirmation(h.ctx, { to, tier: "solo" }))
        .toEqual({ status: "skipped", reason: "rate_limited" });
    }
    expect(h.spy.sent).toHaveLength(3);
  });

  it("counts every TRANSACTIONAL template against one bucket — no alternating past it", async () => {
    // Within a quota the budget is still shared, so a loop cannot rotate templates to get
    // more mail into one inbox.
    const h = await harness({ ratePerWindow: 2 });
    const to = "one-person@example.com";
    expect((await h.svc.sendInvite(h.ctx, { to, code: "C", expiresAt: START })).status).toBe("sent");
    expect((await h.svc.sendNewDeviceSignIn(h.ctx, { to, device: "Web", ip: "1.1.1.1", at: START })).status)
      .toBe("sent");
    expect((await h.svc.sendInvite(h.ctx, { to, code: "D", expiresAt: START })).status).toBe("skipped");
    expect(h.spy.sent.map((s) => s.template)).toEqual(["invite", "new_device_signin"]);
  });

  /**
   * THE QUOTA SPLIT — and it is a security boundary, not tidiness.
   *
   * One budget used to serve every template, and `POST /waitlist` is public and takes any
   * address a stranger types. So five anonymous submissions naming a victim exhausted that
   * victim's whole hourly budget, and the operator's next `invite mint --email victim` came
   * back `{"status":"skipped","reason":"rate_limited"}` — an invite burned into the table and
   * never delivered, arranged by someone who only had to know the address. A security notice
   * for that person would have been dropped the same way.
   */
  it("the WAITLIST budget cannot starve an invite or a security notice", async () => {
    const h = await harness({ ratePerWindow: 2 });
    const to = "target@example.com";

    // Exhaust the unsolicited budget entirely.
    expect((await h.svc.sendWaitlistConfirmation(h.ctx, { to, tier: "pro" })).status).toBe("sent");
    expect((await h.svc.sendWaitlistConfirmation(h.ctx, { to, tier: "pro" })).status).toBe("sent");
    expect((await h.svc.sendWaitlistConfirmation(h.ctx, { to, tier: "pro" })).status).toBe("skipped");

    // The transactional budget is untouched — this is the whole point.
    expect((await h.svc.sendInvite(h.ctx, { to, code: "C", expiresAt: START })).status).toBe("sent");
    expect((await h.svc.sendNewDeviceSignIn(h.ctx, { to, device: "Web", ip: "1.1.1.1", at: START })).status)
      .toBe("sent");
    // …and it is a BUDGET, not an exemption: the third transactional send still refuses.
    expect((await h.svc.sendInvite(h.ctx, { to, code: "D", expiresAt: START })).status).toBe("skipped");
  });

  it("the two budgets are separate ROWS, so neither can be read off the other", async () => {
    const h = await harness();
    const to = "split@example.com";
    await h.svc.sendWaitlistConfirmation(h.ctx, { to, tier: "solo" });
    await h.svc.sendInvite(h.ctx, { to, code: "C", expiresAt: START });
    const keys = (await h.db.select().from(authThrottle)).map((r) => r.key).sort();
    expect(keys).toEqual([
      `mail:transactional:${KEYS.address(to)}`,
      `mail:unsolicited:${KEYS.address(to)}`,
    ].sort());
    expect(keys.join(" "), "a plain digest of an address is reversible by a guess").not.toContain(hashToken(to));
  });

  it("is per recipient — one hammered address does not silence anybody else", async () => {
    const h = await harness({ ratePerWindow: 1 });
    await h.svc.sendWaitlistConfirmation(h.ctx, { to: "a@example.com", tier: "solo" });
    expect((await h.svc.sendWaitlistConfirmation(h.ctx, { to: "a@example.com", tier: "solo" })).status)
      .toBe("skipped");
    expect((await h.svc.sendWaitlistConfirmation(h.ctx, { to: "b@example.com", tier: "solo" })).status)
      .toBe("sent");
  });

  it("normalises before counting — Gil@ and gil@ are one person", async () => {
    const h = await harness({ ratePerWindow: 1 });
    expect((await h.svc.sendWaitlistConfirmation(h.ctx, { to: "Gil@Example.com", tier: "solo" })).status)
      .toBe("sent");
    expect((await h.svc.sendWaitlistConfirmation(h.ctx, { to: " gil@example.com ", tier: "solo" })).status)
      .toBe("skipped");
  });

  it("reopens one window after the FIRST send — hammering cannot extend the cooldown", async () => {
    const h = await harness({ ratePerWindow: 1, rateWindowMs: 60_000 });
    const to = "loop@example.com";
    expect((await h.svc.sendWaitlistConfirmation(h.ctx, { to, tier: "solo" })).status).toBe("sent");
    // 50 refusals spread across the window must not push the reopening later.
    for (let i = 0; i < 50; i++) {
      h.clock.advance(1_000);
      await h.svc.sendWaitlistConfirmation(h.ctx, { to, tier: "solo" });
    }
    expect(h.spy.sent).toHaveLength(1);
    h.clock.advance(11_000);   // now 61s past the first send
    expect((await h.svc.sendWaitlistConfirmation(h.ctx, { to, tier: "solo" })).status).toBe("sent");
    expect(h.spy.sent).toHaveLength(2);
  });

  it("stores the recipient under the deployment's KEYED hash — a waitlist address never lands in the throttle table", async () => {
    const h = await harness();
    await h.svc.sendWaitlistConfirmation(h.ctx, { to: "private.person@example.com", tier: "solo" });
    const rows = await h.db.select().from(authThrottle);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe(`mail:unsolicited:${KEYS.address("private.person@example.com")}`);
    expect(rows[0]!.key).not.toContain("private.person");
    expect(rows[0]!.key).not.toContain(hashToken("private.person@example.com"));
  });

  it("the limit bites: removing it would let a retry loop through", async () => {
    // The control. Same loop, no limiter — proving the assertion above is not vacuous.
    const spy = new SpyMailer();
    const unlimited: MailerPort = spy;
    for (let i = 0; i < 20; i++) {
      await unlimited.send("loop@example.com", "waitlist_confirmation", {
        tier: "solo", siteUrl: CONFIG.siteUrl, supportEmail: CONFIG.supportEmail,
      });
    }
    expect(spy.sent).toHaveLength(20);
  });
});

describe("MailService — the config it refuses to boot with", () => {
  const build = (over: Record<string, unknown>): MailService =>
    new MailService({ mailer: new SpyMailer(), config: { ...CONFIG, ...over } as never, throttleKeys: KEYS });

  it("rejects a link base that is not first-party, at CONSTRUCTION", () => {
    // The hole this closes: `safeUrl` accepts every https host, and the "first-party
    // only" template test only ever fed it hard-coded fixtures — so a deployment with
    // MAIL_APP_URL=https://evil.example rendered a perfectly plausible ohmail invite
    // pointing at somebody else's site, with a green suite. Catching it at boot means an
    // operator sees a crash, not a stream of dropped mail.
    expect(() => build({ appUrl: "https://evil.example" })).toThrow(/not in allowedOrigins/);
    expect(() => build({ siteUrl: "https://ohmail.app.attacker.test" })).toThrow(/not in allowedOrigins/);
    expect(() => build({ appUrl: "https://app.ohmail.app:8443" })).toThrow(/not in allowedOrigins/);
  });

  it("rejects credentials, a query, a fragment, and plain http off loopback", () => {
    const USER = "user", PASS = "pw";
    expect(() => build({ appUrl: `https://${USER}:${PASS}@app.ohmail.app` })).toThrow(/must not carry credentials/);
    expect(() => build({ appUrl: "https://app.ohmail.app?next=x" })).toThrow(/query string or fragment/);
    expect(() => build({ appUrl: "https://app.ohmail.app#f" })).toThrow(/query string or fragment/);
    expect(() => build({ appUrl: "http://app.ohmail.app" })).toThrow(/must be https/);
    expect(() => build({ appUrl: "javascript:alert(1)" })).toThrow(/must be https/);
    expect(() => build({ appUrl: "/relative" })).toThrow(/not an absolute URL/);
  });

  it("accepts the real origins and any loopback port, and honours an explicit allow-list", () => {
    expect(() => build({})).not.toThrow();
    expect(() => build({ appUrl: "http://localhost:3000", siteUrl: "http://127.0.0.1:5173" })).not.toThrow();
    // A preview deployment has to NAME its origin — deliberately.
    expect(() => build({
      appUrl: "https://ohmail-preview.vercel" + ".app",
      allowedOrigins: ["https://ohmail-preview.vercel" + ".app", "https://ohmail.app"],
    })).not.toThrow();
  });

  it("the boot check bites: without it these URLs render into real mail", async () => {
    // The control. `safeUrl` — the only validation there used to be — is perfectly happy
    // with every origin the constructor above rejects.
    for (const url of ["https://evil.example/join", "https://app.ohmail.app:8443/join"]) {
      expect(safeUrl(url)).toBe(url);
    }
  });
});

describe("MailService — failure mode is DROP, and it never throws into a request", () => {
  it("returns the provider failure instead of raising it", async () => {
    const h = await harness();
    h.spy.failNext("resend_503: upstream", true);
    const res = await h.svc.sendWaitlistConfirmation(h.ctx, { to: "gil@example.com", tier: "solo" });
    expect(res).toEqual({ status: "failed", retryable: true, error: "resend_503: upstream" });
  });

  it("does not retry a failed send — no second attempt appears anywhere", async () => {
    const h = await harness();
    h.spy.failNext();
    await h.svc.sendInvite(h.ctx, { to: "gil@example.com", code: "C", expiresAt: START });
    expect(h.spy.sent).toHaveLength(1);            // attempted once, dropped
    const rows = await h.db.select().from(authThrottle);
    expect(rows[0]!.failures).toBe(1);             // and it consumed exactly one slot
  });

  it("a mailer that throws is contained, not propagated", async () => {
    const db = await makeTestDb();
    const exploding: MailerPort = {
      async send(): Promise<MailSendResult> { throw new Error("boom"); },
    };
    const svc = new MailService({ mailer: exploding, config: CONFIG, throttleKeys: KEYS });
    const res = await svc.sendWaitlistConfirmation({ db, now: () => START }, {
      to: "gil@example.com", tier: "solo",
    });
    expect(res).toMatchObject({ status: "failed", retryable: false });
    expect((res as { error: string }).error).toContain("boom");
  });

  it("a THROTTLE-TABLE failure is contained too, and fails closed", async () => {
    // The limiter reservation used to sit OUTSIDE the try, so a dead pool or a lock
    // timeout on `auth_throttle` escaped straight into the request handler — worst case
    // a successful login whose best-effort security notice turns the 200 into a 500.
    // A mailer that throws was already covered; the database that throws was not.
    const spy = new SpyMailer();
    const brokenDb = {
      insert() { throw new Error("pool exhausted: could not claim a slot"); },
      select() { throw new Error("pool exhausted"); },
    } as unknown as Db;
    const svc = new MailService({ mailer: spy, config: CONFIG, throttleKeys: KEYS });

    const res = await svc.sendNewDeviceSignIn({ db: brokenDb, now: () => START }, {
      to: "gil@example.com", device: "Web", ip: "1.1.1.1", at: START,
    });
    expect(res).toMatchObject({ status: "failed", retryable: false });
    expect((res as { error: string }).error).toContain("pool exhausted");
    // FAIL CLOSED: no slot, no send.
    expect(spy.sent).toHaveLength(0);
  });

  it("the contained error is scrubbed — a driver can quote our parameters back at us", async () => {
    const spy = new SpyMailer();
    const secret = "mail-service-driver-quoted-fixture-token";
    const leaky = {
      insert() {
        throw new Error(
          `bind failed for gil@example.com at https://app.ohmail.app/verify-email?token=${secret}`,
        );
      },
    } as unknown as Db;
    const res = await new MailService({ mailer: spy, config: CONFIG, throttleKeys: KEYS })
      .sendWaitlistConfirmation({ db: leaky, now: () => START }, { to: "gil@example.com", tier: "solo" });
    const error = (res as { error: string }).error;
    expect(error).not.toContain(secret);
    expect(error).not.toContain("gil@example.com");
    expect(error).toContain("bind failed");
  });

  it("a deployment with no mailer configured skips silently", async () => {
    const db = await makeTestDb();
    const svc = new MailService({ mailer: disabledMailer, config: CONFIG, throttleKeys: KEYS });
    expect(await svc.sendWaitlistConfirmation({ db, now: () => START }, { to: "gil@example.com", tier: "solo" }))
      .toEqual({ status: "skipped", reason: "mailer_disabled" });
  });
});

describe("MailService — email verification (built, not wired)", () => {
  it("mints a hashed, single-use login_tokens row with purpose email_verify", async () => {
    const h = await harness();
    const { userId, email } = await seedUser(h.db);

    const res = await h.svc.issueEmailVerification(h.ctx, { userId, to: email });
    expect(res.status).toBe("sent");

    const send = h.spy.only("email_verification");
    const url = new URL(send.data.verifyUrl);
    expect(url.origin + url.pathname).toBe("https://app.ohmail.app/verify-email");
    const raw = url.searchParams.get("token")!;
    expect(raw.length).toBeGreaterThan(20);
    expect(send.data.expiresIn).toBe("24 hours");

    const rows = await h.db.select().from(loginTokens).where(eq(loginTokens.purpose, EMAIL_VERIFY_PURPOSE));
    expect(rows).toHaveLength(1);
    // The RAW token is nowhere in the database — only its sha256.
    expect(rows[0]!.tokenHash).toBe(hashToken(raw));
    expect(rows[0]!.tokenHash).not.toBe(raw);
    expect(rows[0]!.expiresAt.getTime()).toBe(START.getTime() + 24 * 60 * 60_000);
  });

  it("consumes exactly once, and refuses a replay", async () => {
    const h = await harness();
    const { userId, email } = await seedUser(h.db);
    await h.svc.issueEmailVerification(h.ctx, { userId, to: email });
    const raw = new URL(h.spy.only("email_verification").data.verifyUrl).searchParams.get("token")!;

    expect(await h.svc.consumeEmailVerification(h.ctx, raw)).toEqual({ userId });
    expect(await h.svc.consumeEmailVerification(h.ctx, raw)).toBeNull();
  });

  it("refuses an expired link, an unknown token, and an empty one", async () => {
    const h = await harness();
    const { userId, email } = await seedUser(h.db);
    await h.svc.issueEmailVerification(h.ctx, { userId, to: email });
    const raw = new URL(h.spy.only("email_verification").data.verifyUrl).searchParams.get("token")!;

    expect(await h.svc.consumeEmailVerification(h.ctx, "not-a-token")).toBeNull();
    expect(await h.svc.consumeEmailVerification(h.ctx, "")).toBeNull();
    h.clock.advance(24 * 60 * 60_000 + 1);
    expect(await h.svc.consumeEmailVerification(h.ctx, raw)).toBeNull();
  });

  it("never emails a recovery code — the verification mail carries a link and nothing else", async () => {
    const h = await harness();
    const { userId, email } = await seedUser(h.db);
    await h.svc.issueEmailVerification(h.ctx, { userId, to: email });
    const { rendered } = h.spy.only("email_verification");
    expect(rendered.text).not.toMatch(/recovery/i);
    expect(rendered.html).not.toMatch(/recovery/i);
  });

  it("refuses to mail one user's verification link to a different address", async () => {
    // The token is bound to `userId`; `to` arrives independently. Without this check a
    // caller could mail a target user's LIVE token to an attacker-chosen inbox, and the
    // attacker could then present it and have the target's address marked verified.
    const h = await harness();
    const { userId } = await seedUser(h.db, "victim@example.com");

    const res = await h.svc.issueEmailVerification(h.ctx, { userId, to: "attacker@example.com" });
    expect(res).toEqual({ status: "skipped", reason: "recipient_mismatch" });
    expect(h.spy.sent).toHaveLength(0);
    // …and NO token was minted, so there is nothing live left behind either.
    expect(await h.db.select().from(loginTokens).where(eq(loginTokens.purpose, EMAIL_VERIFY_PURPOSE)))
      .toHaveLength(0);
  });

  it("refuses an unknown userId, and accepts the user's own address in any casing", async () => {
    const h = await harness();
    const { userId } = await seedUser(h.db, "gil@example.com");
    expect(await h.svc.issueEmailVerification(h.ctx, {
      userId: "00000000-0000-4000-8000-000000000000", to: "gil@example.com",
    })).toEqual({ status: "skipped", reason: "recipient_mismatch" });
    expect((await h.svc.issueEmailVerification(h.ctx, { userId, to: "  GIL@Example.COM " })).status)
      .toBe("sent");
  });

  it("consumption is ONE statement — a stale read cannot be replayed past it", async () => {
    // The single-use guarantee used to be SELECT → check → unconditional UPDATE, which
    // two concurrent requests both pass. PGlite is single-connection so it cannot show
    // the race; what this asserts is the shape that removes it — an already-consumed row
    // is not re-consumable even when the consuming statement is handed a row the caller
    // observed as live. `mail-verify-concurrency.pg.test.ts` runs the real race.
    const h = await harness();
    const { userId, email } = await seedUser(h.db);
    await h.svc.issueEmailVerification(h.ctx, { userId, to: email });
    const raw = new URL(h.spy.only("email_verification").data.verifyUrl).searchParams.get("token")!;

    const first = await h.svc.consumeEmailVerification(h.ctx, raw);
    expect(first).toEqual({ userId });
    const rows = await h.db.select().from(loginTokens).where(eq(loginTokens.purpose, EMAIL_VERIFY_PURPOSE));
    expect(rows[0]!.consumedAt).not.toBeNull();
    // Ten more presentations of the same link, none of which may succeed.
    for (let i = 0; i < 10; i++) {
      expect(await h.svc.consumeEmailVerification(h.ctx, raw)).toBeNull();
    }
    // …and consuming did not move `consumed_at` again.
    const after = await h.db.select().from(loginTokens).where(eq(loginTokens.purpose, EMAIL_VERIFY_PURPOSE));
    expect(after[0]!.consumedAt!.getTime()).toBe(rows[0]!.consumedAt!.getTime());
  });

  it("does not mint a token when the recipient is rate-limited", async () => {
    const h = await harness({ ratePerWindow: 1 });
    const { userId, email } = await seedUser(h.db);
    // the budget exhausted here is `unsolicited`, because that is the one verification
    // now spends (see below). The assertion itself is unchanged and is the one that matters: a
    // refused send must mint NOTHING, or a rate-limited caller accumulates live 24-hour
    // credentials in `login_tokens` for links nobody ever received.
    await h.svc.sendWaitlistConfirmation(h.ctx, { to: email, tier: "plus" });

    expect((await h.svc.issueEmailVerification(h.ctx, { userId, to: email })).status).toBe("skipped");
    expect(await h.db.select().from(loginTokens).where(eq(loginTokens.purpose, EMAIL_VERIFY_PURPOSE)))
      .toHaveLength(0);
  });

  it("verification spends `unsolicited`, so a prober cannot starve the invite", async () => {
    // THE REASON THE QUOTA MOVED. `issueEmailVerification` was `transactional` while it was
    // unwired. Wiring it to `POST /auth/register` — which any stranger can aim at any address —
    // made that a suppression vector: five anonymous signups naming a victim would have drained
    // the victim's transactional budget, and the operator's next `pnpm invite mint --email
    // victim` would have come back `skipped: rate_limited` with the invite burned in the table
    // and never delivered. That is `MailQuota`'s finding (1), re-entering through a new door.
    //
    // Budget of one, spent entirely by the anonymous path, and the invite still goes out.
    const h = await harness({ ratePerWindow: 1 });
    const { userId, email } = await seedUser(h.db);

    expect((await h.svc.issueEmailVerification(h.ctx, { userId, to: email })).status).toBe("sent");
    // The anonymous budget is now spent — a second verification for the same address is refused.
    expect((await h.svc.issueEmailVerification(h.ctx, { userId, to: email })).status).toBe("skipped");

    // …and the TRANSACTIONAL budget is untouched, so the mail the product owes this person still
    // sends. Reverting the quota to `transactional` makes this line fail.
    expect((await h.svc.sendInvite(h.ctx, {
      to: email, code: "OHMAIL-7QR4-2K9F-" + "1234", expiresAt: new Date(START.getTime() + 86_400_000),
    })).status).toBe("sent");
    expect((await h.svc.sendNewDeviceSignIn(h.ctx, {
      to: email, device: "Web", ip: "1.1.1.1", at: START,
    })).status).toBe("skipped");
  });

  it("`account_exists` shares verification's budget exactly, so neither branch is visible", async () => {
    // The register path answers a constant 202 for a fresh address and a taken one, and each
    // branch sends a different template. If the two spent DIFFERENT budgets, a prober who
    // exhausted one and not the other would recover the oracle from the limiter's behaviour —
    // a constant response with a branch-dependent side effect is not a constant response.
    //
    // Budget of one, spent by the fresh-address mail; the taken-address mail is then refused for
    // the same address, which is what "one shared budget" means observably.
    const h = await harness({ ratePerWindow: 1 });
    const { userId, email } = await seedUser(h.db);

    expect((await h.svc.issueEmailVerification(h.ctx, { userId, to: email })).status).toBe("sent");
    expect((await h.svc.sendAccountExists(h.ctx, { to: email })).status).toBe("skipped");

    // And in the other order, to prove the sharing is symmetric rather than an artefact of which
    // one ran first.
    const h2 = await harness({ ratePerWindow: 1 });
    const second = await seedUser(h2.db);
    expect((await h2.svc.sendAccountExists(h2.ctx, { to: second.email })).status).toBe("sent");
    expect((await h2.svc.issueEmailVerification(h2.ctx, {
      userId: second.userId, to: second.email,
    })).status).toBe("skipped");
    // The refused branch minted nothing, as ever.
    expect(await h2.db.select().from(loginTokens).where(eq(loginTokens.purpose, EMAIL_VERIFY_PURPOSE)))
      .toHaveLength(0);
  });

  it("`account_exists` carries no credential at all", async () => {
    // Nothing was created and nothing was proven when this mail is sent, so there is nothing to
    // mint — and a mail that lands in a stranger's inbox because somebody typed their address
    // into our form must not carry a secret. Pinned because the tempting "helpful" edit is to
    // put a password-reset or a magic sign-in link in here.
    const h = await harness();
    const { email } = await seedUser(h.db);
    expect((await h.svc.sendAccountExists(h.ctx, { to: email })).status).toBe("sent");

    const sent = h.spy.only("account_exists");
    // `signInUrl` is derived from the harness's `appUrl` by `MailService`, never passed by a
    // caller — the same rule every link in this class follows, and the reason a deployment
    // cannot be talked into mailing a sign-in link that points somewhere else.
    expect(sent.data).toEqual({
      signInUrl: "https://app.ohmail.app/login", supportEmail: "support@ohmail.app",
    });
    // No token row of ANY purpose was created.
    expect(await h.db.select().from(loginTokens)).toHaveLength(0);
    // And no rendered part carries a query string, which is where a credential would hide.
    expect(JSON.stringify(sent.data)).not.toContain("?");
  });
});

describe("mail ↔ login — a mailed verification token is not a login token", () => {
  it("cannot be presented as a first factor to any 2FA endpoint", async () => {
    const h = await harness();
    const { userId, email } = await seedUser(h.db);
    await h.svc.issueEmailVerification(h.ctx, { userId, to: email });
    const raw = new URL(h.spy.only("email_verification").data.verifyUrl).searchParams.get("token")!;

    const auth = new AuthService(makeTestAuthDeps());
    const ctx: ServiceContext = {
      db: h.db, accountId: "", userId: null, now: h.clock.now, requestId: "r", ip: "1.2.3.4",
      origin: "http://localhost:3000",
    };
    // Every endpoint that takes a `loginToken` must reject it. Without the
    // `purpose='login'` predicate in `peekLoginToken`, the first of these mints a
    // WebAuthn challenge bound to the user — from a value that was emailed.
    await expect(auth.webauthnAssertOptions(ctx, { loginToken: raw })).rejects.toThrow(/login session expired/);
    await expect(auth.totpVerify(ctx, { loginToken: raw, code: "000000" })).rejects.toThrow(/login session expired/);
    await expect(auth.recoveryVerify(ctx, { loginToken: raw, code: "whatever" })).rejects.toThrow(/login session expired/);

    // The row is untouched: the rejection is a scoping decision, not a consumption.
    const rows = await h.db.select().from(loginTokens).where(eq(loginTokens.purpose, EMAIL_VERIFY_PURPOSE));
    expect(rows[0]!.consumedAt).toBeNull();
  });

  it("and a purpose='login' token of the same shape still gets through — the login path is intact", async () => {
    // The control for the case above: identical row, identical lookup, only `purpose`
    // differs. If `peekLoginToken` were simply broken, this would fail too.
    const h = await harness();
    const { userId } = await seedUser(h.db);
    const raw = "a-raw-login-token-value";
    await h.db.insert(loginTokens).values({
      userId, tokenHash: hashToken(raw), methods: ["webauthn"], purpose: "login",
      expiresAt: new Date(START.getTime() + 5 * 60_000),
    });

    const auth = new AuthService(makeTestAuthDeps());
    const ctx: ServiceContext = {
      db: h.db, accountId: "", userId: null, now: h.clock.now, requestId: "r", ip: "1.2.3.4",
      origin: "http://localhost:3000",
    };
    await expect(auth.webauthnAssertOptions(ctx, { loginToken: raw })).resolves.toHaveProperty("options");
  });
});
