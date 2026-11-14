import { CASCADE_TYPES } from "../mirror-bounds.js";
import { winningStates } from "../selectors.js";
import type { EngineDraft, EngineMessage } from "../types.js";
import { RENDERED_PINS } from "./ceilings.js";
import type { WakeSignalSource } from "./options.js";
import { EngineReads } from "./reads.js";
import { messageTime, type PendingApproval, type PendingRoutingDecision } from "./server-wire.js";

export abstract class EngineWindowed extends EngineReads {
  // ── the windowed store: keeping only part of the mailbox on disk ─────────

  /**
   * Evict the messages this client has chosen not to keep; returns whether anything went. The
   * shape is {@link OhmailEngine.purgeProtectedBodies}'s: one pass computing a victim list, then
   * the store write. The rule: keep the newest `minRows` whatever their age (what stops a quiet
   * mailbox evicting itself down to an empty app); of the rest, keep anything newer than `days`
   * that is also among the newest `maxRows`; evict the remainder. The pin set overrides all three.
   */

  /**
   * IT RUNS PER BACKLOG PAGE AS WELL AS AT THE SETTLE, and `graceAbove` is what makes that sound.
   * Floor, ceiling and age are MONOTONE in the arriving set, so a row evictable at one page is
   * evictable at every later one: running early loses nothing. Only the PIN SET is non-monotone —
   * a message's pinning row can arrive after the message — and every server writer emits the two
   * within a few seqs, so excluding rows above the previous page's high-water covers the straddle.
   * Every other pin re-materializes: a `/sync` change carries the FULL DTO.
   */

  /**
   * Minus the pin set, which is the part that matters: a message the product is still USING must never be evicted for
   * being old — the thing referencing it renders from the mirror and would render a hole. Five references pin: a
   * surface currently RENDERING it (nothing in the mirror points at an open message — see {@link
   * OhmailEngine.pinnedMessageIds}); a `draft` replying to it (a reply-later draft outlives the window); a
   * `message_state` that is not `none` (every triage pile IS a set of these, and `bubbled_up` is a TIMER on an old
   * message — evicting it deletes the reminder); a `routing_decision` still `pending_approval`; and an `approval`
   * still `pending` — both unanswered questions, unanswerable without the mail. Anything resolved does NOT pin: it is
   * history, and history is what the window is for.
   */
  /**
   * AND AT THE SETTLE IT RUNS ONLY WHEN SOMETHING MOVED — everything below reads the whole mirror
   * and sorts it, so a settled client paid its own SIZE per poll to be told there was nothing to
   * evict. Its inputs are records plus the age term: {@link StoreReader.stampExcept} moves for
   * every record, {@link cutlineGen} for the age term. Bodies are excluded — evicted BY this pass,
   * never deciding it. The age term alone can open a gap with nothing written, and that is
   * deliberately not a reason to run: ageing only evicts MORE, an unwritten mirror is not growing,
   * and the next arrival, cutline answer and launch each run the pass. A backlog page
   * (`graceAbove`) is never skipped — that arm bounds the mirror on the way IN.
   */
  protected static readonly PRUNE_IGNORES: readonly string[] = ["message_body"];

