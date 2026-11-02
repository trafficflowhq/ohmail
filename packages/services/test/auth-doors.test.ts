import { describe, it, expect } from "vitest";
import { eq, like } from "drizzle-orm";
import { generateSync } from "otplib";
import { makeTestDb } from "@trafficflow/db/testing";
import { sessions } from "@trafficflow/db";
import { authThrottle } from "@trafficflow/db/cloud";
import {
  AuthService, MailService, SpyMailer, makeTestAuthDeps, throttleKeysFor, ServiceError,
  type AuthDeps, type MailerPort, type ServiceContext, type SessionUser,
} from "../src/index.js";

/**
 * THE SIGN-IN DOORS A STRANGER CAN NO LONGER HOLD SHUT (audit rows login-lockout-dos, totp-slow-grind,
 * throttle-plaintext-email-keys). Before: five wrong passwords from anywhere locked the address AND
 * the user for everybody, factor codes were a flat 480 a day with nobody told, and every typed
 * address sat in `auth_throttle` in the clear. Now a stranger fills only their own (address,
 * client) bucket, clients that never signed in meet a ceiling that slows rather than locks, the
 * pre-session factor has a day cap with a notice, and no key carries an address.
 */
type Db = Awaited<ReturnType<typeof makeTestDb>>;
const START = new Date("2026-09-26T10:00:00.000Z");
const PASSWORD = "pw-correct-horse-password-password";

class Clock {
  constructor(public t: Date = new Date(START)) {}
  now = (): Date => this.t;
  advance(ms: number): void { this.t = new Date(this.t.getTime() + ms); }
}

async function harness(over: Parameters<typeof makeTestAuthDeps>[0] = {}, mailer?: MailerPort) {
  const db: Db = await makeTestDb();
  const clock = new Clock();
  const mail = mailer
    ? new MailService({
      mailer, config: { appUrl: "https://ohmail.app", siteUrl: "https://ohmail.app", supportEmail: "support@ohmail.app" },
      throttleKeys: throttleKeysFor(makeTestAuthDeps().keyProvider),
    })
    : undefined;
  const deps: AuthDeps = makeTestAuthDeps(over, mail);
  const svc = new AuthService(deps);
  const ctx = (ip: string, extra: Partial<ServiceContext> = {}): ServiceContext => ({
    db, accountId: "", userId: null, now: clock.now, requestId: "r", ip, ...extra,
  });
  return { db, clock, deps, svc, ctx };
}
type H = Awaited<ReturnType<typeof harness>>;

async function register(h: H, email: string): Promise<SessionUser> {
  const out = await h.svc.register(h.ctx("10.9.9.9"), { email, password: PASSWORD, displayName: "P", inviteCode: "INVITE-OK" });
  if (!("user" in out)) throw new Error("registration answered pending; the invite path mints a session");
  return out.user;
}
const attempt = (h: H, ip: string, email: string, password = "WRONG") =>
  h.svc.login(h.ctx(ip), { email, password }).then(() => "ok", (e: unknown) => (e as ServiceError).code ?? "threw");

