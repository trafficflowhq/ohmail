/**
 * THE ACCOUNT'S NAMED DEVICES ON THE SETTINGS RECORD, AND WHO RINGS FOR THEM.
 *
 * A person is told that a device was paired to their account by the account's other signed-in
 * clients, which compare two readings of the settings record. The record says three whole numbers
 * (`device-numbers.ts`): how many named devices were ever made and how many of them were taken
 * back in Devices, which only rise, and how many are signed in now. A path that makes a named
 * device rings once it has committed (`auth/device-doorbell.ts`); the Devices list's take-back
 * stamps the device and rings; nothing that only ends a session does either.
 *
 * Every path is driven through the service a route calls, on the store's own journal. Each
 * transaction a path opens is counted at the handle, so "after its own commit" is read off what
 * was committed when the ring's transaction opened, not off the source.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { format } from "node:util";
import { and, desc, eq } from "drizzle-orm";
import { generateSync } from "otplib";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, changeLog, devices, refreshTokens, sessions } from "@trafficflow/db";
import {
  AuthService, makeTestAuthDeps, generateToken, hashToken, mintAppHandoff, mintPairingToken, redeemAppHandoff,
  redeemDevicePair, resolveSession,
  type OAuthTokens, type ServiceContext, type SessionUser,
} from "../src/index.js";
import { ringDeviceMade, ringDeviceRevoked } from "../src/auth/device-doorbell.js";
import { runInTransaction } from "../src/context.js";
import { deviceNumbers } from "../src/device-numbers.js";
import { materializeSettings } from "../src/dto/materialize.js";
import { SoftwareAuthenticator } from "./webauthn-authenticator.js";

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const ORIGIN = "http://localhost:3000";
const RPID = "localhost";
const START = new Date("2026-11-17T08:00:00.000Z");
const PASSWORD = "account-signin-password";
const EVENT = "devices_doorbell_failed";

afterEach(() => { vi.restoreAllMocks(); });

/** One top-level transaction a path opened: what was already committed when it opened. */
interface Opened { readonly alreadyOpen: number; readonly rings: number; readonly made: number }

interface World {
  readonly db: Db;
  readonly svc: AuthService;
  now(): Date;
  advance(ms: number): void;
  /** A context over a handle that counts the top-level transactions opened through it. */
  ctx(over?: Partial<ServiceContext>): ServiceContext;
  /** The top-level transactions opened since the last call, in order. */
  opened(accountId: string): Promise<Opened[]>;
  rings(accountId: string): Promise<number>;
}

async function world(): Promise<World> {
  const db = await makeTestDb();
  let t = new Date(START);
  const rings = async (accountId: string): Promise<number> => (await db.select({ seq: changeLog.seq }).from(changeLog)
    .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings")))).length;
  // Every top-level transaction is noted with what the store held when it opened; the reads are
  // made before the transaction starts, so they see only what is committed.
  let depth = 0;
  let watched: string | null = null;
  let log: Opened[] = [];
  const counting = Object.create(db) as Db;
  Object.defineProperty(counting, "transaction", {
    value: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (watched !== null) {
        log.push({ alreadyOpen: depth, rings: await rings(watched), made: (await deviceNumbers(db, watched)).made });
      }
      depth += 1;
      try {
        return await (db as unknown as { transaction: (f: typeof fn) => Promise<unknown> }).transaction(fn);
      } finally {
        depth -= 1;
      }
    },
  });
  return {
    db,
    svc: new AuthService(makeTestAuthDeps()),
    now: () => t,
    advance: (ms) => { t = new Date(t.getTime() + ms); },
    ctx: (over = {}) => ({
      db: counting as unknown as ServiceContext["db"], accountId: "", userId: null, now: () => t, requestId: "r", ip: "1.2.3.4", ...over,
    }),
    opened: async (accountId) => {
      const seen = log;
      log = [];
      watched = accountId;
      return seen;
    },
    rings,
  };
}

const code = (w: World, secret: string): string => generateSync({ secret, epoch: Math.floor(w.now().getTime() / 1000) });