  protected async pruneToPolicy(graceAbove?: number): Promise<boolean> {
    const policy = this.storePolicy;
    if (policy.mode !== "windowed") return false; // `full` — the default. Nothing is ever evicted.
    if (graceAbove === undefined
        && this.store.stampExcept(OhmailEngine.PRUNE_IGNORES) === this.prunedAtStamp
        && this.cutlineGen === this.prunedAtCutline) {
      return false;
    }
    /** Record what this pass ran over, AFTER its own writes — a prune moves the stamp itself. */
    const pruned = <T>(answer: T): T => {
      this.prunedAtStamp = this.store.stampExcept(OhmailEngine.PRUNE_IGNORES);
      this.prunedAtCutline = this.cutlineGen;
      return answer;
    };

    const rows = this.store.entries<EngineMessage>("message");
    if (rows.length <= policy.minRows) return pruned(false);

    // Newest first. `date` is the mail's own time and the order every pile renders in; a row
    // without one (or with an unparseable one) sorts oldest, but is still protected by the
    // minRows floor and by the pin set — it is never singled out.
    const sorted = [...rows].sort((a, b) => messageTime(b.entity) - messageTime(a.entity));
    // The WIDER of the policy's own `days` and the account's screening cutline — see
    // {@link OhmailEngine.setCutline} for why a mirror narrower than its cutline answers a
    // question the server answers differently.
    const cutoff = this.ageFloor(policy.days);
    const pinned = this.pinnedMessageIds();
    // The ceiling, in the same newest-first order the floor is counted in: beyond it a row goes
    // for being NUMEROUS rather than for being old, which is the half `days` alone cannot do.
    // Absent ⇒ Infinity ⇒ the pre-ceiling rule, unchanged, for every embedder that set no ceiling.
    const ceiling = policy.maxRows ?? Number.POSITIVE_INFINITY;

    const victims: Array<{ type: string; id: string }> = [];
    for (let i = policy.minRows; i < sorted.length; i++) {
      const row = sorted[i]!;
      if (i < ceiling && messageTime(row.entity) >= cutoff) continue;
      if (pinned.has(row.id)) continue;
      // THE ONE-PAGE GRACE. Nothing that arrived in the page just applied is evictable until a
      // later page has landed, so a pinning row that is one page behind its message still finds
      // it here.
      if (graceAbove !== undefined && row.seq > graceAbove) continue;
      victims.push({ type: "message", id: row.id });
    }
    if (victims.length === 0) return pruned(false);
    // EVERY ROW THAT NAMED AN EVICTED MESSAGE GOES WITH IT. See {@link cascadeVictims}. Appended one
    // by one, never spread: a first drain over a large mailbox lands the whole reachable mailbox
    // before this prune runs, so the cascade is tens of thousands of rows, and `push(...cascade)`
    // past the engine's argument ceiling threw `RangeError: Maximum call stack size exceeded` out of
    // every drain — the strip read "Sync failed. Retrying." for a whole session while every sync
    // succeeded (measured 2026-09-21).
    for (const v of this.cascadeVictims(victims, graceAbove)) victims.push(v);
    await this.store.prune(victims); // hard delete + the `message_body` cascade
    return pruned(true);
  }

  /**
   * THE CHILD ROWS OF THE MESSAGES THIS PASS IS EVICTING — threads, parks, settled routing
   * decisions and settled approvals. Evicting a message left each of them behind, so the
   * advertised window bounded the mail and not what hangs off it. Nothing is lost: `prune`
   * deletes rather than tombstones and a /sync change carries the FULL DTO.
   */
  /**
   * Only RESTING rows are reachable: a park that is not `none`, a `pending_approval` decision and
   * a `pending` approval each PIN their message, so a child worth keeping keeps its parent. An
   * approval with NO message is page-1 live state — the cascade follows a NAMED message, never
   * the absence of one.
   */
  protected cascadeVictims(
    messageVictims: ReadonlyArray<{ type: string; id: string }>,
    graceAbove?: number,
  ): Array<{ type: string; id: string }> {
    const evicted = new Set(messageVictims.map((v) => v.id));
    // THE SURVIVORS' THREADS, read from the rows that are staying. Derived from what is kept
    // rather than from what goes: a thread named by one survivor and forty victims stays.
    const keptThreads = new Set<string>();
    for (const { id, entity } of this.store.entries<EngineMessage>("message")) {
      if (evicted.has(id)) continue;
      if (typeof entity.threadId === "string" && entity.threadId !== "") keptThreads.add(entity.threadId);
    }
    const out: Array<{ type: string; id: string }> = [];
    for (const { type, via } of CASCADE_TYPES) {
      for (const row of this.store.entries<{ messageId?: string | null }>(type)) {
        // THE ONE-PAGE GRACE, the same one the message loop takes and for the same reason: a
        // child can arrive a page ahead of the message it names, and evicting it here would drop
        // a row the next page is about to justify.
        if (graceAbove !== undefined && row.seq > graceAbove) continue;
        if (via === "message.threadId") {
          if (!keptThreads.has(row.id)) out.push({ type, id: row.id });
          continue;
        }
        const named = row.entity?.messageId;
        // Not a string ⇒ this row names no message (the page-1 approval) and is not ours to take.
        if (typeof named === "string" && evicted.has(named)) out.push({ type, id: row.id });
      }
    }
    return out;
  }

