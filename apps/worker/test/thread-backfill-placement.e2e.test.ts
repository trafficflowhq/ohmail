import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { randomUUID } from "node:crypto";
import { startWorker, type RunningWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import {
  THREAD_BACKFILL_SLICE_MS, THREAD_BACKFILL_SLICE_PAGES,
  type ThreadBackfillDeps, type ThreadBackfillResult,
} from "../src/thread-backfill.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { byMessageId } from "./_workerdb.js";

/**
 * WHERE THE THREAD BACKFILL RUNS, AND WHAT IT MAY COST.
 *
 * On 2026-08-02 a change ran `runThreadBackfill` on the ATTACH path. Against the small
 * seeded world that is invisible; against a large live mailbox it held a
 * freshly-dialled, not-yet-IDLE IMAP connection open for minutes, the socket timed out,
 * imapflow emitted the failure on a client with no `error` listener, and the process died — and
 * repeated it every few seconds for minutes with `mailboxes: 0`. See the INCIDENT entry at the
 * end of the project's design notes.
 *
 * Four claims, and the seam that makes them testable is `WorkerConfig.threadBackfill`: a real
 * pass cannot be made to hang, throw an `ETIMEOUT`, or count its own invocations.
 *
 *  1. attach never waits for the backfill — proven with a backfill that never returns;
 *  2. a throwing backfill costs the cycle and the process nothing;
 *  3. every slice the worker asks for is BOUNDED, and the worker keeps asking (resumption);
 *  4. slices round-robin over accounts, so one enormous mailbox cannot starve another.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";

type Db = ReturnType<typeof makeDb>;

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

function cfgFor(fleet: FakeAdapterFleet, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
    adapterFactory: fleet.factory, maxSyncFailures: 3, mailboxRetryMs: 500,
    rosterIntervalMs: 500, lockHeartbeatMs: 5_000, alertIntervalMs: 60_000,
    ...over,
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

const DRAINED: ThreadBackfillResult = { resolved: 0, threadsCreated: 0, truncated: false };

describe("thread backfill placement", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_c3a"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } } }, ISOLATED_DB_RESET_BUDGET_MS);

  /**
   * A process-level tripwire. The incident's exit code did not come from a rejected await — it
   * came from an event with no listener — so "the worker survived" is a claim about the PROCESS
   * and has to be asserted there. Vitest fails a file on an unhandled rejection anyway; this
   * makes the reason legible instead of a mystery stack at the end of the run.
   */
  function watchForEscapes(): () => void {
    const escapes: unknown[] = [];
    const onRejection = (e: unknown): void => { escapes.push(e); };
    const onException = (e: unknown): void => { escapes.push(e); };
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onException);
    return () => {
      process.removeListener("unhandledRejection", onRejection);
      process.removeListener("uncaughtException", onException);
      expect(escapes, "something escaped to the process — this is how the process exited before").toEqual([]);
    };
  }

  it("attach does not wait for the backfill: one that NEVER returns still leaves the mailbox serving", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    await seedMailbox(db);

    // Far longer than any IMAP socket timeout — it does not end until the test says so. Under
    // the placement this sits between `adapter.connect()` and `adapter.watch()`, which is
    // exactly the shape that killed production.
    let release: () => void = () => { /* replaced */ };
    const gate = new Promise<void>((r) => { release = r; });
    let entered = 0;
    let syncsAtFirstEntry = -1;
    const threadBackfill = async (): Promise<ThreadBackfillResult> => {
      if (entered === 0) syncsAtFirstEntry = fleet.syncs;
      entered++;
      await gate;
      return DRAINED;
    };
    // Registered before the boot so a failed boot still frees the gate.
    closers.push(async () => { release(); });

    const t0 = Date.now();
    const worker: RunningWorker = await startWorker(cfgFor(fleet, { threadBackfill }));
    // Teardown ORDER matters: `stop()` drains the serial queue and a slice parked on the gate
    // is ON that queue, so the gate opens first.
    closers.push(async () => { release(); await worker.stop(); });

    const attachMs = Date.now() - t0;
    expect(worker.stats().mailboxes, "the mailbox is attached and in the rotation").toBe(1);
    // The number the incident was about. Before that change the large live mailbox attached in
    // seconds; the change pushed it past the socket timeout. A backfill that never returns must not add a
    // millisecond, because attach must not be a caller of it at all.
    expect(attachMs, "attach waited on the backfill").toBeLessThan(5_000);

    // …and the backfill DOES run — off the cycle, which is the other half of the claim. It is
    // not "removed", it is "moved", and a slice that never runs would leave the threading report failing.
    await waitFor(() => entered > 0, 10_000, "the backfill to be entered from the cycle");
    // ORDER, asserted without a stopwatch. The slice is kicked from the TAIL of `cycle()`, so a
    // slice reached from anywhere else — the attach path in particular — would see zero syncs
    // behind it. This held before that change because `attach` itself ran two sync cycles, and it
    // holds after it for a better reason: nothing on the attach path syncs at all, so a nonzero
    // count is now positive proof the caller was a completed cycle.
    expect(syncsAtFirstEntry, "the backfill ran before any sync cycle — it is not on the cycle tail")
      .toBeGreaterThan(0);
  }, 60_000);

  /**
   * A THROWING SLICE, and an honest note about WHICH layer contains it.
   *
   * Three layers stand between a failing slice and the process, and they are not equal. I
   * mutated each one:
   *
   *  · the slice's own `try/catch` — removing it leaves this test GREEN, because
   *  · `serialize()` already does `tail = run.catch(() => undefined)`, which attaches a
   *    rejection handler to the very promise `kickThreadBackfill` discards. Removing the outer
   *    `.catch` as well is STILL green for the same reason. The queue is the load-bearing part,
   *    and it was there before this slice;
   *  · what the slice's catch actually buys is the LOG LINE. Without it the failure is
   *    swallowed by `serialize`'s no-op handler and an operator sees a drain that silently
   *    never happens — so the assertion on the log below is what makes that layer testable, and
   *    it is the one that goes red when the catch is deleted.
   *
   * Running the slice OFF the queue with no catch does escape to the process; that mutation is
   * red, which is also what proves the tripwire in `watchForEscapes` is not a no-op.
   */
  it("a throwing backfill kills neither the cycle nor the process, and mail keeps flowing", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db);
    fleet.behave(mb.mailboxId, {
      deliver: [{ from: "anna@x.example", subject: "after the throw", messageId: "c3a-1@x" }],
    });
    const assertNoEscapes = watchForEscapes();

    const logged: string[] = [];
    const logger = {
      debug: () => { /* unused */ },
      info: () => { /* unused */ },
      warn: () => { /* unused */ },
      error: (event: string) => { logged.push(event); },
      child() { return this; },
    };

    let calls = 0;
    const threadBackfill = async (): Promise<ThreadBackfillResult> => {
      calls++;
      // The incident's own error class and code: an IMAP socket that died under a long pass.
      const err = new Error("socket timeout") as Error & { code: string };
      err.code = "ETIMEOUT";
      throw err;
    };

    const worker = await startWorker(cfgFor(fleet, { threadBackfill, logger }));
    closers.push(() => worker.stop());

    await waitFor(() => calls >= 3, 15_000, "three failed slices");

    // REPORTED, not merely survived. `serialize()` would swallow the rejection on its own, so
    // the difference the slice's own catch makes is that the failure is visible at all.
    expect(logged.filter((e) => e === "thread_backfill_failed").length)
      .toBeGreaterThanOrEqual(3);

    // The cycle is unharmed: the mailbox is still attached, still syncing, and the message the
    // adapter is holding lands in the database.
    expect(worker.stats().mailboxes).toBe(1);
    expect(worker.stats().quarantined, "a failing backfill quarantined the mailbox").toBe(0);
    await waitFor(async () => (await db.select().from(messages)
      .where(byMessageId(mb.mailboxId, "c3a-1@x"))).length === 1,
      15_000, "the message to be ingested despite the failing backfill");

    // FRESHNESS: a cycle that carried a failed slice still counts as a cycle that synced.
    expect(worker.stats().lastCycleAt).not.toBeNull();
    assertNoEscapes();
  }, 60_000);

  it("asks for a BOUNDED slice every time, and keeps asking — the drain resumes", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    await seedMailbox(db);

    const seen: ThreadBackfillDeps[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const threadBackfill = async (deps: ThreadBackfillDeps): Promise<ThreadBackfillResult> => {
      seen.push(deps);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      // "There is more" — the shape of a real slice against a large backlog. The
      // worker must come back for the rest instead of treating one pass as the whole job.
      return { resolved: THREAD_BACKFILL_SLICE_PAGES * 100, threadsCreated: 12, truncated: true };
    };

    const worker = await startWorker(cfgFor(fleet, { threadBackfill }));
    closers.push(() => worker.stop());

    await waitFor(() => seen.length >= 3, 15_000, "three slices");

    // BOUNDED — the worker never asks for a drain-to-exhaustion, which is precisely what the first version did.
    for (const deps of seen) {
      expect(deps.maxPages).toBe(THREAD_BACKFILL_SLICE_PAGES);
      expect(deps.deadlineMs).toBe(THREAD_BACKFILL_SLICE_MS);
    }
    // …and ONE at a time. Slices ride the serial queue; two at once would mean the dedupe flag
    // is not holding and a slow account could stack cycles' worth of work on itself.
    expect(maxInFlight).toBe(1);
  }, 60_000);

  it("round-robins over accounts, so one enormous mailbox cannot starve another", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);
    expect(a.accountId).not.toBe(b.accountId);

    const order: string[] = [];
    const threadBackfill = async (deps: ThreadBackfillDeps): Promise<ThreadBackfillResult> => {
      order.push(deps.accountId);
      return { resolved: 2_000, threadsCreated: 40, truncated: true };   // never finishes
    };

    const worker = await startWorker(cfgFor(fleet, { threadBackfill }));
    closers.push(() => worker.stop());

    await waitFor(() => order.length >= 4, 20_000, "four slices across two accounts");

    // Both accounts get turns even though neither backlog ever drains. A cursor that did not
    // advance would put the first account's id four times in this list and the second account's
    // conversations would never appear.
    const window = order.slice(0, 4);
    expect(new Set(window).size, `slices went to one account only: ${window.join(", ")}`).toBe(2);
    expect(window[0]).not.toBe(window[1]);
    expect(window[1]).not.toBe(window[2]);
  }, 60_000);
});