describe("the password door: a stranger locks only themselves", () => {
  it("stranger A is locked, known B still signs in, unknown C is slowed at the ceiling, B still signs in", async () => {
    const h = await harness({ maxFailures: 5, maxAddressFailures: 20 });
    await register(h, "owner@x.example");
    // B completes a sign-in first (no factor enrolled: the enrollment session is the completed one).
    expect(await attempt(h, "10.0.0.2", "owner@x.example", PASSWORD)).toBe("ok");

    for (let i = 0; i < 5; i++) expect(await attempt(h, "10.0.0.1", "owner@x.example")).toBe("credential_refused");
    expect(await attempt(h, "10.0.0.1", "owner@x.example"), "A was not locked").toBe("account_locked");
    expect(await attempt(h, "10.0.0.2", "owner@x.example", PASSWORD), "a stranger's failures locked the account holder").toBe("ok");

    // A's five count toward the ceiling; fifteen more strangers bring it to twenty.
    for (let i = 0; i < 15; i++) expect(await attempt(h, `10.1.0.${i + 1}`, "owner@x.example")).toBe("credential_refused");
    expect(await attempt(h, "10.2.0.1", "owner@x.example"), "the 21st never-seen client was not slowed").toBe("sign_in_slowed");
    expect(await attempt(h, "10.0.0.2", "owner@x.example", PASSWORD), "the ceiling reached a known client").toBe("ok");
  }, 60_000);

  it("the ceiling answers 429 with a wait, never 423", async () => {
    const h = await harness({ maxAddressFailures: 20 });
    for (let i = 0; i < 20; i++) await attempt(h, `10.3.0.${i + 1}`, "ghost@x.example");
    const err = await h.svc.login(h.ctx("10.4.0.1"), { email: "ghost@x.example", password: "WRONG" }).catch((e: ServiceError) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(429);
    expect(((err as ServiceError).details as { retryAfter?: number }).retryAfter).toBeGreaterThan(0);
  }, 60_000);

  it("a registered and an unregistered address answer the same sequence and walk the same statements", async () => {
    const h = await harness({ maxFailures: 5 });
    await register(h, "real@x.example");
    const client = (h.db as unknown as { $client: { query: (...a: unknown[]) => unknown } }).$client;
    const original = client.query.bind(client);
    let statements = 0;
    client.query = (...a: unknown[]) => { statements++; return original(...a); };
    let derivations = 0;
    const verify = h.deps.passwordHasher.verify.bind(h.deps.passwordHasher);
    h.deps.passwordHasher.verify = async (p, s) => { derivations++; return verify(p, s); };
    const run = async (email: string) => {
      const codes: string[] = [];
      const counts: number[] = [];
      const derived: number[] = [];
      for (let i = 0; i < 25; i++) {
        statements = 0; derivations = 0;
        codes.push(await attempt(h, "10.5.0.1", email));
        counts.push(statements); derived.push(derivations);
      }
      return { codes, counts, derived };
    };
    const known = await run("real@x.example");
    const ghost = await run("ghost@x.example");
    client.query = original;
    expect(ghost.codes).toEqual(known.codes);
    expect(known.codes.slice(0, 6)).toEqual(["credential_refused", "credential_refused", "credential_refused", "credential_refused", "credential_refused", "account_locked"]);
    expect(ghost.derived, "hash work differs by branch").toEqual(known.derived);
    // The one named residual: a registered address's refusal writes its audit row (the erasure
    // fence read and the insert), after the verify. Everything before it is statement for statement.
    known.counts.forEach((n, i) => expect(n - ghost.counts[i]!, `attempt ${i + 1}`).toBe(known.codes[i] === "credential_refused" ? 2 : 0));
  }, 60_000);

  it("no throttle key names an address, and password failures never touch the factor key", async () => {
    const h = await harness();
    const user = await register(h, "someone@x.example");
    await attempt(h, "10.6.0.1", "someone@x.example");
    await attempt(h, "10.6.0.1", "nobody@x.example");
    await attempt(h, "10.6.0.2", "someone@x.example", PASSWORD);
    const keys = (await h.db.select({ key: authThrottle.key }).from(authThrottle)).map((r) => r.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => k.includes("@")), "a typed address in a key").toEqual([]);
    const factor = (await h.db.select().from(authThrottle).where(eq(authThrottle.key, `user:${user.userId}`)))[0];
    expect(factor?.failures ?? 0, "a password failure counted against the second factor").toBe(0);
    expect(keys.filter((k) => /^(pw|pwa|known):/.test(k)).every((k) => /^(pw|pwa|known):[0-9a-f]{32}(:[0-9a-f]{32})?$/.test(k)), keys.join(" ")).toBe(true);
  }, 60_000);

  it("known: is written by a completed sign-in only, never by a right password with a factor outstanding", async () => {
    const h = await harness();
    const user = await register(h, "twofa@x.example");
    // Enrol TOTP through a step-upped session, the suite's own shape.
    const [row] = await h.db.insert(sessions).values({
      accountId: user.accountId, userId: user.userId, familyId: crypto.randomUUID(), scope: "full",
      accessExpiresAt: new Date(h.clock.now().getTime() + 3_600_000), refreshExpiresAt: new Date(h.clock.now().getTime() + 7_200_000),
      lastTwofaAt: h.clock.now(), lastSeenAt: h.clock.now(),
    }).returning();
    const sctx = h.ctx("10.7.0.9", { userId: user.userId, accountId: user.accountId, sessionId: row!.id });
    const { secret } = await h.svc.totpEnroll(sctx);
    await h.svc.totpActivate(sctx, { code: generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) }) });
    const knownKeys = async () => (await h.db.select({ key: authThrottle.key }).from(authThrottle).where(like(authThrottle.key, "known:%"))).length;
    const before = await knownKeys();
    const step = await h.svc.login(h.ctx("10.7.0.1"), { email: "twofa@x.example", password: PASSWORD }) as { loginToken?: string };
    expect(step.loginToken).toBeTruthy();
    expect(await knownKeys(), "a password alone marked the client known").toBe(before);
    h.clock.advance(31_000);
    await h.svc.totpVerify(h.ctx("10.7.0.1"), { loginToken: step.loginToken!, code: generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) }) });
    expect(await knownKeys(), "the completed sign-in did not mark the client known").toBe(before + 1);
  }, 60_000);
});

