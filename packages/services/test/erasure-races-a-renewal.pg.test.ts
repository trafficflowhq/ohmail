import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, inArray } from "drizzle-orm";
import { generateSync } from "otplib";
import { accounts, refreshTokens, sessions, users } from "@trafficflow/db";
import { erasedBearers, schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { AuthService, deleteAccount, hashToken, makeTestAuthDeps, type ServiceContext } from "@trafficflow/services";

/*
 * AN ERASURE RACING A RENEWAL OF THE SAME ACCOUNT ERASES IT, whichever waits first. A renewal locks
 * its session row and then its token; erasure's step 7 used to delete tokens and then sessions, so
 * the two could deadlock (the erasure the victim when it waited first) or the renewal could commit
 * a successor behind the token delete's snapshot (23503 on the session delete). Erasure now locks
 * the account's session rows first. Each timing ends erased, with nothing left to present and the
 * renewal's successor recorded as erased. Waits are READ from pg_stat_activity, never slept.
 */
const PG_UP = await realPgAvailable();
type Sql = ReturnType<typeof postgres>;
type Db = ReturnType<typeof drizzle<typeof schema>>;
type Settled<T> = { ok: true; v: T } | { ok: false; e: unknown };

let client: Sql;
let db: Db;
const extra: Sql[] = [];
let ipCell = 0;
let ip = "10.41.0.1";
const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({
  db, accountId: "", userId: null, now: () => new Date(), requestId: "erasure-race-pg", ip, ...over,
});
const native = { surface: "native" } as const;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const settle = <T>(p: Promise<T>): Promise<Settled<T>> => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
/** The refusal's code for the assertion's message: 40P01, 23503, or whatever else it was. */
const why = (s: Settled<unknown>): string => (s.ok ? "" : ` — refused ${String((s.e as { code?: unknown })?.code ?? s.e)}`);

async function establish(svc: AuthService, email: string): Promise<{ userId: string; accountId: string; r1: string }> {
  ip = `10.41.${(ipCell += 1)}.1`;
  let t = new Date();
  const at = (over: Partial<ServiceContext> = {}): ServiceContext => ctx({ now: () => t, ...over });
  const totp = (secret: string): string => generateSync({ secret, epoch: Math.floor(t.getTime() / 1000) });
  const registered = await svc.register(at(), {
    email, password: "account-signin-password", displayName: "Gil", inviteCode: "INVITE-OK",
  });
  if (registered.status !== "enrollment") throw new Error(`expected an enrolment session, got ${registered.status}`);
  const user = registered.user;
  const [latest] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, user.userId)).limit(1);
  const enrollCtx = at({ userId: user.userId, accountId: user.accountId, sessionId: latest!.id });
  const { secret } = await svc.totpEnroll(enrollCtx);
  await svc.totpActivate(enrollCtx, { code: totp(secret) });
  t = new Date(t.getTime() + 30_000);
  const ch = await svc.login(at(), { email, password: "account-signin-password" });
  if (ch.status !== "twofa_required") throw new Error(`expected a 2FA challenge, got ${ch.status}`);
  const est = await svc.totpVerify(at(), { loginToken: ch.loginToken, code: totp(secret) });
  return { userId: user.userId, accountId: user.accountId, r1: est.tokens!.refreshToken };
}

/*
 * A HANDLE OF ITS OWN, named in pg_stat_activity, whose first statement matching `pattern` (inside a
 * transaction too) is held until `open()`; `reached` resolves when it arrives. No pattern, no hold.
 */
function party(app: string, pattern?: RegExp): { db: Db; reached: Promise<void>; open: () => void } {
  const base = postgres(PG_TEST_URL, { max: 2, onnotice: () => {}, connection: { application_name: app } });
  extra.push(base);
  let hit = false;
  let arrive!: () => void;
  const reached = new Promise<void>((r) => { arrive = r; });
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const wrap = (sql: Sql): Sql => new Proxy(sql, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop === "unsafe") {
        return (text: string, params?: unknown[], opts?: unknown) => {
          const make = () => (value as (...a: unknown[]) => { values: () => Promise<unknown> } & PromiseLike<unknown>)
            .call(target, text, params, opts);
          if (hit || !pattern?.test(text)) return make();
          hit = true;
          arrive();
          return {
            values: () => gate.then(() => make().values()),
            then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => gate.then(() => make()).then(ok, bad),
          };
        };
      }
      if (prop === "begin" || prop === "savepoint") {
        return (...args: unknown[]) => {
          const fn = args[args.length - 1] as (s: Sql) => unknown;
          return (value as (...a: unknown[]) => unknown).apply(target, [...args.slice(0, -1), (inner: Sql) => fn(wrap(inner))]);
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: brandDialect(drizzle(wrap(base), { schema }), "pg"), reached, open };
}

/** Poll, bounded, until a backend named `app` in this database waits on a lock: a reading, not a sleep. */
async function blockedOnALock(app: string, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const [row] = await client`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and application_name = ${app} and wait_event_type = 'Lock'`;
    if ((row as { n: number }).n > 0) return true;
    await sleep(20);
  }
  return false;
}