  /**
   * Note that a surface has asked to render this message. Newest last; the oldest fall off at
   * {@link RENDERED_PINS}. Re-asking moves an id back to the newest end, so a message that is
   * re-opened is held again rather than ageing out mid-read.
   */
  protected noteRendered(messageId: string): void {
    // This set is the ONLY thing holding the body of a message the reader opened that is older
    // than the eager window: `trimBodyCache` evicts by date, and old is exactly what it is.
    this.renderedIds.delete(messageId);
    this.renderedIds.add(messageId);
    while (this.renderedIds.size > RENDERED_PINS) {
      const oldest = this.renderedIds.values().next();
      if (oldest.done) break;
      this.renderedIds.delete(oldest.value);
    }
  }

  /** The pin set — every message id the mirror is still referencing. See {@link pruneToPolicy}. */
  protected pinnedMessageIds(): Set<string> {
    const pinned = new Set<string>();

    /**
     * The message on screen, which nothing in the mirror references. Every other clause reads a ROW that points at a
     * message; an open message is pointed at by nothing (reading is not a mutation), so the four record clauses could
     * all be satisfied while the windowed prune hard-deleted, cascade included, the mail under the reader's eyes.
     * `hydrateBody` is the signal and not a new registration call: every reading surface already tells the engine
     * which message it renders, from an effect keyed on the open id — that call IS the statement "I am rendering this
     * body", so honouring it needs no second seam a surface could forget. Not a promise that everything ever opened
     * survives: the hold is capped ({@link RENDERED_PINS}) and lives only in this tab — what the surfaces are
     * showing, not a second retention policy.
     */
    for (const id of this.renderedIds) pinned.add(id);

    for (const d of this.store.list<EngineDraft>("draft")) {
      if (d.inReplyToMessageId) pinned.add(d.inReplyToMessageId);
      // …and the message it forwards: a kept forward opens only while its original is here.
      if (d.forwardOfMessageId) pinned.add(d.forwardOfMessageId);
    }
    /**
     * EVERY PARK, THROUGH THE ONE FOLD. `winningStates` reads both wire homes — the standalone
     * `message_state` record AND the copy the message's own row carries — because a windowed
     * bootstrap can deliver either without the other, and reading the records alone evicted the
     * parked mail of a mirror that only ever received the message: the reminder deleted by the
     * cache it was kept in. Over the STORE, not the overlay, because the prune is about what the
     * mirror holds.
     */
    for (const [messageId, claim] of winningStates(this.store)) {
      if (claim.state && claim.state !== "none") pinned.add(messageId);
    }
    for (const r of this.store.list<PendingRoutingDecision>("routing_decision")) {
      if (r.status === "pending_approval" && r.messageId) pinned.add(r.messageId);
    }
    for (const a of this.store.list<PendingApproval>("approval")) {
      if (a.status === "pending" && a.messageId) pinned.add(a.messageId);
    }
    /**
     * A TAGGED MESSAGE, whatever its age. The server serves these deliberately: after the windowed walk meets both
     * floors, `getSnapshot` opens a LABELED TAIL and carries every message below the window that owns a tag, because
     * a tagged row evicted from a windowed mirror can never be re-delivered — its `message_tags` change sits below
     * the client's post-bootstrap cursor. Without this clause the first post-drain prune threw that tail away again,
     * so a tag whose mail was older than the window showed a fraction of its messages and a count to match.
     * `labels` is the mirror's own field; an assignment later re-materializes an evicted row as a `message` update.
     */
    for (const { id, entity } of this.store.entries<EngineMessage>("message")) {
      if (entity.labels && entity.labels.length > 0) pinned.add(id);
    }
    return pinned;
  }

