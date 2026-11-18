import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { format } from "node:util";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { accounts, bindDb, changeLog, devices, refreshTokens, sessions, users } from "@trafficflow/db";
import { makeOwnedDb, schema, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  dbFor, hashToken, makeAuthService, makeTestAuthDeps, mintPairingToken, redeemDevicePair,
  type OAuthTokens, type ServiceContext,
} from "@trafficflow/services";
import { deviceNumbers } from "../src/device-numbers.js";

/**
 * THE DEVICES' DOORBELL ON REAL POSTGRES: what its own transaction waits on, and what waits on it.
 *
 * The ring writes the account's change-log counter. A pairing's redeem holds its code's row and
 * the rows it writes; a take-back in Devices holds the person's user row and the sessions it ends.
 * A ring inside either would take the counter under those rows, and a writer that takes the counter
 * first and one of those rows second would wait on it while it waited on the writer: a deadlock,
 * and a sign-in refused for a notice. The ring is therefore rung after its path has committed, in a
 * transaction of its own that opens on the erasure fence. A store with one connection cannot show
 * any of it, so each case here holds a row on a second connection and reads what is visible from a
 * third:
 *
 *   1. With the counter held by another writer, the device (or the ended session) is COMMITTED and
 *      visible while the ring still waits, and the rows the path took are free for that writer.
 *   2. An account erased between the path's commit and the ring: the ring waits behind the
 *      erasure's lock on the account row, reads its stamp, writes nothing and says nothing.
 *   3. Many pairings and take-backs of one account at once: every one answers, and the three
 *      numbers and the count of change rows come out exact.
 */
const PG_UP = await realPgAvailable();
const NOW = new Date("2026-11-17T10:00:00.000Z");

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
// The factory's handle: the binder takes a server handle only from the factory that registered its door.
let owned: OwnedDb;
let auth: ReturnType<typeof makeAuthService>;

type Handle = ServiceContext["db"];
/**
 * A door before sign-in holds a handle bound to nothing; a call that carries a session, its account's.
 * `wrap` puts a double over that bound handle (never binds the double).
 */
const ctxOn = (
  who: { accountId: string; userId: string } | null, sessionId: string | null = null, wrap: (h: object) => object = (h) => h,
): ServiceContext => ({
  db: wrap(who === null ? bindDb(owned.db, { account: null }) : dbFor(owned.db, who.accountId)) as Handle,
  accountId: who?.accountId ?? "", userId: who?.userId ?? null, sessionId,
  now: () => NOW, requestId: `bell-${randomUUID().slice(0, 8)}`, ip: "10.9.8.7",
});

async function person() {
  const [acct] = await db.insert(accounts).values({ name: `bell-${randomUUID()}` }).returning();
  const [user] = await db.insert(users).values({
    accountId: acct!.id, email: `bell-${randomUUID()}@example.com`, displayName: "B", emailVerifiedAt: NOW,
  }).returning();
  // A browser session with a second factor asserted now: the caller of a mint and of a take-back.
  const [browser] = await db.insert(sessions).values({
    accountId: acct!.id, userId: user!.id, familyId: randomUUID(), scope: "full",
    accessExpiresAt: new Date(NOW.getTime() + 3_600_000), refreshExpiresAt: new Date(NOW.getTime() + 7_200_000),
    lastTwofaAt: NOW, lastSeenAt: NOW,
  }).returning();
  const who = { accountId: acct!.id, userId: user!.id };
  return { ...who, who, browser: browser!.id };
}
type Person = Awaited<ReturnType<typeof person>>;

const mint = async (p: Person): Promise<{ token: string; id: string }> =>
  mintPairingToken(ctxOn(p.who, p.browser), { grant: "device-pair", label: "Kitchen phone" });

async function paired(p: Person): Promise<{ tokens: OAuthTokens; deviceId: string }> {
  const minted = await mint(p);
  const { tokens } = await redeemDevicePair(ctxOn(null), auth, { token: minted.token, kind: "mobile-android" });
  const [row] = await db.select({ deviceId: sessions.deviceId }).from(refreshTokens)
    .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
    .where(eq(refreshTokens.tokenHash, hashToken(tokens.refreshToken))).limit(1);
  return { tokens, deviceId: row!.deviceId! };
}

