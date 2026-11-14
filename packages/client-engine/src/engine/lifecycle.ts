import { drainPageLimit } from "@trafficflow/core/drain-policy";
import { flattenResponse } from "../apply.js";
import { keptDecisionOf, stillKept, supersededBy } from "../kept-decisions.js";
import type { MutationEffect } from "../mutations.js";
import type { WindowSearchPhases } from "../search-phases.js";
import { SHADOW_DRAIN_BOUND, shadowAgrees, shadowKeysOf } from "../shadow.js";
import { OUTBOX_PROTOCOL, type OutboxNotice } from "../store.js";
import {
  CursorExpiredError, type EngineMessage, type EngineMutation, FEED_SINCE_ID, type FeedSinceMeta,
  isProtectedMessage, type MessageBodyRecord, OUTBOX_ABANDONED_TYPE, OUTBOX_TYPE, type RuleDTO,
  SnapshotCursorRefusedError,
} from "../types.js";
import { classifyWindowSyncFailure, type WindowSyncFailure } from "../window-sync-failure.js";
import {
  BACKLOG_PUBLISH_PAGES, LAST_DRAIN_AT_META, noAnswerWithin, SNAPSHOT_REFUSAL_HOLD_BASE_MS,
  SNAPSHOT_REFUSAL_HOLD_CAP_MS, STORE_POLICY_GENERATION, STORE_POLICY_GENERATION_META,
} from "./options.js";
import {
  andDoneOf, byAtN, isCreatedRow, isPersistedOutboxEntry, pastCreateDedupe, type PersistedOutboxEntry,
  persistedWired,
} from "./outbox-record.js";
import { EngineTrash } from "./trash.js";

export abstract class EngineLifecycle extends EngineTrash {
  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Read the device's copy of the mailbox into memory — and SAY SO. `store.load()` reads the whole
   * persisted mirror and notifies nobody (the listener set lives here, not in the store), so a
   * returning user's mailbox was hydrated into memory and the UI was never told —
   * `useSyncExternalStore` holds its last snapshot, and the rows appeared only when the first
   * `/sync` page landed: on a slow connection the screen said "Nothing in your Ohbox." over mail
   * already on the device. Measured: two messages readable, store version 0 → 1000003, listeners
   * fired: 0 — mail sometimes appearing earlier was luck (any unrelated re-render re-reads).
   */

  /**
   * Single-flight, cleared in `finally` — `syncOnce()`'s pattern: concurrent callers coalesce, and
   * the promise is cleared even on REJECTION, so a failed hydration (IndexedDB blocked) can be
   * tried on the next wake — a memoized-forever version turns one transient storage error into a
   * mirror that can never be read for the life of the tab. A failed read changes one fact,
   * {@link outboxUnreadable}, and notifies once for it; the scheduler counts the rejection as a
   * failed tick, which is what makes the retry happen. Re-hydrating mid-session is not reachable
   * today (the scheduler latches; `start()` runs this before its only drain) — noted rather than
   * guarded, because a guard nothing can trigger is a claim no test can put under load.
   */
  async hydrate(): Promise<void> {
    if (this.hydrating) return this.hydrating;
    this.hydrating = this.store
      .load()
      // Reconcile the no-raw-secret-at-rest rule before publishing: a body cached by an older
      // engine (or by a
      // delta that arrived before the protect cascade shipped) for a message that is protected in
      // the mirror this load just read must not survive. See {@link purgeProtectedBodies}.
      .then(() => this.purgeProtectedBodies())
      .then(async () => {
        // The durable outbox re-arms with the same load that revives the mirror, so the first
        // publish below already carries every un-sent verb's optimistic effect — the boot
        // render is continuous with the killed session. See {@link OhmailEngine.restoreOutbox}.
        this.storeLoaded = true;
        this.restoreSentFolders();
        this.restoreOutbox();
        // The bodies the load restored are bodies this session holds, and the bound is theirs to
        // pay too — count them, then trim ONCE, before anybody is told. See {@link
        // OhmailEngine.countRestoredBodies}.
        this.countRestoredBodies();
        await this.trimBodyCache();
        this.notify();
      })
      .catch((err: unknown) => {
        if (!this.storeLoaded && !this.loadFailed) {
          this.loadFailed = true;
          this.notify();
        }
        throw err;
      })
      .finally(() => {
        this.hydrating = null;
      });
    return this.hydrating;
  }

  /**
   * TRUE WHILE THE STORE HAS REFUSED ITS LOAD and nothing has loaded since: this engine cannot read
   * its outbox, so it cannot say any send is over. A composer held for one says so, once.
   */
  outboxUnreadable(): boolean {
    return this.loadFailed && !this.storeLoaded;
  }

  /**
   * NO SENSITIVE BODY AT REST, RECONCILED ON LOAD. The delta cascade in {@link MirrorStore} purges a body the moment
   * a message TRANSITIONS to protected. This covers the two cases that transition cannot reach: a body cached by an
   * engine build from before that cascade existed, and a message that is ALREADY protected in the mirror this load
   * read (its protecting delta landed while a purge-less build was running). A protected message must hold no cached
   * `message_body`, and because {@link SearchIndex} is built from those records, purging here is also what keeps the
   * raw text out of the local search index — so a client that cached the body under an old engine, then updates,
   * converges. One pass over the client-local bodies, tombstoning only the ids whose message is protected; on the
   * ordinary mirror — where no protected message ever cached a body — it writes nothing.
   */

  /**
   * It does not `notify()`: `hydrate` publishes once after this settles, over the already-bumped store version.
   */
  protected async purgeProtectedBodies(): Promise<void> {
    const reader = this.read();
    const victims: string[] = [];
    for (const { id } of this.store.entries<MessageBodyRecord>("message_body")) {
      if (isProtectedMessage(reader.get<EngineMessage>("message", id))) victims.push(id);
    }
    for (const id of victims) await this.store.putLocal("message_body", id, null);
  }

  /**
   * Hydrate the mirror, then bootstrap/catch up.
   *
   * THE COLD-START SNAPSHOT IS NOT A SEPARATE CALL HERE. `syncOnce()` → `drain()`, and `drain()`
   * checks for a cursor of "0" at the top of its loop, which is the same condition a cold start
   * is. Writing the check here TOO would be a second seam that has to stay in agreement with the
   * first — and the drain's copy is the one that has to exist regardless, because the 410
   * re-bootstrap re-enters the loop with a cursor of "0" without ever passing through `start()`.
   * So there is one condition in one place, and a cold start reaches it by calling `syncOnce`.
   */
  async start(): Promise<void> {
    await this.hydrate();
    await this.syncOnce();
  }

  /**
   * Ring the WORKER's doorbell — `POST /sync/pull` — so the next IMAP scan of this account's mailboxes happens now
   * instead of at the poll rotation's leisure. The gesture-side half of pull-to-refresh: a drain answers "what does
   * the worker already have", and this is the ask for mail the worker has not looked at yet. See {@link
   * EngineAdapter.requestPull}. `null` when this adapter has no doorbell (the demo's FixturesAdapter, older bundles),
   * which a caller treats as "this world has no worker to hurry" — the drain it was going to run is still the whole
   * of what the gesture can do there. Never throws: the pull is an accelerant on top of a sync that must proceed
   * regardless, so a refused or failed ring degrades to exactly the behaviour the gesture had before the doorbell
   * existed.
   */
  /**
   * The window's own pull failed: hand a content-free record to the door so it lands in the
   * engine's log (`window_sync_failed`). Fire-and-forget by construction — the scheduler calls it
   * from the drain's catch, and a sink that rejects or is absent changes nothing about the retry.
   */
  reportSyncFailure(err: unknown, attempt: number): void {
    const sink = this.adapter.reportSyncFailure?.bind(this.adapter);
    if (!sink) return;
    let record: WindowSyncFailure;
    try { record = classifyWindowSyncFailure(err, attempt); } catch { return; }
    void sink(record).catch(() => { /* the log is a courtesy; the retry is the contract */ });
  }

