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
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A CONNECTION THAT CANNOT SERVE IS DETACHED, AND THE ROW SAYS SO
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured on the hosted service on 2026-08-04, on a live
 * mailbox:
 *
 *   00:58  both mailbox_attached      01:05  last last_sync_at stamp
 *   01:08:35  first causeCode="NoConnection"
 *   01:08 → 02:05  hundreds of consecutive event="sync_cycle_lease_unavailable", BOTH mailboxes
 *   row throughout: status=connected, sync_blocked_reason=NULL, error_code=NULL, retry_count=0
 *   heals ONLY on process restart
 *
 * `LeaseUnavailableError` is exempt from `maxSyncFailures` BY CLASS, and that exemption is CORRECT —
 * an infrastructure fault must never write `status='error'` on a customer's mailbox. What the exempt
 * arm had was no second observer: nothing bounded how long the state could persist and nothing
 * recorded it, so a PERMANENTLY dead connection was retried for ever while the worker reported
 * `leader` and `serving`. 52 minutes, two mailboxes, zero rows and zero log lines that said so.
 *
 * ── WHY THE SEAM IS THE LEASE AND NOT `failSync` ─────────────────────────────────────────────
 *
 * `failSync` throws from `changesSince`, which lands in the ORDINARY failure arm and quarantines
 * after `maxSyncFailures` — i.e. it exercises the path that already worked. The outage happened in
 * the arm that is exempt from that count, and the only way in is a lease read that throws. So
 * `FakeMetaFolder.deadConnection` (`_fakeadapter.ts`) makes `ensureMetaFolder`/`listClaims` throw a
 * plain `Error` carrying imapflow's own `code: "NoConnection"`, and `runLeaseGate` wraps it into
 * `LeaseUnavailableError` through the identical code path production took —
 * `errorClass=LeaseUnavailableError causeClass=Error causeCode=NoConnection`, all three reproduced.
 *
 * ── WHAT EACH CLAIM CATCHES (mutation table in the project's design notes) ───────────
 *
 *  1. two mailboxes attach and each completes a real cycle    ← the fixture is honest
 *  2. past the bound BOTH runtimes are detached, their logins CLOSED, `degraded` true, and
 *     `quarantined` still 0                                   ← restoring the arm to a bare
 *     `continue`; and, separately, "fix" it by quarantining instead of detaching
 *  3. the next roster pass RE-DIALS                           ← attach is reconnect, or nothing heals
 *  4. the row reads `sync_blocked_reason='lease_unreadable'`   ← dropping the arm's `noteBlock`
 *  5. no organizer claim is released, and no release is even ATTEMPTED
 *                                                             ← adding `releaseOrganizerClaim` to
 *     the detach path, which would hand the mailbox to a desktop install on every provider blip
 *  6. healing the lease heals the mailbox, WITH NO PROCESS RESTART, and clears the row
 *
 * …plus the negative claim the exemption itself depends on: ONE occurrence below the bound must NOT
 * detach anything. That one is a separate `it`, because it needs the opposite configuration.
 *
 * Nowhere near a real mailbox: two fake mailboxes in an isolated database.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 29));
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

/**
 * Every line the worker emitted, by event — the only vantage point from which "no claim release was
 * even ATTEMPTED" is observable (claim 5). A failed release is best-effort and swallowed, so the
 * counters cannot see it and neither can the folder.
 */
interface Recorder {
  lines: Array<{ event: string; fields: Record<string, unknown> }>;
  logger: WorkerConfig["logger"];
  of(event: string): Array<Record<string, unknown>>;
  events(): string[];
}

function recorder(): Recorder {
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const push = (event: string, fields?: Record<string, unknown>): void => {
    lines.push({ event, fields: fields ?? {} });
  };
  const logger = {
    debug: push, info: push, warn: push, error: push,
    child() { return this; },
  };
  return {
    lines,
    logger: logger as unknown as WorkerConfig["logger"],
    of(event) { return lines.filter((l) => l.event === event).map((l) => l.fields); },
    events() { return [...new Set(lines.map((l) => l.event))]; },
  };
}

