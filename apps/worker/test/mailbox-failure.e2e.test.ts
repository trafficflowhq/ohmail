import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { workerHeartbeats } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { startWorker, type RunningWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * WHAT A FAILED MAILBOX RECORDS, AND WHAT A BUSY ONE LOOKS LIKE FROM OUTSIDE.
 *
 * Both halves of this file come from one incident. On 2026-08-01 a disk-full outage
 * quarantined a live mailbox, and for the next hour the system could say almost
 * nothing true about itself:
 *
 *  · `mailboxes` recorded THAT it failed and never WHY — no code, no time, no attempt count —
 *    so Settings → Mailboxes said "Sync failed" and the admin console's `lastError` was a
 *    hardcoded `null`. Everything else lived in a process that had since restarted;
 *  · and once the fix deployed, the mailbox ingested its backlog over a stretch of hours
 *    while `worker_heartbeats` reported `mailboxes: 0` — because the runtime was not published
 *    until the first drain finished. "Hard at work" and "dead" were the same row.
 *
 * Every test below asserts one of those, driven by the fake adapter rather than by a real
 * provider: a parked `changesSince` is what makes "mid-drain" a state a test can stand inside.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 11));
let DB = "";

type Db = ReturnType<typeof makeDb>;

async function seedMailbox(
  db: Db, opts: { status?: string } = {},
): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    ...(opts.status ? { status: opts.status } : {}),
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

async function rowOf(db: Db, mailboxId: string): Promise<typeof mailboxes.$inferSelect> {
  const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
  return row!;
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

function cfgFor(fleet: FakeAdapterFleet, extra: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
    rosterIntervalMs: 300, mailboxRetryMs: 300, maxSyncFailures: 2,
    lockHeartbeatMs: 150, instanceId: "wkr-fail-test",
    adapterFactory: fleet.factory,
    ...extra,
  };
}

