import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  accounts, refreshTokens, sessions, users, ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS, UNMETERED_ACCESS,
  type EntitlementsPort,
} from "@trafficflow/db";
import { credentials, makeOwnedDb, recoveryCodes, totpSecrets, webauthnCredentials, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import {
  generateToken, hashToken, makeAuthService, makeTestAuthDeps, mintPairingToken, redeemDevicePair,
  type Db, type ServiceContext,
} from "@trafficflow/services";

/**
 * DELETE /account AGAINST EVERY SESSION WRITER THAT AUDITS. The erasure takes `accounts` first and
 * the sessions at step 7. Each writer below used to lock a session (or user) row and then audit,
 * which reads `accounts` FOR SHARE: a cycle, and Postgres killed one side (40P01). Every such
 * writer now opens its transaction on that account row (the fence), so it waits behind the
 * erasure's first statement and holds nothing the erasure needs. The erasure is paused on its own
 * thread-structure lock while holding the account row, the writer is seen waiting on that row, and
 * the pause ends at once or after the deadlock timeout. Each case asks: no deadlock victim, the
 * account erased, no auth row left from the race's address, and the writer's own answer.
 */

const PG_UP = await realPgAvailable();
const app = createApp(apiRoutes);
const owned: OwnedDb | null = PG_UP ? makeOwnedDb(PG_TEST_URL) : null;
const made: string[] = [];
const READINGS = process.env.FIX026_READINGS;

type Settled<T> = { ok: true; v: T } | { ok: false; e: unknown };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const db = (): Db => owned!.db as unknown as Db;

afterAll(async () => {
  if (!owned) return;
  for (const id of made) await owned.db.delete(accounts).where(eq(accounts.id, id)).catch(() => {});
  await owned.close();
});

/** A handle whose backends carry `app` as their application name, so each party can be watched. */
function named(app: string): OwnedDb {
  const u = new URL(PG_TEST_URL);
  u.searchParams.set("application_name", app);
  return makeOwnedDb(u.toString());
}

/** Every transaction the handle opens reports how it ended: a 40P01 a caller swallows is still read. */
function watched(o: OwnedDb, ended: string[]): OwnedDb {
  const h = o.db as unknown as { transaction: (fn: unknown, ...rest: unknown[]) => Promise<unknown> };
  const inner = h.transaction.bind(h);
  Object.defineProperty(h, "transaction", {
    configurable: true, writable: true,
    value: (fn: unknown, ...rest: unknown[]) => inner(fn, ...rest).catch((e: unknown) => { ended.push(codeOf(e)); throw e; }),
  });
  return o;
}

/** The statement a backend named `waiter` is blocked on, when a backend named `holder` blocks it. */
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

/** The lock a waiting statement asks for, in words, so a reading names the lock and not "a lock". */
function lockOf(q: string | null): string {
  if (q === null) return "never";
  if (/from "accounts".*for share/is.test(q)) return "accounts FOR SHARE";
  if (/^\s*update "accounts"/i.test(q)) return "UPDATE accounts";
  if (/from "sessions".*for update/is.test(q)) return "sessions FOR UPDATE";
  if (/^\s*update "refresh_tokens"/i.test(q)) return "UPDATE refresh_tokens";
  if (/^\s*delete from "users"/i.test(q)) return "DELETE users";
  if (/^\s*delete from "auth_events"/i.test(q)) return "DELETE auth_events";
  if (/^\s*delete from "login_tokens"/i.test(q)) return "DELETE login_tokens";
  return q.replace(/\s+/g, " ").slice(0, 80);
}

async function deadlocks(): Promise<number> {
  const rows = await db().execute(sql`select deadlocks::int as n from pg_stat_database where datname = current_database()`);
  return (rows as unknown as Array<{ n: number }>)[0]?.n ?? -1;
}

const codeOf = (e: unknown): string => {
  const x = e as { code?: unknown; cause?: { code?: unknown }; message?: unknown };
  return String(x?.code ?? x?.cause?.code ?? x?.message ?? e);
};

interface Person { accountId: string; userId: string; eraser: string; eraserSession: string }
interface Family { sessionId: string; familyId: string; refresh: string }

/** The race's own client address, so the auth rows it leaves behind can be counted. */
let scenarioIp = "10.26.0.1";

async function person(): Promise<Person> {
  const [a] = await db().insert(accounts).values({ name: "fix026" }).returning();
  made.push(a!.id);
  const [u] = await db().insert(users).values({ accountId: a!.id, email: `fix026-${randomUUID().slice(0, 8)}@erase.test` }).returning();
  const p = { accountId: a!.id, userId: u!.id, eraser: "", eraserSession: "" };
  const s = await signedIn(p);
  return { ...p, eraser: s.token, eraserSession: s.sessionId };
}

/** A full browser session with a fresh second factor: what DELETE /account is pressed from. */
async function signedIn(p: { accountId: string; userId: string }): Promise<{ token: string; sessionId: string }> {
  const token = generateToken();
  const now = Date.now();
  const [s] = await db().insert(sessions).values({
    accountId: p.accountId, userId: p.userId, familyId: randomUUID(), accessTokenHash: hashToken(token),
    accessExpiresAt: new Date(now + 10 * 60_000), refreshExpiresAt: new Date(now + 30 * 86_400_000),
    lastTwofaAt: new Date(now),
  }).returning();
  return { token, sessionId: s!.id };
}

/** One more device-less session with a live refresh token. */
async function family(p: Person, twofaAt: Date | null = null): Promise<Family> {
  const refresh = generateToken();
  const familyId = randomUUID();
  const now = Date.now();
  const [s] = await db().insert(sessions).values({
    accountId: p.accountId, userId: p.userId, familyId, accessTokenHash: hashToken(generateToken()),
    accessExpiresAt: new Date(now + 10 * 60_000), refreshExpiresAt: new Date(now + 30 * 86_400_000),
    lastTwofaAt: twofaAt,
  }).returning();
  await db().insert(refreshTokens).values({
    accountId: p.accountId, userId: p.userId, sessionId: s!.id, familyId,
    tokenHash: hashToken(refresh), expiresAt: new Date(now + 30 * 86_400_000), createdAt: new Date(now - 60 * 60_000),
  });
  return { sessionId: s!.id, familyId, refresh };
}

const auth = () => makeAuthService(makeTestAuthDeps());
const ctxOn = (handle: unknown, over: Partial<ServiceContext> = {}): ServiceContext => ({
  db: handle as never, accountId: "", userId: null, sessionId: null, now: () => new Date(),
  requestId: `fix026-${randomUUID()}`, ip: scenarioIp, ...over,
});
const at = (msAgo: number) => ({ now: () => new Date(Date.now() - msAgo) });

/** A metered host's port: it records every release and answers `cancelled`. */
function port(releases: string[]): EntitlementsPort {
  return {
    async access() { return UNMETERED_ACCESS; },
    async accessOrFault() { return UNMETERED_ACCESS; },
    async spend() { return { verdict: "fault" } as never; },
    async release() { return "settled" as never; },
    async manageLink() { return null; },
    async releaseAccount(accountId: string) { releases.push(accountId); return "cancelled"; },
  } as unknown as EntitlementsPort;
}

function routeDeps(handle: unknown, releases: string[]): ApiDeps {
  const authDeps = makeTestAuthDeps({});
  return {
    db: handle, now: () => new Date(), requestId: `fix026-${randomUUID()}`, session: null, idempotency: null,
    authConfig: authDeps.config, keyProvider: authDeps.keyProvider,
    services: { auth: makeAuthService(authDeps), entitlementsPort: port(releases) },
  } as unknown as ApiDeps;
}

const erase = (token: string, deps: ApiDeps): Promise<Response> => app.handle(new Request("http://localhost/account", {
  method: "DELETE", headers: { authorization: `Bearer ${token}` },
}), deps);

async function said(res: Response): Promise<string> {
  const b = await res.clone().json().catch(() => ({})) as { erased?: boolean; subscription?: string; error?: { code?: string } };
  return `${res.status} ${b.error?.code ?? (b.erased ? "erased" : "?")}${b.subscription ? ` ${b.subscription}` : ""}`;
}

async function count(q: ReturnType<typeof sql>): Promise<number> {
  return ((await db().execute(q)) as unknown as Array<{ n: number }>)[0]?.n ?? -1;
}

async function state(p: Person) {
  const [a] = await db().select({ erasedAt: accounts.erasedAt }).from(accounts).where(eq(accounts.id, p.accountId));
  return {
    erased: (a?.erasedAt ?? null) !== null,
    users: (await db().select({ id: users.id }).from(users).where(eq(users.accountId, p.accountId))).length,
    liveSessions: (await db().select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.accountId, p.accountId), isNull(sessions.revokedAt)))).length,
    // Rows from the race's address that outlived the erasure: the person's IP with no account on it.
    anonymousRowsAfter: await count(sql`select count(*)::int as n from auth_events where ip = ${scenarioIp} and account_id is null`),
    ipRowsAfter: await count(sql`select count(*)::int as n from auth_events where ip = ${scenarioIp}`),
  };
}

