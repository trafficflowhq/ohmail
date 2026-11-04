// @postpush: alone — one case holds ACCESS EXCLUSIVE on `sessions`, which a co-tenant would wait behind.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq, desc } from "drizzle-orm";
import { generateSync } from "otplib";
import { refreshTokens, sessions } from "@trafficflow/db";
import { authEvents, schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  AuthService, makeTestAuthDeps, hashToken, classifyRefreshFailure, type ServiceContext,
} from "@trafficflow/services";

/*
 * A ROTATION IS ONE COMMIT: the claim, the session's checks and the successor land together or
 * not at all. The claim used to autocommit alone, so any fault after it — a lock wait, a busy pool,
 * a killed function — spent the token and minted nothing; the client's retry then presented the
 * only token it had, and the native surface swept the family as theft. Production carried four
 * such families in thirty days, every one on a desktop.
 */
const PG_UP = await realPgAvailable();
type Sql = ReturnType<typeof postgres>;
type Db = ReturnType<typeof drizzle<typeof schema>>;

let client: Sql;
let db: Db;
const extra: Sql[] = [];

let ipCell = 0;
let ip = "10.10.0.1";
const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({
  db, accountId: "", userId: null, now: () => new Date(), requestId: "refresh-half-pg", ip, ...over,
});
const native = { surface: "native" } as const;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Register, enrol TOTP, sign in with the second factor; the user and the first refresh token. */
async function establish(svc: AuthService, email: string): Promise<{ userId: string; r1: string }> {
  ip = `10.10.${(ipCell += 1)}.1`;
  let t = new Date();
  const at = (over: Partial<ServiceContext> = {}): ServiceContext => ctx({ now: () => t, ...over });
  const totp = (secret: string): string => generateSync({ secret, epoch: Math.floor(t.getTime() / 1000) });
  const registered = await svc.register(at(), {
    email, password: "account-signin-password", displayName: "Gil", inviteCode: "INVITE-OK",
  });
  if (registered.status !== "enrollment") throw new Error(`expected an enrolment session, got ${registered.status}`);
  const user = registered.user;
  const [latest] = await db.select({ id: sessions.id }).from(sessions)
    .where(eq(sessions.userId, user.userId)).orderBy(desc(sessions.createdAt)).limit(1);
  const enrollCtx = at({ userId: user.userId, accountId: user.accountId, sessionId: latest!.id });
  const { secret } = await svc.totpEnroll(enrollCtx);
  await svc.totpActivate(enrollCtx, { code: totp(secret) });
  t = new Date(t.getTime() + 30_000);
  const ch = await svc.login(at(), { email, password: "account-signin-password" });
  if (ch.status !== "twofa_required") throw new Error(`expected a 2FA challenge, got ${ch.status}`);
  const est = await svc.totpVerify(at(), { loginToken: ch.loginToken, code: totp(secret) });
  return { userId: user.userId, r1: est.tokens!.refreshToken };
}

const rowOf = async (token: string) =>
  (await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hashToken(token))).limit(1))[0]!;
const familyRows = (familyId: string) => db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
const reuseEvents = async (userId: string) => (await db.select().from(authEvents)
  .where(and(eq(authEvents.userId, userId), eq(authEvents.event, "refresh_reuse_revoked")))).length;

/** A query that never reaches the driver and rejects with `err` however drizzle consumes it. */
function rejected(err: Error): object {
  const run = (): Promise<never> => Promise.reject(err);
  return { values: run, raw: run, then: (ok?: never, bad?: (e: unknown) => unknown) => run().then(ok, bad) };
}

/** As `rejected`, but the real statement, sent only once `gate` opens. */
function held(gate: Promise<void>, make: () => { values: () => Promise<unknown> } & PromiseLike<unknown>): object {
  return {
    values: () => gate.then(() => make().values()),
    then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => gate.then(() => make()).then(ok, bad),
  };
}

/*
 * A HANDLE THAT MEDDLES WITH ONE STATEMENT: after it has seen the claim, the first statement that
 * matches `pattern` is handed to `act`, which may refuse it or hold it. The pool's `begin` and
 * `savepoint` hand their callbacks a scoped client, so the proxy wraps those too — a transaction's
 * statements never pass through the outer `unsafe`.
 */