describe("a quarantined mailbox records WHY (mail 0023)", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_failreason"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("writes a code, a detail, a start time and an attempt count — and clears all four on recovery", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db);
    // A refused dial. The fake throws a plain Error with no `code`, which is the honest shape
    // for "we could not name it": the taxonomy must still say something useful (`unknown`
    // during attach) and the detail must be NULL rather than the message.
    fleet.behave(mb.mailboxId, { failConnect: true });

    const worker: RunningWorker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());

    await waitFor(async () => (await rowOf(db, mb.mailboxId)).status === "error", 8000, "quarantine persisted");
    const failed = await rowOf(db, mb.mailboxId);
    expect(failed.errorCode).toBe("unknown");
    // THE REDACTION, ASSERTED AS AN ABSENCE. `fake connect refused (<id>)` is the message, and
    // it must not be anywhere in this row: a real one can carry RFC822 header bytes or echo a
    // login argument, and this column is read by the account's user AND by the admin console.
    expect(failed.errorDetail).toBeNull();
    expect(failed.failedAt).not.toBeNull();
    expect(failed.retryCount).toBeGreaterThanOrEqual(1);

    const firstFailedAt = failed.failedAt!.getTime();
    const firstCount = failed.retryCount;

    // The outage CONTINUES. `failed_at` is the start of it and must not move; `retry_count` is
    // its size and must grow. A column that reset to "just now, attempt 1" on every retry would
    // tell a user their three-day outage began a minute ago.
    await waitFor(async () => (await rowOf(db, mb.mailboxId)).retryCount > firstCount, 8000, "a second attempt");
    const again = await rowOf(db, mb.mailboxId);
    expect(again.failedAt!.getTime()).toBe(firstFailedAt);

    // …and now it recovers. All four clear in the same statement that writes `connected`, so a
    // client can never render "connected" beside a stale reason.
    fleet.behave(mb.mailboxId, { failConnect: false });
    await waitFor(async () => (await rowOf(db, mb.mailboxId)).status === "connected", 8000, "recovery");
    const healed = await rowOf(db, mb.mailboxId);
    expect(healed.errorCode).toBeNull();
    expect(healed.errorDetail).toBeNull();
    expect(healed.failedAt).toBeNull();
    expect(healed.retryCount).toBe(0);
  }, 30000);

  it("a mailbox that attaches and THEN fails is classified as a sync failure, not a connect one", async () => {
    // The distinction the UI turns into different sentences: a mailbox that never answered vs
    // one that authenticated fine and then went wrong while being read. Keyed on the PHASE, so
    // an unnameable error still lands somewhere honest instead of a blanket "unknown".
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db);

    const worker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitFor(async () => (await rowOf(db, mb.mailboxId)).status === "connected", 8000, "the clean attach");

    fleet.behave(mb.mailboxId, { failSync: true });
    await waitFor(async () => (await rowOf(db, mb.mailboxId)).status === "error", 8000, "runtime quarantine");
    expect((await rowOf(db, mb.mailboxId)).errorCode).toBe("sync");
  }, 30000);

  /* ── WHAT THE ROW SAYS WHEN THE PROVIDER IS MERELY BUSY ──────────────────────

     The two tests below are the end-to-end half of `mailbox-error-redaction.test.ts`'s
     auth-classification block. That file proves the classifier's answer; these prove that the answer
     reaches the column the account owner reads in Settings → Mailboxes and the admin console
     reads as `lastError`, on both paths that can produce it.

     They also correct the gap row that commissioned them. It said "three consecutive failures
     detach the mailbox", which is the SYNC path (`index.ts` counts `maxSyncFailures` cycle
     errors before detaching). A refused LOGIN lands on the ATTACH path, which quarantines on the
     FIRST occurrence — so the wrong sentence is on the user's screen one roster pass after the
     provider gets busy, not three. The `retryCount` assertion in the first test is what pins
     that, and it is the reason it is asserted at all. */

  it("a provider connection cap is NOT a rejected password — and it lands on the FIRST attempt", async () => {
    // The wire shape, from `imapflow@1.5.0` rather than invented: an untagged `BYE` and a close
    // during LOGIN rejects the pending command through `createNoConnectionError`
    // (`imap-flow.js:1987-1994`) with `code: "NoConnection"` and the server's text in `reason`,
    // and `commands/login.js:38` then stamps `authenticationFailed = true` on it unconditionally.
    // There is no `serverResponseCode` on this shape — `serverBye` keeps only the TEXT parts —
    // which is why reordering the response-code probe alone would not have fixed it.
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db);
    fleet.behave(mb.mailboxId, {
      connectError: Object.assign(new Error("Connection not available"), {
        code: "NoConnection",
        reason: "Maximum number of connections from user+IP exceeded",
        authenticationFailed: true,
      }),
    });

    const worker: RunningWorker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());

    await waitFor(async () => (await rowOf(db, mb.mailboxId)).status === "error", 8000, "quarantine persisted");
    const failed = await rowOf(db, mb.mailboxId);

    // THE FINDING. `auth` here is the row telling the user their password is wrong about a
    // mailbox whose password is fine and whose provider is simply at its connection limit.
    expect(failed.errorCode, "a busy provider must not be reported as a rejected password").toBe("connect");
    // …and the sub-case is still legible, which is the argument for reusing `connect` instead of
    // growing the taxonomy: `error_code` carries what a human acts on, `error_detail` carries
    // which refusal it was. Both are in the row, so nothing is lost by having six classes.
    expect(failed.errorDetail).toBe("NoConnection");
    // The server's own sentence is NOT in the row. `reason` is chosen by the mail server exactly
    // as the bracket atom is, and the rule covers it: a provider having a verbose day, or a
    // hostile endpoint the user was tricked into adding, may not write free text into a column
    // the user and staff both read.
    expect(JSON.stringify(failed)).not.toContain("Maximum number of connections");

    // ONE attempt, not three. The attach path has no failure counter — `attach()` quarantines
    // directly — so the whole of the user-visible harm is present after a single refused dial.
    expect(failed.retryCount).toBe(1);
    expect(worker.stats().mailboxes, "nothing was ever attached, so nothing was detached").toBe(0);

    // …and it heals by itself when the provider frees a slot, with no human action. This is what
    // makes the quarantine a BACKOFF rather than a quarantine in the punitive sense.
    fleet.behave(mb.mailboxId, { connectError: undefined });
    await waitFor(async () => (await rowOf(db, mb.mailboxId)).status === "connected", 8000, "recovery");
    expect((await rowOf(db, mb.mailboxId)).errorCode).toBeNull();
  }, 30000);

  it("three cycle failures on a dead socket DO detach — and say `connect`, not `sync`", async () => {
    // The other path, and the one the gap row was actually describing. A connection that dies
    // under an attached mailbox makes every cycle throw; at `maxSyncFailures` the runtime is
    // detached and quarantined. THE DETACH IS NOT THE DEFECT — detach is how this worker
    // reconnects (`index.ts`: attach is connect + gate + folders + IDLE, so the next roster pass
    // re-dials on a fresh socket). Keeping a dead socket in the rotation instead is the
    // 52-minute outage the dead-connection fix was written about.
    //
    // What IS asserted is the classification: the client names this failure precisely
    // (`code: "NoConnection"`), so the row must not fall back to the phase and report the
    // catch-all `sync` about a failure that has a name.
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db);

    const cycleFailures: number[] = [];
    const logger = {
      debug: () => { /* unused */ },
      info: () => { /* unused */ },
      warn: () => { /* unused */ },
      error: (event: string, fields?: Record<string, unknown>) => {
        if (event === "sync_cycle_failed") cycleFailures.push(Number(fields?.consecutiveFailures ?? -1));
      },
      child() { return this; },
    };

    const worker = await startWorker(cfgFor(fleet, { maxSyncFailures: 3, logger }));
    closers.push(() => worker.stop());
    await waitFor(async () => (await rowOf(db, mb.mailboxId)).status === "connected", 8000, "the clean attach");
    expect(worker.stats().mailboxes).toBe(1);

    fleet.behave(mb.mailboxId, {
      syncError: Object.assign(new Error("Connection not available"), { code: "NoConnection" }),
    });

    await waitFor(() => worker.stats().mailboxes === 0, 10_000, "the mailbox to be detached");
    // The detach and the row write are two steps — `detach(rt)` then `quarantineMailbox` — so the
    // process being ahead of the database here is normal and not the thing under test.
    await waitFor(async () => (await rowOf(db, mb.mailboxId)).status === "error", 8000, "the quarantine write");
    // Exactly three, counted from the worker's own log rather than inferred from the outcome:
    // `retry_count` grows either way and cannot tell three cycle failures from one quarantine.
    expect(cycleFailures.slice(0, 3), "detached at maxSyncFailures, not before").toEqual([1, 2, 3]);
    const quarantined = await rowOf(db, mb.mailboxId);
    expect(quarantined.errorCode).toBe("connect");
    expect(quarantined.errorDetail).toBe("NoConnection");
  }, 30000);

  it("the roster HEALS a row that says error while the mailbox is attached and serving", async () => {
    // THE LATENT BUG THIS CLOSES. The recovery write was made once, at attach, inside a
    // try/catch whose comment promised "the next roster pass writes it". It did not: the roster
    // loop skipped anything already in `runtimes`, so a mailbox whose recovery write failed
    // synced perfectly for the life of the process while Settings and the admin console both
    // called it broken — which is indistinguishable from the outage this slice is about.
    //
    // The failed write is simulated by putting the row into exactly the state it leaves behind:
    // attached and serving, row says `error`. Nothing else in the worker touches it.
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db);

    const worker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitFor(async () => (await rowOf(db, mb.mailboxId)).status === "connected", 8000, "the clean attach");
    expect(worker.stats().mailboxes).toBe(1);

    await db.update(mailboxes)
      .set({ status: "error", errorCode: "storage", errorDetail: "53100", retryCount: 4 })
      .where(eq(mailboxes.id, mb.mailboxId));

    await waitFor(async () => (await rowOf(db, mb.mailboxId)).status === "connected", 8000,
      "the roster pass to converge the row onto the mailbox it is actually serving");
    const healed = await rowOf(db, mb.mailboxId);
    expect(healed.errorCode, "healing is one statement — the reason goes with the status").toBeNull();
    expect(healed.retryCount).toBe(0);
    // …and it never dropped out of the rotation to do it.
    expect(worker.stats().mailboxes).toBe(1);
  }, 30000);
});