type Order = "erasure waits last" | "writer waits last";
let lastDeadlocks = 0;
type Arm = (p: Person) => Promise<(handle: unknown) => Promise<unknown>>;

interface Reading {
  writer: string; order: Order; route: string; releases: number; writerAnswer: string; writerMessage: string | null;
  writerWaitedOn: string; erasureWaitedOn: string; deadlocks: number; victims: string[];
  /** The writer's transactions that met the stamp: the arm that met it answers, nothing falls through. */
  refusedByFence: number;
  erased: boolean; users: number; liveSessions: number; anonymousRowsAfter: number; ipRowsAfter: number; retry?: string;
}

/**
 * One race. `audits` false is the hot-path control: that writer never waits on the erasure, so it
 * is let finish before the pause ends. The retry is the person pressing again after a refusal,
 * from the same session when it is still live and from a fresh sign-in when the writer took it.
 */
async function race(writer: string, arm: Arm, order: Order, audits = true): Promise<Reading> {
  scenarioIp = `10.${26 + Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  const p = await person();
  const run = await arm(p);
  const tag = randomUUID().slice(0, 8);
  const [H, E, W] = [`fix026-hold-${tag}`, `fix026-erase-${tag}`, `fix026-write-${tag}`];
  const erEnded: string[] = []; const wrEnded: string[] = [];
  const hold = named(H); const er = watched(named(E), erEnded); const wr = watched(named(W), wrEnded);
  const before = await deadlocks();
  const releases: string[] = [];
  try {
    let release!: () => void; let locked!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holding = hold.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS}, hashtext(${p.accountId}))`);
      locked();
      await released;
    });
    await isLocked;
    const route = settle(erase(p.eraser, routeDeps(er.db, releases)));
    expect(await blockedOn(E, H, 10_000), "the erasure holds the account row and waits on the pause").not.toBeNull();
    const write = settle(run(wr.db));
    const writerQ = audits ? await blockedOn(W, E, 10_000) : null;
    if (!audits) await write;
    if (order === "erasure waits last") await sleep(1_500);
    release();
    await holding;
    const erasureQ = await blockedOn(E, W, 3_000);
    const [r, w] = await Promise.all([route, write]);
    const reading: Reading = {
      writer, order, route: r.ok ? await said(r.v) : `threw ${codeOf(r.e)}`, releases: releases.length,
      writerAnswer: w.ok ? "ok" : codeOf(w.e), writerMessage: w.ok ? null : String((w.e as Error)?.message ?? w.e),
      writerWaitedOn: lockOf(writerQ), erasureWaitedOn: lockOf(erasureQ), deadlocks: 0,
      victims: [...(erEnded.includes("40P01") ? ["erasure"] : []), ...(wrEnded.includes("40P01") ? ["writer"] : [])],
      refusedByFence: wrEnded.filter((c) => c === "account_erased").length,
      ...(await state(p)),
    };
    if (!reading.erased) {
      const [d] = await db().select({ revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.id, p.eraserSession));
      const token = d && d.revokedAt === null ? p.eraser : (await signedIn(p)).token;
      const again = await erase(token, routeDeps(owned!.db, releases));
      reading.retry = `${await said(again)} from ${token === p.eraser ? "the same session" : "a new sign-in"}, releases ${releases.length}, erased ${(await state(p)).erased}`;
    }
    return reading;
  } finally {
    await Promise.all([hold.close(), er.close(), wr.close()]);
    const end = Date.now() + 2_000;
    let after = await deadlocks();
    while (after === before && Date.now() < end) { await sleep(100); after = await deadlocks(); }
    lastDeadlocks = after - before;
  }
}