/** A full session of `user` with a second factor asserted now, seeded: the caller of a mint. */
async function stepped(w: World, user: SessionUser): Promise<ServiceContext> {
  const now = w.now();
  const [row] = await w.db.insert(sessions).values({
    accountId: user.accountId, userId: user.userId, familyId: crypto.randomUUID(), scope: "full",
    accessExpiresAt: new Date(now.getTime() + 60 * 60_000), refreshExpiresAt: new Date(now.getTime() + 120 * 60_000),
    lastTwofaAt: now, lastSeenAt: now,
  }).returning();
  return w.ctx({ userId: user.userId, accountId: user.accountId, sessionId: row!.id });
}

let people = 0;
/** A registered person with an authenticator, and a signed-in browser of theirs. */
async function person(w: World) {
  const email = `person-${++people}@x.example`;
  const reg = await w.svc.register(w.ctx(), { email, password: PASSWORD, displayName: "P", inviteCode: "INVITE-OK" });
  if (!("user" in reg)) throw new Error("registration answered pending; the invite path mints a session");
  const { user } = reg;
  const browser = await stepped(w, user);
  const { secret } = await w.svc.totpEnroll(browser);
  await w.svc.totpActivate(browser, { code: code(w, secret) });
  return { user, email, secret, browser, accountId: user.accountId };
}

/** A person who registered and holds only the password-only session of their first sign-in. */
async function enrolling(w: World) {
  const email = `enrolling-${++people}@x.example`;
  const reg = await w.svc.register(w.ctx(), { email, password: PASSWORD, displayName: "E", inviteCode: "INVITE-OK" });
  if (!("user" in reg)) throw new Error("registration answered pending; the invite path mints a session");
  const resolved = await resolveSession(w.db, reg.enrollmentToken, w.now());
  const ctx = w.ctx({ userId: reg.user.userId, accountId: reg.user.accountId, sessionId: resolved!.sessionId });
  return { user: reg.user, ctx, accountId: reg.user.accountId };
}

async function pair(w: World, by: ServiceContext, kind: "mobile-android" | "web" = "mobile-android"): Promise<OAuthTokens> {
  const minted = await mintPairingToken(by, { grant: "device-pair", label: "Kitchen phone" });
  return (await redeemDevicePair(w.ctx(), w.svc, { token: minted.token, kind })).tokens;
}

/** The session and the device a bearer pair names. */
async function sessionOf(w: World, tokens: OAuthTokens) {
  const [row] = await w.db.select({ sessionId: refreshTokens.sessionId }).from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(tokens.refreshToken))).limit(1);
  const [session] = await w.db.select().from(sessions).where(eq(sessions.id, row!.sessionId)).limit(1);
  return { sessionId: session!.id, deviceId: session!.deviceId };
}

/** What a path is measured by: the account it acts on, and the one call that makes (or ends) something. */
interface Armed { readonly accountId: string; act(): Promise<unknown> }

