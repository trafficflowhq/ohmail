import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { mailboxes, mailboxCredentials, messages } from "@trafficflow/db";
import { makeDb, closeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core";
import { startWorker, type RunningWorker } from "../src/index.js";
import { MAX_CYCLE_LANES, DEFAULT_CYCLE_LANES, CYCLE_FAST_LANES, type WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { byMessageId } from "./_workerdb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  ONE MAILBOX'S HEAVY WORK MUST NOT DELAY ANOTHER MAILBOX'S INBOUND MAIL
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE TWO PRODUCTION MEASUREMENTS ────────────────────────────────────────────────────────
 *
 * Both on the same thirteen-mailbox shard, and both are the same defect seen from different ends:
 *
 *  · during a folder-coverage backfill, several of the shard's mailboxes crossed the `sync_lag`
 *    threshold — the worst by many minutes — because one mailbox's deep walk owned the serial rotation.
 *    It cleared when that mailbox finished, which is why it read as transient; it comes back on
 *    every first enumeration and every deep backfill wave, and the operator received the alert mail;
 *  · a mailbox went 15.5 minutes between visits, making end-to-end inbound 5 min 20 s on a wake
 *    channel that answers in under a second. A sub-second doorbell in front of a 15-minute queue
 *    is a 15-minute doorbell.
 *
 * ── WHY THIS FILE IS ORDER AND PRESENCE, NEVER A STOPWATCH ────────────────────────────────
 *
 * The same rule `first-sync-priority.e2e.test.ts` states: a duration measured against a fake
 * adapter measures the harness. So the heavy mailbox is PARKED inside `changesSince`
 * (`FakeControl.syncGate`) — the hung-provider case in the extreme, and every deep batch in
 * between — and every claim is read while it is parked. The one number this file reports is
 * printed, never asserted.
 *
 * ── THE CONTROL IS A LANE COUNT, WHICH IS WHY THE MUTATION IS PERMANENT ───────────────────
 *
 * `cycleLanes: 1` IS the pre-W-LANES rotation — not an approximation of it, the same code path with
 * one lane — so the first two claims below are the same scenario asserted in both directions:
 * starved at one lane, served at the shipped default. A mutation that restores serial-everything
 * therefore cannot make this file green, because the file already contains that mutation as its
 * own control.
 *
 * ── AND THE INVARIANTS CONCURRENCY IS NOT ALLOWED TO BUY IT WITH ──────────────────────────
 *
 * Three, each with its own claim below: one cycle per ACCOUNT (which strictly implies one cycle
 * per mailbox), the pool-derived ceiling on lanes, and the fast-lane reservation in BOTH
 * directions — the light mailbox is served AND the heavy one keeps draining.
 *
 * Real Postgres, isolated database, fake providers. Nowhere near anybody's mailbox.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 91));
let DB = "";
type Db = ReturnType<typeof makeDb>;

/** A mailbox in its OWN account, which is the production shape (one shard, many customers). */
async function seedMailbox(db: Db, accountId = randomUUID()): Promise<{ accountId: string; mailboxId: string }> {
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

function mail(n: number, tag: string): Array<{ from: string; subject: string; messageId: string }> {
  return Array.from({ length: n }, (_, i) => ({
    from: `sender${i}@backlog.test`,
    subject: `${tag} ${i}`,
    messageId: `x1h7-${tag}-${i}@backlog.test`,
  }));
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

/** How many of a mailbox's messages have actually been ingested. */
async function ingested(db: Db, mailboxId: string): Promise<number> {
  const rows = await db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, mailboxId));
  return rows.length;
}

/** Has THIS message landed? The product claim — a trace entry is not a delivered mail. */
async function landed(db: Db, mailboxId: string, messageId: string): Promise<boolean> {
  const rows = await db.select({ id: messages.id }).from(messages).where(byMessageId(mailboxId, messageId));
  return rows.length > 0;
}

/**
 * Park a mailbox's NEXT `changesSince` and hand back the release.
 *
 * The same seam `first-sync-priority.e2e.test.ts` uses, and for the same reason: it makes one
 * mailbox's batch the long one deterministically, so an ordering question has a single answer.
 */
function parkSync(fleet: FakeAdapterFleet, mailboxId: string): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fleet.behave(mailboxId, { syncGate: gate });
  return () => { fleet.behave(mailboxId, { syncGate: undefined }); release(); };
}

/**
 * A PASS BOUNDARY, exactly. A pass gives each mailbox one turn and ends only when its lanes
 * return, so a park planted mid-pass can land on a mailbox the pass has already served and decide
 * the case by where the pass happened to be. The tail runs on the rotation's own serial queue, so
 * while a tail slice runs no pass is mid-way and every lane has returned: parks planted from its
 * hook land on each mailbox's own turn of the next pass. Install `tailSliceHook` in the worker's
 * config; `park` arms it and resolves at the next slice with every seed's turn count there.
 */
function passBoundary(fleet: FakeAdapterFleet, releases: Array<() => void>): {
  tailSliceHook: () => Promise<void>;
  park: (seeds: ReadonlyArray<{ mailboxId: string }>, park: ReadonlyArray<{ mailboxId: string }>) => Promise<number[]>;
} {
  let armed: (() => void) | null = null;
  return {
    tailSliceHook: async () => { const fire = armed; armed = null; fire?.(); },
    park: (seeds, park) => new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => { armed = null; reject(new Error("no tail slice, so no pass boundary, in 20 s")); }, 20_000);
      armed = () => {
        clearTimeout(timer);
        const starts = seeds.map((s) => fleet.indicesOf(s.mailboxId, "sync_start").length);
        const ends = seeds.map((s) => fleet.indicesOf(s.mailboxId, "sync_end").length);
        if (fleet.syncInFlight !== 0 || starts.some((n, i) => n !== ends[i])) {
          reject(new Error(`a sync was in flight during a tail slice: starts ${starts}, ends ${ends}`));
          return;
        }
        for (const p of park) releases.push(parkSync(fleet, p.mailboxId));
        resolve(ends);
      };
    }),
  };
}

/** Every `mailbox_visit` line the worker writes, AFTER the log allow-list: a field it drops is not there. */
function visitLog(): { logger: ReturnType<typeof createLogger>; visits: Array<Record<string, unknown>> } {
  const visits: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    service: "worker", level: "info",
    sink: (line) => { const j = JSON.parse(line) as Record<string, unknown>; if (j.event === "mailbox_visit") visits.push(j); },
  });
  return { logger, visits };
}

