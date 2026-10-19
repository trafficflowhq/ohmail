import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { mailboxes, mailboxCredentials, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core";
import { startWorker, type RunningWorker } from "../src/index.js";
import { leaderLockKeyFor } from "../src/leader-lock.js";
import { ALLOW_ANY_DIAL_HOST } from "../src/dial-host-guard.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { ORGANIZER_CONSENT, byMessageId } from "./_workerdb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  ONE SLOW PROVIDER NO LONGER HOLDS EVERY OTHER MAILBOX UNCONNECTED
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * CLOUD-ROSTER-REATTACH-IS-SERIAL: a roster pass re-attached mailboxes one at a time, inside the one
 * serial queue, so a provider that took 107 s to answer (2026-10-09) held every mailbox behind it
 * unconnected and every doorbell of the mailboxes still connected. Attaches now run in a pool: at
 * most N at once, one per provider host, each under its own deadline.
 *
 * Each mailbox here sits on a host of its own unless a case says otherwise, so the host key is the
 * variable under test. A slow provider is a connect PARKED on a gate (or hung until it is
 * force-closed), never a sleep: every claim is an order or a presence read while it is parked. The
 * one duration this file reports is printed, never asserted.
 *
 * Real Postgres, isolated database, fake providers.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 53));
const ROSTER_MS = 150;
let DB = "";
type Db = ReturnType<typeof makeDb>;

async function seedMailbox(db: Db, host: string): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, ...ORGANIZER_CONSENT }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host, port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

/** `label` may be a function, so a trace in it is read when the wait fails, not when it starts. */
async function waitFor(
  cond: () => boolean | Promise<boolean>, ms: number, label: string | (() => string),
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${typeof label === "function" ? label() : label}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function cfgFor(fleet: FakeAdapterFleet, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, sentDomain: "trafficflow.test",
    adapterFactory: fleet.factory,
    pollIntervalMs: 80, rosterIntervalMs: ROSTER_MS, lockHeartbeatMs: 60_000,
    alertIntervalMs: 600_000, maxSyncFailures: 50, mailboxRetryMs: 60_000,
    ...over,
  };
}

/** Every line the worker logs, after the real logger's allow-list. */
function recorder(): { logger: ReturnType<typeof createLogger>; of: (event: string) => Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    service: "worker", level: "info",
    sink: (line) => { lines.push(JSON.parse(line) as Record<string, unknown>); },
  });
  return { logger, of: (event) => lines.filter((l) => l.event === event) };
}

/** A gate for one mailbox's NEXT connect, and its release. */
function parkConnect(fleet: FakeAdapterFleet, mailboxId: string): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fleet.behave(mailboxId, { gate });
  return () => { fleet.behave(mailboxId, { gate: undefined }); release(); };
}

function parkSync(fleet: FakeAdapterFleet, mailboxId: string): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fleet.behave(mailboxId, { syncGate: gate });
  return () => { fleet.behave(mailboxId, { syncGate: undefined }); release(); };
}

async function landed(db: Db, mailboxId: string, messageId: string): Promise<boolean> {
  const rows = await db.select({ id: messages.id }).from(messages).where(byMessageId(mailboxId, messageId));
  return rows.length > 0;
}

async function rowOf(db: Db, id: string) {
  const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, id));
  return row!;
}

/** `[connect_start, watch]` index pairs of one mailbox's attaches, in order. */
function attachIntervals(fleet: FakeAdapterFleet, mailboxId: string): Array<[number, number]> {
  const starts = fleet.indicesOf(mailboxId, "connect_start");
  const watches = fleet.indicesOf(mailboxId, "watch");
  return starts.map((s) => [s, watches.find((w) => w > s) ?? Infinity]);
}