/** Every path that makes a named device, armed up to its last call. */
const MAKERS: ReadonlyArray<readonly [string, (w: World) => Promise<Armed>]> = [
  ["a scanned pairing code's redeem", async (w) => {
    const p = await person(w);
    const minted = await mintPairingToken(p.browser, { grant: "device-pair", label: "Kitchen phone" });
    return { accountId: p.accountId, act: () => redeemDevicePair(w.ctx(), w.svc, { token: minted.token, kind: "mobile-android" }) };
  }],
  ["a phone app's handoff to its sibling", async (w) => {
    const p = await person(w);
    const phone = await pair(w, p.browser);
    const verifier = generateToken();
    const handoff = await mintAppHandoff(w.ctx(), w.svc, { renewed: phone.refreshToken, challenge: hashToken(verifier), target: "ohcal" });
    return { accountId: p.accountId, act: () => redeemAppHandoff(w.ctx(), w.svc, { token: handoff.token, verifier, kind: "mobile-android" }) };
  }],
  ["a desktop app's sign-in by a link code", async (w) => {
    const p = await person(w);
    const link = await w.svc.issueDesktopLink(p.browser);
    return { accountId: p.accountId, act: () => w.svc.claimDesktopLink(w.ctx({ ip: "10.0.0.9" }), { code: link.code, kind: "desktop-linux" }) };
  }],
  ["a desktop app's sign-in by the browser's approval", async (w) => {
    const p = await person(w);
    const verifier = generateToken();
    const asked = await w.svc.issueDesktopApproval(w.ctx(), { challenge: hashToken(verifier), kind: "desktop-linux" });
    await w.svc.confirmDesktopApproval(p.browser, asked.approvalId);
    return {
      accountId: p.accountId,
      act: async () => {
        const claimed = await w.svc.claimDesktopApproval(w.ctx(), { approvalId: asked.approvalId, verifier, kind: "desktop-linux" });
        expect("tokens" in claimed, "the confirmed approval answered the pair").toBe(true);
      },
    };
  }],
  ["a desktop app's sign-in by the authorization code's exchange", async (w) => {
    const p = await person(w);
    const verifier = generateToken();
    const { request } = await w.svc.authorize(p.browser, {
      response_type: "code", client_id: "tf-macos", redirect_uri: "trafficflow://auth",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: `S${"256"}` as const, state: "s", scope: "full",
    });
    const granted = new URL((await w.svc.approveAuthorize(p.browser, { request })).redirect).searchParams.get("code")!;
    return {
      accountId: p.accountId,
      act: () => w.svc.token(w.ctx(), {
        grant_type: "authorization_code", code: granted, redirect_uri: "trafficflow://auth", client_id: "tf-macos", code_verifier: verifier,
      }),
    };
  }],
  ["a desktop app's sign-in by a password and a second factor", async (w) => {
    const p = await person(w);
    w.advance(31_000);
    const ch = await w.svc.login(w.ctx(), { email: p.email, password: PASSWORD }) as { loginToken: string };
    return { accountId: p.accountId, act: () => w.svc.totpVerify(w.ctx(), { loginToken: ch.loginToken, code: code(w, p.secret), kind: "desktop-linux" }) };
  }],
  ["a desktop's first authenticator, which exchanges its first session", async (w) => {
    const e = await enrolling(w);
    const { secret } = await w.svc.totpEnroll(e.ctx);
    return {
      accountId: e.accountId,
      act: async () => {
        const activated = await w.svc.totpActivate(e.ctx, { code: code(w, secret) }, { client: "macos" });
        expect(activated.session?.status, "the first factor exchanged the session").toBe("authenticated");
      },
    };
  }],
  ["a desktop's first passkey, which exchanges its first session", async (w) => {
    const e = await enrolling(w);
    const authenticator = new SoftwareAuthenticator();
    const { options } = await w.svc.webauthnRegisterOptions(e.ctx);
    const credential = authenticator.register({ rpID: RPID, challenge: (options as { challenge: string }).challenge, origin: ORIGIN });
    return {
      accountId: e.accountId,
      act: async () => {
        const verified = await w.svc.webauthnRegisterVerify(e.ctx, { credential, label: "MacBook" }, { client: "macos" });
        expect(verified.session?.status, "the first factor exchanged the session").toBe("authenticated");
      },
    };
  }],
];

describe("a path that makes a named device rings once, after its own commit", () => {
  it.each(MAKERS)("%s", async (_name, arm) => {
    const w = await world();
    const armed = await arm(w);
    const before = { rings: await w.rings(armed.accountId), numbers: await deviceNumbers(w.db, armed.accountId) };
    await w.opened(armed.accountId);

    await armed.act();

    const after = await deviceNumbers(w.db, armed.accountId);
    expect(after, "one device more was made, none was taken back")
      .toEqual({ made: before.numbers.made + 1, revoked: before.numbers.revoked, live: before.numbers.live + 1 });
    expect(await w.rings(armed.accountId), "one settings change row").toBe(before.rings + 1);
    // The ring's transaction is the last one the path opened. When it opened no other was open, the
    // device was committed, and no change row stood yet: it is the path's own commit that it follows.
    const opened = await w.opened(armed.accountId);
    expect(opened.length, "the path's own transaction, then the ring's").toBeGreaterThanOrEqual(2);
    expect(opened.at(-1)).toEqual({ alreadyOpen: 0, rings: before.rings, made: before.numbers.made + 1 });
    // And the record every client of the account reads says the same three numbers.
    const record = await materializeSettings(w.db, armed.accountId, armed.accountId);
    expect({ made: record?.devicesMade, revoked: record?.devicesRevoked, live: record?.devices }).toEqual(after);
  });
});

