import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { startWorker, type RunningWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A MAILBOX'S FIRST `last_sync_at` MUST NOT WAIT ON THE REST OF THE ROTATION
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `evaluateAlerts` measures `coalesce(last_sync_at, created_at) < now() - 15 minutes`
 * (`packages/db/src/alerts.ts`), so the 15 minutes are counted from the moment the mailbox ROW
 * was created — from the user pressing Connect, not from the worker's current pass. A first
 * connect that spends longer than that with the column NULL pages `sync_lag` with
 * *"their owners are not receiving mail"* about a mailbox that is actively ingesting.
 *
 * ── WHAT WAS ACTUALLY WRONG, WHICH IS NOT WHAT THE GAP SAID ───────────────────────────────
 *
 * The gap was filed as "`stampMailboxSync` fires only on cycle completion and the first cycle carries
 * the whole backfill". That mechanism no longer exists: the non-blocking attach moved the drain onto `cycle()`,
 * `synced.push` at `index.ts:1558` runs on a TRUNCATED batch as well
 * (`DEFAULT_SYNC_BATCH_MAX_MESSAGES` = 200), and the batched stamp lands before the `hasBacklog`
 * re-kick. So the bar has been "one bounded batch" for a while.
 *
 * What survived is the SERIALIZATION, and it has two arms:
 *
 *  · the batched write sits after the whole rotation loop, so mailbox A's first stamp waits on
 *    every other mailbox's bounded batch. Two live mailboxes measured minutes to the
 *    first completed pass — little margin, which a third backfilling
 *    mailbox on the shard spends;
 *  · `if (stopped) return;` at the top of the loop returns BEFORE that write, so a deploy landing
 *    mid-rotation discards the stamp for every mailbox that had already synced in the pass.
 *
 * The sharp case is neither: one mailbox whose `changesSince` HANGS holds `synced` in memory for
 * as long as it hangs, and every healthy mailbox in that rotation reads NULL while serving.
 *
 * ── WHY THAT IS THE SHAPE THIS FILE TESTS ─────────────────────────────────────────────────
 *
 * A stopwatch against a fake adapter measures the harness. The defect is an ORDERING — is this
 * mailbox's stamp behind another mailbox's `changesSince`? — so B is PARKED inside `changesSince`
 * with `FakeControl.syncGate` and the assertion is read while it is parked. Nothing in this file
 * waits for a duration.
 *
 * `apps/worker/test/sync-stamp.pg.test.ts` owns the writer itself (and the source scans that keep
 * the batched caller where it is). This file owns WHEN the first one happens.
 *
 * Nowhere near a real mailbox: two fake mailboxes in an isolated database.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 43));
let DB = "";
type Db = ReturnType<typeof makeDb>;