  /** One Search's timings to the door's log, fire-and-forget as {@link reportSyncFailure} is. */
  reportSearchPhases(record: WindowSearchPhases): void {
    const sink = this.adapter.reportSearchPhases?.bind(this.adapter);
    if (!sink) return;
    void sink(record).catch(() => { /* the log is a courtesy */ });
  }

  async requestPull(opts?: { mailboxIds?: readonly string[] }): Promise<{
    requested: number; requestedAt: string;
    mailboxes: Array<{ id: string; requestedAt: string }>;
  } | null> {
    const ring = this.adapter.requestPull?.bind(this.adapter);
    if (!ring) return null;
    try {
      return await ring(opts);
    } catch {
      return null;
    }
  }

  /**
   * Does this client have a doorbell to ring at all? `attachmentsAvailable()`'s idiom for {@link
   * OhmailEngine.requestPull}: resolved from the adapter's own optional capability, so the predicate cannot disagree
   * with what the method will do. `false` for the demo (`?demo=1` is fixtures and zero network) and for any adapter
   * wrapper that did not forward the capability — which is exactly what a "Pull new mail" control must gate its own
   * rendering on: an affordance whose press could only ever degrade to the ordinary drain must not render as if it
   * reached the mail server. The webapp's `apiConfigured()` was the previous gate and it was wrong twice over — true
   * while the wrapped adapter had lost the doorbell (a dead button on the hosted client), and false on the desktop,
   * whose bridge adapter has a doorbell but no Cloud base (a missing button on both desktop doors).
   */
  pullAvailable(): boolean {
    return typeof this.adapter.requestPull === "function";
  }

