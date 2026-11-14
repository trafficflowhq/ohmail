import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, contacts, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { randomUUID } from "node:crypto";
import { startWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { runWorkerSupervised } from "../src/supervisor.js";
import { acquireLeaderLock } from "../src/leader-lock.js";
import { imapCfg, rawClient, emlOf } from "./_workerenv.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

type Db = ReturnType<typeof makeDb>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
const RETRY_MS = 400;

let DB = "";

interface Health {
  status: number;
  body: {
    ok: boolean; healthy: boolean; leader: boolean; standby: boolean;
    mailboxes: number; accounts: number; expected: number; quarantined: number;
    awaitingCredentials: number; truncated: number; degraded: boolean;
    lastCycleAt: string | null; lagSeconds: number | null;
    // All THREE KEK fields (risk 2): the ring fingerprint alone cannot tell two hosts
    // apart when their key BYTES match but their active version differs.
    kekFingerprint: string | null; kekActiveVersion: number | null; kekVersionCount: number | null;
    shard: { index: number; shards: number };
  };
}

/** The credential that reads the whole health snapshot; the public body carries no count. */
const DETAIL = "d".repeat(32);

async function health(port: number, path = "/health"): Promise<Health> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${DETAIL}` } });
  return { status: res.status, body: (await res.json()) as Health["body"] };
}

async function waitForHealthBody(
  port: number, cond: (body: Health["body"]) => boolean, ms: number,
): Promise<Health["body"]> {
  const start = Date.now();
  let last: Health["body"] | null = null;
  while (Date.now() - start < ms) {
    last = (await health(port)).body;
    if (cond(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${ms}ms waiting for health; last = ${JSON.stringify(last)}`);
}

async function waitUntil(cond: () => boolean, ms: number, label: string): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

async function seedOneMailbox(db: Db) {
  const cfg = imapCfg();
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: cfg.auth.user }).returning();
  await db.insert(contacts).values({ accountId, address: "anna@x.example" });
  const enc = await KP.encrypt(cfg.auth.pass);
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: cfg.host, port: cfg.port, secure: false, user: cfg.auth.user },
  });
  return { cfg, accountId, mailboxId: row!.id };
}

/**
 * Wait for the message with this Message-ID (RFC 5322) to be ingested into this mailbox.
 *
 * By `message_id_header`, not `dedup_key`: since that change slice 2 the key is `fp1:<sha256>` over every
 * field a sender chooses, so a test cannot spell it out — and "the message I appended" is exactly
 * what the header names. Case is significant now (`normalizeMessageId` stopped folding it).
 */
async function waitForMessage(db: Db, mailboxId: string, messageId: string, ms = 12000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const rows = await db.select().from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, messageId)));
    if (rows.length > 0) return rows.length;
    await new Promise((r) => setTimeout(r, 200));
  }
  return 0;
}

/** Identical config for both instances — only the lock decides who serves. */
function cfgFor(): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, kek: { active: 2, count: 2, fingerprint: "deadbeef" },
    pollIntervalMs: 1000, sentDomain: "trafficflow.test",
    healthPort: 0, standbyRetryMs: RETRY_MS,   // 0 ⇒ an ephemeral health port per instance
    healthDetailSecret: DETAIL,
  };
}

