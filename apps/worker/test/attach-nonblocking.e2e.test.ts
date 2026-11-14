import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { startWorker, type RunningWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { ORGANIZER_CONSENT } from "./_workerdb.js";
import { FakeAdapterFleet, type FakeEvent } from "./_fakeadapter.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  ATTACH REGISTERS A MAILBOX; IT DOES NOT DRAIN IT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured on the hosted service twice on 2026-08-04: a modest live
 * mailbox took **minutes** both times between `mailbox_attach_started` and
 * `mailbox_attached`, while the other mailbox took seconds — and the next `attach_started` came moments
 * after the previous `attached`, so the attaches did not overlap AT ALL. `reconcileRoster` awaits
 * `attach(mb)` per mailbox and `attach` awaited `reconcileOnRestart`, which is two complete sync
 * cycles. Cold start to `worker_serving` was 7 min 03 s for two mailboxes; at `maxMailboxes=64`
 * the last mailbox is not dialled for hours after a deploy.
 *
 * Two consequences, and the second is the worse one:
 *
 *  · every LATER mailbox's first sync waits out every earlier mailbox's full backlog;
 *  · `last_sync_at` is stamped by `cycle()` and by nothing else, so a boot spent draining inside
 *    `attach` fires `sync_lag` with `detail="… have not synced within 15m … Their owners are not
 *    receiving mail."` while the same log shows `mailbox_attached` for every mailbox and active
 *    ingest. Every deploy emitted a false page.
 *
 * ── WHY THIS IS AN ORDERING TEST AND NOT A STOPWATCH ──────────────────────────────────────
 *
 * A duration assertion against a fake adapter measures the harness. The defect is a SHAPE — who
 * calls `changesSince`, and when, relative to the next mailbox's `connect()` — so the fleet
 * records an ordered trace (`FakeAdapterFleet.trace`) and every claim below is an index
 * comparison. Counters cannot express it: a worker that drains A fully before dialling B and one
 * that dials both and then drains produce identical `connects`/`syncs`.
 *
 * ── WHAT EACH CLAIM CATCHES (mutation table in the project's design notes) ────────────
 *
 *  1. `B:connect` precedes `A:sync_end#2`  ← re-adding `await runSyncCycle(deps)` inside `attach`
 *  2. `B:connect` precedes `A:sync_end#1`  ← re-adding `reconcileOnRestart` inside `attach`
 *  3. zero A-syncs at the moment `startWorker` resolves ← the same, from the caller's vantage
 *  4. A drains over ≥ 3 cycles on ONE connection ← the backlog rides `hasBacklog` re-kicks
 *     (the "Delta-first client contract" invariant), not a second drain path bolted back onto attach
 *  5. `lease_organize` precedes `ensure_folders` ← moving/deleting the ATTACH lease seam
 *  6. every `sync_start` has a fresh `lease_organize` behind it ← deleting the CYCLE lease seam
 *  7. a mailbox attached by a LATER roster pass syncs without waiting `pollIntervalMs`
 *     ← the post-attach `kickCycle`, whose absence logs nothing and fails nothing
 *
 * Nowhere near a real mailbox: two fake mailboxes in an isolated database.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 41));
let DB = "";
type Db = ReturnType<typeof makeDb>;

async function seedMailbox(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, ...ORGANIZER_CONSENT }).returning();
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
    messageId: `w-attach-${tag}-${i}@backlog.test`,
  }));
}

