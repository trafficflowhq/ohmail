import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { generateSync } from "otplib";
import { accounts, refreshTokens, sessions, users, type Tx } from "@trafficflow/db";
import { authEvents, schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  AuthService, deleteAccount, hashToken, makeTestAuthDeps, reapStaleWebSessions, type ServiceContext,
} from "@trafficflow/services";

/**
 * EVERY WRITER OF SEVERAL SESSION ROWS TAKES THEM IN ID ORDER, the order erasure's step 7 locks an
 * account's sessions in. An UPDATE locks in scan order, so two of one account's sessions whose
 * scan order is the reverse of their id order deadlocked an erasure against the reaper (5 of 5,
 * as a verifier measured) and against the two mass sign-outs. A third connection holds the
 * lower id briefly so both parties queue on it; with one order, neither is a deadlock victim. The
 * two sign-outs now also open on the account row (the erasure fence), so here they queue behind
 * the erasure's first statement and answer "nothing revoked"; the reaper keeps the id order alone.
 */

const PG_UP = await realPgAvailable();
type Sql = ReturnType<typeof postgres>;
type Db = ReturnType<typeof drizzle<typeof schema>>;
type Settled<T> = { ok: true; v: T } | { ok: false; e: unknown };

let client: Sql;
let db: Db;
const extra: Sql[] = [];
let ipCell = 0;
let ip = "10.47.0.1";
const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({
  db, accountId: "", userId: null, now: () => new Date(), requestId: "k91", ip, ...over,
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const codeOf = (s: Settled<unknown>): string =>
  s.ok ? "ok" : String((s.e as { code?: unknown })?.code ?? (s.e as Error)?.message ?? s.e);

interface Person { userId: string; accountId: string; email: string; secret: string; t: Date }

async function establish(svc: AuthService): Promise<Person> {
  ip = `10.47.${(ipCell += 1)}.1`;
  const email = `k91-${randomUUID()}@lichtgrat.example`;
  let t = new Date();
  const at = (over: Partial<ServiceContext> = {}): ServiceContext => ctx({ now: () => t, ...over });
  const totp = (secret: string): string => generateSync({ secret, epoch: Math.floor(t.getTime() / 1000) });
  const registered = await svc.register(at(), { email, password: "pw-correct-horse-password-password", displayName: "Gil", inviteCode: "INVITE-OK" });
  if (registered.status !== "enrollment") throw new Error(`expected enrolment, got ${registered.status}`);
  const user = registered.user;
  const [latest] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, user.userId)).limit(1);
  const enrollCtx = at({ userId: user.userId, accountId: user.accountId, sessionId: latest!.id });
  const { secret } = await svc.totpEnroll(enrollCtx);
  await svc.totpActivate(enrollCtx, { code: totp(secret) });
  return { userId: user.userId, accountId: user.accountId, email, secret, t };
}

/** One more full sign-in, password and second factor, `offsetMs` after the person was made. */
async function signIn(svc: AuthService, p: Person, offsetMs: number): Promise<void> {
  const t = new Date(p.t.getTime() + offsetMs);
  const ch = await svc.login(ctx({ now: () => t }), { email: p.email, password: "pw-correct-horse-password-password" });
  if (ch.status !== "twofa_required") throw new Error(`expected 2FA, got ${ch.status}`);
  await svc.totpVerify(ctx({ now: () => t }), {
    loginToken: ch.loginToken, code: generateSync({ secret: p.secret, epoch: Math.floor(t.getTime() / 1000) }),
  });
}

function handle(app: string): Db {
  const base = postgres(PG_TEST_URL, { max: 2, onnotice: () => {}, connection: { application_name: app } });
  extra.push(base);
  return brandDialect(drizzle(base, { schema }), "pg");
}

/** Bounded: whether a backend named `app` is waiting on a heavyweight lock. */
async function waitsOnALock(app: string, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const rows = await client`select 1 from pg_stat_activity
      where datname = current_database() and application_name = ${app} and wait_event_type = 'Lock'`;
    if (rows.length > 0) return true;
    await sleep(20);
  }
  return false;
}

async function state(accountId: string) {
  const [acct] = await db.select({ erasedAt: accounts.erasedAt }).from(accounts).where(eq(accounts.id, accountId));
  return {
    erased: (acct?.erasedAt ?? null) !== null,
    sessions: (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountId, accountId))).length,
    tokens: (await db.select({ id: refreshTokens.id }).from(refreshTokens).where(eq(refreshTokens.accountId, accountId))).length,
    users: (await db.select({ id: users.id }).from(users).where(eq(users.accountId, accountId))).length,
    events: (await db.select({ id: authEvents.id }).from(authEvents).where(eq(authEvents.accountId, accountId))).length,
  };
}