const erase = (accountId: string, userId: string, handle: Db) => deleteAccount({
  db: handle as never, accountId, userId, now: () => new Date(), requestId: `erase-${randomUUID()}`,
});

/** The whole erased state: the account stamped, no session, token or user left, the successor recorded. */
async function expectErasedWhole(accountId: string, minted: { accessToken: string; refreshToken: string } | null) {
  const [acct] = await db.select({ erasedAt: accounts.erasedAt }).from(accounts).where(eq(accounts.id, accountId));
  expect(acct?.erasedAt ?? null, "the erasure committed").not.toBeNull();
  expect(await db.select().from(sessions).where(eq(sessions.accountId, accountId)), "no session left").toHaveLength(0);
  expect(await db.select().from(refreshTokens).where(eq(refreshTokens.accountId, accountId)), "no token left").toHaveLength(0);
  expect(await db.select().from(users).where(eq(users.accountId, accountId)), "no user left").toHaveLength(0);
  if (minted) {
    const kept = await db.select({ tokenHash: erasedBearers.tokenHash }).from(erasedBearers)
      .where(inArray(erasedBearers.tokenHash, [hashToken(minted.refreshToken), hashToken(minted.accessToken)]));
    expect(kept, "the renewal's successor is told the account was erased").toHaveLength(2);
  }
}

describe.skipIf(!PG_UP)("an erasure racing a renewal of the same account", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => {
    for (const c of extra) await c.end({ timeout: 5 }).catch(() => {});
    await client?.end({ timeout: 5 });
  });

  it("control: an erasure alone erases the account whole", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, accountId } = await establish(svc, `erase-ctl-${randomUUID()}@lichtgrat.example`);
    await erase(accountId, userId, db);
    await expectErasedWhole(accountId, null);
  }, 60_000);

  it("the renewal waits first: the erasure commits and the renewal is refused", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, accountId, r1 } = await establish(svc, `erase-d1-${randomUUID()}@lichtgrat.example`);
    const e = party(`erase-d1-e-${randomUUID().slice(0, 8)}`, /^delete from "sessions"/i);
    const renewer = `erase-d1-r-${randomUUID().slice(0, 8)}`;
    const erasure = settle(erase(accountId, userId, e.db));
    await e.reached;
    const renewal = settle(svc.refresh(ctx({ db: party(renewer).db }), { refreshToken: r1, attemptId: `r${randomUUID()}` }, native));
    expect(await blockedOnALock(renewer), "the renewal waits on the erasure").toBe(true);
    e.open();
    const [er, rn] = await Promise.all([erasure, renewal]);
    expect(er.ok, `the erasure succeeded on its first attempt${why(er)}`).toBe(true);
    expect(rn.ok, "the renewal was refused").toBe(false);
    await expectErasedWhole(accountId, null);
  }, 60_000);

  it("the erasure waits first, before the renewal's claim: the renewal commits, then the erasure takes it", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, accountId, r1 } = await establish(svc, `erase-d2-${randomUUID()}@lichtgrat.example`);
    const r = party(`erase-d2-r-${randomUUID().slice(0, 8)}`, /^update "refresh_tokens" set "consumed_at"/i);
    const eraser = `erase-d2-e-${randomUUID().slice(0, 8)}`;
    const renewal = settle(svc.refresh(ctx({ db: r.db }), { refreshToken: r1, attemptId: `r${randomUUID()}` }, native));
    await r.reached;
    const erasure = settle(erase(accountId, userId, party(eraser).db));
    expect(await blockedOnALock(eraser), "the erasure waits on the renewal").toBe(true);
    r.open();
    const [er, rn] = await Promise.all([erasure, renewal]);
    expect(er.ok, `the erasure succeeded on its first attempt${why(er)}`).toBe(true);
    expect(rn.ok, "the renewal committed before the erasure").toBe(true);
    await expectErasedWhole(accountId, rn.ok ? rn.v.tokens! : null);
  }, 60_000);

  it("the erasure waits on a claimed renewal: the successor commits, and the erasure takes it too", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, accountId, r1 } = await establish(svc, `erase-f1-${randomUUID()}@lichtgrat.example`);
    const r = party(`erase-f1-r-${randomUUID().slice(0, 8)}`, /^insert into "refresh_tokens"/i);
    const eraser = `erase-f1-e-${randomUUID().slice(0, 8)}`;
    const renewal = settle(svc.refresh(ctx({ db: r.db }), { refreshToken: r1, attemptId: `r${randomUUID()}` }, native));
    await r.reached;
    const erasure = settle(erase(accountId, userId, party(eraser).db));
    expect(await blockedOnALock(eraser), "the erasure waits on the renewal").toBe(true);
    r.open();
    const [er, rn] = await Promise.all([erasure, renewal]);
    expect(er.ok, `the erasure succeeded on its first attempt${why(er)}`).toBe(true);
    expect(rn.ok, "the renewal committed before the erasure").toBe(true);
    await expectErasedWhole(accountId, rn.ok ? rn.v.tokens! : null);
  }, 60_000);
});
