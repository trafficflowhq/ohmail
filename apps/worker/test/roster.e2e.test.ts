import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { randomUUID } from "node:crypto";
import { startWorker, type RunningWorker } from "../src/index.js";
import { runWorkerSupervised } from "../src/supervisor.js";
import { acquireLeaderLock } from "../src/leader-lock.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { ORGANIZER_CONSENT } from "./_workerdb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

type Db = ReturnType<typeof makeDb>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";

async function seedMailbox(db: Db, accountId = randomUUID()): Promise<{ accountId: string; mailboxId: string }> {
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, ...ORGANIZER_CONSENT }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

/** A mailbox row with NO credential row — enabled, but nothing to connect to. */
async function seedMailboxWithoutCreds(db: Db, accountId = randomUUID()): Promise<{ accountId: string; mailboxId: string }> {
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  return { accountId, mailboxId: row!.id };
}

/**
 * The in-memory counters in `stats()` are NOT synchronisation points for the DB.
 *
 * `index.ts` updates its maps BEFORE it awaits the corresponding write — `runtimes.set()` at :264
 * precedes `await setMailboxStatus(…, 'connected')` at :274, and `quarantine.set()` at :211
 * precedes `await setMailboxStatus(…, 'error')` at :215. So a `waitFor` on the counter can return
 * while the write is still in flight, and the very next `expect(statusOf(...))` loses the race under
 * load. That is the flake in this file, and it has TWO instances, one on each side.
 *
 * Both helpers below wait for the counter AND the persisted status the assertion is about to read.
 * Widening a timeout would only make the flake rarer; the predicate has to cover the state.
 */
async function waitForServed(
  worker: { stats(): { mailboxes: number; accounts: number } },
  db: Db, seeded: Array<{ accountId: string; mailboxId: string }>, ms: number, label: string,
): Promise<void> {
  // `accounts` is part of the predicate for the SAME reason the persisted status is, and it is
  // the third instance of the note above rather than a new rule. `runtimes.set()` happens at
  // the START of `attach()` — before `ensureFolders`, before the kickstart, before the two
  // restart sync cycles — while `dutyAccounts` is assigned only once the whole attach LOOP
  // returns. So a wait on `mailboxes` alone can be satisfied minutes of real work before
  // `stats().accounts` catches up, and the next `toMatchObject({ accounts: 2 })` loses under
  // load. Waiting on the counter the assertion actually reads is the fix; widening a timeout
  // would only make it rarer.
  const accounts = new Set(seeded.map((s) => s.accountId)).size;
  await waitFor(async () => {
    const stats = worker.stats();
    if (stats.mailboxes !== seeded.length || stats.accounts !== accounts) return false;
    for (const s of seeded) if ((await statusOf(db, s.mailboxId)) !== "connected") return false;
    return true;
  }, ms, label);
}