describe("what makes no named device, or only ends a session, rings nothing", () => {
  /** A person with a paired phone and a second browser session, as the paths below find them. */
  async function household(w: World) {
    const p = await person(w);
    const phone = await pair(w, p.browser);
    return { ...p, phone, phoneSession: await sessionOf(w, phone) };
  }

  /** `act` moved neither rising number and wrote no change row; `live` moved by `liveBy`. */
  async function silent(w: World, accountId: string, liveBy: number, act: () => Promise<unknown>): Promise<void> {
    const before = { rings: await w.rings(accountId), numbers: await deviceNumbers(w.db, accountId) };
    await act();
    const after = await deviceNumbers(w.db, accountId);
    expect({ made: after.made, revoked: after.revoked }).toEqual({ made: before.numbers.made, revoked: before.numbers.revoked });
    expect(after.live - before.numbers.live, "devices signed in now").toBe(liveBy);
    expect(await w.rings(accountId), "no settings change row").toBe(before.rings);
  }

  it("a browser's sign-in by a password and a second factor", async () => {
    const w = await world();
    const p = await person(w);
    w.advance(31_000);
    const ch = await w.svc.login(w.ctx(), { email: p.email, password: PASSWORD }) as { loginToken: string };
    await silent(w, p.accountId, 0, () => w.svc.totpVerify(w.ctx(), { loginToken: ch.loginToken, code: code(w, p.secret) }));
  });

  it("a desktop approval that is still waiting for its confirmation", async () => {
    const w = await world();
    const p = await person(w);
    const verifier = generateToken();
    const asked = await w.svc.issueDesktopApproval(w.ctx(), { challenge: hashToken(verifier), kind: "desktop-linux" });
    await silent(w, p.accountId, 0, async () => {
      expect(await w.svc.claimDesktopApproval(w.ctx(), { approvalId: asked.approvalId, verifier, kind: "desktop-linux" }))
        .toMatchObject({ status: "pending" });
    });
  });

  it("a device that signs itself out", async () => {
    const w = await world();
    const h = await household(w);
    await silent(w, h.accountId, -1, () =>
      w.svc.logout(w.ctx({ userId: h.user.userId, accountId: h.accountId, sessionId: h.phoneSession.sessionId })));
  });

  it("a device that signs itself out by its refresh token", async () => {
    const w = await world();
    const h = await household(w);
    await silent(w, h.accountId, -1, () => w.svc.logout(w.ctx(), { refreshToken: h.phone.refreshToken }));
  });

  it("a refresh token presented twice, which ends its whole family", async () => {
    const w = await world();
    const h = await household(w);
    await w.svc.refresh(w.ctx(), { refreshToken: h.phone.refreshToken });
    await silent(w, h.accountId, -1, async () => {
      await expect(w.svc.refresh(w.ctx(), { refreshToken: h.phone.refreshToken })).rejects.toBeTruthy();
    });
  });

  it("a change of a second factor, which signs every other session out", async () => {
    const w = await world();
    const h = await household(w);
    // A second factor of another kind first, so the authenticator is not the last one.
    const authenticator = new SoftwareAuthenticator();
    const { options } = await w.svc.webauthnRegisterOptions(h.browser);
    const credential = authenticator.register({ rpID: RPID, challenge: (options as { challenge: string }).challenge, origin: ORIGIN });
    await w.svc.webauthnRegisterVerify(h.browser, { credential, label: "MacBook" });
    await silent(w, h.accountId, -1, () => w.svc.totpRemove(h.browser));
  });

  it("signing out every other browser session", async () => {
    const w = await world();
    const h = await household(w);
    await stepped(w, h.user);
    await silent(w, h.accountId, 0, () => w.svc.revokeWebSessions(h.browser));
  });

  it("the Devices list's take-back of a plain browser session, which is no named device", async () => {
    const w = await world();
    const h = await household(w);
    const other = await stepped(w, h.user);
    await silent(w, h.accountId, 0, () => w.svc.revokeDevice(h.browser, other.sessionId!));
    const [ended] = await w.db.select({ revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.id, other.sessionId!));
    expect(ended!.revokedAt, "the session was ended all the same").not.toBeNull();
  });

  it("a pairing that replaces the phone's previous sign-in tells the new device and no take-back", async () => {
    const w = await world();
    const h = await household(w);
    const before = { rings: await w.rings(h.accountId), numbers: await deviceNumbers(w.db, h.accountId) };
    const minted = await mintPairingToken(h.browser, { grant: "device-pair", label: "Kitchen phone" });
    await redeemDevicePair(w.ctx({ supersedesInstall: hashToken(h.phone.refreshToken) }), w.svc, { token: minted.token, kind: "mobile-android" });
    // One was made and the one before it was ended: as many are signed in as before.
    expect(await deviceNumbers(w.db, h.accountId)).toEqual({ made: before.numbers.made + 1, revoked: 0, live: before.numbers.live });
    expect(await w.rings(h.accountId)).toBe(before.rings + 1);
  });
});

