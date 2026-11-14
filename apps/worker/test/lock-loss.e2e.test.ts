import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { mailboxes, mailboxCredentials, messages, type Tx } from "@trafficflow/db";
import { makeDb, makeOwnedDb, workerHeartbeats, claimHeartbeat, refreshHeartbeat } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core";
import { acquireLeaderLock, LEADER_LOCK_KEY, leaderLockKeyFor, type LeaderLock } from "../src/leader-lock.js";
import { runWorkerSupervised } from "../src/supervisor.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { DbDoor, surviveDriverWriteRace } from "./_dbdoor.js";

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

  it("release() on a session that no longer answers returns inside its bound, without a throw and without `lost`", async () => {
    const restore = surviveDriverWriteRace();
    closers.push(async () => { restore(); });
    const door = DbDoor.to(DB);
    await door.up();
    closers.push(async () => { door.down(); });
    const lock = await acquireLeaderLock(door.via(DB), LEADER_LOCK_KEY);
    expect(lock).not.toBeNull();
    let settled = false;
    void lock!.lost.then(() => { settled = true; });

    // Nothing passes and nothing closes: the unlock is written and never answered. It used to be
    // waited on for good, and a stop or a surrender waited with it.
    door.freeze(1);
    const outcome = await Promise.race([
      lock!.release().then(() => "returned", (err: unknown) => `threw ${String((err as Error).name)}`),
      new Promise<string>((resolve) => setTimeout(() => resolve("still waiting after 9 s"), 9_000)),
    ]);
    expect(outcome).toBe("returned");

    // Ending this side frees nothing at the server, which has not been told: the lock is the old
    // session's until the server lets it go, and then anyone's.
    expect(await acquireLeaderLock(DB, LEADER_LOCK_KEY)).toBeNull();
    await terminate(await lockHolders(LEADER_LOCK_KEY));
    let next: Awaited<ReturnType<typeof acquireLeaderLock>> = null;
    await waitFor(async () => (next = await acquireLeaderLock(DB, LEADER_LOCK_KEY)) !== null, 8000, "the lock to be free");
    closers.push(() => next!.release());
    expect(settled).toBe(false);           // a release is never a loss, answered or not
  }, 30000);

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

  // ── A LOCK SESSION THAT GOES MUTE ────────────────────────────────────────────────────────────
  //
  // Everything above ends the lock's session where the driver can see it. Here it stays open and
  // nothing answers (a path that drops packets): the server may end its half and free the lock, and
  // the leader is never told. Each instance dials through a door of its own; a start's first dial is
  // its lock session (nothing is retired, so no gate read comes before it).

  interface Line { event: string; errorCode: string | null }
  interface Instance {
    sup: Awaited<ReturnType<typeof runWorkerSupervised>>;
    started: Promise<void>;
    door: DbDoor; fleet: FakeAdapterFleet; lines: Line[]; fatals: unknown[];
    /** Turns this instance had started when it logged `leader_lock_lost`. */
    turnsWhenLost: number | null;
  }
  const HEARTBEAT_MS = 300;
  /** What a leader may go without a proof of its lock: three heartbeats, and one more for the tick that reads it. */
  const UNPROVEN_MS = 4 * HEARTBEAT_MS;

  /** Starts an instance without waiting for its start: `sup` is there once `started` has resolved. */
  async function launch(name: string, mailboxId: string, extra: Partial<WorkerConfig> = {}, door = DbDoor.to(DB)): Promise<Instance> {
    await door.up();
    const fleet = new FakeAdapterFleet();
    fleet.behave(mailboxId, { syncDelayMs: 40 });
    const turns = (): number => fleet.indicesOf(mailboxId, "sync_start").length;
    const self: Instance = {
      sup: null as unknown as Instance["sup"], started: Promise.resolve(), door, fleet, lines: [], fatals: [], turnsWhenLost: null,
    };
    const logger = createLogger({
      service: "worker",
      sink: (raw) => {
        const line = JSON.parse(raw) as { event?: unknown; errorCode?: unknown };
        const event = String(line.event);
        if (event === "leader_lock_lost") self.turnsWhenLost = turns();
        self.lines.push({ event, errorCode: typeof line.errorCode === "string" ? line.errorCode : null });
      },
    });
    self.started = runWorkerSupervised(
      cfgFor(fleet, {
        databaseUrl: door.via(DB), instanceId: `wkr-${name}`, logger, lockHeartbeatMs: HEARTBEAT_MS,
        dbWaitBaseMs: 100, dbWaitCapMs: 300, ...extra,
      }),
      { onFatal: (err) => self.fatals.push(err) }).then((sup) => { self.sup = sup; });
    // First out: a stop drains statements, and those on a session the door still holds never answer.
    closers.unshift(async () => {
      door.down();
      await Promise.race([self.started.catch(() => undefined), new Promise((r) => setTimeout(r, 8000))]);
      await (self.sup as Instance["sup"] | null)?.stop();
    });
    return self;
  }
  async function instance(name: string, mailboxId: string, extra: Partial<WorkerConfig> = {}): Promise<Instance> {
    const self = await launch(name, mailboxId, extra);
    await self.started;
    return self;
  }
  const eventsOf = (i: Instance): string[] => i.lines.map((l) => l.event);
  const lossCodes = (i: Instance): Array<string | null> =>
    i.lines.filter((l) => l.event === "leader_lock_lost").map((l) => l.errorCode);
  /** True once `cond` holds; false when it has not by `ms`. For a fact that is asserted afterwards. */
  async function seen(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
    try { await waitFor(cond, ms, "a sight"); return true; } catch { return false; }
  }
  /** Who the shard's heartbeat row names, or null when there is none. */
  async function rowNames(db: Db): Promise<string | null> {
    const rows = await db.select({ instanceId: workerHeartbeats.instanceId }).from(workerHeartbeats);
    return rows[0]?.instanceId ?? null;
  }
  const stateOf = (i: Instance): string => (i.sup as Instance["sup"] | null)?.state() ?? "starting";
  /**
   * A letter waiting at one instance's provider. The fake numbers a letter by its place in the list and
   * the cursor is the database's, so A's letter comes second, behind one in a folder of its own: in the
   * place of B's it would read as fetched already and prove nothing.
   */
  function letterFor(who: "a" | "b"): { id: string; deliver: Array<{ from: string; subject: string; messageId: string; folder?: string }> } {
    const id = `${randomUUID()}@from-${who}.example`;
    const letter = { from: "x@lichtgrat.example", subject: `to ${who}`, messageId: id };
    const ahead = { ...letter, messageId: `${randomUUID()}@ahead.example`, folder: "Elsewhere" };
    return { id, deliver: who === "a" ? [ahead, letter] : [letter] };
  }
  const written = async (db: Db, id: string): Promise<number> =>
    (await db.select({ id: messages.id }).from(messages).where(like(messages.messageIdHeader, `%${id}%`))).length;
  /** From its call until `stop()`: the most sessions seen holding the lock, how long both said leader, whom the row named. */
  function watch(db: Db, key: bigint, a: Instance, b: Instance): {
    stop: () => Promise<void>; saw: { mostHolders: number; bothLeaderMs: number; named: string[] };
  } {
    const saw = { mostHolders: 0, bothLeaderMs: 0, named: [] as string[] };
    let on = true;
    const loop = (async () => {
      let last = Date.now();
      while (on) {
        saw.mostHolders = Math.max(saw.mostHolders, (await lockHolders(key)).length);
        const name = await rowNames(db);
        if (name !== null && saw.named[saw.named.length - 1] !== name) saw.named.push(name);
        const now = Date.now();
        if (stateOf(a) === "leader" && stateOf(b) === "leader") saw.bothLeaderMs += now - last;
        last = now;
        await new Promise((r) => setTimeout(r, 25));
      }
    })();
    const stop = async (): Promise<void> => { on = false; await loop; };
    closers.unshift(stop);
    return { stop, saw };
  }

  it("a leader whose lock session went mute stops when a successor leads: it takes nothing back and writes no mail", async () => {
    const restore = surviveDriverWriteRace();
    closers.push(async () => { restore(); });
    const db = makeDb(DB);
    const mailboxId = await seedMailbox(db);
    const key = leaderLockKeyFor(0);

    const a = await instance("a", mailboxId);
    expect(a.sup.state()).toBe("leader");
    await waitFor(async () => (await health(a.sup.healthPort)).body.mailboxes === 1, 8000, "A to serve");
    const b = await instance("b", mailboxId);
    expect(b.sup.state()).toBe("standby");

    // The whole case: A's lock session is held by the door, and the server ends its half. The lock is
    // free and A's own connections (its pool) work on.
    a.door.freeze(1);
    expect(a.door.frozen).toBe(1);
    const holders = await lockHolders(key);
    expect(holders).toHaveLength(1);
    await terminate(holders);

    // From here on, sampled until the end: who holds the lock, who says leader, whom the row names.
    const watching = watch(db, key, a, b);

    await waitFor(() => b.sup.state() === "leader", 10000, "B, the lawful successor, to lead");
    // A is given the time it needs either to learn or to beat again: its turns end in a beat, and that
    // beat used to take the row back from B. Then one letter for each of them: whoever writes it shows
    // whom the fence lets write.
    const turnsOfA = (): number => a.fleet.indicesOf(mailboxId, "sync_start").length;
    const turnsWhenBLed = turnsOfA();
    await seen(() => a.sup.state() !== "leader" || turnsOfA() >= turnsWhenBLed + 3, 8000);
    const letterA = letterFor("a");
    const letterB = letterFor("b");
    a.fleet.behave(mailboxId, { deliver: letterA.deliver });
    b.fleet.behave(mailboxId, { deliver: letterB.deliver });

    // (a) A stops calling itself leader, and starts no turn once it knows.
    const aLeft = await seen(() => a.sup.state() !== "leader", UNPROVEN_MS + 6000);
    // (b) the letter is written once, by the one that holds the lock.
    const bWrote = await seen(async () => (await written(db, letterB.id)) === 1, 10000);
    // (e) A closes what it held, without the unlock's answer, and stands by behind B.
    const aStoodBy = await seen(() => a.sup.state() === "standby", 15000);
    const turnsAtEnd = turnsOfA();
    await watching.stop();
    const { named, mostHolders, bothLeaderMs } = watching.saw;

    expect.soft(aLeft, "(a) A still calls itself leader").toBe(true);
    expect.soft(a.turnsWhenLost, "(a) A never learned that its lock is gone").not.toBeNull();
    expect.soft(turnsAtEnd, "(a) A started a turn after it knew").toBe(a.turnsWhenLost);
    // Not by the driver seeing a close: the door held the session, so A learned from the row or from its own clock.
    expect.soft(lossCodes(a).every((c) => c === "LOCK_SUPERSEDED" || c === "LOCK_UNPROVEN" || c === "LOCK_FENCED"),
      `(a) A's loss was ${JSON.stringify(lossCodes(a))}`).toBe(true);
    expect.soft(bWrote, "(b) B, which holds the lock, did not write its letter").toBe(true);
    expect.soft(await written(db, letterA.id), "(b) A, which holds no lock, wrote a letter").toBe(0);
    // (c) from B's claim on the row never names A again.
    const firstB = named.findIndex((n) => n.startsWith("wkr-b"));
    expect.soft(firstB, "(c) the row never named B").toBeGreaterThanOrEqual(0);
    expect.soft(named.slice(firstB).filter((n) => n.startsWith("wkr-a")), "(c) A took the row back").toEqual([]);
    // (d) the lawful leader is never refused and never deposed.
    expect.soft(eventsOf(b).filter((e) => e === "sync_cycle_fenced" || e === "leader_lock_lost"), "(d) B was refused").toEqual([]);
    // (e) no exit on either side, and A's close ended by itself.
    expect.soft(aStoodBy, "(e) A did not come to stand by behind B").toBe(true);
    expect.soft(eventsOf(a).filter((e) => e === "surrender_timed_out" || e === "lock_release_failed"), "(e) A's close").toEqual([]);
    expect.soft([...a.fatals, ...b.fatals], "(e) a fatal").toHaveLength(0);
    // (f) one holder of the lock at most on every read, and two `leader` answers only until A's next renewal.
    expect.soft(mostHolders, "(f) two sessions held the lock").toBeLessThanOrEqual(1);
    expect.soft(bothLeaderMs, "(f) both said leader for that long").toBeLessThan(UNPROVEN_MS + 3000);
    expect(b.sup.state()).toBe("leader");
  }, 90000);

  it("with nobody contending, a leader that cannot prove its lock stops inside its bound and leads again on a new session", async () => {
    const restore = surviveDriverWriteRace();
    closers.push(async () => { restore(); });
    const db = makeDb(DB);
    const mailboxId = await seedMailbox(db);
    const key = leaderLockKeyFor(0);
    const a = await instance("a", mailboxId);
    await waitFor(async () => (await health(a.sup.healthPort)).body.mailboxes === 1, 8000, "A to serve");
    const firstName = await rowNames(db);

    a.door.freeze(1);
    expect(a.door.frozen).toBe(1);
    await terminate(await lockHolders(key));
    await waitFor(async () => (await lockHolders(key)).length === 0, 5000, "the server to free the lock");

    // No successor ever claims, so nothing but its own clock can tell it. It used to answer `leader`
    // for good here, with no session holding the lock anywhere.
    const left = await seen(() => a.sup.state() !== "leader", UNPROVEN_MS + 6000);
    expect(left, "it still calls itself leader, and nothing holds the lock").toBe(true);
    expect(lossCodes(a)).toEqual(["LOCK_UNPROVEN"]);

    // The old session is ended without the unlock's answer, the lock taken on a new one, in this process.
    await waitFor(() => eventsOf(a).filter((e) => e === "leader_acquired").length === 2 && a.sup.state() === "leader",
      20000, "A to lead again");
    const order = eventsOf(a).filter((e) => ["leader_acquired", "leader_lock_lost", "leadership_surrendered", "surrender_timed_out"].includes(e));
    expect(order).toEqual(["leader_acquired", "leader_lock_lost", "leadership_surrendered", "leader_acquired"]);
    expect(a.fatals).toHaveLength(0);
    expect(await lockHolders(key)).toHaveLength(1);
    await waitFor(async () => (await health(a.sup.healthPort)).body.mailboxes === 1, 8000, "A to serve again");
    // A second leadership is a second claim, under a name of its own.
    const secondName = await rowNames(db);
    expect(secondName).toMatch(/^wkr-a:/);
    expect(secondName).not.toBe(firstName);
  }, 90000);

  it("a mute session the server still runs is ended by its own process's next attempt, which then leads", async () => {
    const restore = surviveDriverWriteRace();
    closers.push(async () => { restore(); });
    const db = makeDb(DB);
    const mailboxId = await seedMailbox(db);
    const key = leaderLockKeyFor(0);
    const a = await instance("a", mailboxId);
    await waitFor(async () => (await health(a.sup.healthPort)).body.mailboxes === 1, 8000, "A to serve");
    const [first] = await lockHolders(key);

    // Held by the door and NOT ended at the server: the old session keeps the lock there, for as long
    // as the server takes to notice a peer that is gone (hours, by default). Nobody else can lead on it.
    a.door.freeze(1);
    await waitFor(() => a.sup.state() !== "leader", UNPROVEN_MS + 6000, "A to stop leading");
    expect(lossCodes(a)).toEqual(["LOCK_UNPROVEN"]);

    await waitFor(() => eventsOf(a).filter((e) => e === "leader_acquired").length === 2 && a.sup.state() === "leader",
      25000, "A to lead again");
    expect(eventsOf(a)).toContain("lock_ghost_evicted");
    const holders = await lockHolders(key);
    expect(holders).toHaveLength(1);
    expect(holders[0]).not.toBe(first);
    expect(a.fatals).toHaveLength(0);
    await waitFor(async () => (await health(a.sup.healthPort)).body.mailboxes === 1, 8000, "A to serve again");
  }, 90000);

  // ── A CLAIM THAT IS HELD ON ITS WAY ──────────────────────────────────────────────────────────
  //
  // A takeover's claim of the heartbeat row is two statements on a pool session, and the lock lives on
  // another. Here the pool session goes silent with the claim half sent, the lock's session is ended at
  // the server and a successor takes the shard; the rest of the claim arrives late. It used to land:
  // written on an answer that was no longer true, over the successor's claim.

  it("a takeover's claim that arrives after a successor's takes nothing: the row stays the successor's and only the lock holder writes mail", async () => {
    const restore = surviveDriverWriteRace();
    closers.push(async () => { restore(); });
    const db = makeDb(DB);
    const mailboxId = await seedMailbox(db);
    const key = leaderLockKeyFor(0);

    // A wins the lock and starts its claim, which the door holds at its write. A long heartbeat: A is
    // to learn from the claim's answer, not from its own bound.
    const doorA = DbDoor.to(DB);
    doorA.holdAt = (text) => doorA.held.length === 0 && text.includes('insert into "worker_heartbeats"');
    const a = await launch("a", mailboxId, { lockHeartbeatMs: 20_000 }, doorA);
    await waitFor(() => doorA.held.length === 1, 20000, "A's claim to be on its way");
    const holders = await lockHolders(key);
    expect(holders).toHaveLength(1);
    doorA.freeze(1);
    await terminate(holders);

    // B takes the shard, claims it and writes a letter. It renews seconds apart, as a shipped one does.
    const b = await instance("b", mailboxId, { lockHeartbeatMs: 5000, pollIntervalMs: 5000 });
    await waitFor(() => b.sup.state() === "leader", 10000, "B, the lawful successor, to lead");
    const watching = watch(db, key, a, b);
    const letterB = letterFor("b");
    b.fleet.behave(mailboxId, { deliver: letterB.deliver });
    await waitFor(async () => (await written(db, letterB.id)) === 1, 20000, "B to write its letter");

    // A's letter waits at its provider, and the rest of its claim is let through.
    const letterA = letterFor("a");
    a.fleet.behave(mailboxId, { deliver: letterA.deliver });
    doorA.thaw(doorA.held[0]!);

    // A is told no, gives up what it holds and stands by behind B.
    const aStoodBy = await seen(() => stateOf(a) === "standby", 20000);
    await new Promise((r) => setTimeout(r, 1500));               // and nothing comes after the fact either
    await watching.stop();

    // One claim, B's: the row never names A, and B never has to claim again.
    expect.soft(watching.saw.named.map((n) => n.replace(/:[0-9a-f]{8}$/, ""))).toEqual(["wkr-b"]);
    expect.soft(await written(db, letterA.id), "A, which holds no lock, wrote its letter").toBe(0);
    expect.soft(await written(db, letterB.id)).toBe(1);
    expect.soft(eventsOf(b).filter((e) => e === "sync_cycle_fenced" || e === "leader_lock_lost"), "B, which holds the lock, was refused").toEqual([]);
    expect.soft(eventsOf(a).filter((e) => e === "leader_acquired"), "A led without the lock").toEqual([]);
    expect.soft(lossCodes(a)).toEqual(["LOCK_UNCLAIMED"]);
    expect.soft(aStoodBy, "A did not come to stand by behind B").toBe(true);
    expect.soft(watching.saw.mostHolders).toBeLessThanOrEqual(1);
    expect.soft([...a.fatals, ...b.fatals]).toHaveLength(0);
    expect(b.sup.state()).toBe("leader");
  }, 90000);

  const pulseOf = (instanceId: string): Parameters<typeof claimHeartbeat>[1] => ({
    shardIndex: 0, instanceId, shards: 1, mailboxes: 0, expected: 0, accounts: 0, quarantined: 0,
    degraded: false, aiCircuitOpenSince: null, lastCycleAt: null, startedAt: new Date(),
  });
  const sessionOf = (lock: LeaderLock): Parameters<typeof claimHeartbeat>[2] =>
    ({ pid: lock.backendPid, key: leaderLockKeyFor(0), mark: lock.mark });
  /** The shard's lock, once whoever held it has let go at the server. */
  async function lockOnceFree(): Promise<LeaderLock> {
    for (const start = Date.now(); Date.now() - start < 8000;) {
      const lock = await acquireLeaderLock(DB, leaderLockKeyFor(0));
      if (lock) { closers.push(() => lock.release()); return lock; }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error("the lock was not free after 8 s");
  }

  // The claim alone, held at each of its two statements. The row never names the old one either way.
  for (const [where, statement] of [["its write", 'insert into "worker_heartbeats"'], ["its question", "from pg_locks"]] as const) {
    it(`a claim held at ${where} while its lock goes to a successor is refused when it arrives`, async () => {
      const restore = surviveDriverWriteRace();
      closers.push(async () => { restore(); });
      const db = makeDb(DB);
      const door = DbDoor.to(DB);
      door.holdAt = (text) => door.held.length === 0 && text.includes(statement);
      await door.up();
      closers.push(async () => { door.down(); });
      const pool = makeOwnedDb(door.via(DB));                    // the worker's own kind of pool
      closers.push(() => pool.close());

      const first = await lockOnceFree();
      const late = claimHeartbeat(pool.db as unknown as Tx, pulseOf("wkr-first"), sessionOf(first));
      void late.catch(() => undefined);                          // a case that fails early leaves it to the door's end
      await waitFor(() => door.held.length === 1, 8000, "the claim to be held");

      await terminate([first.backendPid]);
      const next = await lockOnceFree();
      let landed = false;
      const successor = claimHeartbeat(db as unknown as Tx, pulseOf("wkr-next"), sessionOf(next)).then((v) => { landed = true; return v; });
      if (where === "its write") {
        // Nothing of the old claim is at the server yet: the successor's lands at once.
        await waitFor(() => landed, 8000, "the successor's claim to land");
        expect(await rowNames(db)).toBe("wkr-next");
      } else {
        // The old claim's write is there, uncommitted, and holds the row: the successor's waits for its end.
        await new Promise((r) => setTimeout(r, 300));
        expect(landed, "the successor's claim did not wait behind the old one's").toBe(false);
        expect(await rowNames(db)).toBeNull();
      }
      door.thaw(door.held[0]!);

      expect(await late).toBe(false);
      expect(await successor).toBe(true);
      expect(await rowNames(db)).toBe("wkr-next");
      expect(await refreshHeartbeat(db as unknown as Tx, pulseOf("wkr-next"))).toBe(true);
    }, 30000);
  }

  const beatAt = async (db: Db): Promise<number> =>
    (await db.select({ beatAt: workerHeartbeats.beatAt }).from(workerHeartbeats))[0]?.beatAt.getTime() ?? 0;

  it("a pulse that comes before the claim deposes nobody", async () => {
    const db = makeDb(DB);
    const mailboxId = await seedMailbox(db);
    // The shard's row is held by an open transaction, so the takeover's claim has to wait while the
    // lock's timer ticks on: a renewal in that gap finds no row of its own.
    const admin = postgres(DB, { max: 1 });
    closers.push(() => admin.end({ timeout: 5 }));
    let letGo: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { letGo = resolve; });
    let holding: () => void = () => undefined;
    const isHolding = new Promise<void>((resolve) => { holding = resolve; });
    const held = admin.begin(async (tx) => {
      await tx`INSERT INTO worker_heartbeats (shard_index, instance_id, leader) VALUES (0, 'nobody', false)`;
      holding();
      await gate;
      throw new Error("rolled back on purpose");
    }).catch(() => undefined);
    await isHolding;

    const starting = instance("a", mailboxId, { lockHeartbeatMs: 200 });
    await new Promise((r) => setTimeout(r, 1000));           // five heartbeats with the claim still waiting
    letGo();
    await held;
    const a = await starting;

    expect(a.sup.state()).toBe("leader");
    expect(eventsOf(a)).not.toContain("leader_lock_lost");
    expect(await rowNames(db)).toMatch(/^wkr-a:/);
  }, 60000);

  /** For the cases where a lock must NOT be lost: a heartbeat with room in it, so a loaded host decides nothing. */
  const CALM_MS = 1000;

  it("a lock session that answers late, inside the bound, deposes nobody and the pulse goes on", async () => {
    const restore = surviveDriverWriteRace();
    closers.push(async () => { restore(); });
    const db = makeDb(DB);
    const mailboxId = await seedMailbox(db);
    const a = await instance("a", mailboxId, { lockHeartbeatMs: CALM_MS });
    await waitFor(async () => (await health(a.sup.healthPort)).body.mailboxes === 1, 8000, "A to serve");
    // One long turn, so that no rotation ends meanwhile: the timer's pulse alone moves the row.
    const turns = a.fleet.indicesOf(mailboxId, "sync_start").length;
    a.fleet.behave(mailboxId, { syncDelayMs: 8000 });
    await waitFor(() => a.fleet.indicesOf(mailboxId, "sync_start").length > turns, 8000, "a long turn");

    a.door.freeze(1);
    await new Promise((r) => setTimeout(r, 2.2 * CALM_MS));      // two heartbeats ask and get no answer: inside three
    const before = await beatAt(db);
    a.door.thaw(1);

    await waitFor(async () => (await beatAt(db)) > before, 8000, "the pulse to go on");
    await new Promise((r) => setTimeout(r, 2 * CALM_MS));        // and nothing comes after the fact either
    expect(eventsOf(a)).not.toContain("leader_lock_lost");
    expect(a.sup.state()).toBe("leader");
  }, 60000);

  it("one check of the lock that the database rejects deposes nobody: it is asked again", async () => {
    const db = makeDb(DB);
    const mailboxId = await seedMailbox(db);
    const a = await instance("a", mailboxId, { lockHeartbeatMs: CALM_MS });
    await waitFor(async () => (await health(a.sup.healthPort)).body.mailboxes === 1, 8000, "A to serve");
    const [pid] = await lockHolders(leaderLockKeyFor(0));

    // The check reads `pg_locks`. Under an exclusive lock on that view it waits at the server, and a
    // cancel then rejects it (57014) on a session that is otherwise sound.
    const admin = postgres(DB, { max: 2 });
    closers.push(() => admin.end({ timeout: 5 }));
    await admin.begin(async (tx) => {
      await tx`LOCK TABLE pg_catalog.pg_locks IN ACCESS EXCLUSIVE MODE`;
      await waitFor(async () =>
        (await admin`SELECT 1 FROM pg_stat_activity WHERE pid = ${pid!} AND wait_event_type = 'Lock'`).length === 1,
      8000, "the check to wait");
      await admin`SELECT pg_cancel_backend(${pid!})`;
    });
    await waitFor(() => eventsOf(a).includes("lock_verify_failed"), 5000, "the rejected check to be logged");

    const before = await beatAt(db);
    await waitFor(async () => (await beatAt(db)) > before, 8000, "the pulse to go on");
    await new Promise((r) => setTimeout(r, 2 * CALM_MS));
    expect(eventsOf(a).filter((e) => e === "lock_verify_failed")).toHaveLength(1);
    expect(eventsOf(a)).not.toContain("leader_lock_lost");
    expect(a.sup.state()).toBe("leader");
  }, 60000);

  it("a database that stops answering the pool, with the lock's session alive, is not a lost lock", async () => {
    const restore = surviveDriverWriteRace();
    closers.push(async () => { restore(); });
    const db = makeDb(DB);
    const mailboxId = await seedMailbox(db);
    const a = await instance("a", mailboxId, { lockHeartbeatMs: CALM_MS });
    await waitFor(async () => (await health(a.sup.healthPort)).body.mailboxes === 1, 8000, "A to serve");

    // Every session but the lock's goes mute, and every later dial at its first statement: the
    // renewals never answer. The lock is proven on its own session, so the verdict stays the cycle's.
    a.door.mute = (dial) => dial >= 2;
    for (let dial = 2; dial <= a.door.dials; dial++) { try { a.door.freeze(dial); } catch { /* that one has closed */ } }
    expect(a.door.frozen).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 5 * CALM_MS));        // past the heartbeats that would depose it
    expect(eventsOf(a)).not.toContain("leader_lock_lost");
    expect(a.sup.state()).toBe("leader");
    expect((await health(a.sup.healthPort)).body).toMatchObject({ leader: true });
  }, 60000);
});