describe("a mailbox mid-first-sync is visible, not invisible", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_failreason"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("COUNTS the mailbox and keeps BEATING while its first drain is still in flight", async () => {
    // The measured failure: thousands of messages ingested over many minutes while the
    // heartbeat said `mailboxes: 0` and `beat_at` sat frozen at boot. `attach()` published nothing
    // until its inline drain returned, and every beat in the file happened at the END of some piece
    // of work — so the busiest the worker ever gets was also the quietest it ever looked.
    //
    // The non-blocking attach removed the inline drain, so `mailboxes: 0` is no longer reachable this way. The
    // claim still needs asserting: a bounded cycle over a slow provider holds the serial queue for
    // minutes, and the row must keep counting and keep beating through it.
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db);

    // Park the FIRST sync cycle inside `changesSince`, which is where a real first sync spends
    // its minutes. Since that change that park is in the first `cycle()` rather than inside
    // `attach()` — the drain moved, the state under test did not: the serial queue is blocked on
    // a mailbox that is connected, counted, and nowhere near done.
    let release = (): void => {};
    fleet.behave(mb.mailboxId, { syncGate: new Promise<void>((r) => { release = r; }) });

    // NOT AWAITED, and the reason survived the move. `startWorker` now returns while the parked
    // cycle holds the queue, so `stats()` is technically reachable — but every ASSERTION below is
    // deliberately made against the DATABASE ROW, because that is what Railway's probe and the
    // external watchdog can see, and the incident was that the row said `mailboxes: 0` about a
    // process ingesting thousands of messages. A test that asked the process about itself would have
    // been green throughout the outage.
    const starting = startWorker(cfgFor(fleet));
    closers.push(async () => { release(); await (await starting).stop(); });

    await waitFor(() => fleet.syncInFlight === 1, 8000, "the first sync cycle to park");

    // 1. The row counts the mailbox. It IS connected, its folders exist, and the call it is
    //    parked inside is syncing it — counting it is the honest answer, not an optimistic one.
    await waitFor(async () => {
      const [row] = await db.select().from(workerHeartbeats);
      return row?.mailboxes === 1;
    }, 8000, "the heartbeat to count the mailbox it is draining");
    const [beat] = await db.select().from(workerHeartbeats);
    expect(beat!.quarantined, "and it is not simultaneously quarantined").toBe(0);

    // 2. …and keeps saying so. The lock-verify timer pulses off the serial queue, so `beat_at`
    //    advances while the queue is blocked. Without it the `worker_down` rule — which reads
    //    `beat_at` staleness and nothing else — pages a human at two minutes about a worker
    //    that is ingesting mail as fast as the provider will serve it, and the platform is
    //    entitled to replace the instance mid-backfill.
    await waitFor(async () => {
      const [row] = await db.select().from(workerHeartbeats);
      return row!.beatAt.getTime() > beat!.beatAt.getTime();
    }, 8000, "beat_at to advance WHILE the serial queue is blocked on the drain");

    // 3. And the STATUS column has not been talked into lying. Verified recovery means a
    //    COMPLETED sync cycle (the non-blocking attach moved that bar off "two inline cycles at attach" and onto
    //    the cycle path, where every success is a real one); this mailbox is parked inside its
    //    first `changesSince` and has completed nothing, so a `connected` written now would be
    //    the flap the ordering exists to avoid. It was seeded `connected` (the column's default),
    //    so the assertion that bites is the negative one: nothing has claimed a recovery on its
    //    behalf.
    expect((await rowOf(db, mb.mailboxId)).failedAt).toBeNull();

    release();
    const worker = await starting;
    await waitFor(() => worker.stats().mailboxes === 1, 8000, "the attach to complete normally");
  }, 30000);

  it("does NOT reset the retry backoff when a mailbox connects and then fails to sync", async () => {
    // ── THE TRAP, AND WHERE IT MOVED TO ─────────────────────────────
    //
    // `quarantine` carries the exponential backoff's attempt count in memory, and whatever
    // clears it decides whether a struggling provider is backed off or hammered at the base
    // delay for ever. Originally the trap was clearing it beside `runtimes.set`, so the delete
    // was put at the END of a successful attach — which was then AFTER the inline drain, so a
    // mailbox whose sync threw never reached it and attempts kept growing.
    //
    // The non-blocking attach took the drain off the attach path, which turned "the end of a successful attach"
    // into "before the drain" and reopened the same trap by standing still. For THIS mailbox —
    // a login the provider accepts whose every `changesSince` throws — attach now SUCCEEDS, so a
    // delete left there would clear the count on every retry: fail, quarantine at attempts=1,
    // re-attach, clear, fail, for ever at `retryBaseMs`, against somebody's real provider. So the
    // delete moved again, onto the first SUCCESSFUL CYCLE, and this test moved with it.
    //
    // ── WHY THE ROW'S COUNTER CANNOT SEE ANY OF THAT ───────────────────────────────────────
    //
    // `retryCount` is a durable `+ 1` per quarantine, so it climbs identically whether the
    // in-memory attempts grow or reset — it would have been green on the regression above. The
    // observable that actually distinguishes them is `retryInMs`, which `quarantineMailbox`
    // computes from the attempt count and logs, so the logger is the seam.
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db);
    // Connect, the lease gate, ensureFolders and IDLE all succeed; every sync cycle throws. The
    // runtime IS published and the mailbox then fails at RUNTIME — the exact window under test.
    fleet.behave(mb.mailboxId, { failSync: true });

    const backoffs: number[] = [];
    const recoveries: string[] = [];
    const logger = {
      debug: () => { /* unused */ },
      info: (event: string) => { if (event === "mailbox_recovered") recoveries.push(event); },
      warn: () => { /* unused */ },
      error: (event: string, detail?: Record<string, unknown>) => {
        if (event === "mailbox_quarantined" && typeof detail?.retryInMs === "number") {
          backoffs.push(detail.retryInMs);
        }
      },
      child() { return this; },
    };

    const worker = await startWorker(cfgFor(fleet, { logger }));
    closers.push(() => worker.stop());

    await waitFor(async () => (await rowOf(db, mb.mailboxId)).retryCount >= 3, 15000,
      "three quarantines, each counted durably");
    const row = await rowOf(db, mb.mailboxId);
    expect(row.status).toBe("error");
    // `sync`, not `unknown`: the phase genuinely moved. This mailbox connected, proved its lease,
    // got its folders and reached IDLE — it then went wrong WHILE BEING READ, which is what the
    // `sync` phase means and what `classifyMailboxError` turns into this code. `unknown` was the
    // right answer only while the throw came from inside an attach that never completed.
    expect(row.errorCode).toBe("sync");

    // ── THE ASSERTION THE OLD VERSION OF THIS TEST DID NOT HAVE ────────────────────────────
    //
    // Attempts grow ⇒ 300, 600, 1200 … A reset gives 300, 300, 300 — same `retryCount`, same
    // status, same code. This is the only line that tells them apart.
    expect(backoffs.length, "at least three quarantines were logged").toBeGreaterThanOrEqual(3);
    expect(backoffs, `the backoff did not grow: ${backoffs.join(", ")}`)
      .toEqual([...backoffs].sort((a, b) => a - b));
    expect(backoffs[2], `the third backoff is still the base delay: ${backoffs.join(", ")}`)
      .toBeGreaterThan(backoffs[0]!);

    // A FAILING MAILBOX STILL LEAVES NOTHING BEHIND. The old form of this assertion read
    // `stats().mailboxes === 0` immediately, which held only because a failed ATTACH never
    // entered the rotation. Now the mailbox does enter it and is detached by the quarantine, so
    // the claim is "it leaves" rather than "it never arrived" — and it is polled rather than
    // sampled, because by the third quarantine the next re-attach is ≥ 1.2 s away.
    await waitFor(() => worker.stats().mailboxes === 0, 5000,
      "the quarantine to detach the failing mailbox from the rotation");
    expect(fleet.openFor(mb.mailboxId), "the quarantine leaked the provider login").toBe(0);

    // ── AND THE STATUS COLUMN IS NEVER TALKED INTO SAYING `connected` ───────────────────────
    //
    // The other half of the recovery-write move, and the half with no natural guard.
    // "Attached" used to imply "drained twice", so being in `runtimes` was itself evidence of a
    // sync; it no longer is. THIS mailbox connects perfectly on every retry, so both writers of
    // `connected` — the cycle's `needsRecovery` spend and the roster pass's converge clause — are
    // one missing predicate away from flipping error → connected → error on every backoff, which
    // is a "connected" flash in Settings about a mailbox that has never once synced.
    //
    // Asserted on the LOG rather than the row, because `markMailboxFailed` rewrites `error` on
    // each quarantine and would hide a transient `connected` between two of them.
    expect(recoveries, "a mailbox that has never completed a cycle was called recovered").toEqual([]);
  }, 30000);

  it("the roster does NOT heal a row for a mailbox that is attached but has never synced", async () => {
    // ── THE OTHER WRITER OF `connected`, AND WHY IT NEEDED ITS OWN TEST ─────────────────────
    //
    // Two places write `connected` about an attached mailbox: the cycle's `needsRecovery` spend
    // and `reconcileRoster`'s converge clause. Only the second one can fire about a mailbox that
    // has never synced, because it keys on the ROW rather than on anything the runtime did — and
    // before that change it did not need a predicate, since "in `runtimes`" implied "drained twice".
    //
    // The sibling test above cannot see this. Its `maxSyncFailures: 2` quarantines the mailbox
    // faster than the 300 ms roster interval, so no pass ever observes it attached-and-`error`:
    // dropping the predicate leaves that test green. This one holds the mailbox in the rotation
    // instead — `maxSyncFailures: 50`, so it never quarantines inside the window — which is the
    // state a real mailbox sits in while a provider is refusing FETCH but accepting LOGIN.
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db, { status: "error" });
    fleet.behave(mb.mailboxId, { failSync: true });

    const recoveries: string[] = [];
    const logger = {
      debug: () => { /* unused */ },
      info: (event: string) => { if (event === "mailbox_recovered") recoveries.push(event); },
      warn: () => { /* unused */ },
      error: () => { /* unused */ },
      child() { return this; },
    };

    const worker = await startWorker(cfgFor(fleet, { logger, maxSyncFailures: 50 }));
    closers.push(() => worker.stop());

    // Attached and staying attached, with every cycle throwing.
    await waitFor(() => worker.stats().mailboxes === 1, 5000, "the mailbox to attach");
    // Long enough for several roster passes (300 ms) and several cycles (200 ms) to have seen it.
    await new Promise((r) => setTimeout(r, 1500));
    expect(worker.stats().mailboxes, "it stayed in the rotation for the whole window").toBe(1);

    expect(recoveries, "the roster healed a row for a mailbox that has never synced").toEqual([]);
    expect((await rowOf(db, mb.mailboxId)).status,
      "the row was converged to `connected` about a mailbox whose every cycle throws").toBe("error");
  }, 30000);
});

