import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { accounts, sessions, users } from "@trafficflow/db";
import { authThrottle, credentials, loginTokens, makeOwnedDb, totpSecrets, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  generateToken, hashToken, makeAuthService, makeTestAuthDeps, mintPairingToken, redeemDevicePair,
  type Db, type ServiceContext,
} from "../src/index.js";

/**
 * THE PASSWORD CHANGE AGAINST A SIGN-IN IN FLIGHT, ON POSTGRES. PGlite runs one statement at a time,
 * so it cannot show the two waits the change relies on:
 *
 *  1. A sign-in that checked the old password writes its first step only while that password is
 *     still the account's, read FOR SHARE. With the change holding the credential row it rewrote,
 *     the sign-in waits, then reads the new hash and is refused; a plain read would see the old one,
 *     write a first step the change's void has already passed, and leave it live.
 *  2. The change voids pending grants BEFORE it claims the sessions. A pairing redeem that burned
 *     its code first holds that row, so the change waits on it; when the redeem commits, the claim
 *     that follows takes the session it minted. Claiming first would miss that session.
 *
 * Each party runs on its own named connection, and each is seen waiting where it should.
 */

const PG_UP = await realPgAvailable();
const OLD = "pw-correct-horse-battery-password-password";
const NEW = "new-battery-staple-horse-password";

type Settled<T> = { ok: true; v: T } | { ok: false; e: unknown };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const answer = (s: Settled<unknown>): string => (s.ok ? "ok" : String((s.e as { code?: unknown })?.code ?? s.e));

let base: OwnedDb | null = null;
const opened: OwnedDb[] = [];
const db = (): Db => base!.db as unknown as Db;

/** A handle whose backends carry `app` as their application name, so each party can be watched. */
function named(app: string): OwnedDb {
  const u = new URL(PG_TEST_URL);
  u.searchParams.set("application_name", app);
  const o = makeOwnedDb(u.toString());
  opened.push(o);
  return o;
}

/** The statement a backend named `waiter` is blocked on while one named `holder` blocks it. */
async function blockedOn(waiter: string, holder: string, ms: number): Promise<string | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const rows = await db().execute(sql`select w.query as q from pg_stat_activity w
      where w.datname = current_database() and w.application_name = ${waiter} and w.wait_event_type = 'Lock'
        and exists (select 1 from pg_stat_activity h
          where h.application_name = ${holder} and h.pid = any(pg_blocking_pids(w.pid)))`);
    const q = (rows as unknown as Array<{ q: string }>)[0]?.q;
    if (q !== undefined) return q;
    await sleep(20);
  }
  return null;
}

/** The lock a waiting statement asks for, in words. */
function lockOf(q: string | null): string {
  if (q === null) return "never";
  if (/from "credentials".*for share/is.test(q)) return "credentials FOR SHARE";
  if (/from "sessions".*for update/is.test(q)) return "sessions FOR UPDATE";
  if (/^\s*update "pairing_tokens"/i.test(q)) return "UPDATE pairing_tokens";
  if (/^\s*update "auth_throttle"/i.test(q)) return "UPDATE auth_throttle";
  return q.replace(/\s+/g, " ").slice(0, 80);
}

const randomIp = (): string =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

interface Person { accountId: string; userId: string; email: string; caller: string; other: string }

/** A user with the old password, a second factor, and two full sessions: the caller's and another. */
async function person(): Promise<Person> {
  const deps = makeTestAuthDeps();
  const tag = randomUUID().slice(0, 8);
  const [a] = await db().insert(accounts).values({ name: `pw-race-${tag}` }).returning();
  const email = `pw-race-${tag}@x.example`;
  const [u] = await db().insert(users).values({ accountId: a!.id, email }).returning();
  await db().insert(credentials).values({ userId: u!.id, passwordHash: await deps.passwordHasher.hash(OLD), algo: "scrypt" });
  // An activated factor, so a right password answers with a first step and not a session.
  const { ciphertext, keyVersion } = await deps.keyProvider.encrypt(generateToken());
  await db().insert(totpSecrets).values({ userId: u!.id, secretEnc: ciphertext, keyVersion, activated: true });
  const session = async (): Promise<string> => {
    const now = Date.now();
    const [s] = await db().insert(sessions).values({
      accountId: a!.id, userId: u!.id, familyId: randomUUID(), accessTokenHash: hashToken(generateToken()),
      accessExpiresAt: new Date(now + 10 * 60_000), refreshExpiresAt: new Date(now + 30 * 86_400_000),
      lastTwofaAt: new Date(now),
    }).returning();
    return s!.id;
  };
  return { accountId: a!.id, userId: u!.id, email, caller: await session(), other: await session() };
}