describe("the Devices list's take-back of a named device", () => {
  async function taken(w: World) {
    const p = await person(w);
    const phone = await sessionOf(w, await pair(w, p.browser));
    return { ...p, deviceId: phone.deviceId! };
  }
  const stampOf = async (w: World, deviceId: string): Promise<Date | null> =>
    (await w.db.select({ at: devices.revokedAt }).from(devices).where(eq(devices.id, deviceId)))[0]!.at;

  it("stamps the device and rings once, after the take-back committed", async () => {
    const w = await world();
    const t = await taken(w);
    const before = { rings: await w.rings(t.accountId), numbers: await deviceNumbers(w.db, t.accountId) };
    expect(await stampOf(w, t.deviceId)).toBeNull();
    await w.opened(t.accountId);
    w.advance(5_000);

    await w.svc.revokeDevice(t.browser, t.deviceId);

    expect(await deviceNumbers(w.db, t.accountId)).toEqual({ made: before.numbers.made, revoked: 1, live: before.numbers.live - 1 });
    expect(await stampOf(w, t.deviceId)).toEqual(w.now());
    expect(await w.rings(t.accountId)).toBe(before.rings + 1);
    const opened = await w.opened(t.accountId);
    expect(opened.at(-1)).toMatchObject({ alreadyOpen: 0, rings: before.rings });
    const [session] = await w.db.select({ revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.deviceId, t.deviceId));
    expect(session!.revokedAt, "the session was ended by the take-back itself, before the ring").not.toBeNull();
  });

  it("a second press on the same device tells nothing more", async () => {
    const w = await world();
    const t = await taken(w);
    await w.svc.revokeDevice(t.browser, t.deviceId);
    const first = { rings: await w.rings(t.accountId), stamp: await stampOf(w, t.deviceId) };
    w.advance(60_000);
    await w.svc.revokeDevice(t.browser, t.deviceId);
    expect(await w.rings(t.accountId)).toBe(first.rings);
    expect(await stampOf(w, t.deviceId), "the stamp is written once").toEqual(first.stamp);
    expect((await deviceNumbers(w.db, t.accountId)).revoked).toBe(1);
  });

  it("a press on a device that had already signed itself out ends nothing, stamps nothing and tells nothing", async () => {
    const w = await world();
    const p = await person(w);
    const phone = await sessionOf(w, await pair(w, p.browser));
    await w.svc.logout(w.ctx({ userId: p.user.userId, accountId: p.accountId, sessionId: phone.sessionId }));
    const before = await w.rings(p.accountId);
    // A Devices list read before the sign-out still shows the row, and the person presses it.
    await w.svc.revokeDevice(p.browser, phone.deviceId!);
    expect(await stampOf(w, phone.deviceId!), "a device nobody took back was counted as taken back").toBeNull();
    expect(await deviceNumbers(w.db, p.accountId)).toEqual({ made: 1, revoked: 0, live: 0 });
    expect(await w.rings(p.accountId)).toBe(before);
  });

  it("an app the device handed its sign-in to is ended with it, and is not counted as taken back", async () => {
    const w = await world();
    const p = await person(w);
    const phone = await pair(w, p.browser);
    const verifier = generateToken();
    const handoff = await mintAppHandoff(w.ctx(), w.svc, { renewed: phone.refreshToken, challenge: hashToken(verifier), target: "ohcal" });
    await redeemAppHandoff(w.ctx(), w.svc, { token: handoff.token, verifier, kind: "mobile-android" });
    expect(await deviceNumbers(w.db, p.accountId)).toEqual({ made: 2, revoked: 0, live: 2 });
    await w.svc.revokeDevice(p.browser, (await sessionOf(w, phone)).deviceId!);
    expect(await deviceNumbers(w.db, p.accountId)).toEqual({ made: 2, revoked: 1, live: 0 });
  });

  it("another person's device is neither ended nor stamped, and nothing is rung for either account", async () => {
    const w = await world();
    const mine = await taken(w);
    const theirs = await taken(w);
    const before = { mine: await w.rings(mine.accountId), theirs: await w.rings(theirs.accountId) };
    await w.svc.revokeDevice(mine.browser, theirs.deviceId);
    expect(await stampOf(w, theirs.deviceId)).toBeNull();
    expect(await deviceNumbers(w.db, theirs.accountId)).toMatchObject({ revoked: 0, live: 1 });
    expect({ mine: await w.rings(mine.accountId), theirs: await w.rings(theirs.accountId) }).toEqual(before);
    // Nor by the ring itself, handed a device of another account: the stamp names account and person.
    await ringDeviceRevoked(mine.browser, { accountId: mine.accountId, userId: mine.user.userId, deviceId: theirs.deviceId });
    expect(await stampOf(w, theirs.deviceId)).toBeNull();
    expect({ mine: await w.rings(mine.accountId), theirs: await w.rings(theirs.accountId) }).toEqual(before);
  });
});