function meddling(pattern: RegExp, act: (run: () => unknown) => unknown): { db: Db; hits: () => number } {
  const base = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
  extra.push(base);
  let claimed = false;
  let hits = 0;
  const wrap = (sql: Sql): Sql => new Proxy(sql, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop === "unsafe") {
        return (text: string, params?: unknown[], opts?: unknown) => {
          const run = () => (value as (...a: unknown[]) => unknown).call(target, text, params, opts);
          if (claimed && hits === 0 && pattern.test(text)) {
            hits += 1;
            return act(run);
          }
          if (/^update "refresh_tokens" set "consumed_at"/i.test(text)) claimed = true;
          return run();
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
  return { db: brandDialect(drizzle(wrap(base), { schema }), "pg"), hits: () => hits };
}

/** A handle of its own, named in pg_stat_activity, so a wait of its backend can be READ. */
function named(app: string): Db {
  const base = postgres(PG_TEST_URL, { max: 2, onnotice: () => {}, connection: { application_name: app } });
  extra.push(base);
  return brandDialect(drizzle(base, { schema }), "pg");
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

describe.skipIf(!PG_UP)("a rotation whose second half fails spends nothing", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 5, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => {
    for (const c of extra) await c.end({ timeout: 5 });
    await client?.end({ timeout: 5 });
  });

  for (const named of [true, false]) {
    it(`a fault after the claim leaves the token live, and the retry ${named ? "of the same attempt" : "with no attempt id"} rotates`, async () => {
      const svc = new AuthService(makeTestAuthDeps());
      const { userId, r1 } = await establish(svc, `half-${named ? "named" : "bare"}-${randomUUID()}@lichtgrat.example`);
      const familyId = (await rowOf(r1)).familyId;
      const body = named ? { refreshToken: r1, attemptId: `r${randomUUID()}` } : { refreshToken: r1 };
      const faulty = meddling(/"sessions"/, () => rejected(new Error("injected: the statement after the claim failed")));

      const err = await svc.refresh(ctx({ db: faulty.db }), body, native).then(() => null, (e: unknown) => e);
      expect(faulty.hits(), "the fault was injected after the claim").toBe(1);
      expect(err, "the request failed").not.toBeNull();
      expect(classifyRefreshFailure(err), "a fault, never a verdict on the session").toBe("fault");

      const row = await rowOf(r1);
      expect(row.consumedAt, "the claim rolled back with the statement that failed").toBeNull();
      expect(row.consumedByAttempt).toBeNull();
      expect(await familyRows(familyId), "no successor was minted").toHaveLength(1);

      const retried = await svc.refresh(ctx(), body, native);
      expect(retried.tokens?.refreshToken, "the retry rotates the token it still holds").toBeTruthy();
      const fam = await familyRows(familyId);
      expect(fam.filter((r) => r.consumedAt === null && r.revokedAt === null), "one live tail").toHaveLength(1);
      expect(fam.some((r) => r.revokedAt !== null), "nothing in the family was revoked").toBe(false);
      expect(await reuseEvents(userId), "no theft verdict").toBe(0);
    });
  }

  it("the production class: the session read times out on a lock, and the token is still live", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, r1 } = await establish(svc, `half-lock-${randomUUID()}@lichtgrat.example`);
    const familyId = (await rowOf(r1)).familyId;
    const attemptId = `r${randomUUID()}`;
    const short = postgres(PG_TEST_URL, { max: 2, onnotice: () => {}, connection: { lock_timeout: 300 } });
    const holder = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    extra.push(short, holder);
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holding = holder.begin(async (tx) => {
      await tx`lock table sessions in access exclusive mode`;
      locked();
      await released;
    });
    try {
      await isLocked;
      const shortDb = brandDialect(drizzle(short, { schema }), "pg");
      const err = await svc.refresh(ctx({ db: shortDb }), { refreshToken: r1, attemptId }, native)
        .then(() => null, (e: unknown) => e as { code?: string });
      expect(err?.code, "the lock wait gave up").toBe("55P03");
    } finally {
      release();
      await holding;
    }
    expect((await rowOf(r1)).consumedAt, "nothing was spent").toBeNull();
    const retried = await svc.refresh(ctx(), { refreshToken: r1, attemptId }, native);
    expect(retried.tokens?.refreshToken).toBeTruthy();
    expect((await familyRows(familyId)).some((r) => r.revokedAt !== null)).toBe(false);
    expect(await reuseEvents(userId)).toBe(0);
  });

  it("a revoked session still refuses, and the family's revoke is committed", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { r1 } = await establish(svc, `half-revoked-${randomUUID()}@lichtgrat.example`);
    const { familyId, sessionId } = await rowOf(r1);
    // The race the hot path guards: a revocation that reached the session and not yet its tokens.
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));

    await expect(svc.refresh(ctx(), { refreshToken: r1, attemptId: `r${randomUUID()}` }, native))
      .rejects.toMatchObject({ code: "refresh_revoked", message: "session is no longer active" });
    const fam = await familyRows(familyId);
    expect(fam.every((r) => r.revokedAt !== null), "the revoke outlived the refusal").toBe(true);
    expect((await rowOf(r1)).consumedAt, "the presented token was claimed").not.toBeNull();
  });

  it("a capped session still refuses, and the family's revoke is committed", async () => {
    const svc = new AuthService(makeTestAuthDeps({ nativeSessionAbsoluteTtlMs: 1 }));
    const { r1 } = await establish(svc, `half-capped-${randomUUID()}@lichtgrat.example`);
    const { familyId, sessionId } = await rowOf(r1);
    const later = ctx({ now: () => new Date(Date.now() + 5 * 60_000) });

    await expect(svc.refresh(later, { refreshToken: r1 }, native))
      .rejects.toMatchObject({ code: "refresh_revoked", message: "session has reached its maximum lifetime" });
    expect((await familyRows(familyId)).every((r) => r.revokedAt !== null)).toBe(true);
    const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(s!.revokedAt, "the session went with its family").not.toBeNull();
  });

  /*
   * LOCK ORDER. Every arm that writes a family takes its SESSION row first and its token rows
   * second; a rotation that claimed its token first would hold a token row while waiting for the
   * session, which is a cycle with each of them. The probe from a third connection asks the
   * question directly: while the rotation waits for the session, is its token still unlocked?
   */
  it("a rotation waits for the session row before it claims anything", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { r1 } = await establish(svc, `half-order-${randomUUID()}@lichtgrat.example`);
    const { familyId, sessionId, id: tokenRowId } = await rowOf(r1);
    const holder = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    const probe = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    extra.push(holder, probe);
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holding = holder.begin(async (tx) => {
      await tx`select id from sessions where id = ${sessionId} for update`;
      locked();
      await released;
    });
    await isLocked;
    let settled = false;
    const rotator = `half-order-${randomUUID().slice(0, 8)}`;
    const rotation = svc.refresh(ctx({ db: named(rotator) }), { refreshToken: r1, attemptId: `r${randomUUID()}` }, native)
      .finally(() => { settled = true; });
    try {
      expect(await blockedOnALock(rotator), "the rotation is blocked on a lock").toBe(true);
      expect(settled, "the rotation waits while the session row is held").toBe(false);
      expect((await rowOf(r1)).consumedAt, "nothing is spent while it waits").toBeNull();
      const lockable = await probe.begin(async (tx) => {
        await tx`select id from refresh_tokens where id = ${tokenRowId} for update nowait`;
        return true;
      }).catch((e: { code?: string }) => e.code ?? "error");
      expect(lockable, "the waiting rotation holds no token row").toBe(true);
    } finally {
      release();
      await holding;
    }
    expect((await rotation).tokens?.refreshToken).toBeTruthy();
    const fam = await familyRows(familyId);
    expect(fam.filter((r) => r.consumedAt === null && r.revokedAt === null)).toHaveLength(1);
  });

  it("a sign-out racing a rotation in flight revokes the successor it minted too", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { r1 } = await establish(svc, `half-logout-${randomUUID()}@lichtgrat.example`);
    const { familyId, sessionId } = await rowOf(r1);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let reached!: () => void;
    const atMint = new Promise<void>((r) => { reached = r; });
    // Held at the mint's session write: the claim and the successor are written, not committed.
    const pausing = meddling(/^update "sessions"/i, (run) => {
      reached();
      return held(gate, run as () => { values: () => Promise<unknown> } & PromiseLike<unknown>);
    });
    const rotation = svc.refresh(ctx({ db: pausing.db }), { refreshToken: r1, attemptId: `r${randomUUID()}` }, native);
    await atMint;
    let signedOut = false;
    const leaver = `half-logout-${randomUUID().slice(0, 8)}`;
    const logout = svc.logout(ctx({ db: named(leaver) }), { refreshToken: r1 }).finally(() => { signedOut = true; });
    try {
      expect(await blockedOnALock(leaver), "the sign-out is blocked on a lock").toBe(true);
      expect(signedOut, "the sign-out waits for the rotation that holds the session").toBe(false);
    } finally {
      open();
    }
    const minted = await rotation;
    await logout;
    const successor = await rowOf(minted.tokens!.refreshToken);
    expect(successor.revokedAt, "the successor the rotation minted is revoked too").not.toBeNull();
    expect((await familyRows(familyId)).every((r) => r.revokedAt !== null)).toBe(true);
    const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(s!.revokedAt).not.toBeNull();
  });
});