async function measured(writer: string, arm: Arm, order: Order, audits = true): Promise<Reading> {
  const reading = await race(writer, arm, order, audits);
  reading.deadlocks = lastDeadlocks;
  if (READINGS) appendFileSync(READINGS, `${JSON.stringify(reading)}\n`);
  return reading;
}

/** Present a token the arm's setup already rotated once, on the arm's surface. */
const presentAgain = (f: Family, opts: { grace: boolean; attemptId?: string }) => (h: unknown) =>
  auth().refresh(ctxOn(h), { refreshToken: f.refresh, ...(opts.attemptId ? { attemptId: opts.attemptId } : {}) },
    opts.grace ? { concurrentGrace: true, surface: "cookie" } : {});

/** The writer's answer, by class: a mint refuses, a reducer finds nothing to do. */
type Expected = "ok" | { code: string; message?: string };
const REVOKED: Expected = { code: "refresh_revoked", message: "invalid refresh token" };
const ERASED: Expected = { code: "account_erased" };

const WRITERS: Array<[string, Arm, Expected]> = [
  ["convergeGrace (a cookie renewal inside the grace window)", async (p) => {
    const f = await family(p);
    await auth().refresh(ctxOn(db(), at(1_000)), { refreshToken: f.refresh }, { concurrentGrace: true, surface: "cookie" });
    return presentAgain(f, { grace: true });
  }, REVOKED],
  ["replayRotation (a retried attempt whose answer was lost)", async (p) => {
    const f = await family(p);
    await auth().refresh(ctxOn(db(), at(1_000)), { refreshToken: f.refresh, attemptId: "fix026-attempt" }, {});
    return presentAgain(f, { grace: false, attemptId: "fix026-attempt" });
  }, REVOKED],
  ["recoverLostRotation (a stale cookie after a lost answer)", async (p) => {
    const f = await family(p);
    await auth().refresh(ctxOn(db(), at(16 * 60_000)), { refreshToken: f.refresh }, { concurrentGrace: true, surface: "cookie" });
    return presentAgain(f, { grace: true });
  }, REVOKED],
  ["sweepFamily (a spent token presented again)", async (p) => {
    const f = await family(p);
    await auth().refresh(ctxOn(db(), at(1_000)), { refreshToken: f.refresh }, {});
    return presentAgain(f, { grace: false });
  }, REVOKED],
  ["revokeClaimedSessions (sign out every other web session)", async (p) => {
    const caller = await family(p, new Date());
    await family(p);
    return (h) => auth().revokeWebSessions(ctxOn(h, { userId: p.userId, accountId: p.accountId, sessionId: caller.sessionId }));
  }, "ok"],
  ["logout, every device (hosted)", async (p) => {
    const caller = await family(p, new Date());
    return (h) => auth().logout(ctxOn(h, { userId: p.userId, accountId: p.accountId, sessionId: caller.sessionId }), { allDevices: true });
  }, "ok"],
  ["logout, this session (hosted)", async (p) => {
    const caller = await family(p);
    return (h) => auth().logout(ctxOn(h, { userId: p.userId, accountId: p.accountId, sessionId: caller.sessionId }), {});
  }, "ok"],
  ["logout by refresh token (the web's sign-out)", async (p) => {
    const f = await family(p);
    return (h) => auth().logout(ctxOn(h), { refreshToken: f.refresh });
  }, "ok"],
  ["issueDesktopLink (locks the user row, then audits)", async (p) => {
    return (h) => auth().issueDesktopLink(ctxOn(h, { userId: p.userId, accountId: p.accountId }));
  }, ERASED],
  ["claimDesktopApproval (burns a confirmed approval, then mints)", async (p) => {
    const verifier = generateToken();
    const { approvalId } = await auth().issueDesktopApproval(ctxOn(db()), { challenge: hashToken(verifier), label: "fix026" });
    await auth().confirmDesktopApproval(ctxOn(db(), { userId: p.userId, accountId: p.accountId, sessionId: p.eraserSession }), approvalId);
    return (h) => auth().claimDesktopApproval(ctxOn(h), { approvalId, verifier });
  }, ERASED],
  ["redeemDevicePair (burns a pairing token, then mints)", async (p) => {
    const minted = await mintPairingToken(ctxOn(db(), { userId: p.userId, accountId: p.accountId }), { grant: "device-pair", label: "fix026 phone" });
    return (h) => redeemDevicePair(ctxOn(h), auth(), { token: minted.token, kind: "mobile-android" });
  }, ERASED],
  ["changePassword (rewrites the credential, voids pending grants, signs every other session out)", async (p) => {
    await withPassword(p);
    const caller = await family(p, new Date());
    return (h) => auth().changePassword(ctxOn(h, { userId: p.userId, accountId: p.accountId, sessionId: caller.sessionId }),
      { currentPassword: PASSWORD, newPassword: `${PASSWORD}-next` });
  }, "ok"],
];