describe("the numbers are counted for one account, from the device rows", () => {
  it("another account's devices are not counted, and a plain browser session is no named device", async () => {
    const w = await world();
    const a = await person(w);
    const b = await person(w);
    await pair(w, a.browser);
    await pair(w, a.browser);
    await pair(w, b.browser);
    await stepped(w, a.user);
    expect(await deviceNumbers(w.db, a.accountId)).toEqual({ made: 2, revoked: 0, live: 2 });
    expect(await deviceNumbers(w.db, b.accountId)).toEqual({ made: 1, revoked: 0, live: 1 });
  });

  it("an account with no device row reads three zeros, and the record carries them before any settings row exists", async () => {
    const w = await world();
    const p = await person(w);
    expect(await deviceNumbers(w.db, p.accountId)).toEqual({ made: 0, revoked: 0, live: 0 });
    const record = await materializeSettings(w.db, p.accountId, p.accountId);
    expect(record).toMatchObject({ devices: 0, devicesMade: 0, devicesRevoked: 0 });
  });

  it("the record holds nothing of a device but the three numbers", async () => {
    const w = await world();
    const p = await person(w);
    await pair(w, p.browser);
    const [device] = await w.db.select().from(devices).where(eq(devices.accountId, p.accountId)).orderBy(desc(devices.createdAt)).limit(1);
    const record = JSON.stringify(await materializeSettings(w.db, p.accountId, p.accountId));
    for (const word of [device!.label, device!.kind, device!.id, device!.ip]) expect(record).not.toContain(word);
  });
});

/** The logger's lines, parsed: what the process would print. */
function heard() {
  const lines: Array<Record<string, unknown>> = [];
  const printed: string[] = [];
  for (const m of ["log", "error", "warn", "info"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      const s = format(...a);
      printed.push(s);
      try { lines.push(JSON.parse(s) as Record<string, unknown>); } catch { /* not a log line */ }
    });
  }
  return { named: (event: string) => lines.filter((l) => l.event === event), printed: () => printed.join("\n") };
}

