import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, contacts, messages } from "@trafficflow/db";
import { makeDb, workerHeartbeats } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { randomUUID } from "node:crypto";
import { startWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { runWorkerSupervised, databaseWaitMs } from "../src/supervisor.js";
import { asDatabaseFault, databaseAwayCodeOf } from "../src/db-fault.js";
import { DEFAULT_DB_WAIT_BASE_MS, DEFAULT_DB_WAIT_CAP_MS } from "../src/config.js";
import { DbDoor, refusingPostgres, surviveDriverWriteRace } from "./_dbdoor.js";
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
    unhealthyReason: string | null; waitingForDatabaseSeconds: number | null; waitingForDatabaseCode: string | null;
    takingOver: boolean; error?: string;
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
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
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

  /** A mailbox no mail server stands behind: the fleet's fake adapter serves it. */
  async function seedFakeMailbox(db: Db, kp = KP): Promise<string> {
    const [row] = await db.insert(mailboxes)
      .values({ accountId: randomUUID(), provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
    const enc = await kp.encrypt(randomUUID());            // the fake adapter never dials with it
    await db.insert(mailboxCredentials).values({
      mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
    });
    return row!.id;
  }

  /**
   * 12 November 2026: the database went away, every start failed to connect and EXITED, 81 times in
   * ten minutes, and the host stopped restarting the worker. The database came back an hour later
   * and nothing started it again. A start that cannot reach the database now waits in this process.
   * The second row declares a key version retired: the gate's own read is then the first contact.
   */
  it.each([
    { name: "a start", kekRetiredThrough: 0 },
    { name: "a start whose first read is the key-retirement gate's", kekRetiredThrough: 1 },
  ])("$name against a database that refuses connections waits, says so, and leads when it is back", async ({ kekRetiredThrough }) => {
    const db = makeDb(DB);
    const kp = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 2);     // nothing names version 1
    await seedFakeMailbox(db, kp);
    const fleet = new FakeAdapterFleet();
    const door = await DbDoor.to(DB).reserve();
    closers.push(async () => { door.down(); });

    const fatals: unknown[] = [];
    const sup = await runWorkerSupervised({
      ...cfgFor(), databaseUrl: door.via(DB), keyProvider: kp, kekRetiredThrough, adapterFactory: fleet.factory,
      dbWaitBaseMs: 100, dbWaitCapMs: 300, pollIntervalMs: 200,
    }, { onFatal: (err) => fatals.push(err) });
    closers.push(() => sup.stop());

    // It did not exit and it does not call itself healthy, a leader or a spare.
    expect(sup.state()).toBe("waiting");
    const waiting = await health(sup.healthPort);
    expect(waiting.status).toBe(503);
    expect(waiting.body).toMatchObject({
      ok: false, healthy: false, leader: false, standby: false, takingOver: false,
      unhealthyReason: "waiting_for_database", waitingForDatabaseCode: "ECONNREFUSED", mailboxes: 0,
    });
    expect(waiting.body.waitingForDatabaseSeconds).toBeGreaterThanOrEqual(0);
    expect("error" in waiting.body).toBe(false);
    // …for as long as the database stays away: several waits later it is still there, still waiting.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(sup.state()).toBe("waiting");
    expect(door.dials).toBe(0);

    // The database comes back. Nothing outside restarts anything.
    await door.up();
    await Promise.race([
      sup.whenLeader(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("never led after the database came back")), 15_000)),
    ]);
    expect(sup.state()).toBe("leader");
    // …and it works: a cycle completes, on the health answer and on the shard's row.
    const led = await waitForHealthBody(sup.healthPort, (v) => typeof v.lastCycleAt === "string", 10_000);
    expect(led).toMatchObject({
      healthy: true, leader: true, mailboxes: 1, unhealthyReason: null,
      waitingForDatabaseSeconds: null, waitingForDatabaseCode: null,
    });
    const [beat] = await db.select().from(workerHeartbeats);
    expect(beat?.leader).toBe(true);
    expect(fatals).toHaveLength(0);
  }, 60_000);

  const ledWithin = (sup: { whenLeader(): Promise<void> }, ms: number): Promise<void> => Promise.race([
    sup.whenLeader(),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`never led within ${ms} ms`)), ms)),
  ]);

  it("a database that goes away right after the lock is won is waited for too", async () => {
    // The lock's dial is answered and the pool's first is refused: a raw socket error out of the
    // worker's own start, which names the database only because the read that met it does.
    const db = makeDb(DB);
    await seedFakeMailbox(db);
    const fleet = new FakeAdapterFleet();
    const door = DbDoor.to(DB);
    door.closeAfter = 1;
    await door.up();
    closers.push(async () => { door.down(); });

    const fatals: unknown[] = [];
    const sup = await runWorkerSupervised({
      ...cfgFor(), databaseUrl: door.via(DB), adapterFactory: fleet.factory,
      dbWaitBaseMs: 100, dbWaitCapMs: 300, pollIntervalMs: 200,
    }, { onFatal: (err) => fatals.push(err) });
    closers.unshift(() => sup.stop());

    expect(sup.state()).toBe("waiting");
    expect((await health(sup.healthPort)).body).toMatchObject({
      healthy: false, unhealthyReason: "waiting_for_database", waitingForDatabaseCode: "ECONNREFUSED",
    });
    const free = await acquireLeaderLock(DB);         // the start gave the lock back
    expect(free).not.toBeNull();
    await free!.release();

    door.closeAfter = null;
    await door.up();
    await ledWithin(sup, 15_000);
    expect(fatals).toHaveLength(0);
  }, 60_000);

  /**
   * A session that completes its handshake and is then neither answered nor closed: the driver bounds
   * the handshake alone, so the attempt never settled and nothing tried again. First contact has a
   * deadline of its own; past it the attempt's session is ended and the next one dials afresh.
   */
  it.each([
    { name: "the lock's", kekRetiredThrough: 0 },
    { name: "the key-retirement gate's", kekRetiredThrough: 1 },
  ])("a first contact that is accepted and never answered ($name) is given up at its deadline and tried again", async ({ kekRetiredThrough }) => {
    const restore = surviveDriverWriteRace();
    closers.push(async () => { restore(); });
    const db = makeDb(DB);
    const kp = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 2);     // nothing names version 1
    await seedFakeMailbox(db, kp);
    const fleet = new FakeAdapterFleet();
    const door = DbDoor.to(DB);
    door.mute = (dial) => dial === 1;
    await door.up();
    closers.unshift(async () => { door.down(); });

    const fatals: unknown[] = [];
    const sup = await runWorkerSupervised({
      ...cfgFor(), databaseUrl: door.via(DB), keyProvider: kp, kekRetiredThrough, adapterFactory: fleet.factory,
      dbWaitBaseMs: 1_500, dbWaitCapMs: 1_500, pollIntervalMs: 200, firstContactDeadlineMs: 600,
    }, { onFatal: (err) => fatals.push(err), random: () => 1 });
    closers.unshift(() => sup.stop());

    expect(sup.state()).toBe("waiting");
    const waiting = await health(sup.healthPort);
    expect(waiting.status).toBe(503);
    expect(waiting.body).toMatchObject({
      healthy: false, unhealthyReason: "waiting_for_database", waitingForDatabaseCode: "FIRST_CONTACT_TIMEOUT",
    });
    expect(door.dials).toBe(1);

    // It leads on a dial of its own, with the mute session still open: nothing outside closed it.
    await ledWithin(sup, 15_000);
    expect(door.dials).toBeGreaterThan(1);
    expect(door.muted).toBe(1);
    expect(fatals).toHaveLength(0);
  }, 60_000);

  it("a takeover that never finishes ends at its bound as this instance's failure, so the lock is not held for good", async () => {
    const restore = surviveDriverWriteRace();
    closers.push(async () => { restore(); });
    const db = makeDb(DB);
    await seedFakeMailbox(db);
    const fleet = new FakeAdapterFleet();
    // The lock's dial is answered; every session after it goes mute at its first statement.
    const door = await DbDoor.to(DB).reserve();
    door.mute = (dial) => dial >= 2;
    closers.unshift(async () => { door.down(); });

    const fatals: unknown[] = [];
    const sup = await runWorkerSupervised({
      ...cfgFor(), databaseUrl: door.via(DB), adapterFactory: fleet.factory,
      dbWaitBaseMs: 100, dbWaitCapMs: 300, pollIntervalMs: 200, takeoverDeadlineMs: 1_200,
    }, { onFatal: (err) => fatals.push(err) });
    closers.unshift(() => sup.stop());
    expect(sup.state()).toBe("waiting");

    await door.up();
    // Until the bound it is a takeover like any other: the lock is its own and it answers 200.
    const taking = await waitForHealthBody(sup.healthPort, (v) => v.takingOver, 10_000);
    expect(taking).toMatchObject({ healthy: true, standby: true, leader: false });
    await waitUntil(() => fatals.length > 0, 10_000, "the takeover's bound");
    expect(sup.state()).toBe("failed");
    expect(fatals[0]).toMatchObject({ code: "TAKEOVER_TIMEOUT" });
    const h = await health(sup.healthPort);
    expect(h.status).toBe(503);
    expect(h.body).toMatchObject({ unhealthyReason: "fatal", error: "TakeoverTimeoutError TAKEOVER_TIMEOUT" });
  }, 60_000);

  /**
   * A timer holds 2^31 - 1 ms and runs a longer delay after 1 ms. The takeover's bound grows with the
   * mailbox ceiling and passes that at 11,924 mailboxes: every takeover was then overdue at once, and
   * a start on a healthy database exited.
   */
  it.each([
    { name: "a mailbox ceiling of 12,000", over: { maxMailboxes: 12_000 } },
    { name: "a mailbox ceiling of 100,000", over: { maxMailboxes: 100_000 } },
    { name: "a first-contact deadline of 2^31 ms", over: { firstContactDeadlineMs: 2 ** 31 } },
  ])("$name leads on a healthy database: a bound past what a timer holds is not overdue at once", async ({ over }) => {
    await seedFakeMailbox(makeDb(DB));
    const fatals: unknown[] = [];
    const sup = await runWorkerSupervised(
      { ...cfgFor(), ...over, adapterFactory: new FakeAdapterFleet().factory }, { onFatal: (err) => fatals.push(err) },
    );
    closers.unshift(() => sup.stop());

    expect(sup.state()).toBe("leader");
    await new Promise((r) => setTimeout(r, 300));        // a timer set to 1 ms would have run by now
    expect((await health(sup.healthPort)).body).toMatchObject({ healthy: true, leader: true, mailboxes: 1 });
    expect(fatals).toHaveLength(0);
  }, 30_000);

  it("a database that refuses the credential still fails the start at once, and nothing waits", async () => {
    // Not an outage: this deployment's own setting. Waiting on it would hide a broken deploy.
    const pg = await refusingPostgres("28P01");
    closers.push(async () => { pg.close(); });
    const u = new URL(DB);
    u.hostname = "127.0.0.1";
    u.port = String(pg.port);
    await expect(runWorkerSupervised({ ...cfgFor(), databaseUrl: u.toString(), dbWaitBaseMs: 50, dbWaitCapMs: 50 }))
      .rejects.toMatchObject({ code: "28P01" });
    await new Promise((r) => setTimeout(r, 300));
    expect(pg.dials()).toBe(1);                     // one dial, no retry behind the rejection
  }, 30000);

  it("a takeover that fails names the error's class on /health, never its message", async () => {
    vi.stubEnv(KEY_RING_V1, "");                     // no injected provider, no env KEK
    const held = await acquireLeaderLock(DB);
    const fatals: unknown[] = [];
    const sup = await runWorkerSupervised({
      databaseUrl: DB, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
      healthPort: 0, standbyRetryMs: RETRY_MS, healthDetailSecret: DETAIL,
    }, { onFatal: (err) => fatals.push(err) });
    closers.push(() => sup.stop());
    expect(sup.state()).toBe("standby");
    await held!.release();
    await waitUntil(() => sup.state() === "failed", 8000, "the takeover to fail");

    const h = await health(sup.healthPort);
    expect(h.status).toBe(503);
    expect(h.body).toMatchObject({ healthy: false, leader: false, unhealthyReason: "fatal", error: "Error" });
    expect(String((fatals[0] as Error).message)).toMatch(/KeyProvider/);     // the hook and the log keep it
  }, 30000);

  it("only a database that is away is waited for: the wait class is a closed list of codes", async () => {
    const at = (code: string): Promise<unknown> =>
      asDatabaseFault("first_contact", () => Promise.reject(Object.assign(new Error("x"), { code }))).catch((e: unknown) => e);
    for (const code of [
      "08006", "08001", "08P01", "57P01", "57P02", "57P03", "53300", "57014",
      "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND",
      "FIRST_CONTACT_TIMEOUT",
    ]) expect(databaseAwayCodeOf(await at(code)), code).toBe(code);
    for (const code of [
      "28P01", "28000", "3D000", "42501", "42P01", "42703", "XX000", "TF_CONFIG_INVALID", "KEK_RETIRED_VERSION_IN_USE",
      "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ]) expect(databaseAwayCodeOf(await at(code)), code).toBeNull();
    // An errno with no origin could be any remote's; it is the database's only under the tag.
    expect(databaseAwayCodeOf(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBeNull();
  });

  it("the wait grows, is capped, and is drawn from the upper half of its step", () => {
    const base = DEFAULT_DB_WAIT_BASE_MS;
    const cap = DEFAULT_DB_WAIT_CAP_MS;
    expect([0, 1, 2, 3, 9].map((n) => databaseWaitMs(n, base, cap, () => 1))).toEqual([5_000, 10_000, 20_000, 30_000, 30_000]);
    expect([0, 1, 2, 3, 9].map((n) => databaseWaitMs(n, base, cap, () => 0))).toEqual([2_500, 5_000, 10_000, 15_000, 15_000]);
    expect(databaseWaitMs(1_000_000, base, cap, () => 1)).toBe(cap);
    // …and never more than a timer holds, whatever cap it is given.
    expect(databaseWaitMs(40, base, 2 ** 40, () => 1)).toBe(2 ** 31 - 1);
  });
});