/** One turn of a mailbox at a time: its starts and ends alternate, start first. */
function oneTurnAtATime(fleet: FakeAdapterFleet, mailboxId: string): boolean {
  return fleet.trace
    .filter((e) => e.mailboxId === mailboxId && (e.event === "sync_start" || e.event === "sync_end"))
    .every((e, i) => e.event === (i % 2 === 0 ? "sync_start" : "sync_end"));
}

/* THE LEAK PROBE COUNTS CLIENT BACKENDS ONLY (ROSTER-PROBE-COUNTS-AUTOVACUUM): an autovacuum worker on this
   database over the 3 s window is the server's, not a connection an earlier case left open. */
type Backend = { pid: number; backend_type: string | null };
function clientBackendsLeft(rows: readonly Backend[], selfPid: number): number {
  return rows.filter((r) => r.backend_type === "client backend" && r.pid !== selfPid).length;
}

describe("the leak probe's reading", () => {
  it("counts another client backend and neither an autovacuum worker nor the probe itself", () => {
    const rows: Backend[] = [
      { pid: 10, backend_type: "client backend" },
      { pid: 11, backend_type: "autovacuum worker" },
      { pid: 12, backend_type: "client backend" },
    ];
    expect(clientBackendsLeft(rows, 10)).toBe(1);
    expect(clientBackendsLeft(rows.slice(0, 2), 10)).toBe(0);
  });
});

