import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core";
import { randomUUID } from "node:crypto";
import { startWorker, type RunningWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A MAILBOX CONNECTED WHILE A CYCLE IS IN FLIGHT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `roster.e2e.test.ts` already proves the roster is LIVE and not a boot snapshot: an account
 * registered after startup is served with no restart. That test passes, and it passed on the
 * day the adoption gap was measured — which is exactly why the gap was mysterious. It seeds a second
 * mailbox into an IDLE worker, so the roster pass it queues is the only thing on the queue.
 *
 * Production is never idle. `index.ts` puts `cycle()` and `reconcileRoster()` on ONE serial
 * queue, and a cycle is a single queue entry covering EVERY attached mailbox — one bounded
 * batch each, serially. Measured against the live deployment on 2026-08-04:
 * `worker_heartbeats.last_cycle_at` moved 12:41:06 → 12:51:18 UTC, i.e. one cycle entry held
 * the queue for TEN MINUTES, while `beat_at` stayed fresh because the pulse runs off-queue.
 * `expected` and `mailboxes` in that row are only recomputed inside a roster pass, so the
 * heartbeat kept reporting the pre-existing count throughout — the exact reported symptom.
 *
 * A roster pass queued during that window is FIFO-behind it. So adoption is not broken, it is
 * STARVED, and the starvation term is the whole cycle rather than one mailbox's share of it:
 * at the shipped cap of 64 mailboxes it is hours, and it is unbounded in principle.
 *
 * These tests are about the ORDER in which one queue serves two kinds of work, so they assert
 * on the adapter trace and never on elapsed time. `syncGate` parks a cycle inside one
 * mailbox's `changesSince` — the shape of a real first backfill, made deterministic.
 *
 * ── AND THE RESIDUAL LEFT, WHICH CLOSED ─────────────────────────────────────
 *
 * The adoption fix bounded adoption at ONE BOUNDED BATCH rather than one roster interval, because the
 * rotation could only reach `yieldToRoster` between two mailboxes and it judged the tighter bound
 * unaffordable ("only purchasable with real concurrency between `attach` and a running cycle, and
 * that is how a mailbox ends up with two organizers"). The rotation now runs several mailboxes at
 * once and `requestRoster` nudges a cycle blocked on its lanes, so the bound IS the roster
 * interval — and the dual-organizer price is not paid, because the danger was two things
 * organizing ONE mailbox and a mailbox being attached has no lane. Two claims below changed with
 * it, each saying so at its own site: the first now asserts adoption WHILE the batch is parked,
 * and `roster_pass_delayed` is driven by the window that still produces it (a parked slice of the
 * cycle tail, which nothing preempts) rather than by a suspended batch or a hung provider dial,
 * neither of which holds the queue any more.
 */

type Db = ReturnType<typeof makeDb>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
const ROSTER_MS = 150;
let DB = "";

async function seedMailbox(db: Db, accountId: string = randomUUID()): Promise<{ accountId: string; mailboxId: string }> {
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

/** Two completed rotations from now: the released cycle has finished and the next one ran. */
async function twoCycles(worker: RunningWorker): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const before = worker.stats().lastCycleAt;
    await waitFor(() => worker.stats().lastCycleAt !== before, 8000, `completed cycle ${i + 1}`);
  }
}

/** `sync_start`s of a mailbox after its first `close`: syncs of a runtime that was detached. */
function syncsAfterClose(fleet: FakeAdapterFleet, mailboxId: string): number {
  const closeAt = fleet.nth(mailboxId, "close", 1);
  return fleet.indicesOf(mailboxId, "sync_start").filter((i) => i > closeAt).length;
}

/**
 * C (and D) SHARE B'S ACCOUNT in the cases below. The rotation runs three lanes, so on three
 * accounts A, B and C are admitted in one fill and C can still be before its `changesSince` when
 * B parks: "C has not had its turn" was then a race (FIX-026-A). One cycle per ACCOUNT keeps a
 * mailbox of B's account out of every lane while B is parked, so its turn comes after B's.
 */

/** Production-shaped config: no account filter, fake adapters, timers scaled down. */
function cfgFor(fleet: FakeAdapterFleet): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 120, sentDomain: "trafficflow.test",
    rosterIntervalMs: ROSTER_MS, mailboxRetryMs: 300, maxSyncFailures: 2,
    lockHeartbeatMs: 60_000,
    servingNothingMaxMs: 500,
    adapterFactory: fleet.factory,
  };
}