  /**
   * One full drain: pull pages from the cursor of record until hasMore:false,
   * applying each page idempotently. A 410 discards local state and re-enters
   * as a bootstrap (once — a second 410 within one drain is surfaced).
   */
  async syncOnce(): Promise<void> {
    // Serialize concurrent callers onto one drain.
    if (this.syncing) return this.syncing;
    this.driveStartedAt = Date.now();
    this.syncing = this.drive().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  /** When the latest drive started (epoch ms, 0 before the first): a push this soon after is its echo. */
  lastDriveAt(): number {
    return this.driveStartedAt;
  }

  /**
   * ONE DRIVE = the outbox first, then the drain — the boot-drain ordering INSTANT-ARCH §8 stage 1 requires ("the
   * outbox drains before/with the first sync"), generalised to EVERY drive because it is correct on every one: a
   * queued verb replayed before the pages are read means the drain that follows carries its echo (the POSTs returned
   * before the page loop began), so a restart converges in a single round of requests and a verb queued by a network
   * blip retries at the scheduler's ordinary cadence with no dedicated loop. The replay happens INSIDE the
   * single-flight (`this.syncing` is this promise), which is why {@link OhmailEngine.dispatch} runs in
   * `deferReconcile` mode here — its usual per-mutation `syncFresh()` would wait on this very promise.
   */
  protected async drive(): Promise<void> {
    // NOT `restoreOutbox()` — see {@link restoreOutboxIfLoaded}. The drive can be reached before
    // `hydrate()` resolves, and latching there loses the previous session's verbs for good.
    this.restoreOutboxIfLoaded();
    await this.adoptOrphanedOutbox();
    await this.replayOutbox();
    await this.askOwedOnDrive();
    await this.drainPublishing();
  }

  /** The owed Cancels a drive asks, where the drive owns the replay; their answers wait as late ones. */
  protected async askOwedOnDrive(): Promise<void> {
    if (!this.autoReplayOn || this.owedWithdraws.size === 0) return;
    const settled = await this.askOwedWithdraws();
    for (const r of settled) this.lateResults.set(r.id, r);
    if (settled.length > 0) this.notify();
  }

  /** Replay every queued verb, oldest first, under its original Idempotency-Key. */

  protected async replayOutbox(): Promise<void> {
    // The host owns the whole replay (`outboxAutoReplay: false` — the mobile shape): the drive
    // touches nothing, and `flushPending` routes every result to its ledger.
    if (!this.autoReplayOn) return;
    // A timed-out dispatch from an earlier drive is still in the air — see {@link outboxHold}:
    // nothing may be dispatched behind it until it settles, so this drive skips its replay and
    // goes straight to the drain. Read here rather than left to the gate on purpose: the gate
    // would make this drive WAIT for the hold, and a drive that waits is a drain that waits —
    // reads are never hostage to a hung write. The queue keeps everything, in order, for the
    // drive after; the hold's own settle nudges one.
    if (this.outboxHold) return;
    /**
     * A DRIVE REACHED FROM INSIDE A DISPATCH DOES NOT REPLAY. A confirmed dispatch awaits `syncFresh()` to reconcile,
     * and that is a `drive()`, and a drive calls this. So this method can be entered while a gated dispatch is still
     * on the chain — and joining the gate there would queue it behind its own holder, which never settles. The
     * deadlock is silent: the promise just hangs, and the guard that catches it reads as a timeout rather than a
     * defect. Skipping is the honest answer rather than a workaround, and it is the same one the hold above gives:
     * that nested drive exists to DRAIN, the queue keeps everything in user order, and the next drive replays it.
     * Reads are never hostage to a write.
     */
    if (this.inOutboxGate) return;
    if (this.queue.length === 0) return;
    // THE GATE, around the whole batch. The body re-reads the hold at release — see the gate's
    // own note: a dispatch this batch queued behind may have timed out and armed one, and
    // replaying behind a request still in the air is the reordering the barrier exists to stop.
    // Order within the batch is user order and the batch must not be interleaved with a
    // `mutate` or a `flushPending` — a fresh verb landing between two
    // replayed ones can commit first and be overwritten when the older one lands, which is
    // user-always-wins violated in exactly the window nobody watches. This road was the last one
    // outside the gate; `replayActive` was its private stand-in, and a private stand-in only
    // serializes the callers that know about it.
    return this.outboxGate(() => this.replayOutboxInner());
  }

  protected async replayOutboxInner(): Promise<void> {
    // Release-time re-read. Skipping is right here for the same reason it is at the top: the
    // drive goes on to its drain, and the queue keeps everything in order for the drive after.
    if (this.outboxHold) return;
    // Every RESTORED entry (its owner died with its session), plus every same-session entry
    // whose result nobody routes — see {@link OhmailEngine.ownerSettled} for the two families
    // that stay with `flushPending()`.
    // `nextAt` is the backoff gate: a verb the server already refused waits out its delay instead
    // of being retried on every drive. Filtered here rather than inside `dispatch` so a waiting
    // verb never leaves the queue at all — it keeps its place in user order for the drive that
    // does take it, and nothing downstream has to know it was skipped.
    const ready = this.now().getTime();
    const batch = this.queue
      .filter((p) => (p.nextAt ?? 0) <= ready)
      .filter((p) => p.restored === true || !OhmailEngine.ownerSettled(p.mutation))
      .sort(byAtN);
    if (batch.length === 0) return;
    // The batch stays on the queue until each entry's own turn — see {@link takeTurn}.
    // Serial and awaited: order is user order, and the drain below must not begin until every
    // replayed POST has returned (that happens-before is what lets it carry their echoes). A
    // retryable failure re-queues onto the queue for the NEXT drive — `dispatch` never throws,
    // so one dead verb cannot stall the drain behind it. Each attempt is DEADLINE-BOUNDED —
    // the adapter's mutate has no timeout of its own, and one half-open request awaited here
    // would otherwise hold the single-flight forever: no bootstrap, no sync, for the whole
    // session. The in-flight dispatch still OWNS its timed-out entry (it settles it, re-queues
    // it, or leaves it persisted for the next boot), so the verb is never double-run and never
    // dropped.
    for (const p of batch) {
      if (this.outboxHold) return;
      if (this.takeTurn(p) === "gone") continue;
      // ONE ROAD. This loop used to hand-roll the deadline, the barrier and the hold, which is
      // how `retryAbandoned` came to be the road WITHOUT a deadline: the code that had one was
      // not reusable, so the third caller re-derived a subset of it. It is the same method now.
      // The drive's own drain follows this batch and carries every echo, so the reconcile this
      // dispatch defers is deliberately DROPPED rather than issued — one drain, not two. That is
      // the whole reason the deferred mode exists, and it is why `owed` is ignored here alone.
      const { timedOut, held, result } = await this.dispatchOnLane(p);
      /**
       * The replay's answer is kept, exactly as a late answer is. This loop used to throw the RESULT away, and for a
       * restored entry that result is the only thing anyone will ever know: its owner died with the previous session.
       * For a send that is a second delivery — press Send before the first autosave, lose the response, reload: the
       * replay delivers it, drops the `sent` answer and the `entityId`, the create gate opens, the next pause writes
       * a second row, and an edit un-matches the fingerprint so Send goes out under a fresh key. `lateResults` is
       * where an answer with no waiting caller belongs (the timeout path writes exactly this) and `flushPending()` is
       * its single destructive reader; the two writers are mutually exclusive per call.
       */

      /**
       * ONLY a settled answer: a `queued` result is the ABSENCE of an answer — the entry went back on the outbox —
       * and keeping it poisons the reader (measured: a 410 mid-drive test read the stale `queued` as the flush's
       * verdict; one level out, the compose adoption would settle a message on a send that has not settled — the
       * false "Sent." this seam prevents).
       */
      if (result !== null && result.status !== "queued" && result.status !== "superseded") {
        this.lateResults.set(p.id, result);
        this.notify();
      }
      if (held) {
        // A hold armed while this batch ran. This entry goes back and the rest never left, in
        // user order for the drive after; reads are never hostage to a write.
        this.queue.push(p);
        this.queue.sort(byAtN);
        return;
      }
      if (timedOut) {
        // ORDER IS THE CONTRACT, so a timeout stops the BATCH, not just the wait: the hung
        // request may yet commit, and dispatching the entries behind it would let a newer write
        // land before an older one. The rest are still on the queue with their stamps, and
        // `dispatchWithDeadline` armed {@link outboxHold}, so no road dispatches until it
        // settles. This drive still proceeds to its drain.
        return;
      }
    }
  }

  /**
   * Re-arm the durable outbox from the mirror store — the restart half of the contract. Reads every persisted {@link
   * PersistedOutboxEntry}, restores the queue in `(at, n)` order, and re-applies each verb's overlay so the BOOT
   * RENDER already carries the user's un-sent intents (INSTANT-ARCH §8 stage 1). Synchronous on purpose: everything
   * it reads is in memory once the store has loaded. Idempotent via a latch, called from three places so every
   * construction order is covered: `hydrate` (the webapp path), `drive` (an engine never hydrated), and directly by a
   * host that loaded the store first (the mobile boot) — a drive on an unloaded store latches over an empty set; the
   * entries replay next boot.
   */

  /**
   * An entry whose shape this build does not recognise is left in place, not replayed — it waits for a build that
   * understands it; an entry whose overlay cannot be recomputed (target pruned from a windowed mirror) still REPLAYS
   * — only the local paint is skipped.
   */
  restoreOutbox(): void {
    // Calling this IS the statement that the store was loaded first, so it also arms the drive's
    // own door — a host that loaded and restored has nothing left for `restoreOutboxIfLoaded` to
    // wait on.
    this.storeLoaded = true;
    /**
     * THE HOST'S STATEMENT THAT IT LOADED FIRST. Calling this latches the restore, so a caller
     * that has not loaded the store latches over an empty one and the previous session's verbs
     * are never replayed. `hydrate()` and the mobile boot both load before they call it; the
     * DRIVE does not, which is why the drive uses {@link restoreOutboxIfLoaded} instead.
     */
    this.restoreOutboxOnce();
  }

  /**
   * TRUE ONCE THE PREVIOUS SESSION'S OUTBOX IS ON THE QUEUE. From then on a send key that is not
   * queued, on the wire or on the durable outbox is not pending; before it nobody can say, and a
   * surface holding a composer for such a send keeps holding it.
   */
  outboxKnown(): boolean {
    return this.outboxRestored;
  }

  /**
   * THE DRIVE'S DOOR: a no-op that does NOT latch until the store is known to be loaded. `drive()` is reachable from
   * `mutate → dispatch → syncFresh` before `hydrate()` resolves. It used to call the latching version, so a mutation
   * made in the first moments of a session could latch the restore over an unloaded store — and every verb the
   * previous session left on disk was then never replayed for the whole session. The verbs were durable, present, and
   * ignored. Not latching is the safe half: the worst case is that the restore happens on the next drive instead of
   * this one, which costs one cycle. Latching early costs a session.
   */
  protected restoreOutboxIfLoaded(): void {
    if (!this.outboxLoadable()) return;
    this.restoreOutboxOnce();
  }

  /** True once the store is loaded — by `hydrate()` resolving, or by a host that loaded it. */
  protected outboxLoadable(): boolean {
    return this.storeLoaded;
  }

  protected restoreOutboxOnce(): void {
    if (this.outboxRestored) return;
    this.outboxRestored = true;

    const rows = this.store.entries<unknown>(OUTBOX_TYPE)
      .map((e) => e.entity)
      .filter(isPersistedOutboxEntry)
      .sort((a, b) => (a.at - b.at) || (a.n - b.n));
    if (rows.length === 0) return;
    let restored = false;
    const ownership = this.ownershipOn();
    for (const e of rows) {
      /* ANOTHER ENGINE'S ROW STAYS ON DISK: its owner sends it, and this engine reads it there. A
         row whose owner's lock is gone is adopted by a drive (`adoptOrphanedOutbox`), once. */
      if (ownership && typeof e.owner === "string" && e.owner !== this.ownerName) continue;
      if (this.restoreEntry(e)) restored = true;
    }
    /**
     * A VERB IN BOTH COLLECTIONS IS A CRASH RESIDUE, AND THE LIVE ROW WINS. `abandon()` writes the abandoned record
     * before deleting the outbox one, so a kill between the two leaves both. The pair is not self-resolving: a later
     * replay success deletes only the live copy and leaves a false "could not be saved" row, and Discard deletes only
     * the abandoned copy while the live verb goes on to execute — a person told it was thrown away, watching it land.
     * Resolved here, at boot, where both collections are in hand: anything still queued is by definition not
     * abandoned, so the abandoned twin is the stale one and goes. The other order would delete work that is about to
     * be retried.
     */
    const queuedIds = new Set(this.queue.map((q) => q.id));
    for (const row of this.store.entries<unknown>(OUTBOX_ABANDONED_TYPE)) {
      if (!queuedIds.has(row.id)) continue;
      void this.store.commitLocal([], [{ type: OUTBOX_ABANDONED_TYPE, id: row.id }])
        .catch(() => { /* best-effort; the next boot tries again */ });
    }
    if (!restored) return;
    // Restored entries must replay in their (at, n) order even when a same-session verb was
    // queued before this ran — a retryable failure milliseconds after boot is older than
    // nothing. The sort is total because every stamp came from the same monotonic pair.
    this.queue.sort((a, b) => (a.at - b.at) || (a.n - b.n));
    this.overlayRev++;
    this.notify();
  }

  /**
   * Paint the restored verbs {@link unpaintedRestored} names, once their rows are in the mirror.
   * Only a verb still QUEUED is painted: one already dispatched owns its own overlay, and one that
   * settled has none to show. At the verb's own moment, as the restore paints it. True when any
   * overlay moved.
   */
  /**
   * ONE STORED ENTRY INTO THE QUEUE — the boot restore's body, and an adoption's ({@link adoptOrphanedOutbox}). `true`
   * when it was queued; a withdrawn, already-held or expired entry is settled here and answers `false`.
   */
  protected restoreEntry(e: PersistedOutboxEntry): boolean {
    this.outboxSeq = Math.max(this.outboxSeq, e.n + 1);
    /**
     * A WITHDRAWN ROW IS NEVER REPLAYED. Cancel marked it before the composer closed, the mark
     * is what survives the restart, and this boot drops the row rather than queueing it — the
     * person cancelled that send, so no later session may deliver it.
     */
    if (e.withdrawn === true) {
      // A CANCEL THE SERVER NEVER ANSWERED is asked again, never sent and never dropped unanswered.
      if (e.withdrawOwed === true && e.mutation.kind === "mail_send") {
        this.withdrawnKeys.add(e.key);
        this.owedWithdraws.set(e.id, {
          id: e.id, key: e.key, mutation: e.mutation, at: e.at, n: e.n, restored: true, withdrawOwed: true,
          attempts: e.attempts ?? 0, ...(e.nextAt !== undefined ? { nextAt: e.nextAt } : {}),
          ...(persistedWired(e) ? { wired: true as const } : {}),
          ...(isCreatedRow(e.createdRow) ? { createdRow: e.createdRow } : {}),
          ...(this.ownerName !== null ? { owner: this.ownerName } : {}),
        });
        return false;
      }
      this.sayEnded(e, "withdrawn");
      void this.dropOutbox(e.id);
      return false;
    }
    /**
     * AN ENTRY THIS SESSION IS ALREADY HANDLING IS NOT A RESTART'S ENTRY. The latch does not guarantee this method
     * runs before the first mutation: an engine driven without ever hydrating reaches here through its first drive,
     * and that drive can be the very `syncFresh` a confirmed mutation just issued — at which point that mutation's
     * entry is still on disk (its terminal cleanup runs after the drive starts) and re-queueing it would dispatch
     * the SAME verb twice in one session. Every live mutation holds either its overlay (in flight, or awaiting its
     * echo) or a queue slot (retryable), so those two are the skip. An entry skipped here that then fails its
     * cleanup simply replays next session, idempotently — the safe direction.
     */
    if (this.overlays.has(e.id) || this.queue.some((q) => q.id === e.id)) return false;
    /**
     * AN UNKEYED CREATE PAST THE SERVER'S DEDUPE HORIZON IS NOT REPLAYED. The server's idempotency records live
     * 24 h (`idempotency_keys.expires_at`); within that window every replay is exact. Past it, the state verbs still
     * converge on their own (absolute values, unique names, permanent send reservations) and keep replaying at any
     * age — but a `rule_create` has no uniqueness constraint and a compose's first `draft_save` mints a fresh row,
     * so replaying one after a day-plus-dead app mints a duplicate. Nor is it deleted in silence: it may hold the
     * only copy of what somebody wrote, so it moves to the abandoned list saying why, and the person discards it.
     */
    // The same predicate `retryAbandoned` applies — see {@link pastCreateDedupe}. It was two
    // copies of one rule for as long as there was only one caller.
    if (pastCreateDedupe(e, this.now().getTime())) {
      void this.expireAtRestore(e);
      return false;
    }
    try {
      // The verb's OWN moment, not the restart's: a leave-commit restored the next morning
      // must not stamp its waterline (or any optimistic `updatedAt`) with boot time — the
      // effects are rebuilt under the clock the verb was expressed at.
      const asExpressed = () => new Date(e.at);
      const effects = this.paintOf(e.mutation, e.key, asExpressed);
      if (effects.length > 0) this.overlays.set(e.id, effects);
      else this.unpaintedRestored.add(e.id);
    } catch { /* a malformed or out-of-vocabulary mutation paints nothing; the wire decides */ }
    this.queue.push({
      id: e.id, key: e.key, mutation: e.mutation, at: e.at, n: e.n, restored: true,
      // A `v: 1` record carries none of these; `?? 0` is what makes it a valid `v: 2` in memory
      // and gives it the full ceiling rather than retiring it on arrival.
      attempts: e.attempts ?? 0,
      ...(e.nextAt !== undefined ? { nextAt: e.nextAt } : {}),
      // THE WHOLE POINT OF PERSISTING IT: this replay runs through a FRESH adapter, whose own
      // memory of the unreadable create is gone. Without this the replay re-POSTs the create.
      ...(e.createAttempted === true ? { createAttempted: true } : {}),
      ...(e.mutation.kind === "mail_send" && isCreatedRow(e.createdRow) ? { createdRow: e.createdRow } : {}),
      // A released intent stays on the row as a record and never rides a replay's confirmation.
      ...(e.released === true ? { released: true as const } : andDoneOf(e)),
      ...(e.confirmed === true ? { confirmed: true as const } : {}),
      ...(persistedWired(e) ? { wired: true as const } : {}),
      /**
       * A `v: 2` RECORD WITH A WAIT AND NO FLAG IS READ AS SERVER-NAMED. `waitIsServerNamed` was added to the `v:
       * 2` shape in place, so records written before it can carry a `nextAt` that came from a `Retry-After` and no
       * way to say so. Reading the absent flag as `false` makes the explicit-flush path ignore an interval the
       * SERVER chose — the one wait this client has no right to override. So the ambiguity resolves toward
       * obedience: a `v: 2` record that has a wait is assumed to have been told to wait. `v: 1` had no `nextAt` at
       * all and is unaffected; `v: 3` always carries the flag explicitly, which is what the version bump is for.
       */
      ...(e.waitIsServerNamed !== undefined
        ? { waitIsServerNamed: e.waitIsServerNamed }
        : (e.v === 2 && e.nextAt !== undefined ? { waitIsServerNamed: true } : {})),
      ...(e.lastError !== undefined ? { lastError: e.lastError } : {}),
      // This engine replays it now, so a later adopter asks about THIS engine's lock.
      ...(this.ownerName !== null ? { owner: this.ownerName } : {}),
    });
    return true;
  }

  /**
   * THIS ENGINE'S LOCK, held for its whole life: the lock's name is the `owner` field every entry it writes carries, and the
   * browser drops the lock when the tab goes — which is what tells another tab the entries are orphaned. Only over a
   * store other engines share; the name is recorded once the lock is GRANTED, never before.
   */
  protected holdOwnerLock(): void {
    if (!this.ownershipOn() || this.locks === null) return;
    const name = `ohmail.engine.${this.store.sharedDiskName!()}.${this.uuid()}`;
    void this.locks.request(name, { mode: "exclusive" }, () => {
      if (this.disposed) return Promise.resolve();
      this.ownerName = name;
      // Held until the tab goes, or until this engine is disposed inside a live page.
      return new Promise<void>((release) => { this.releaseOwnerLock = release; });
    }).catch(() => { this.ownerName = null; });
  }

  /**
   * AN ENGINE A LIVE PAGE REPLACES LETS GO OF ITS ROWS: its owner lock is released, so another engine
   * adopts what this one left, and this one stops following the disk. Idempotent; nothing else stops.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.partLane.dropAll();
    this.partReasksDue.clear();
    this.unlistenDisk?.();
    this.unlistenDisk = null;
    this.notices = null;
    this.releaseOwnerLock?.();
    this.releaseOwnerLock = null;
  }

  /**
   * ONE OWNER PER ROW is on: Web Locks to ask, a disk other engines share, and adoption over it. Off
   * (the phone, the desktop window, a browser without Web Locks): every row is this engine's, as before.
   */
  protected ownershipOn(): boolean {
    return this.locks !== null && (this.store.sharedDiskName?.() ?? null) !== null
      && typeof this.store.adoptOrphanedOutbox === "function";
  }

  /**
   * THE OTHER WINDOWS' WRITES REACH THIS ONE: a `changed` notice re-reads the outbox from disk, a
   * `withdraw` says another window's Cancel won a row this engine owns, `ended` how a send ended.
   */
  protected listenToDisk(): void {
    if (!this.ownershipOn()) return;
    const bus = this.store.outboxNotices?.() ?? null;
    if (bus === null) return;
    this.notices = bus;
    this.unlistenDisk = bus.listen((n) => { void this.heard(n); });
  }

  protected async heard(n: OutboxNotice): Promise<void> {
    if (n.t === "changed") return this.followDisk();
    if (n.t === "ended") {
      this.foreignEndings.delete(n.key);
      this.foreignEndings.set(n.key, n.how);
      if (this.foreignEndings.size > 256) this.foreignEndings.delete(this.foreignEndings.keys().next().value!);
      return;
    }
    /* `withdraw`: another window's mark already won on disk. A row this engine holds queued is ended
       here at once, so its surface closes; one on its way meets the mark at its claim. */
    if (this.queue.some((p) => p.key === n.key)) {
      // The viewer posts only after the server answered; a notice with no answer is an older build's.
      await this.withdrawQueued(n.key, { askedElsewhere: true, ...(n.outcome === "withdrawn" ? { answered: "withdrawn" as const } : {}) });
    }
  }

  /** The ids whose memory is newer than the disk: this engine's queue, wire and overlays. */
  protected heldIds(): ReadonlySet<string> {
    return new Set<string>([
      ...this.overlays.keys(), ...this.queue.map((q) => q.id), ...this.inFlight.keys(), ...this.owedWithdraws.keys(),
    ]);
  }

  /** One re-read at a time; a notice heard during one asks for one more after it. */
  protected async followDisk(): Promise<void> {
    if (!this.storeLoaded || typeof this.store.refreshOutbox !== "function") return;
    if (this.following !== null) { this.followAgain = true; return this.following; }
    this.following = (async () => {
      do {
        this.followAgain = false;
        const moved = await this.store.refreshOutbox!(() => this.heldIds()).catch(() => false);
        if (moved) this.notify();
      } while (this.followAgain);
    })().finally(() => { this.following = null; });
    return this.following;
  }

  /**
   * HOW ANOTHER WINDOW'S SEND ENDED, as its owner said before dropping the row: `undefined` when
   * nobody said (the owning window closed first, or this one opened after). Read by a surface that saw
   * the row leave the outbox and must not take a cancellation or a refusal for a delivery.
   */
  foreignSendEnding(key: string): "confirmed" | "refused" | "withdrawn" | undefined {
    return this.foreignEndings.get(key);
  }

  /**
   * Say how a send this engine owns ended, before its row is dropped, so the order holds: a window
   * that never hears an ending takes the row's leaving as nothing, never as a delivery.
   */
  protected sayEnded(p: { key: string; mutation: { kind: string } }, how: "confirmed" | "refused" | "withdrawn"): void {
    if (p.mutation.kind === "mail_send") this.notices?.post({ t: "ended", key: p.key, how });
  }

  /** {@link sayEnded} for a row known by id only: a confirmed verb the drain retires. */
  protected sayEndedRow(id: string, how: "confirmed" | "refused" | "withdrawn"): void {
    const row = this.store.get<unknown>(OUTBOX_TYPE, id);
    if (isPersistedOutboxEntry(row)) this.sayEnded(row, how);
  }

  /**
   * ANOTHER WINDOW'S WAITING SEND THAT THIS WINDOW MAY NOT CANCEL: its row comes from an older build,
   * whose owner does not claim the row before the wire, so a mark here could not stop it.
   */
  foreignCancelRefused(key: string): boolean {
    if (!this.ownershipOn()) return false;
    return this.store.entries<unknown>(OUTBOX_TYPE).map((e) => e.entity).filter(isPersistedOutboxEntry)
      .some((e) => e.key === key && typeof e.owner === "string" && e.owner !== this.ownerName
        && e.withdrawn !== true && e.confirmed !== true && e.protocol !== OUTBOX_PROTOCOL);
  }

  /**
   * A VERB A CLOSED TAB LEFT IS DELIVERED BY A LIVE ONE, ONCE. Every entry naming an owner whose lock is no longer held
   * is adopted by a compare-and-set inside one store transaction (so of two tabs adopting at once, one takes it) and
   * queued like a restored entry. A live owner's entry, an entry naming no owner, and every entry when this engine
   * cannot ask about locks are left alone. At the head of every drive, and after a 410 re-bootstrap.
   */
  protected async adoptOrphanedOutbox(): Promise<void> {
    const me = this.ownerName;
    if (me === null || this.locks === null || !this.outboxLoadable() || typeof this.store.adoptOrphanedOutbox !== "function") return;
    let live: Set<string>;
    try {
      const held = (await this.locks.query()).held ?? [];
      live = new Set(held.map((h) => h.name).filter((n): n is string => typeof n === "string"));
    } catch { return; }
    const mine = new Set<string>([...this.overlays.keys(), ...this.queue.map((q) => q.id), ...this.inFlight.keys()]);
    const taken = await this.store.adoptOrphanedOutbox(me, live, mine).catch(() => [] as unknown[]);
    let restored = false;
    for (const e of taken) if (isPersistedOutboxEntry(e) && this.restoreEntry(e)) restored = true;
    if (!restored) return;
    this.queue.sort((a, b) => (a.at - b.at) || (a.n - b.n));
    this.overlayRev++;
    this.notify();
  }

  protected repaintRestored(): boolean {
    let moved = false;
    for (const id of [...this.unpaintedRestored]) {
      const q = this.queue.find((p) => p.id === id);
      if (!q || this.overlays.has(id)) { this.unpaintedRestored.delete(id); continue; }
      try {
        const effects = this.paintOf(q.mutation, q.key, () => new Date(q.at));
        if (effects.length === 0) continue;
        this.overlays.set(id, effects);
        moved = true;
      } catch { /* paints nothing, as at the restore */ }
      this.unpaintedRestored.delete(id);
    }
    return moved;
  }

  /**
   * ONE NOTIFY PER DRAIN STEP. A poll's page, what its settle retires and the freshness stamp
   * reach a subscriber as one notify, so no snapshot holds rows without their stamp; a backlog
   * still publishes once per {@link BACKLOG_PUBLISH_PAGES}. Rows applied and not yet published
   * go out on a throw too: a drain that stops early is never silent.
   */
  protected async drainPublishing(): Promise<void> {
    const owed = { rows: false };
    try {
      await this.drain(owed);
    } catch (err) {
      if (owed.rows) this.notify();
      throw err;
    }
  }

  /**
   * ONE DRAIN PAGE, BELTED — see {@link DRAIN_REQUEST_CEILING_MS}. A race and nothing more: no signal
   * reaches the request, and the loser's rejection is swallowed. The timeout is retryable, so the
   * drive fails as a drain does and the scheduler counts it.
   */
  protected async readCeiling<T>(read: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    read.catch(() => { /* the loser of the race has no reader */ });
    const ceiling = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(noAnswerWithin(this.drainCeilingMs)), this.drainCeilingMs);
    });
    try {
      return await Promise.race([read, ceiling]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  protected async drain(owed: { rows: boolean }): Promise<void> {
    const publish = (): void => { owed.rows = false; this.notify(); };
    /**
     * This drain's epoch — the other half of {@link awaitingEcho}'s happens-before. Stamped
     * BEFORE the first page is requested, so "registered epoch < this epoch" means the POST
     * returned before this drain read the log, and this drain's success therefore proves the
     * echo is applied. See {@link OhmailEngine.sweepAwaitingEcho} at the successful exit.
     */
    const epoch = ++this.drainEpoch;
    let rebootstrapped = false;
    /** Pages this drain consumed — read at the settle by {@link OhmailEngine.prefetchRecentBodies}. */
    let pagesThisDrain = 0;
    // The rules-first pass runs AT MOST ONCE per drain (re-owed by the 410 reset below): the
    // completion stamp only lands when the whole drain settles, so without this latch every page
    // of a multi-page first drain would re-open with a redundant rules request.
    let rulesFirstDone = false;
    // A STALE resume converges its newest page FIRST — see the method for the whole argument.
    // Before the loop, once per drain: the 410 branch re-enters the loop with a wiped mirror,
    // where the bootstrap snapshot below already owns "newest first".
    //
    // The staleness verdict is read ONCE, before the freshen (a completed freshen changes no
    // stamp, but reading per page would let the loop's own completion flip the answer mid-
    // drain), and it selects the page size for the WHOLE drain: a stale resume is a backlog
    // catch-up and asks for {@link BACKLOG_PAGE_LIMIT} rows per page — see the constant for the
    // measured arithmetic. An explicit {@link EngineOptions.syncLimit} always wins (the test
    // seam), and a fresh resume keeps the server's default page, the deployed shape.
    const staleResume = this.isStaleResume();
    // AFTER A REFUSED SNAPSHOT CURSOR, until a pull is accepted, the freshen and the tail walk are
    // not read: both are snapshot reads over a mirror that IS the refused snapshot, and the drain
    // stamp they key on is never written while every drain fails. The walk stays owed (the latch).
    const refused = this.snapshotCursorRefusals > 0;
    if (!refused) await this.freshenStaleResume();
    this.policyWalkFailed = refused;
    if (!refused) await this.rehydrateForPolicy();
    for (;;) {
      // COLD MIRROR + A SNAPSHOT ROUTE ⇒ TAKE THE SNAPSHOT INSTEAD OF REPLAYING THE LOG.
      //
      // This is the ONE place the condition is written, and it is reached by all three callers
      // that can present a cursor of "0": a first-ever `start()`, a `start()` over a mirror whose
      // last bootstrap crashed before its final page, and the 410 branch below — which resets to
      // "0" and `continue`s straight back here. See {@link OhmailEngine.runSnapshot}.
      // A NON-ZERO CURSOR ON A MIRROR THAT HAS NEVER COMPLETED A DRAIN is an interrupted
      // bootstrap resuming — an earlier session's `since=0` fallback (or post-snapshot catch-up)
      // committed some pages and died. Read BEFORE the snapshot check, because a successful
      // snapshot moves the cursor off "0" in this very iteration and must not read as a resume.
      const resumedIncomplete = this.store.getCursor() !== "0"
        && this.store.getMeta<string>(LAST_DRAIN_AT_META) === undefined;

      // TRUE WHEN THIS ITERATION'S SNAPSHOT COMMITTED THE CURSOR THE PULL BELOW PRESENTS — the
      // one cursor a door has no reason to refuse. See the 410 arm.
      const snapshotIssued = this.store.getCursor() === "0" && this.snapshotFn !== null
        && await this.runSnapshot();

      // Rules before mail, on the degraded bootstrap. The snapshot path delivers the whole rule set in page 1 ("a
      // partial rule set is worse than none"), so a mid-bootstrap render never sees a message whose sender's decision
      // is missing; the `since=0` replay interleaves by seq, so a sender decided AFTER their mail arrived replays
      // mail-first and the consent cutline reads the absent rule as "undecided" — an already-screened sender in the
      // Screener until the replay catches up. Unknown is not undecided, so the fallback drains the rule type to its
      // horizon first, rows only (the cursor stays put; the per-entity seq guard absorbs the repeat).

      // Two ways in: a cold mirror whose snapshot failed page 1, and a resumed incomplete bootstrap, where the
      // committed pages may hold mail whose rule sits beyond the interruption (with a healthy route
      // `freshenStaleResume()` already applied page 1; this arm is the degraded completion plus the belt for a
      // freshen that failed). Deliberately NOT before `hydrate()`: holding the offline-first paint on a network drain
      // trades a bounded interim state for a blank screen on a dead network. Gated on a snapshot route EXISTING: the
      // route-less adapters are the demo (never partitioned) and servers that no longer exist.
      let resp;
      try {
        // INSIDE the try, deliberately: a later prefetch page can 410 exactly as the delta can
        // (the horizon moves), and the recovery is the same one — reset, re-enter as a bootstrap.
        // Not after a refused snapshot cursor: that mirror is a COMPLETE snapshot, rules and all,
        // which only reads as an interrupted bootstrap because no drain has settled since.
        if (this.snapshotFn && !rulesFirstDone && !refused
            && (resumedIncomplete || (this.store.getCursor() === "0" && this.snapshotUnavailable))) {
          rulesFirstDone = true;
          await this.drainRulesFirst();
        }
        // The dense-page ask covers the RESUMED-incomplete-bootstrap replay too — that is a
        // backlog by definition (an earlier session's since=0 fallback died mid-log), and it is
        // read fresh per iteration because the 410 branch can turn a stale resume INTO one.
        const backlogLimit = this.syncLimit !== undefined
          ? this.syncLimit
          : drainPageLimit(staleResume || resumedIncomplete, undefined);
        resp = await this.readCeiling(this.adapter.sync({
          since: this.store.getCursor(),
          ...(backlogLimit !== undefined ? { limit: backlogLimit } : {}),
          ...(this.types ? { types: this.types } : {}),
        }));
      } catch (err) {
        if (err instanceof CursorExpiredError) {
          const at = this.now().getTime();
          if (snapshotIssued) {
            // THE DOOR REFUSED THE CURSOR ITS OWN SNAPSHOT JUST ISSUED. A second wipe and snapshot
            // would be refused the same way, so the snapshot's rows stay, the defect is surfaced by
            // name, and no re-snapshot is taken until the hold ends (doubling, capped).
            this.snapshotCursorRefusals += 1;
            this.resnapshotHeldUntilMs = at + Math.min(
              SNAPSHOT_REFUSAL_HOLD_BASE_MS * 2 ** (this.snapshotCursorRefusals - 1),
              SNAPSHOT_REFUSAL_HOLD_CAP_MS,
            );
            throw new SnapshotCursorRefusedError();
          }
          if (at < this.resnapshotHeldUntilMs) throw new SnapshotCursorRefusedError();
        }
        if (err instanceof CursorExpiredError && !rebootstrapped) {
          // The once-per-drain guard stays exactly as it was: a SECOND 410 inside one drain is a
          // server that expires the cursor it just issued, and is surfaced rather than looped on.
          // It bounds the snapshot path too — at most one snapshot can follow a 410 per drain.
          rebootstrapped = true;
          // THE SEQ-0 ROWS RIDE THROUGH THE WIPE, and the STORE is what carries them: it
          // partitions them in `resetForBootstrap` and re-writes them inside the wipe's own
          // transaction. This used to be a snapshot here, a wipe, and a one-by-one write-back —
          // a durable zero-row window in which a kill, or one refused re-put, lost every queued
          // verb and every abandoned record. It was also a second writer of a rule the store
          // already owned for the cross-tab case.
          await this.store.resetForBootstrap(); // cursor → "0"
          // The wipe re-put every carried row on disk, a closed tab's among them: adopt what is orphaned.
          await this.adoptOrphanedOutbox();
          // The wipe took the held-release answer too; the settle's bell asks for it again.
          this.heldRelease.owed = true;
          // …and the queue's page: withheld until the store speaks again, asked now rather than at the
          // rebuild's settle, or each rebuilt page of gate mail would count as the queue (6, 7, 8).
          this.screenerWait.dirty = true;
          if (this.screenerWait.armed) {
            this.screenerWait.settled = false;
            this.reaskScreenerWaiting();
          }
          // The instant index is an index of the mail that just went. A build walking the old
          // rows would install it over the new mirror and hand back hits that open nothing.
          this.invalidateSearchIndex();
          this.storePages.clear();
          // The wipe took the mail with it, so nothing has been received any more: every row comes
          // back over the wire and would otherwise be counted a second time. The wipe emptied meta
          // with it, so there is no written count left for the next boot to read back.
          await this.resetReceived();
          // …and the recorded Sent folders, which came from the mailbox read and not from the log.
          this.stateSentFolders(this.statedSentFolders());
          // The wipe took the rules with it — the re-bootstrap owes the rules-first pass again.
          rulesFirstDone = false;
          publish();
          // Back to the top: with a snapshot route the cursor of "0" selects the snapshot and the
          // delta drain then resumes from `asOfSeq`; without one it selects `since=0`, which is
          // the pre-snapshot path and still converges. The fallback is not dead code — it is what
          // the FixturesAdapter and any adapter older than this route take.
          continue;
        }
        throw err;
      }
      // An accepted page ends any hold: the door takes this mirror's cursor again.
      this.snapshotCursorRefusals = 0;
      this.resnapshotHeldUntilMs = 0;
      // READ THE HIGH-WATER BEFORE THE PAGE LANDS — it is the grace bound below, and one line
      // later it is gone.
      const highBefore = this.store.maxSeq();
      pagesThisDrain += 1;
      const flat = flattenResponse(resp);
      // Before the rows, which tombstone the mailbox the receipt names.
      await this.noteRemovalOwesRefill(flat);
      this.dropRemovedSentFolders(flat);
      this.noteApplied(flat);
      owed.rows = true;
      await this.store.applyResponse(resp);
      // AFTER THE ROWS, NEVER BEFORE. A kill between the two leaves the written count BEHIND the
      // mirror, which the consumer's floor absorbs; the other order leaves it AHEAD, and the rows
      // that never landed come back over the wire and are counted a second time.
      await this.persistReceived();
      if (resp.hasMore) {
        // A PRUNE PER BACKLOG PAGE, so the mirror never grows past the window on the way in. The
        // peak of a first import used to be the size of the MAILBOX — every row of it, and 254
        // whole-mirror derivations before a single eviction, measured. `highBefore` is the grace —
        // see {@link pruneToPolicy}. One notify for the apply and the prune together: they are one
        // change to the mirror as far as any reader is concerned, and two is two derivations.
        await this.pruneToPolicy(highBefore);
        // AND ONE PUBLISH PER {@link BACKLOG_PUBLISH_PAGES} OF THEM — see the constant. The settle
        // below always publishes, so the last rows never wait on this.
        if (pagesThisDrain % BACKLOG_PUBLISH_PAGES === 0) publish();
        continue;
      }
      // A drain that took more than one page was a CATCH-UP, not a poll — see
      // {@link OhmailEngine.prefetchRecentBodies}.
      this.caughtUpInOnePage = pagesThisDrain <= 1;
      // THIS DEVICE'S FIRST COMPLETED SYNC, once: the reading streams' anchor before any visit. The
      // last page has landed; written before the settle's pass, so an idle next drain derives nothing.
      if (this.store.get("view_meta", FEED_SINCE_ID) === undefined) {
        await this.store.putLocal("view_meta", FEED_SINCE_ID, { at: this.now().toISOString() } satisfies FeedSinceMeta);
      }

      // AND THE PASS AT THE SETTLE, ungraced, at the point the mirror is caught up and therefore
      // at its most complete — the last page's own rows are judged here and nowhere earlier. A
      // `full` policy returns immediately.
      // A removal's short window is refilled BEFORE the settle prune trims it back to the policy.
      await this.refillWindow();
      await this.pruneToPolicy();
      // A drain is the one thing that can deliver the REAL Sent row an optimistic copy is standing
      // in for — retire any copy the mirror now holds under the same header (or that has aged out),
      // so the conversation shows the ingested row alone rather than a duplicate.
      const before = this.optimisticSent.size;
      this.reconcileOptimisticSent();
      if (this.optimisticSent.size !== before) this.overlayRev++;
      if (this.repaintRestored()) this.overlayRev++;
      // THE DRAIN'S LAST WORD: this mirror was fully caught up at this moment, on this device's
      // own clock. Written at COMPLETION and nowhere earlier — a drain that fails or aborts
      // mid-backlog leaves the old stamp standing, so the next drain still reads as a stale
      // resume and freshens again (idempotent: the seq guard absorbs the repeat).
      await this.store.setMeta(LAST_DRAIN_AT_META, this.now().toISOString());
      // AND THE RETENTION GENERATION, at the same settle and under one condition: that nothing
      // this drain owed the mirror was left unfetched. A cold bootstrap owes nothing (the
      // snapshot walks the tail itself), a `full` mirror owes nothing, an adapter with no
      // snapshot route replays every row from seq 0 and owes nothing — each of those reaches
      // here with the latch down and is stamped once, for ever. Only a tail walk that failed
      // mid-flight leaves it up, and that mirror is owed the walk again on the next drain.
      if (!this.policyWalkFailed
          && this.store.getMeta<number>(STORE_POLICY_GENERATION_META) !== STORE_POLICY_GENERATION) {
        await this.store.setMeta(STORE_POLICY_GENERATION_META, STORE_POLICY_GENERATION);
      }
      // THE OVERLAY SWEEP, only on this successful exit: every overlay whose POST returned
      // before this drain began now has its echo IN the mirror, so retiring it changes what is
      // rendered from "the overlay's claim" to "the server's identical statement".
      this.sweepAwaitingEcho(epoch);
      this.drainsDone += 1;
      this.reaskInlineParts();
      this.settledEpoch = epoch;
      // THE SETTLE'S ONE PUBLISH, after the stamp {@link OhmailEngine.freshness} reads: the last
      // page, the prune, the retired copies and overlays and the stamp are one snapshot, never
      // the new rows under the old "as of". `one-notify-per-poll.test.ts` and
      // `freshness-label.test.ts` watch this line.
      publish();
      // The held-release offer re-asks when this drain moved the settings stamp or brought held mail.
      this.ringHeldReleaseBell();
      this.ringUnscreenedBell();
      // The queue's page re-asks when this drain touched the gate, a rule, the settings or a mailbox,
      // and at every settle while the page says the door's copy is behind: that is how this window
      // learns the copy has caught up ({@link queueStaysBehind}). That ask never supersedes one in the air.
      const queue = this.screenerWait;
      if (queue.armed && (queue.dirty || (queue.asking === 0 && this.queueBehind()))) this.reaskScreenerWaiting();
      return;
    }
  }

  /**
   * Retire every {@link awaitingEcho} overlay registered before the drain of `epoch` began.
   * A failed drain never reaches this (its `throw` propagates out of {@link drain}), which is
   * the whole point: the overlay survives any number of failed attempts and retires only on
   * proof. Entries registered DURING the drain (`registered === epoch`) stay — that drain read
   * the log before their POST committed and proves nothing about them.
   */
  protected sweepAwaitingEcho(epoch: number): void {
    let swept = false;
    for (const [overlayId, registered] of this.awaitingEcho) {
      if (registered.epoch >= epoch) continue;
      this.awaitingEcho.delete(overlayId);
      // The drain proves the log was read, not that this mirror shows the rows: those stay
      // masked until they agree (see `settleConfirmed`). A verb with no overlay (its target was
      // never in this mirror) settles at once. The durable entry goes with the overlay; one that
      // survives a refused delete replays idempotently, the safe direction.
      const had = this.overlays.has(overlayId);
      if (this.settleConfirmed(overlayId, registered.m, registered.shadow)) {
        this.sayEndedRow(overlayId, "confirmed");
        void this.dropOutbox(overlayId);
      }
      swept = had || swept;
    }
    swept = this.sweepShadows(epoch) || swept;
    swept = this.sweepKept() || swept;
    // No notify of its own: the drain's settle publishes right after, in the same snapshot.
    if (swept) this.overlayRev++;
  }

  /**
   * A CONFIRMED VERB'S ECHO IS IN — retire its overlay, unless the mirror still disagrees with a
   * row it moved: then only the rows the mirror or a History/Search page HOLDS stay masked (a
   * created entity has no stale copy to hide) and the verb waits in {@link shadows}. True when the overlay retired, and the
   * caller then drops the durable entry. The caller bumps the overlay rev. `shadow: false` for a
   * confirm naming `pendingWith`: the server took it and another install applies it, so the
   * mirror is right to disagree and the surface shows it decided-and-waiting instead.
   */
  protected settleConfirmed(id: string, m: EngineMutation, shadow = true): boolean {
    const effects = this.overlays.get(id);
    const held = (type: string, eid: string): boolean => this.store.record(type, eid) !== undefined
      || (type === "message" && this.storePages.find(eid) !== undefined);
    if (m.kind === "screener_decide" && effects) this.keepDecision(id, effects);
    const keys = effects && shadow ? shadowKeysOf(m, effects, held) : [];
    if (keys.length === 0 || shadowAgrees(keys, this.shadowTruth)) {
      this.shadows.delete(id);
      this.overlays.delete(id);
      return true;
    }
    this.overlays.set(id, effects!.filter((e) => held(e.type, e.id)));
    this.shadows.set(id, { keys, epoch: this.drainEpoch, drains: 0 });
    return false;
  }

  /**
   * Each drain that began after a shadow stood asks again: the rows agree ⇒ the mirror is the
   * truth; {@link SHADOW_DRAIN_BOUND} drains without agreement ⇒ the mirror is the truth anyway
   * (a no-op, a divergence, another device's later change). Returns whether anything retired.
   */
  protected sweepShadows(epoch: number): boolean {
    let retired = false;
    for (const [id, s] of this.shadows) {
      if (!this.overlays.has(id)) { this.shadows.delete(id); continue; }
      if (s.epoch >= epoch) continue;
      s.drains += 1;
      if (!shadowAgrees(s.keys, this.shadowTruth) && s.drains < SHADOW_DRAIN_BOUND) continue;
      this.shadows.delete(id);
      this.overlays.delete(id);
      this.sayEndedRow(id, "confirmed");
      void this.dropOutbox(id);
      retired = true;
    }
    return retired;
  }

  /**
   * A NEWER VERB ON A SHADOWED ROW replaces the shadow: its own overlay now carries the person's
   * latest word, and a shadow outliving it would re-mask the row with the older one (an Undo
   * shown undone). The older verb is confirmed, so its durable entry goes too.
   */
  protected retireShadowsUnder(effects: readonly MutationEffect[]): void {
    for (const [id, s] of this.shadows) {
      if (!s.keys.some((k) => effects.some((e) => e.type === k.type && e.id === k.id))) continue;
      this.shadows.delete(id);
      this.overlays.delete(id);
      this.sayEndedRow(id, "confirmed");
      void this.dropOutbox(id);
    }
    for (const [id, d] of this.kept) if (supersededBy(d, effects)) this.kept.delete(id);
  }

  /**
   * A CONFIRMED DECISION'S RULES OUTLIVE ITS OVERLAY until this copy holds them — see
   * {@link KeptDecision}. The shadow's drain bound cannot serve here: a lagging door passes three
   * drains in seconds while its copy is minutes behind. Skipped when a newer verb in flight already
   * speaks about the subject; the caller bumps the overlay rev.
   */
  protected keepDecision(id: string, effects: readonly MutationEffect[]): void {
    const record = (type: string, eid: string): boolean => this.store.record(type, eid) !== undefined;
    const d = keptDecisionOf(effects, this.storeTruth, this.screenerWait.seq, record);
    if (d === null) return;
    for (const [other, live] of this.overlays) if (other !== id && supersededBy(d, live)) return;
    this.kept.set(id, d);
  }

  /** Re-read every kept decision against the copy. True when one moved. */
  protected sweepKept(): boolean {
    if (this.kept.size === 0) return false;
    const record = (type: string, eid: string): boolean => this.store.record(type, eid) !== undefined;
    let moved = false;
    for (const [id, d] of this.kept) {
      const next = stillKept(d, this.storeTruth, record);
      if (next === d) continue;
      moved = true;
      if (next === null) this.kept.delete(id);
      else this.kept.set(id, next);
    }
    return moved;
  }

  /**
   * THE PROMOTED RULE TAKES THE SERVER'S ID AT THE CONFIRM, so the rules list, a kept decision and
   * the next verb on it all name the row the server holds. The created rule is the first rule
   * effect `derivedScreenerEffects` writes.
   */
  protected rekeyPromotedRule(overlayId: string, serverId: string): void {
    const effects = this.overlays.get(overlayId);
    const i = effects?.findIndex((e) => e.type === "rule" && e.entity !== null) ?? -1;
    if (!effects || i < 0 || effects[i]!.id === serverId) return;
    const e = effects[i]!;
    const next = [...effects];
    next[i] = { ...e, id: serverId, entity: { ...(e.entity as RuleDTO), id: serverId } };
    this.overlays.set(overlayId, next);
  }

  /**
   * Drain `?types=rule` from seq 0 to its horizon, ROWS ONLY — the `since=0` fallback's opening move (see the call
   * site in {@link OhmailEngine.drain} for the whole argument). The cursor is never touched: the main replay that
   * follows re-delivers every one of these changes at the same seqs and the per-entity guard skips them, so a crash
   * between the two passes costs nothing and converges exactly as a crashed bootstrap always has. A failure here is a
   * failure of the SAME wire the main drain is about to use, so it is left to propagate on the main drain's own path
   * rather than being swallowed into an unordered bootstrap — swallowing would silently reintroduce the
   * misclassification this exists to stop, in exactly the flaky conditions that made the fallback fire.
   */
  protected async drainRulesFirst(): Promise<void> {
    // An engine configured to sync a type list that excludes rules has no decisions to order.
    if (this.types && !this.types.includes("rule")) return;
    let since = "0";
    for (;;) {
      const resp = await this.readCeiling(this.adapter.sync({
        since,
        types: ["rule"],
        ...(this.syncLimit !== undefined ? { limit: this.syncLimit } : {}),
      }));
      this.noteApplied(flattenResponse(resp));
      await this.store.applyChanges(flattenResponse(resp));
      await this.persistReceived();
      since = resp.cursor;
      if (!resp.hasMore) break;
    }
    this.notify();
  }
}

/** The engine's class as this file's bodies name it: the statics they read are declared here. */
const OhmailEngine = EngineLifecycle;