describe("the ring can fail nothing, and rings only after a commit", () => {
  it("handed a transaction's handle it writes nothing and throws nothing", async () => {
    const w = await world();
    const p = await person(w);
    const before = await w.rings(p.accountId);
    const h = heard();
    // A plain transaction, and one that opened on this account's fence as every sign-in path's does:
    // inside that one a fenced transaction of the ring's own would open as a part of it, and its
    // change row would be written under whatever the path still holds.
    await (w.db as unknown as { transaction: (f: (tx: unknown) => Promise<void>) => Promise<void> }).transaction(async (tx) => {
      await ringDeviceMade({ ...w.ctx(), db: tx as ServiceContext["db"] }, p.accountId);
    });
    await runInTransaction(w.ctx(), async (txCtx) => {
      await ringDeviceMade(txCtx, p.accountId);
      await ringDeviceRevoked(txCtx, { accountId: p.accountId, userId: p.user.userId, deviceId: crypto.randomUUID() });
    }, { fence: { accountId: p.accountId } });
    expect(await w.rings(p.accountId)).toBe(before);
    expect(h.named(EVENT)).toHaveLength(3);
  });

  it("a ring that cannot be written leaves the pairing made, answered and counted", async () => {
    const w = await world();
    const p = await person(w);
    const minted = await mintPairingToken(p.browser, { grant: "device-pair", label: "Kitchen phone" });
    const before = await w.rings(p.accountId);
    // The redeem's own transaction commits; the next one opened on the handle is the ring's.
    let opened = 0;
    const failing = Object.create(w.db) as Db;
    Object.defineProperty(failing, "transaction", {
      value: (fn: (tx: unknown) => Promise<unknown>) => (++opened === 2
        ? Promise.reject(new Error("the store went away"))
        : (w.db as unknown as { transaction: (f: typeof fn) => Promise<unknown> }).transaction(fn)),
    });
    const h = heard();
    const answer = await redeemDevicePair({ ...w.ctx(), db: failing as unknown as ServiceContext["db"] }, w.svc, { token: minted.token, kind: "mobile-android" });
    expect(answer.tokens.accessToken).toBeTruthy();
    expect(opened).toBe(2);
    expect(await w.rings(p.accountId), "the change row was not written").toBe(before);
    expect((await deviceNumbers(w.db, p.accountId)).made, "and the number rose all the same: it is counted from the row").toBe(1);
    const logged = h.named(EVENT);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: "warn", accountId: p.accountId });
    expect(String(logged[0]!.reason), "the line says which ring it was, in the logger's own fields").toContain("the device was MADE");
    expect(logged[0]!.droppedFields, "no field of the line was refused by the logger").toBeUndefined();
  });

  it("an account erased between the commit and the ring gets no change row, and nothing is said", async () => {
    const w = await world();
    const p = await person(w);
    const phone = await sessionOf(w, await pair(w, p.browser));
    const before = await w.rings(p.accountId);
    await w.db.update(accounts).set({ erasedAt: w.now() }).where(eq(accounts.id, p.accountId));
    const h = heard();
    await ringDeviceMade(w.ctx(), p.accountId);
    await ringDeviceRevoked(w.ctx(), { accountId: p.accountId, userId: p.user.userId, deviceId: phone.deviceId! });
    expect(await w.rings(p.accountId)).toBe(before);
    const [device] = await w.db.select({ at: devices.revokedAt }).from(devices).where(eq(devices.id, phone.deviceId!));
    expect(device!.at, "an erased account's device is not stamped").toBeNull();
    expect(h.printed(), "nobody is left to tell, and nothing went wrong").toBe("");
  });

  it("no account named, or a word that is no id, rings nothing and throws nothing", async () => {
    const w = await world();
    await person(w);
    const before = (await w.db.select({ seq: changeLog.seq }).from(changeLog)).length;
    const h = heard();
    await expect(ringDeviceMade(w.ctx(), "")).resolves.toBeUndefined();
    await expect(ringDeviceMade(w.ctx(), "not-an-id")).resolves.toBeUndefined();
    expect(h.named(EVENT)).toHaveLength(2);
    expect((await w.db.select({ seq: changeLog.seq }).from(changeLog)).length).toBe(before);
  });
});
