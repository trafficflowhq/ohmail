import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { randomUUID } from "node:crypto";
import { startWorker, type RunningWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * @postpush: alone
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A MAILBOX THAT HAS NEVER SYNCED WAITS OUT EVERY OTHER MAILBOX'S BACKFILL
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * IT RUNS ALONE. The two claims below are order claims, but the INSTANT they are read at is
 * established by a clock: three `waitFor`s with 8 s bounds, a 600 ms sleep, and a worker
 * configured in milliseconds (roster 150, poll 120, retry 300). One post-push run read the second case
 * RED beside 67 box co-tenants on 2026-09-22 (`expected 1 to be 2`) where the run before it read it
 * green at the tip immediately below, with this file and its whole import chain byte-identical at
 * both and the range's runtime delta one React Native component. Ten runs here did not reproduce
 * it — 3 alone, 3 under six spinners at load 6.2-6.9, 4 as a co-tenant among 64 lane-database
 * worker files at loads 3.5 to 15, the last of them taken after this marker landed and green in
 * 6329 ms — so this marker is the standing rule applied to a file the wall-clock census now counts
 * in its class, not a fix anybody has watched work.
 *
 * An earlier change fixed ADOPTION: a mailbox connected mid-cycle joins `runtimes` within a roster
 * interval instead of waiting out the whole cycle, and `roster-preemption.e2e.test.ts` proves
 * it. The row that filed it wrote the residual down in the same breath — *"one backfilling
 * mailbox still dominates ~10 minutes today, so a mailbox connected during its batch waits it
 * out"* — and that residual is a different, larger term than the one that was fixed: attach is
 * fast, and the FIRST SYNC still sums over the rotation, because `cycle()` walked
 * `[...runtimes.values()]` in insertion order and a newcomer is always LAST.
 *
 * Measured in production with many mailboxes on one shard, three of them cold
 * backfills: a new mailbox was attached within a second and its first cycle came
 * many MINUTES later — by which time its provider had closed the connection, so the first
 * cycle failed, the mailbox was re-attached at the BACK of the rotation, and it never synced
 * at all. `coalesce(last_sync_at, created_at)` had aged 1h 57m and `sync_lag` was paging.
 * `roster_pass_delayed` reported single cycle entries holding the queue for 480 s.
 *
 * The two claims below are ORDER claims and never elapsed-time claims: they assert on the
 * adapter trace, exactly as the tests do, and `parkSync` makes one mailbox's batch the
 * long one deterministically.
 *
 * NOT CONCURRENCY. The ruling is explicit that a strict bar "is only purchasable with
 * real concurrency between attach and a running cycle, and that price is the dual-organizer
 * bug". Nothing here runs two mailboxes at once; the cycle is still one serial walk. It is the
 * ORDER of that walk that changes, which is why it costs nothing and can be tested by order.
 */

type Db = ReturnType<typeof makeDb>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
const ROSTER_MS = 150;
let DB = "";

async function seedMailbox(db: Db, accountId = randomUUID()): Promise<{ accountId: string; mailboxId: string }> {
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
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

function cfgFor(fleet: FakeAdapterFleet): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 120, sentDomain: "trafficflow.test",
    rosterIntervalMs: ROSTER_MS, mailboxRetryMs: 300, maxSyncFailures: 2,
    lockHeartbeatMs: 60_000,
    servingNothingMaxMs: 500,
    // ONE LANE: both claims are about the ORDER of a serial walk. Under the default three lanes A, B
    // and C share a pass, so whether B's visit in the parked pass is noted before or after the count
    // is taken was a race, and with three mailboxes there is no "rest of the rotation" to order.
    // `cycleLanes: 1` is the same code path with one lane (`roster-serialization.pg.test.ts`).
    cycleLanes: 1,
    adapterFactory: fleet.factory,
  };
}

/** Park the NEXT `changesSince` for one mailbox, and hand back the release. */
function parkSync(fleet: FakeAdapterFleet, mailboxId: string): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fleet.behave(mailboxId, { syncGate: gate });
  return () => { fleet.behave(mailboxId, { syncGate: undefined }); release(); };
}

