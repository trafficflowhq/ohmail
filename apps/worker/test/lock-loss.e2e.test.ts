import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
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
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
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

  it("quiesces the leader and hands the shard over instead of two workers syncing the same accounts", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    await seedMailbox(db);

    // The FATAL hook is what the CLI turns into `process.exit(1)` so the platform replaces
    // the instance. Nothing exercised it before; it is asserted here end to end.
    const fatals: unknown[] = [];
    const a = await runWorkerSupervised(cfgFor(fleet), { onFatal: (err) => fatals.push(err) });
    closers.push(() => a.stop());
    expect(a.state()).toBe("leader");
    expect(fatals).toHaveLength(0);
    await waitFor(async () => (await health(a.healthPort)).body.mailboxes === 1, 8000, "A to serve");
    expect(fleet.openCount).toBe(1);

    // Kill the session that holds the lock. Nothing else changes: the process is alive, its
    // IMAP connections are up, and its timers are running — exactly the split-brain setup.
    const holders = await lockHolders(leaderLockKeyFor(0));
    expect(holders.length).toBe(1);
    await terminate(holders);

    // A must surrender: no longer leader, health 503 (so the platform replaces it), and it
    // must have CLOSED its connections rather than keep syncing accounts it no longer owns.
    await waitFor(() => a.state() === "failed", 8000, "A to surrender leadership");
    const ha = await health(a.healthPort);
    expect(ha.status).toBe(503);
    expect(ha.body).toMatchObject({ ok: false, leader: false, healthy: false });
    expect(String(ha.body.error)).toMatch(/lock lost/i);
    expect(fatals).toHaveLength(1);
    expect((fatals[0] as Error).name).toBe("LockLostError");
    await waitFor(() => fleet.openCount === 0, 8000, "A to close its mailbox connections");

    // ...and the shard is genuinely free: a fresh instance takes it over and serves.
    const b = await runWorkerSupervised(cfgFor(fleet));
    closers.push(() => b.stop());
    await waitFor(() => b.state() === "leader", 8000, "B to take the shard over");
    await waitFor(async () => (await health(b.healthPort)).body.mailboxes === 1, 8000, "B to serve");
    expect((await health(a.healthPort)).body.leader).toBe(false);   // never two leaders
  }, 60000);
});