/**
 * Park the NEXT `changesSince` for one mailbox, and hand back the release.
 *
 * `syncGate` is read per call, so clearing it on release means the mailbox resumes ordinary
 * behaviour rather than parking again on the cycle this test is about to observe.
 */
function parkSync(fleet: FakeAdapterFleet, mailboxId: string): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fleet.behave(mailboxId, { syncGate: gate });
  return () => { fleet.behave(mailboxId, { syncGate: undefined }); release(); };
}

describe("the roster pass is not starved by the cycle it shares a queue with", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_roster_preempt"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  /**
   * Gates to open BEFORE the workers are stopped.
   *
   * `stop()` awaits the in-flight queue entry, so a worker suspended inside a gated `connect()`
   * would never let the hook finish — and vitest reports that as "Hook timed out", after which
   * every LATER test in the file fails with "another worker holds the leader lock" because the
   * leaked worker still has it. Measured: one assertion failure became six.
   */
  const releases: Array<() => void> = [];
  afterEach(async () => {
    for (const r of releases.splice(0)) { try { r(); } catch { /* ignore */ } }
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  /**
   * THE REPRODUCTION.
   *
   * Three mailboxes are attached in roster order A, B, C — which is the rotation order, since
   * `runtimes` is a Map and the roster is stable oldest-first. The cycle is parked inside B, a
   * fourth mailbox D is connected while it is parked, several roster intervals go by, and then
   * B is released.
   *
   * The claim is about what happens NEXT: D must join the rotation before the cycle goes on to
   * spend C's batch. Before the fix it could not — the queued roster pass ran only once the
   * whole cycle had returned, so D's connect landed AFTER C's sync. That is the ten minutes,
   * in miniature and without a clock.
   */
  it("attaches a mailbox connected mid-cycle BEFORE the rest of that cycle's rotation", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);
    const c = await seedMailbox(db, b.accountId);

    const worker: RunningWorker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 3, 8000, "A, B and C served");

    const release = parkSync(fleet, b.mailboxId);
    await waitFor(() => fleet.syncInFlight === 1, 8000, "a cycle parked inside B's changesSince");
    // Captured while the cycle is parked at B, so C has demonstrably not synced in it yet:
    // the next entry at this index IS this cycle's visit to C.
    const cSyncsBefore = fleet.indicesOf(c.mailboxId, "sync_start").length;

    // The customer connects their mailbox now.
    const d = await seedMailbox(db);

    // ── THE RESIDUAL RECORDED, AND WHERE IT WENT ──────────────────────────
    //
    // This line used to assert `mailboxes === 3` after five roster intervals, with the comment
    // *"nothing can be attached while the one queue is held — this is the defect, not the fix"*.
    // It was a true statement about a rotation that could only reach `yieldToRoster` BETWEEN two
    // mailboxes, which is the residual the adoption fix wrote down and declined to close:
    //
    //   *"the residual bound is ONE bounded batch rather than one roster interval, and that trade
    //    is deliberate: the tighter bound is only purchasable with real concurrency between
    //    `attach` and a running cycle, and that is how a mailbox ends up with two organizers."*
    //
    // Per-mailbox lanes buy that concurrency and do NOT pay that price, because the danger was never
    // "attach runs while a cycle runs" — it was "two things organize ONE mailbox". D has no
    // runtime and therefore no lane, so its attach touches no adapter the rotation is holding;
    // the rotation's own per-ACCOUNT key and the roster pass's `laneBusy` skip are what keep that
    // true for every other mailbox. So the bound is now the ROSTER INTERVAL, which is what the
    // customer pressing Connect is actually waiting for, and the claim below is the strong form
    // of the one this line used to make.
    await waitFor(
      () => worker.stats().mailboxes === 4, 8000,
      "D adopted while B's batch is STILL parked — a customer's brand-new mailbox must not wait " +
      "out an unrelated mailbox's backfill before anything connects to it at all",
    );
    expect(
      fleet.syncInFlight,
      "B's batch had already returned, so D's adoption proves nothing about preemption",
    ).toBe(1);

    release();

    await twoCycles(worker);
    const dConnect = fleet.nth(d.mailboxId, "connect", 1);
    const cNextSync = fleet.nth(c.mailboxId, "sync_start", cSyncsBefore + 1);
    expect(cNextSync, "C's next batch must have run before the order means anything").not.toBe(Infinity);
    expect(
      dConnect,
      `D must be adopted before the parked cycle spends C's batch — ${fleet.describeTrace(new Map([
        [a.mailboxId, "A"], [b.mailboxId, "B"], [c.mailboxId, "C"], [d.mailboxId, "D"],
      ]))}`,
    ).toBeLessThan(cNextSync);
  }, 30000);

  /**
   * THE HAZARD THE FIX INTRODUCES, GUARDED.
   *
   * A roster pass may now run BETWEEN two mailboxes of a cycle, and a roster pass detaches:
   * a mailbox disabled, deleted, lapsed on billing or evicted by the cap has its adapter
   * CLOSED. The cycle is walking a snapshot taken before that happened, so without a check it
   * would go on to sync a mailbox whose connection is gone — sync failures on a healthy
   * mailbox, counting toward `maxSyncFailures` and a `status='error'` a customer can see.
   *
   * That is the invariant the single queue used to give for free ("a roster pass must never
   * close an adapter a sync cycle is using"), and it is now a line of code, so it gets a test.
   */
  it("does not sync a mailbox the interleaved roster pass detached", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);
    const c = await seedMailbox(db, b.accountId);

    const worker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 3, 8000, "A, B and C served");

    const release = parkSync(fleet, b.mailboxId);
    await waitFor(() => fleet.syncInFlight === 1, 8000, "a cycle parked inside B's changesSince");
    const cSyncsBefore = fleet.indicesOf(c.mailboxId, "sync_start").length;

    // C leaves the duty while the cycle that is about to visit it is parked.
    //
    // WAIT FOR THE PASS, NOT FOR A NUMBER OF MILLISECONDS. `release()` below is only meaningful
    // once the roster pass has actually detached C; a fixed sleep asserts that it fits, and the
    // measurement says the pass lands at ~130 ms inside 750, so the literal is a 5.7x bet on the
    // scheduler that a loaded machine loses (this file failed inside a 146-file parallel run and
    // passed 5/5 serially). Waiting on the pass's own effect returns as soon as it happens and
    // fails only if it never does.
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, c.mailboxId));
    await waitFor(() => worker.stats().mailboxes === 2, 8000, "the roster pass that drops C to run while the cycle is parked");

    release();

    await waitFor(() => worker.stats().mailboxes === 2, 8000, "C detached");
    expect(fleet.openFor(c.mailboxId), "C's connection must actually be closed").toBe(0);
    await twoCycles(worker);
    expect(syncsAfterClose(fleet, c.mailboxId), "a sync began on C after C was closed").toBe(0);
    expect(
      fleet.indicesOf(c.mailboxId, "sync_start").length,
      "the cycle must skip a runtime that left the rotation while it was parked",
    ).toBe(cSyncsBefore);
    expect(worker.stats()).toMatchObject({ mailboxes: 2, expected: 2, quarantined: 0 });
    expect(await statusOf(db, a.mailboxId)).toBe("connected");
    expect(await statusOf(db, b.mailboxId)).toBe("connected");
  }, 30000);

  /**
   * THE OTHER HALF OF "NOTHING SURFACES IT".
   *
   * A pass that is owed and cannot run is the whole of that change, and until this line existed
   * the worker emitted nothing at all while it was happening — no log, no counter, no column.
   * The delay is reported once per pass, from the pass itself, so the record exists even when
   * the delay is a legitimately slow cycle rather than a bug.
   */
  it("reports the delay when a roster pass waited on the queue", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const lines: Array<Record<string, unknown>> = [];
    await seedMailbox(db);
    await seedMailbox(db);
    await seedMailbox(db);

    // A tail slice parks on this gate once `parkNext` is set.
    let parkNext = false;
    let parked = false;
    let releaseSlice = (): void => { /* replaced below */ };
    const sliceGate = new Promise<void>((r) => { releaseSlice = () => { r(); }; });
    releases.push(() => { releaseSlice(); });
    const worker = await startWorker({
      ...cfgFor(fleet),
      tailSliceHook: async () => {
        if (!parkNext) return;
        parkNext = false;
        parked = true;
        await sliceGate;
      },
      // `logger`, not `log`. `apps/worker` does not typecheck its tests, so the wrong key is a
      // silently absent logger and an assertion that can only ever time out — which is how this
      // test first "failed".
      logger: createLogger({
        service: "worker", level: "info",
        sink: (line) => { lines.push(JSON.parse(line) as Record<string, unknown>); },
      }),
    });
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 3, 8000, "three mailboxes served");

    // ── WHICH DELAY THIS STILL REPORTS, AND WHICH ONE IT NO LONGER CAN ────────────
    //
    // This used to park a cycle inside `changesSince` and wait: the rotation could only reach
    // `yieldToRoster` BETWEEN two mailboxes, so a suspended batch held every owed pass behind it
    // and the WARN fired every time. `requestRoster` now NUDGES a cycle that is blocked on its
    // lanes, so that window is closed and the pass is served while the batch is still parked —
    // which is the point of the slice and would make this guard permanently green if it kept
    // asserting the old shape.
    //
    // The WARN is not dead, and this is the window that remains: the cycle TAIL is its own queue
    // entry and yields only between slices, so one slow slice holds every owed pass behind it. A hung
    // provider dial no longer does: attaches run in their own pool beside the queue
    // (CLOUD-ROSTER-REATTACH-IS-SERIAL), so the window this case used to park was closed. A parked
    // slice is the shape the line has to keep explaining, because an operator reading
    // `roster_pass_delayed` needs it to mean something.
    parkNext = true;
    await waitFor(() => parked, 8000, "a tail slice to park on its gate");

    await new Promise((r) => setTimeout(r, ROSTER_MS * 6));
    releaseSlice();

    const delayed = (): Array<Record<string, unknown>> =>
      lines.filter((l) => l.event === "roster_pass_delayed");
    await waitFor(() => delayed().length > 0, 8000, "the delayed roster pass to report itself");
    // The DELAY, not merely the event. A line that says "a pass was late" without saying how
    // late is not evidence, and the logger drops the value of any field outside its allowlist —
    // so asserting the number is also what pins the field name to one the logger will emit.
    expect(Number(delayed()[0]!.latencyMs)).toBeGreaterThanOrEqual(ROSTER_MS);
  }, 30000);

  /**
   * THE STALE-RUNTIME BRANCH, which is why the rotation guard is by IDENTITY and not by
   * PRESENCE.
   *
   * A cycle that runs for ten minutes spans twenty roster intervals, so "one pass detached this
   * mailbox and a later one re-attached it" is not an exotic interleaving — it is what a
   * downgrade-then-restore, a disable-then-enable, or a cap eviction followed by a departure
   * produces on any normal afternoon. `runtimes.has(id)` is TRUE for that mailbox, and the `rt`
   * this cycle is holding is the OLD object with the CLOSED connection.
   *
   * Four mailboxes, two parks, and D leaves and returns between them. The cycle must reach D's
   * turn holding a runtime that is no longer the mailbox's runtime, and must decline to use it.
   */
  it("skips a stale runtime whose mailbox left and rejoined while the cycle was parked", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const useAfterClose: string[] = [];
    await seedMailbox(db);                                   // A — syncs and gets out of the way
    const b = await seedMailbox(db);
    const c = await seedMailbox(db, b.accountId);
    const d = await seedMailbox(db, b.accountId);
    // TWO guards hold this shape, measured: the rejoined D is a first-syncer admitted ahead of the
    // stale one, so `servedIds` skips the stale runtime before the identity check is asked. Either
    // guard mutated alone stays green here; the pair turns it red.

    const worker = await startWorker({
      ...cfgFor(fleet), adapterFactory: recordingFactory(fleet, useAfterClose),
    });
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 4, 8000, "four mailboxes served");

    const releaseB = parkSync(fleet, b.mailboxId);
    await waitFor(() => fleet.syncInFlight === 1, 8000, "a cycle parked inside B");

    // D leaves the duty while the cycle is parked, and C is armed to park next. Same reason as
    // above for waiting on the pass rather than on a literal: `releaseB()` is only the thing this
    // case means once D is out of the rotation the cycle is holding.
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, d.mailboxId));
    await waitFor(() => worker.stats().mailboxes === 3, 8000, "the roster pass that drops D while the cycle is parked in B");
    const releaseC = parkSync(fleet, c.mailboxId);
    releaseB();

    // The pass at C's turn detaches D — the runtime this cycle is still holding in `rotation`.
    await waitFor(() => worker.stats().mailboxes === 3, 8000, "D detached mid-cycle");
    await waitFor(() => fleet.syncInFlight === 1, 8000, "a cycle parked inside C");
    const dConnectsBefore = fleet.indicesOf(d.mailboxId, "connect").length;

    // …and D comes back before the cycle gets to it — which is the whole interleaving, so it is
    // waited for rather than budgeted for.
    await db.update(mailboxes).set({ status: "connected" }).where(eq(mailboxes.id, d.mailboxId));
    await waitFor(() => worker.stats().mailboxes === 4, 8000, "the roster pass that takes D back before the cycle reaches it");
    releaseC();

    await waitFor(
      () => fleet.indicesOf(d.mailboxId, "connect").length > dConnectsBefore,
      8000, "D re-attached on a fresh connection",
    );
    // A cycle has to COMPLETE before "no adapter was used after it was closed" means anything: a
    // fixed sleep that a loaded machine outruns makes this pass for want of a cycle rather than
    // for want of a use-after-close.
    const cycleBefore = worker.stats().lastCycleAt;
    await waitFor(() => worker.stats().lastCycleAt !== cycleBefore, 8000, "a cycle to complete after D came back");

    expect(useAfterClose, "no adapter may be used after it was closed").toEqual([]);
    expect(worker.stats()).toMatchObject({ mailboxes: 4, expected: 4, quarantined: 0 });
    expect(fleet.openFor(d.mailboxId), "exactly one live connection for D").toBe(1);
    expect(await statusOf(db, d.mailboxId)).toBe("connected");
  }, 40000);

  /**
   * THE FLOOR UNDER THE ACCELERATOR.
   *
   * `rosterPending` is only ever read from inside a running cycle. On a shard with nothing
   * attached there are no cycles to read it, so a flag-only design would stop adopting
   * altogether — and it would do so on exactly the deployment where the bug never existed: an
   * empty one, i.e. every brand-new customer's first mailbox. `requestRoster` therefore queues
   * an entry as well, and this is the test that the entry is what runs.
   *
   * `pollIntervalMs` is deliberately LONGER than the whole test, and that is the assertion's
   * teeth rather than a detail: with a short one the poll timer would kick a cycle anyway and
   * the cycle's own yield point would adopt the mailbox, so a flag-only scheduler would pass.
   * Production runs its poll and its roster on their own intervals, so "no cycle is in flight" is its
   * ordinary state, not a contrived one.
   */
  it("still adopts on a shard with nothing attached, where no cycle reaches a yield point", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();

    const worker = await startWorker({ ...cfgFor(fleet), pollIntervalMs: 60_000 });
    closers.push(() => worker.stop());
    expect(worker.stats()).toMatchObject({ mailboxes: 0, expected: 0 });

    const a = await seedMailbox(db);
    await waitFor(() => worker.stats().mailboxes === 1, 8000, "the first mailbox of an empty shard");
    expect(await statusOf(db, a.mailboxId)).toBe("connected");
  }, 30000);
});