/**
 * MAIL 0039 — THE BACKOFF IS DURABLE, SO IT SURVIVES A RESTART AND SOMEBODY ELSE CAN CLEAR IT.
 *
 * ── THE GAP ────────────────────────────────────────────────────────────────────────────────
 *
 * The quarantine lived in a `Map` in this process and nowhere else, which cost two things at
 * once. A restart FORGOT every backoff, so a redeploy during a provider outage re-dialled every
 * parked mailbox at once — and a redeploy was simultaneously the ONLY way anybody could release
 * one, because no database write could reach the state. The console could not, a support engineer
 * could not, the customer could not.
 *
 * Both halves are the same column, and both are asserted here against a real worker rather than a
 * unit stub: the property is about what the roster pass DOES with a row it re-reads, and a stub of
 * the roster pass would be a test of the stub.
 */
describe("a quarantine outlives the process that set it (mail 0039)", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_retryafter"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("writes retry_after beside the failure, and clears it on a verified recovery", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db);
    fleet.behave(mb.mailboxId, { failConnect: true });

    const worker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());

    await waitFor(async () => (await rowOf(db, mb.mailboxId)).retryAfter !== null, 8000, "retry_after persisted");
    const parked = await rowOf(db, mb.mailboxId);
    // It is a FUTURE instant, in the same statement as the status — a row that says `error`
    // beside no backoff is the half-truth this column exists to remove, and the operator release
    // path reads exactly this field.
    expect(parked.status).toBe("error");
    expect(parked.retryAfter!.getTime()).toBeGreaterThan(Date.now() - 1000);

    // A verified recovery clears it, for the same reason it clears `retry_count`: a mailbox that
    // completed a cycle is not in a backoff. Left behind, it would re-park the mailbox on the
    // next restart, because the seed below reads the ROW and not the map.
    fleet.behave(mb.mailboxId, { failConnect: false });
    await waitFor(async () => (await rowOf(db, mb.mailboxId)).status === "connected", 8000, "recovery");
    expect((await rowOf(db, mb.mailboxId)).retryAfter).toBeNull();
  }, 30000);

  it("A NEW PROCESS HONOURS A BACKOFF IT NEVER SET — and an operator's release ends it", async () => {
    // The whole gap, in one test. Before the column, a fresh leader had an empty map: it
    // re-attached the mailbox immediately, which is why "restart the worker" WAS the release
    // mechanism — and why a deploy during a provider outage was a burst of retries.
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db);
    fleet.behave(mb.mailboxId, { failConnect: true });

    // A backoff far enough out that no ladder this test could run would reach it.
    await db.update(mailboxes).set({
      status: "error", errorCode: "auth", failedAt: new Date(), retryCount: 5,
      retryAfter: new Date(Date.now() + 3_600_000),
    }).where(eq(mailboxes.id, mb.mailboxId));

    // The mailbox is dialable again — the provider recovered — so anything that attaches it will
    // succeed. If the fresh worker ignored the row it would connect within a roster interval.
    fleet.behave(mb.mailboxId, { failConnect: false });

    const worker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());

    // Several roster passes (rosterIntervalMs = 300) with no attach: the row governs.
    await new Promise((r) => setTimeout(r, 2000));
    expect(
      (await rowOf(db, mb.mailboxId)).status,
      "a durable backoff must outlive the process that set it",
    ).toBe("error");
    expect(worker.stats().quarantined, "and it is ACCOUNTED FOR, not an unexplained roster gap").toBe(1);

    // ── THE RELEASE ────────────────────────────────────────────────────────────────────────
    //
    // Exactly what `resyncMailbox` writes: `retry_after = NULL`, nothing else. No status change,
    // no counter reset — the leader is left to observe the recovery itself.
    await db.update(mailboxes).set({ retryAfter: null }).where(eq(mailboxes.id, mb.mailboxId));

    await waitFor(
      async () => (await rowOf(db, mb.mailboxId)).status === "connected", 8000,
      "the leader re-dials on its next roster pass",
    );
    // …and the outage record it inherited was cleared by the RECOVERY, not by the release.
    const healed = await rowOf(db, mb.mailboxId);
    expect(healed.retryCount).toBe(0);
    expect(healed.errorCode).toBeNull();
  }, 30000);
});

