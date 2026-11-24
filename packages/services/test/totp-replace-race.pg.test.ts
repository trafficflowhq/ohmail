import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, sql } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { accounts, sessions, users } from "@trafficflow/db";
import { authEvents, authThrottle, schema, totpSecrets, makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  AuthService, makeTestAuthDeps, newTotpSecret, totpNow, type ServiceContext,
} from "@trafficflow/services";

/**
 * Replacing an authenticator on real Postgres: the promote is `FOR UPDATE` plus a
 * compare-and-swap on the pending ciphertext, and PGlite is one connection, so neither interleaving
 * below is reachable there. Three `max: 1` clients: two tabs activating and a third holding the row;
 * a fourth reads `pg_stat_activity` so a release happens only once the tabs are waiting on the lock.
 * The lock and the CAS are PEERS, as in `kek-rewrap.pg.test.ts`: either one alone keeps these green,
 * both removed turn them red. Every row is this file's own user's, and `afterEach` removes it.
 */
const PG_UP = await realPgAvailable();

type Db = ReturnType<typeof drizzle<typeof schema>>;
let clients: Array<ReturnType<typeof postgres>> = [];
let tabA: Db;
let tabB: Db;
let holder: Db;
let observer: Db;
/** The backend pid behind each tab's one connection. */
/** Each tab's pool of the factory's, named in pg_stat_activity (a parameter of the address is one of the connection). */
const TAB_A = `totp-tab-a-${randomUUID().slice(0, 8)}`;
const TAB_B = `totp-tab-b-${randomUUID().slice(0, 8)}`;
let tabs: OwnedDb[] = [];
const namedPool = (app: string): OwnedDb => {
  const address = new URL(PG_TEST_URL);
  address.searchParams.set("application_name", app);
  return makeOwnedDb(address.toString());
};

const deps = makeTestAuthDeps();
const svc = new AuthService(deps);
const mine: Array<{ accountId: string; userId: string }> = [];

/** A clock in the past, so nothing this file writes is stamped ahead of the server. */
class Clock {
  t = new Date(Date.now() - 30 * 60_000);
  now = (): Date => this.t;
  advance(ms: number): void { this.t = new Date(this.t.getTime() + ms); }
}

interface World {
  clock: Clock;
  userId: string;
  accountId: string;
  /** A fresh FULL session per tab — the promote re-asks step-up. */
  ctxOn(db: Db, sessionId: string): ServiceContext;
  sessionA: string;
  sessionB: string;
  /** The replacement's secret, shown to the person by the enrol. */
  next: string;
  liveEnc: string;
  pendingEnc: string;
}

async function fullSession(db: Db, w: { accountId: string; userId: string }, clock: Clock): Promise<string> {
  const now = clock.now();
  const [row] = await db.insert(sessions).values({
    accountId: w.accountId, userId: w.userId, familyId: randomUUID(), scope: "full",
    accessExpiresAt: new Date(Date.now() + 60 * 60_000),
    refreshExpiresAt: new Date(Date.now() + 120 * 60_000),
    lastTwofaAt: now, lastSeenAt: now,
  }).returning();
  return row!.id;
}

/** An activated authenticator (enrolled and activated through the service), then a replacement begun. */
async function newWorld(): Promise<World> {
  const clock = new Clock();
  const accountId = randomUUID();
  await holder.insert(accounts).values({ id: accountId, name: `totp-race-${accountId.slice(0, 8)}` });
  const [u] = await holder.insert(users).values({
    accountId, email: `totp-race-${randomUUID()}@example.test`,
  }).returning();
  const userId = u!.id;
  mine.push({ accountId, userId });

  const ctxOn = (db: Db, sessionId: string): ServiceContext => ({
    db: dbFor(db, accountId), accountId, userId, sessionId,
    now: clock.now, requestId: `totp-race-${randomUUID().slice(0, 8)}`, ip: "192.0.2.1",
  });
  const sessionA = await fullSession(holder, { accountId, userId }, clock);
  const sessionB = await fullSession(holder, { accountId, userId }, clock);

  const { secret: old } = await svc.totpEnroll(ctxOn(tabA, sessionA));
  await svc.totpActivate(ctxOn(tabA, sessionA), { code: totpNow(old, clock.now()) });
  clock.advance(30_000);
  const liveEnc = (await readRow(userId)).secretEnc;
  const { secret: next } = await svc.totpEnroll(ctxOn(tabA, sessionA));
  const row = await readRow(userId);
  expect(row.activated).toBe(true);
  expect(row.secretEnc).toBe(liveEnc);
  expect(row.pendingSecretEnc).not.toBeNull();
  clock.advance(30_000);
  return { clock, userId, accountId, ctxOn, sessionA, sessionB, next, liveEnc, pendingEnc: row.pendingSecretEnc! };
}