/**
 * Live web sessions; the two lowest ids are the pair, put in REVERSE scan order by a non-HOT update
 * of the lower one (an indexed column changes, so every scan meets it after the higher); the
 * highest is the caller a mass sign-out spares. `writer` runs once the erasure waits, or first.
 */
async function race(stale: boolean, writer: (p: Person, caller: string, h: Db) => Promise<unknown>, writerFirst = false) {
  const svc = new AuthService(makeTestAuthDeps());
  const p = await establish(svc);
  for (const offset of [30_000, 90_000, 150_000]) await signIn(svc, p, offset);
  const ids = (await client`select id::text as id from sessions where account_id = ${p.accountId}
    and device_id is null and scope = 'full' and revoked_at is null order by id`).map((r) => (r as unknown as { id: string }).id);
  expect(ids.length, "at least three live web sessions").toBeGreaterThanOrEqual(3);
  const [lo, hi] = ids as [string, string];
  const caller = ids[ids.length - 1]!;
  // Idle 91 days: the cookie window, written in lockstep with last_seen_at, closed a day ago.
  if (stale) await client`update sessions set last_seen_at = now() - interval '91 days',
    refresh_expires_at = now() - interval '1 day' where id in (${lo}, ${hi})`;
  const scan = async () => (await client`select id::text as id from sessions where id in (${lo}, ${hi}) order by ctid`)
    .map((r) => (r as unknown as { id: string }).id);
  // A new version can take a freed slot ahead of `hi`, so the move is repeated until it lands after.
  for (let i = 0; i < 25 && (await scan())[0] !== hi; i++) {
    await client`update sessions set access_token_hash = access_token_hash || '-k91' where id = ${lo}`;
  }
  expect(await scan(), "the pair's scan order is the reverse of its id order").toEqual([hi, lo]);

  const holder = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
  extra.push(holder);
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => { locked = r; });
  const holding = holder.begin(async (tx) => {
    await tx`select id from sessions where id = ${lo} for update`;
    locked();
    await released;
  });
  await isLocked;
  const E = `k91-erasure-${randomUUID().slice(0, 8)}`;
  const W = `k91-writer-${randomUUID().slice(0, 8)}`;
  const erase = () => settle(deleteAccount({
    db: handle(E) as never, accountId: p.accountId, userId: p.userId, now: () => new Date(), requestId: `erase-${randomUUID()}`,
  }));
  const first = writerFirst ? settle(writer(p, caller, handle(W))) : erase();
  expect(await waitsOnALock(writerFirst ? W : E), "the first party queues on the held row").toBe(true);
  const second = writerFirst ? erase() : settle(writer(p, caller, handle(W)));
  expect(await waitsOnALock(writerFirst ? E : W), "the second queues too").toBe(true);
  const [erasure, write] = writerFirst ? [second, first] : [first, second];
  release();
  await holding;
  const [er, wr] = await Promise.all([erasure, write]);
  expect({ erasure: codeOf(er), writer: codeOf(wr) }, "one lock order: no deadlock victim (40P01) on either side")
    .toEqual({ erasure: "ok", writer: "ok" });
  expect(await state(p.accountId)).toEqual({ erased: true, sessions: 0, tokens: 0, users: 0, events: 0 });
}

describe.skipIf(!PG_UP)("an erasure against every writer of several session rows", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => {
    for (const c of extra) await c.end({ timeout: 5 }).catch(() => {});
    await client?.end({ timeout: 5 });
  });

  it("the reaper, over two stale web sessions", async () => {
    await race(true, (_p, _caller, h) => reapStaleWebSessions(h as unknown as Tx, new Date()));
  }, 60_000);

  it("the reaper first: its rows land under the session locks and the erasure takes them", async () => {
    await race(true, async (_p, _caller, h) => {
      expect((await reapStaleWebSessions(h as unknown as Tx, new Date())).reaped).toBe(2);
    }, true);
  }, 60_000);

  it("signing out every other web session", async () => {
    await race(false, (p, caller, h) => new AuthService(makeTestAuthDeps()).revokeWebSessions(
      ctx({ db: h as never, userId: p.userId, accountId: p.accountId, sessionId: caller, now: () => new Date(p.t.getTime() + 200_000) })));
  }, 60_000);

  it("signing out everywhere", async () => {
    await race(false, (p, caller, h) => new AuthService(makeTestAuthDeps()).logout(
      ctx({ db: h as never, userId: p.userId, accountId: p.accountId, sessionId: caller, now: () => new Date(p.t.getTime() + 200_000) }),
      { allDevices: true }));
  }, 60_000);
});