function answered(r: Reading): Expected {
  if (r.writerAnswer === "ok") return "ok";
  return r.writerMessage !== null && r.writerAnswer === "refresh_revoked"
    ? { code: r.writerAnswer, message: r.writerMessage } : { code: r.writerAnswer };
}

describe.skipIf(!PG_UP)("DELETE /account against a session writer that audits", () => {
  it("CONTROL: the pause alone, with no writer, erases", async () => {
    const r = await measured("no writer", async () => async () => undefined, "erasure waits last", false);
    expect({ route: r.route, erased: r.erased, releases: r.releases, victims: r.victims })
      .toEqual({ route: "200 erased cancelled", erased: true, releases: 1, victims: [] });
  }, 60_000);

  it("CONTROL: the hot-path renewal never waits on the erasure and both commit", async () => {
    const r = await measured("hot path (a live token renewed)", async (p) => {
      const f = await family(p);
      return (h) => auth().refresh(ctxOn(h), { refreshToken: f.refresh }, { concurrentGrace: true, surface: "cookie" });
    }, "erasure waits last", false);
    expect({ route: r.route, writer: r.writerAnswer, waited: r.writerWaitedOn, erased: r.erased, victims: r.victims })
      .toEqual({ route: "200 erased cancelled", writer: "ok", waited: "never", erased: true, victims: [] });
  }, 60_000);

  for (const [writer, arm, expected] of WRITERS) {
    for (const order of ["erasure waits last", "writer waits last"] as const) {
      it(`${writer} — ${order}`, async () => {
        const r = await measured(writer, arm, order);
        expect(r.writerWaitedOn, "the writer waited on the erasure's account row").toBe("accounts FOR SHARE");
        expect({
          route: r.route, victims: r.victims, erased: r.erased, liveSessions: r.liveSessions,
          anonymousRowsAfter: r.anonymousRowsAfter, ipRowsAfter: r.ipRowsAfter, writer: answered(r),
          refusedByFence: r.refusedByFence,
        }, `reading: ${JSON.stringify(r)}`).toEqual({
          route: "200 erased cancelled", victims: [], erased: true, liveSessions: 0,
          anonymousRowsAfter: 0, ipRowsAfter: 0, writer: expected,
          // A refusal is met once, by the arm that took the fence; a reducer finds nothing to do.
          refusedByFence: expected === "ok" ? 0 : 1,
        });
        // The refresh door never names theft for an account that is gone.
        expect(r.writerMessage ?? "").not.toMatch(/reuse/i);
      }, 60_000);
    }
  }

  /**
   * THE OTHER ORDER: the writer's fence first. A real convergence is paused after its fence by a
   * third connection holding the family's live tail; the erasure then waits at its own first
   * statement on the writer's share lock, the writer mints and commits, and the erasure takes what
   * it minted: the new token's hash is kept as an erased bearer and no session or token survives.
   */
  it("CONTROL: a writer whose fence came first commits its mint, and the erasure takes it", async () => {
    scenarioIp = `10.25.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
    const p = await person();
    const f = await family(p);
    await auth().refresh(ctxOn(db(), at(1_000)), { refreshToken: f.refresh }, { concurrentGrace: true, surface: "cookie" });
    const tag = randomUUID().slice(0, 8);
    const [H, E, W] = [`fix026-tail-${tag}`, `fix026-erase-${tag}`, `fix026-write-${tag}`];
    const erEnded: string[] = []; const wrEnded: string[] = [];
    const hold = named(H); const er = watched(named(E), erEnded); const wr = watched(named(W), wrEnded);
    const releases: string[] = [];
    try {
      let release!: () => void; let locked!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      const isLocked = new Promise<void>((r) => { locked = r; });
      const holding = hold.db.transaction(async (tx) => {
        await tx.execute(sql`select id from refresh_tokens where family_id = ${f.familyId}
          and consumed_at is null and revoked_at is null for update`);
        locked();
        await released;
      });
      await isLocked;
      const write = settle(presentAgain(f, { grace: true })(wr.db));
      expect(lockOf(await blockedOn(W, H, 10_000)), "the writer is past its fence, at the tail").toBe("UPDATE refresh_tokens");
      const route = settle(erase(p.eraser, routeDeps(er.db, releases)));
      expect(lockOf(await blockedOn(E, W, 10_000)), "the erasure waits at its first statement").toBe("UPDATE accounts");
      release();
      await holding;
      const [r, w] = await Promise.all([route, write]);
      const minted = w.ok ? (w.v as { tokens?: { refreshToken: string } }).tokens?.refreshToken : undefined;
      const kept = minted === undefined ? -1
        : await count(sql`select count(*)::int as n from erased_bearers where token_hash = ${hashToken(minted)}`);
      const reading = {
        route: r.ok ? await said(r.v) : `threw ${codeOf(r.e)}`, writer: w.ok ? "ok" : codeOf(w.e),
        victims: [...(erEnded.includes("40P01") ? ["erasure"] : []), ...(wrEnded.includes("40P01") ? ["writer"] : [])],
        erased: (await state(p)).erased,
        sessions: await count(sql`select count(*)::int as n from sessions where account_id = ${p.accountId}`),
        tokens: await count(sql`select count(*)::int as n from refresh_tokens where account_id = ${p.accountId}`),
        mintedKept: kept, ipRowsAfter: (await state(p)).ipRowsAfter,
      };
      if (READINGS) appendFileSync(READINGS, `${JSON.stringify({ ...reading, case: "writer-first control" })}\n`);
      expect(reading).toEqual({
        route: "200 erased cancelled", writer: "ok", victims: [], erased: true, sessions: 0, tokens: 0,
        mintedKept: 1, ipRowsAfter: 0,
      });
    } finally {
      await Promise.all([hold.close(), er.close(), wr.close()]);
    }
  }, 60_000);
});

/**
 * THE ERASURE PARKED BEFORE `DELETE users`: a third connection holds one of the account's
 * `auth_events` rows, so the erasure has deleted every credential table and waits at its last
 * statement before the users delete. A writer that lands a row keyed to the user in that window
 * makes `DELETE users` refuse (23503), or, over a row the erasure already deleted while it holds
 * `users`, makes the erasure a deadlock victim (40P01); either way after the subscription release.
 * Each writer here opens on the account row now, waits behind the erasure and is refused.
 */
interface Parked { label: string; route: string; erasureEnded: string[]; writer: string; writerWaitedOn: string; erased: boolean }
type ParkWriter = (h: unknown, p: Person, prior: Record<string, string>) => Promise<unknown>;
type ParkPrior = (p: Person) => Promise<Record<string, string>>;
const PASSWORD = "pw-correct-horse-battery-password-password";
const none: ParkPrior = async () => ({});

async function parked(label: string, prior: ParkPrior, writer: ParkWriter): Promise<Parked> {
  scenarioIp = `10.${26 + Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  const p = await person();
  await db().execute(sql`insert into auth_events (account_id, user_id, event, ip) values (${p.accountId}, ${p.userId}, 'login', '10.25.0.1')`);
  const before = await prior(p);
  const tag = randomUUID().slice(0, 8);
  const [H, E, W] = [`fix026-park-${tag}`, `fix026-erase-${tag}`, `fix026-write-${tag}`];
  const erEnded: string[] = []; const wrEnded: string[] = [];
  const hold = named(H); const er = watched(named(E), erEnded); const wr = watched(named(W), wrEnded);
  const releases: string[] = [];
  try {
    let release!: () => void; let locked!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holding = hold.db.transaction(async (tx) => {
      await tx.execute(sql`select id from auth_events where account_id = ${p.accountId} limit 1 for update`);
      locked();
      await released;
    });
    await isLocked;
    const route = settle(erase(p.eraser, routeDeps(er.db, releases)));
    expect(lockOf(await blockedOn(E, H, 15_000)), "the erasure is parked at its last statement before DELETE users")
      .toBe("DELETE auth_events");
    const write = settle(writer(wr.db, p, before));
    const early = await Promise.race([write.then(() => true), sleep(3_000).then(() => false)]);
    const writerWaitedOn = early ? "never" : lockOf(await blockedOn(W, E, 5_000));
    if (!early) await sleep(1_500);
    release();
    await holding;
    const [r, w] = await Promise.all([route, write]);
    const reading: Parked = {
      label, route: r.ok ? await said(r.v) : `threw ${codeOf(r.e)}`, erasureEnded: erEnded,
      writer: w.ok ? "ok" : codeOf(w.e), writerWaitedOn, erased: (await state(p)).erased,
    };
    if (READINGS) appendFileSync(READINGS, `${JSON.stringify({ ...reading, case: "parked before DELETE users" })}\n`);
    return reading;
  } finally {
    await Promise.all([hold.close(), er.close(), wr.close()]);
  }
}

const asUser = (h: unknown, p: Person): ServiceContext =>
  ctxOn(h, { userId: p.userId, accountId: p.accountId, sessionId: p.eraserSession });
const authorizeQuery = () => ({ client_id: "tf-macos", redirect_uri: "trafficflow://auth", code_challenge: "A".repeat(43),
  code_challenge_method: "S" + "256", state: "fix026" }) as never;
const withPassword: ParkPrior = async (p) => {
  await db().insert(credentials).values({ userId: p.userId, passwordHash: await makeTestAuthDeps().passwordHasher.hash(PASSWORD), algo: "scrypt" });
  return {};
};
const emailOf = async (p: Person): Promise<string> =>
  (await db().select({ email: users.email }).from(users).where(eq(users.id, p.userId)))[0]!.email;
const approval: ParkPrior = async () => {
  const { approvalId } = await auth().issueDesktopApproval(ctxOn(db()), { challenge: hashToken(generateToken()), label: "fix026" });
  return { approvalId };
};

const PARKED: Array<[string, ParkPrior, ParkWriter, string]> = [
  ["issueDesktopLink (CONTROL: fenced in round 1)", none, (h, p) => auth().issueDesktopLink(asUser(h, p)), "account_erased"],
  ["generateRecoveryCodes, no prior codes", none, (h, p) => auth().generateRecoveryCodes(asUser(h, p)), "account_erased"],
  ["generateRecoveryCodes, over existing codes", async (p) => {
    const batchId = randomUUID();
    for (let i = 0; i < 3; i++) await db().insert(recoveryCodes).values({ userId: p.userId, codeHash: hashToken(generateToken()), batchId });
    return {};
  }, (h, p) => auth().generateRecoveryCodes(asUser(h, p)), "account_erased"],
  ["totpEnroll, no prior secret", none, (h, p) => auth().totpEnroll(asUser(h, p)), "account_erased"],
  ["authorize, no prior request", none, (h, p) => auth().authorize(asUser(h, p), authorizeQuery()), "account_erased"],
  ["authorize, over a prior request", async (p) => {
    await auth().authorize(asUser(db(), p), authorizeQuery());
    return {};
  }, (h, p) => auth().authorize(asUser(h, p), authorizeQuery()), "account_erased"],
  ["confirmDesktopApproval (binds an approval to the user)", approval,
    (h, p, b) => auth().confirmDesktopApproval(asUser(h, p), b.approvalId!), "account_erased"],
  ["denyDesktopApproval (binds an approval to the user)", approval,
    (h, p, b) => auth().denyDesktopApproval(asUser(h, p), b.approvalId!), "account_erased"],
  ["login, no factor (the enrollment session)", withPassword,
    async (h, p) => auth().login(ctxOn(h), { email: await emailOf(p), password: PASSWORD }), "credential_refused"],
  ["login, a factor enrolled (the login token)", async (p) => {
    await withPassword(p);
    const { ciphertext, keyVersion } = await makeTestAuthDeps().keyProvider.encrypt("JBSWY3DPEHPK3PXP");
    await db().insert(totpSecrets).values({ userId: p.userId, secretEnc: ciphertext, keyVersion, activated: true });
    return {};
  }, async (h, p) => auth().login(ctxOn(h), { email: await emailOf(p), password: PASSWORD }), "credential_refused"],
  ["webauthnRegisterOptions (the registration challenge)", none,
    (h, p) => auth().webauthnRegisterOptions(asUser(h, p)), "account_erased"],
  ["stepUpWebauthnOptions (the step-up challenge)", async (p) => {
    await db().insert(webauthnCredentials).values({ userId: p.userId, credentialId: `fix026-${randomUUID()}`, publicKey: "AAAA" });
    return {};
  }, (h, p) => auth().stepUpWebauthnOptions(asUser(h, p)), "account_erased"],
];

describe.skipIf(!PG_UP)("DELETE /account parked before DELETE users, against a writer of a row keyed to the user", () => {
  for (const [label, prior, writer, refused] of PARKED) {
    it(label, async () => {
      const r = await parked(label, prior, writer);
      expect({ route: r.route, erased: r.erased, erasureEnded: r.erasureEnded, writer: r.writer }, `reading: ${JSON.stringify(r)}`)
        .toEqual({ route: "200 erased cancelled", erased: true, erasureEnded: [], writer: refused });
    }, 60_000);
  }
});