async function readRow(userId: string) {
  const rows = await holder.select().from(totpSecrets).where(eq(totpSecrets.userId, userId));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** Hold the row under `FOR UPDATE` on the third client until `release`, then run `then` and commit. */
function holdRow(userId: string, then: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<void>) {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let locked!: () => void;
  const ready = new Promise<void>((r) => { locked = r; });
  const done = holder.transaction(async (tx) => {
    await tx.execute(sql`select id from totp_secrets where user_id = ${userId} for update`);
    locked();
    await held;
    await then(tx);
  });
  return { ready, release, done };
}

/** Resolve once `n` of these backends wait on a lock: the interleaving, read off the server. */
async function waitingOnLock(apps: string[], n: number): Promise<void> {
  const giveUpAt = Date.now() + 15_000;
  for (;;) {
    const rows = await observer.execute(sql`select count(*)::int as n from pg_stat_activity
      where application_name in (${sql.join(apps.map((a) => sql`${a}`), sql`, `)}) and wait_event_type = 'Lock'`);
    if ((rows as unknown as Array<{ n: number }>)[0]!.n >= n) return;
    if (Date.now() > giveUpAt) throw new Error(`fewer than ${n} of ${apps.join(",")} ever waited on the row lock`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(() => "ok", (e: { httpStatus?: number; message?: string }) => `${e.httpStatus ?? "?"} ${e.message ?? String(e)}`);

describe.skipIf(!PG_UP)("replacing an authenticator on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    clients = [0, 1].map(() => postgres(PG_TEST_URL, { max: 1, onnotice: () => {} }));
    [holder, observer] = clients.map((c) => brandDialect(drizzle(c, { schema }), "pg")) as [Db, Db];
    tabs = [namedPool(TAB_A), namedPool(TAB_B)];
    [tabA, tabB] = tabs.map((t) => t.db as unknown as Db) as [Db, Db];
  }, 120_000);

  afterEach(async () => {
    const userIds = mine.map((m) => m.userId);
    const accountIds = mine.map((m) => m.accountId);
    mine.length = 0;
    if (userIds.length === 0) return;
    await holder.delete(totpSecrets).where(inArray(totpSecrets.userId, userIds));
    await holder.delete(sessions).where(inArray(sessions.userId, userIds));
    await holder.delete(authEvents).where(inArray(authEvents.userId, userIds));
    await holder.delete(authThrottle).where(inArray(authThrottle.key, userIds.map((id) => `user:${id}`)));
    await holder.delete(users).where(inArray(users.id, userIds));
    await holder.delete(accounts).where(inArray(accounts.id, accountIds));
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
    await Promise.all(tabs.map((t) => t.close()));
  });

  it("two tabs activating one replacement at once: exactly one promotes", async () => {
    const w = await newWorld();
    const code = totpNow(w.next, w.clock.now());
    const hold = holdRow(w.userId, async () => {});
    await hold.ready;
    const first = outcome(svc.totpActivate(w.ctxOn(tabA, w.sessionA), { code }));
    const second = outcome(svc.totpActivate(w.ctxOn(tabB, w.sessionB), { code }));
    await waitingOnLock([TAB_A, TAB_B], 2);
    hold.release();
    await hold.done;

    const results = (await Promise.all([first, second])).sort();
    expect(results).toEqual(["422 no TOTP enrollment in progress", "ok"]);
    const row = await readRow(w.userId);
    expect(row.secretEnc).toBe(w.pendingEnc);
    expect([row.pendingSecretEnc, row.pendingKeyVersion, row.pendingStartedAt]).toEqual([null, null, null]);
  }, 30_000);

  it("a replacement superseded while the activation waits promotes nothing", async () => {
    const w = await newWorld();
    const newer = newTotpSecret();
    const sealed = await deps.keyProvider.encrypt(newer);
    const hold = holdRow(w.userId, async (tx) => {
      await tx.execute(sql`update totp_secrets
        set pending_secret_enc = ${sealed.ciphertext}, pending_key_version = ${sealed.keyVersion},
            pending_started_at = ${w.clock.now().toISOString()}::timestamptz
        where user_id = ${w.userId}`);
    });
    await hold.ready;
    const activating = outcome(svc.totpActivate(w.ctxOn(tabA, w.sessionA), { code: totpNow(w.next, w.clock.now()) }));
    await waitingOnLock([TAB_A], 1);
    hold.release();
    await hold.done;

    expect(await activating).toMatch(/^422 /);
    const row = await readRow(w.userId);
    expect(row.secretEnc, "the live secret must not move").toBe(w.liveEnc);
    expect(row.pendingSecretEnc).toBe(sealed.ciphertext);
    // The row is still promotable: the superseding secret's own code activates it.
    await expect(outcome(svc.totpActivate(w.ctxOn(tabB, w.sessionB), { code: totpNow(newer, w.clock.now()) })))
      .resolves.toBe("ok");
    expect((await readRow(w.userId)).secretEnc).toBe(sealed.ciphertext);
  }, 30_000);

  it("control, B then A in sequence: the ordinary replacement promotes once and the second is refused", async () => {
    const w = await newWorld();
    const code = totpNow(w.next, w.clock.now());
    expect(await outcome(svc.totpActivate(w.ctxOn(tabB, w.sessionB), { code }))).toBe("ok");
    expect(await outcome(svc.totpActivate(w.ctxOn(tabA, w.sessionA), { code })))
      .toBe("422 no TOTP enrollment in progress");
    expect((await readRow(w.userId)).secretEnc).toBe(w.pendingEnc);
    w.clock.advance(30_000);
    await expect(outcome(svc.stepUpTotp(w.ctxOn(tabA, w.sessionA), { code: totpNow(w.next, w.clock.now()) })))
      .resolves.toBe("ok");
  }, 30_000);
});