/**
 * Wrap every adapter the fleet makes so that USING ONE AFTER IT WAS CLOSED is recorded.
 *
 * A closed IMAP connection does not politely return an empty batch — it throws, the mailbox's
 * failure counter climbs, and a working customer mailbox ends up `status='error'`. The fake has
 * no socket, so a use-after-close is invisible to it and to every assertion in this suite. This
 * makes it observable, per ADAPTER INSTANCE rather than per mailbox, which is the whole point:
 * the bug this guards is two runtimes for one mailbox id, so an assertion keyed on the id
 * cannot see it.
 */
function recordingFactory(
  fleet: FakeAdapterFleet, useAfterClose: string[],
): WorkerConfig["adapterFactory"] {
  return (cfg, ctx) => {
    const adapter = fleet.factory(cfg, ctx);
    let closed = false;
    const close = adapter.close.bind(adapter);
    const changesSince = adapter.changesSince.bind(adapter);
    adapter.close = async (): Promise<void> => { closed = true; await close(); };
    adapter.changesSince = async (c) => {
      if (closed) useAfterClose.push(ctx.mailboxId);
      return changesSince(c);
    };
    return adapter;
  };
}

async function statusOf(db: Db, mailboxId: string): Promise<string> {
  const [row] = await db.select({ status: mailboxes.status }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
  return row!.status;
}