describe("a heavy mailbox must not hold the rotation against the rest of the shard", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_roster_serialization"); }, 120_000);
  /* EACH CASE STARTS ON A DATABASE NOBODY ELSE IS CONNECTED TO (ROSTER-SERIALIZATION-CLAMP-CASE-READS-AN-
     EARLIER-CASE-RESIDUE): every case's `makeDb` handle stayed open, one idle connection per case, so the clamp
     case met five on a 100-slot server a gate run shares and timed out filling its lanes ("too many clients"
     on a 10-slot one; alone it is green). A residue that outlives 3 s is a leak, named here, not a timeout later. */
  beforeEach(async () => {
    await truncateAll(DB);
    const probe = postgres(DB, { max: 1, onnotice: () => {} });
    let left = -1;
    try {
      for (const until = Date.now() + 3_000; ; await new Promise((r) => setTimeout(r, 50))) {
        const [me] = await probe<{ pid: number }[]>`select pg_backend_pid() as pid`;
        const rows = await probe<Backend[]>`select pid, backend_type from pg_stat_activity
          where datname = current_database()`;
        left = clientBackendsLeft(rows, me!.pid);
        if (left === 0 || Date.now() > until) break;
      }
    } finally { await probe.end({ timeout: 5 }); }
    expect(left, "connections an earlier case left open on this file's database").toBe(0);
  }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  const releases: Array<() => void> = [];
  afterEach(async () => {
    // The parks FIRST: `stop()` waits for the in-flight cycle, and a lane suspended inside
    // `changesSince` would never let it finish — the hook would time out instead of the claim.
    for (const r of releases.splice(0)) r();
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
    // The case's own `makeDb` handle, after its worker: the next case's guard counts what is left.
    await closeDb();
  }, ISOLATED_DB_RESET_BUDGET_MS);

  /**
   * Bring up a shard of `n` mailboxes and wait until every one has completed a first cycle.
   *
   * Every claim in this file is about the STEADY state — a mailbox that is already serving and
   * whose doorbell rings — so the boot pass, in which every mailbox is a first-syncer and
   * owns the ordering, has to be over before anything is observed.
   */
  async function warmShard(
    db: Db, fleet: FakeAdapterFleet, seeds: Array<{ mailboxId: string }>, over: Partial<WorkerConfig> = {},
  ): Promise<RunningWorker> {
    const worker = await startWorker(cfgFor(fleet, over));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === seeds.length, 20_000, "every mailbox attached");
    await waitFor(
      () => seeds.every((s) => fleet.indicesOf(s.mailboxId, "sync_end").length > 0),
      20_000, "every mailbox to complete a first cycle",
    );
    return worker;
  }

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   *  THE STARVATION, REPRODUCED — the rotation as it shipped before that change
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * `cycleLanes: 1` is not a stand-in for the old code, it IS the old code path: one lane, one
   * mailbox at a time. H is parked inside a deep batch; L's doorbell then rings with a message
   * waiting behind it. The claim is that L is not served at all until H's batch returns — which
   * is the long visit gap in miniature, and the reason several mailboxes paged.
   *
   * ASSERTED AS AN ORDER AND NOT AS A DELAY. The park is released at the end, and the claim is
   * that L's next `sync_start` falls AFTER H's parked batch ENDED. Nothing waits for a duration
   * to prove an absence.
   */
  it("starves a woken mailbox behind one deep batch when the rotation has a single lane", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const h = await seedMailbox(db);
    const l = await seedMailbox(db);
    const names = new Map([[h.mailboxId, "H"], [l.mailboxId, "L"]]);

    // H is the deep backfill: many batches of 40 messages, so every cycle it completes reports a
    // truncated batch and it is a mailbox that owes work for the whole test.
    fleet.behave(h.mailboxId, { deliver: mail(400, "h"), batchSize: 40 });

    const worker = await warmShard(db, fleet, [h, l], { cycleLanes: 1 });

    // Park H mid-batch. Everything below happens while a lane is suspended inside its provider.
    const releaseH = parkSync(fleet, h.mailboxId);
    releases.push(releaseH);
    await waitFor(() => fleet.syncInFlight === 1, 20_000, "the rotation parked inside H's batch");
    const lVisitsBefore = fleet.indicesOf(l.mailboxId, "sync_start").length;
    // The parked batch is identified NOW, by how many of H's ends precede it. Reading "H's last
    // sync_end" after the release would name a LATER visit, and the order claim would then be
    // about the wrong pair — measured doing exactly that.
    const hEndsBefore = fleet.indicesOf(h.mailboxId, "sync_end").length;

    // L's doorbell rings with mail behind it — the realtime path, exactly as `attach()` wires it.
    fleet.behave(l.mailboxId, { deliver: [{ from: "anna@x.example", subject: "hello", messageId: "wake-l@x" }] });
    fleet.signal.get(l.mailboxId)!();

    // Several poll intervals pass, so a cycle is demonstrably owed rather than merely unscheduled.
    await new Promise((r) => setTimeout(r, POLL_MS * 6));
    expect(
      await landed(db, l.mailboxId, "wake-l@x"),
      "at one lane a woken mailbox's mail must NOT arrive while another mailbox's batch is parked " +
      `— if it does, this control no longer reproduces the defect the fix is for — trace: ${fleet.describeTrace(names)}`,
    ).toBe(false);

    releaseH();
    await waitFor(() => landed(db, l.mailboxId, "wake-l@x"), 20_000, "L's mail once H's batch returned");

    // THE ORDER, which is the claim: L was not visited until H's parked batch had ENDED.
    const hParkedEnd = fleet.nth(h.mailboxId, "sync_end", hEndsBefore + 1);
    expect(hParkedEnd, "H's parked batch never ended, so the order claim below is vacuous").not.toBe(Infinity);
    expect(
      fleet.nth(l.mailboxId, "sync_start", lVisitsBefore + 1),
      "at one lane L waits out H's whole batch — that is the 15.5-minute visit gap in miniature, " +
      `and this control is what makes the claim above a claim about lanes — trace: ${fleet.describeTrace(names)}`,
    ).toBeGreaterThan(hParkedEnd);
    expect(worker.stats().mailboxes, "a mailbox was lost during the park").toBe(2);
  }, 120_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   *  …AND GONE AT THE SHIPPED LANE COUNT — the fix, on the identical scenario
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * Same two mailboxes, same park, same doorbell. The assertion is the opposite one and it is a
   * PRODUCT claim rather than a trace claim: L's message is in the database — routed, filed,
   * visible to the client — WHILE H is still suspended inside its provider.
   *
   * Both halves are asserted at that one instant, which is what makes it a no-starvation claim in
   * both directions rather than a latency claim: L's mail has landed, and H has not been cancelled,
   * detached or quarantined to make room for it.
   */
  it("serves a woken mailbox's inbound while another mailbox is suspended inside a deep batch", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const h = await seedMailbox(db);
    const l = await seedMailbox(db);
    const names = new Map([[h.mailboxId, "H"], [l.mailboxId, "L"]]);

    fleet.behave(h.mailboxId, { deliver: mail(400, "h"), batchSize: 40 });

    const worker = await warmShard(db, fleet, [h, l]);

    const releaseH = parkSync(fleet, h.mailboxId);
    releases.push(releaseH);
    await waitFor(() => fleet.syncInFlight === 1, 20_000, "a lane parked inside H's batch");
    const hIngestedAtPark = await ingested(db, h.mailboxId);

    fleet.behave(l.mailboxId, { deliver: [{ from: "anna@x.example", subject: "hello", messageId: "wake-l@x" }] });
    const rang = Date.now();
    fleet.signal.get(l.mailboxId)!();

    await waitFor(
      () => landed(db, l.mailboxId, "wake-l@x"), 20_000,
      "L's woken mail to be ingested while H's batch is still parked — this is the whole slice: " +
      `a mailbox's inbound must not wait out another mailbox's deep batch — trace: ${fleet.describeTrace(names)}`,
    );
    const latencyMs = Date.now() - rang;

    // AT THE SAME INSTANT: H is still inside the batch it was parked in. Without this the claim
    // above would also be satisfied by a rotation that simply finished H first.
    expect(
      fleet.syncInFlight,
      `H's batch had already returned, so L's mail proves nothing — trace: ${fleet.describeTrace(names)}`,
    ).toBe(1);
    // …and H was not sacrificed for it: no quarantine, no detach, still serving.
    expect(worker.stats().mailboxes, "the heavy mailbox was detached to make room for the light one").toBe(2);
    expect(worker.stats().quarantined, "the heavy mailbox was quarantined for being slow").toBe(0);
    expect(await ingested(db, h.mailboxId), "H lost mail it had already ingested").toBe(hIngestedAtPark);

    // REPORTED, NEVER ASSERTED — the number is the harness's, not the product's. It is here
    // because the production measurement it replaces is a number, and a reader deserves to see
    // that this scenario answers in milliseconds where the shard answered in many minutes.
    // eslint-disable-next-line no-console
    console.log(`[lanes] woken mailbox served in ${latencyMs}ms with a deep batch still in flight`);
  }, 120_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   *  AND THE HEAVY MAILBOX KEEPS DRAINING — no starvation in the other direction
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * A fast lane that a backfill can never enter is the inverse defect: it would make the deep
   * backlog — the case the alert was actually about — slower than the serial rotation it
   * replaced. So this asserts BOTH populations make progress at once, with nothing parked: the
   * heavy mailbox drains its whole backlog while every light mailbox is visited repeatedly.
   *
   * `CYCLE_FAST_LANES` is named in the arithmetic rather than written as a number, so the claim
   * follows the constant if the reservation is ever retuned.
   */
  it("drains a deep backlog to completion while every light mailbox is served throughout", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const heavy = await seedMailbox(db);
    const lights = [await seedMailbox(db), await seedMailbox(db), await seedMailbox(db)];

    fleet.behave(heavy.mailboxId, { deliver: mail(200, "deep"), batchSize: 20 });
    for (const [i, m] of lights.entries()) {
      fleet.behave(m.mailboxId, { deliver: [{ from: "x@y.example", subject: "s", messageId: `light-${i}@x` }] });
    }

    const worker = await warmShard(db, fleet, [heavy, ...lights]);

    await waitFor(
      () => ingested(db, heavy.mailboxId).then((n) => n === 200), 60_000,
      "the deep backlog to drain completely — a reserved fast lane must not starve the backfill " +
      "it was reserved against",
    );

    for (const [i, m] of lights.entries()) {
      expect(
        await landed(db, m.mailboxId, `light-${i}@x`),
        "a light mailbox's mail never arrived while the deep backlog drained",
      ).toBe(true);
      expect(
        fleet.indicesOf(m.mailboxId, "sync_end").length,
        "a light mailbox was visited only once in the whole drain — it is being starved by the " +
        "backfill, which is the defect this slice exists to remove",
      ).toBeGreaterThan(1);
    }
    expect(worker.stats().quarantined, "a mailbox was quarantined during the drain").toBe(0);
    // …and the reservation's SIZE, asserted rather than left to the drain's timing: reserving two
    // of three lanes would leave a single lane for every backfill on the shard and make the deep
    // backlog — the case the alert was actually about — slower than the serial rotation it replaces.
    expect(
      DEFAULT_CYCLE_LANES - CYCLE_FAST_LANES,
      "the fast-lane reservation left backfills fewer than two lanes, which is worse for a deep " +
      "backlog than the serial rotation this replaces",
    ).toBeGreaterThanOrEqual(2);
  }, 180_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   *  ONE CYCLE PER ACCOUNT — which is strictly stronger than one cycle per mailbox
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * The concurrency key is the ACCOUNT and not the mailbox, and the reason is measurable:
   * `recordChange` → `allocateSeq` takes the account's `account_sync_state` ROW LOCK and holds it
   * to commit, while the worker's connections carry `lock_timeout: 30_000`. Two mailboxes of one
   * account running at once meet on that row and the meeting is either a thirty-second stall or a
   * `55P03` counted against a mailbox whose provider answered every request correctly.
   *
   * A mailbox belongs to exactly one account, so this rule IMPLIES that two cycles of one mailbox
   * can never overlap — the structural claim the whole file rests on. The trace assertion at the
   * end states that half directly rather than leaving it as an inference.
   *
   * The first two mailboxes share an account; N is a stranger. With the first parked, the second must not be visited at all
   * and N must be visited anyway — the second half is what stops this passing on a shard that is
   * merely stalled.
   */
  it("never runs two mailboxes of one account at once, and is not merely stalled while proving it", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const shared = randomUUID();
    const m1 = await seedMailbox(db, shared);
    const m2 = await seedMailbox(db, shared);
    const n = await seedMailbox(db);
    const names = new Map([[m1.mailboxId, "first"], [m2.mailboxId, "second"], [n.mailboxId, "N"]]);

    const worker = await warmShard(db, fleet, [m1, m2, n]);

    const releaseM1 = parkSync(fleet, m1.mailboxId);
    releases.push(releaseM1);
    await waitFor(() => fleet.syncInFlight === 1, 20_000, "a lane parked inside the first mailbox's batch");
    const m2Before = fleet.indicesOf(m2.mailboxId, "sync_start").length;

    // Both doorbells ring, with mail behind each. N is a stranger and must be served; the second
    // mailbox shares the first's account and must NOT be, however loudly it rings.
    fleet.behave(n.mailboxId, { deliver: [{ from: "x@y.example", subject: "s", messageId: "acct-n@x" }] });
    fleet.behave(m2.mailboxId, { deliver: [{ from: "x@y.example", subject: "s", messageId: "acct-m2@x" }] });
    fleet.signal.get(n.mailboxId)!();
    fleet.signal.get(m2.mailboxId)!();

    // THE STRANGER IS SERVED — and it is what makes the negative claim below meaningful rather
    // than a statement about a shard that is simply stalled behind that change.
    await waitFor(
      () => landed(db, n.mailboxId, "acct-n@x"), 20_000,
      `N's woken mail to arrive while the first mailbox is parked — trace: ${fleet.describeTrace(names)}`,
    );

    // …AND THE ACCOUNT SIBLING IS NOT, at that same instant, despite an identical wake.
    expect(
      fleet.indicesOf(m2.mailboxId, "sync_start").length,
      "a second mailbox of the SAME account was visited while the first held a lane — they would " +
      "meet on that account's account_sync_state row lock, which is a 30-second stall or a 55P03 " +
      `charged to a healthy mailbox — trace: ${fleet.describeTrace(names)}`,
    ).toBe(m2Before);
    expect(
      await landed(db, m2.mailboxId, "acct-m2@x"),
      "the account sibling's mail arrived, so it ran beside the first mailbox after all",
    ).toBe(false);

    // A DEFERRAL IS NOT A STARVATION. The wake survives the deferral, so the second mailbox is served the moment
    // its account is free rather than waiting for another signal.
    releaseM1();
    await waitFor(
      () => landed(db, m2.mailboxId, "acct-m2@x"), 20_000,
      "the second mailbox's mail once its account was free — a wake deferred by the account key must survive it",
    );

    // THE STRUCTURAL HALF, stated rather than inferred: no mailbox ever has two `sync_start`
    // entries with no `sync_end` between them, for any mailbox in the trace. Two cycles of one
    // mailbox are impossible by construction (`servedIds` bounds one turn per pass, and the serial
    // queue bounds one `cycle()` per process) and this is what would show it if they were not.
    const open = new Map<string, number>();
    for (const e of fleet.trace) {
      if (e.event === "sync_start") {
        const depth = (open.get(e.mailboxId) ?? 0) + 1;
        open.set(e.mailboxId, depth);
        expect(
          depth,
          `two cycles of ${names.get(e.mailboxId) ?? e.mailboxId} overlapped — per-mailbox ` +
          `serialization is load-bearing in sync.ts, the write fence and the organizer lease ` +
          `— trace: ${fleet.describeTrace(names)}`,
        ).toBe(1);
      }
      if (e.event === "sync_end") open.set(e.mailboxId, 0);
    }
    expect(worker.stats().mailboxes, "a mailbox was lost while the account was held").toBe(3);
  }, 120_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   *  A ROSTER PASS MAY NOT CLOSE AN ADAPTER A LANE IS INSIDE — the hazard concurrency adds
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * The adoption fix let a roster pass run from INSIDE a cycle's queue entry and bought its safety from
   * the shape: the pass ran between two mailboxes, where nothing was suspended inside an adapter.
   * Lanes spend that, so the property is enforced directly — `laneBusy` — instead of inherited.
   *
   * The pass's detach loop is the one detach site reachable from inside a running cycle. The other
   * three (`handleConnectionError`, `handleLockLoss`, `stop()`) each take their own `serialize`
   * entry and therefore cannot start until the whole cycle entry has returned.
   *
   * H is parked inside `changesSince` and its row is then disabled — the billing-downgrade
   * path, a user disconnecting a mailbox, a cap eviction. Two claims, and they are the two halves
   * of a DEFERRAL as opposed to a skip:
   *
   *  · the adapter is not closed while the lane is inside it. `close` under a suspended
   *    `changesSince` aborts a batch mid-flight and, through `releaseOrganizerClaim`, hands the
   *    mailbox to another install while this process is still organizing it;
   *  · and it IS closed once the lane returns. A deferral that forgot would leak an IDLE login on
   *    a mailbox nobody is entitled to sync — the failure the detach exists to prevent, arrived at
   *    from the other side.
   */
  it("defers a roster detach for a mailbox a lane is inside, and completes it when the lane returns", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const h = await seedMailbox(db);
    const other = await seedMailbox(db);
    const names = new Map([[h.mailboxId, "H"], [other.mailboxId, "O"]]);

    fleet.behave(h.mailboxId, { deliver: mail(400, "h"), batchSize: 40 });

    // A short roster interval, because the pass is the thing under test here rather than a
    // background chore: it has to run, and try to detach, WHILE the lane is parked.
    const worker = await warmShard(db, fleet, [h, other], { rosterIntervalMs: 150 });

    const releaseH = parkSync(fleet, h.mailboxId);
    releases.push(releaseH);
    await waitFor(() => fleet.syncInFlight === 1, 20_000, "a lane parked inside H's batch");
    const closesBefore = fleet.indicesOf(h.mailboxId, "close").length;

    // H leaves the duty while a lane is inside it.
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, h.mailboxId));

    // ── WAIT FOR THE PASS TO HAVE SEEN IT, AND NOT MERELY FOR TIME TO PASS ────────────────
    //
    // `expected` is `served.length`, recomputed by `reconcileRoster` and by nothing else, so
    // `expected === 1` IS "a roster pass has run, read the disabled row, and reached its detach
    // loop". Without this the assertion below fires before any pass has looked, and the guard is
    // decorative — measured doing exactly that: the mutation that deletes the deferral passed.
    await waitFor(
      () => worker.stats().expected === 1, 20_000,
      `a roster pass to observe H leaving the duty while its lane is parked — trace: ${fleet.describeTrace(names)}`,
    );

    // …and the rotation is alive rather than wedged behind H: O is still served.
    const otherBefore = fleet.indicesOf(other.mailboxId, "sync_start").length;
    fleet.behave(other.mailboxId, { deliver: [{ from: "x@y.example", subject: "s", messageId: "defer-o@x" }] });
    fleet.signal.get(other.mailboxId)!();
    await waitFor(
      () => landed(db, other.mailboxId, "defer-o@x"), 20_000,
      `the rotation to keep serving O while H is parked and disabled — trace: ${fleet.describeTrace(names)}`,
    );
    expect(fleet.indicesOf(other.mailboxId, "sync_start").length,
      "O was never revisited, so the roster passes under test may not have run at all")
      .toBeGreaterThan(otherBefore);

    expect(
      fleet.indicesOf(h.mailboxId, "close").length,
      "a roster pass closed the adapter a lane was suspended inside — the batch is aborted " +
      "mid-flight and the organizer claim is released while this process is still organizing " +
      `the mailbox — trace: ${fleet.describeTrace(names)}`,
    ).toBe(closesBefore);
    expect(fleet.syncInFlight, "H's batch returned, so the claim above is vacuous").toBe(1);

    // …AND THE DEFERRAL IS NOT A SKIP.
    releaseH();
    await waitFor(
      () => worker.stats().mailboxes === 1, 20_000,
      "the deferred detach to complete once H's lane returned — a deferral that forgot would " +
      "leak an IDLE login on a mailbox nobody is entitled to sync",
    );
    expect(fleet.indicesOf(h.mailboxId, "close").length,
      "the disabled mailbox's connection was never closed").toBeGreaterThan(closesBefore);
    expect(fleet.openFor(h.mailboxId), "the disabled mailbox's provider login is still open").toBe(0);
  }, 120_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   *  THE POOL IS THE CEILING — an unbounded lane count is clamped, not honoured
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * This process owns ONE postgres pool of `WORKER_POOL_MAX` connections and a fenced write group
   * holds one for its transaction; the pulse and the alert pass need theirs and run off the cycle
   * queue. postgres.js QUEUES on an exhausted pool rather than failing, so an unbounded scheduler
   * does not break — it silently stops being concurrency while still paying for the IMAP
   * connections and the memory of running wide. That is precisely the failure a guard has to be
   * able to see, so it is asserted on the observable: how many mailboxes are inside `changesSince`
   * at once.
   *
   * Every mailbox is parked, so the rotation admits as many as it is allowed to and then blocks —
   * the count is a ceiling test with no timing in it. Deleting the clamp in `resolveCycleLanes`
   * turns this red with the full eight.
   */
  it("clamps a lane count above the pool's ceiling instead of honouring it", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const seeds = [];
    for (let i = 0; i < 8; i++) seeds.push(await seedMailbox(db));

    const boundary = passBoundary(fleet, releases);
    const worker = await warmShard(db, fleet, seeds, { cycleLanes: 32, tailSliceHook: boundary.tailSliceHook });

    /* PARKED AT A PASS BOUNDARY, so every mailbox is unserved in the pass that fills the lanes.
       Parked mid-pass with six already served, the last two parked and held the pass open, and
       the rotation sat at 2 of 3 lanes for the whole 20 s: 10 of 30 runs of this case alone
       (ROSTER-ROTATION-STUCK-UNDER-PARK, which the due turns below now answer). This case asserts
       the clamp, so it fills the lanes with own turns only. */
    await boundary.park(seeds, seeds);
    // As many lanes as the clamp allows, and then it blocks. Reaching the ceiling is what makes
    // the "never above it" assertion below a bound rather than an accident of scheduling.
    await waitFor(
      () => fleet.syncInFlight >= MAX_CYCLE_LANES, 20_000,
      `the rotation to fill every one of its ${MAX_CYCLE_LANES} lanes`,
    );
    // Sampled over a window: a single reading could catch the rotation between two admissions.
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      peak = Math.max(peak, fleet.syncInFlight);
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(
      peak,
      `a configured 32 lanes was honoured. This process has one pool; the extra lanes would queue ` +
      `on it while still holding ${8} provider connections and ${8} batches in memory`,
    ).toBe(MAX_CYCLE_LANES);
    expect(worker.stats().mailboxes, "a mailbox was lost while the lanes were full").toBe(8);
  }, 120_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   *  A MAILBOX DUE ITS POLL TAKES A FREE LANE WHILE LONG BATCHES HOLD THE PASS
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * ROSTER-ROTATION-STUCK-UNDER-PARK. A pass gives each mailbox one turn and ends when its lanes
   * return, so two batches parked in it held it open while the third lane idled and the six other
   * mailboxes, served and due their poll again, did not start for the whole 20 s at an 80 ms poll
   * (in production: a deep batch's length). They are IDLE-armed, as every attached mailbox is, and
   * no doorbell rings here: what they owe is the poll, which is how flag changes from other devices
   * and every folder but INBOX arrive. Each must now take the free lane every time its own poll
   * comes due, while both parked batches still hold the pass.
   */
  it("gives every other mailbox a turn each time its poll comes due while two batches hold the pass", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const seeds = [];
    for (let i = 0; i < 8; i++) seeds.push(await seedMailbox(db));
    const [a, b, ...six] = seeds;
    const names = new Map(seeds.map((s, i) => [s.mailboxId, i < 2 ? `parked${i + 1}` : `M${i - 1}`]));
    const { logger, visits } = visitLog();
    const boundary = passBoundary(fleet, releases);
    const worker = await warmShard(db, fleet, seeds, { cycleLanes: 3, logger, tailSliceHook: boundary.tailSliceHook });
    // Production's shape: every mailbox watched, so the claim is about one whose doorbell has not rung.
    expect(seeds.every((s) => fleet.indicesOf(s.mailboxId, "watch").length > 0), "a mailbox is not IDLE-armed").toBe(true);

    const at = await boundary.park(seeds, [a!, b!]);
    // The held pass's lines start here: no lane is open at a tail slice, so every earlier turn has logged.
    const held = visits.length;
    await waitFor(() => fleet.syncInFlight === 2, 20_000,
      `both batches parked inside their own turns of the next pass — trace: ${fleet.describeTrace(names)}`);
    // Stamped when a pass ENDS: the parks pin it from here until their release.
    const passStamp = worker.stats().lastCycleAt?.getTime() ?? null;
    expect(passStamp, "no pass had ended before the parks, so the pin below is vacuous").not.toBeNull();

    const TURNS = 3;
    const dueTurns = (id: string): number => visits.slice(held).filter((v) => v.mailboxId === id && v.due === true).length;
    await waitFor(() => six.every((s) => dueTurns(s.mailboxId) >= TURNS), 20_000,
      `${TURNS} due turns for each of the six while two batches hold the pass — they waited for the pass ` +
      `to end — trace: ${fleet.describeTrace(names)}`);
    // AT THE SAME INSTANT both batches are still parked and no pass has ended: the turns did not
    // ride a new pass.
    expect(fleet.syncInFlight, `a parked batch returned, so the turns prove nothing — trace: ${fleet.describeTrace(names)}`).toBe(2);
    expect(worker.stats().lastCycleAt?.getTime() ?? null, "a pass ended, so the turns rode new passes").toBe(passStamp);
    six.forEach((s, i) => {
      expect(fleet.indicesOf(s.mailboxId, "sync_end").length, `${names.get(s.mailboxId)} turns`).toBeGreaterThanOrEqual(at[i + 2]! + 1 + TURNS);
    });
    // The parked mailboxes are on their own turns, never on a due one: a parked turn logs when it is let
    // go, and it is that mailbox's first line of the held pass.
    for (const r of releases.splice(0)) r();
    const parkedTurn = (id: string): Record<string, unknown> | undefined => visits.slice(held).find((v) => v.mailboxId === id);
    await waitFor(() => parkedTurn(a!.mailboxId) !== undefined && parkedTurn(b!.mailboxId) !== undefined, 20_000,
      "the parked turns to end once let go");
    expect([parkedTurn(a!.mailboxId)!.due, parkedTurn(b!.mailboxId)!.due], "a parked batch was a due turn").toEqual([false, false]);
    for (const s of seeds) {
      expect(oneTurnAtATime(fleet, s.mailboxId), `two turns of ${names.get(s.mailboxId)} at once — trace: ${fleet.describeTrace(names)}`).toBe(true);
    }
    expect(worker.stats().mailboxes, "a mailbox was lost while the batches were parked").toBe(8);
  }, 120_000);

  /**
   * A SECOND TURN NEVER GOES AHEAD OF A FIRST. A 1 ms poll makes every served mailbox due again
   * the moment its turn ends, so the only thing between a due turn and a mailbox still waiting for
   * its first turn of the pass is the gate itself: without it, the first mailbox through the free
   * lane goes round again before the last one has had its turn.
   */
  it("gives no mailbox a second turn of a pass while another still waits for its first", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const seeds = [];
    for (let i = 0; i < 8; i++) seeds.push(await seedMailbox(db));
    const [a, b, ...six] = seeds;
    const names = new Map(seeds.map((s, i) => [s.mailboxId, i < 2 ? `parked${i + 1}` : `M${i - 1}`]));
    const boundary = passBoundary(fleet, releases);
    await warmShard(db, fleet, seeds, { cycleLanes: 3, pollIntervalMs: 1, tailSliceHook: boundary.tailSliceHook });

    const at = await boundary.park(seeds, [a!, b!]);
    await waitFor(() => fleet.syncInFlight === 2, 20_000,
      `both batches parked inside their own turns of the next pass — trace: ${fleet.describeTrace(names)}`);
    await waitFor(() => six.every((s, i) => fleet.indicesOf(s.mailboxId, "sync_end").length >= at[i + 2]! + 1), 20_000,
      `every one of the six to have its own turn of the held pass — due turns kept going ahead of it — trace: ${fleet.describeTrace(names)}`);
    await waitFor(() => six.every((s, i) => fleet.indicesOf(s.mailboxId, "sync_end").length >= at[i + 2]! + 2), 20_000,
      `a second turn for each of the six while two batches hold the pass — trace: ${fleet.describeTrace(names)}`);
    // Turn n+1 is each mailbox's own turn of the held pass, n+2 its first due turn (n: its count at the boundary).
    const lastFirst = Math.max(...seeds.map((s, i) => fleet.nth(s.mailboxId, "sync_start", at[i]! + 1)));
    const firstSecond = Math.min(...six.map((s, i) => fleet.nth(s.mailboxId, "sync_start", at[i + 2]! + 2)));
    expect(firstSecond, `a second turn started before every mailbox had its first — trace: ${fleet.describeTrace(names)}`)
      .toBeGreaterThan(lastFirst);
  }, 120_000);

  /**
   * A RUNG DOORBELL GOES AHEAD OF EVERY DUE TURN. At a 1 ms poll some mailbox is always due, so
   * a doorbell revisit `admitWoken` queued would wait behind due turns for as long as the parked
   * batches hold the pass, if due turns were placed in front of it: the wake latency the doorbell
   * exists to remove, back again.
   */
  it("lets a rung doorbell's mail in ahead of every due turn while two batches hold the pass", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const seeds = [];
    for (let i = 0; i < 8; i++) seeds.push(await seedMailbox(db));
    const [a, b, ...six] = seeds;
    const w = six[0]!;
    const names = new Map(seeds.map((s, i) => [s.mailboxId, i < 2 ? `parked${i + 1}` : i === 2 ? "W" : `M${i - 1}`]));
    const { logger, visits } = visitLog();
    const boundary = passBoundary(fleet, releases);
    const worker = await warmShard(db, fleet, seeds, { cycleLanes: 3, pollIntervalMs: 1, logger, tailSliceHook: boundary.tailSliceHook });

    const at = await boundary.park(seeds, [a!, b!]);
    await waitFor(() => fleet.syncInFlight === 2, 20_000,
      `both batches parked inside their own turns of the next pass — trace: ${fleet.describeTrace(names)}`);
    // Due turns are flowing through the free lane before the doorbell rings.
    await waitFor(() => six.every((s, i) => fleet.indicesOf(s.mailboxId, "sync_end").length >= at[i + 2]! + 2), 20_000,
      `a due turn for each of the six — trace: ${fleet.describeTrace(names)}`);

    const wokenTurns = (): number => visits.filter((v) => v.mailboxId === w.mailboxId && v.woken === true).length;
    const wokenBefore = wokenTurns();
    fleet.behave(w.mailboxId, { deliver: [{ from: "anna@x.example", subject: "hi", messageId: "due-w@x" }] });
    fleet.signal.get(w.mailboxId)!();
    // A turn's line is written when its lane returns, after its mail is in: wait for W's woken turn.
    await waitFor(() => wokenTurns() > wokenBefore, 10_000,
      `W's woken turn while two batches hold the pass — due turns went ahead of its doorbell — trace tail: ` +
      `${fleet.describeTrace(names).slice(-2_000)}`);
    expect(await landed(db, w.mailboxId, "due-w@x"), "W's mail was not in when its woken turn ended").toBe(true);
    expect(fleet.syncInFlight, "a parked batch returned, so the mail proves nothing").toBe(2);
    expect(worker.stats().mailboxes).toBe(8);
  }, 120_000);

  /**
   * A MAILBOX THE PASS WILL QUARANTINE TAKES NO DUE TURN. At `maxSyncFailures` its own turn queues
   * it for the post-loop quarantine; a due turn after that could succeed, reset its failures and
   * still be quarantined as broken once the pass ends.
   */
  it("takes no due turn for a mailbox the pass will quarantine", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const seeds = [];
    for (let i = 0; i < 8; i++) seeds.push(await seedMailbox(db));
    const [a, b, m, ...five] = seeds;
    const names = new Map(seeds.map((s, i) => [s.mailboxId, i < 2 ? `parked${i + 1}` : i === 2 ? "Q" : `M${i - 2}`]));
    const { logger, visits } = visitLog();
    const boundary = passBoundary(fleet, releases);
    const worker = await warmShard(db, fleet, seeds, { cycleLanes: 3, maxSyncFailures: 1, logger, tailSliceHook: boundary.tailSliceHook });

    const at = await boundary.park(seeds, [a!, b!]);
    // The held pass's lines start here: no lane is open at a tail slice, so every earlier turn has logged.
    const held = visits.length;
    // Q's own turn of the held pass fails, which at a bound of one queues it for quarantine.
    fleet.behave(m!.mailboxId, { failSync: true });
    await waitFor(() => fleet.syncInFlight === 2, 20_000,
      `both batches parked inside their own turns of the next pass — trace: ${fleet.describeTrace(names)}`);
    await waitFor(() => fleet.indicesOf(m!.mailboxId, "sync_start").length >= at[2]! + 1, 20_000,
      `Q's own turn of the held pass — trace: ${fleet.describeTrace(names)}`);
    // From here a turn would succeed: only the exclusion keeps Q out.
    fleet.behave(m!.mailboxId, { failSync: false });
    const qStarts = fleet.indicesOf(m!.mailboxId, "sync_start").length;
    await waitFor(() => five.every((s) => visits.slice(held).filter((v) => v.mailboxId === s.mailboxId && v.due === true).length >= 3), 20_000,
      `three due turns for each of the other five — trace: ${fleet.describeTrace(names)}`);
    expect(fleet.syncInFlight, "a parked batch returned, so the claim proves nothing").toBe(2);
    expect(fleet.indicesOf(m!.mailboxId, "sync_start").length,
      `Q, queued for quarantine, took a turn inside the pass — trace: ${fleet.describeTrace(names)}`).toBe(qStarts);
    expect(visits.slice(held).filter((v) => v.mailboxId === m!.mailboxId && v.due === true)).toHaveLength(0);
    expect(worker.stats().mailboxes).toBe(8);
  }, 120_000);

  /**
   * DUE TURNS NEVER HOLD A PASS OPEN. Only a lane on a mailbox's own turn lets a due turn start,
   * so when the last own turn returns the due lanes drain and the pass ends. With a 1 ms poll every
   * served mailbox is due at once for ever; were a due lane enough to admit the next, they would
   * keep each other's pass open and no pass would end again.
   */
  it("still ends its passes when every mailbox is due again at once", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const seeds = [];
    for (let i = 0; i < 8; i++) seeds.push(await seedMailbox(db));
    const { logger, visits } = visitLog();
    const worker = await warmShard(db, fleet, seeds, { cycleLanes: 3, pollIntervalMs: 1, logger });
    await waitFor(() => worker.stats().lastCycleAt !== null, 20_000, "the first pass to end");

    for (let pass = 0; pass < 3; pass++) {
      const stamp = worker.stats().lastCycleAt!.getTime();
      await waitFor(() => (worker.stats().lastCycleAt?.getTime() ?? stamp) !== stamp, 20_000,
        `pass ${pass + 1} of 3 to end — due turns held it open — trace tail: ${fleet.describeTrace().slice(-2_000)}`);
    }
    expect(visits.some((v) => v.due === true), "no due turn was taken, so the claim is vacuous").toBe(true);
    for (const s of seeds) expect(oneTurnAtATime(fleet, s.mailboxId), "two turns of one mailbox at once").toBe(true);
  }, 120_000);

  /**
   * A PASS WITH NO LONG BATCH ENDS AS IT DID: no mailbox is due again inside it (a 2 s poll against
   * batches of milliseconds), so no due turn is taken and each mailbox has exactly one turn a pass.
   */
  it("takes no due turn in a pass no long batch holds", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const seeds = [];
    for (let i = 0; i < 8; i++) seeds.push(await seedMailbox(db));
    const { logger, visits } = visitLog();
    const worker = await warmShard(db, fleet, seeds, { cycleLanes: 3, pollIntervalMs: 2_000, logger });
    await waitFor(() => worker.stats().lastCycleAt !== null, 20_000, "the first pass to end");
    const stamp = worker.stats().lastCycleAt!.getTime();
    await waitFor(() => (worker.stats().lastCycleAt?.getTime() ?? stamp) !== stamp, 20_000, "the next pass to end");

    expect(visits.length, "no visit was logged, so the claim is vacuous").toBeGreaterThanOrEqual(16);
    expect(visits.filter((v) => v.due === true), "a due turn in a pass no long batch held").toHaveLength(0);
    const starts = seeds.map((s) => fleet.indicesOf(s.mailboxId, "sync_start").length);
    expect(new Set(starts).size, `turns per mailbox differ: ${starts}`).toBe(1);
  }, 120_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   *  THE RESERVED LANE — a mailbox that owes nothing is never behind every backfill
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * The lane cap alone is not enough, and this is the claim that says why: with three cold
   * backfills on a three-lane shard, a mailbox whose IDLE fires is behind a deep batch again —
   * the 15.5-minute measurement with a smaller constant. `CYCLE_FAST_LANES` is held back from
   * mailboxes that reported a backlog, so at most `DEFAULT_CYCLE_LANES - CYCLE_FAST_LANES` of them
   * may be in flight however many are queued.
   *
   * Three heavy mailboxes are parked; the assertion is that only the reservation's worth of them
   * got in, and that the light mailbox was served anyway. Removing the `heavyInFlight` test in
   * `admissible` turns both halves red at once.
   */
  it("holds a lane for mailboxes that owe nothing, however many backfills are queued", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const heavies = [await seedMailbox(db), await seedMailbox(db), await seedMailbox(db)];
    const light = await seedMailbox(db);
    const names = new Map<string, string>(heavies.map((h, i) => [h.mailboxId, `H${i + 1}`]));
    names.set(light.mailboxId, "L");

    // Each heavy owes a backlog after its first cycle — the flag the reservation reads is the
    // mailbox's OWN report (`hasBacklog`), never a guess from its size.
    for (const [i, h] of heavies.entries()) {
      fleet.behave(h.mailboxId, { deliver: mail(400, `deep${i}`), batchSize: 40 });
    }

    const boundary = passBoundary(fleet, releases);
    const worker = await warmShard(db, fleet, [...heavies, light], { tailSliceHook: boundary.tailSliceHook });
    // TWO completed cycles each, so every heavy has REPORTED its backlog: the first cycle is what
    // sets the flag, and a claim read before it would be testing the attach-time default instead.
    await waitFor(
      () => heavies.every((h) => fleet.indicesOf(h.mailboxId, "sync_end").length >= 2), 30_000,
      "every heavy mailbox to have reported a backlog of its own",
    );

    // At a pass boundary, so each heavy parks on its own turn of the next pass. Parked mid-pass, one
    // could land on a turn taken while its poll came due, which holds the pass without letting the
    // others in (`admitDue`), and the lanes would never fill.
    await boundary.park([...heavies, light], heavies);
    const heavyLanes = DEFAULT_CYCLE_LANES - CYCLE_FAST_LANES;
    await waitFor(
      () => fleet.syncInFlight >= heavyLanes, 30_000,
      `${heavyLanes} heavy mailboxes to occupy their share of the lanes`,
    );

    const lightBefore = fleet.indicesOf(light.mailboxId, "sync_start").length;
    fleet.behave(light.mailboxId, { deliver: [{ from: "anna@x.example", subject: "hi", messageId: "reserved-l@x" }] });
    fleet.signal.get(light.mailboxId)!();

    await waitFor(
      () => landed(db, light.mailboxId, "reserved-l@x"), 20_000,
      "the light mailbox's mail to arrive with every backfill lane occupied — the reservation is " +
      `what makes the wake channel's promise reachable rather than merely likelier — trace: ${fleet.describeTrace(names)}`,
    );

    // AT THAT INSTANT: no more than the reservation's worth of backfills are in flight, so the
    // light mailbox was served BECAUSE a lane was held for it and not because one happened to be
    // free. Sampled, for the same reason the ceiling claim above is.
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      peak = Math.max(peak, fleet.syncInFlight);
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(
      peak,
      `every lane filled with a backfill — a woken mailbox is behind a deep batch again, which is ` +
      `the production measurement with a smaller constant — trace: ${fleet.describeTrace(names)}`,
    ).toBe(heavyLanes);
    expect(
      fleet.indicesOf(light.mailboxId, "sync_start").length,
      "the light mailbox was never visited while the backfills held their lanes",
    ).toBeGreaterThan(lightBefore);
    expect(worker.stats().quarantined, "a parked backfill was quarantined").toBe(0);
  }, 180_000);

  // THE TAIL IS A QUEUE ENTRY. While a per-account slice runs no lane is open and no visit starts,
  // however many doorbells ring: the tail's writes take the account's seq row, and a visit beside
  // them is the two-writers-on-one-account shape the lanes are keyed to prevent.
  it("opens no lane while a tail slice runs, and serves the doorbells once it returns", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const seeds = [await seedMailbox(db), await seedMailbox(db)];
    const gate: { park: (() => void) | null } = { park: null };
    let parkNext = false;
    let lanesAtPark = -1;
    const worker = await warmShard(db, fleet, seeds, {
      pollIntervalMs: 600_000,
      tailSliceHook: async () => {
        if (!parkNext) return;
        parkNext = false;
        lanesAtPark = fleet.syncInFlight;
        await new Promise<void>((r) => { gate.park = r; });
      },
    });
    releases.push(() => gate.park?.());
    parkNext = true;
    fleet.signal.get(seeds[0]!.mailboxId)!();
    await waitFor(() => gate.park !== null, 20_000, "a tail slice to park");
    expect(lanesAtPark, "a visit was in flight while a tail slice ran").toBe(0);
    const from = fleet.trace.length;
    for (const s of seeds) fleet.signal.get(s.mailboxId)!();
    await new Promise((r) => setTimeout(r, 200));
    expect(fleet.trace.slice(from).filter((e) => e.event === "sync_start"),
      "a visit started inside a tail slice").toEqual([]);
    gate.park!();
    await waitFor(() => fleet.trace.slice(from).some((e) => e.event === "sync_start"), 20_000,
      "the doorbells to be served once the slice returned");
    expect(worker.stats().mailboxes).toBe(2);
  }, 120_000);
});