/**
 * ═══ THE MAIL HOST GOES DOWN MID-CYCLE, NOT AT THE DOOR ═══════════════════════════════════
 *
 * ── WHAT THIS ADDS TO THE SIBLING TEST TWO BLOCKS UP ─────────────────────────────────────
 *
 * "three cycle failures on a dead socket" already covers a mid-cycle throw, and it is the right
 * shape — attach cleanly, then fail — so this does not re-prove that. What it fails with is
 * `code: "NoConnection"`, which is the installed IMAP CLIENT'S own word for a dead socket and
 * lands in `SERVER_UNAVAILABLE_CODES`. A mail host that is simply DOWN produces something else:
 * a Node errno, `ECONNREFUSED`, from `CONNECT_ERRNOS`, on a socket that never opened at all
 * this cycle. Two different sets, two different arms of `classifyMailboxError`, and only one of
 * them had a mid-cycle proof.
 *
 * The errno also carries something the client's code does not — `connect ECONNREFUSED
 * 10.0.0.5:993`, with the customer's mail host and port in the message — so this is also where
 * the redaction rule is exercised on the sync path rather than the attach one.
 *
 * The user-visible half is what makes it worth its own test. `apps/webapp`'s new `filing` state
 * says "we have filed this mail and your server has not applied it yet", and it is BELOW
 * `mailboxError` on the ladder deliberately — "your mail server refused us" is the larger,
 * actionable fact. That precedence is only honest if a host that is genuinely refusing actually
 * REACHES `status='error'`. If a mid-cycle ECONNREFUSED left the row saying `connected`, the
 * strip would sit on the smaller sentence for the whole outage and the mailbox row would never
 * offer the reconnect.
 *
 * ── AND THE CODE MUST BE `connect`, NOT `sync` ───────────────────────────────────────────
 *
 * `MailboxErrorPhase` "decides only the FALLBACK, never a positive classification"
 * (`mailboxes.ts`), and `ECONNREFUSED` is in `CONNECT_ERRNOS`, so it must classify as `connect`
 * on either path. The distinction reaches the user: `err_connect` says the mail server did not
 * answer — which is true and which they can act on — while `err_sync` says something went wrong
 * while reading their mail, which points at us.
 *
 * WATCHED TO FAIL: removing `"ECONNREFUSED"` from `CONNECT_ERRNOS` turns the code assertion red
 * with `sync` (the phase fallback), which is the sentence blaming ohmail for the host being
 * down. Dropping the `toQuarantine` loop's `quarantineMailbox` call leaves the row `connected`
 * for ever and turns the whole test red at the wait.
 */