/** Quarantined AND persisted as `status='error'` — the other half of the same race. */
async function waitForQuarantined(
  worker: { stats(): { quarantined: number } }, db: Db, mailboxId: string, ms: number, label: string,
): Promise<void> {
  await waitFor(async () =>
    worker.stats().quarantined === 1 && (await statusOf(db, mailboxId)) === "error", ms, label);
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

async function statusOf(db: Db, mailboxId: string): Promise<string> {
  const [row] = await db.select({ status: mailboxes.status }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
  return row!.status;
}

/** The WHOLE row, read back independently — mail 0029's assertions are about columns, not counters. */
async function rowOf(db: Db, mailboxId: string): Promise<typeof mailboxes.$inferSelect> {
  const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
  return row!;
}

/** Production-shaped config: NO account filter anywhere. Fast timers, fake adapters. */
/** The credential that reads the whole health snapshot; the public body carries no count. */
const DETAIL = "d".repeat(32);
const detail = { headers: { authorization: `Bearer ${DETAIL}` } };

function cfgFor(fleet: FakeAdapterFleet, extra: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
    healthDetailSecret: DETAIL,
    rosterIntervalMs: 300, mailboxRetryMs: 300, maxSyncFailures: 2,
    lockHeartbeatMs: 60_000,                     // heartbeat is exercised by lock-loss.e2e
    // A later change put a GRACE PERIOD in front of the "leader serves nothing" refusal — two minutes in
    // production, because that rule gates deployments and a cold start during an outage must
    // still be able to ship a build. This suite asserts the rule, not the wait, so it names a
    // short bound rather than sleeping through the real one. `health-bounds.e2e.test.ts` is
    // where the grace itself is the claim under test.
    servingNothingMaxMs: 500,
    adapterFactory: fleet.factory,
    ...extra,
  };
}

describe("worker roster reconciliation", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_roster"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("picks up an account registered AFTER startup, with no restart (the real timing)", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const a = await seedMailbox(db);

    const worker: RunningWorker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    expect(worker.stats()).toMatchObject({ mailboxes: 1, accounts: 1, expected: 1 });

    // Open registration: a SECOND account appears while the worker is already running. A
    // startup-snapshot roster would never see it — this is the failure the report actually describes,
    // and seeding both accounts before boot (as the first multi-account test did) cannot detect it.
    const b = await seedMailbox(db);
    await waitForServed(worker, db, [a, b], 8000, "the new account's mailbox served AND persisted");
    expect(worker.stats()).toMatchObject({ mailboxes: 2, accounts: 2, expected: 2, degraded: false });
    expect(await statusOf(db, b.mailboxId)).toBe("connected");
    expect(await statusOf(db, a.mailboxId)).toBe("connected");
  }, 30000);

  it("detaches and CLOSES a mailbox disabled mid-run (no orphan IDLE connection)", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);

    const worker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitForServed(worker, db, [a, b], 8000, "both mailboxes served AND persisted");
    expect(fleet.openFor(b.mailboxId)).toBe(1);

    // Exactly what the billing-downgrade path does — and what deleting credentials
    // follows. Before this fix the mailbox stayed watched, IDLE-connected and synced forever.
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, b.mailboxId));

    await waitFor(() => worker.stats().mailboxes === 1, 8000, "the disabled mailbox to be detached");
    expect(fleet.openFor(b.mailboxId)).toBe(0);            // the connection was actually CLOSED
    expect(fleet.openFor(a.mailboxId)).toBe(1);            // and the healthy one kept serving
    expect(worker.stats()).toMatchObject({ mailboxes: 1, expected: 1, accounts: 1, quarantined: 0 });

    // It must not come back on the next pass either.
    await new Promise((r) => setTimeout(r, 700));
    expect(worker.stats().mailboxes).toBe(1);
  }, 30000);

  it("closes the connection when a POST-connect step fails, and never leaks the login", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);
    // connect() SUCCEEDS, ensureFolders() then throws: the pre-fix code pushed the adapter onto
    // its tracked list only after the attach-time drain, so this path leaked a live login. The
    // drain has since moved to `cycle()` and `ensureFolders` is now the LAST step of
    // attach that can throw before `runtimes.set`, which makes this the narrowest surviving
    // window for that leak rather than a historical one.
    fleet.behave(b.mailboxId, { failEnsureFolders: true });

    const worker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());

    expect(worker.stats()).toMatchObject({ mailboxes: 1, expected: 2, quarantined: 1, degraded: true });
    expect(fleet.connects).toBeGreaterThanOrEqual(2);       // b DID connect...
    expect(fleet.openFor(b.mailboxId)).toBe(0);             // ...and was closed again
    expect(fleet.openFor(a.mailboxId)).toBe(1);
    expect(await statusOf(db, b.mailboxId)).toBe("error");
    expect(await statusOf(db, a.mailboxId)).toBe("connected");
  }, 30000);

  it("quarantines a mailbox that goes bad at RUNTIME, then restores 'connected' only after a verified recovery", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);

    const worker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitForServed(worker, db, [a, b], 8000, "both mailboxes served AND persisted");
    expect(await statusOf(db, b.mailboxId)).toBe("connected");

    // A clean attach followed by repeated runtime failures: previously this logged the same
    // error every cycle forever while /health kept counting the mailbox as if it were serving.
    fleet.behave(b.mailboxId, { failSync: true });
    await waitForQuarantined(worker, db, b.mailboxId, 8000, "the failing mailbox quarantined AND persisted");
    expect(worker.stats()).toMatchObject({ mailboxes: 1, expected: 2, quarantined: 1, degraded: true });
    expect(fleet.openFor(b.mailboxId)).toBe(0);             // detached, connection closed
    expect(await statusOf(db, b.mailboxId)).toBe("error");
    expect(fleet.openFor(a.mailboxId)).toBe(1);             // the other account never stalled

    // Recovery: status returns to 'connected' only after connect + folders + two sync cycles.
    fleet.behave(b.mailboxId, { failSync: false });
    await waitForServed(worker, db, [a, b], 10000, "the recovered mailbox re-attached AND persisted");
    expect(await statusOf(db, b.mailboxId)).toBe("connected");
    expect(worker.stats()).toMatchObject({ quarantined: 0, degraded: false });
  }, 40000);

  it("counts an enabled mailbox with no credentials as awaiting, not as served or lost", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    await seedMailbox(db);
    const pending = await seedMailboxWithoutCreds(db);

    const worker = await startWorker(cfgFor(fleet, { syncBlockGraceMs: 0 }));
    closers.push(() => worker.stop());

    expect(worker.stats()).toMatchObject({
      mailboxes: 1, expected: 2, awaitingCredentials: 1, quarantined: 0, degraded: true,
    });
    // Not quarantined (nothing failed) and not silently forgotten either: the roster
    // invariant accounts for it explicitly.
    expect(await statusOf(db, pending.mailboxId)).not.toBe("error");

    // ── AND THE ROW SAYS SO (mail 0029) ────────────────────────────────────────────────────
    //
    // Until 0029 this arm was the QUIETEST of the three: `awaitingCreds` was an in-memory set and
    // the log line fired ONCE EVER, behind `announced.creds`, so after the first roster pass a
    // mailbox that had never been able to sync produced no trace anywhere and its row said
    // `connected`. The counter above is process-local — it dies with the process and is invisible
    // to the user's Settings pane and to the admin console.
    //
    // The elapsed-time policy lives in ONE place, so this arm needed no threshold of its own: it
    // records, `reconcileRoster` writes. `syncBlockGraceMs: 0` is how this test says "do not make
    // me wait out the grace" — the grace itself is `organizer-lease.e2e.test.ts`'s claim.
    await waitFor(
      async () => (await rowOf(db, pending.mailboxId)).syncBlockedReason === "awaiting_credentials",
      8000, "the row never said the mailbox was waiting for credentials",
    );
    const row = await rowOf(db, pending.mailboxId);
    expect(row.status, "waiting for credentials is not a FAILURE").toBe("connected");
    expect(row.errorCode).toBeNull();
    expect(row.retryCount).toBe(0);
    expect(row.syncBlockedSince).not.toBeNull();
  }, 30000);

  it("caps the mailboxes it serves and reports the truncated tail", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const accountId = randomUUID();
    const seeded: string[] = [];
    for (let i = 0; i < 3; i++) seeded.push((await seedMailbox(db, accountId)).mailboxId);

    // A grace of THREE roster intervals, not 0, and that is load-bearing here rather than
    // incidental: `dropped` is recomputed from scratch on every pass, so the map holding `since`
    // has to live at closure scope. Made per-pass it would reset `since` to `Date.now()` every 300
    // ms and the grace would never elapse — a bug a grace of 0 cannot see, because with 0 the very
    // first observation is already due.
    const worker = await startWorker(cfgFor(fleet, { maxMailboxes: 2, syncBlockGraceMs: 900 }));
    closers.push(() => worker.stop());

    expect(worker.stats()).toMatchObject({
      mailboxes: 2, expected: 2, truncated: 1, accounts: 1, degraded: true,
    });

    // ── AND THE DROPPED MAILBOX'S ROW SAYS SO (mail 0029) ─────────────────────────────────
    //
    // The most invisible of the three arms, and for a structural reason rather than a logging one:
    // a capped mailbox is NOT counted in `expected`, so `degraded` is computed without it and
    // `/health` can report a perfectly healthy worker while nothing in the deployment serves the
    // mailbox at all. `mailbox_cap_exceeded` fires once per change of the dropped SET, so a stable
    // overflow is silent after the first pass. Nothing told the mailbox's owner.
    //
    // The roster is ordered oldest-first so the cap truncates DETERMINISTICALLY — which is what
    // makes "the third one seeded" the right row to assert about.
    const dropped = seeded[2]!;
    await waitFor(
      async () => (await rowOf(db, dropped)).syncBlockedReason === "at_capacity",
      8000, "the row never said this deployment had no capacity for the mailbox",
    );
    expect((await rowOf(db, dropped)).status, "the cap is not a mailbox FAILURE").toBe("connected");
    // …and the two it DOES serve carry nothing: the note is per mailbox, not per shard, which is
    // exactly what a `worker_heartbeats`-derived signal could not have been.
    for (const served of seeded.slice(0, 2)) {
      expect((await rowOf(db, served)).syncBlockedReason,
        "a SERVED mailbox was defamed by its shard-mate's block").toBeNull();
    }
  }, 30000);

  it("stop() AWAITS the in-flight cycle instead of closing the adapter and the lock under it", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const a = await seedMailbox(db);

    const worker = await startWorker(cfgFor(fleet));
    let closed = false;
    closers.push(async () => { if (!closed) await worker.stop(); });
    await waitFor(() => fleet.syncs > 0, 8000, "the first cycle");

    // Park the NEXT cycle inside changesSince — a long IMAP fetch, in effect.
    let release: () => void = () => { /* replaced */ };
    const syncGate = new Promise<void>((r) => { release = r; });
    fleet.behave(a.mailboxId, { syncGate });
    await waitFor(() => fleet.syncInFlight === 1, 8000, "a cycle to be in flight");

    // stop() must WAIT. Pre-fix, cycle() was fire-and-forget and its promise was not
    // retained, so stop() closed the adapter, closed the DB pool and RELEASED the lock while
    // the cycle was still reading IMAP and writing rows — and a standby could take over
    // mid-cycle.
    let settled = false;
    const stopping = worker.stop().then(() => { settled = true; closed = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    expect(fleet.openFor(a.mailboxId)).toBe(1);            // not closed under the running cycle

    release();
    await stopping;
    expect(settled).toBe(true);
    expect(fleet.syncInFlight).toBe(0);
    expect(fleet.openFor(a.mailboxId)).toBe(0);
    // ...and the lock is free only now that the cycle is done.
    const after = await acquireLeaderLock(DB);
    expect(after).not.toBeNull();
    await after!.release();
  }, 40000);

  it("/health stays 200 for a PARTIAL failure but goes 503 when the leader serves nothing at all", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);
    fleet.behave(b.mailboxId, { failConnect: true });

    const sup = await runWorkerSupervised(cfgFor(fleet, { healthPort: 0, standbyRetryMs: 500 }));
    closers.push(() => sup.stop());

    // One bad customer must never take down everybody else's sync.
    const partial = await fetch(`http://127.0.0.1:${sup.healthPort}/health`, detail);
    expect(partial.status).toBe(200);
    expect(await partial.json()).toMatchObject({
      ok: true, healthy: true, leader: true, mailboxes: 1, expected: 2, quarantined: 1, degraded: true,
    });

    // Now the LAST healthy mailbox dies too: sync is entirely dead, so health must say so
    // instead of reporting `leader:true` with a freshly-ticking lagSeconds.
    fleet.behave(a.mailboxId, { failSync: true });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${sup.healthPort}/health`, detail)).status === 503,
      10000, "health to report the dead leader");
    const dead = await fetch(`http://127.0.0.1:${sup.healthPort}/health`, detail);
    const body = await dead.json() as { ok: boolean; lastCycleAt: string | null; lagSeconds: number | null; mailboxes: number; expected: number };
    expect(dead.status).toBe(503);
    expect(body).toMatchObject({ ok: false, mailboxes: 0, expected: 2 });
    // FRESHNESS HONESTY: a cycle in which nothing synced must not refresh the pair an alert
    // watches. Before the fix `lastCycleAt` advanced on every empty/failed cycle.
    const before = body.lastCycleAt;
    await new Promise((r) => setTimeout(r, 900));
    const again = await (await fetch(`http://127.0.0.1:${sup.healthPort}/health`, detail)).json() as { lastCycleAt: string | null };
    expect(again.lastCycleAt).toBe(before);
  }, 40000);
});