describe("worker standby + health", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_sb"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
    vi.unstubAllEnvs();
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("stands by with health 200 instead of exiting, then takes over and serves when the leader releases", async () => {
    const db = makeDb(DB);
    const mb = await seedOneMailbox(db);

    const a = await runWorkerSupervised(cfgFor());
    closers.push(() => a.stop());
    expect(a.state()).toBe("leader");

    const ha = await health(a.healthPort);
    expect(ha.status).toBe(200);
    expect(ha.body).toMatchObject({
      ok: true, healthy: true, leader: true, standby: false, mailboxes: 1, accounts: 1,
      expected: 1, quarantined: 0, awaitingCredentials: 0, truncated: 0, degraded: false,
      kekFingerprint: "deadbeef", kekActiveVersion: 2, kekVersionCount: 2,
      shard: { index: 0, shards: 1 },
    });

    // A SECOND instance while the first holds the lock — the Railway rolling-deploy case.
    // Before that change this threw + process.exit(1) (crash-loop); now it stands by, health 200.
    const b = await runWorkerSupervised(cfgFor());
    closers.push(() => b.stop());
    expect(b.state()).toBe("standby");

    const hb = await health(b.healthPort);
    expect(hb.status).toBe(200);                     // 200 in STANDBY or the platform kills the spare
    expect(hb.body).toMatchObject({
      ok: true, healthy: true, leader: false, standby: true, mailboxes: 0, accounts: 0,
      expected: 0, degraded: false, lastCycleAt: null, lagSeconds: null,
      kekFingerprint: "deadbeef", kekActiveVersion: 2, kekVersionCount: 2,
    });

    // The leader releases (a deploy stopping the old instance) → the standby takes over.
    const t0 = Date.now();
    await a.stop();
    await waitUntil(() => b.state() === "leader", 10000, "standby takeover");
    const elapsed = Date.now() - t0;
    // Bounded by ONE backoff interval to WIN the lock, plus the IMAP connect + initial
    // reconcile it then performs before it reports itself leader.
    expect(elapsed).toBeLessThan(RETRY_MS + 5000);
    await b.whenLeader();                            // already resolved; asserts the signal fires

    const hb2 = await health(b.healthPort);
    expect(hb2.status).toBe(200);
    expect(hb2.body).toMatchObject({ leader: true, standby: false, mailboxes: 1, accounts: 1 });

    // It does not just CLAIM leadership — it serves: mail arriving after takeover syncs.
    const c = await rawClient(mb.cfg);
    await c.append("INBOX", emlOf({ from: "anna@x.example", subject: "after takeover", messageId: "sb2@x" }));
    await c.logout();
    expect(await waitForMessage(db, mb.mailboxId, "sb2@x")).toBe(1);

    // Once a cycle has completed, health carries the freshness pair an alert needs
    // ("no cycle for N seconds"). It is null until then — a takeover is not a cycle.
    const cycled = await waitForHealthBody(b.healthPort, (v) => typeof v.lastCycleAt === "string", 5000);
    expect(cycled.lagSeconds).toBeGreaterThanOrEqual(0);
    expect(cycled.lagSeconds).toBeLessThan(60);
  }, 60000);

  it("keeps startWorker's programmatic throw when the lock is held (leader-lock semantics unchanged)", async () => {
    const lock = await acquireLeaderLock(DB);
    expect(lock).not.toBeNull();
    closers.push(() => lock!.release());

    await expect(startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
    })).rejects.toThrow(/leader lock/);
  }, 30000);

  it("a stop() landing mid-takeover leaves no worker running and no lock held", async () => {
    const db = makeDb(DB);
    const mb = await seedOneMailbox(db);
    const fleet = new FakeAdapterFleet();
    // The takeover BARRIER: this instance wins the lock and then parks inside
    // startWorkerWithLock (in adapter.connect()) until we release it.
    let release: () => void = () => { /* replaced */ };
    const gate = new Promise<void>((r) => { release = r; });
    fleet.behave(mb.mailboxId, { gate });

    // Something else holds the lock, so the supervisor comes up as a standby.
    const held = await acquireLeaderLock(DB);
    expect(held).not.toBeNull();

    const b = await runWorkerSupervised({ ...cfgFor(), adapterFactory: fleet.factory });
    closers.push(() => b.stop());
    expect(b.state()).toBe("standby");

    // Let it win the lock; it then blocks half-way through starting up.
    await held!.release();
    await waitUntil(() => fleet.created === 1, 8000, "the takeover to reach adapter.connect()");
    await new Promise((r) => setTimeout(r, 100));       // parked at `await gate`
    expect(b.state()).toBe("standby");                  // not yet leader

    // SIGTERM lands NOW. Pre-fix, stop() saw `worker === null`, returned immediately, and the
    // pending attempt then published `state = "leader"` with a worker and a lock nobody owned.
    const stopping = b.stop();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await stopping;

    expect(b.state()).toBe("stopped");                  // never flipped back to leader
    expect(fleet.openCount).toBe(0);                    // the worker it started was stopped
    const after = await acquireLeaderLock(DB);           // ...and its lock was released
    expect(after).not.toBeNull();
    await after!.release();
  }, 45000);

  it("fails the boot loudly on a broken config and leaves the lock free for another instance", async () => {
    vi.stubEnv(KEY_RING_V1, "");                     // no injected provider, no env KEK
    await expect(runWorkerSupervised({
      databaseUrl: DB, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
      healthPort: 0, standbyRetryMs: RETRY_MS, healthDetailSecret: DETAIL,
    })).rejects.toThrow(/KeyProvider/);

    const lock = await acquireLeaderLock(DB);        // the failed boot must NOT hold the shard hostage
    expect(lock).not.toBeNull();
    await lock!.release();
  }, 30000);
});
