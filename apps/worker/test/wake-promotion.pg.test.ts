import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { startWorker, type RunningWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { byMessageId } from "./_workerdb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  a doorbell that rings BEFORE a mailbox's turn must move that turn forward
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The half of the wake story `roster-serialization.pg.test.ts` does not cover. That file proves
 * a woken mailbox that was ALREADY SERVED this pass is re-admitted (`admitWoken`), and that the
 * fast lane keeps a wake from waiting out a deep batch. What it never exercises is a wake for a
 * mailbox still WAITING in the pass's snapshot: the pass plans its order once at the top, so
 * before `reorderPending` a doorbell that rang two seconds into a long pass for the last mailbox
 * in the snapshot bought nothing at all.
 *
 * Measured in production on 2026-08-26 (the inbound-latency slice): a probe message reached the
 * provider's INBOX at 09:14:25, `sync_requested_at` was stamped at 09:14:29, the 3-second kick
 * pass marked the runtime woken continuously — and the message reached the mirror at 09:22:23,
 * minutes later, because the mailbox's position in the running pass was fixed before its
 * wake existed. The fix is `reorderPending` in `cycle()`'s dispatcher: a stable re-partition of
 * what is left of `pending` into the exact groups the planner used (first-syncers, then woken by
 * oldest wake, then the rest), applied on every dispatcher turn.
 *
 * Order and presence, never a stopwatch — the same rule the neighbouring suites state.
 * Real Postgres, isolated database, fake providers.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 47));
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

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

const POLL_MS = 80;

function cfgFor(fleet: FakeAdapterFleet, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, sentDomain: "trafficflow.test",
    adapterFactory: fleet.factory,
    pollIntervalMs: POLL_MS, rosterIntervalMs: 5_000, lockHeartbeatMs: 60_000,
    alertIntervalMs: 600_000, maxSyncFailures: 50, mailboxRetryMs: 60_000,
    ...over,
  };
}

async function landed(db: Db, mailboxId: string, messageId: string): Promise<boolean> {
  const rows = await db.select({ id: messages.id }).from(messages).where(byMessageId(mailboxId, messageId));
  return rows.length > 0;
}

/** Park a mailbox's NEXT `changesSince` — the deterministic long batch, as the suites beside this one use it. */
function parkSync(fleet: FakeAdapterFleet, mailboxId: string): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fleet.behave(mailboxId, { syncGate: gate });
  return () => { fleet.behave(mailboxId, { syncGate: undefined }); release(); };
}

