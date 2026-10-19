import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { accounts, sessions, users } from "@trafficflow/db";
import { credentials, loginTokens, makeOwnedDb, totpSecrets, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  DESKTOP_LINK_PURPOSE, OAuthCodeReplayed, generateToken, hashToken, makeAuthService, makeTestAuthDeps,
  mintPairingToken, redeemDevicePair, type Db, type ServiceContext,
} from "../src/index.js";
import { newTotpSecret, totpNow } from "../src/auth/totp.js";
import { SoftwareAuthenticator } from "./webauthn-authenticator.js";

/**
 * A GRANT MINTED OR SPENT WHILE A REVOKE RUNS, ON POSTGRES. A mint door checks its session at the
 * route; a revoke that commits after that check and before the mint does must still take the grant.
 * And a redeem spending a grant that was open when the revoke began must not keep the session it
 * writes. Four statements make that true, and PGlite runs one statement at a time, so it cannot show
 * any of them:
 *
 *  1. Every mint proves its own session live as its LAST statement, read FOR SHARE. A revoke that
 *     claimed the session first makes that read find nothing, and the mint rolls back.
 *  2. Every revoke voids the user's pending grants again after its session claim. A mint that held
 *     its session before the claim makes the claim wait, commits, and the second void takes it.
 *  3. Every revoke takes its user row FOR NO KEY UPDATE before its first void, the lock the mints that
 *     supersede a code take first, so the two wait for each other whole. A desktop link that had
 *     deleted the code before it and waited on the revoke's claim, while the revoke's second void
 *     waited on that row, was a deadlock.
 *  4. Every redeem burns its grant and writes its session in ONE transaction. A redeem holding its
 *     burn makes the revoke's first void wait, commits, and the claim then takes the session it wrote;
 *     a void that came first makes the burn wait, and the burn then finds the grant spent.
 *
 * Each party runs on its own named connection, and each is seen waiting where it should. A deadlock
 * victim answers 40P01, which no expectation below admits: a deadlock fails its case.
 */

const PG_UP = await realPgAvailable();

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

/** The statement a backend named `waiter` is blocked on while one named `holder` blocks it; `null` once `done()` or after `ms`. */
async function blockedOn(waiter: string, holder: string, ms: number, done: () => boolean = () => false): Promise<string | null> {
  const end = Date.now() + ms;
  while (Date.now() < end && !done()) {
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

/** The statement a backend named `waiter` waits on, on any lock; `null` once `done()` or after `ms`. */
async function waitingOn(waiter: string, ms: number, done: () => boolean = () => false): Promise<string | null> {
  const end = Date.now() + ms;
  while (Date.now() < end && !done()) {
    const rows = await db().execute(sql`select query as q from pg_stat_activity
      where datname = current_database() and application_name = ${waiter} and wait_event_type = 'Lock'`);
    const q = (rows as unknown as Array<{ q: string }>)[0]?.q;
    if (q !== undefined) return q;
    await sleep(20);
  }
  return null;
}

/** The lock a waiting statement asks for, in words. */
function lockOf(q: string | null): string {
  if (q === null) return "never";
  if (/from "users".*for no key update/is.test(q)) return "users FOR NO KEY UPDATE";
  if (/from "users".*for update/is.test(q)) return "users FOR UPDATE";
  if (/from "sessions".*for share/is.test(q)) return "sessions FOR SHARE";
  if (/from "sessions".*for update/is.test(q)) return "sessions FOR UPDATE";
  if (/^\s*update "login_tokens"/i.test(q)) return "UPDATE login_tokens";
  if (/^\s*delete from "login_tokens"/i.test(q)) return "DELETE login_tokens";
  if (/^\s*update "pairing_tokens"/i.test(q)) return "UPDATE pairing_tokens";
  if (/^\s*update "oauth_auth_codes"/i.test(q)) return "UPDATE oauth_auth_codes";
  if (/^\s*delete from "oauth_auth_codes"/i.test(q)) return "DELETE oauth_auth_codes";
  if (/^\s*insert into "auth_events"/i.test(q)) return "INSERT auth_events";
  return q.replace(/\s+/g, " ").slice(0, 80);
}


const randomIp = (): string =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

interface Person { accountId: string; userId: string; email: string; caller: string; other: string }

/** A user with two full sessions inside the step-up window: the caller's and another. */
async function person(): Promise<Person> {
  const tag = randomUUID().slice(0, 8);
  const email = `rg-race-${tag}@x.example`;
  const [a] = await db().insert(accounts).values({ name: `rg-race-${tag}` }).returning();
  const [u] = await db().insert(users).values({ accountId: a!.id, email }).returning();
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

/** A request on `handle`: as the given session, or (no session) as an anonymous redeem. */
const ctxOn = (handle: unknown, p: Person, sessionId: string | null): ServiceContext => ({
  db: handle as never, accountId: sessionId ? p.accountId : "", userId: sessionId ? p.userId : null, sessionId,
  now: () => new Date(), requestId: `rg-race-${randomUUID()}`, ip: randomIp(),
});

/** One transaction on `hold` that runs `steps` and keeps their locks until the release; then commits. */
async function holding(hold: OwnedDb, steps: Array<ReturnType<typeof sql>>): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void; let locked!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const isLocked = new Promise<void>((r) => { locked = r; });
  const done = hold.db.transaction(async (tx) => {
    for (const step of steps) await tx.execute(step);
    locked();
    await released;
  });
  await isLocked;
  return { release, done };
}

const liveSessions = async (userId: string): Promise<string[]> =>
  (await db().select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))).map((r) => r.id);