async function seedMailbox(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

function mail(n: number, tag: string): Array<{ from: string; subject: string; messageId: string }> {
  return Array.from({ length: n }, (_, i) => ({
    from: `sender${i}@backlog.test`,
    subject: `${tag} ${i}`,
    messageId: `ic3-${tag}-${i}@backlog.test`,
  }));
}

/**
 * The intervals are LONGER than the test window on purpose: the only cycle in this test is the
 * one the boot kicks, so nothing but the code under test can produce the stamp being asserted.
 */
function cfgFor(fleet: FakeAdapterFleet, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, sentDomain: "trafficflow.test",
    adapterFactory: fleet.factory,
    pollIntervalMs: 60_000, rosterIntervalMs: 60_000, lockHeartbeatMs: 60_000,
    alertIntervalMs: 600_000, maxSyncFailures: 3, mailboxRetryMs: 1_000,
    ...over,
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

describe("the first stamp is this mailbox's own business", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_ic3stamp"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  const releases: Array<() => void> = [];
  afterEach(async () => {
    // The gate FIRST: `stop()` waits for the in-flight cycle, and a cycle parked inside
    // `changesSince` would never let it finish.
    for (const r of releases.splice(0)) r();
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("a mailbox is stamped on its own first batch, while a later mailbox is still mid-sync", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();

    // ── HOW MANY MAILBOXES, AND WHY IT IS NO LONGER THREE ─────────────────────────
    //
    // Seeded in order, because the roster is stable oldest-first: A leads the rotation, then B,
    // C, D, E. The last one exists so the SHUTDOWN arm below has a mailbox the pass never
    // REACHED — that is what makes the pass demonstrably truncated, and therefore what makes A's
    // and B's surviving stamps evidence of their own per-mailbox writes rather than of the
    // batched one.
    //
    // Three used to be enough because the rotation was serial: park the second and the third is
    // unreachable. The rotation now runs `DEFAULT_CYCLE_LANES` mailboxes at once and REFILLS a
    // lane the instant one frees, so an unreached mailbox needs every lane held: B, C and D are
    // all parked inside `changesSince`, and E is the witness behind them. The lane count is
    // deliberately NOT pinned here — the claim is about the stamp, and it has to hold in the
    // configuration that ships.
    const A = await seedMailbox(db);
    const B = await seedMailbox(db);
    const C = await seedMailbox(db);
    const D = await seedMailbox(db);
    const E = await seedMailbox(db);
    const names = new Map([
      [A.mailboxId, "A"], [B.mailboxId, "B"], [C.mailboxId, "C"], [D.mailboxId, "D"], [E.mailboxId, "E"],
    ]);

    // A: enough messages for several 40-message batches, so its FIRST cycle is truncated and it still owes a
    // backlog at the moment of the assertion. That matters — a mailbox stamped only after its
    // backlog drained would satisfy a weaker version of this claim.
    fleet.behave(A.mailboxId, { deliver: mail(120, "a"), batchSize: 40 });
    // B, C, D: parked inside `changesSince` forever. This is the stand-in for "still working":
    // the hung-provider case in the extreme, and every slow mailbox in between. Three of them
    // because three is what it takes to hold every lane — see above.
    let release = (): void => { /* replaced below */ };
    const parked = new Promise<void>((resolve) => { release = () => { resolve(); }; });
    releases.push(() => { release(); });
    fleet.behave(B.mailboxId, { deliver: mail(1, "b"), syncGate: parked });
    fleet.behave(C.mailboxId, { deliver: mail(1, "c"), syncGate: parked });
    fleet.behave(D.mailboxId, { deliver: mail(1, "d"), syncGate: parked });
    fleet.behave(E.mailboxId, { deliver: mail(1, "e") });

    const worker: RunningWorker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());

    // ── THE OBSERVATION POINT, AND WHY IT MOVED ───────────────────────────────────
    //
    // It used to be `A's first sync_end has fired && syncInFlight === 1`, and that was a correct
    // reading of "A's whole visit has finished" only because the rotation was SERIAL: nothing
    // else could start until A's visit returned, so B's park was proof that A was done. With
    // lanes, B's `changesSince` is entered the moment A's RETURNS — while A is still ingesting
    // its batch — so that condition now fires in the middle of A's visit and the assertion below
    // races A's own stamp. It was measured doing exactly that: `A:sync_end@47ms → B:sync_start@48ms`
    // with `last_sync_at` still NULL.
    //
    // So the wait is on the visit LANDING rather than on a proxy for it, and the claim is
    // unchanged and un-weakened: A's stamp must exist WHILE B is parked inside `changesSince`,
    // which is the ordering this file is about. The timeout is where a mutation lands — deleting
    // the first-success stamp in `cycle()` makes this wait run out and say so — and the CONTROL
    // below (B must still read NULL at the same instant) is what stops a blanket
    // `UPDATE mailboxes SET last_sync_at = now()` from satisfying it.
    //
    // Still no duration is asserted anywhere: `syncInFlight === 1` is what makes the instant
    // meaningful, and B stays parked until this test releases it.
    const stampOfA = async (): Promise<Date | null> => {
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, A.mailboxId));
      return row?.lastSyncAt ?? null;
    };
    await waitFor(
      async () => (await stampOfA()) !== null && fleet.syncInFlight >= 1,
      30_000,
      "A's first bounded batch to be stamped WHILE another mailbox is parked inside changesSince " +
      `— a mailbox that completed a clean batch must not read as never-synced — trace: ${fleet.describeTrace(names)}`,
    );

    // `expect.soft` throughout, like `attach-nonblocking.e2e.test.ts`: each claim below breaks for
    // a different reason, and a mutation should show every one it breaks rather than the first.
    const [rowA] = await db.select().from(mailboxes).where(eq(mailboxes.id, A.mailboxId));
    expect.soft(rowA!.lastSyncAt,
      `A completed a clean batch and reads as never-synced while B is mid-sync — trace: ${fleet.describeTrace(names)}`)
      .not.toBeNull();

    // …and it was stamped on a TRUNCATED batch: one batch ingested, backlog outstanding.
    const ingested = await db.select().from(messages).where(eq(messages.mailboxId, A.mailboxId));
    expect.soft(ingested.length, "A's first batch was not bounded — the claim is about a partial drain")
      .toBe(40);

    // ── A PARTIAL IMPORT IS NOT A COMPLETE ONE ────────────────────────────────────────────
    //
    // A carries a `last_sync_at` (it completed a bounded batch) and STILL OWES 80 messages, which is
    // exactly the partial state the client used to read as complete once its own mirror settled.
    // `initial_import_completed_at` is stamped only on a `hasBacklog === false` cycle, so it must be
    // NULL here — the floor that keeps the strip saying "still importing" depends on it. A worker
    // that stamped it beside `last_sync_at` would let A present a mailbox with a hole in it as done.
    expect.soft(rowA!.initialImportCompletedAt,
      `A marked its first import complete with a backlog still owed — trace: ${fleet.describeTrace(names)}`)
      .toBeNull();

    // THE CONTROL. Without it, a blanket `UPDATE mailboxes SET last_sync_at = now()` would pass
    // the assertion above, and the alert it feeds would be permanently silenced rather than
    // correct. B has not completed a cycle, so B must still read NULL.
    const [rowB] = await db.select().from(mailboxes).where(eq(mailboxes.id, B.mailboxId));
    expect.soft(rowB!.lastSyncAt, "a mailbox that has not completed a batch must not be credited with one")
      .toBeNull();

    // ── THE SHUTDOWN ARM ────────────────────────────────────────────────────────────────
    //
    // `stop()` sets `stopped` synchronously and then waits for the in-flight cycle, so releasing
    // the parked mailboxes AFTER asking to stop reproduces a deploy landing mid-rotation exactly:
    // their success arms run, the rotation joins its lanes, `if (stopped) return;` fires — and the
    // batched write at the end of the pass never executes. Everything that synced in that pass
    // keeps its stamp only because each one wrote its own.
    //
    // The join before that return is the one non-negotiable addition: a `return` with lanes
    // still inside `changesSince` would leave `stop()`'s own detaches closing adapters mid-batch.
    // What it does NOT change is which write is skipped, which is the whole of this claim.
    const stopping = worker.stop();
    release();
    await stopping;

    const [aAfter] = await db.select().from(mailboxes).where(eq(mailboxes.id, A.mailboxId));
    const [bAfter] = await db.select().from(mailboxes).where(eq(mailboxes.id, B.mailboxId));
    const [eAfter] = await db.select().from(mailboxes).where(eq(mailboxes.id, E.mailboxId));
    expect.soft(aAfter!.lastSyncAt,
      `a shutdown before the batched write discarded A's stamp — trace: ${fleet.describeTrace(names)}`)
      .not.toBeNull();
    expect.soft(bAfter!.lastSyncAt,
      `B completed its batch during the shutdown and lost its stamp with the pass — trace: ${fleet.describeTrace(names)}`)
      .not.toBeNull();
    // The control for the shutdown arm: E never ran a cycle, and a stamp is evidence, not a
    // participation award. It is also what proves the pass was TRUNCATED — without a mailbox the
    // rotation never reached, A's and B's surviving stamps would be equally explained by the
    // batched write having run after all.
    expect.soft(eAfter!.lastSyncAt, "a mailbox the pass never reached must not be stamped").toBeNull();
    expect.soft(fleet.indicesOf(E.mailboxId, "sync_end").length,
      "E synced after all — the shutdown arm did not reproduce a truncated pass").toBe(0);
  }, 120_000);
});