/**
 * `pollIntervalMs` and `rosterIntervalMs` are deliberately LONGER than the test window in the
 * first case, so nothing but the code under test can start a cycle. A 200 ms poll would hide a
 * missing post-attach kick behind the next tick — which is exactly the silence claim 7 is about.
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

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

describe("attach registers, the cycle drains", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_wattach"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } } }, ISOLATED_DB_RESET_BUDGET_MS);

  it("a big mailbox's backlog does not delay the next mailbox's connect, and rides the cycle", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    /** Every `mailbox_attached` payload — acceptance criterion 2 of the brief, offline. */
    const attachedLines: Array<Record<string, unknown>> = [];
    const logger = {
      debug: () => { /* unused */ },
      info: (event: string, detail?: Record<string, unknown>) => {
        if (event === "mailbox_attached" && detail) attachedLines.push(detail);
      },
      warn: () => { /* unused */ },
      error: () => { /* unused */ },
      child() { return this; },
    };

    // A FIRST, because the roster is stable oldest-first: A leads every pass, which is the
    // ordering the production measurement had (the slow mailbox was attached first).
    const A = await seedMailbox(db);
    const B = await seedMailbox(db);
    const names = new Map([[A.mailboxId, "A"], [B.mailboxId, "B"]]);
    const trace = (): string => fleet.describeTrace(names);

    // Enough messages for three batches of 40 ⇒ `hasBacklog` on the first two cycles and three cycles to
    // drain. Three is the minimum that makes "A's SECOND changesSince" a real event and still
    // leaves a backlog outstanding when `startWorker` returns.
    fleet.behave(A.mailboxId, { deliver: mail(120, "a"), batchSize: 40 });
    fleet.behave(B.mailboxId, { deliver: mail(1, "b") });

    const worker: RunningWorker = await startWorker(cfgFor(fleet, { logger }));
    // SNAPSHOT WITH NO INTERVENING AWAIT. This is the caller's vantage point: whatever the worker
    // had done to A by the time it published itself as serving.
    const aSyncsAtResolve = fleet.indicesOf(A.mailboxId, "sync_end").length;
    const bConnectedAtResolve = fleet.indicesOf(B.mailboxId, "connect").length;
    closers.push(() => worker.stop());

    // ── CLAIM 3 ──────────────────────────────────────────────────────────────────────────
    // Register-only attach: nothing in the roster pass calls `changesSince`. Under the shipped
    // code this was 2 per mailbox, and for the measured live mailbox those two took minutes.
    expect.soft(aSyncsAtResolve, `attach drained mailbox A inline — trace: ${trace()}`).toBe(0);
    expect.soft(bConnectedAtResolve, "the roster pass did not reach mailbox B before returning").toBe(1);
    expect.soft(worker.stats().mailboxes, "both mailboxes are in the rotation").toBe(2);

    // The drain now happens on the cycle. Wait for it to finish so the ordering assertions have
    // A's later syncs to compare against.
    await waitFor(
      async () => (await db.select().from(messages).where(eq(messages.mailboxId, A.mailboxId))).length >= 120,
      30_000, "mailbox A's backlog to drain via cycle re-kicks",
    );

    const bConnect = fleet.nth(B.mailboxId, "connect", 1);
    // ── CLAIM 1: the brief's ruled assertion ─────────────────────────────────────────────
    expect.soft(bConnect, `B's connect waited on A's second changesSince — trace: ${trace()}`)
      .toBeLessThan(fleet.nth(A.mailboxId, "sync_end", 2));
    // ── CLAIM 2: the stronger form the fix actually delivers ─────────────────────────────
    // `reconcileOnRestart` is gone from attach ENTIRELY, so B is dialled before A syncs even
    // once. Asserted separately from claim 1 so a regression that halves the inline drain from
    // two cycles to one is still red.
    expect.soft(bConnect, `B's connect waited on A's FIRST changesSince — trace: ${trace()}`)
      .toBeLessThan(fleet.nth(A.mailboxId, "sync_end", 1));

    // ── CLAIM 4: the "Delta-first client contract" invariant — the backlog drains through the existing bounded-batch machinery ──
    // Three cycles minimum, on ONE connection. A second inline drain path, or a re-attach loop,
    // would show up as extra connects.
    expect.soft(fleet.indicesOf(A.mailboxId, "sync_end").length,
      "A's backlog did not take several bounded cycles").toBeGreaterThanOrEqual(3);
    expect.soft(fleet.indicesOf(A.mailboxId, "connect").length,
      "mailbox A was re-attached — the drain must ride ONE connection").toBe(1);

    // …and the small mailbox is not starved: it syncs while A still owes backlog. This is
    // acceptance criterion 3 of the brief, in miniature.
    expect.soft(fleet.nth(B.mailboxId, "sync_end", 1),
      `B's first sync waited for A's whole backlog — trace: ${trace()}`)
      .toBeLessThan(fleet.nth(A.mailboxId, "sync_end", 3));

    // ── CLAIM 5: the ATTACH lease seam, still before the first write ─────────────────────
    // `ensureFolders` CREATES the `ohmail/*` tree in somebody's mailbox. Exactly one active
    // organizer per mailbox (CLAUDE.md) requires the gate to have answered organize first, and
    // this slice moved code either side of it.
    for (const [id, name] of names) {
      expect.soft(fleet.nth(id, "lease_organize", 1),
        `${name}: ensureFolders ran before the organizer lease answered — trace: ${trace()}`)
        .toBeLessThan(fleet.nth(id, "ensure_folders", 1));
      // ── CLAIM 6: the CYCLE lease seam ─────────────────────────────────────────────────
      // Not "a gate happened once" — a FRESH gate since the previous sync. A claim is evidence
      // for exactly the cycle that read it.
      expect.soft(unGatedSyncs(fleet, id), `${name}: a changesSince ran with no lease gate behind it — trace: ${trace()}`)
        .toEqual([]);
    }

    // ── CLAIM 8: `mailbox_attached` CARRIES THE PHASE BREAKDOWN ──────────────────────────
    //
    // Acceptance criterion 2 of the brief, asserted here rather than only read off production:
    // The attach measurement could not say which phase dominated the minutes because the log had two timestamps
    // and nothing between them. There is deliberately NO `restartMs` — the phase it would have
    // measured no longer exists on this path, and a field reporting 0 for it would read as a
    // fast drain rather than as an absent one.
    expect.soft(attachedLines.length, "both attaches logged").toBe(2);
    for (const line of attachedLines) {
      expect.soft(Object.keys(line).sort(), "the phase breakdown moved or was dropped").toEqual(
        ["accountId", "attachMs", "connectMs", "foldersMs", "kickstartMs", "leaseMs", "mailboxId", "watchMs"],
      );
      for (const k of ["connectMs", "leaseMs", "foldersMs", "kickstartMs", "watchMs", "attachMs"]) {
        expect.soft(typeof line[k], `${k} is not a number`).toBe("number");
      }
    }
  }, 120_000);

  it("a mailbox attached by a later roster pass syncs at once, not a pollIntervalMs later", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();

    // The boot mailbox carries ONE message and no `batchSize`, so it drains in its first cycle
    // and `hasBacklog` never re-kicks. After boot, NOTHING is scheduled to run a cycle inside
    // the test window except the post-attach kick this claim is about.
    const boot = await seedMailbox(db);
    fleet.behave(boot.mailboxId, { deliver: mail(1, "boot") });

    const worker = await startWorker(cfgFor(fleet, { rosterIntervalMs: 250 }));
    closers.push(() => worker.stop());
    await waitFor(
      async () => (await db.select().from(messages).where(eq(messages.mailboxId, boot.mailboxId))).length === 1,
      20_000, "the boot mailbox's first cycle",
    );

    // A mailbox that appears AFTER the boot — a signup, or a mailbox re-enabled by support.
    const late = await seedMailbox(db);
    fleet.behave(late.mailboxId, { deliver: mail(1, "late") });

    // `pollIntervalMs` is 60 s. Attach alone no longer syncs anything, so without the kick this
    // mailbox's mail sits unprocessed for a minute and NOTHING logs or fails about it.
    const waited = await waitFor(
      async () => (await db.select().from(messages).where(eq(messages.mailboxId, late.mailboxId))).length === 1,
      20_000, "the late mailbox's first cycle (a missing post-attach kickCycle would wait 60s)",
    );
    expect(waited, "the late mailbox waited on the poll interval").toBeLessThan(20_000);
    expect(fleet.nth(late.mailboxId, "lease_organize", 1))
      .toBeLessThan(fleet.nth(late.mailboxId, "ensure_folders", 1));
  }, 120_000);
});

/**
 * The `sync_start` positions for `mailboxId` that have NO `lease_organize` between them and the
 * previous completed sync — i.e. every `changesSince` this process issued without the organizer
 * lease answering organize first.
 *
 * Returned as a list rather than a boolean so a failure names the offending call's index instead
 * of just saying `false`.
 */
function unGatedSyncs(fleet: FakeAdapterFleet, mailboxId: string): number[] {
  const at = (event: FakeEvent): number[] => fleet.indicesOf(mailboxId, event);
  const starts = at("sync_start");
  const ends = at("sync_end");
  const gates = at("lease_organize");
  return starts.filter((start, k) => {
    const floor = k === 0 ? -1 : (ends[k - 1] ?? -1);
    return !gates.some((g) => g > floor && g < start);
  });
}