const rings = async (accountId: string): Promise<number> => (await db.select({ seq: changeLog.seq }).from(changeLog)
  .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings")))).length;

/** Wait until `seen` answers true, read from the pool: only what is committed is visible there. */
async function visible(what: string, seen: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 10_000;
  while (!(await seen())) {
    if (Date.now() > until) throw new Error(`never became visible from another connection: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** How many backends of this database wait for a lock right now. */
const waiting = async (): Promise<number> => Number((await client`
  select count(*)::int as n from pg_stat_activity
   where datname = current_database() and wait_event_type = 'Lock'`)[0]!.n);

/** A second writer's open transaction on a connection of its own. */
async function writer() {
  const conn = await client.reserve();
  await conn`begin`;
  await conn`set local lock_timeout = '3s'`;
  return {
    sql: conn,
    async end(how: "commit" | "rollback" = "commit"): Promise<void> {
      try { await conn.unsafe(how); } finally { conn.release(); }
    },
  };
}

/**
 * A double over a door's bound handle that runs `between` once, before the second transaction opened
 * through it. The handle's own `transaction` runs with the double as `this`, so the transaction carries
 * the handle's binding.
 */
function betweenTheTwo(between: () => Promise<void>): { wrap: (h: object) => object; opened: () => number } {
  let opened = 0;
  const wrap = (bound: object): object => {
    const handle = Object.create(bound) as object;
    Object.defineProperty(handle, "transaction", {
      value: async function (this: unknown, fn: (tx: unknown) => Promise<unknown>) {
        opened += 1;
        if (opened === 2) await between();
        return (bound as { transaction: (f: typeof fn) => Promise<unknown> }).transaction.call(this, fn);
      },
    });
    return handle;
  };
  return { wrap, opened: () => opened };
}

function printed(): () => string {
  const out: string[] = [];
  for (const m of ["log", "error", "warn", "info"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(format(...a)); });
  }
  return () => out.join("\n");
}

describe.skipIf(!PG_UP)("the devices' doorbell on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 24, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
    owned = makeOwnedDb(PG_TEST_URL);
    auth = makeAuthService(makeTestAuthDeps());
  }, 120_000);
  afterAll(async () => {
    await owned?.close();
    await client?.end({ timeout: 5 });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("a pairing is committed and its rows are free while its ring still waits for the counter", async () => {
    const p = await person();
    await paired(p);                       // the account's counter row exists from here
    const minted = await mint(p);
    const before = await rings(p.accountId);

    const other = await writer();
    await other.sql`select 1 from account_sync_state where account_id = ${p.accountId} for update`;
    const redeem = redeemDevicePair(ctxOn(null), auth, { token: minted.token, kind: "mobile-android" });
    let answered = false;
    void redeem.then(() => { answered = true; }, () => { answered = true; });
    try {
      // The second device is visible from another connection: the redeem's transaction has committed.
      await visible("the paired device's row", async () => (await deviceNumbers(db as never, p.accountId)).made === 2);
      expect((await deviceNumbers(db as never, p.accountId)).live, "its session is committed with it").toBe(2);
      await visible("the ring waiting for the counter", async () => (await waiting()) >= 1);
      expect(await rings(p.accountId), "the change row is not written while the counter is held").toBe(before);
      expect(answered, "the redeem answers once its ring has rung or failed").toBe(false);
      // What the redeem held is free: a writer that holds the counter takes each at once.
      await other.sql`select 1 from pairing_tokens where id = ${minted.id} for update`;
      await other.sql`select 1 from users where id = ${p.userId} for update`;
      await other.sql`select 1 from sessions where user_id = ${p.userId} for update`;
    } finally {
      // Whatever was read, the counter is let go, so the redeem can end.
      await other.end();
    }

    expect((await redeem).tokens.accessToken).toBeTruthy();
    expect(await rings(p.accountId)).toBe(before + 1);
  }, 60_000);

  it("a take-back is committed and its rows are free while its stamp and ring still wait for the counter", async () => {
    const p = await person();
    const phone = await paired(p);
    const before = await rings(p.accountId);
    const sessionEnded = async (): Promise<boolean> =>
      (await db.select({ at: sessions.revokedAt }).from(sessions).where(eq(sessions.deviceId, phone.deviceId)))[0]!.at !== null;
    const stamp = async (): Promise<Date | null> =>
      (await db.select({ at: devices.revokedAt }).from(devices).where(eq(devices.id, phone.deviceId)))[0]!.at;

    const other = await writer();
    await other.sql`select 1 from account_sync_state where account_id = ${p.accountId} for update`;
    const takeBack = auth.revokeDevice(ctxOn(p.who, p.browser), phone.deviceId);
    void takeBack.catch(() => undefined);

    try {
      await visible("the ended session", sessionEnded);
      await visible("the ring waiting for the counter", async () => (await waiting()) >= 1);
      expect(await rings(p.accountId)).toBe(before);
      expect(await stamp(), "the stamp is the ring's own write, not yet committed").toBeNull();
      // The take-back held the person's row and the sessions it ended; both are free.
      await other.sql`select 1 from users where id = ${p.userId} for update`;
      await other.sql`select 1 from sessions where user_id = ${p.userId} for update`;
    } finally {
      await other.end();
    }

    await takeBack;
    expect(await stamp()).toEqual(NOW);
    expect(await rings(p.accountId)).toBe(before + 1);
    expect(await deviceNumbers(db as never, p.accountId)).toEqual({ made: 1, revoked: 1, live: 0 });
  }, 60_000);

  it("an account erased between a pairing's commit and its ring: the pairing answers, no row is written, nothing is said", async () => {
    const p = await person();
    await paired(p);
    const minted = await mint(p);
    const before = await rings(p.accountId);
    const said = printed();

    // The erasure's own first statement, taken after the redeem committed and before its ring opens.
    let erasure: Awaited<ReturnType<typeof writer>> | null = null;
    let committed = false;
    const view = betweenTheTwo(async () => {
      expect((await deviceNumbers(db as never, p.accountId)).made, "the redeem had committed").toBe(2);
      erasure = await writer();
      await erasure.sql`select 1 from accounts where id = ${p.accountId} for update`;
      // The stamp lands once the ring is seen waiting behind this lock, so the order is not a race.
      void (async () => {
        await visible("the ring waiting on the account row", async () => (await waiting()) >= 1);
        await erasure!.sql`update accounts set erased_at = ${NOW.toISOString()}::timestamptz where id = ${p.accountId}`;
        committed = true;
        await erasure!.end();
      })();
    });

    const answer = await redeemDevicePair(ctxOn(null, null, view.wrap), auth, { token: minted.token, kind: "mobile-android" });

    expect(answer.tokens.accessToken, "the pairing had committed and answers").toBeTruthy();
    expect(view.opened(), "the redeem's transaction, then the ring's").toBe(2);
    expect(committed, "the ring waited for the erasure's lock, and returned after its commit").toBe(true);
    expect(await rings(p.accountId), "an erased account gets no change row").toBe(before);
    expect(said()).toBe("");
  }, 60_000);

  it("an account erased between a take-back's commit and its ring: the device is not stamped, nothing is said", async () => {
    const p = await person();
    const phone = await paired(p);
    const before = await rings(p.accountId);
    const said = printed();
    const view = betweenTheTwo(async () => {
      await db.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, p.accountId));
    });

    await auth.revokeDevice(ctxOn(p.who, p.browser, view.wrap), phone.deviceId);

    const [session] = await db.select({ at: sessions.revokedAt }).from(sessions).where(eq(sessions.deviceId, phone.deviceId));
    expect(session!.at, "the take-back itself had committed").not.toBeNull();
    const [device] = await db.select({ at: devices.revokedAt }).from(devices).where(eq(devices.id, phone.deviceId));
    expect(device!.at).toBeNull();
    expect(await rings(p.accountId)).toBe(before);
    expect(said()).toBe("");
  }, 60_000);

  it("six pairings of one account at once, then three take-backs at once: every one answers, and the numbers are exact", async () => {
    const p = await person();
    const standing = [await paired(p), await paired(p), await paired(p)];
    const tokens = await Promise.all(Array.from({ length: 6 }, () => mint(p)));
    const before = await rings(p.accountId);
    const answers = (settled: PromiseSettledResult<unknown>[]): string[] =>
      settled.map((s) => (s.status === "fulfilled" ? "ok" : String((s.reason as { code?: string }).code ?? s.reason)));

    const pairings = await Promise.allSettled(
      tokens.map((t) => redeemDevicePair(ctxOn(null), auth, { token: t.token, kind: "mobile-android" })));
    expect(answers(pairings)).toEqual(Array.from({ length: 6 }, () => "ok"));
    expect(await deviceNumbers(db as never, p.accountId)).toEqual({ made: 9, revoked: 0, live: 9 });
    expect(await rings(p.accountId), "one change row for each device made").toBe(before + 6);

    const takeBacks = await Promise.allSettled(
      standing.map((s) => auth.revokeDevice(ctxOn(p.who, p.browser), s.deviceId)));
    expect(answers(takeBacks)).toEqual(["ok", "ok", "ok"]);
    expect(await deviceNumbers(db as never, p.accountId)).toEqual({ made: 9, revoked: 3, live: 6 });
    expect(await rings(p.accountId), "and one for each taken back").toBe(before + 9);
  }, 60_000);
});