describe("a mailbox that has never synced is served before the rest of the rotation", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_first_sync"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  /**
   * THE PRODUCTION FAILURE, in miniature.
   *
   * A, B and C are serving. The cycle is parked inside A — a cold backfill's bounded batch. The
   * customer connects D while it is parked. Adoption already guarantees D is ATTACHED at A's
   * boundary, before the cycle spends B's and C's batches, and `roster-preemption.e2e.test.ts`
   * proves that; this asserts the thing the customer is actually waiting for, which is D's first
   * SYNC.
   *
   * Before the fix D's first `sync_start` came after B's and C's next ones, because the cycle
   * walked the snapshot it took before D existed and a newcomer joins the map at the END. In
   * production that ordering was many minutes; here it is two batches, and the assertion is the
   * order.
   *
   * The park is RELEASED before every assertion, and before any `waitFor` that can fail: a
   * cycle suspended inside `changesSince` cannot reach a yield point, so `worker.stop()` would
   * wait out its drain and the failure would be reported as a hook timeout instead of as itself.
   */
  it("syncs a mailbox adopted mid-cycle before the rest of that cycle's rotation", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);
    const c = await seedMailbox(db);

    const worker: RunningWorker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 3, 8000, "A, B and C served");

    const release = parkSync(fleet, a.mailboxId);
    await waitFor(() => fleet.syncInFlight === 1, 8000, "a cycle parked inside A's changesSince");
    // Captured while the cycle is parked at A, so the next entries at these indices ARE this
    // cycle's visits to B and C.
    const bBefore = fleet.indicesOf(b.mailboxId, "sync_start").length;
    const cBefore = fleet.indicesOf(c.mailboxId, "sync_start").length;

    // The customer connects their mailbox now, mid-backfill. A roster pass adopts it while A holds
    // the cycle, OBSERVED rather than slept for, so it is attached at the moment A returns.
    const d = await seedMailbox(db);
    await waitFor(() => worker.stats().mailboxes === 4, 8000, "D adopted while A holds the cycle")
      .finally(release);
    await waitFor(
      () => fleet.indicesOf(d.mailboxId, "sync_start").length > 0, 8000, "D's first sync",
    );
    const dFirstSync = fleet.nth(d.mailboxId, "sync_start", 1);
    const label = fleet.describeTrace(new Map([
      [a.mailboxId, "A"], [b.mailboxId, "B"], [c.mailboxId, "C"], [d.mailboxId, "D"],
    ]));
    expect(
      dFirstSync,
      `D has never synced, so it must not wait out B's batch — ${label}`,
    ).toBeLessThan(fleet.nth(b.mailboxId, "sync_start", bBefore + 1));
    expect(
      dFirstSync,
      `D has never synced, so it must not wait out C's batch — ${label}`,
    ).toBeLessThan(fleet.nth(c.mailboxId, "sync_start", cBefore + 1));
  }, 30000);

  /**
   * AND THE ORDER ON EVERY LATER PASS, which is the same term without a park.
   *
   * Every mailbox is a first-syncer at boot, so this claim is about the SECOND pass onward: a
   * mailbox whose cycles have all FAILED must lead the rotation rather than trail the mailboxes
   * that already synced. That is the state the production mailbox was stuck in — attached three
   * times, never a completed cycle, and each re-attach put it back at the end of the queue behind
   * every other customer's backfill.
   *
   * Z is seeded LAST, so insertion order alone puts it last on every pass: without the fix the
   * trace reads X, Y, Z, X, Y, Z… `maxSyncFailures` is raised so the repeated failure never
   * quarantines it — the claim is about the ORDER of the attempts, and `sync_start` is noted
   * before `syncError` is thrown, so a failing cycle is still a visible visit.
   *
   * THE PARK IS THE PASS BOUNDARY, and it has to be: a version of this test that simply waited
   * for two visit counts to advance and compared trace indices PASSED BOTH `toBeLessThan` AND
   * `toBeGreaterThan` on consecutive runs against unfixed code — passes run back to back, so
   * "which counter advanced first" is a race and the assertion was decorative. Parking Y makes
   * the question a single unambiguous one, asked at one instant: with the cycle suspended inside
   * Y's batch of THIS pass, has the never-synced Z been visited in this pass yet? Under insertion
   * order it cannot have been; it comes after Y. Counts, not trace indices, so nothing depends on
   * where the previous pass ended.
   */
  it("leads the rotation with a mailbox whose earlier cycles all failed", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const x = await seedMailbox(db);
    const y = await seedMailbox(db);
    const z = await seedMailbox(db);   // LAST in insertion order, and the one that never syncs

    fleet.behave(z.mailboxId, { syncError: new Error("provider refused the cycle") });

    const worker = await startWorker({ ...cfgFor(fleet), maxSyncFailures: 100 });
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 3, 8000, "X, Y and Z served");
    // Pass 1 is over: every mailbox is a first-syncer at boot, so ordering can only be observed
    // from pass 2 onward — by which point X and Y have succeeded and Z has not.
    await waitFor(
      () => fleet.indicesOf(x.mailboxId, "sync_start").length > 0
        && fleet.indicesOf(y.mailboxId, "sync_start").length > 0
        && fleet.indicesOf(z.mailboxId, "sync_start").length > 0,
      8000, "the first pass to have visited all three",
    );

    const release = parkSync(fleet, y.mailboxId);
    await waitFor(() => fleet.syncInFlight === 1, 8000, "a later pass parked inside Y's batch");
    const yVisits = fleet.indicesOf(y.mailboxId, "sync_start").length;
    const zVisits = fleet.indicesOf(z.mailboxId, "sync_start").length;
    const label = fleet.describeTrace(new Map([
      [x.mailboxId, "X"], [y.mailboxId, "Y"], [z.mailboxId, "Z"],
    ]));
    release();

    expect(
      zVisits,
      "with the cycle inside Y's batch, the mailbox that has NEVER completed a cycle must " +
      `already have had its turn in this pass — ${label}`,
    ).toBe(yVisits);
    expect(worker.stats(), "Z stays in the rotation while it is being retried")
      .toMatchObject({ mailboxes: 3, expected: 3 });
  }, 30000);
});