/** A request on `handle`: as the caller's session, or (no session) as an anonymous sign-in. */
const ctxOn = (handle: unknown, p: Person, sessionId: string | null): ServiceContext => ({
  db: handle as never, accountId: sessionId ? p.accountId : "", userId: sessionId ? p.userId : null, sessionId,
  now: () => new Date(), requestId: `pw-race-${randomUUID()}`, ip: randomIp(),
});

/** One transaction on `hold` that takes `lock` and keeps it until the returned release is called. */
async function holding(hold: OwnedDb, lock: ReturnType<typeof sql>): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void; let locked!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const isLocked = new Promise<void>((r) => { locked = r; });
  const done = hold.db.transaction(async (tx) => {
    await tx.execute(lock);
    locked();
    await released;
  });
  await isLocked;
  return { release, done };
}

const liveSessions = async (userId: string): Promise<string[]> =>
  (await db().select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))).map((r) => r.id);

describe.skipIf(!PG_UP)("the password change against a sign-in in flight, on Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    base = makeOwnedDb(PG_TEST_URL);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(opened.map((o) => o.close()));
    await base?.close();
  });

  it("a sign-in that checked the old password waits on the change's credential row, is refused, and leaves no first step", async () => {
    const p = await person();
    const auth = makeAuthService(makeTestAuthDeps());
    const tag = randomUUID().slice(0, 8);
    const [H, C, L] = [`pwr-hold-${tag}`, `pwr-change-${tag}`, `pwr-login-${tag}`];
    const hold = named(H); const changer = named(C); const signer = named(L);
    // Parks the change at its session claim: past the compare-and-set and the void, the
    // credential row it rewrote held and not yet committed.
    const parked = await holding(hold, sql`select id from sessions where id = ${p.other} for update`);
    const change = settle(auth.changePassword(ctxOn(changer.db, p, p.caller), { currentPassword: OLD, newPassword: NEW }));
    expect(lockOf(await blockedOn(C, H, 10_000)), "the change is parked at its session claim").toBe("sessions FOR UPDATE");

    const signIn = settle(auth.login(ctxOn(signer.db, p, null), { email: p.email, password: OLD }));
    const early = await Promise.race([signIn.then(() => true), sleep(3_000).then(() => false)]);
    const waited = early ? "never" : lockOf(await blockedOn(L, C, 5_000));
    parked.release();
    await parked.done;
    const [c, l] = await Promise.all([change, signIn]);

    expect({ change: answer(c), signIn: answer(l), waited }).toEqual({
      change: "ok", signIn: "credential_refused", waited: "credentials FOR SHARE",
    });
    const firstSteps = await db().select({ id: loginTokens.id }).from(loginTokens).where(and(
      eq(loginTokens.userId, p.userId), eq(loginTokens.purpose, "login"), isNull(loginTokens.consumedAt),
    ));
    expect(firstSteps, "a first step taken with the old password outlived the change").toEqual([]);
    expect(await liveSessions(p.userId)).toEqual([p.caller]);
  }, 60_000);

  it("a pairing redeem that burned its code first is waited for, and the change then signs its session out", async () => {
    const p = await person();
    const auth = makeAuthService(makeTestAuthDeps());
    const pair = await mintPairingToken(ctxOn(db(), p, p.other), { grant: "device-pair", label: "pw-race phone" });
    // The redeem's last write is the sign-in bookkeeping on this row: held, it parks the redeem with
    // the code burned and its session written, neither committed.
    const key = `user:${p.userId}`;
    await db().insert(authThrottle).values({ key, failures: 0 }).onConflictDoNothing();
    const tag = randomUUID().slice(0, 8);
    const [H, R, C] = [`pwr-hold-${tag}`, `pwr-redeem-${tag}`, `pwr-change-${tag}`];
    const hold = named(H); const redeemer = named(R); const changer = named(C);
    const parked = await holding(hold, sql`select key from auth_throttle where key = ${key} for update`);
    const redeem = settle(redeemDevicePair(ctxOn(redeemer.db, p, null), auth, { token: pair.token, kind: "mobile-android" }));
    expect(lockOf(await blockedOn(R, H, 10_000)), "the redeem is parked after its burn and its mint").toBe("UPDATE auth_throttle");

    const change = settle(auth.changePassword(ctxOn(changer.db, p, p.caller), { currentPassword: OLD, newPassword: NEW }));
    const waited = lockOf(await blockedOn(C, R, 10_000));
    parked.release();
    await parked.done;
    const [r, c] = await Promise.all([redeem, change]);

    expect({ redeem: answer(r), change: answer(c), waited }).toEqual({
      redeem: "ok", change: "ok", waited: "UPDATE pairing_tokens",
    });
    expect(await liveSessions(p.userId), "the session the redeem minted outlived the change").toEqual([p.caller]);
  }, 60_000);
});