describe("wake promotion", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_wake_promo"); }, 60_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  /** Gates to open BEFORE stop() — a worker suspended inside a gate never lets the hook finish. */
  const releases: Array<() => void> = [];
  afterEach(async () => {
    for (const r of releases.splice(0)) { try { r(); } catch { /* ignore */ } }
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("serves a mailbox woken MID-PASS before an unwoken mailbox ahead of it in the snapshot", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    // Three mailboxes, three accounts, ONE lane: the pass is the exact serial rotation, so the
    // snapshot order A → B → C is the order the dispatcher would serve without the reorder, and
    // "C before B" below can only come from the wake moving C forward.
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);
    const c = await seedMailbox(db);
    const names = new Map([[a.mailboxId, "A"], [b.mailboxId, "B"], [c.mailboxId, "C"]]);

    const worker: RunningWorker = await startWorker(cfgFor(fleet, { cycleLanes: 1 }));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 3, 10_000, "A, B and C served");
    // Everyone completes a first cycle, so nobody is a first-syncer when the claim is read —
    // on the first pass every runtime ranks as a first-syncer and the reorder is (correctly)
    // inert, which would make this test pass vacuously against the unfixed dispatcher.
    await waitFor(
      () => [a, b, c].every((m) => fleet.indicesOf(m.mailboxId, "sync_end").length >= 1),
      10_000, "a completed first pass for all three",
    );

    // Park A's next batch. The single lane is now suspended inside A, and B and C are waiting
    // in this pass's snapshot, in that order, both unserved.
    const releaseA = parkSync(fleet, a.mailboxId);
    releases.push(releaseA);
    await waitFor(() => fleet.syncInFlight === 1, 20_000, "the pass parked inside A's batch");
    const bStartsAtPark = fleet.indicesOf(b.mailboxId, "sync_start").length;
    const cStartsAtPark = fleet.indicesOf(c.mailboxId, "sync_start").length;

    // C's doorbell rings with mail behind it — while C is still WAITING for its turn.
    fleet.behave(c.mailboxId, { deliver: [{ from: "anna@x.example", subject: "rang early", messageId: "promo-c@x" }] });
    fleet.signal.get(c.mailboxId)!();

    releaseA();
    await waitFor(() => landed(db, c.mailboxId, "promo-c@x"), 20_000, "C's woken mail");
    // B's own next turn is a few milliseconds BEHIND C's on a healthy rotation, so it is waited
    // for rather than read instantly — asserting the moment C's mail lands raced the rotation
    // and read `Infinity` for a turn that was already on its way (two measured flakes before
    // this wait existed, both this line, neither an ordering violation).
    await waitFor(
      () => fleet.indicesOf(b.mailboxId, "sync_start").length >= bStartsAtPark + 1,
      20_000, "B's next turn — promotion must reorder, never evict",
    );

    // THE ORDER, which is the whole claim: the lane A released went to C, not to B's snapshot
    // position. Mutation evidence: deleting the `reorderPending()` call in `cycle()`'s
    // dispatcher turns exactly this red (B is served first, in planned order) while every other
    // suite stays green — watched fail on 2026-08-26 when the fix landed.
    const bNext = fleet.nth(b.mailboxId, "sync_start", bStartsAtPark + 1);
    const cNext = fleet.nth(c.mailboxId, "sync_start", cStartsAtPark + 1);
    expect(cNext, "C was never visited again, so the order claim is vacuous").not.toBe(Infinity);
    expect(
      cNext,
      "a wake for a not-yet-served mailbox must move it ahead of unwoken snapshot positions — " +
      `trace: ${fleet.describeTrace(names)}`,
    ).toBeLessThan(bNext);
    expect(worker.stats().mailboxes).toBe(3);
  }, 120_000);

  it("stamps last_sync_at EAGERLY on a woken visit — the pull spinner's settle signal", async () => {
    // `POST /sync/pull` answers `requestedAt`, and the client settles its spinner when every
    // connected mailbox's `lastSyncAt` moves past it. The batched stamp lands at the END of the
    // whole pass — minutes behind the woken visit under load — so the woken visit stamps its own
    // row on completion. Proven by SHAPE, not timing: H's lane is still parked (the pass is
    // demonstrably not over, so the batched stamp cannot have run) when L's stamp is read.
    // Mutation evidence: reverting the stamp condition to bare `firstSuccess` turns the
    // stamped-while-parked assertion red — watched fail on 2026-08-26 when the fix landed.
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const h = await seedMailbox(db);
    const l = await seedMailbox(db);

    const worker: RunningWorker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 2, 10_000, "H and L served");
    await waitFor(
      () => [h, l].every((m) => fleet.indicesOf(m.mailboxId, "sync_end").length >= 1),
      10_000, "a completed first pass for both",
    );

    const releaseH = parkSync(fleet, h.mailboxId);
    releases.push(releaseH);
    await waitFor(() => fleet.syncInFlight === 1, 20_000, "a lane parked inside H's batch");
    const stampAtPark = (await db.select({ at: mailboxes.lastSyncAt }).from(mailboxes)
      .where(eq(mailboxes.id, l.mailboxId)))[0]!.at;

    fleet.behave(l.mailboxId, { deliver: [{ from: "anna@x.example", subject: "stamp me", messageId: "stamp-l@x" }] });
    fleet.signal.get(l.mailboxId)!();
    await waitFor(() => landed(db, l.mailboxId, "stamp-l@x"), 20_000, "L's woken mail while H is parked");
    // Give L's visit its tail (the stamp is after the ingest, in the same visit), bounded.
    await waitFor(async () => {
      const row = (await db.select({ at: mailboxes.lastSyncAt }).from(mailboxes)
        .where(eq(mailboxes.id, l.mailboxId)))[0]!;
      return row.at !== null && (stampAtPark === null || row.at.getTime() > stampAtPark.getTime());
    }, 10_000, "L's last_sync_at to advance while the pass is still parked");

    // …and the pass is DEMONSTRABLY still in flight, so the batched stamp cannot be the writer.
    expect(fleet.syncInFlight, "H's batch had returned, so the eager claim is unproven").toBe(1);
    const eager = (await db.select({ at: mailboxes.lastSyncAt }).from(mailboxes)
      .where(eq(mailboxes.id, l.mailboxId)))[0]!.at!;

    // ── AND THE PASS-END BATCH MUST NOT UN-SETTLE IT ────────────────────────────────────────
    //
    // The batch stamp backdates to the PASS's start — earlier than L's eager visit-start stamp —
    // so an unconditional batch write would REGRESS the column and re-open a spinner the eager
    // stamp had honestly settled (review round 3). `stampMailboxSyncNow` writes GREATEST for
    // exactly this; the release below lets the parked pass finish and its batch write run.
    // Mutation evidence: dropping the GREATEST (bare `now() - interval` write) turns the
    // no-regression assertion red — watched fail on 2026-08-26 when the fix landed.
    const hEndsAtPark = fleet.indicesOf(h.mailboxId, "sync_end").length;
    releaseH();
    // Park H's NEXT batch too, in the same tick: the FOLLOWING pass must not complete, or its
    // own (fresh) batch stamp papers over the regression within one test poll and the mutation
    // below is invisible — which is exactly how it would hide in a fast test world while
    // costing a real client up to a full pass in production.
    const releaseH2 = parkSync(fleet, h.mailboxId);
    releases.push(releaseH2);
    await waitFor(
      () => fleet.indicesOf(h.mailboxId, "sync_end").length > hEndsAtPark,
      20_000, "H's parked batch to return so the pass can end",
    );
    // The wake survives its own visit (deliberately), so pass P+1 revisits L once more and its
    // EAGER stamp fires again — later than P's, so the monotonicity claim is unaffected. Wait
    // for P+1 to be parked inside H with L's revisit done, THEN read: the only writer left that
    // could have touched the row since the last eager stamp is pass P's END-OF-PASS BATCH.
    await waitFor(() => fleet.syncInFlight === 1, 20_000, "the NEXT pass parked inside H");
    await new Promise((r) => setTimeout(r, POLL_MS * 2));
    const after = (await db.select({ at: mailboxes.lastSyncAt }).from(mailboxes)
      .where(eq(mailboxes.id, l.mailboxId)))[0]!.at!;
    expect(after.getTime(), "the pass-end batch regressed a newer eager stamp")
      .toBeGreaterThanOrEqual(eager.getTime());
  }, 60_000);

  it("re-arms the watch after every successful visit — the connection ends each turn back on INBOX", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const m = await seedMailbox(db);

    const worker: RunningWorker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 1, 10_000, "the mailbox served");

    // Two completed visits, each followed by a re-arm: the wake channel is re-established per
    // visit, not once at attach — which is the production defect this guards (an IDLE left on
    // the last-scanned folder is a dead push channel that looks healthy; p50 194 s measured).
    // Mutation evidence: deleting the `rt.adapter.rearmWatch?.()` call in `visitMailbox` turns
    // the count below to zero — watched fail on 2026-08-26 when the fix landed.
    await waitFor(
      () => fleet.indicesOf(m.mailboxId, "sync_end").length >= 2
        && fleet.indicesOf(m.mailboxId, "rearm").length >= 2,
      15_000,
      "two completed visits and two re-arms",
    );
    expect(
      fleet.nth(m.mailboxId, "rearm", 1),
      "the re-arm belongs AFTER the visit's folder work, not before it",
    ).toBeGreaterThan(fleet.nth(m.mailboxId, "sync_end", 1));
  }, 60_000);
});