describe("the second factor: a day cap, replays free, step-up untouched, the account told", () => {
  async function totpUser(h: H, email: string) {
    const user = await register(h, email);
    const [row] = await h.db.insert(sessions).values({
      accountId: user.accountId, userId: user.userId, familyId: crypto.randomUUID(), scope: "full",
      accessExpiresAt: new Date(h.clock.now().getTime() + 3_600_000), refreshExpiresAt: new Date(h.clock.now().getTime() + 7_200_000),
      lastTwofaAt: h.clock.now(), lastSeenAt: h.clock.now(),
    }).returning();
    const sctx = h.ctx("10.8.0.9", { userId: user.userId, accountId: user.accountId, sessionId: row!.id });
    const { secret } = await h.svc.totpEnroll(sctx);
    await h.svc.totpActivate(sctx, { code: generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) }) });
    return { user, secret, sctx };
  }
  const token = async (h: H, email: string) =>
    ((await h.svc.login(h.ctx("10.8.0.1"), { email, password: PASSWORD })) as { loginToken: string }).loginToken;

  it("pre-session refusals past the day cap lock the factor for the day, and a live session's step-up still admits", async () => {
    const h = await harness({ maxFailures: 5, maxFactorFailuresPerDay: 8 });
    const { user, secret, sctx } = await totpUser(h, "grind@x.example");
    const wrong = async () => h.svc.totpVerify(h.ctx("10.8.0.1"), { loginToken: await token(h, "grind@x.example"), code: "000000" })
      .then(() => "ok", (e: ServiceError) => e.code);
    for (let i = 0; i < 4; i++) expect(await wrong()).toBe("credential_refused");
    // Serve the 15-minute counter so only the day cap can refuse next.
    await h.db.update(authThrottle).set({ failures: 0, lockedUntil: null }).where(eq(authThrottle.key, `user:${user.userId}`));
    for (let i = 0; i < 4; i++) expect(await wrong()).toBe(i < 3 ? "credential_refused" : "account_locked");
    await h.db.update(authThrottle).set({ failures: 0, lockedUntil: null }).where(eq(authThrottle.key, `user:${user.userId}`));
    expect(await wrong(), "the day lock did not hold past the 15-minute one").toBe("account_locked");
    const day = (await h.db.select().from(authThrottle).where(eq(authThrottle.key, `factor-day:${user.userId}`)))[0]!;
    expect(day.lockedUntil!.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    // The live session's step-up never reads the day key.
    h.clock.advance(31_000);
    await expect(h.svc.stepUpTotp(sctx, { code: generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) }) }))
      .resolves.toEqual({ ok: true });
  }, 60_000);

  it("a replayed code is not counted toward the day cap", async () => {
    const h = await harness({ maxFactorFailuresPerDay: 20 });
    const { user, secret } = await totpUser(h, "replay@x.example");
    h.clock.advance(31_000);
    const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    await h.svc.totpVerify(h.ctx("10.8.0.1"), { loginToken: await token(h, "replay@x.example"), code });
    for (let i = 0; i < 3; i++) {
      await h.svc.totpVerify(h.ctx("10.8.0.1"), { loginToken: await token(h, "replay@x.example"), code }).catch(() => {});
    }
    const day = (await h.db.select().from(authThrottle).where(eq(authThrottle.key, `factor-day:${user.userId}`)))[0];
    expect(day?.failures ?? 0, "a replay spent a day slot").toBe(0);
  }, 60_000);

  it("from twenty-one failures to one notice: the refusal returns while the mailer hangs, and the drain sends once a day", async () => {
    let release: () => void = () => {};
    const hang = new Promise<void>((r) => { release = r; });
    const spy = new SpyMailer();
    let hanging = true;
    const mailer: MailerPort = { send: async (...a) => { if (hanging) await hang; return spy.send(...(a as Parameters<SpyMailer["send"]>)); } };
    const h = await harness({ maxAddressFailures: 20 }, mailer);
    await register(h, "watched@x.example");
    for (let i = 0; i < 20; i++) expect(await attempt(h, `10.9.1.${i + 1}`, "watched@x.example")).toBe("credential_refused");
    // The 21st is refused at once: the notice is an intent row, not a send on this path.
    expect(await attempt(h, "10.9.2.1", "watched@x.example")).toBe("sign_in_slowed");
    expect(await attempt(h, "10.9.2.2", "watched@x.example")).toBe("sign_in_slowed");
    hanging = false; release();
    expect(await h.svc.drainSecurityNotices(h.ctx(""))).toEqual({ sent: 1, dropped: 0, failed: 0 });
    expect(spy.sent.map((s) => [s.to, s.template, (s.data as { kind: string }).kind])).toEqual([["watched@x.example", "security_notice", "sign_in_slowed"]]);
    expect(await h.svc.drainSecurityNotices(h.ctx("")), "a drained notice was sent twice").toEqual({ sent: 0, dropped: 0, failed: 0 });
    // The ceiling trips again within the day: no second notice.
    await attempt(h, "10.9.2.3", "watched@x.example");
    expect(await h.svc.drainSecurityNotices(h.ctx(""))).toEqual({ sent: 0, dropped: 0, failed: 0 });
    // An unregistered address trips the same way and tells nobody.
    for (let i = 0; i < 21; i++) await attempt(h, `10.9.3.${i + 1}`, "nobody@x.example");
    expect(await h.svc.drainSecurityNotices(h.ctx(""))).toEqual({ sent: 0, dropped: 1, failed: 0 });
  }, 60_000);

  it("a pre-session factor lock owes the account one notice", async () => {
    const spy = new SpyMailer();
    const h = await harness({ maxFailures: 3 }, spy);
    await totpUser(h, "factor@x.example");
    for (let i = 0; i < 3; i++) {
      await h.svc.totpVerify(h.ctx("10.8.0.1"), { loginToken: await token(h, "factor@x.example"), code: "000000" }).catch(() => {});
    }
    expect(await h.svc.drainSecurityNotices(h.ctx(""))).toMatchObject({ sent: 1 });
    expect(spy.sent.filter((s) => s.template === "security_notice").map((s) => (s.data as { kind: string }).kind)).toEqual(["factor_refused"]);
    const text = spy.sent.find((s) => s.template === "security_notice")!;
    expect(JSON.stringify(text), "the notice tells a person to change a password there is no page for").not.toMatch(/change your password/i);
  }, 60_000);
});