describe("roster re-attach is bounded-parallel", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_roster_parallel_attach"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const releases: Array<() => void> = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const r of releases.splice(0)) { try { r(); } catch { /* ignore */ } }
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  async function boot(fleet: FakeAdapterFleet, over: Partial<WorkerConfig> = {}): Promise<RunningWorker> {
    const worker = await startWorker(cfgFor(fleet, over));
    closers.push(() => worker.stop());
    return worker;
  }

  // ── a storm while one re-dial is parked ──────────────────────────────────────────────────────
  it("re-attaches and serves every other mailbox while one provider's re-dial is parked", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const rec = recorder();
    // S FIRST: the roster is oldest-first, so a serial pass reaches the slow host before the rest.
    const S = await seedMailbox(db, "slow.fake.invalid");
    const Fa = await seedMailbox(db, "f1.fake.invalid");
    const Fb = await seedMailbox(db, "f2.fake.invalid");
    const W = await seedMailbox(db, "w.fake.invalid");
    const worker = await boot(fleet, { logger: rec.logger });
    await waitFor(() => worker.stats().mailboxes === 4, 10_000, "all four attached");
    await waitFor(() => [S, Fa, Fb, W].every((m) => fleet.indicesOf(m.mailboxId, "sync_end").length > 0),
      10_000, "a first cycle for each");

    // The storm: three connections end at once, and S's provider stops answering its re-dial.
    releases.push(parkConnect(fleet, S.mailboxId));
    const t0 = Date.now();
    for (const m of [S, Fa, Fb]) fleet.closeConnection(m.mailboxId);
    fleet.behave(Fa.mailboxId, { deliver: [{ from: "anna@x.example", subject: "f1", messageId: "storm-f1@x" }] });
    fleet.behave(Fb.mailboxId, { deliver: [{ from: "anna@x.example", subject: "f2", messageId: "storm-f2@x" }] });
    fleet.behave(W.mailboxId, { deliver: [{ from: "anna@x.example", subject: "w", messageId: "storm-w@x" }] });
    fleet.signal.get(W.mailboxId)!();

    await waitFor(() => fleet.indicesOf(S.mailboxId, "connect_start").length === 2, 10_000, "S's re-dial to park");
    const at: Record<string, number> = {};
    for (const [name, m, id] of [["Fa", Fa, "storm-f1@x"], ["Fb", Fb, "storm-f2@x"], ["W", W, "storm-w@x"]] as const) {
      await waitFor(() => landed(db, m.mailboxId, id), 10_000,
        () => `${name}'s letter while S's re-dial is parked — trace: ${fleet.describeTrace()}`);
      at[name] = Date.now() - t0;
    }
    for (const m of [Fa, Fb]) {
      expect(fleet.indicesOf(m.mailboxId, "watch").length, "re-attached and watched").toBe(2);
    }
    expect(fleet.indicesOf(S.mailboxId, "connect").length, "S is still parked").toBe(1);
    expect(worker.stats().mailboxes).toBe(3);

    // A mailbox that appears mid-park is adopted too.
    const N = await seedMailbox(db, "n.fake.invalid");
    await waitFor(() => fleet.indicesOf(N.mailboxId, "watch").length === 1, 10_000, "N adopted while S is parked");
    expect(worker.stats().mailboxes).toBe(4);
    expect(worker.stats().causes.dutyGap, "S being attached is accounted for").toBe(false);
    expect(rec.of("roster_invariant_violated")).toEqual([]);
    expect(fleet.indicesOf(S.mailboxId, "connect").length, "S is still parked").toBe(1);

    const parkedMs = Date.now() - t0;
    releases.splice(0).forEach((r) => r());
    await waitFor(() => worker.stats().mailboxes === 5, 10_000, "S attached once its provider answers");
    await sleep(ROSTER_MS * 3);
    // A pass can still be late behind a long cycle on a 150 ms interval; none waited out S's dial.
    const delays = rec.of("roster_pass_delayed").map((l) => Number(l.latencyMs));
    expect(delays.filter((ms) => ms >= parkedMs), `a roster pass waited on S's dial (parked ${parkedMs} ms)`).toEqual([]);
    // Reported, never asserted: how long each letter waited behind the storm.
    console.info(`storm → landed: ${JSON.stringify(at)} ms; S parked ${parkedMs} ms; pass delays ${JSON.stringify(delays)}`);
  }, 60_000);

  // ── one attach per host ──────────────────────────────────────────────────────────────────────
  it("never attaches two mailboxes of one host at once, and lets another host's through", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const worker = await boot(fleet);
    const H1 = await seedMailbox(db, "shared.fake.invalid");
    releases.push(parkConnect(fleet, H1.mailboxId));
    const H2 = await seedMailbox(db, "SHARED.fake.invalid.");
    const H3 = await seedMailbox(db, "shared.fake.invalid");
    const O = await seedMailbox(db, "other.fake.invalid");

    await waitFor(() => fleet.indicesOf(O.mailboxId, "watch").length === 1, 10_000,
      () => `O attached while H1 is parked — trace: ${fleet.describeTrace()}`);
    await sleep(ROSTER_MS * 3);
    expect(fleet.indicesOf(H2.mailboxId, "connect_start"), "H2 dialled beside H1 on one host").toEqual([]);
    expect(fleet.indicesOf(H3.mailboxId, "connect_start"), "H3 dialled beside H1 on one host").toEqual([]);

    releases.splice(0).forEach((r) => r());
    await waitFor(() => worker.stats().mailboxes === 4, 10_000, "every mailbox attached");
    const spans = [H1, H2, H3].flatMap((m) => attachIntervals(fleet, m.mailboxId));
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]![0], `two attaches of one host overlapped — trace: ${fleet.describeTrace()}`)
        .toBeGreaterThan(spans[i - 1]![1]);
    }
  }, 60_000);

  it("the control: a second mailbox on ANOTHER host attaches beside a parked one", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    await boot(fleet);
    const H1 = await seedMailbox(db, "shared.fake.invalid");
    releases.push(parkConnect(fleet, H1.mailboxId));
    const H2 = await seedMailbox(db, "elsewhere.fake.invalid");
    await waitFor(() => fleet.indicesOf(H2.mailboxId, "watch").length === 1, 10_000, "H2 attached beside parked H1");
    expect(fleet.indicesOf(H1.mailboxId, "connect")).toEqual([]);
  }, 60_000);

  // ── the bound ────────────────────────────────────────────────────────────────────────────────
  for (const [setting, mailboxCount, want] of [[undefined, 8, 4], [2, 8, 2], [32, 10, 8]] as const) {
    it(`holds the bound with attachConcurrency ${setting ?? "unset"}: ${want} at once`, async () => {
      const db = makeDb(DB);
      const fleet = new FakeAdapterFleet();
      await boot(fleet, setting === undefined ? {} : { attachConcurrency: setting });
      const seeded = [];
      for (let i = 0; i < mailboxCount; i++) {
        const m = await seedMailbox(db, `h${i}.fake.invalid`);
        releases.push(parkConnect(fleet, m.mailboxId));
        seeded.push(m);
      }
      await waitFor(() => fleet.connectInFlight >= Math.min(want, mailboxCount), 10_000,
        () => `${want} dials in flight — peak ${fleet.connectPeak}`);
      await sleep(ROSTER_MS * 3);
      expect(fleet.connectPeak).toBe(want);
      expect(fleet.connectInFlight).toBe(want);
    }, 60_000);
  }

  // ── the deadline ─────────────────────────────────────────────────────────────────────────────
  it("gives up on a hung dial at its deadline, backs it off as a timeout, and frees its host", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const worker = await boot(fleet, { attachDeadlineMs: 1_500 });
    const S = await seedMailbox(db, "hung.fake.invalid");
    fleet.behave(S.mailboxId, { hangConnect: true });
    const H2 = await seedMailbox(db, "hung.fake.invalid");
    const F = await seedMailbox(db, "fine.fake.invalid");

    await waitFor(() => fleet.indicesOf(F.mailboxId, "watch").length === 1, 10_000, "F attached beside the hung dial");
    await waitFor(async () => (await rowOf(db, S.mailboxId)).errorCode === "timeout", 15_000,
      () => `S quarantined as a timeout — trace: ${fleet.describeTrace()}`);
    expect(fleet.indicesOf(S.mailboxId, "force_close").length, "the hung connection was force-closed").toBe(1);
    await waitFor(() => fleet.indicesOf(H2.mailboxId, "watch").length === 1, 10_000, "H2 attached once its host was free");
    expect(fleet.nth(H2.mailboxId, "connect_start", 1), "H2 dialled before S's attach let go of the host")
      .toBeGreaterThan(fleet.nth(S.mailboxId, "force_close", 1));
    await sleep(ROSTER_MS * 4);
    expect(fleet.indicesOf(S.mailboxId, "connect_start").length, "S re-dialled inside its backoff").toBe(1);
    expect(fleet.openFor(S.mailboxId)).toBe(0);
    expect(worker.stats().mailboxes).toBe(2);
    expect(worker.stats().quarantined).toBe(1);
  }, 60_000);

  it("quarantines a lease read that hangs past the deadline as a timeout, not as an unreadable lease", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const rec = recorder();
    await boot(fleet, { attachDeadlineMs: 1_500, logger: rec.logger });
    const S = await seedMailbox(db, "meta.fake.invalid");
    fleet.behave(S.mailboxId, { hangMeta: true });
    await waitFor(async () => (await rowOf(db, S.mailboxId)).errorCode === "timeout", 15_000,
      () => `S quarantined as a timeout — trace: ${fleet.describeTrace()}`);
    await sleep(ROSTER_MS * 4);
    expect(fleet.indicesOf(S.mailboxId, "connect_start").length, "S re-dialled with no backoff").toBe(1);
    expect(rec.of("mailbox_attach_deadline").length).toBe(1);
  }, 60_000);

  it("isolates an ordinary connect failure", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const worker = await boot(fleet);
    const X = await seedMailbox(db, "refusing.fake.invalid");
    fleet.behave(X.mailboxId, { connectError: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    const F = await seedMailbox(db, "fine.fake.invalid");
    await waitFor(() => fleet.indicesOf(F.mailboxId, "watch").length === 1, 10_000, "F attached");
    await waitFor(async () => (await rowOf(db, X.mailboxId)).status === "error", 10_000, "X quarantined");
    expect(worker.stats()).toMatchObject({ mailboxes: 1, quarantined: 1 });
  }, 60_000);

  // ── shutdown and lock loss ───────────────────────────────────────────────────────────────────
  it("stops with an attach hung in its dial: force-closes it, writes nothing and frees the lock", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const worker = await startWorker(cfgFor(fleet));
    const S = await seedMailbox(db, "hung.fake.invalid");
    fleet.behave(S.mailboxId, { hangConnect: true });
    await waitFor(() => fleet.indicesOf(S.mailboxId, "connect_start").length === 1, 10_000, "S's dial to hang");

    const stopped = await Promise.race([
      worker.stop().then(() => true),
      sleep(10_000).then(() => false),
    ]);
    if (!stopped) closers.push(() => worker.stop());
    expect(stopped, "stop() never resolved behind a hung attach").toBe(true);
    expect(fleet.indicesOf(S.mailboxId, "force_close").length).toBe(1);
    expect(fleet.openCount).toBe(0);
    const row = await rowOf(db, S.mailboxId);
    expect(row.errorCode, "a stop wrote a failure on the mailbox it interrupted").toBeNull();
    expect(row.retryAfter).toBeNull();
    // The lock is free: a successor takes it.
    const next = await startWorker(cfgFor(new FakeAdapterFleet()));
    await next.stop();
  }, 60_000);

  it("force-closes an attach hung in its dial when the leader lock is lost", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    let lost = false;
    const worker = await startWorker(cfgFor(fleet), { onLockLost: () => { lost = true; } });
    closers.push(() => worker.stop());
    const S = await seedMailbox(db, "hung.fake.invalid");
    fleet.behave(S.mailboxId, { hangConnect: true });
    await waitFor(() => fleet.indicesOf(S.mailboxId, "connect_start").length === 1, 10_000, "S's dial to hang");

    const admin = postgres(DB, { max: 1 });
    try {
      const key = leaderLockKeyFor(0);
      const rows = await admin<{ pid: number }[]>`
        SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND ((classid::bigint << 32) + objid::bigint) = ${key as unknown as number}`;
      for (const r of rows) await admin`SELECT pg_terminate_backend(${r.pid})`;
    } finally { await admin.end({ timeout: 5 }); }

    await waitFor(() => lost, 10_000, "the lock loss to be observed");
    await waitFor(() => fleet.indicesOf(S.mailboxId, "force_close").length === 1, 10_000,
      "the hung attach force-closed on lock loss");
    expect(fleet.openCount).toBe(0);
  }, 60_000);

  // ── a mailbox disabled while it waits ────────────────────────────────────────────────────────
  it("never dials a mailbox disabled while it waited behind its host", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const worker = await boot(fleet);
    const S = await seedMailbox(db, "shared.fake.invalid");
    const release = parkConnect(fleet, S.mailboxId);
    releases.push(release);
    const Q = await seedMailbox(db, "shared.fake.invalid");
    await waitFor(() => fleet.indicesOf(S.mailboxId, "connect_start").length === 1, 10_000, "S's dial to park");
    await waitFor(() => worker.stats().expected === 2, 10_000, "a pass that queued Q");
    expect(fleet.indicesOf(Q.mailboxId, "connect_start")).toEqual([]);

    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, Q.mailboxId));
    // A pass that read the disable, if passes run beside the parked dial. A serial pass cannot.
    await waitFor(() => worker.stats().expected === 1, 5_000, "a pass that read the disable").catch(() => undefined);
    release();
    await waitFor(() => fleet.indicesOf(S.mailboxId, "watch").length === 1, 10_000, "S attached");
    await sleep(ROSTER_MS * 4);
    expect(fleet.indicesOf(Q.mailboxId, "connect_start"), "Q was dialled from a stale row").toEqual([]);
  }, 60_000);

  // ── boot ─────────────────────────────────────────────────────────────────────────────────────
  it("attaches at boot in parallel and still waits for every boot attach before serving", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const S = await seedMailbox(db, "slow.fake.invalid");
    const F = await seedMailbox(db, "fast.fake.invalid");
    const release = parkConnect(fleet, S.mailboxId);
    releases.push(release);
    let started = false;
    const starting = startWorker(cfgFor(fleet)).then((w) => { started = true; closers.push(() => w.stop()); return w; });
    await waitFor(() => fleet.indicesOf(F.mailboxId, "watch").length === 1, 10_000,
      () => `F attached while S is parked at boot — trace: ${fleet.describeTrace()}`);
    await sleep(ROSTER_MS * 2);
    expect(started, "startup resolved before S's boot attach settled").toBe(false);
    expect(fleet.indicesOf(F.mailboxId, "sync_start"), "a cycle ran before boot finished").toEqual([]);
    release();
    const worker = await starting;
    expect(worker.stats().mailboxes).toBe(2);
  }, 60_000);

  // ── the nudge ────────────────────────────────────────────────────────────────────────────────
  it("syncs a newly attached mailbox at once while another's re-dial and a deep batch are parked", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const Z = await seedMailbox(db, "z.fake.invalid");
    const P = await seedMailbox(db, "p.fake.invalid");
    const worker = await boot(fleet, { pollIntervalMs: 600_000, rosterIntervalMs: 600_000 });
    await waitFor(() => [Z, P].every((m) => fleet.indicesOf(m.mailboxId, "sync_end").length > 0),
      10_000, "a first cycle for each");

    // A cycle held open by Z's deep batch: nothing but a nudge reaches its dispatcher now, and the
    // poll and roster timers are a minute away.
    releases.push(parkSync(fleet, Z.mailboxId));
    fleet.signal.get(Z.mailboxId)!();
    await waitFor(() => fleet.syncInFlight === 1, 10_000, "Z parked inside its batch");
    // F is new; P's connection ends and its re-dial parks. The pass P's close asks for (served from
    // inside the held cycle) schedules both, P first.
    const F = await seedMailbox(db, "f.fake.invalid");
    releases.push(parkConnect(fleet, P.mailboxId));
    fleet.closeConnection(P.mailboxId);
    await waitFor(() => fleet.indicesOf(F.mailboxId, "watch").length === 1, 10_000,
      () => `F attached — trace: ${fleet.describeTrace()}`);
    await waitFor(() => fleet.indicesOf(F.mailboxId, "sync_start").length > 0,
      10_000, () => `F's first sync, with P and Z parked — trace: ${fleet.describeTrace()}`);
    expect(fleet.indicesOf(P.mailboxId, "connect").length, "P is still parked").toBe(1);
    expect(fleet.syncInFlight, "Z is still parked").toBeGreaterThanOrEqual(1);
    expect(worker.stats().mailboxes).toBe(2);
  }, 60_000);

  // ── the rotation, last ───────────────────────────────────────────────────────────────────────
  it("puts a mailbox in the rotation only once its IDLE is up", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const W = await seedMailbox(db, "w.fake.invalid");
    const worker = await boot(fleet);
    let release!: () => void;
    const watchGate = new Promise<void>((r) => { release = r; });
    releases.push(() => release());
    const S = await seedMailbox(db, "s.fake.invalid");
    fleet.behave(S.mailboxId, { watchGate });
    await waitFor(() => fleet.indicesOf(S.mailboxId, "ensure_folders").length === 1, 10_000, "S at its watch");
    for (let i = 0; i < 5; i++) { fleet.signal.get(W.mailboxId)!(); await sleep(100); }
    expect(fleet.indicesOf(S.mailboxId, "sync_start"), "a cycle visited S before its IDLE").toEqual([]);
    release();
    await waitFor(() => fleet.indicesOf(S.mailboxId, "sync_end").length > 0, 10_000, "S's first sync");
    expect(fleet.nth(S.mailboxId, "sync_start", 1)).toBeGreaterThan(fleet.nth(S.mailboxId, "watch", 1));
    expect(worker.stats().mailboxes).toBe(2);
  }, 60_000);

  // ── a connection lost during its attach ──────────────────────────────────────────────────────
  it("never reads through a connection reported closed during its attach, and re-attaches fresh", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const W = await seedMailbox(db, "w.fake.invalid");
    const worker = await boot(fleet, { mailboxRetryMs: 200 });
    let release!: () => void;
    const watchGate = new Promise<void>((r) => { release = r; });
    releases.push(() => release());
    const S = await seedMailbox(db, "s.fake.invalid");
    fleet.behave(S.mailboxId, { watchGate });
    await waitFor(() => fleet.indicesOf(S.mailboxId, "ensure_folders").length === 1, 10_000, "S at its watch");
    fleet.closeConnection(S.mailboxId);
    fleet.behave(S.mailboxId, { watchGate: undefined });
    release();
    for (let i = 0; i < 5; i++) { fleet.signal.get(W.mailboxId)!(); await sleep(60); }
    await waitFor(() => fleet.indicesOf(S.mailboxId, "sync_end").length > 0, 15_000,
      () => `S synced on a fresh connection — trace: ${fleet.describeTrace()}`);
    expect(fleet.nth(S.mailboxId, "sync_start", 1), "changesSince ran on the connection reported closed")
      .toBeGreaterThan(fleet.nth(S.mailboxId, "connect", 2));
    expect(worker.stats().mailboxes).toBe(2);
  }, 60_000);
  // ── the real adapter, in a TLS handshake that never answers ──────────────────────────────────
  // imapflow's close() mid-handshake settles nothing, so only the adapter's own abort ends the
  // dial. No fake here: a listener that takes the TCP connection and never says a word.
  async function silentTls(): Promise<{ port: number; connections: () => number }> {
    const sockets = new Set<net.Socket>();
    let count = 0;
    const server = net.createServer((sock) => {
      count++;
      sockets.add(sock);
      sock.on("error", () => { /* the worker goes away */ });
      sock.on("close", () => sockets.delete(sock));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => { for (const so of sockets) so.destroy(); server.close(() => r()); }));
    return { port: (server.address() as net.AddressInfo).port, connections: () => count };
  }

  async function seedSilent(db: Db, port: number): Promise<{ accountId: string; mailboxId: string }> {
    const m = await seedMailbox(db, "127.0.0.1");
    await db.update(mailboxCredentials).set({ meta: { host: "127.0.0.1", port, secure: true, user: "u" } })
      .where(eq(mailboxCredentials.mailboxId, m.mailboxId));
    return m;
  }

  function realCfg(over: Partial<WorkerConfig> = {}): WorkerConfig {
    const c: WorkerConfig = { ...cfgFor(new FakeAdapterFleet(), over), dialHostGuard: ALLOW_ANY_DIAL_HOST };
    delete c.adapterFactory;   // the worker's own ImapAdapter
    return c;
  }

  it("stops with a real dial stuck in its TLS handshake, and writes nothing on it", async () => {
    const db = makeDb(DB);
    const l = await silentTls();
    const worker = await startWorker(realCfg());
    const S = await seedSilent(db, l.port);
    await waitFor(() => l.connections() === 1, 10_000, "S's dial to reach the listener");

    const stopped = await Promise.race([
      worker.stop().then(() => true),
      sleep(10_000).then(() => false),
    ]);
    if (!stopped) closers.push(() => worker.stop());
    expect(stopped, "stop() never resolved behind a dial in its handshake").toBe(true);
    const row = await rowOf(db, S.mailboxId);
    expect(row.errorCode, "a stop wrote a failure on the mailbox it interrupted").toBeNull();
    const next = await startWorker(cfgFor(new FakeAdapterFleet()));
    await next.stop();
  }, 60_000);

  it("gives up on a real dial at its deadline in the handshake and frees its host", async () => {
    const db = makeDb(DB);
    const l = await silentTls();
    const worker = await startWorker(realCfg({ attachDeadlineMs: 1_500 }));
    closers.push(() => worker.stop());
    const S = await seedSilent(db, l.port);
    await waitFor(() => l.connections() === 1, 10_000, "S's dial to reach the listener");
    // A second mailbox on the same host waits behind S's host key.
    await seedSilent(db, l.port);
    await waitFor(async () => (await rowOf(db, S.mailboxId)).errorCode === "timeout", 15_000,
      "S quarantined as a timeout");
    await waitFor(() => l.connections() === 2, 15_000, "the second mailbox dialled once S let go of the host");
  }, 60_000);
});