function cfgFor(fleet: FakeAdapterFleet, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, sentDomain: "trafficflow.test",
    adapterFactory: fleet.factory,
    pollIntervalMs: 150, rosterIntervalMs: 250, lockHeartbeatMs: 60_000,
    alertIntervalMs: 600_000, maxSyncFailures: 3, mailboxRetryMs: 60_000,
    // ZERO, so the row is written on the FIRST observation instead of two minutes later. The grace
    // exists for a rolling deploy, not for a test, and a test that waited it out would be measuring
    // the clock rather than the write.
    syncBlockGraceMs: 0,
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

describe("a dead connection is detached and re-dialled, and the row says so", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_deadconn"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } } }, ISOLATED_DB_RESET_BUDGET_MS);

  it("bounds the exempt arm: detach, re-dial, write the row, keep the claim, heal without a restart", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const rec = recorder();

    const A = await seedMailbox(db);
    const B = await seedMailbox(db);
    const both = [A, B];
    const names = new Map([[A.mailboxId, "A"], [B.mailboxId, "B"]]);
    const trace = (): string => fleet.describeTrace(names);
    fleet.behave(A.mailboxId, { deliver: [{ from: "a@x.test", subject: "one", messageId: "dc-a1@x" }] });
    fleet.behave(B.mailboxId, { deliver: [{ from: "b@x.test", subject: "one", messageId: "dc-b1@x" }] });

    // 400 ms is comfortably several cycles at `pollIntervalMs: 150`, so the bound is crossed by
    // ELAPSED TIME across cycles rather than by any single cycle — which is the property the ruling
    // insisted on (a DURATION, never a pass count).
    const worker: RunningWorker = await startWorker(
      cfgFor(fleet, { logger: rec.logger, leaseUnavailableDetachMs: 400 }),
    );
    closers.push(() => worker.stop());

    // ── CLAIM 1: the fixture is honest — both mailboxes attach and each SYNCS ────────────────
    await waitFor(() => worker.stats().mailboxes === 2, 20_000, "both mailboxes attached");
    for (const mb of both) {
      await waitFor(
        async () => (await db.select().from(messages).where(eq(messages.mailboxId, mb.mailboxId))).length === 1,
        20_000, `${names.get(mb.mailboxId)}'s first cycle to ingest`,
      );
    }
    const claimsBefore = both.map((mb) => fleet.metaFor(mb.mailboxId).removals);
    const connectsBefore = both.map((mb) => fleet.indicesOf(mb.mailboxId, "connect").length);
    expect(connectsBefore, "each mailbox was dialled exactly once").toEqual([1, 1]);

    // ── THE EVENT: both connections die, exactly as production's did — silently. ─────────────
    // Nothing throws from a call the worker is awaiting; the client still exists and every lease
    // operation on it now refuses with `NoConnection`.
    for (const mb of both) fleet.killLease(mb.mailboxId);

    // ── CLAIM 2: past the bound BOTH runtimes are DETACHED, not quarantined ──────────────────
    await waitFor(() => worker.stats().mailboxes === 0, 20_000,
      `both runtimes to be detached past the bound — trace: ${trace()}`);
    const stats = worker.stats();
    expect(stats.mailboxes, "a runtime survived the bound").toBe(0);
    expect(stats.degraded, "serving 0 of 2 must be degraded").toBe(true);
    // THE DISTINCTION THE RULING TURNS ON. A quarantine writes `status='error'` plus an exponential
    // backoff for an INFRASTRUCTURE fault — the exact thing the by-class exemption exists to
    // prevent — and it would leave the mailbox un-dialled for a minute and then four and then
    // sixteen. Detach earns no backoff, so the next roster pass re-dials in 30 s, for ever, on a
    // mailbox whose row still says `connected`.
    expect(stats.quarantined, "the mailbox was QUARANTINED — an infrastructure fault must not").toBe(0);
    // …and the dead logins were CLOSED rather than leaked (risk 12). `openFor` is per mailbox, so
    // this also proves the detach reached the adapter and not merely the map.
    for (const mb of both) {
      expect(fleet.openFor(mb.mailboxId), `${names.get(mb.mailboxId)}'s dead login was leaked`).toBe(0);
    }
    // The reason on the wire says what happened, and the fields are the ones the census allows.
    const detached = rec.of("mailbox_detached");
    expect(detached.length, "no mailbox_detached line — the streak cannot self-terminate").toBeGreaterThanOrEqual(2);
    expect(String(detached.at(-1)?.reason)).toMatch(/organizer lease was unreadable for \d+ms/);
    // Every occurrence logged, with the operation named — the cycle arm that fired hundreds of times in
    // production carried no `op` at all.
    const unavailable = rec.of("sync_cycle_lease_unavailable");
    expect(unavailable.length, "the exempt arm stopped logging").toBeGreaterThanOrEqual(2);
    expect(unavailable[0]!.op, "the failing lease operation is not named").toBe("ensure_meta");
    expect(unavailable[0]!.threshold).toBe(400);

    // ── CLAIM 3: THE NEXT ROSTER PASS RE-DIALS. Attach IS reconnect. ─────────────────────────
    for (const mb of both) {
      await waitFor(() => fleet.indicesOf(mb.mailboxId, "connect").length >= 2, 20_000,
        `${names.get(mb.mailboxId)} to be re-dialled on a FRESH connection — trace: ${trace()}`);
    }

    // ── CLAIM 4: THE ROW SAYS SO — THE claim-as-contract, in the steady state ──────────────
    // "A mailbox that cannot be served says so on its row" was true at attach and FALSE in the
    // steady state for the whole 52 minutes. This is the assertion that makes it true.
    for (const mb of both) {
      await waitFor(async () => {
        const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.mailboxId));
        return row?.syncBlockedReason === "lease_unreadable";
      }, 20_000, `${names.get(mb.mailboxId)}'s row to read sync_blocked_reason='lease_unreadable'`);
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.mailboxId));
      // …and NOTHING ELSE on the row moved. This half is the "not a quarantine, not a stand-down"
      // claim read from the database rather than from the counters: an infrastructure fault must not
      // mark the mailbox broken, must not disable it, and must not earn it a retry backoff.
      expect(row!.status, "an infrastructure fault changed the mailbox's status").toBe("connected");
      expect(row!.errorCode, "an infrastructure fault wrote an error code").toBeNull();
      expect(row!.retryCount, "an infrastructure fault earned a retry backoff").toBe(0);
      expect(row!.disabledReason, "a lease we could not READ was treated as a stand-down").toBeNull();
    }

    // ── CLAIM 5: THE CLAIM IS NOT RELEASED, AND NO RELEASE IS EVEN ATTEMPTED ─────────────────
    //
    // A release on connection death hands the mailbox to a desktop install on every provider blip,
    // and breaks "exactly one active organizer per mailbox" in the direction that loses mail.
    //
    // THE `removals` HALF IS WEAK ON ITS OWN AND IS KEPT ANYWAY: with the lease dead, a release
    // could not succeed even if it were attempted (`releaseMailboxClaim` reads the folder first, and
    // that throws), so this counter cannot move whatever the detach path does. What it DOES cover is
    // `runLeaseGate`'s own expunge on a stand-down verdict — the bound must never convert "we could
    // not read the lease" into "somebody else holds it".
    //
    // The BITING half is the log: `releaseOrganizerClaim` is best-effort and swallows its failure,
    // but it swallows it into `organizer_claim_release_failed`. So an attempt is observable exactly
    // once, on the line nobody would think to delete.
    expect(both.map((mb) => fleet.metaFor(mb.mailboxId).removals),
      "an organizer claim was expunged across the detach").toEqual(claimsBefore);
    expect(rec.of("organizer_claim_released"), "the detach path released the organizer claim").toEqual([]);
    expect(rec.of("organizer_claim_release_failed"),
      "the detach path ATTEMPTED to release the organizer claim").toEqual([]);

    // …and the fix does not page an operator about its own behaviour (risk 3). A detached mailbox
    // that the arm forgot to `noteBlock` is in NO bucket, and `roster_invariant_violated` fires
    // every roster interval about it.
    expect(rec.of("roster_invariant_violated"),
      "the fix's own detach was reported as a duty gap — the arm's noteBlock is missing").toEqual([]);

    // ── CLAIM 6: HEAL THE LEASE → THE MAILBOX HEALS. NO PROCESS RESTART. ────────────────────
    // Production healed on a redeploy and on nothing else. This is the same recovery without one.
    fleet.behave(A.mailboxId, {
      deliver: [
        { from: "a@x.test", subject: "one", messageId: "dc-a1@x" },
        { from: "a@x.test", subject: "two", messageId: "dc-a2@x" },
      ],
    });
    for (const mb of both) fleet.killLease(mb.mailboxId, false);

    await waitFor(() => worker.stats().mailboxes === 2, 20_000, "both mailboxes to re-attach");
    // A REAL cycle, not merely a re-attach: since that change `attach()` syncs nothing at all, so new
    // mail arriving is the only evidence that the rotation is serving again.
    await waitFor(
      async () => (await db.select().from(messages).where(eq(messages.mailboxId, A.mailboxId))).length === 2,
      20_000, "the recovered mailbox to ingest new mail",
    );
    for (const mb of both) {
      await waitFor(async () => {
        const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.mailboxId));
        return row?.syncBlockedReason === null;
      }, 20_000, `${names.get(mb.mailboxId)}'s row to be CLEARED once it is served again`);
    }
    expect(worker.stats().degraded, "a fully recovered roster still reports degraded").toBe(false);
  }, 180_000);

  it("ONE occurrence below the bound does NOT detach — the exemption survives", async () => {
    // The other half of the ruling, and the one a careless fix breaks. `LeaseUnavailableError` is
    // exempt BY CLASS precisely so a transient blip — a `FETCH` refused once, a provider hiccup —
    // costs one un-synced cycle and nothing else. A bound that fired on the first occurrence would
    // turn every blip into a reconnect, and (worse) would make the exemption's whole argument false:
    // an infrastructure fault would once again have a per-mailbox consequence.
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const rec = recorder();

    const A = await seedMailbox(db);
    const B = await seedMailbox(db);
    fleet.behave(A.mailboxId, { deliver: [{ from: "a@x.test", subject: "one", messageId: "dc-low-a@x" }] });

    // Far longer than the test window, so nothing but a first-occurrence bug can detach anything.
    const worker = await startWorker(
      cfgFor(fleet, { logger: rec.logger, leaseUnavailableDetachMs: 60_000 }),
    );
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 2, 20_000, "both mailboxes attached");
    await waitFor(
      async () => (await db.select().from(messages).where(eq(messages.mailboxId, A.mailboxId))).length === 1,
      20_000, "the first cycle",
    );

    fleet.killLease(A.mailboxId);
    // Asserted at ONE occurrence first and then at three. Both, deliberately: a bound that fires on
    // the first occurrence detaches the mailbox before a third `sync_cycle_lease_unavailable` can
    // ever be logged, so a wait for three would time out on the harness's own message instead of on
    // the claim. The one-occurrence check below is what names the actual defect.
    await waitFor(() => rec.of("sync_cycle_lease_unavailable").length >= 1, 20_000,
      "the first lease-unavailable cycle");
    expect(rec.of("mailbox_detached"), "the FIRST occurrence detached the mailbox").toEqual([]);
    expect(worker.stats().mailboxes, "the FIRST occurrence detached the mailbox").toBe(2);
    // …and again after several, so this is "repeatedly below the bound" and not "once".
    await waitFor(() => rec.of("sync_cycle_lease_unavailable").length >= 3, 20_000,
      "at least three lease-unavailable cycles below the bound");

    expect(worker.stats().mailboxes, "a blip below the bound detached the mailbox").toBe(2);
    expect(worker.stats().quarantined, "a blip below the bound quarantined the mailbox").toBe(0);
    expect(rec.of("mailbox_detached"), "a blip below the bound detached the mailbox").toEqual([]);
    // …and the row still says so, from the FIRST occurrence, because recording and detaching are
    // separate decisions. This is what makes the bound safe to set generously.
    await waitFor(async () => {
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, A.mailboxId));
      return row?.syncBlockedReason === "lease_unreadable";
    }, 20_000, "the row to explain a block that has not yet earned a detach");
    // The innocent mailbox is untouched throughout — per-mailbox isolation, restated.
    const [rowB] = await db.select().from(mailboxes).where(eq(mailboxes.id, B.mailboxId));
    expect(rowB!.syncBlockedReason, "the healthy mailbox was blamed for its neighbour").toBeNull();
  }, 180_000);

  /**
   * THE FAST PATH — A CONNECTION THAT *ENDED* DETACHES, A CONNECTION THAT *ERRORED* QUARANTINES.
   *
   * The ruling routes imapflow's `close` into the same `onConnectionError` callback as `error`, and
   * the ruling's own CORRECTION 2 says the consequence of a dead connection is detach and NOT
   * quarantine. Those two compose only if `handleConnectionError` tells the shapes apart, so it does
   * — by CLASS (`ImapConnectionClosedError`, which is ours), never by a driver string.
   *
   * The stakes are not hypothetical. The 2026-08-04 timeline fits `socketMs = 120_000` → socket
   * timeout → failed NOOP recovery → a silent `close()`. Quarantining that writes `status='error'`,
   * an `error_code` and a `retry_count` bump onto the OWNER's mailbox because the worker's own
   * deadline ended a connection — the "infrastructure fault rendered as a broken mailbox" pathology
   * this repository has now paid for three times — and it makes the "fast" path SLOWER than the
   * bound it is supposed to beat: a doubling backoff measured against the roster interval.
   *
   * `killConnection` (the `error` shape) still quarantines, and `connection-error.e2e.test.ts`
   * still asserts exactly that. These two tests are the pair.
   */
  it("a connection that merely CLOSED is detached and re-dialled — never quarantined", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const rec = recorder();
    const A = await seedMailbox(db);
    const B = await seedMailbox(db);
    fleet.behave(A.mailboxId, { deliver: [{ from: "a@x.test", subject: "one", messageId: "dc-cl-a1@x" }] });

    const worker = await startWorker(cfgFor(fleet, { logger: rec.logger }));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 2, 20_000, "both mailboxes attached");
    await waitFor(
      async () => (await db.select().from(messages).where(eq(messages.mailboxId, A.mailboxId))).length === 1,
      20_000, "the first cycle",
    );

    // THE EVENT — out of band, from no call stack the worker owns, carrying the real class the
    // adapter's `close` listener constructs.
    fleet.closeConnection(A.mailboxId);

    await waitFor(() => rec.of("mailbox_detached").length >= 1, 20_000, "the closed connection to be detached");
    expect(rec.of("mailbox_quarantined"),
      "a socket that merely CLOSED was rendered as a broken mailbox").toEqual([]);
    expect(worker.stats().quarantined, "a closed connection earned a retry backoff").toBe(0);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, A.mailboxId));
    expect(row!.status, "a closed connection wrote status='error'").toBe("connected");
    expect(row!.errorCode, "a closed connection wrote an error code").toBeNull();
    expect(row!.retryCount, "a closed connection bumped retry_count").toBe(0);

    // …and it comes straight back, on a fresh connection, without waiting out any backoff.
    await waitFor(() => fleet.indicesOf(A.mailboxId, "connect").length >= 2, 20_000,
      "the closed connection to be re-dialled by the next roster pass");
    await waitFor(() => worker.stats().mailboxes === 2, 20_000, "the rotation to be whole again");
    // The bystander never left. Per-mailbox isolation is the whole point of this callback.
    expect(fleet.indicesOf(B.mailboxId, "connect").length,
      "the innocent mailbox was re-dialled too").toBe(1);
  }, 180_000);

  /**
   * THE CLOCK IS PER EPISODE, AND A RECOVERED CYCLE ENDS THE EPISODE.
   *
   * Written because two mutations came back GREEN against the two tests above, and a mutation that
   * is green for a *reachability* reason is the most dangerous kind:
   *
   *  · deleting `rt.leaseUnavailableSince = null` after `mayOrganize` resolves. Neither test above
   *    ever recovers a lease and then loses it again, so nothing observes a clock that is never
   *    reset — and in production that mutation means the SECOND blip of the day detaches
   *    immediately, because it is measured from the first blip hours earlier. The bound would decay
   *    into "one failure, ever".
   *  · deleting the success path's `leaseBlocked.delete(rt.mailboxId)`. In the first test the row is
   *    cleared by the successful RE-ATTACH (`attach()` deletes the same key), so the cycle-path
   *    delete is redundant there. It stops being redundant exactly here: a mailbox that recovers
   *    BELOW the bound is never re-attached at all, so the cycle is the only thing that can clear
   *    its row — and a row left saying `lease_unreadable` about a mailbox that is visibly syncing is
   *    the claim-as-contract broken in the other direction.
   *
   * The bound is short and the recovery is deliberately allowed to outlast it, which is what makes
   * the second kill's FIRST failure the whole assertion.
   */
  it("a recovered cycle ends the episode: the row clears without a re-attach, and the clock restarts", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const rec = recorder();
    const A = await seedMailbox(db);
    fleet.behave(A.mailboxId, { deliver: [{ from: "a@x.test", subject: "one", messageId: "dc-ep-a1@x" }] });

    const BOUND = 500;
    const worker = await startWorker(
      cfgFor(fleet, { logger: rec.logger, leaseUnavailableDetachMs: BOUND }),
    );
    closers.push(() => worker.stop());
    await waitFor(
      async () => (await db.select().from(messages).where(eq(messages.mailboxId, A.mailboxId))).length === 1,
      20_000, "the first cycle",
    );

    // ── EPISODE ONE, ended BELOW the bound ──────────────────────────────────────────────────
    fleet.killLease(A.mailboxId);
    await waitFor(() => rec.of("sync_cycle_lease_unavailable").length >= 1, 20_000, "one failing cycle");
    await waitFor(async () => {
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, A.mailboxId));
      return row?.syncBlockedReason === "lease_unreadable";
    }, 20_000, "the row to record the block");
    fleet.killLease(A.mailboxId, false);

    // Cleared by the CYCLE, on the connection it has held throughout. The connect count is the proof
    // that no re-attach is doing this work: `attach()` deletes the same bucket key, so without this
    // assertion the two writers are indistinguishable.
    await waitFor(async () => {
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, A.mailboxId));
      return row?.syncBlockedReason === null;
    }, 20_000, "the row to be CLEARED by a recovered cycle (no re-attach can be credited here)");
    expect(fleet.indicesOf(A.mailboxId, "connect").length,
      "the mailbox was re-attached — this claim is about the CYCLE clearing the row").toBe(1);
    expect(rec.of("mailbox_detached"), "the episode below the bound detached the mailbox").toEqual([]);

    // Let the wall clock pass the bound while the mailbox is perfectly healthy. A clock that is
    // never reset is now `BOUND + ε` old, so the next single failure would detach at once.
    await new Promise((r) => setTimeout(r, BOUND + 300));

    // ── EPISODE TWO: its FIRST failure must not detach ───────────────────────────────────────
    const before = rec.of("sync_cycle_lease_unavailable").length;
    fleet.killLease(A.mailboxId);
    await waitFor(() => rec.of("sync_cycle_lease_unavailable").length >= before + 1, 20_000,
      "the second episode's first failing cycle");
    expect(rec.of("mailbox_detached"),
      "the second episode was measured from the FIRST episode's clock — the reset is missing").toEqual([]);
    expect(worker.stats().mailboxes, "the second episode's first failure detached the mailbox").toBe(1);

    // …and it still detaches eventually, so the assertion above is a statement about the CLOCK and
    // not about the bound having been switched off.
    await waitFor(() => worker.stats().mailboxes === 0, 20_000,
      "the second episode to cross the bound on its own clock");
  }, 180_000);
});
