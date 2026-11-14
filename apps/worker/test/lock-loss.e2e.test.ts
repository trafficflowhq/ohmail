import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core";
import { acquireLeaderLock, LEADER_LOCK_KEY, leaderLockKeyFor } from "../src/leader-lock.js";
import { runWorkerSupervised } from "../src/supervisor.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

type Db = ReturnType<typeof makeDb>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";

async function seedMailbox(db: Db): Promise<string> {
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return row!.id;
}

/** The backend PID(s) holding a given advisory lock — the thing a failover kills. */
async function lockHolders(key: bigint): Promise<number[]> {
  const admin = postgres(DB, { max: 1 });
  try {
    const rows = await admin<{ pid: number }[]>`
      SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND ((classid::bigint << 32) + objid::bigint) = ${key as unknown as number}`;
    return rows.map((r) => Number(r.pid));
  } finally { await admin.end({ timeout: 5 }); }
}

async function terminate(pids: readonly number[]): Promise<void> {
  const admin = postgres(DB, { max: 1 });
  try { for (const pid of pids) await admin`SELECT pg_terminate_backend(${pid})`; }
  finally { await admin.end({ timeout: 5 }); }
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

/** The credential that reads the whole health snapshot; the public body carries no count. */
const DETAIL = "d".repeat(32);
const detail = { headers: { authorization: `Bearer ${DETAIL}` } };

async function health(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/health`, detail);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function cfgFor(fleet: FakeAdapterFleet, extra: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
    rosterIntervalMs: 500, lockHeartbeatMs: 300, mailboxRetryMs: 500,
    healthPort: 0, standbyRetryMs: 400, adapterFactory: fleet.factory, healthDetailSecret: DETAIL,
    ...extra,
  };
}

describe("leader-lock loss (split-brain guard)", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_lockloss"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("signals `lost` and fails `verify()` when the lock session is terminated", async () => {
    const lock = await acquireLeaderLock(DB, LEADER_LOCK_KEY);
    expect(lock).not.toBeNull();
    closers.push(() => lock!.release());

    expect(await lock!.verify()).toBe(true);
    expect(lock!.backendPid).toBeGreaterThan(0);

    // A failover / admin kill / network drop: Postgres frees the SESSION-scoped lock at once,
    // and postgres.js will happily reconnect into a session that does not hold it.
    await terminate([lock!.backendPid]);

    const err = await Promise.race([
      lock!.lost,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("`lost` never resolved")), 8000)),
    ]);
    expect(err.name).toBe("LockLostError");
    expect(await lock!.verify()).toBe(false);
  }, 30000);

  it("does NOT signal `lost` for a deliberate release()", async () => {
    const lock = await acquireLeaderLock(DB, LEADER_LOCK_KEY);
    expect(lock).not.toBeNull();
    let settled = false;
    void lock!.lost.then(() => { settled = true; });
    await lock!.release();
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);           // a clean handover must not look like a failure
  }, 20000);

  /** The supervisor's own log lines, by event name, in order. */
  function recorder(): { logger: ReturnType<typeof createLogger>; events: string[] } {
    const events: string[] = [];
    const logger = createLogger({
      service: "worker",
      sink: (line) => { events.push(String((JSON.parse(line) as { event?: unknown }).event)); },
    });
    return { logger, events };
  }

  it("a leader that loses its lock gives up everything it holds and leads again in the same process", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    await seedMailbox(db);
    const key = leaderLockKeyFor(0);

    // The FATAL hook is what the CLI turns into `process.exit(1)`. A lost lock used to end there:
    // the host restarted the process, and a host that had stopped restarting left the shard dark.
    const fatals: unknown[] = [];
    const { logger, events } = recorder();
    const a = await runWorkerSupervised(cfgFor(fleet, { logger }), { onFatal: (err) => fatals.push(err) });
    closers.push(() => a.stop());
    expect(a.state()).toBe("leader");
    await waitFor(async () => (await health(a.healthPort)).body.mailboxes === 1, 8000, "A to serve");
    expect(fleet.openCount).toBe(1);

    // Kill the session that holds the lock. Nothing else changes: the process is alive, its
    // IMAP connections are up, and its timers are running — exactly the split-brain setup.
    const holders = await lockHolders(key);
    expect(holders.length).toBe(1);
    await terminate(holders);

    // A surrenders, closes what it held, and takes the lock again itself. On every read on the way
    // there is at most one session holding the lock and at most one connection to the mailbox.
    await waitFor(async () => {
      expect((await lockHolders(key)).length).toBeLessThanOrEqual(1);
      expect(fleet.openCount).toBeLessThanOrEqual(1);
      return events.filter((e) => e === "leader_acquired").length === 2 && a.state() === "leader";
    }, 15000, "A to lead again");
    const order = events.filter((e) => ["leader_acquired", "leader_lock_lost", "leadership_surrendered"].includes(e));
    expect(order).toEqual(["leader_acquired", "leader_lock_lost", "leadership_surrendered", "leader_acquired"]);
    await a.whenLeader();                                                    // the second leadership
    await waitFor(async () => (await health(a.healthPort)).body.mailboxes === 1, 8000, "A to serve again");
    const ha = await health(a.healthPort);
    expect(ha.status).toBe(200);
    expect(ha.body).toMatchObject({ ok: true, leader: true, healthy: true, waitingForDatabaseSeconds: null });
    expect("error" in ha.body).toBe(false);
    expect(fatals).toHaveLength(0);                                          // no exit, no restart
    expect((await lockHolders(key)).length).toBe(1);
    expect(fleet.openCount).toBe(1);
  }, 60000);

  it("with a second instance standing by, a lost lock never yields two leaders, and the loser stands by", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    await seedMailbox(db);
    const key = leaderLockKeyFor(0);

    const fatals: unknown[] = [];
    const a = await runWorkerSupervised(cfgFor(fleet), { onFatal: (err) => fatals.push(err) });
    closers.push(() => a.stop());
    const b = await runWorkerSupervised(cfgFor(fleet), { onFatal: (err) => fatals.push(err) });
    closers.push(() => b.stop());
    expect([a.state(), b.state()]).toEqual(["leader", "standby"]);
    await waitFor(async () => (await health(a.healthPort)).body.mailboxes === 1, 8000, "A to serve");

    await terminate(await lockHolders(key));

    // Whichever of the two wins the lock next, on every read one session holds it at most and one
    // instance calls itself leader at most; it settles on one leader and one spare.
    const leaders = (): number => [a, b].filter((w) => w.state() === "leader").length;
    await waitFor(async () => {
      expect((await lockHolders(key)).length).toBeLessThanOrEqual(1);
      expect(leaders()).toBeLessThanOrEqual(1);
      return leaders() === 1 && [a, b].some((w) => w.state() === "standby");
    }, 15000, "one leader and one spare");
    const [leader, spare] = a.state() === "leader" ? [a, b] : [b, a];
    await waitFor(async () => (await health(leader.healthPort)).body.mailboxes === 1, 8000, "the leader to serve");
    expect((await health(spare.healthPort)).body).toMatchObject({ leader: false, standby: true, healthy: true });

    // …and the spare is a real one: it takes the shard over when the leader stops.
    await leader.stop();
    await waitFor(() => spare.state() === "leader", 8000, "the spare to take over");
    await waitFor(async () => (await health(spare.healthPort)).body.mailboxes === 1, 8000, "the spare to serve");
    expect(fatals).toHaveLength(0);
  }, 60000);
});