describe("a mail host that goes down MID-CYCLE reaches status='error' (host-down)", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_hostdown"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("a refused connection DURING a cycle quarantines the mailbox and records `connect`", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db);

    // ATTACH CLEANLY FIRST. This is the whole point: the mailbox works, so the failure below
    // cannot reach `attach()`'s catch and must be handled by the cycle path.
    const worker: RunningWorker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitFor(async () => (await rowOf(db, mb.mailboxId)).status === "connected", 8000, "the clean attach");
    expect(worker.stats().mailboxes, "the premise: this mailbox is attached and serving").toBe(1);

    // …and NOW the host stops answering. The errno shape a real refusal carries, not a bare
    // Error: `code` is what `classifyMailboxError` reads, and inventing a message instead would
    // test the fallback rather than the classification.
    fleet.behave(mb.mailboxId, {
      syncError: Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:993"), {
        code: "ECONNREFUSED",
        errno: -61,
        syscall: "connect",
      }),
    });

    await waitFor(
      async () => (await rowOf(db, mb.mailboxId)).status === "error", 12000,
      "the mid-cycle outage was never written to the row",
    );
    const failed = await rowOf(db, mb.mailboxId);

    // THE FINDING THIS PINS. `connect` and not `sync`: the phase decides only the fallback, and
    // an errno the taxonomy knows outranks it on both paths. `err_sync` here would tell the
    // user ohmail broke while reading their mail, about a mail server that is refusing to
    // accept a TCP connection.
    expect(failed.errorCode, "a refused host was reported as our own sync failure").toBe("connect");
    // The detail is the ALLOWLISTED token and never the message — the message here carries an
    // IP and a port.
    expect(failed.errorDetail).toBe("ECONNREFUSED");
    expect(JSON.stringify(failed)).not.toContain("10.0.0.5");
    expect(failed.failedAt).not.toBeNull();

    // MORE THAN ONE cycle failed before this was written — the sync path counts to
    // `maxSyncFailures` (2 here), unlike the attach path which quarantines on the first refusal.
    // Asserting it is what stops this test passing against an implementation that had quietly
    // routed the throw back through `attach()`.
    expect(failed.retryCount).toBeGreaterThanOrEqual(1);
    expect(worker.stats().mailboxes, "the runtime was detached, not left counting as healthy").toBe(0);

    // …and it recovers on its own once the host comes back, which is what makes `error` a
    // reportable state rather than a dead end.
    fleet.behave(mb.mailboxId, { syncError: undefined });
    await waitFor(async () => (await rowOf(db, mb.mailboxId)).status === "connected", 12000, "recovery");
    expect((await rowOf(db, mb.mailboxId)).errorCode).toBeNull();
  }, 40000);
});