  /**
   * A drain guaranteed to have STARTED AFTER the caller's write committed. `syncOnce()` coalesces —
   * right for a poll, wrong for a mutation reconciling its own write: a drain issued BEFORE the
   * POST committed read the log below the mutation's row and cannot carry it, however long it
   * takes; `dispatch` awaited it anyway, dropped the overlay, and the mail snapped back until the
   * next 8 s poll. Reported twice as "when I select one as ohbox, it does not seem to work" — and
   * then it does: it depends on whether a poll was in flight when the click landed, intermittent by
   * construction.
   */

  /**
   * "Started after the POST returned" is sufficient because the server allocates each seq through an `UPDATE …
   * RETURNING` on the account's `account_sync_state` row inside the mutation's own transaction, so seq order equals
   * COMMIT order per account: a drain issued after our POST returned reads a log in which our row is visible. The
   * argument rests entirely on that row lock — a future `bigserial` seq would leave every test green and make this
   * silently unsound. Deliberately NOT a wait for `cursor >= outcome.seq`: the cursor is the max seq RETURNED after
   * the `types` filter, so with `EngineOptions.types` set the wait never terminates; it also needs a fallback anyway
   * (`seq: null` on a stripped header), and a wait loop is unbounded requests with nobody behind them, where this is
   * exactly one drain.
   */

  /**
   * Cost: nothing in the common case — no drain in flight means `syncOnce()` starts one NOW, the same single drain
   * the mutation always paid for. A drain in flight means ONE follow-up, shared by every mutation landing in the
   * window (three clicks during one poll are three overlays and one extra drain). The bound comes from `syncOnce()`
   * itself: the waiting callbacks run as consecutive microtasks, the first assigns `this.syncing` synchronously,
   * every sibling coalesces — proven by experiment, the remembered-drain field removed with the suite green. Drains
   * never overlap (concurrency 1, `sync-liveness.test.ts`).
   */

  /**
   * Two accepted costs: a mutation landing during the cold bootstrap waits for it plus a follow-up (it already did,
   * through coalescing), and a POST that returned before the current drain started chains one drain it did not need —
   * sound, bounded at one, and distinguishing it would need a wall clock.
   */
  protected syncFresh(): Promise<void> {
    const inFlight = this.syncing;
    // Nothing running ⇒ this starts a drain now, which is already after the commit.
    if (!inFlight) return this.syncOnce();
    return inFlight
      // The IN-FLIGHT drain's failure is not this mutation's failure — it is a poll that has
      // nothing to do with the write, and this mutation still needs its own drain afterwards.
      // Its rejection still reaches its own caller (the scheduler counts it and arms backoff):
      // `.catch` derives a NEW promise and steals no handler.
      .catch(() => { /* see above */ })
      .then(() => this.syncOnce());
  }

  /** Hook an SSE/EventSource (or push relay) as a wake signal: `sync` events nudge a drain. */
  attachWakeSignal(source: WakeSignalSource, event = "sync"): () => void {
    const onWake = (): void => {
      void this.syncOnce().catch(() => {
        /* a wake nudge must never throw into the event loop; the next tick retries */
      });
    };
    source.addEventListener(event, onWake);
    return () => source.removeEventListener(event, onWake);
  }

  // Written in a later file of the engine; named here because this one calls them.
  abstract syncOnce(): Promise<void>;
  protected abstract ageFloor(policyDays: number): number;
}

/** The engine's class as this file's bodies name it: the statics they read are declared here. */
const OhmailEngine = EngineWindowed;