describe("the keyer", () => {
  it("is hex, keyed by the KEK subkey, and a rotation re-keys", () => {
    const a = throttleKeysFor(makeTestAuthDeps().keyProvider);
    expect(a.address("x@y.z")).toMatch(/^[0-9a-f]{32}$/);
    expect(a.address("x@y.z")).not.toBe(a.client("x@y.z"));
    const other = makeTestAuthDeps();
    (other as { keyProvider: unknown }).keyProvider = { ...other.keyProvider, deriveSubkey: () => Buffer.alloc(32, 9) };
    expect(throttleKeysFor(other.keyProvider).address("x@y.z")).not.toBe(a.address("x@y.z"));
  }, 60_000);
});

describe("rehash on sign-in", () => {
  const legacy = async (password: string): Promise<string> => {
    const { randomBytes, scrypt } = await import("node:crypto");
    const { promisify } = await import("node:util");
    const salt = randomBytes(16);
    const d = (await promisify(scrypt)(password, salt, 64)) as Buffer;
    return `scrypt$64$${salt.toString("base64url")}$${d.toString("base64url")}`;
  };
  const credentialOf = async (h: H, userId: string) => {
    const { credentials } = await import("@trafficflow/db/cloud");
    return (await h.db.select().from(credentials).where(eq(credentials.userId, userId)))[0]!.passwordHash;
  };

  it("a sign-in on the original cost writes the current one, and the old password keeps working", async () => {
    const h = await harness();
    // The production hasher for this case: the test deps hash at a cheap cost on purpose.
    const { scryptHasher } = await import("../src/auth/crypto.js");
    (h.deps as { passwordHasher: unknown }).passwordHasher = scryptHasher;
    const user = await register(h, "legacy@x.example");
    const { credentials } = await import("@trafficflow/db/cloud");
    await h.db.update(credentials).set({ passwordHash: await legacy(PASSWORD) }).where(eq(credentials.userId, user.userId));
    expect(await attempt(h, "10.10.0.1", "legacy@x.example", PASSWORD)).toBe("ok");
    expect((await credentialOf(h, user.userId)).split("$")[4]).toBe("n17r8p1");
    expect(await attempt(h, "10.10.0.1", "legacy@x.example", PASSWORD)).toBe("ok");
  }, 60_000);

  it("the rehash is a compare-and-set: a hash that moved underneath is never overwritten", async () => {
    const h = await harness();
    const user = await register(h, "moved@x.example");
    const { credentials } = await import("@trafficflow/db/cloud");
    const old = await legacy(PASSWORD);
    await h.db.update(credentials).set({ passwordHash: old }).where(eq(credentials.userId, user.userId));
    const verify = h.deps.passwordHasher.verify.bind(h.deps.passwordHasher);
    h.deps.passwordHasher.verify = async (p, s) => {
      const ok = await verify(p, s);
      await h.db.update(credentials).set({ passwordHash: "moved-underneath-password-hash-password-hash" }).where(eq(credentials.userId, user.userId));
      return ok;
    };
    expect(await attempt(h, "10.10.0.2", "moved@x.example", PASSWORD)).toBe("ok");
    expect(await credentialOf(h, user.userId)).toBe("moved-underneath-password-hash-password-hash");
  }, 60_000);
});