const liveLinks = async (userId: string): Promise<string[]> =>
  (await db().select({ id: loginTokens.id }).from(loginTokens).where(and(
    eq(loginTokens.userId, userId), eq(loginTokens.purpose, DESKTOP_LINK_PURPOSE),
    isNull(loginTokens.consumedAt), gt(loginTokens.expiresAt, new Date()),
  ))).map((r) => r.id);

describe.skipIf(!PG_UP)("a grant minted while a revoke runs, on Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    base = makeOwnedDb(PG_TEST_URL);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(opened.map((o) => o.close()));
    await base?.close();
  });

  it("a desktop link asked while everything is signed out waits at its user lock, is refused, and leaves no code", async () => {
    const p = await person();
    const auth = makeAuthService(makeTestAuthDeps());
    // A first step of the user's, held: the sign-out parks in its first void, its user row taken.
    const [step] = await db().insert(loginTokens).values({
      userId: p.userId, tokenHash: hashToken(generateToken()), methods: [], purpose: "login",
      expiresAt: new Date(Date.now() + 5 * 60_000),
    }).returning();
    const tag = randomUUID().slice(0, 8);
    const [H, C, M] = [`rgr-hold-${tag}`, `rgr-revoke-${tag}`, `rgr-mint-${tag}`];
    const hold = named(H); const revoker = named(C); const minter = named(M);
    const parked = await holding(hold, [sql`select id from login_tokens where id = ${step!.id} for update`]);
    const revoke = settle(auth.logout(ctxOn(revoker.db, p, p.caller), { allDevices: true }));
    expect(lockOf(await blockedOn(C, H, 10_000)), "the sign-out is parked in its first void").toBe("UPDATE login_tokens");

    // The mint, after its route admitted the other session: it waits for the sign-out at its first lock.
    const mint = settle(auth.issueDesktopLink(ctxOn(minter.db, p, p.other)));
    expect(lockOf(await blockedOn(M, C, 10_000)), "the mint waits at its user lock").toBe("users FOR NO KEY UPDATE");
    parked.release();
    await parked.done;
    const [revoked, m] = await Promise.all([revoke, mint]);

    expect({ revoke: answer(revoked), mint: answer(m) }).toEqual({ revoke: "ok", mint: "unauthorized" });
    expect(await liveLinks(p.userId), "a desktop link minted for a signed-out session outlived the sign-out").toEqual([]);
    expect(await liveSessions(p.userId)).toEqual([]);
  }, 60_000);

  it("a pairing code minted between the revoke's first void and its claim is voided by the second", async () => {
    const p = await person();
    const auth = makeAuthService(makeTestAuthDeps());
    // A first step of the user's, held: the revoke's first void waits on it with the pairing arm done.
    const [step] = await db().insert(loginTokens).values({
      userId: p.userId, tokenHash: hashToken(generateToken()), methods: [], purpose: "login",
      expiresAt: new Date(Date.now() + 5 * 60_000),
    }).returning();
    const tag = randomUUID().slice(0, 8);
    const [H, C, M] = [`rgr-hold-${tag}`, `rgr-revoke-${tag}`, `rgr-mint-${tag}`];
    const hold = named(H); const revoker = named(C); const minter = named(M);
    const parked = await holding(hold, [sql`select id from login_tokens where id = ${step!.id} for update`]);
    const revoke = settle(auth.revokeDevice(ctxOn(revoker.db, p, p.caller), p.other));
    expect(lockOf(await blockedOn(C, H, 10_000)), "the revoke is parked in its first void").toBe("UPDATE login_tokens");

    const minted = await settle(mintPairingToken(ctxOn(minter.db, p, p.other), { grant: "device-pair", label: "rg-race phone" }));
    parked.release();
    await parked.done;
    const r = await revoke;

    expect({ mint: answer(minted), revoke: answer(r) }).toEqual({ mint: "ok", revoke: "ok" });
    const token = minted.ok ? minted.v.token : "";
    const redeemed = await settle(redeemDevicePair(ctxOn(db(), p, null), auth, { token, kind: "mobile-android" }));
    expect(answer(redeemed), "a pairing code minted before the claim outlived the revoke").toBe("pairing_invalid");
    expect(await liveSessions(p.userId)).toEqual([p.caller]);
  }, 60_000);

  it("a desktop link written while its session is held FOR SHARE makes the claim wait, and is voided after it", async () => {
    const p = await person();
    const auth = makeAuthService(makeTestAuthDeps());
    const code = generateToken();
    const tag = randomUUID().slice(0, 8);
    const [H, C] = [`rgr-hold-${tag}`, `rgr-revoke-${tag}`];
    const hold = named(H); const revoker = named(C);
    // A mint's own shape, by hand: its session held FOR SHARE and its code written, not yet committed.
    const parked = await holding(hold, [
      sql`select id from sessions where id = ${p.other} for share`,
      sql`insert into login_tokens (user_id, token_hash, methods, purpose, expires_at)
        values (${p.userId}, ${hashToken(code)}, '[]'::jsonb, ${DESKTOP_LINK_PURPOSE}, ${new Date(Date.now() + 120_000).toISOString()}::timestamptz)`,
    ]);
    const revoke = settle(auth.logout(ctxOn(revoker.db, p, p.caller), { allDevices: true }));
    expect(lockOf(await blockedOn(C, H, 10_000)), "the sign-out waits at its session claim").toBe("sessions FOR UPDATE");

    parked.release();
    await parked.done;
    const r = await revoke;

    expect(answer(r)).toBe("ok");
    const claimed = await settle(auth.claimDesktopLink(ctxOn(db(), p, null), { code }));
    expect(answer(claimed), "a desktop link committed before the claim outlived the sign-out").toBe("invalid_code");
    expect(await liveSessions(p.userId)).toEqual([]);
  }, 60_000);

  /**
   * A DESKTOP LINK HOLDING ITS USER ROW MAKES THE REVOKE WAIT FOR IT WHOLE. The mint takes the row first
   * and asks its session last; the revoke takes the same row before its first void, so it never reaches
   * its claim or its second void while the mint stands between its supersede and its hold. The mint
   * commits, and the revoke's first void takes its code.
   */
  it("a desktop link holding its user row makes the revoke wait at that row, and the revoke takes its code", async () => {
    const p = await person();
    const auth = makeAuthService(makeTestAuthDeps());
    // A spent link of the user's, held: the mint's supersede deletes it, so the mint parks there,
    // past its user lock. The revoke's voids skip a spent row and never wait on it.
    const [spent] = await db().insert(loginTokens).values({
      userId: p.userId, tokenHash: hashToken(generateToken()), methods: [], purpose: DESKTOP_LINK_PURPOSE,
      expiresAt: new Date(Date.now() + 120_000), consumedAt: new Date(),
    }).returning();
    const tag = randomUUID().slice(0, 8);
    const [H, M, C] = [`rgr-hold-${tag}`, `rgr-mint-${tag}`, `rgr-revoke-${tag}`];
    const hold = named(H); const minter = named(M); const revoker = named(C);
    const parked = await holding(hold, [sql`select id from login_tokens where id = ${spent!.id} for update`]);
    const mint = settle(auth.issueDesktopLink(ctxOn(minter.db, p, p.other)));
    expect(lockOf(await blockedOn(M, H, 10_000)), "the mint is parked past its user lock").toBe("DELETE login_tokens");

    const revoke = settle(auth.logout(ctxOn(revoker.db, p, p.caller), { allDevices: true }));
    const waited = lockOf(await blockedOn(C, M, 10_000));
    parked.release();
    await parked.done;
    const [r, m] = await Promise.all([revoke, mint]);

    expect({ waited, revoke: answer(r), mint: answer(m) })
      .toEqual({ waited: "users FOR NO KEY UPDATE", revoke: "ok", mint: "ok" });
    const code = m.ok ? m.v.code : "";
    const claimed = await settle(auth.claimDesktopLink(ctxOn(db(), p, null), { code }));
    expect(answer(claimed), "a desktop link committed before the sign-out outlived it").toBe("invalid_code");
    expect(await liveLinks(p.userId)).toEqual([]);
    expect(await liveSessions(p.userId)).toEqual([]);
  }, 60_000);

  /**
   * TWO DESKTOP LINKS STRADDLING A REVOKE. A first link commits while the revoke is between its first
   * void and its claim; a second, from the session being revoked, supersedes it and asks its session
   * last. The revoke's second void then needed the row the second deleted while the second needed the
   * session the revoke claimed: a deadlock, the revoke as likely as the mint to be the one killed. With
   * the revoke holding its user row from before its first void, both links wait for it whole.
   */
  it("two desktop links straddling a device revoke wait for it whole: the second is refused, nothing deadlocks", async () => {
    const p = await person();
    const auth = makeAuthService(makeTestAuthDeps());
    const tag = randomUUID().slice(0, 8);
    const [H, C, A, B] = [`rgr-hold-${tag}`, `rgr-revoke-${tag}`, `rgr-mint-a-${tag}`, `rgr-mint-b-${tag}`];
    const hold = named(H); const revoker = named(C); const first = named(A); const second = named(B);
    // The revoke parked at its claim of the other session, its first void done.
    const parked = await holding(hold, [sql`select id from sessions where id = ${p.other} for update`]);
    const revoke = settle(auth.revokeDevice(ctxOn(revoker.db, p, p.caller), p.other));
    expect(lockOf(await blockedOn(C, H, 10_000)), "the revoke is parked at its claim").toBe("sessions FOR UPDATE");

    // A link by the caller, whom this revoke leaves signed in; then one by the session it takes back.
    let firstDone = false;
    const minted1 = settle(auth.issueDesktopLink(ctxOn(first.db, p, p.caller))).finally(() => { firstDone = true; });
    const firstWaited = lockOf(await waitingOn(A, 10_000, () => firstDone));
    const minted2 = settle(auth.issueDesktopLink(ctxOn(second.db, p, p.other)));
    expect(await waitingOn(B, 10_000), "the second link never waited").not.toBeNull();
    parked.release();
    await parked.done;
    const [r, m1, m2] = await Promise.all([revoke, minted1, minted2]);

    expect({ firstWaited, revoke: answer(r), first: answer(m1), second: answer(m2) }).toEqual({
      firstWaited: "users FOR NO KEY UPDATE", revoke: "ok", first: "ok", second: "unauthorized",
    });
    expect(await liveSessions(p.userId)).toEqual([p.caller]);
    expect((await liveLinks(p.userId)).length, "the caller's link is the one left").toBe(1);
  }, 60_000);

  /**
   * THE SAME RACE WITH NO HOLDERS: the session being taken back mints desktop links back to back, on
   * three connections, while the person takes it back. Before the revoke held its user row, a few in
   * every hundred of these revokes died 40P01 and left that session signed in.
   */
  const ROUNDS = 40;
  const BURST: Array<[string, (auth: ReturnType<typeof makeAuthService>, c: ServiceContext, p: Person) => Promise<unknown>]> = [
    ["revoking its device", (auth, c, p) => auth.revokeDevice(c, p.other)],
    ["signing out everywhere", (auth, c) => auth.logout(c, { allDevices: true })],
  ];
  for (const [door, run] of BURST) {
    it(`${door} while that session mints desktop links back to back never deadlocks`, async () => {
      const auth = makeAuthService(makeTestAuthDeps());
      const tag = randomUUID().slice(0, 8);
      const loops = [1, 2, 3].map((i) => named(`rgr-burst${i}-${tag}`));
      const revoker = named(`rgr-burst-revoke-${tag}`);
      const answers: Record<string, number> = {};
      const count = (k: string): void => { answers[k] = (answers[k] ?? 0) + 1; };
      let outlived = 0;
      for (let round = 0; round < ROUNDS; round++) {
        const p = await person();
        let stop = false;
        const minting = loops.map(async (h) => {
          while (!stop) {
            const m = await settle(auth.issueDesktopLink(ctxOn(h.db, p, p.other)));
            if (m.ok) continue;
            count(`mint ${answer(m)}`);
            if (answer(m) === "unauthorized") return;
          }
        });
        await sleep(5 + (round % 7) * 3);
        count(`revoke ${answer(await settle(run(auth, ctxOn(revoker.db, p, p.caller), p)))}`);
        stop = true;
        await Promise.all(minting);
        if ((await liveSessions(p.userId)).includes(p.other) || (await liveLinks(p.userId)).length > 0) outlived++;
      }
      // A mint refused 401 is the expected end of each loop; anything else is listed.
      const others = Object.fromEntries(Object.entries(answers).filter(([k]) => k !== "mint unauthorized"));
      expect({ ...others, outlived }, JSON.stringify(answers)).toEqual({ "revoke ok": ROUNDS, outlived: 0 });
    }, 180_000);
  }

  /*
   * A REDEEM SPENDING A GRANT WHILE A REVOKE RUNS. Each redeem burns its grant and writes its session
   * in one transaction. Held between the two, it makes the revoke's first void wait on the burned row;
   * it commits, and the revoke's claim takes the session it wrote. A redeem that committed its burn
   * alone left the void a spent row to skip and the claim no session to see, and its session outlived
   * the revoke. In the other order the revoke voided the grant first and holds it: the burn waits on
   * that row, and then finds the grant spent.
   */
  const PW = "pw-correct-horse-battery-password-password";
  const deps = makeTestAuthDeps();
  type Auth = ReturnType<typeof makeAuthService>;
  type Signer = Person & { secret: string; passkey: SoftwareAuthenticator | null };
  const s256 = (v: string): string => createHash("sha256").update(v).digest("base64url");

  /** A person who signs in: a password, an activated TOTP, and a passkey when one is asked for. */
  async function signer(withPasskey: boolean): Promise<Signer> {
    const p = await person();
    await db().insert(credentials).values({ userId: p.userId, passwordHash: await deps.passwordHasher.hash(PW), algo: "scrypt" });
    const secret = newTotpSecret();
    const { ciphertext, keyVersion } = await deps.keyProvider.encrypt(secret);
    await db().insert(totpSecrets).values({ userId: p.userId, secretEnc: ciphertext, keyVersion, activated: true });
    if (!withPasskey) return { ...p, secret, passkey: null };
    const auth = makeAuthService(deps);
    const ctx = ctxOn(db(), p, p.caller);
    const passkey = new SoftwareAuthenticator();
    const { options } = await auth.webauthnRegisterOptions(ctx);
    const credential = passkey.register({
      rpID: "localhost", challenge: (options as { challenge: string }).challenge, origin: "http://localhost:3000",
    });
    await auth.webauthnRegisterVerify(ctx, { credential, label: "Key" });
    return { ...p, secret, passkey };
  }

  /** Holds `establish` on `auth`: a redeem stops there with its grant burned and no session written. */
  function holdAtMint(auth: Auth): { at: Promise<void>; release: () => void } {
    const svc = auth as unknown as { establish: (...a: unknown[]) => Promise<unknown> };
    const mint = svc.establish;
    let open!: () => void; let reached!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const at = new Promise<void>((r) => { reached = r; });
    svc.establish = async function (this: unknown, ...a: unknown[]) { reached(); await gate; return mint.apply(this, a); };
    return { at, release: () => { delete (auth as unknown as { establish?: unknown }).establish; open(); } };
  }

  const firstStep = async (auth: Auth, p: Signer): Promise<string> =>
    ((await auth.login(ctxOn(db(), p, null), { email: p.email, password: PW })) as { loginToken: string }).loginToken;

  interface RedeemCase {
    redeem: string;
    door: string;
    passkey: boolean;
    /** Mints the grant from the other session, or takes the first step; answers the spend, on a handle. */
    arm: (auth: Auth, p: Signer) => Promise<(auth: Auth, handle: unknown) => Promise<unknown>>;
    revoke: (auth: Auth, c: ServiceContext) => Promise<unknown>;
    /** The sessions the door leaves. */
    keeps: (p: Signer) => string[];
    /** Where the revoke's first void waits on a held burn, and where a burn waits on a held void. */
    burnWait: string;
    voidWait: string;
    refusal: string;
  }

  const REDEEMS: RedeemCase[] = [
    {
      redeem: "a desktop link claim", door: "signing out everywhere", passkey: false,
      arm: async (auth, p) => {
        const { code } = await auth.issueDesktopLink(ctxOn(db(), p, p.other));
        return (a, handle) => a.claimDesktopLink(ctxOn(handle, p, null), { code });
      },
      revoke: (auth, c) => auth.logout(c, { allDevices: true }),
      keeps: () => [],
      burnWait: "UPDATE login_tokens", voidWait: "UPDATE login_tokens", refusal: "invalid_code",
    },
    {
      redeem: "an OAuth code exchange", door: "changing the password", passkey: false,
      arm: async (auth, p) => {
        const verifier = generateToken();
        const by = ctxOn(db(), p, p.other);
        const { request } = await auth.authorize(by, {
          response_type: "code", client_id: "tf-macos", redirect_uri: "trafficflow://auth",
          code_challenge: s256(verifier), code_challenge_method: `S${"256"}` as const, state: "s", scope: "full",
        });
        const code = new URL((await auth.approveAuthorize(by, { request })).redirect).searchParams.get("code")!;
        return (a, handle) => a.token(ctxOn(handle, p, null), {
          grant_type: "authorization_code", code, redirect_uri: "trafficflow://auth", client_id: "tf-macos", code_verifier: verifier,
        });
      },
      revoke: (auth, c) => auth.changePassword(c, { currentPassword: PW, newPassword: "new-battery-staple-horse-password" }),
      keeps: (p) => [p.caller],
      burnWait: "DELETE oauth_auth_codes", voidWait: "UPDATE oauth_auth_codes", refusal: "invalid_grant",
    },
    {
      redeem: "a TOTP sign-in", door: "signing out the other web sessions", passkey: false,
      arm: async (auth, p) => {
        const loginToken = await firstStep(auth, p);
        return (a, handle) => a.totpVerify(ctxOn(handle, p, null), { loginToken, code: totpNow(p.secret, new Date()) });
      },
      revoke: (auth, c) => auth.revokeWebSessions(c),
      keeps: (p) => [p.caller],
      burnWait: "UPDATE login_tokens", voidWait: "UPDATE login_tokens", refusal: "credential_refused",
    },
    {
      redeem: "a passkey sign-in", door: "removing the authenticator", passkey: true,
      arm: async (auth, p) => {
        const loginToken = await firstStep(auth, p);
        const { options } = await auth.webauthnAssertOptions(ctxOn(db(), p, null), { loginToken });
        const credential = p.passkey!.assert({
          rpID: "localhost", challenge: (options as { challenge: string }).challenge, origin: "http://localhost:3000",
        });
        return (a, handle) => a.webauthnAssertVerify(ctxOn(handle, p, null), { loginToken, credential });
      },
      revoke: (auth, c) => auth.totpRemove(c),
      keeps: (p) => [p.caller],
      burnWait: "UPDATE login_tokens", voidWait: "UPDATE login_tokens", refusal: "credential_refused",
    },
  ];

  for (const r of REDEEMS) {
    it(`${r.redeem} holding its burned grant makes ${r.door} wait at that row, and is signed out by it`, async () => {
      const p = await signer(r.passkey);
      const auth = makeAuthService(deps);
      const redeemer = makeAuthService(deps);
      const spend = await r.arm(auth, p);
      const tag = randomUUID().slice(0, 8);
      const [R, C] = [`rgr-redeem-${tag}`, `rgr-revoke-${tag}`];
      const redeemConn = named(R); const revoker = named(C);
      const held = holdAtMint(redeemer);
      const redeemed = settle(spend(redeemer, redeemConn.db));
      await held.at;

      // A redeem that committed its burn alone holds nothing: the revoke runs to its end here.
      let over = false;
      const revoke = settle(r.revoke(auth, ctxOn(revoker.db, p, p.caller))).finally(() => { over = true; });
      const waited = lockOf(await blockedOn(C, R, 10_000, () => over));
      held.release();
      const [rd, rv] = await Promise.all([redeemed, revoke]);

      const live = await liveSessions(p.userId);
      const outlived = live.filter((id) => !r.keeps(p).includes(id)).length;
      expect({ waited, redeem: answer(rd), revoke: answer(rv), outlived }, `the session ${r.redeem} wrote outlived ${r.door}`)
        .toEqual({ waited: r.burnWait, redeem: "ok", revoke: "ok", outlived: 0 });
      expect(live.sort()).toEqual(r.keeps(p).sort());
    }, 60_000);

    it(`${r.door} holding the grant it voided makes ${r.redeem} wait at its burn, and refuses it`, async () => {
      const p = await signer(r.passkey);
      const auth = makeAuthService(deps);
      const spend = await r.arm(auth, p);
      const tag = randomUUID().slice(0, 8);
      const [H, C, R] = [`rgr-hold-${tag}`, `rgr-revoke-${tag}`, `rgr-redeem-${tag}`];
      const hold = named(H); const revoker = named(C); const redeemConn = named(R);
      // The revoke parked at its claim, past its first void: the grant voided and its row held.
      const parked = await holding(hold, [sql`select id from sessions where id = ${p.other} for update`]);
      const revoke = settle(r.revoke(auth, ctxOn(revoker.db, p, p.caller)));
      expect(lockOf(await blockedOn(C, H, 10_000)), "the revoke is parked at its claim").toBe("sessions FOR UPDATE");

      const redeemed = settle(spend(auth, redeemConn.db));
      const waited = lockOf(await blockedOn(R, C, 10_000));
      parked.release();
      await parked.done;
      const [rv, rd] = await Promise.all([revoke, redeemed]);

      expect({ waited, revoke: answer(rv), redeem: answer(rd) }).toEqual({ waited: r.voidWait, revoke: "ok", redeem: r.refusal });
      // A code the revoke took issued nothing: refused, never read as a replay.
      expect(rd.ok ? null : rd.e).not.toBeInstanceOf(OAuthCodeReplayed);
      expect((await liveSessions(p.userId)).sort()).toEqual(r.keeps(p).sort());
    }, 60_000);
  }

  /**
   * THE REDEEM RACE WITH NO HOLDERS: the session being taken back links desktops and each desktop
   * claims its code, back to back on three connections, while the person signs out everywhere. A
   * claim whose burn committed alone could leave its session signed in after the sign-out.
   */
  it("signing out everywhere while that session links desktops that claim at once never deadlocks and leaves none signed in", async () => {
    const auth = makeAuthService(deps);
    const tag = randomUUID().slice(0, 8);
    const loops = [1, 2, 3].map((i) => named(`rgr-claim${i}-${tag}`));
    const revoker = named(`rgr-claim-revoke-${tag}`);
    const answers: Record<string, number> = {};
    const count = (k: string): void => { answers[k] = (answers[k] ?? 0) + 1; };
    let outlived = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const p = await person();
      let stop = false;
      const linking = loops.map(async (h) => {
        while (!stop) {
          const m = await settle(auth.issueDesktopLink(ctxOn(h.db, p, p.other)));
          if (!m.ok) {
            count(`mint ${answer(m)}`);
            if (answer(m) === "unauthorized") return;
            continue;
          }
          const c = await settle(auth.claimDesktopLink(ctxOn(h.db, p, null), { code: m.v.code }));
          if (!c.ok) count(`claim ${answer(c)}`);
        }
      });
      await sleep(5 + (round % 7) * 3);
      count(`revoke ${answer(await settle(auth.logout(ctxOn(revoker.db, p, p.caller), { allDevices: true })))}`);
      stop = true;
      await Promise.all(linking);
      if ((await liveSessions(p.userId)).length > 0) outlived++;
    }
    // A mint refused 401 ends a loop, and a code another loop's mint replaced or the sign-out voided
    // is refused: both expected. Anything else is listed.
    const others = Object.fromEntries(Object.entries(answers)
      .filter(([k]) => k !== "mint unauthorized" && k !== "claim invalid_code"));
    expect({ ...others, outlived }, JSON.stringify(answers)).toEqual({ "revoke ok": ROUNDS, outlived: 0 });
  }, 180_000);
});
