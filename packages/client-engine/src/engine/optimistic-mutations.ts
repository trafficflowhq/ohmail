import type {
  CreatedDraftRow, MutationOutcome, MutationQueued, WithdrawSendAnswer, WithdrawSendOutcome,
} from "../adapters/adapter.js";
import {
  keepsWrite, OUTBOX_WITHDRAWN_CODE, STAGING_UNREACHABLE_CODE, UPDATE_ANSWER_CODES, type UpdateAnswerCode,
} from "../adapters/refusal-shape.js";
import { outrankCoveringDomains } from "../address-rank.js";
import { bytesBlob } from "../bytes-blob.js";
import { narrowRead } from "../mark-seen-chunk.js";
import {
  messageIdKey, type MutationEffect, mutationEffects, replySubject, sentOverlayMessage,
} from "../mutations.js";
import { filedOutOfOhbox, rowPinsBackNow } from "../ohbox-rows.js";
import { heldRuleKey } from "../rule-twins.js";
import { conversationKeyOf, isOwnSent, isResurfaced, ohboxView, rulesList, sendingMailboxId } from "../selectors.js";
import type { SendAndDonePlan } from "../send-and-done.js";
import { sendFingerprint } from "../send-fingerprint.js";
import { verbTargetsOf } from "../shadow.js";
import type { OutboxRowAct, OutboxRowVerdict } from "../store.js";
import {
  type ComposeAttachment, type EngineDraft, type EngineMessage, type EngineMutation, FOLDER_OF_VIEW,
  MutationRejectedError, OUTBOX_ABANDONED_TYPE, OUTBOX_TYPE, type RuleDTO,
} from "../types.js";
import { type AttachmentItem, base64ToBytes } from "./attachment-items.js";
import { EngineAttachments } from "./attachments.js";
import { OPTIMISTIC_SENT_TTL_MS, QUEUE_VERBS, SENT_FORWARD_MAX_PARTS, TRAVELLING_VERBS } from "./ceilings.js";
import {
  type AbandonedMark, type KeptAsNewDraft, type MutationResult, type PendingMutation, type QueuedRuleWrite,
  STALE_PRESS_CODE, type SupersedeEffect, type WithdrawOutcome,
} from "./mutation-views.js";
import {
  abortControllerOrNull, MODELLED_WAIT_CODES, noAnswerWithin, OUTBOX_BACKOFF_BASE_MS, OUTBOX_BACKOFF_CAP_MS,
  OUTBOX_MAX_SERVER_FAILURES, OUTBOX_TRY_AGAIN_ENDS_HOLD_MS, OUTBOX_UNREACHABLE_CEILING_MS,
} from "./options.js";
import {
  type AbandonedMutation, andDoneOf, byAtN, explicitRead, isCreatedRow, isPersistedOutboxEntry, NO_QUEUED,
  NO_WAITING, OUTBOX_ENTRY_VERSION, OUTBOX_EXPIRED_MESSAGE, outboxEntryOf, pastCreateDedupe,
  type PersistedOutboxEntry, persistedWired, pressAgeOf, type QueuedChange, readLeftBy, retiresAbandoned,
  supersedeKey, targetOf, type WaitingSend, WITHDRAW_UNCONFIRMED_SENTENCE, withdrawnResult, worseWithdraw,
} from "./outbox-record.js";

export abstract class EngineOptimisticMutations extends EngineAttachments {
  // ── optimistic mutations ─────────────────────────────────────────────────

  /**
   * Whether the server's copy of draft `id` may hold formatting: the overlaid row, the row the
   * server last confirmed, or a pending save that states html. A queued save's overlay reads
   * plain while the server is still formatted, and this verb may retire that save.
   */
  protected mayHoldFormatting(id: string): boolean {
    const formatted = (d: EngineDraft | undefined) => typeof d?.html === "string" && d.html !== "";
    if (formatted(this.read().get<EngineDraft>("draft", id)) || formatted(this.store.get<EngineDraft>("draft", id))) return true;
    return [...this.queue, ...this.inFlight.values()].some((p) =>
      p.supersededBy === undefined && p.mutation.kind === "draft_save" && p.mutation.draftId === id && "html" in p.mutation);
  }

  /** Fill in wire-derivable fields so adapter + overlay agree on the payload. */
  protected enrich(given: EngineMutation): EngineMutation {
    let m = given;
    // `html: null` = the editor holds no formatting. It rides only to a row this mirror holds as
    // formatted, which it makes plain; anywhere else the plain request stays as it was. Decided
    // here so the overlay and the outbox hold the same request.
    if ((m.kind === "draft_save" || m.kind === "mail_send") && m.html === null) {
      if (!(m.draftId && this.mayHoldFormatting(m.draftId))) {
        const { html: _plain, ...rest } = m;
        m = rest as EngineMutation;
      }
    }
    // A published rule with no row here is named by its key, parsed from its id and nothing else.
    if ((m.kind === "rule_update" || m.kind === "rule_delete") && m.key === undefined) {
      const key = heldRuleKey(m.ruleId);
      if (key !== null) m = { ...m, key };
    }
    // An address rule is written at a priority no rule on its domain filing elsewhere outranks.
    if (m.kind === "rule_create" || m.kind === "rule_update") return outrankCoveringDomains(rulesList(this.read()), m);
    if (m.kind === "tag_assign" && m.labels === undefined) {
      const msg = this.read().get<EngineMessage>("message", m.messageId);
      if (msg) {
        const labels = m.assigned
          ? [...new Set([...msg.labels, m.tagId])]
          : msg.labels.filter((l) => l !== m.tagId);
        return { ...m, labels };
      }
    }
    if (m.kind === "feed_mark_seen") {
      const reader = this.read();
      // The mark-the-whole-feed form: every unread id of the VIEW'S folder, so the wire PATCHes
      // exactly the set the optimistic effect flips — per `FeedView`, no longer Reads-only.
      const folder = FOLDER_OF_VIEW[m.view ?? "reads"];
      const given = m.messageIds ?? reader
        .list<EngineMessage>("message")
        .filter((msg) => msg.folder === folder && msg.unread)
        .map((msg) => msg.id);
      /**
       * A glance reads; it does not spend the pin — and the server knows the difference. `feed_mark_seen` is the
       * involuntary read (the per-card dwell, the leave-commit), and this seam used to FILTER resurfaced ids out of
       * it so the PATCH could not reach `MessageService.spendResurface` — protecting the pin by DROPPING THE READ:
       * the flip-back reported live (2026-08-26), a pinned row presented read while open and turning back to unread
       * on leave because the read never landed. The rule now: a resurfaced message keeps its genuine read state, and
       * the glance itself goes on the wire — `HttpAdapter` sends `via: "glance"` and the server marks read WITHOUT
       * spending the pin; only dealing with the row takes the pin down (the read pill, `⇧I`, bulk, read-all, filing,
       * the settled reply, Done).
       */

      /**
       * The id list is still frozen HERE: the enriched mutation is what the overlay, the demo echo and the adapters
       * all read afterwards — one list, no divergence.
       */
      return { ...m, messageIds: given };
    }
    if (m.kind === "mark_seen") {
      /**
       * AN OPEN READ IS DECIDED HERE, AND ONLY HERE: a read whose every id is in the conversation the
       * reader holds open ({@link holdOpenRow}) carries `openRead`, and the server stamps the rows
       * that were unread — the top of "Earlier" once the reader moves on. `via` does not matter: a
       * glance counts. A flag a surface passed is dropped: no surface decides placement.
       * `readRow` (a row read by its own verb, nothing holding it) is judged the same way when it
       * stands in New, takes no hold, and is dropped here too.
       */
      const { openRead: _surfaceFlag, readRow, ...given } = m;
      // An Undo's read puts back what the press ended and places nothing anew.
      if (given.unread || given.restoreOpenReadAt !== undefined) return given;
      const reader = this.read();
      const named = readRow !== undefined && readRow !== this.openRow
        && ohboxView(reader).newForYou.some((x) => x.id === readRow) ? readRow : this.openRow;
      if (named === null) return given;
      const held = reader.get<EngineMessage>("message", named);
      if (!held) return given;
      const key = conversationKeyOf(held);
      const all = given.messageIds.every((id) => {
        const msg = reader.get<EngineMessage>("message", id);
        return msg !== undefined && conversationKeyOf(msg) === key;
      });
      return all ? { ...given, openRead: true } : given;
    }
    if (m.kind === "mail_send") {
      // FREEZE THE ENVELOPE HERE, and nowhere else. The overlay effect and the wire body are
      // both computed from this one object, so they cannot disagree — and because the
      // enriched mutation is what goes on the queue, a retry after a network failure sends
      // the SAME envelope rather than re-deriving it from a mirror that has since drained.
      if (m.inReplyTo === null) {
        // A COMPOSE, or a FORWARD. The recipient and the subject are the USER's and are not
        // derived from anything; the only unknown is which of the account's mailboxes it goes
        // out from. A compose pins `threadId` to null so nothing downstream can wander into a
        // thread. A forward of a message this mirror holds takes THAT message's thread: the
        // server mints its In-Reply-To/References off the original, so the Sent copy files
        // under the original's conversation on every device — and the confirm-time overlay
        // stands there from the first frame rather than as a conversation of its own.
        const original = m.forwardOf ? this.read().get<EngineMessage>("message", m.forwardOf) : undefined;
        return {
          ...m,
          mailboxId: m.mailboxId ?? sendingMailboxId(this.read()) ?? undefined,
          threadId: original?.threadId ?? null,
        };
      }
      const parent = this.read().get<EngineMessage>("message", m.inReplyTo);
      if (!parent) return m; // unknown parent ⇒ no effects ⇒ mutate() rejects it below
      return {
        ...m,
        mailboxId: m.mailboxId ?? parent.mailboxId,
        threadId: m.threadId ?? parent.threadId,
        subject: m.subject ?? replySubject(parent.subject),
        // The reply goes to the sender of the message being answered. `Reply-To` is not in
        // the mirror (the DTO has no field for it), so a sender who set one is answered at
        // their From — filed as owed rather than silently approximated.
        to: m.to ?? [parent.from],
      };
    }
    return m;
  }

  /**
   * Apply locally NOW, fire the request, reconcile on the echo. Hard rejection ⇒ overlay rolled back; retryable
   * failure ⇒ the mutation stays queued and visible (user-always-wins) for `flushPending()` with the SAME key.
   * `opts.key` is for a caller that already owns an Idempotency-Key, and the one that needs it is the send:
   * `useMailSend` persists the key with the send lane the moment it is minted, ahead of this call, because a send's
   * lock must outlive the component — a reload inside the queued window used to let the restored editor mint a SECOND
   * key and deliver the same mail twice. Resuming the stored key makes the server's same-key branch
   * (`SendService.resumeExisting` — replay, report, or verify-by-Sent, never a blind resend) the authority on whether
   * that mail has gone.
   */

  /**
   * Not restricted to `mail_send` in the signature — the rule is "the caller owns this verb's identity" — but a key
   * must be durable at the caller before it is handed over, or this is just a slower `uuid()`.
   */
  async mutate(
    m: EngineMutation,
    opts: {
      key?: string; andDone?: SendAndDonePlan;
      /** Called once, after the outbox write committed and before the dispatch; never on a refused write. */
      onDurable?: () => void;
    } = {},
  ): Promise<MutationResult> {
    this.noteFiling(m);
    const result = await this.mutateOnce(m, opts);
    // A verb that may travel to another install re-reads what waits — on a 202 AND on an applied
    // answer, since a mixed account's rule removal is applied here and asked there.
    if ((result.status === "awaiting_organizer" || result.status === "confirmed") && TRAVELLING_VERBS.has(m.kind)) {
      if (result.status === "awaiting_organizer") this.waitingRefused = false;
      this.refreshWaitingOnOrganizer();
    }
    // A decision the server took changes who is waiting; the page is re-read on this one road.
    if (result.status !== "rolled_back" && QUEUE_VERBS.has(m.kind) && this.screenerWait.armed) {
      this.reaskScreenerWaiting();
    }
    return result;
  }

  /**
   * A LETTER FILED WITH ITS PIN TAKES ITS RESURFACED ROW ALONG, and every door files through here: Move
   * and Junk, the sender sheet and its gate decision, Move them, Move it too and Delete, on every surface.
   * The server spends the pin of the letter it files (`MessageService.spendResurface`); the row's other
   * pins that are back now, our own reply's included, are spent at the end of the turn, once for all the
   * turn filed, so a row filed whole spends only what it leaves. `inverseMutations` puts them back.
   */
  protected noteFiling(m: EngineMutation): void {
    const letter = filedOutOfOhbox(this.verbView, m);
    if (letter === null) return;
    if (this.filingTurn === null) {
      const turn = { filed: new Set<string>(), rows: new Set<string>() };
      this.filingTurn = turn;
      void Promise.resolve().then(() => {
        if (this.filingTurn === turn) this.filingTurn = null;
        for (const messageId of rowPinsBackNow(this.verbView, turn.rows, turn.filed)) {
          void this.mutate({ kind: "triage_set", messageId, state: "none" }).catch(() => undefined);
        }
      });
    }
    this.filingTurn.filed.add(letter.id);
    if (isResurfaced(letter)) this.filingTurn.rows.add(conversationKeyOf(letter));
  }

  /** A verb's paint: a `draft_save` create's row carries its key ({@link EngineDraft.pendingCreate}). */
  protected paintOf(m: EngineMutation, key: string, now: () => Date): MutationEffect[] {
    return mutationEffects(this.verbView, m, { now, uuid: this.uuid, key });
  }

  protected async mutateOnce(
    m: EngineMutation, opts: { key?: string; andDone?: SendAndDonePlan; onDurable?: () => void },
  ): Promise<MutationResult> {
    const enriched = this.enrich(m);
    const id = this.uuid();
    const key = opts.key ?? this.uuid();
    // A key the caller owns can be re-expressed after a withdrawal (the send path reuses one
    // intent's key). The mark belongs to the row that was cancelled, never to the key for ever.
    this.withdrawnKeys.delete(key);
    /* A WRITE NAMING A ROW WHOSE CREATE HAS NOT SETTLED names an id the server never held: answered as
       the server answers it, before anything is painted, kept or sent. */
    const named = enriched.kind === "draft_save" || enriched.kind === "draft_discard" || enriched.kind === "mail_send"
      ? enriched.draftId ?? null : null;
    if (named !== null && this.pendingCreateOf(named) !== null) {
      return {
        id, key, status: "rolled_back", seq: null,
        error: new MutationRejectedError("draft not found", { status: 404, code: "not_found" }),
      };
    }

    // THE EFFECTS ARE COMPUTED BEFORE SUPERSESSION, deliberately: they must be read over the
    // superseded verbs' overlays. A reversal is the case that breaks the other order — a
    // queued move to Reads, then the user moves it back to INBOX: with the Reads overlay
    // already dropped the mirror says "it is in INBOX", the reversal computes zero effects,
    // and mutate() would reject a verb the server absolutely needs (the queued move may have
    // COMMITTED with its response lost, and only the reversal on the wire can undo it).
    const effects = this.paintOf(enriched, key, this.now);

    // THEN supersession, still SYNCHRONOUS — the first frame after mutate() must already show the newer verb's
    // overlay (re-resurface-first-frame pins that mutate() publishes before its first await), and enrich above read
    // the old overlays it needed. The store-side deletes/rewrites inside are fire-and-forget: if a kill outruns them,
    // the stale entry replays BEFORE the newer one — restore sorts by (at, n) — so the newer verb still lands last
    // and the server converges on the user's latest word. …and only AFTER the no-op check below: a verb with no
    // effects is about to be REJECTED, and a rejected verb supersedes nothing. Re-pressing a queued move (the
    // optimistic destination makes the repeat a no-op) must not retire the queued original — that entry may be the
    // only copy of an intent whose first attempt never reached the server.
    // A row in neither the mirror nor a page (a deep link) is still sent, with nothing to paint:
    // only the server may say it is gone. Empty effects on a HELD row are a no-op, refused here.
    if (effects.length === 0 && !this.namesOnlyUnheldRows(enriched)) {
      const error = new MutationRejectedError(`mutation target not found (${m.kind})`, {
        status: 404, code: "not_found",
      });
      return { id, key, status: "rolled_back", seq: null, error };
    }
    const settleMarks = this.openReplacement(id);
    const superseded = this.supersedeQueued(enriched, id, key);
    this.retireShadowsUnder(effects);
    this.overlays.set(id, effects);
    this.overlayRev++;
    this.endHoldActedAway(effects);
    this.notify();
    const awaitsHold = enriched.kind === "draft_save" && enriched.draftId === null;

    /**
     * The verb is durable before it is sent — the outbox write ahead of the wire POST (INSTANT-ARCH §6.2(b)). The
     * order is the guarantee: a process killed between this line and the server's answer restarts with the entry
     * still in the mirror store, replays it under the SAME Idempotency-Key, and the verb lands exactly once. When the
     * write is refused, the verb decides: for almost everything the failure is swallowed and the verb goes on the
     * wire — a `triage_set` sent twice sets the same state twice, and refusing would cost a real action to protect
     * nothing. A SEND is not that verb: its key is the only thing between "retry" and a second message in someone's
     * inbox, and the key lives in the row that just failed — dispatch anyway and a death before the answer leaves the
     * next boot with no record, the user resends, and the server delivers twice with no key to match.
     */

    /**
     * So a send whose durable record was refused is rolled back and says so; the composer still holds the text.
     */
    // A press under a key whose send just confirmed sends the row that send made, never a second one.
    const confirmedRow = enriched.kind === "mail_send" && opts.key !== undefined ? this.confirmedRows.get(key) : undefined;
    const pending: PendingMutation = {
      id, key, mutation: enriched, at: this.now().getTime(), n: this.outboxSeq++,
      ...(superseded.retired.length > 0 ? { retire: superseded.retired } : {}),
      ...(superseded.createAttempted ? { createAttempted: true } : {}),
      ...(superseded.createdRow !== undefined ? { createdRow: superseded.createdRow }
        : confirmedRow !== undefined ? { createdRow: confirmedRow } : {}),
      ...(this.ownerName !== null ? { owner: this.ownerName } : {}),
      // With the send's durable row, never in a surface's memory: the arm outlives the surface.
      ...andDoneOf({ mutation: enriched, andDone: opts.andDone }),
    };
    // A create waits its turn painted and in no collection: a take-back reaches it here.
    if (awaitsHold) this.awaitingTurn.set(key, pending);
    // So does a read: a newer read or unread on its letters reaches it here (`readsTaken`).
    if (enriched.kind === "mark_seen" || enriched.kind === "feed_mark_seen") this.freshReads.add(pending);
    try {
      return await this.dispatchFresh(pending, superseded, settleMarks, opts, awaitsHold);
    } finally {
      if (this.awaitingTurn.get(key) === pending) this.awaitingTurn.delete(key);
      this.freshReads.delete(pending);
    }
  }

  /** {@link mutateOnce} past the paint: the outbox write, then the wire. */
  protected async dispatchFresh(
    pending: PendingMutation, superseded: SupersedeEffect, settleMarks: () => void,
    opts: { key?: string; andDone?: SendAndDonePlan; onDurable?: () => void }, awaitsHold: boolean,
  ): Promise<MutationResult> {
    const { id, key, mutation: enriched } = pending;
    // ONE TRANSACTION: the newer row in, the rows it supersedes out, and every abandoned record it
    // marks stale. See `supersedeQueued` for why the removal may not be a separate best-effort
    // delete, and `commitReplacement` for why the marks may not be separate writes either.
    let commit: { persisted: boolean; marks: number };
    try {
      commit = await this.commitReplacement(pending, superseded);
    } catch (err) {
      // A throw is a refusal too: what the supersession changed goes back, wire marks included.
      this.undoSupersede(superseded);
      settleMarks();
      throw err;
    }
    const persisted = commit.persisted;
    /**
     * NO WRITE, NO WIRE — and the rule counts EVERY row this verb replaces, not only whole ones.
     *
     * It read `retired.length > 0` alone, so a verb that only NARROWED a queued read record — a
     * newer `mark_seen` subtracting ids from an older one — had zero retired rows and escaped: the
     * combined transaction was refused, memory was restored, and the replacement still went to the
     * wire while disk kept the full older intent, which the next boot then replays over it. The
     * marks belong to the same count for the same reason: a record this verb failed to mark stale
     * is still retryable and can overwrite the state this verb is about to establish.
     */
    if (!persisted
      && (superseded.retired.length > 0 || superseded.narrowed.length > 0 || commit.marks > 0
        // A send on the wire this verb only MARKED: unmarked, or its retryable answer drops it.
        || superseded.markedInFlight.length > 0
        // A read on its way or on the wire this verb took ids from: the same, for those ids.
        || superseded.takenOnWire.length > 0)) {
      /**
       * NO WRITE, NO WIRE — the supersession half of the rule stated in this module's header. This verb replaces
       * queued verbs. Its durable write was refused, so the store still holds the ones it would have retired, and
       * they are still the truth. Sending it anyway would put a change on the wire that this device has no record of,
       * over intents it has not managed to withdraw — and a kill would then replay those older verbs on top of it. So
       * nothing is dispatched, everything the supersession changed goes back, and the person is told the action was
       * refused rather than being shown it succeed and silently lose.
       */
      // No marker goes back, because none was made: they ride the transaction that was refused.
      this.undoSupersede(superseded);
      settleMarks();
      this.overlays.delete(id);
      this.overlayRev++;
      this.notify();
      return {
        id, key, status: "rolled_back", seq: null,
        error: new MutationRejectedError(
          "this device could not record the change, and it replaces others that are still queued",
          { status: null, code: "storage_refused", retryable: true },
        ),
      };
    }
    settleMarks();
    if (!persisted && enriched.kind === "mail_send") {
      this.overlays.delete(id);
      this.overlayRev++;
      this.notify();
      return {
        id, key, status: "rolled_back", seq: null,
        error: new MutationRejectedError(
          "this device could not record the send, and sending without a record risks delivering it twice",
          { status: null, code: "storage_refused", retryable: true },
        ),
      };
    }
    // The verb is on disk and replays under its key whatever happens next: a caller may let go now.
    if (persisted) {
      try { opts.onDurable?.(); } catch { /* the caller's own fault; the verb goes on */ }
    }

    /**
     * The fresh verb takes the same gate as every other road. It was the last dispatch outside {@link outboxGate},
     * waiting on a private `replayActive` deferred — serialized against the drive's replay and nothing else, so two
     * dispatches could be on the wire together; for the read verbs, whose supersession key is `null`, ordering IS the
     * contract (a newer unread landing before an older read leaves the server at the older value, silently). Joining
     * the chain is what "wait out whatever is in flight" means, bounded through {@link dispatchWithDeadline}. The
     * hold is still read synchronously FIRST, deliberately: it may stand for most of a minute and a person pressing Send must
     * not sit through it — the verb waits in the QUEUE (expressed, painted, persisted) and the hold's settle chains
     * the drive.
     */

    /**
     * The one exception is the caller-settled create (`draft_save`, draftId null): its caller adopts `entityId` from
     * THIS result and has no retry path, so it joins the gate and waits — a late-adopted draft id is correct; an
     * orphaned `queued` create is a twin factory.
     */
    // Taken back while its row was being written: the row is marked too, so no boot replays it.
    if (awaitsHold && this.withdrawnKeys.has(key)) await this.markWithdrawn(pending, false);
    const queued = (): MutationResult => {
      pending.told = true;
      this.queue.push(pending);
      return { id, key, status: "queued", seq: null };
    };

    for (;;) {
      // The create that must not be orphaned waits the hold out BEFORE joining the chain, never
      // while holding it: a caller that sat on the gate for the length of a hung request would
      // stall every other road behind it, which is the stranding the deadline exists to end
      // wearing a different hat.
      if (this.outboxHold) {
        if (!awaitsHold) return queued();
        await this.outboxHold;
        continue;
      }

      // Deadline-bounded like every other road. A timeout leaves the attempt owning its entry
      // and arms the hold; the verb is answered `queued` rather than left on a hung request.
      const out = await this.outboxGate(() => this.dispatchOnLane(pending));
      if (out.held) {
        if (!awaitsHold) return queued();
        continue; // the create re-reads the hold at the top and waits it out off the chain
      }
      if (out.timedOut) {
        /**
         * ONE OWNER, NOT TWO. The request is still running and owns this entry: it will settle it,
         * re-queue it, or leave it persisted for the next boot, and its late answer now reaches
         * `flushPending`. Putting the verb back on the queue as well gave it a second owner, and a
         * later flush dispatched it AGAIN — for a draft create, whose route ignores the key, that
         * is a second draft on the server for one the client already asked for.
         */
        pending.told = true;
        return { id, key, status: "queued", seq: null };
      }
      if (out.result === null) return queued();
      // OFF THE CHAIN NOW, so concurrent verbs coalesce onto one drive exactly as they did before
      // this road was gated: `syncFresh` joins an in-flight drain rather than starting a second.
      await this.settleReconcile(out.owed);
      return out.result;
    }
  }

  /** Does this verb name message rows by id, none of which the mirror or a page holds? */
  protected namesOnlyUnheldRows(m: EngineMutation): boolean {
    // A published rule by its key: sent with nothing painted, the organizer's to apply.
    if ((m.kind === "rule_update" || m.kind === "rule_delete") && m.key !== undefined) {
      return this.store.record("rule", m.ruleId) === undefined;
    }
    // A queue row from a page past the first: the mirror never held it, and only the server can
    // resolve the representative, so the decision is sent with nothing to paint.
    if (m.kind === "screener_decide") {
      return this.store.record("message", m.senderId) === undefined && this.screenerPageReps.has(m.senderId);
    }
    const ids = verbTargetsOf(m);
    return ids !== null && ids.every((mid) =>
      this.store.record("message", mid) === undefined && this.storePages.find(mid) === undefined);
  }

  protected outboxGate<T>(fn: () => Promise<T>): Promise<T> {
    /**
     * THE GATE SERIALIZES; IT DOES NOT WAIT OUT A HOLD: A caller joins the chain when it calls, and is released when
     * everything ahead has settled. A hold can be armed in between — by the very dispatch this caller is queued
     * behind, which timed out with its request still in the air. So every body re-reads {@link outboxHold} at its
     * start, which is release time, and that is the "consult before release" the roads need. The gate deliberately
     * does NOT `await` the hold on the caller's behalf. It stands for as long as a hung request does, up to its
     * {@link OUTBOX_HOLD_CEILING_MS}, and the whole point of the deadline is that nobody is suspended past it: a fresh verb answers
     * `queued`, a flush answers `queued` per entry, a drive skips its replay and goes on to drain.
     */

    /**
     * Waiting here would put every one of them back on the unbounded promise the deadline exists to escape —
     * measured, once: a fresh verb behind a hung replay hung with it.
     */
    const release = async (): Promise<T> => {
      this.inOutboxGate = true;
      try {
        return await fn();
      } finally {
        this.inOutboxGate = false;
      }
    };
    const run = this.outboxChain.then(release, release);
    this.outboxChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * ONE DISPATCH, DEADLINE-BOUNDED, WITH THE SAME BARRIER SEMANTICS THE BOOT REPLAY USES. Extracted from
   * `replayOutbox`'s loop so the per-record retry cannot be the one road without a deadline. Without it, a half-open
   * request leaves `retryAbandoned()` — and the surface promise a person is watching a spinner on — pending for ever.
   * On timeout the in-flight attempt still OWNS its entry (it settles, re-queues, or leaves it persisted for the next
   * boot), and becomes the order barrier {@link outboxHold} names, so no other outbox dispatch may start behind it.
   */
  /**
   * The one dispatch every road takes. Round four found the gate global but two riders not: `retryAbandoned` and
   * `flushPendingInner` had neither the release-time hold check nor `deferReconcile`, because both were added to
   * `mutate` by hand — this method makes that shape impossible, and a source census asserts nothing calls {@link
   * dispatchWithDeadline} except this. It owns two rules: the RELEASE-TIME hold check — a hold can be armed by the
   * very dispatch a caller queued behind, so checking on entry would release into the race the barrier prevents
   * (`held` says so; each road answers its own way); and `deferReconcile`, ALWAYS — the reconcile drain must not run
   * while the lane is held, else the deadline times the DRAIN and a completed POST reports `queued`; the caller gets
   * `owed` back.
   */

  /**
   * Deliberately NOT the gate: the unit of work owns that — batches hold it whole (a fresh verb landing between two
   * replayed ones puts a newer write ahead of older ones), singles take it themselves; taking it here would have each
   * batch queue behind itself, a deadlock a nested-flag cannot fix.
   */
  protected async dispatchOnLane(
    p: PendingMutation,
  ): Promise<{
    result: MutationResult | null;
    timedOut: boolean;
    held: boolean;
    owed: "await" | "background" | null;
  }> {
    if (this.outboxHold) return { result: null, timedOut: false, held: true, owed: null };
    if (this.awaitingTurn.get(p.key) === p) this.awaitingTurn.delete(p.key);
    // From here a fresh read is on the wire, where `inFlight` holds it.
    this.freshReads.delete(p);
    let owed: "await" | "background" | null = null;
    const { result, timedOut } = await this.dispatchWithDeadline(p, {
      deferReconcile: true,
      onReconcileDeferred: (mode) => { owed = mode; },
    });
    return { result, timedOut, held: false, owed };
  }

  /**
   * A PERSON'S TRY AGAIN ENDS THE WAIT ON A HUNG WRITE, once the server cannot still be working on it:
   * its request older than {@link OUTBOX_TRY_AGAIN_ENDS_HOLD_MS}. The attempt then settles as its
   * ceiling would settle it — a write back on the queue under its own key, a send only letting its
   * barrier go ({@link OUTBOX_HOLD_CEILING_MS}) — and this waits for the barrier to go. Answers the
   * entry whose wait it ended (`ended: null` when no barrier stood), or `null` while the barrier
   * stands: the press waits its turn behind it, and the barrier's end starts the drive that sends it.
   * Only a person's press does this; a new verb, a flush and a drive still queue behind the hold.
   */
  protected async endHold(): Promise<{ readonly ended: string | null } | null> {
    const hold = this.outboxHold;
    if (hold === null) return { ended: null };
    const owner = this.holdOwner;
    const wire = owner === null ? undefined : this.endWait.get(owner);
    if (owner === null || wire === undefined) return null;
    if (this.now().getTime() - wire.since < OUTBOX_TRY_AGAIN_ENDS_HOLD_MS) return null;
    wire.end();
    await hold;
    return { ended: owner };
  }

  /**
   * THE CHANGE {@link endHold} PUT BACK GOES OUT BEFORE THE PRESS when it was made first — the queue's
   * own order, inside the gate, so a newer change on the same field never lands ahead of the older
   * one still owed. A send or a draft's first save stays with the surface that settles it, as on the
   * drive. Its answer is kept as the drive's replay keeps one; the reconcile it owes is handed back
   * to be issued off the lane. Call inside {@link outboxGate} only.
   */
  protected async dispatchEndedFirst(ended: string | null, p: PendingMutation): Promise<"await" | "background" | null> {
    if (ended === null || ended === p.id) return null;
    const q = this.queue.find((x) => x.id === ended);
    if (q === undefined || byAtN(q, p) > 0) return null;
    if (q.restored !== true && OhmailEngine.ownerSettled(q.mutation)) return null;
    if (this.takeTurn(q) === "gone") return null;
    const out = await this.dispatchOnLane(q);
    if (out.held) {
      this.queue.push(q);
      this.queue.sort(byAtN);
      return null;
    }
    if (out.result !== null && out.result.status !== "queued" && out.result.status !== "superseded") {
      this.lateResults.set(q.id, out.result);
      this.notify();
    }
    return out.owed;
  }

  /** Issue the drain a dispatch deferred. OFF THE LANE — see {@link dispatchOnLane}. */
  protected settleReconcile(owed: "await" | "background" | null): Promise<void> {
    if (owed === "await") {
      return this.syncFresh().catch(() => { /* the overlay stands until a drain proves the echo */ });
    }
    if (owed === "background") {
      void this.syncFresh().catch(() => { /* the write landed; the next poll catches up */ });
    }
    return Promise.resolve();
  }

  protected async dispatchWithDeadline(
    p: PendingMutation,
    opts: { deferReconcile?: boolean; onReconcileDeferred?: (mode: "await" | "background") => void } = {},
  ): Promise<{ result: MutationResult | null; timedOut: boolean }> {
    // NO SEPARATE "ACTIVE" DEFERRED. Every caller of this method reaches it through
    // {@link outboxGate}, and the chain does not release the next one until this returns — so
    // being on the chain IS the in-flight barrier, and it is bounded by the deadline below.
    /**
     * IN FLIGHT FOR THE LIFE OF THE REQUEST, NOT OF THIS CALL.
     *
     * This method RETURNS at the deadline while the request keeps running — that is the whole
     * point of the deadline. Tracking the verb around the call therefore un-tracked it at exactly
     * the moment it most needs to be visible: still on the wire, in no collection, and about to
     * come back and re-queue itself. The entry is removed when the ATTEMPT settles.
     */
    const attempt = this.dispatch(p, opts);
    this.inFlight.set(p.id, p);
    void attempt.then(() => this.inFlight.delete(p.id), () => this.inFlight.delete(p.id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const raced = await Promise.race([
      attempt.then((r) => ({ r })),
      new Promise<{ r: null }>((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve({ r: null }); }, this.replayDeadlineMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);

    if (timedOut) {
      /**
       * THE LATE ANSWER IS KEPT, NOT THROWN AWAY: The attempt goes on and becomes the barrier; its eventual result
       * used to be discarded entirely, because the caller had already been told `queued`. That is fine for a verb the
       * drive owns and wrong for the two families a SURFACE is waiting on:
       * · a send. Its settlement reaches the composer only through a result `flushPending` returns. The verb is not
       *   on the queue — the in-flight attempt owns it — so no later flush produces one, and the composer stays
       *   locked after the message has gone.
       * · a first `draft_save`. The server's `entityId` exists in exactly one place, that result. Lose it and the
       *   next edit creates a SECOND draft, because nothing adopted the first one's id.
       */

      /**
       * So a late settle is recorded and handed to the next `flushPending`, which is the road every owner-settled
       * result already travels. Nothing is re-dispatched: this is the answer to a request that did go out, arriving
       * after the deadline said it might not.
       */
      /* THE BARRIER GOES WHEN THE ATTEMPT SETTLES, or earlier through `holdRelease` (a send's ceiling,
         a press on it): its late answer is still kept when it comes, with the drain it owes. */
      let release: () => void = () => {};
      let releasedEarly = false;
      const hold: Promise<void> = new Promise<void>((resolve) => { release = resolve; }).finally(() => {
        if (this.outboxHold === hold) {
          this.outboxHold = null;
          this.holdOwner = null;
          this.holdRelease = null;
        }
        void this.syncFresh().catch(() => { /* the scheduler's cadence retries */ });
      });
      void attempt.then(
        (late) => {
          // A superseded send has no reader: the newer press under its key answers for it.
          if (late.status === "superseded") return;
          /* A `queued` late answer is no answer — the entry is back on the queue (its ceiling ended
             it, or the wire failed) — and kept it was read as a verdict beside the real one. Except
             for a live send or draft's first save: their surface re-arms its retry on it. */
          if (late.status === "queued" && (p.restored === true || !OhmailEngine.ownerSettled(p.mutation))) return;
          this.lateResults.set(p.id, late);
          this.notify();
        },
        () => undefined,
      ).then(() => {
        if (releasedEarly) void this.syncFresh().catch(() => { /* the scheduler's cadence retries */ });
        release();
      });
      this.outboxHold = hold;
      this.holdOwner = p.id;
      this.holdRelease = () => { releasedEarly = true; release(); };
      return { result: null, timedOut: true };
    }
    return { result: raced.r, timedOut: false };
  }

  /**
   * RE-ASSERT one outbox entry after a retryable failure — {@link OhmailEngine.mutate}'s own first
   * write is {@link OhmailEngine.commitReplacement}, which carries the supersession with it.
   *
   * It used to answer `void` and swallow every failure, with the reasoning that "a verb that
   * cannot be persisted must still be SENT". That is right for almost every verb and wrong for
   * exactly one, so the caller now gets to decide instead of this method deciding for all of them.
   */
  /**
   * THE ROW A SEND MADE, ON DISK BEFORE THE SEND REQUEST: a reload that replays this send then sends
   * that row instead of creating another. Written through the same door as every entry write, under
   * the generation fence; a refused write leaves today's shape. A withdrawn key is never re-written.
   */
  protected async recordCreatedRow(p: PendingMutation, row: CreatedDraftRow): Promise<void> {
    p.createdRow = row;
    if (this.withdrawnKeys.has(p.key)) return;
    await this.putOutbox(p);
  }

  protected async putOutbox(p: PendingMutation): Promise<boolean> {
    const entry = outboxEntryOf(p);
    try {
      await this.store.commitLocal(
        [{ type: OUTBOX_TYPE, id: p.id, entity: entry }],
        (p.retire ?? []).map((id) => ({ type: OUTBOX_TYPE, id })),
      );
      // Only now: a commit that did not happen has retired nothing, and the next write of this
      // verb must carry them again.
      delete p.retire;
      return true;
    } catch {
      return false; // storage refused — what that costs depends on the verb; see `mutate`.
    }
  }

  /**
   * Hard-delete one outbox entry on its terminal outcome (best-effort). It stayed on `prune` when the rest of the
   * outbox moved to `commitLocal`: three callers are synchronous `void` functions that read the store immediately
   * after, which works only because `prune` evicts from `records` BEFORE its first await — moving it to `commitLocal`
   * pushed the eviction two microtasks later and the row was still readable after the sweep that retired it (seven
   * kill-restart failures in `durable-outbox.test.ts`). Supersession's delete is NOT here any more: it is one half of
   * a replacement, and gone-from-memory/still-on-disk is exactly the wrong failure there — it rides the newer verb's
   * own transaction. A LONE delete has nothing to be atomic with and memory-first fails safe: a row that outlives its
   * delete replays under its original key.
   */

  /**
   * `prune` is also the only primitive that evicts `unflushed` (`store.ts`), which a bare `transact` would leave to
   * the next carry-forward.
   */
  /**
   * A DAY-OLD UNKEYED CREATE IS KEPT, NOT DELETED: into the abandoned list, with Try again refused
   * by the same record and sentence the retry gives it, so the person sees it and decides. One
   * transaction, like `abandon`; a refused write leaves the row queued on disk for the next boot.
   */
  protected async expireAtRestore(e: PersistedOutboxEntry): Promise<void> {
    const record: PersistedOutboxEntry = {
      ...e,
      lastError: { message: OUTBOX_EXPIRED_MESSAGE, code: "outbox_expired", status: null },
      retryRefused: "outbox_expired",
    };
    try {
      await this.store.commitLocal(
        [{ type: OUTBOX_ABANDONED_TYPE, id: e.id, entity: record }], [{ type: OUTBOX_TYPE, id: e.id }]);
      this.notify();
    } catch { /* still queued on disk: the next boot asks again, and never replays it */ }
  }

  protected async dropOutbox(id: string): Promise<boolean> {
    try {
      // THROUGH THE STORE'S OWN WRITE LANE, like every other durable outbox write. `prune` is
      // memory-first by design and that is still right here, but its PERSISTED half raced the
      // re-bootstrap exactly as `commitLocal` used to: the reset snapshots the rows to keep, the
      // purge lands, and the wipe re-writes a row the purge had just removed — a verb that
      // reached its terminal outcome coming back to life on the next boot. `prune` now runs on
      // the lane, so it and the reset take turns.
      await this.store.pruneSerialized([{ type: OUTBOX_TYPE, id }]);
      return true;
    } catch {
      return false; // an undeleted entry replays idempotently — the safe direction; a Cancel asks
    }
  }

  /** Is this refusal the server out of reach — see {@link EngineOptions.outboxTransportIsUnreachable}. */
  protected unreachable(err: MutationRejectedError): boolean {
    if (err.code === "offline_read_only") return true;
    return this.transportIsUnreachable && (err.code === "network" || err.code === "timeout");
  }

  /**
   * DID THE SERVER LOOK AT THIS VERB AND FAIL IN A WAY NOBODY MODELLED? Only a `true` here spends the give-up
   * ceiling, so this test decides whether a verb can ever be abandoned. It is written to say NO whenever it is
   * unsure, because the two mistakes are not symmetric: a false negative costs one more retry, and a false positive
   * throws away a user's work that would have landed. Three families answer no.
   * · **`network` / `timeout`.** The adapter raises these when the request never got an answer — `code: "network"`
   *   from a rejected fetch, `code: "timeout"` from `withDeadline`. An offline laptop must retry for ever; the verb
   *   is fine and the wire is not.
   */

  /**
   * · **A refusal carrying `Retry-After`.** The server declined work it knows it cannot do yet (`503 db_busy` from
   *   a starved pool) and said when to come back. Counting that would abandon every legitimate verb in flight during
   *   a pool outage — a far bigger loss than the loop this ceiling closes.
   * · **No status at all.** Nothing reached an HTTP response, so nothing attributes the failure to the server.
   */
  protected static serverAnswered(err: Pick<MutationRejectedError, "code" | "status" | "retryAfterMs">): boolean {
    if (err.code === "network" || err.code === "timeout") return false;
    // The API had just answered the mint, so only storage is out of reach: counted, status or not,
    // and before the carve-out below, since the desktop's door names a wait for it.
    if (err.code === STAGING_UNREACHABLE_CODE) return true;
    if (err.retryAfterMs !== null) return false;
    if (MODELLED_WAIT_CODES.has(err.code ?? "")) return false;
    // A BARE 429 — an edge or proxy rate limit with no JSON body and no `Retry-After`, so it
    // arrives with no code at all. Rate limiting is a wait by definition; counting it means a
    // throttle abandons work rather than delaying it, and the caller has no way to say otherwise.
    if (err.status === 429) return false;
    return typeof err.status === "number";
  }

  /**
   * GIVE UP ON ONE VERB, VISIBLY. The visible half reuses the explicit-refusal arm exactly — overlay dropped, echo
   * forgotten, `overlayRev++`, `notify()` — because from the user's side this IS a refusal: the row reverts and what
   * they asked for did not happen. Presenting it as anything softer would leave a change on screen that no longer
   * exists anywhere. What differs is where the record goes. An explicit refusal calls `dropOutbox` and the verb is
   * gone; this MOVES it to {@link OUTBOX_ABANDONED_TYPE}, so the work survives, a person can read what the server
   * said, and "Try again" is possible. Dropping it would make the ceiling a silent data-loss feature, which is worse
   * than the unbounded loop it replaces.
   */

  /**
   * The write happens BEFORE the delete, and the order is load-bearing: a crash between the two leaves the verb in
   * both collections, which replays a verb the user can also see and retry — recoverable, and idempotent under its
   * unchanged key. The other order loses it outright.
   */
  protected async abandon(
    p: PendingMutation, attempts: number, err: MutationRejectedError,
  ): Promise<MutationResult> {
    /**
     * Giving up on a send is not proof it did not leave: eight answers this client could not model are eight
     * unknowns, and reporting a `mail_send` as a generic `rolled_back` says the opposite — the composer treats it as
     * failure and the next press mints a FRESH key, a second delivery of mail the reservation may already have sent.
     * So a send is recoded to `send_unverified`, the gated send's own terminal ambiguity, which the compose surface
     * already renders ("check your Sent folder before retrying"). The recode applies to BOTH the returned result and
     * the persisted `lastError` — the two are read by different people at different times, and either saying "failed"
     * is enough to buy a duplicate. Try again then means "ask the server what happened under this key": the same-key
     * replay is verify-before-resend, never a second message.
     */
    this.sayEnded(p, "refused");
    const isSend = p.mutation.kind === "mail_send";
    const reported = isSend
      ? new MutationRejectedError(
        "We could not confirm this send. Check your Sent folder before retrying.",
        {
          status: err.status,
          code: "send_unverified",
          retryable: false,
          retryAfterMs: err.retryAfterMs,
        },
      )
      : err;

    const record: PersistedOutboxEntry = {
      v: 3, id: p.id, key: p.key, n: p.n, at: p.at, mutation: p.mutation,
      attempts,
      lastError: { message: reported.message, code: reported.code, status: reported.status },
      // A record whose create already went out unread keeps saying so: Try again on it, in this
      // session or the next, must not repeat a create the route cannot deduplicate.
      ...(p.createAttempted === true ? { createAttempted: true } : {}),
      ...(p.createdRow !== undefined ? { createdRow: p.createdRow } : {}),
      // Its Send + Done release, for the Try again that confirms it (`retryAbandonedOnce`).
      ...andDoneOf(p),
    };
    /**
     * TWO WRITES, TWO FAILURE MODES, AND NEITHER MAY BE SWALLOWED: This used to be one `try` around both calls with
     * an empty `catch`, and the comment claimed the verb "stays queued". It did not: `dispatch` has already removed
     * `p` from the queue by the time it calls here, so a failed write left the verb in NEITHER collection and nowhere
     * in memory — gone, silently, which is precisely the loss the abandoned collection exists to prevent. WRITE FAILS
     * ⇒ stay queued, for real. Put `p` back on the queue and re-persist it. The verb keeps its (exhausted) attempt
     * count, so it will try to abandon again on the next drive and succeed once storage recovers; until then it is a
     * live verb, which is recoverable, rather than a lost one, which is not.
     */

    /**
     * DELETE FAILS ⇒ both rows persist, and that is the tolerable half: the boot resolver (`restoreOutbox`) deletes
     * an abandoned twin of anything still queued, so the pair converges on the LIVE row — a verb that runs again
     * rather than one that vanished. The order here is chosen for exactly that: write first, delete second, so a
     * crash between them lands in the recoverable state.
     */
    /**
     * ONE TRANSACTION, BOTH KEYS: When this resolves, disk, memory, `this.queue`, `overlays`, `awaitingEcho` and
     * `abandoned()` all agree that `p` is abandoned. When it rejects, NONE of them has changed and `p` is back on the
     * queue with its attempts intact — so no interleaving of abort, process death or a concurrent flush can leave a
     * verb in both collections, in neither, or in one on disk and the other in memory. This was two best-effort
     * writes with an ordering argument between them ("write first, so a crash lands on the recoverable side"). The
     * argument was sound and the premise was not: `putLocal` publishes to memory BEFORE its flush can reject, so a
     * refused write left the row live in memory and in the unflushed set, where the next flush persisted it — twins
     * on disk, and a strip offering Retry on a verb still executing.
     */

    /**
     * `commitLocal` removes the window rather than reasoning about which side of it is safer.
     */
    try {
      await this.store.commitLocal(
        [{ type: OUTBOX_ABANDONED_TYPE, id: p.id, entity: record }],
        [{ type: OUTBOX_TYPE, id: p.id }],
      );
    } catch {
      // Nothing moved. The verb goes back on the queue where it was, with its attempts, and waits
      // out a full cap before trying again — a store that just refused will not accept the next
      // write a millisecond later either.
      p.nextAt = this.now().getTime() + OUTBOX_BACKOFF_CAP_MS;
      this.queue.push(p);
      return { id: p.id, key: p.key, status: "queued", seq: null, error: reported };
    }

    this.overlays.delete(p.id);
    this.awaitingEcho.delete(p.id);
    this.overlayRev++;
    this.notify();
    return { id: p.id, key: p.key, status: "rolled_back", seq: null, error: reported };
  }

  /**
   * THE VERBS THIS CLIENT GAVE UP ON — newest first, for the status strip and its sheet.
   *
   * Read straight from the mirror rather than from memory, so it is correct on the first render
   * after a boot, when nothing has been dispatched yet and the only evidence is on disk.
   */
  abandoned(): AbandonedMutation[] {
    /**
     * KEYED ON THE STORE'S VERSION, NOT INVALIDATED BY HAND: Value-cached because `useSyncExternalStore` compares
     * snapshots by identity: a method that allocates a fresh array per call re-renders for ever. But the invalidation
     * used to be eleven `abandonedCache = null` lines placed by hand, and one of them was a boot-path line that moved
     * THREE times — each move answered by a review finding an earlier return in front of it. That is not a bug that
     * gets fixed by a fourth move; it is a rule that cannot be maintained by placement. Every store write bumps `ver`
     * — `putLocal`, `commitLocal`, `prune`, `applyResponse`, `resetForBootstrap`, `adoptWipedBaseline`, `load()` — so
     * keying on it means a boot latch, a 410, a cross-tab adoption or a rejected commit can never leave this stale,
     * and there is no line left to position wrongly. The same pattern `bucketsOf` and `search()` already use.
     */

    /**
     * The previous array's identity is kept when the rebuilt list is field-equal, so an ordinary /sync page — which
     * bumps `ver` without touching this collection — does not re-render the strip.
     */
    // The store's version AND the session-local refusals: a refusal the store would not accept
    // changes no row and no version, so keying on `ver` alone would serve the pre-refusal row for
    // ever. See {@link refusedLocally}.
    const v = this.store.version() * 1_000_003 + this.localRefusalRev;
    if (this.abandonedCache !== null && this.abandonedCache.v === v) return this.abandonedCache.out;
    const out: AbandonedMutation[] = [];
    // The store's rows, plus any terminal outcome this session could not write — ONE reader, see
    // {@link abandonedRows}.
    for (const row of this.abandonedRows()) {
      const e = row.entry;
      out.push({
        id: e.id, key: e.key, mutation: e.mutation, at: e.at,
        attempts: e.attempts ?? OUTBOX_MAX_SERVER_FAILURES,
        error: e.lastError ?? { message: "the server did not accept this change", code: null, status: null },
        superseded: e.superseded === true,
        retryable: e.superseded !== true
          && e.retryRefused === undefined
          && !this.refusedLocally.has(row.id),
        refusedCode: e.retryRefused
          ?? this.refusedLocally.get(row.id)
          ?? (e.superseded === true ? "outbox_superseded" : null),
      });
    }
    const next = out.sort((a, b) => b.at - a.at);
    const prev = this.abandonedCache?.out;
    const same = prev !== undefined
      && prev.length === next.length
      && prev.every((p, i) => {
        const n = next[i]!;
        return p.id === n.id && p.superseded === n.superseded && p.retryable === n.retryable
          && p.attempts === n.attempts && p.error.code === n.error.code
          && p.error.message === n.error.message;
      });
    this.abandonedCache = { v, out: same ? prev : next };
    return this.abandonedCache.out;
  }

  /**
   * Put one given-up verb back — under its ORIGINAL Idempotency-Key, through the one dispatch road. It RETURNS the
   * result: it answered a boolean once, and a retried send answering `send_unverified` showed nothing — no warning,
   * no record, a person free to press send again on mail that may already have left; the sheet row is the only thing
   * waiting, so the row is where the answer lands. One record, and only this record: queue-wide `flushPending()`
   * ignored every client backoff, so retrying A dispatched unrelated Q early and could spend Q's last attempt — a
   * foreground press compressing another verb's hour of patience into seconds; now it dispatches exactly `p` under
   * the same `outboxGate`.
   */

  /**
   * Order of operations, each step chosen for its failure: refuse first (record flagged un-retryable so the button
   * stops lying); rebuild the overlay (intent visible while the request is open); `putOutbox`, which THROWS here (the
   * abandoned row is about to be deleted, and losing both has no recovery); only then prune, then dispatch.
   */

  async retryAbandoned(id: string): Promise<MutationResult> {
    const live = this.retrying.get(id);
    if (live !== undefined) return live;
    const run = this.retryAbandonedOnce(id);
    this.retrying.set(id, run);
    return run.finally(() => { this.retrying.delete(id); });
  }

  protected async retryAbandonedOnce(id: string): Promise<MutationResult> {
    const refuse = async (
      e: PersistedOutboxEntry | null, code: string, message: string,
    ): Promise<MutationResult> => {
      if (e) {
        // Flagged on disk: a refusal that leaves the control offering itself is a button whose
        // every press is a silent no-op, which is worse than no button.
        try {
          await this.store.commitLocal(
            [{ type: OUTBOX_ABANDONED_TYPE, id: e.id, entity: { ...e, retryRefused: code } }], []);
          this.notify();
        } catch {
          /**
           * THE DURABLE MARKER WAS REFUSED, SO HOLD IT IN MEMORY INSTEAD.
           *
           * This catch used to say "the in-memory refusal below still stands for this session"
           * and there was no such thing: `abandoned()` derives from the store's version, a
           * refused commit changes neither the record nor the version, and the next read returned
           * the same cached row with `retryable: true`. The control the refusal exists to disable
           * stayed enabled, and every press was another silent no-op — the exact thing the line
           * above calls worse than no button. A comment is a claim, and this one was false.
           */
          this.refusedLocally.set(e.id, code);
          this.localRefusalRev++;
          this.notify();
        }
      }
      return {
        id, key: e?.key ?? id, status: "rolled_back", seq: null,
        error: new MutationRejectedError(message, { code, retryable: false }),
      };
    };

    // Disk OR the session-local fallback — see `abandonedRecordOf`. Reading disk alone meant a
    // record whose terminal transition could not be written was listed with a Retry that answered
    // "this build cannot retry that", because the row it looked for was only ever in memory.
    const e = this.abandonedRecordOf(id);
    if (e === null) {
      return refuse(null, "outbox_unknown_kind", "This change cannot be retried by this version.");
    }
    if (e.superseded === true) {
      return refuse(e, "outbox_superseded", "A newer change to the same thing has since been saved.");
    }
    if (pastCreateDedupe(e, this.now().getTime())) return refuse(e, "outbox_expired", OUTBOX_EXPIRED_MESSAGE);

    const p: PendingMutation = {
      id: e.id, key: e.key, mutation: e.mutation, at: e.at, n: e.n,
      restored: true, attempts: 0,
      // Try again on a record whose create went out unread is still not a second create.
      ...(e.createAttempted === true ? { createAttempted: true } : {}),
      ...(e.mutation.kind === "mail_send" && isCreatedRow(e.createdRow) ? { createdRow: e.createdRow } : {}),
      // A Send + Done given up on and tried again still files its source once it is confirmed.
      ...andDoneOf(e),
      // An owed Cancel tried again asks the withdraw, never the send.
      ...(e.mutation.kind === "mail_send" && e.withdrawOwed === true ? { withdrawOwed: true as const } : {}),
      ...(persistedWired(e) ? { wired: true as const } : {}),
    };

    /**
     * The overlay, rebuilt AT THE INSTANT THE VERB WAS EXPRESSED — not now — so a re-applied triage or read state
     * carries its original stamp rather than pretending to be fresh. WRAPPED, BECAUSE A KIND THIS BUILD DOES NOT KNOW
     * REACHES HERE. The persisted-shape gate accepts any string as a kind — deliberately, so a row written by a NEWER
     * build survives rather than being discarded — and `mutationEffects` has no runtime default, so it answers
     * `undefined` and the next line reads `.length` off it. The row is then unretryable by crashing rather than by
     * saying so, which is the one outcome the coded refusal exists to prevent. The version guard nearby only covers
     * unknown VERSIONS; this is a known version carrying an unknown verb, and nothing was checking it.
     */
    let built: MutationEffect[] | undefined;
    try {
      // The cast is the point: the signature promises an array because the switch is exhaustive
      // over the KNOWN union, and a persisted row's kind is a plain string that need not be in it.
      built = this.paintOf(e.mutation, e.key, () => new Date(e.at)) as MutationEffect[] | undefined;
    } catch {
      return refuse(e, "outbox_unknown_kind", "This change cannot be retried by this version.");
    }
    // BEFORE any default. Writing `?? []` here — which the first cut did — masks the exact
    // condition being detected: the verb then produces no overlay, no refusal and no crash, and
    // goes to the wire as though it were an ordinary no-effect mutation.
    if (built === undefined) {
      return refuse(e, "outbox_unknown_kind", "This change cannot be retried by this version.");
    }
    const effects = built;
    if (effects.length > 0) this.overlays.set(p.id, effects);
    this.overlayRev++;
    this.notify();

    /**
     * ONE TRANSACTION, the other way round: the live row appears and the abandoned row goes, or
     * neither happens. A rejection leaves the record exactly where the person can still see it —
     * which is what makes `storage_refused` an honest answer rather than a hopeful one.
     *
     * The previous shape wrote the live row, then pruned the abandoned one, and reported refusal
     * if the write threw. But the write had already installed the row in memory and in the
     * unflushed set, so a later unrelated flush persisted a verb the person had been told could
     * not be saved — and a reboot replayed it.
     */
    try {
      await this.store.commitLocal(
        [{
          type: OUTBOX_TYPE,
          id: p.id,
          // The whole intent: the created row, the unread create and Send + Done ride a kill.
          entity: { ...outboxEntryOf(p), attempts: 0 } satisfies PersistedOutboxEntry,
        }],
        [{ type: OUTBOX_ABANDONED_TYPE, id: p.id }],
      );
    } catch {
      this.overlays.delete(p.id);
      this.overlayRev++;
      this.notify();
      return {
        id, key: e.key, status: "rolled_back", seq: null,
        error: new MutationRejectedError(
          "This change could not be saved on this device. Try again once there is room.",
          { code: "storage_refused", retryable: false },
        ),
      };
    }
    /**
     * THE SESSION-LOCAL FALLBACK GOES WITH THE ROW — see {@link abandonedRows}. Retry left it
     * behind, so a record that HAD been retried successfully was listed as abandoned again the
     * moment anything re-rendered, offering a second Try again for a verb already back in the
     * queue. Only after the transaction: a refused retry leaves the record exactly where it was.
     */
    if (this.abandonedLocally.delete(p.id)) this.localRefusalRev++;

    /* The press ends a hold a hung write left once the server cannot still be working on it, and that
       write goes first when it was made first; before that it waits its turn behind it, on the queue
       as the held answer below — see {@link endHold}. */
    let ended: string | null = null;
    if (this.outboxHold) {
      const gone = await this.endHold();
      if (gone === null) {
        this.queue.push(p);
        return { id: p.id, key: p.key, status: "queued", seq: null };
      }
      ended = gone.ended;
    }
    const { ahead, out } = await this.outboxGate(async () => {
      const first = await this.dispatchEndedFirst(ended, p);
      return { ahead: first, out: await this.dispatchOnLane(p) };
    });
    if (ahead !== null) void this.settleReconcile("background");
    if (out.held) {
      /**
       * A hold was armed while this press waited its turn. Dispatching behind a request still on the wire is the
       * reordering the barrier exists to stop, so the press answers instead of joining the race. AND THE VERB GOES ON
       * THE QUEUE, which the first cut of this branch forgot. By this point the record has already moved to the live
       * collection on disk — that happens before the dispatch — so returning `queued` without queueing it left the
       * verb in no collection this session held: not on the wire, not in `this.queue`, not in `abandoned()`. It would
       * have come back on the next boot from its durable row, which is exactly the kind of "not really lost" that
       * means a person watches their action do nothing until they restart the app.
       */
      this.queue.push(p);
      return { id: p.id, key: p.key, status: "queued", seq: null };
    }
    if (out.timedOut || out.result === null) {
      // The in-flight attempt owns the entry from here; `outboxHold` is the barrier.
      return { id: p.id, key: p.key, status: "queued", seq: null };
    }
    await this.settleReconcile(out.owed);
    return out.result;
  }

  /**
   * Throw an abandoned verb away for good. The overlay is long gone; this clears the record — and
   * the LIVE ROW IT CAME FROM, in the same transaction.
   *
   * Discard used to delete the abandoned row alone. For a record whose terminal transition could
   * not be written, the live `OUTBOX_TYPE` row is still on disk and is what the next boot REPLAYS
   * — so the person pressed Discard, watched the row go, and the verb they had thrown away went
   * out anyway on the next launch. A refused transaction leaves the record listed rather than
   * removing it from a surface while the verb it names is still queued on disk.
   */
  async discardAbandoned(id: string): Promise<void> {
    try {
      await this.store.commitLocal([], [
        { type: OUTBOX_ABANDONED_TYPE, id },
        { type: OUTBOX_TYPE, id },
      ]);
    } catch {
      return; // nothing removed, nothing claimed — the row stands and says so.
    }
    // AND THE SESSION-LOCAL COPY, or Discard is a control that visibly does nothing: a record
    // whose terminal transition could not be written lives only in `abandonedLocally`.
    if (this.abandonedLocally.delete(id)) this.localRefusalRev++;
    this.notify();
  }

  /**
   * A newer verb retires the queued older verb it supersedes — user-always-wins applied to the outbox itself: a
   * queued `mark_seen(read)` replayed after the user's newer `mark_seen(unread)` committed would put the SERVER back
   * at the older value, so retiring it IS honoring their latest word — for the drive's replay and `flushPending`
   * alike.
   */

  /**
   * What "supersedes" may mean, deliberately narrow: SAME KIND, SAME SCALAR TARGET ({@link supersedeKey}) —
   * absolute-valued verbs where the newer value is the whole intent (`tag_assign` keys on the MESSAGE alone: its
   * enriched `labels` already carries the union); READ-FLAG ID SUBTRACTION — a newer `mark_seen` subtracts its ids
   * from queued `mark_seen` AND `feed_mark_seen`, a newer `feed_mark_seen` only from `feed_mark_seen` (a glance must
   * never cancel a queued deliberate unread) — rewriting a narrowed body under the SAME key is safe on exactly these
   * routes (`PATCH /messages` stores no idempotency row); and NOTHING ELSE — cross-kind conflicts converge through
   * the server's write ownership, `mail_send` is never touched, creates supersede nothing.
   */
  /**
   * A NEWER VERB ALSO RETIRES AN ABANDONED RECORD FOR THE SAME TARGET — marked, never deleted. `supersedeQueued`
   * protects the QUEUE from a stale replay. The abandoned list needed the same protection and did not have it: draft
   * body B is abandoned, body C saves successfully, and pressing Try again on B re-queues it under its original key
   * and overwrites C. The user asked to retry something they could not see was stale, and lost the newer text. MARKED
   * rather than deleted, and that is the whole judgement here. Deleting would silently throw away work a person can
   * still see listed — the failure this collection exists to prevent. So the record stays, `retryAbandoned` refuses
   * it, and the surface says a newer change to the same thing has since been saved, leaving Discard as the honest
   * remaining answer.
   */

  /**
   * Same key rule as the queue's (`supersedeKey`), so the two cannot come to disagree about what "the same target"
   * means. `null` keys — creates, sends, the read-flag list verbs — never participate, exactly as they do not in the
   * queue.
   */
  protected planAbandonedSupersession(m: EngineMutation): AbandonedMark[] {
    const key = targetOf(m);
    const readIds = m.kind === "mark_seen" || m.kind === "feed_mark_seen"
      ? new Set(m.messageIds ?? [])
      : null;
    /** The rows this verb would mark — WRITTEN BY THE CALLER, in the replacement's own transaction. */
    const marks: AbandonedMark[] = [];
    if (key === null && readIds === null) return marks;

    for (const row of this.abandonedRows()) {
      const e = row.entry;
      if (e.superseded === true) continue;

      let next: PersistedOutboxEntry | null = null;
      if (readIds !== null) {
        /**
         * A newer read-flag verb SUBTRACTS ids, exactly as the queue's version does — it does not
         * merely retire on total coverage. A record covering Giulia and Petra, met by a newer
         * verb naming Giulia alone, used to be left completely untouched: pressing Try again then
         * re-applied the newer verb's own id along with the one it still owed, undoing what the
         * person had just done. Narrowing keeps the part nothing else will deliver and drops the
         * part that is now stale.
         */
        const om = e.mutation;
        const older = om.kind === "mark_seen" || om.kind === "feed_mark_seen"
          ? (om.messageIds ?? [])
          : null;
        if (older === null || older.length === 0) continue;
        /**
         * THE EXPLICIT/GLANCE RULE, WHICH THIS BRANCH USED TO SKIP ENTIRELY. The queue's own supersession has always
         * applied it: an EXPLICIT read verb outranks both queued read verbs, while a glance — an involuntary read,
         * the dwell commit or a feed departure — outranks only other involuntary reads. It must never cancel a
         * deliberate unread, because a person marking something unread has said something a passing glance did not.
         * Abandoned rows were subtracted by ANY newer read verb regardless. So a deliberate `mark_seen(unread: true)`
         * that had been given up on could be narrowed to nothing — and marked superseded, taking its Retry with it —
         * by a later glance over the same message. The record vanished, and the state the person actually asked for
         * was never delivered.
         */

        /**
         * A glance can only ever READ, so the VALUE takes part in the classification and not the label alone: a
         * mislabelled mark-unread still outranks a queued stale read.
         */
        const newerExplicit = m.kind === "mark_seen" && (m.via !== "glance" || m.unread === true);
        const olderInvoluntary = om.kind === "feed_mark_seen"
          || (om.kind === "mark_seen" && om.via === "glance" && om.unread === false);
        if (!newerExplicit && !olderInvoluntary) continue;
        const remaining = older.filter((id) => !readIds.has(id));
        if (remaining.length === older.length) continue; // no overlap at all
        next = remaining.length === 0
          ? { ...e, superseded: true }
          : { ...e, mutation: (om.kind === "mark_seen" ? narrowRead(om, remaining) : { ...om, messageIds: remaining }) as EngineMutation };
      } else if (retiresAbandoned(m, e.mutation)) {
        next = { ...e, superseded: true };
      }
      if (next === null) continue;

      marks.push({ id: row.id, entry: next, durable: row.durable });
    }
    return marks;
  }

  /**
   * THE REPLACEMENT AND EVERY MARK IT MAKES, IN ONE TRANSACTION AND ON ONE LANE.
   *
   * Two defects, one shape. **Atomicity**: each abandoned marker used to be its own `commitLocal`,
   * written before the replacement's, and rolled back by hand when the replacement was refused —
   * so a marker that committed while a sibling (or the replacement, or the rollback) failed left
   * an older record marked superseded for a verb that never happened, its Retry gone for good; a
   * process killed between the two writes had the same outcome and no rollback to attempt. One
   * transaction makes the partial state unrepresentable, which is why `undoMarkers` is gone rather
   * than hardened. **Lost updates**: `commitLocal` publishes to memory only when its transaction
   * RESOLVES, so two verbs narrowing the same abandoned read record both read `{A,B}` and wrote
   * `{B}` and `{A}` — one stale fragment survived, and Try again re-applied an id the newer verb
   * had already delivered. The lane is the serialization: the second verb PLANS its marks after
   * the first verb's transaction has landed, so it re-derives from `{B}` and narrows to nothing.
   */
  protected commitReplacement(
    p: PendingMutation,
    superseded: SupersedeEffect,
  ): Promise<{ persisted: boolean; marks: number }> {
    return this.onOutboxWriteLane(async () => {
      const marks = this.planAbandonedSupersession(p.mutation);
      try {
        await this.store.commitLocal(
          [
            { type: OUTBOX_TYPE, id: p.id, entity: outboxEntryOf(p) },
            ...superseded.narrowed.map((q) => ({ type: OUTBOX_TYPE, id: q.id, entity: outboxEntryOf(q) })),
            ...marks.filter((mk) => mk.durable)
              .map((mk) => ({ type: OUTBOX_ABANDONED_TYPE, id: mk.id, entity: mk.entry })),
          ],
          (p.retire ?? []).map((id) => ({ type: OUTBOX_TYPE, id })),
        );
      } catch {
        // Storage refused — what that costs depends on the verb; see `mutate`. Nothing was
        // written, so nothing is marked and there is nothing to put back.
        return { persisted: false, marks: marks.length };
      }
      // Only now: a commit that did not happen has retired nothing, and the next write of this
      // verb must carry them again.
      delete p.retire;
      /**
       * A FALLBACK RECORD'S MARK IS A MEMORY WRITE, and it is made HERE rather than in the plan:
       * the record lives only in memory because its own terminal write was refused, so there is no
       * durable half to be atomic with — but it must still not be marked on behalf of a
       * replacement that was refused, which is exactly what planning-then-writing gives it.
       */
      const local = marks.filter((mk) => !mk.durable);
      for (const mk of local) this.abandonedLocally.set(mk.id, mk.entry);
      if (local.length > 0) this.localRefusalRev++;
      if (marks.length > 0) this.notify();
      return { persisted: true, marks: marks.length };
    });
  }

  protected openReplacement(id: string): () => void {
    let settle!: () => void;
    this.replacementWrites.set(id, new Promise<void>((r) => { settle = r; }));
    return () => { this.replacementWrites.delete(id); settle(); };
  }

  /** Resolves once that replacement's marks are final; at once for one already decided. */
  protected replacementDecided(id: string): Promise<void> {
    return this.replacementWrites.get(id) ?? Promise.resolve();
  }

  protected onOutboxWriteLane<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.outboxWriteLane.then(fn, fn);
    this.outboxWriteLane = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * THE STALE ROWS ARE RETIRED BY THE NEWER VERB'S OWN TRANSACTION: This used to call `dropOutbox` per retired entry
   * — a memory-first `prune` whose failure is swallowed. Round four found what that costs: memory drops the older
   * verb, the newer verb goes on the wire, the purge fails, the newer row's own write fails too, the process dies,
   * and disk holds ONLY the stale verb. The next boot replays it over the state the newer one established, and both
   * requests reported success. The carve-out that let `dropOutbox` stay on `prune` was argued for a LONE TERMINAL
   * DELETE, where memory-first fails safe: gone from memory, still on disk, replayed under the same key. Supersession
   * is not that. Its delete is one half of a replacement, and the direction that fails safe for a terminal delete is
   * exactly the wrong one here.
   */

  /**
   * So the ids are returned instead, and the caller retires them in the SAME transaction that writes the newer row —
   * the durable set holds both, or the newer one, and never the stale one alone. If that transaction is refused,
   * nothing was removed and the stale rows simply replay, which is the behaviour a storage-refused verb already has.
   */
  protected supersedeQueued(m: EngineMutation, by: string, sendKey: string): SupersedeEffect {
    const retired: string[] = [];
    const narrowed: PendingMutation[] = [];
    /** Everything this call changed, kept so a refused replacement can put it all back. */
    const undo: Array<{ entry: PendingMutation; index: number; mutation: EngineMutation }> = [];
    /**
     * THE ABANDONED HALF IS NOT DECIDED HERE ANY MORE — see {@link OhmailEngine.commitReplacement}.
     *
     * It was `void this.supersedeAbandoned(m)`, then a promise handed back and awaited before the
     * dispatch. Both shapes wrote the markers in their own transactions, ahead of the replacement,
     * and needed a hand-written rollback that could itself fail. The marks are PLANNED and written
     * with the replacement now, so a refused replacement has marked nothing and there is nothing
     * to put back; and the plan is made on the write lane, so two verbs cannot both narrow one
     * record from the same stale read.
     */
    const key = supersedeKey(m);
    const reads = m.kind === "mark_seen" || m.kind === "feed_mark_seen";
    /**
     * A verb on the wire is MARKED, not removed — there is nothing to remove it from: its request is running, and the
     * newer verb cannot un-send it. What the mark does is keep the older verb from rejoining the queue when its
     * request comes back retryable — replaying it would put the older value over the newer one that has since landed.
     * The wire is scanned BEFORE the empty-queue return, and that order is the rule: a verb whose request outran its
     * deadline belongs to NO collection but {@link inFlight}, so the queue can be EMPTY while a verb is on the
     * wire — the scan below that return was unreachable in the one case it was written for, and the first
     * move-then-move-back read `queue.length === 0`, marked nothing, and the older destination replayed over the
     * newer intent with both requests reporting success.
     */
    const markedInFlight: PendingMutation[] = [];
    let createAttempted = false;
    let createdRow: CreatedDraftRow | undefined;
    for (const q of this.inFlight.values()) {
      if (q.supersededBy !== undefined) continue;
      /* ONE KEY, ONE SEND, ON THE WIRE: a send re-pressed under the key of the send in the air is
         that send. Marked, never retired — the wire entry owns its row until it settles; a
         retryable answer then drops it and the newer words go under the same key, and a confirmed
         one is answered for the newer press from the server's reservation. */
      const sameSend = m.kind === "mail_send" && q.mutation.kind === "mail_send" && q.key === sendKey;
      if (sameSend || (q.mutation.kind === m.kind && key !== null && supersedeKey(q.mutation) === key)) {
        q.supersededBy = by;
        // Only what THIS call marked. An entry an EARLIER supersession marked is superseded by a
        // verb that is still standing (it is in the queue, and a refused replacement puts it
        // back), so clearing it on this refusal would resurrect a verb the queue already replaces.
        markedInFlight.push(q);
        if (sameSend && q.createAttempted === true) createAttempted = true;
        if (sameSend && q.createdRow !== undefined) createdRow = q.createdRow;
      }
    }
    /* A READ ON ITS WAY TO THE WIRE OR ON IT carries no key, so the scan above misses it: a person's
       read or unread on its letters is recorded on it (`readsTaken`), and only what that leaves of it
       is sent, or sent again. The newest press wins per letter, whoever made the older read. */
    const takenOnWire: Array<{ entry: PendingMutation; by: string }> = [];
    if (explicitRead(m)) {
      for (const q of new Set([...this.inFlight.values(), ...this.freshReads])) {
        if (readLeftBy(m, q.mutation) === undefined) continue;
        (q.readsTaken ??= new Map()).set(by, m);
        takenOnWire.push({ entry: q, by });
      }
    }
    const carried = {
      ...(createAttempted ? { createAttempted: true as const } : {}),
      ...(createdRow !== undefined ? { createdRow } : {}),
    };
    if (this.queue.length === 0) return { retired, narrowed, undo, markedInFlight, takenOnWire, ...carried };
    let changed = false;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i]!;
      const qm = q.mutation;
      /* ONE KEY, ONE SEND. A send expressed again under a queued send's Idempotency-Key IS that
         send — the caller resumed the key — and the newer words are its whole intent. Replaying the
         older verb too made a second draft row, answered from the same reservation. It carries a
         create the older verb could not read, so a reload's fresh adapter does not make another. */
      if (m.kind === "mail_send" && qm.kind === "mail_send" && q.key === sendKey) {
        undo.push({ entry: q, index: i, mutation: qm });
        this.queue.splice(i, 1);
        this.overlays.delete(q.id);
        retired.push(q.id);
        if (q.createAttempted === true) createAttempted = true;
        if (q.createdRow !== undefined) createdRow = q.createdRow;
        changed = true;
        continue;
      }
      // Whole-entry replacement: same kind, same scalar target.
      if (key !== null && supersedeKey(qm) === key) {
        undo.push({ entry: q, index: i, mutation: qm });
        this.queue.splice(i, 1);
        this.overlays.delete(q.id);
        retired.push(q.id);
        changed = true;
        continue;
      }
      // Read-flag subtraction, by the rule a queued read shares with one on the wire (`readLeftBy`).
      if (reads && (qm.kind === "mark_seen" || qm.kind === "feed_mark_seen")) {
        const left = readLeftBy(m, qm);
        if (left === undefined) continue;
        if (left === null) {
          undo.push({ entry: q, index: i, mutation: qm });
          this.queue.splice(i, 1);
          this.overlays.delete(q.id);
          retired.push(q.id);
        } else {
          undo.push({ entry: q, index: i, mutation: qm });
          q.mutation = left;
          try {
            const effects = this.paintOf(q.mutation, q.key, () => new Date(q.at));
            if (effects.length > 0) this.overlays.set(q.id, effects);
            else this.overlays.delete(q.id);
          } catch { this.overlays.delete(q.id); }
          // NOT a separate best-effort write any more — see `SupersedeEffect.narrowed`. It rides
          // the replacement's transaction, so disk cannot hold one without the other.
          narrowed.push(q);
        }
        changed = true;
      }
    }
    if (changed) {
      this.overlayRev++;
      this.notify();
    }
    return {
      retired, narrowed, undo, markedInFlight, takenOnWire,
      ...(createAttempted ? { createAttempted: true as const } : {}),
      ...(createdRow !== undefined ? { createdRow } : {}),
    };
  }

  /**
   * PUT BACK EVERYTHING A SUPERSESSION CHANGED — see the no-write-no-wire rule in the header. A replacement whose
   * durable write was refused never happens: it does not reach the wire, and the verbs it would have retired are
   * still the truth. Disk already agrees, because the refused transaction removed nothing; this is memory catching up
   * with it, so the two do not disagree for the rest of the session. Overlays are rebuilt at the verb's ORIGINAL
   * stamp rather than now, for the reason `retryAbandoned` rebuilds them that way: a restored triage or read state
   * carries the moment it was expressed, not the moment the store happened to fail.
   */
  protected undoSupersede(effect: SupersedeEffect): void {
    /**
     * THE WIRE'S MARKS GO BACK TOO, AND BEFORE THE EARLY RETURN BELOW.
     *
     * `undo` is EMPTY whenever the queue was empty, and an empty queue is exactly the state the
     * wire scan above it exists for — so a `return` on `undo.length === 0` would skip the only
     * case where a mark is the sole thing this supersession changed. That road is reachable and
     * built: "round eight … (1) a refused replacement does not drop the verb it had marked on the
     * wire" in `outbox-lifecycle.test.ts`, red with this line removed.
     */
    for (const q of effect.markedInFlight) delete q.supersededBy;
    for (const { entry, by } of effect.takenOnWire) entry.readsTaken?.delete(by);
    if (effect.undo.length === 0) return;
    for (const { entry, mutation } of effect.undo) {
      entry.mutation = mutation;
      if (!this.queue.includes(entry)) this.queue.push(entry);
      const effects = this.paintOf(mutation, entry.key, () => new Date(entry.at));
      if (effects.length > 0) this.overlays.set(entry.id, effects);
    }
    this.queue.sort((a, b) => (a.at - b.at) || (a.n - b.n));
    this.overlayRev++;
    this.notify();
  }

  /**
   * `deferReconcile` is the boot replay's mode ({@link OhmailEngine.replayOutbox}): the caller
   * is INSIDE the single-flight drive, so the per-mutation `syncFresh()` would deadlock on the
   * drive's own promise — and is redundant anyway, because the drain that follows the replay in
   * the same drive begins after every replayed POST returned and therefore carries every echo.
   * In this mode a confirmed no-echo mutation registers in {@link awaitingEcho} instead of
   * draining, and that following drain's success is what retires its overlay.
   */
  protected async dispatch(
    p: PendingMutation,
    opts: { deferReconcile?: boolean; onReconcileDeferred?: (mode: "await" | "background") => void } = {},
  ): Promise<MutationResult> {
    const r = await this.dispatchOnce(p, opts);
    this.noteKeptRow(p.key, r);
    if (p.mutation.kind === "mail_send" && r.status === "confirmed" && p.createdRow !== undefined) {
      this.confirmedRows.delete(p.key);
      this.confirmedRows.set(p.key, p.createdRow);
      if (this.confirmedRows.size > 64) this.confirmedRows.delete(this.confirmedRows.keys().next().value!);
    }
    return p.mutation.kind === "mail_send" ? await this.oneSpeaker(p, r) : r;
  }

  /** Queued edits kept as new drafts this session — see {@link KeptAsNewDraft}. Newest last. */
  keptAsNewDrafts(): readonly KeptAsNewDraft[] {
    return this.keptAsNew;
  }

  /**
   * THE WORDS OF A REFUSED WAITING EDIT, RE-ISSUED AS A CREATE: the create takes the edit's place on
   * the outbox in one transaction (replayed by any drive, like a restored entry), goes to the wire at
   * once, and {@link keptAsNewDrafts} says so. The edit's own answer stays the refusal.
   */
  protected async keepAsNewDraft(
    p: PendingMutation, from: string, rejection: MutationRejectedError,
    opts: { deferReconcile?: boolean; onReconcileDeferred?: (mode: "await" | "background") => void },
  ): Promise<MutationResult> {
    const { ifContentRevision: _stated, ...words } = p.mutation as Extract<EngineMutation, { kind: "draft_save" }>;
    // What an edit leaves to its row (the sender, the thread, the forwarded message) comes from it.
    const was = this.store.get<EngineDraft>("draft", from);
    const create = this.enrich({
      ...words, draftId: null,
      ...(words.mailboxId === undefined && was?.mailboxId ? { mailboxId: was.mailboxId } : {}),
      ...(words.threadId === undefined && was?.threadId ? { threadId: was.threadId } : {}),
      ...(words.inReplyToMessageId === undefined && was?.inReplyToMessageId ? { inReplyToMessageId: was.inReplyToMessageId } : {}),
      ...(words.forwardOfMessageId === undefined && was?.forwardOfMessageId ? { forwardOfMessageId: was.forwardOfMessageId } : {}),
    });
    const q: PendingMutation = {
      id: this.uuid(), key: this.uuid(), mutation: create, at: p.at, n: p.n, restored: true,
      ...(this.ownerName !== null ? { owner: this.ownerName } : {}),
    };
    this.overlays.set(q.id, this.paintOf(create, q.key, this.now));
    let swapped = true;
    try {
      await this.store.commitLocal([{ type: OUTBOX_TYPE, id: q.id, entity: outboxEntryOf(q) }], [{ type: OUTBOX_TYPE, id: p.id }]);
    } catch {
      swapped = false; // the edit stays on disk: a later boot replays it, and is refused into this again
    }
    this.keptCreates.set(q.key, p.key);
    this.keptAsNew = [...this.keptAsNew.slice(-31), { key: p.key, from, row: null }];
    this.overlayRev++;
    this.notify();
    const r = await this.dispatchOnce(q, opts);
    this.noteKeptRow(q.key, r);
    if (!swapped && r.status === "confirmed") await this.dropOutbox(p.id);
    return { id: p.id, key: p.key, status: "rolled_back", seq: null, error: rejection };
  }

  /** A kept create the server made: its row joins the entry. */
  protected noteKeptRow(key: string, r: MutationResult): void {
    const edit = this.keptCreates.get(key);
    if (edit === undefined || r.status !== "confirmed" || !r.entityId) return;
    this.keptCreates.delete(key);
    const row = r.entityId;
    this.keptAsNew = this.keptAsNew.map((k) => (k.key === edit ? { ...k, row, ...(r.revision ? { revision: r.revision } : {}) } : k));
    this.notify();
  }


  /**
   * ONE KEY, ONE SPEAKER — the newest press. A send confirmed while a newer press under its key
   * stands answers `superseded`, and its confirmation waits with that press: the newer press
   * confirms and speaks for the key, or it ends without a delivery of its own (refused, withdrawn)
   * and the earlier confirmation speaks instead — as the earlier words, when the two differ.
   */
  protected async oneSpeaker(p: PendingMutation, r: MutationResult): Promise<MutationResult> {
    const waiting = this.silencedConfirms.get(p.id);
    if (r.status === "confirmed") {
      this.silencedConfirms.delete(p.id);
      if (p.supersededBy !== undefined) await this.replacementDecided(p.supersededBy);
      if (p.supersededBy === undefined) return r;
      const spoken = waiting?.result ?? {
        ...r, firstSend: r.firstSend ?? { status: "sent", at: this.now().toISOString() },
      };
      this.silencedConfirms.set(p.supersededBy, { result: spoken, mutation: waiting?.mutation ?? p.mutation });
      return { id: p.id, key: p.key, status: "superseded", seq: null };
    }
    if (waiting === undefined || r.status === "queued") return r;
    this.silencedConfirms.delete(p.id);
    if (r.status === "superseded") {
      if (p.supersededBy !== undefined) this.silencedConfirms.set(p.supersededBy, waiting);
      return r;
    }
    return this.spokenFor(waiting, p.mutation);
  }

  /** The waiting confirmation, said as the earlier words when the press that ended carried others. */
  protected spokenFor(waiting: { result: MutationResult; mutation: EngineMutation }, pressed: EngineMutation): MutationResult {
    const differs = waiting.mutation.kind === "mail_send" && pressed.kind === "mail_send"
      && sendFingerprint(waiting.mutation) !== sendFingerprint(pressed);
    return { ...waiting.result, ...(differs ? { earlierWordsKept: true as const } : {}) };
  }

  /**
   * THE READ WHOSE IDS A PERSON'S READ OR UNREAD TOOK ({@link PendingMutation.readsTaken}),
   * before it is sent or sent again: each mark waits for its verb's write, as a wire mark does
   * ({@link replacementDecided}), and the queue's rule then leaves only the ids none of them names.
   * `false`: nothing is left, and the read's row and paint are gone.
   */
  protected async narrowTaken(p: PendingMutation): Promise<boolean> {
    for (;;) {
      const open = [...(p.readsTaken?.keys() ?? [])].filter((by) => this.replacementWrites.has(by));
      if (open.length === 0) break;
      await Promise.all(open.map((by) => this.replacementDecided(by)));
    }
    const taken = p.readsTaken;
    delete p.readsTaken;
    let left: EngineMutation | null = p.mutation;
    for (const newer of taken?.values() ?? []) {
      if (left === null) break;
      const next = readLeftBy(newer, left);
      if (next !== undefined) left = next;
    }
    if (left === p.mutation) return true;
    if (left === null) {
      await this.dropOutbox(p.id);
      this.overlays.delete(p.id);
      this.overlayRev++;
      this.notify();
      return false;
    }
    p.mutation = left;
    try {
      const effects = this.paintOf(left, p.key, () => new Date(p.at));
      if (effects.length > 0) this.overlays.set(p.id, effects);
      else this.overlays.delete(p.id);
    } catch { this.overlays.delete(p.id); }
    this.overlayRev++;
    this.notify();
    return true;
  }

  protected async dispatchOnce(
    p: PendingMutation,
    opts: { deferReconcile?: boolean; onReconcileDeferred?: (mode: "await" | "background") => void } = {},
  ): Promise<MutationResult> {
    /* THE READ A PERSON'S PRESS TOOK LETTERS FROM while it waited, read here for the
       withdrawal's reason below: only the rest goes, and nothing when none is left. */
    if (p.readsTaken !== undefined && !(await this.narrowTaken(p))) {
      return { id: p.id, key: p.key, status: "superseded", seq: null };
    }
    /**
     * THE WITHDRAWAL IS READ HERE, the line before the wire, because this is the only place every
     * road passes and the only moment at which "is this still wanted?" is a true question. A
     * fresh verb waiting its turn at the gate is in no collection the withdrawal can reach, and
     * reaches the wire unless it is stopped here. Terminal: the overlay and the durable row go, and the refusal names itself so the
     * ledger above says nothing about mail nobody sent.
     */
    /* A CANCEL THE SERVER HAS NOT ANSWERED is asked again here; its send never goes. */
    if (p.mutation.kind === "mail_send" && p.withdrawOwed === true) return this.askOwed(p);
    /* AND ANOTHER WINDOW'S CANCEL, decided on the disk row: see {@link claimForSend}. */
    const claim = this.withdrawnKeys.has(p.key) ? "claimed" : await this.claimForSend(p);
    if (claim === "owed") {
      p.withdrawOwed = true;
      return this.askOwed(p);
    }
    if (claim === "withdrawn") this.withdrawnKeys.add(p.key);
    if (this.withdrawnKeys.has(p.key)) {
      this.overlays.delete(p.id);
      this.overlayRev++;
      this.notify();
      this.sayEnded(p, "withdrawn");
      await this.dropOutbox(p.id);
      return withdrawnResult(p);
    }
    try {
      // A claim the disk could not answer sends nothing this round: the row may carry a Cancel.
      if (claim === "failed") {
        throw new MutationRejectedError("the outbox row could not be read before sending", { code: "network", retryable: true });
      }
      // A claim taken while the browser is offline sends nothing, so a row with no wire fact never left.
      if (claim === "offline") {
        throw new MutationRejectedError("network failure: this device is offline", { code: "network", retryable: true });
      }
      /* THE WIRE FACT, before the request: always in memory, and on disk unless the claim wrote it.
         With no claim (no shared disk, or its lock not granted yet) this put writes it, and a put the
         disk refuses sends nothing this round. A shared row the claim found gone is not re-made. */
      if (p.mutation.kind === "mail_send" && p.wired !== true) {
        p.wired = true;
        if (claim === "unclaimed" && !(await this.putOutbox(p))) {
          delete p.wired;
          throw new MutationRejectedError("the outbox row could not be written before sending", { code: "network", retryable: true });
        }
      }
      /* THE CEILING ON THIS ATTEMPT — see {@link OUTBOX_HOLD_CEILING_MS}. Armed as the call starts; when
         it fires, or a person's Try again ends the wait ({@link endHold}), a write settles as a
         retryable `timeout` and the branch below puts it back under its own key. Its request is
         aborted then, before the queue owns it again: a transport holding it across a renewal must
         not send it beside a newer change, or after a Discard. A send is never ended and carries
         no signal: only its barrier goes, and this attempt settles on its own request's answer. */
      const stop = p.mutation.kind === "mail_send" ? null : abortControllerOrNull();
      const call = this.adapter.mutate(p.mutation, {
        idempotencyKey: p.key,
        ...pressAgeOf(p.mutation, p.at, this.now().getTime()),
        ...(p.createAttempted === true ? { createAttempted: true } : {}),
        ...(p.mutation.kind === "mail_send" ? {
          ...(p.createdRow !== undefined ? { createdRow: p.createdRow } : {}),
          onDraftRow: (row: CreatedDraftRow) => this.recordCreatedRow(p, row),
        } : {}),
        ...(stop !== null ? { signal: stop.signal } : {}),
      });
      call.catch(() => { /* the loser of the ceiling's race has no reader */ });
      let ended = false;
      let end: () => void = () => {};
      const ceiling = new Promise<never>((_resolve, reject) => {
        end = p.mutation.kind === "mail_send"
          ? () => { if (this.holdOwner === p.id) this.holdRelease?.(); }
          : () => {
            if (ended) return;
            ended = true;
            // The rejection first, so a request that rejects at once on the abort cannot win the race.
            reject(noAnswerWithin(this.holdCeilingMs));
            stop?.abort();
          };
      });
      const ceilingTimer = setTimeout(() => end(), this.holdCeilingMs);
      const wire = { since: this.now().getTime(), end };
      this.endWait.set(p.id, wire);
      let outcome: Awaited<typeof call>;
      try {
        outcome = await Promise.race([call, ceiling]);
      } finally {
        ended = true;
        clearTimeout(ceilingTimer);
        if (this.endWait.get(p.id) === wire) this.endWait.delete(p.id);
      }
      /**
       * THE 202 ARM, BEFORE ANYTHING ELSE IN THIS METHOD. Everything below settles: it applies an
       * echo, materialises a Sent copy, or drains and drops the overlay. A queued answer must
       * reach none of it — the server recorded a request for another install and did nothing, so
       * there is no echo to apply, nothing to materialise, and a drain that carries no news is
       * not evidence. It returns its own status instead of joining `confirmed`, which is what the
       * surfaces read to say "Queued for the organizer" rather than "Moved".
       */
      if (outcome.settlement === "queued") return await this.holdForOrganizer(p, outcome);
      /**
       * The happens-before token for {@link awaitingEcho}: any drain whose page loop begins
       * AFTER this line reads a change log that already holds this mutation's rows (the seq
       * argument in {@link OhmailEngine.syncFresh}). Captured HERE — not where a failure is
       * later handled — because `drainEpoch` may have advanced in between, and an epoch read
       * late would let a drain that began BEFORE the POST returned retire the overlay.
       */
      const epochAtConfirm = this.drainEpoch;
      /** A confirm that names another install as the one to act is not shadowed (settleConfirmed). */
      const shadow = !outcome.pendingWith;
      if (p.mutation.kind === "screener_decide" && outcome.entityId) this.rekeyPromotedRule(p.id, outcome.entityId);
      /** Whether the overlay must OUTLIVE this dispatch — set by the two no-echo-yet arms below. */
      let echoPending = false;
      /**
       * The Sent copy is materialised on the server's word and nothing else's — HERE, the line after that word
       * arrives, not below the reconciliation branch. The invariant is unchanged: a send's optimistic effect cannot
       * be taken back, so its Sent row may only ever be a statement the server has already made — `outcome` IS that
       * statement, acted on immediately. It used to sit after `await this.syncFresh()`, so the
       * show-it-in-under-a-second mechanism was gated behind a full drain that can never carry the message it was
       * delaying (the Sent MESSAGE enters the feed minutes later, when the Sent folder is read back) — the symptom
       * was a sent message appearing in the Ohbox a minute late. `notify` fires on its own overlay bump because the
       * whole point is the row on screen before the branch below is entered.
       */
      // Both run, then ONE notify: a frame with the copy in Earlier and its row still held in New is
      // the two-row defect (owner, 2026-09-28).
      const painted = this.materializeSentOverlay(p.mutation, outcome);
      const released = this.endHoldAnswered(p.mutation);
      if (painted || released) {
        this.overlayRev++;
        this.notify();
      }
      if (outcome.changes.length > 0) {
        // Read-your-writes echo (§3.4): idempotent apply — converges with the
        // delta that will arrive at the same seq.
        try {
          this.noteApplied(outcome.changes);
          await this.store.applyChanges(outcome.changes);
        } catch {
          // The SERVER took the write; only the LOCAL apply failed (a torn sqlite flush, a
          // refused IndexedDB transaction). Reporting rolled_back here would be a lie about a
          // committed mutation — the exact inversion this file's send path documents — so the
          // overlay stands as awaiting-echo instead, and the next successful drain (over a
          // store whose own recovery is a reload) retires it.
          this.awaitingEcho.set(p.id, { epoch: epochAtConfirm, m: p.mutation, shadow });
          echoPending = true;
        }
      }
      // A PARTIAL ECHO still drains: the decide's rules are in it, the held mail's moves are not.
      if (outcome.changes.length > 0 && outcome.partialEcho !== true) {
        // The echo is the whole answer.
      } else if (p.mutation.kind === "mail_send") {
        /**
         * A send reconciles in the background, and it is the one kind that may. Every other no-echo mutation needs
         * the drain before it can confirm — its overlay drops on confirm, and the settled row that replaces it comes
         * from that drain. A send has no such row: its overlay is a `sending` DRAFT nothing renders, the message the
         * reader waits for is the Sent copy materialised above, and the delta this drain carries is the draft's flip
         * to `sent`, which changes no list either way. Awaiting it buys nothing and costs the whole drain latency on
         * the one gesture where the user is watching — `mutate()` resolves into `useMailSend`, which closes the
         * compose; that navigation may not be hostage to a poll. Still ISSUED (the flip has to land) and its failure
         * swallowed for the awaited branch's own reason: the write succeeded, the next poll catches the mirror up.
         */
        // In the boot replay's deferred mode the drive's own drain follows immediately and
        // carries the flip, so no background drain is issued — one drain, not two.
        // BACKGROUND, never awaited: this branch already materialised the sent copy, and the
        // gesture the person is watching — the compose closing — may not be hostage to a poll.
        if (opts.deferReconcile) opts.onReconcileDeferred?.("background");
        else void this.syncFresh().catch(() => { /* see above — the write landed */ });
      } else {
        /**
         * No echo body — pull the authoritative delta from a drain that STARTED after this POST returned (see {@link
         * OhmailEngine.syncFresh} for why "a drain" is not enough). Every mutation kind can reach this branch: most
         * answer `changes: []` unconditionally, and the rest degrade to it when `X-Sync-Seq` is stripped by a proxy.
         * The drain's failure is NOT the mutation's failure: `adapter.mutate` resolved — the server committed its
         * `change_log` row — and a failed drain used to report `rolled_back` for a write that had succeeded. For
         * `mail_send` that is a delivered email reported as failed, and worse: `useMailSend.absorb` runs `settle` on
         * `confirmed` only, so the draft survived and the next press minted a NEW Idempotency-Key — a second
         * delivery, which the send path exists to make impossible ("press Send, then switch apps" reached it).
         */

        /**
         * So the drain's failure is swallowed — strictly more truthful: the overlay is dropped
         * either way, and `confirmed` is the true statement about a write the server took; what is
         * NOT swallowed is a rejection from `adapter.mutate` itself, which still rolls back or
         * queues below. The residual is closed: this branch used to drop the overlay even on a
         * failed drain, so the row REVERTED on screen until the next poll and users re-did the act
         * (INSTANT-ARCH §4.2 seam 2). A failed drain now registers the overlay in
         * {@link awaitingEcho}: the intent stays on screen, and the overlay retires when the next
         * drain that began after this POST completes — bounded by the scheduler's ordinary cadence.
         */
        if (opts.deferReconcile) {
          this.awaitingEcho.set(p.id, { epoch: epochAtConfirm, m: p.mutation, shadow });
          echoPending = true;
          opts.onReconcileDeferred?.("await");
        } else {
          try {
            await this.syncFresh();
          } catch {
            // The write landed; the mirror catches up on the next successful drain, and the
            // overlay stands until that drain proves the echo applied.
            this.awaitingEcho.set(p.id, { epoch: epochAtConfirm, m: p.mutation, shadow });
            echoPending = true;
          }
        }
      }
      /**
       * `view_meta` EFFECTS OUTLIVE THE OVERLAY — written into the mirror before the overlay drops, because nothing
       * else will ever write them: `/sync` has no `view_meta` entity type at all (a Cloud account can never receive
       * such a row — `fixtures-adapter.ts` documents the same fact from the other side). Without this, a waterline
       * committed by `feed_mark_seen` existed only for the milliseconds its own mutation was in flight — on a live
       * account the line evaporated on every confirm, which is why Reads' "seen up to here" never held still outside
       * the demo. `putLocal` (seq 0, outside the seq guard) is the channel local-only rows already use
       * (`message_body`); on the fixtures adapter the same entity also arrived authoritatively via the echo, so this
       * write is value-identical there and idempotent.
       */
      const confirmed = this.overlays.get(p.id);
      if (confirmed) {
        for (const e of confirmed) {
          if (e.type === "view_meta") await this.store.putLocal("view_meta", e.id, e.entity);
        }
      }
      // BOTH the overlay AND the durable entry are retired HERE only when the echo is provably
      // in the mirror (the echo body applied, or the awaited drain succeeded). An `echoPending`
      // verb keeps both: the overlay for the screen, the entry for a kill — confirmed
      // server-side but not yet in the local mirror, a restart would otherwise boot into the
      // stale pre-verb state with nothing to re-apply — the exact flash this slice retires.
      // Both are released together by {@link OhmailEngine.drain}'s sweep, and
      // a kill before that sweep replays the entry under its original key — the server's
      // idempotency machinery answers with the stored response, never a second effect.
      const intent = p.released === true ? undefined : p.andDone;
      if (!echoPending && this.settleConfirmed(p.id, p.mutation, shadow)) {
        this.sayEnded(p, "confirmed");
        await this.dropOutbox(p.id);
      } else if (p.mutation.kind === "mail_send") {
        // KEPT for its echo: the send is confirmed and its intent handed over on THIS result.
        p.confirmed = true;
        if (intent !== undefined) p.released = true;
        await this.putOutbox(p);
      }
      // The Sent copy was materialised the instant the server confirmed, above — a rejection
      // reaches the `catch` below and never gets here, which is the "DROP on send rejection"
      // half, unchanged by moving the call up.
      // Sweep the confirm's own drain-side reconcile (a real Sent row for an EARLIER send may have
      // just landed) and any expired copies, so the map cannot accumulate across a long session.
      this.reconcileOptimisticSent();
      if (p.mutation.kind === "draft_save" && p.mutation.draftId === null && outcome.entityId) {
        this.noteCreatedDraft(p.key, outcome.entityId, outcome.revision, outcome.changes);
      }
      this.overlayRev++;
      this.notify();
      // `entityId` rides the CONFIRMED result here. The queued arm below carries its own, taken
      // from the refusal that produced it, and the two are different claims: this one says "a row
      // was created and it is yours to write to", the queued one says "a row exists and this send
      // is about it". Handing the first back for a mutation that was NOT confirmed would be the
      // worst kind of wrong answer — a compose surface would adopt it and go on PATCHing a draft
      // that may not be there, or send it — which is why the queued arm names rather than adopts.
      // `pendingWith` rides the same way, and for the reason it exists: the server took the
      // decision and did NOT act on it, and this result is the only thing that can say so. It is
      // on the CONFIRMED result because the mutation genuinely succeeded — a queued or
      // rolled-back one has no answer from the organizer to report.
      return {
        id: p.id, key: p.key, status: "confirmed", seq: outcome.seq,
        ...(outcome.entityId ? { entityId: outcome.entityId } : {}),
        ...(outcome.revision ? { revision: outcome.revision } : {}),
        ...(outcome.pendingWith ? { pendingWith: outcome.pendingWith } : {}),
        // Rides the confirmed result for `pendingWith`'s reason: the server answered, and this
        // is the only thing that can say the answer was about an earlier press.
        ...(outcome.firstSend ? { firstSend: outcome.firstSend } : {}),
        ...(outcome.earlierWordsKept === true ? { earlierWordsKept: true as const } : {}),
        ...(outcome.sentCopy ? { sentCopy: outcome.sentCopy } : {}),
        ...(outcome.sentCopyReason ? { sentCopyReason: outcome.sentCopyReason } : {}),
        ...(outcome.sentCopyUntil ? { sentCopyUntil: outcome.sentCopyUntil } : {}),
        ...(intent !== undefined ? { andDone: intent } : {}),
      };
    } catch (err) {
      const rejection = err instanceof MutationRejectedError
        ? err
        : new MutationRejectedError(String(err), { retryable: false });
      // THE BELT: a hand-built rejection carrying an unjudged code or an update answer's is still
      // kept, never dropped.
      if (rejection.retryable || keepsWrite(rejection.code)) {
        /* THE READ A PERSON'S PRESS TOOK LETTERS FROM while it was on the wire goes again without
           them: a read answered 500, or dropped after the server took it, must not land over a later
           Mark unread. */
        if (p.readsTaken !== undefined && !(await this.narrowTaken(p))) {
          return { id: p.id, key: p.key, status: "superseded", seq: null };
        }
        /**
         * ── COUNT IT, DELAY IT, OR GIVE UP ON IT ────────────────────────────────────────────
         *
         * Three outcomes, and which one applies turns entirely on WHO failed. See
         * {@link OUTBOX_MAX_SERVER_FAILURES}: a transport failure or a refusal that named its own
         * interval buys the verb another go for free, and only an unmodelled server answer spends
         * the ceiling. `serverAnswered` is the test, and it is deliberately conservative — anything
         * this client cannot positively attribute to the server is treated as transport, because
         * abandoning a verb that would have landed is the worse of the two mistakes.
         */
        const counts = OhmailEngine.serverAnswered(rejection);
        const attempts = (p.attempts ?? 0) + (counts ? 1 : 0);

        if (counts && attempts >= OUTBOX_MAX_SERVER_FAILURES) {
          return await this.abandon(p, attempts, rejection);
        }
        // THE UNREACHABLE SERVER'S CEILING — see {@link OUTBOX_UNREACHABLE_CEILING_MS}.
        if (this.unreachable(rejection)
            && this.now().getTime() - p.at >= OUTBOX_UNREACHABLE_CEILING_MS) {
          return await this.abandon(p, attempts, rejection);
        }

        /**
         * A TRANSPORT FAILURE WAITS FOR NOTHING, AND THAT IS NOT AN OPTIMISATION: Only a failure the SERVER answered
         * earns a delay. An offline laptop re-queues with no `nextAt` at all and is retried by the very next drive,
         * exactly as it always was — the drive's own cadence is the only pacing that case ever needed or had.
         * Delaying it instead was a real defect for the length of one commit: it made every verb queued by a network
         * failure sit out a 30 s backoff, which is the behaviour the durable outbox is built on top of, and eighteen
         * kill-restart guards went red at once saying so. The lesson is the same one `serverAnswered` encodes — the
         * queue's patience is spent on evidence about the SERVER, and a wire that dropped tells you nothing about the
         * verb.
         */

        /**
         * `Math.min` on the cap and on the named interval both: a proxy is free to send a `Retry-After` of a week,
         * and a queue that honours it has stopped being a queue. An update answer that named no
         * interval waits the base one: the server answers the same way until the app is updated, and
         * a drive that asked it every time would be a loop. It is this client's own pacing, so the
         * first drive of the updated app is free to ask at once.
         */
        const wait = rejection.retryAfterMs !== null
          ? Math.min(rejection.retryAfterMs, OUTBOX_BACKOFF_CAP_MS)
          : counts
            ? Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_BACKOFF_CAP_MS)
            : UPDATE_ANSWER_CODES.has(rejection.code as UpdateAnswerCode) ? OUTBOX_BACKOFF_BASE_MS : null;

        // Keep the overlay (the user's intent stands) + queue for a retry with
        // the SAME Idempotency-Key — the server dedupes a half-landed attempt.
        p.attempts = attempts;
        // The attempt answered: the claim ends with it, and a Cancel may win the row again.
        delete p.sending;
        if (wait !== null) {
          p.nextAt = this.now().getTime() + wait;
          p.waitIsServerNamed = rejection.retryAfterMs !== null;
        }
        p.lastError = { message: rejection.message, code: rejection.code, status: rejection.status };
        // BEFORE the re-persist below, so the flag reaches disk with the entry it belongs to.
        if (rejection.createAttempted) p.createAttempted = true;
        // THE CONFIRM PHASE: a mark is final only once its replacement's write has decided — see
        // `supersededBy`. A refused write has taken it back by the time this resumes.
        if (p.supersededBy !== undefined) await this.replacementDecided(p.supersededBy);
        if (p.supersededBy !== undefined) {
          // A newer verb for the same target was expressed while this was on the wire. Re-queuing
          // it would replay the older value over the newer state — see `supersededBy`.
          await this.dropOutbox(p.id);
          this.overlays.delete(p.id);
          this.overlayRev++;
          this.notify();
          // Every kind: the newer press for the same field owns the sentence — see `MutationStatus`.
          // A wire failure here is not this press's refusal; its overlay and row are gone above.
          return { id: p.id, key: p.key, status: "superseded", seq: null };
        }
        p.told = true;
        this.queue.push(p);
        // NAMED, not adopted — see {@link MutationResult.entityId}. The adapter created a row for
        // a press that carried none and the send is on the wire about it; the durable send record
        // binds the row so a reload does not read it as an ordinary draft and mint a second one.
        // Re-assert the durable entry. Normally redundant with `mutate()`'s write, but it is
        // the belt for the one window where it is not: a 410 reset wiped the store while this
        // request was in flight, and without this line the queued verb would be memory-only
        // again — the exact state the durable outbox exists to retire. It also persists the
        // counter and the delay, which is what makes the bound survive a restart.
        await this.putOutbox(p);
        // The queue moved: a surface that lists queued verbs reads it on this notification.
        this.notify();
        return {
          id: p.id, key: p.key, status: "queued", seq: null, error: rejection,
          ...(rejection.entityId ? { entityId: rejection.entityId } : {}),
          ...(counts ? { serverFailed: true as const } : {}),
        };
      }
      // EXPLICIT REFUSAL: the local effect rolls back VISIBLY, once — the overlay drops, the
      // row reverts, and the rejection (with the server's own sentence) rides the result for
      // the surface to say.
      this.overlays.delete(p.id);
      this.awaitingEcho.delete(p.id);
      /* STALE BEHIND A NEWER DECISION: the server refused a press replayed after the field it sets
         was decided elsewhere. The mirror's drain already carries the newer state, so the overlay
         and the row go and the press settles silent — never a refusal record, never a sentence. */
      if (rejection.code === STALE_PRESS_CODE) {
        await this.dropOutbox(p.id);
        this.overlayRev++;
        this.notify();
        return { id: p.id, key: p.key, status: "superseded", seq: null };
      }
      /* A SAVE OF A ROW ALREADY SENT: the send carried the message, so the save ends silent — no
         refusal record, and never kept as a new draft (only `draft_changed` keeps one). */
      if (rejection.code === "draft_sent" && p.mutation.kind === "draft_save") {
        await this.dropOutbox(p.id);
        this.overlayRev++;
        this.notify();
        return { id: p.id, key: p.key, status: "rolled_back", seq: null, error: rejection };
      }
      /* A WAITING EDIT REFUSED BECAUSE THE ROW MOVED ELSEWHERE: its editor was answered `queued` (or
         died with its session) and reads nothing now, so its words become a new draft, never dropped. */
      if (rejection.code === "draft_changed" && p.mutation.kind === "draft_save" && p.mutation.draftId !== null
        && (p.told === true || p.restored === true)) {
        // A newer edit of the row carries newer words and gets its own answer: this one goes with it.
        if (p.supersededBy !== undefined) await this.replacementDecided(p.supersededBy);
        if (p.supersededBy === undefined) return await this.keepAsNewDraft(p, p.mutation.draftId, rejection, opts);
      }
      // THE SERVER TOMBSTONED THIS KEY (a Cancel, here or in another window): the withdrawn ending,
      // never a refusal record — nothing was sent and nothing will be.
      if (p.mutation.kind === "mail_send" && rejection.code === OUTBOX_WITHDRAWN_CODE) {
        this.sayEnded(p, "withdrawn");
        await this.dropOutbox(p.id);
        this.overlayRev++;
        this.notify();
        return withdrawnResult(p);
      }
      /**
       * WHERE THE REFUSAL GOES WHEN NOBODY IS WAITING FOR IT: The result carries the server's sentence, and for a
       * verb the user is watching that is enough: the composer is open, the strip is on screen, someone reads it. A
       * RESTORED VERB HAS NO SUCH READER. Its owner died with the previous session — that is what `restored` means —
       * so returning the sentence to a caller that is a drive loop throws it away, and dropping the row with it
       * leaves the person's work gone and unexplained: they queued something, closed the app, and it is simply not
       * there. The record is the only home an outcome has that outlives the retry, so the refusal is WRITTEN INTO IT,
       * one transaction, and the list shows what happened and why. `send_unverified` is the exception to
       * `retryRefused` and keeps its Retry.
       */

      /**
       * The adapter emits it `retryable: false`, and it is right that no automatic drive replays it — a send whose
       * answer was lost must never be re-POSTed blindly. But Try again on it is verify-under-the-same-key, not a
       * second message, and that is exactly the action a person with an unverified send needs. Hiding the control
       * would leave them with a row that says something went wrong and no way to find out.
       */
      if (p.restored === true) {
        this.sayEnded(p, "refused");
        const code = rejection.code;
        const record: PersistedOutboxEntry = {
          v: OUTBOX_ENTRY_VERSION, id: p.id, key: p.key, n: p.n, at: p.at, mutation: p.mutation,
          attempts: p.attempts ?? 0,
          lastError: { message: rejection.message, code, status: rejection.status },
          ...(p.createAttempted === true ? { createAttempted: true } : {}),
          ...(p.createdRow !== undefined ? { createdRow: p.createdRow } : {}),
          ...andDoneOf(p),
          ...(code === "send_unverified" ? {} : { retryRefused: code ?? "refused" }),
        };
        try {
          await this.store.commitLocal(
            [{ type: OUTBOX_ABANDONED_TYPE, id: p.id, entity: record }],
            [{ type: OUTBOX_TYPE, id: p.id }],
          );
        } catch {
          /**
           * THE TRANSITION WAS REFUSED, SO HOLD THE RECORD IN MEMORY. Nothing moved on disk: the row is still a LIVE
           * outbox entry there. But the replay that dispatched it has already taken it out of the queue, and the boot
           * latch stops the store being read again this session — so without this the verb is in the queue, in
           * `abandoned()`, and on the screen exactly nowhere, while its durable row sits there unreferenced. A person
           * who has just had a send come back "this may have gone, check Sent" would see that warning appear and then
           * have nothing to act on, with no way to reach it again short of restarting the app. Held in memory
           * instead, so the record is listed and its controls work for the rest of the session. A reboot reads the
           * live row and replays it, which is honest: on disk the verb genuinely never reached its terminal state.
           */
          this.abandonedLocally.set(p.id, record);
          this.localRefusalRev++;
          this.notify();
        }
      } else {
        // The durable entry goes with it: a refused verb whose owner read the sentence must not
        // replay, and must not sit in a list claiming to be unfinished work.
        this.sayEnded(p, "refused");
        await this.dropOutbox(p.id);
      }
      this.overlayRev++;
      this.notify();
      // The refusal's own row rides the result for the same reason the queued arm's does: an
      // `unverified` send names the row the server marked, and nothing else in this client can.
      return {
        id: p.id, key: p.key, status: "rolled_back", seq: null, error: rejection,
        ...(rejection.entityId ? { entityId: rejection.entityId } : {}),
      };
    }
  }

  /**
   * HOLD A MUTATION THE SERVER QUEUED FOR THE ORGANIZER. Three acts, each the honest one for
   * "recorded, not done": the OPTIMISTIC PAINT goes back, because the 202's body carries the row
   * unmoved and leaving the overlay shows mail where nobody put it; the DURABLE OUTBOX ENTRY is
   * dropped, because there is nothing to retry — the request is stored server-side under this
   * Idempotency-Key and a second POST re-reads the same answer; and the REQUEST IS KEPT, in
   * {@link organizerQueue}, until a change confirms it.
   */
  protected async holdForOrganizer(p: PendingMutation, outcome: MutationQueued): Promise<MutationResult> {
    this.overlays.delete(p.id);
    this.awaitingEcho.delete(p.id);
    await this.dropOutbox(p.id);
    this.organizerQueue.set(p.id, {
      id: p.id, key: p.key, mutation: p.mutation,
      queuedWith: outcome.queuedWith, requestId: outcome.requestId,
      requestIds: outcome.requestIds ?? (outcome.requestId ? [outcome.requestId] : []), at: this.now().getTime(),
    });
    this.overlayRev++;
    this.notify();
    return {
      id: p.id, key: p.key, status: "awaiting_organizer", seq: null,
      queuedWith: outcome.queuedWith,
      ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
      // The same fact under the name the Screener's standing reader has known since the decision
      // door learnt the 202 (`screener-state.ts#markQueued`) — one answer, not two.
      pendingWith: outcome.queuedWith,
    };
  }

  /**
   * ADD THE OPTIMISTIC SENT COPY of a confirmed send. A no-op for anything else. Gated on `mail_send` AND a
   * `providerMessageId`: the id is the server's word that the message left and was appended to Sent, and its absence
   * (an older server, or a Send later) means no overlay rather than a fabricated one. The copy goes into {@link
   * overlays} under a dedicated key so the {@link OverlayReader} merges it into every message read — the conversation
   * and the Ohbox see it with no change of their own — and its `messageIdHeader`/expiry are recorded in {@link
   * optimisticSent} for {@link reconcileOptimisticSent} to retire it by. Answers whether a copy was added, so the
   * caller can paint immediately and only then — a bare `notify()` on every mutation would wake every subscriber for
   * the seven kinds that never produce one.
   */
  protected materializeSentOverlay(m: EngineMutation, outcome: MutationOutcome): boolean {
    if (m.kind !== "mail_send") return false;
    // The words that went are not the ones in `m`, and this engine does not hold them: nothing is
    // painted, and the real Sent row arrives on the drain.
    if (outcome.earlierWordsKept === true) return false;
    // No copy is in Sent and none will be: a painted row would vanish at its expiry.
    if (outcome.sentCopy === "missing") return false;
    const header = outcome.providerMessageId;
    if (!header) return false;
    // One copy per message: a re-press under the key confirms the same delivery again.
    for (const meta of this.optimisticSent.values()) if (meta.header === header) return false;
    const sent = sentOverlayMessage(this.read(), m, header, { now: this.now, uuid: this.uuid });
    if (!sent) return false;
    const overlayId = `sent:${sent.id}`;
    const expiresAtMs = this.now().getTime() + OPTIMISTIC_SENT_TTL_MS;
    this.overlays.set(overlayId, [{ type: "message", id: sent.id, entity: sent }]);
    this.optimisticSent.set(overlayId, { header, expiresAtMs });
    this.seedSentAttachments(sent.id, m.attachments ?? [], expiresAtMs, m.forwardOf ?? undefined, m.forwardParts);
    return true;
  }

  /**
   * Hold the sent copy's attachments as the list the reader will ask for. The copy claims `hasAttachments`, and the
   * reader that opens it asks `loadAttachments(copy.id)` — an id minted HERE, which no server has a row for, so that
   * read can only 404: the message a person is most likely to open next rendered its strip as a failure until the
   * REAL Sent row arrived (observed live). The engine holds the complete answer at this moment — `m.attachments` is
   * the exact set the server just confirmed — so the list is seeded `ready` from those bytes, and `loadAttachments`
   * answers from the held list, never putting the fabricated id on the wire. Seeded for the no-attachment send too —
   * an empty `ready` list, so opening a just-sent message without files renders the ordinary nothing instead of a 404
   * sentence. Lifecycle is {@link sentAttachmentSeeds}'s: alive while the copy stands, swept at its TTL.
   */

  /**
   * A runtime with no `URL.createObjectURL` still keeps the BYTES — only the browser-facing URL
   * degrades; an unreadable base64 payload is the one case that seeds metadata alone.
   */
  protected seedSentAttachments(
    messageId: string,
    attachments: readonly ComposeAttachment[],
    expiresAtMs: number,
    forwardOf?: string,
    forwardParts?: readonly string[],
  ): void {
    const composeItems: AttachmentItem[] = attachments.map((a, i) => {
      const bytes = base64ToBytes(a.contentBase64);
      const mimeType = a.contentType || "application/octet-stream";
      // `bytesBlob`, not `new Blob`: React Native refuses to build one from bytes, and the seed
      // holds the copy's only bytes — a phone that dropped them showed a sent picture it could
      // never open again. The carrier answers `arrayBuffer()`, which is what the share path reads.
      const minted = bytes ? this.mintObjectUrl(messageId, bytesBlob(bytes, mimeType), mimeType) : undefined;
      return {
        // A local id, namespaced so it can never collide with a server row id. It is only ever
        // resolved against this held list; `openAttachment` short-circuits on `ready` with the
        // bytes (or a URL) in hand, so the id reaches no wire while they stand.
        id: `${messageId}:sent-att:${i}`,
        filename: a.filename?.trim() || `attachment-${i + 1}.bin`,
        mimeType,
        sizeBytes: bytes?.length ?? 0,
        state: "ready" as const,
        inline: false,
        contentId: null,
        ...(minted ? { blob: minted.blob } : {}),
        ...(minted && minted.url !== undefined ? { objectUrl: minted.url } : {}),
      };
    });
    this.sentAttachmentSeeds.set(messageId, {
      live: true, expiresAtMs, forwardOf, composeItems, ...(forwardOf && forwardParts ? { forwardParts } : {}),
    });

    if (!forwardOf) {
      // A compose or reply: the mutation's files ARE the delivered files, so the list is complete.
      this.attachmentLists.set(messageId, { state: "ready", items: composeItems });
      return;
    }

    /**
     * A FORWARD'S DELIVERED MESSAGE CARRIES MORE THAN THE MUTATION DID: the server streams the original's parts onto
     * the outgoing mail. Publishing `composeItems` alone as `ready` would be a complete-looking list missing every
     * inherited file — for the copy's whole lifetime, because a ready list is never re-read. So the copy's list is
     * COMPOSED from the parent's (compose files + the original's parts, under their real server ids): immediately
     * when the parent's metadata is already in hand — the common case, the forward was pressed on an open message —
     * and otherwise as one ordinary indexed read of the PARENT's list, whose answer recomposes the copy and notifies
     * the open view. Until it answers, the copy's list stays unpublished (`loading`, the silent state) rather than
     * confidently incomplete.
     */
    if (!this.recomposeForwardSeed(messageId)) {
      void this.loadAttachments(forwardOf).then(() => {
        if (this.recomposeForwardSeed(messageId)) this.notify();
      });
    }
  }

  /**
   * Compose a FORWARD copy's attachment list from its seed and its parent's held list. The parent's items ride in as
   * fresh `idle` rows under their REAL attachment ids — the byte routes resolve an attachment id alone (`GET
   * /attachments/:id`), and the forward streamed the SAME parts, so a press fetches exactly the delivered bytes.
   * Deliberately WITHOUT the parent's byte state: an object URL shared between two lists dies for both when either
   * message is released. A parent list held `failed` is carried over as that same failure — the true sentence, with
   * the server's own code — and a retry from the copy's strip delegates back to the parent (see {@link
   * OhmailEngine.loadAttachments}), the one id a server can answer for.
   */

  /**
   * Also settles the overlay row's own paperclip: a forward's `hasAttachments`/`attachmentCount` cannot be derived
   * from the mutation (the inherited parts are not in it), so they are written here, from the composed list, counting
   * real files the way ingest does. Returns whether the copy's list is now published (ready or failed).
   */
  protected recomposeForwardSeed(messageId: string): boolean {
    const seed = this.sentAttachmentSeeds.get(messageId);
    if (!seed?.forwardOf) return false;
    const parent = this.attachmentLists.get(seed.forwardOf);
    if (parent?.state === "failed") {
      this.attachmentLists.set(messageId, parent);
      return true;
    }
    if (parent?.state !== "ready") return false;
    // AT MOST WHAT THE SEND STREAMED. The server bounds a forward's inherited parts
    // (`SENT_FORWARD_MAX_PARTS` mirrors `SendService.FORWARD_MAX_PARTS`), so projecting the
    // parent's whole list onto a >cap original would claim files the recipient never got. The
    // MEMBERSHIP matches too: the send's capped query and the metadata list are both ordered by
    // attachment id (`send-service.ts` says why from its side), so this prefix names exactly the
    // parts the send streamed, over-cap originals included.
    // A forward that named its parts streamed exactly those.
    const kept = seed.forwardParts ? new Set(seed.forwardParts) : null;
    const streamed = kept ? parent.items.filter((i) => kept.has(i.id)) : parent.items;
    const inherited: AttachmentItem[] = streamed.slice(0, SENT_FORWARD_MAX_PARTS).map((i) => ({
      id: i.id,
      filename: i.filename,
      mimeType: i.mimeType,
      sizeBytes: i.sizeBytes,
      state: "idle" as const,
      inline: i.inline,
      contentId: i.contentId,
      ...(i.calendarBody === true ? { calendarBody: true } : {}),
    }));
    const items = [...seed.composeItems, ...inherited];
    this.attachmentLists.set(messageId, { state: "ready", items });

    // The paperclip on the overlay row itself — real files only, the ingest rule.
    const overlay = this.overlays.get(`sent:${messageId}`);
    const entity = overlay?.[0]?.entity as EngineMessage | undefined;
    if (overlay && entity) {
      const files = items.filter((i) => !i.inline).length;
      this.overlays.set(`sent:${messageId}`, [{
        type: "message",
        id: messageId,
        entity: { ...entity, hasAttachments: files > 0, attachmentCount: files },
      }]);
      this.overlayRev++;
    }
    return true;
  }

  /**
   * RETIRE optimistic Sent copies — by the real row arriving, or by the TTL.
   *
   * The real row is the authoritative one: once the mirror holds a message carrying the same
   * `messageIdHeader` the copy was minted under, the copy is a duplicate and is dropped, so the
   * conversation shows the ingested row alone. The TTL is the backstop for a copy whose real row
   * this session never sees. Cheap by construction — it scans the mirror only while at least one
   * copy is outstanding, which is the rare case.
   */
  protected reconcileOptimisticSent(): void {
    const nowMs = this.now().getTime();
    // The seed sweep runs even with no copy outstanding: a seed outlives its copy by design (the
    // pane may still be rendering it off-mirror), and the TTL is what bounds one nobody released.
    this.sweepSentAttachmentSeeds(nowMs);
    if (this.optimisticSent.size === 0) return;
    // BOTH sides through `messageIdKey`: the confirmation carries `<id@domain>`, the ingested row
    // carries `id@domain`, and the raw compare that stood here retired copies by TTL alone — see
    // the helper's docblock in `mutations.ts`.
    // Each landed header, and whether any of its rows reads as the account's own.
    const landed = new Map<string, boolean>();
    for (const { entity } of this.store.entries<EngineMessage>("message")) {
      const h = entity.messageIdHeader;
      if (h) {
        const key = messageIdKey(h);
        landed.set(key, landed.get(key) === true || isOwnSent(entity));
      }
    }
    let asks = 0;
    for (const [overlayId, meta] of this.optimisticSent) {
      const own = landed.get(messageIdKey(meta.header));
      if (own === false) asks += 1;
      if (own !== undefined || nowMs >= meta.expiresAtMs) {
        this.overlays.delete(overlayId);
        this.optimisticSent.delete(overlayId);
        // The copy is retired, so its attachment seed stops being load-bearing: clearing `live`
        // hands the seed to the ordinary release path (the pane frees it on unmount; the sweep
        // above frees one nobody opened). NOT released here — a reader may be looking at the
        // copy at this very moment, and yanking its strip mid-read is the defect's mirror image.
        const seed = this.sentAttachmentSeeds.get(overlayId.slice("sent:".length));
        if (seed) seed.live = false;
      }
    }
    if (asks > 0) {
      this.sentFolderAskCount += asks;
      this.notify();
    }
  }

  /**
   * HOW OFTEN A SENT COPY LANDED IN A FOLDER THIS CLIENT DOES NOT KNOW AS SENT — a confirmed send's
   * real row arrived, and no row under its Message-ID reads as the account's own. The mailbox's Sent
   * folder was recorded after the last mailbox read (one made after connecting), so a surface reads
   * `GET /mailboxes` again once per rise rather than at its next poll.
   */
  sentFolderAsks(): number {
    return this.sentFolderAskCount;
  }

  /** Free every sent-copy attachment seed whose TTL has passed. See {@link sentAttachmentSeeds}. */
  protected sweepSentAttachmentSeeds(nowMs: number): void {
    if (this.sentAttachmentSeeds.size === 0) return;
    for (const [messageId, seed] of this.sentAttachmentSeeds) {
      if (nowMs >= seed.expiresAtMs) this.forceReleaseAttachments(messageId);
    }
  }

  /** The verbs on the queue, a running flush's batch included until each one's own turn. */
  pendingMutations(): ReadonlyArray<{ id: string; key: string; mutation: EngineMutation; andDone?: SendAndDonePlan; confirmed?: true }> {
    return [...this.queue];
  }

  /**
   * THE VERBS ON THE WIRE — a request running, a timed-out one included, which is in no collection
   * {@link pendingMutations} reads. Its own read rather than an option on that one, so no reader of
   * the queue changes meaning: a re-press asks both, queue first, to resume the key of a send still
   * in the air instead of minting a second one.
   */
  inFlightMutations(): ReadonlyArray<{ id: string; key: string; mutation: EngineMutation; andDone?: SendAndDonePlan; confirmed?: true }> {
    return [...this.inFlight.values()];
  }

  /**
   * A RULE VERB ON THE QUEUE HAS NOT CHANGED THE RULE. Its overlay hides a revoked
   * rule and moves a retargeted one while it waits, yet the server still runs the rule as the
   * mirror holds it, so the rules surface shows that row (`rule`, overlay-free; absent when the
   * mirror has none) and says what waits on it. `serverFailed`: the server answered the last try
   * with a failure, by the ceiling's own test; otherwise it has not been answered yet.
   */
  queuedRuleWrites(): readonly QueuedRuleWrite[] {
    const out: QueuedRuleWrite[] = [];
    for (const p of this.queue) {
      const m = p.mutation;
      if (m.kind !== "rule_delete" && m.kind !== "rule_update") continue;
      const e = p.lastError;
      const serverFailed = e !== undefined && OhmailEngine.serverAnswered({
        code: e.code, status: e.status, retryAfterMs: p.waitIsServerNamed === true ? 0 : null,
      });
      out.push({
        id: p.id, verb: m.kind === "rule_delete" ? "revoke" : "retarget", ruleId: m.ruleId,
        rule: this.storeTruth.get<RuleDTO>("rule", m.ruleId), serverFailed,
      });
    }
    return out;
  }

  /**
   * THE DRAFT DISCARDS WAITING ON THE QUEUE, for the strip that lists them beside the abandoned
   * rows. Its overlay erases the draft (`mutations.ts`), so while it waits this is the only place
   * the draft is still named. Membership is the queue's own: a verb on the wire is off it, a
   * withdrawn one is spliced and never restored, a held-back one is pushed back at the end. The
   * previous array is kept while every index has the same id and key (`useSyncExternalStore`
   * compares by identity). No discard's `mutation` changes in place: only read verbs are narrowed,
   * and an undone supersession puts back the entry's own object.
   */
  queuedDiscards(): readonly QueuedChange[] {
    const next = this.queue.filter((p) => p.mutation.kind === "draft_discard");
    const prev = this.queuedDiscardsCache;
    if (next.length === prev.length && next.every((p, i) => p.id === prev[i]!.id && p.key === prev[i]!.key)) return prev;
    this.queuedDiscardsCache = next.length === 0
      ? NO_QUEUED
      : Object.freeze(next.map((p) => Object.freeze({ id: p.id, key: p.key, mutation: p.mutation })));
    return this.queuedDiscardsCache;
  }

  /**
   * EVERY CHANGE WAITING ON THE QUEUE, for the Unsaved changes panel — a person sees what has not
   * gone through yet and why, not only the discards (a waiting Screener decision was listed nowhere).
   * Two families are left to the surface that settles them: a send (its sending line) and a draft's
   * first save (the composer). Each carries its last attempt's error, `null` before any answer. The
   * previous array is kept while every index has the same id, key and error (`useSyncExternalStore`
   * compares by identity); a read verb narrowed in place keeps its listed copy, whose kind is all a
   * surface reads of it.
   */
  queuedChanges(): readonly QueuedChange[] {
    const next = this.queue.filter((p) => !OhmailEngine.ownerSettled(p.mutation));
    const prev = this.queuedChangesCache;
    const same = (p: PendingMutation, q: QueuedChange): boolean =>
      p.id === q.id && p.key === q.key && (p.lastError?.code ?? null) === (q.error?.code ?? null)
      && (p.lastError?.message ?? null) === (q.error?.message ?? null);
    if (next.length === prev.length && next.every((p, i) => same(p, prev[i]!))) return prev;
    this.queuedChangesCache = next.length === 0
      ? NO_QUEUED
      : Object.freeze(next.map((p) => Object.freeze({
        id: p.id, key: p.key, mutation: p.mutation,
        error: p.lastError === undefined
          ? null
          : Object.freeze({ code: p.lastError.code, message: p.lastError.message, status: p.lastError.status }),
      })));
    return this.queuedChangesCache;
  }

  /**
   * THE SENDS WAITING TO GO, for a Drafts list that shows them as such: every send on the queue, and
   * one on the wire that has waited before (an answer heard, or restored from a previous session).
   * A first attempt on the wire, an appointment, a confirmed send kept for its echo and a Cancel
   * still owed its answer are not listed. The previous array is kept while every index has the
   * same id, key, row, paint and wire (`useSyncExternalStore` compares by identity).
   */
  waitingSends(): readonly WaitingSend[] {
    const sends = (p: PendingMutation): boolean =>
      p.mutation.kind === "mail_send" && !p.mutation.sendAt && p.confirmed !== true && p.withdrawOwed !== true;
    const next = [
      ...this.queue.filter(sends).map((p) => [p, false] as const),
      ...[...this.inFlight.values()]
        .filter((p) => sends(p) && (p.lastError !== undefined || p.restored === true)).map((p) => [p, true] as const),
    ].map(([p, wire]) => ({
      p, wire,
      draftId: p.createdRow?.id ?? (p.mutation as { draftId?: string }).draftId ?? null,
      paintId: this.overlays.get(p.id)?.find((e) => e.type === "draft")?.id ?? null,
    }));
    const prev = this.waitingSendsCache;
    if (next.length === prev.length && next.every((x, i) => {
      const q = prev[i]!;
      return x.p.id === q.id && x.p.key === q.key && x.draftId === q.draftId && x.paintId === q.paintId && x.wire === q.wire;
    })) return prev;
    this.waitingSendsCache = next.length === 0
      ? NO_WAITING
      : Object.freeze(next.map((x) => Object.freeze({
        id: x.p.id, key: x.p.key, draftId: x.draftId, paintId: x.paintId, wire: x.wire, at: x.p.at,
        mutation: x.p.mutation as Extract<EngineMutation, { kind: "mail_send" }>,
      })));
    return this.waitingSendsCache;
  }

  /**
   * CANCEL CANCELS — withdraw the queued verbs carrying this Idempotency-Key, each by its own
   * outbox row id. The key is marked in memory (read at the moment of sending, see {@link
   * dispatch}) and each row is marked on disk, so neither this session's flush nor a later boot
   * can deliver it. `on_the_wire` is the one answer that withdraws nothing: the request has gone
   * and this device cannot un-send it — the caller says so rather than promising a cancellation.
   */
  async withdrawQueued(key: string, opts: { askedElsewhere?: boolean; answered?: "withdrawn" } = {}): Promise<WithdrawOutcome> {
    for (const p of this.inFlight.values()) if (p.key === key) return "on_the_wire";
    // A create waiting its turn at the gate or behind a hold is taken back as a queued one is.
    const waiting = this.awaitingTurn.get(key);
    const rows = [...this.queue.filter((p) => p.key === key), ...(waiting !== undefined ? [waiting] : [])];
    // A CANCEL ALREADY OWED is asked again: the press is a request for the server's answer.
    const owed = [...this.owedWithdraws.values()].filter((p) => p.key === key);
    if (rows.length === 0 && owed.length > 0) return this.reaskOwed(owed, opts);
    if (rows.length === 0 && !opts.askedElsewhere) {
      const foreign = await this.withdrawForeign(key);
      if (foreign !== null) return foreign;
    }
    this.withdrawnKeys.add(key);
    let unrecorded = false;
    const marked: PendingMutation[] = [];
    for (const p of rows) {
      const at = this.queue.indexOf(p);
      if (at >= 0) this.queue.splice(at, 1);
      const paint = this.overlays.get(p.id);
      this.overlays.delete(p.id);
      /* A CANCEL THE DISK DID NOT TAKE IS NOT A CANCEL where another window can adopt the row: it
         goes back on the queue as it was, and the answer is `unknown`. */
      const owe = p.mutation.kind === "mail_send" && opts.answered !== "withdrawn";
      if (!await this.markWithdrawn(p, owe) && this.ownershipOn()) {
        if (p !== waiting) {
          this.queue.push(p);
          this.queue.sort(byAtN);
        }
        if (paint !== undefined) this.overlays.set(p.id, paint);
        unrecorded = true;
        continue;
      }
      if (p === waiting) this.awaitingTurn.delete(key);
      marked.push(p);
    }
    if (rows.length === 0) return "gone";
    if (unrecorded) this.withdrawnKeys.delete(key);
    let said: WithdrawOutcome = unrecorded ? "unknown" : "withdrawn";
    for (const p of marked) {
      /* A SEND IS DECIDED BY THE SERVER'S ANSWER, asked after the mark has stopped every window's
         send; another verb, or a send another window's Cancel already had answered, by the mark. */
      if (p.mutation.kind !== "mail_send" || opts.answered === "withdrawn") {
        if (p.mutation.kind === "mail_send") this.sayEnded(p, "withdrawn");
        this.hearEnding(p, opts.askedElsewhere === true ? withdrawnResult(p) : null);
        continue;
      }
      const settled = await this.settleWithdrawn(p, await this.askWithdraw(p));
      said = worseWithdraw(said, settled.said);
      // The press answers `withdrawn` itself; every other ending reaches the waiting surface late.
      if (settled.result !== null) {
        this.hearEnding(p, opts.askedElsewhere === true || settled.said !== "withdrawn" ? settled.result : null);
      }
    }
    this.overlayRev++;
    this.notify();
    return said;
  }

  /**
   * A CANCELLED SEND'S ENDING, for the surface waiting on it: an earlier press under its key that was
   * delivered and waited for this one speaks now; otherwise `result`, when there is one to hear.
   */
  protected hearEnding(p: PendingMutation, result: MutationResult | null): void {
    const waiting = this.silencedConfirms.get(p.id);
    if (waiting !== undefined && (result === null || result.status !== "rolled_back" || result.error?.code === OUTBOX_WITHDRAWN_CODE)) {
      this.silencedConfirms.delete(p.id);
      this.lateResults.set(p.id, this.spokenFor(waiting, p.mutation));
      return;
    }
    if (result !== null) this.lateResults.set(p.id, result);
  }

  /** A Cancel pressed again over sends whose Cancel is owed: each is asked now. */
  protected async reaskOwed(owed: PendingMutation[], opts: { askedElsewhere?: boolean }): Promise<WithdrawOutcome> {
    let said: WithdrawOutcome = "withdrawn";
    for (const p of owed) {
      if (this.askingWithdraw.has(p.id)) { said = worseWithdraw(said, "unknown"); continue; }
      this.askingWithdraw.add(p.id);
      try {
        const settled = await this.settleWithdrawn(p, await this.askWithdraw(p));
        said = worseWithdraw(said, settled.said);
        if (settled.result !== null) {
          this.hearEnding(p, opts.askedElsewhere === true || settled.said !== "withdrawn" ? settled.result : null);
        }
      } finally {
        this.askingWithdraw.delete(p.id);
      }
    }
    this.overlayRev++;
    this.notify();
    return said;
  }

  /**
   * CANCEL IN A WINDOW THAT DOES NOT OWN THE SEND, decided by the disk row alone (see
   * {@link decideOutboxRow}): the mark wins only a row nobody has claimed for the wire, and the
   * owning engine's claim reads it, so `withdrawn` is true. A claimed or confirmed row answers
   * `on_the_wire`; a row already gone answers by the ending its owning engine said. That engine is
   * told after, so its surface closes. `null` when no other engine's row carries the key.
   */
  protected async withdrawForeign(key: string): Promise<WithdrawOutcome | null> {
    if (!this.ownershipOn() || typeof this.store.decideOutboxRow !== "function") return null;
    const rows = this.store.entries<unknown>(OUTBOX_TYPE).map((e) => e.entity).filter(isPersistedOutboxEntry)
      .filter((e) => e.key === key && typeof e.owner === "string" && e.owner !== this.ownerName);
    // Already gone from this window's copy: a send another window said it delivered is not "gone".
    if (rows.length === 0) return this.foreignEndings.get(key) === "confirmed" ? "on_the_wire" : null;
    const seen = new Set<OutboxRowVerdict | "failed">();
    for (const e of rows) seen.add(await this.store.decideOutboxRow(e.id, { kind: "withdraw" }).catch(() => "failed" as const));
    this.notify();
    if (seen.has("sending") || seen.has("sent")) return "on_the_wire";
    // A mark the disk did not take, or an older build's row (see foreignCancelRefused): nothing cancelled.
    if (seen.has("failed") || seen.has("unstamped")) return "unknown";
    // Marked here, or by a Cancel still owed its answer: the server decides, then the owning engine is told.
    if (seen.has("marked") || seen.has("owed")) return this.settleForeignWithdraw(key, rows, !seen.has("owed"));
    // Marked by a Cancel the server already answered `withdrawn`.
    if (seen.has("withdrawn")) return "withdrawn";
    /* Gone: answered only by the ending its owner said before the drop. That notice can arrive after
       this transaction's answer, so the disk is re-read once (a store read, not a clock) first; with no
       ending heard, nothing is known. */
    await this.followDisk();
    const said = this.foreignEndings.get(key);
    return said === "confirmed" ? "on_the_wire" : said === "withdrawn" ? "withdrawn" : said === "refused" ? "gone" : "unknown";
  }

  /**
   * THE OWNING ENGINE'S CLAIM ON ITS ROW BEFORE THE WIRE, in the same transaction that reads another
   * window's mark: `claimed` stamps the row `sending`, so a later mark is refused; `withdrawn` means
   * a mark won first. Only for a send, where windows share the disk and this engine owns the row.
   * `failed`: the disk did not answer, and nothing is sent this round. `gone`: the shared row is not
   * on the disk any more. `unclaimed`: no claim to make (no shared disk, or its lock not granted yet).
   */
  protected async claimForSend(p: PendingMutation): Promise<"claimed" | "offline" | "withdrawn" | "owed" | "unclaimed" | "gone" | "failed"> {
    const me = this.ownerName;
    if (p.mutation.kind !== "mail_send" || me === null || !this.ownershipOn() || typeof this.store.decideOutboxRow !== "function") {
      return "unclaimed";
    }
    // THE WIRE FACT rides the claim, unless the browser says it is offline: that claim sends nothing.
    const wire = !OhmailEngine.knownOffline();
    let verdict: OutboxRowVerdict;
    try {
      verdict = await this.store.decideOutboxRow(p.id, { kind: "claim", me, wire });
    } catch {
      return "failed";
    }
    if (verdict === "withdrawn" || verdict === "owed") return verdict;
    if (verdict !== "claimed") return "gone";
    p.sending = me;
    if (!wire) return "offline";
    p.wired = true;
    return "claimed";
  }

  /**
   * TRY AGAIN ON ONE QUEUED VERB — now, under its own key, through the gate like every other road.
   * Our own backoff yields to the press; a wait the SERVER named does not (`waitIsServerNamed`).
   * `null` = no longer queued (on the wire, settled or withdrawn), so there is nothing to press.
   */
  async retryQueued(id: string): Promise<MutationResult | null> {
    const p = this.queue.find((q) => q.id === id);
    if (p === undefined) return null;
    const queued: MutationResult = { id: p.id, key: p.key, status: "queued", seq: null };
    if (p.waitIsServerNamed === true && (p.nextAt ?? 0) > this.now().getTime()) return queued;
    /* The press ends a hold a hung write left once the server cannot still be working on it, and that
       write goes first; before that it waits its turn behind it, our own backoff yielding to the
       press so the barrier's end sends it — see {@link endHold}. */
    let ended: string | null = null;
    if (this.outboxHold) {
      const gone = await this.endHold();
      if (gone === null) {
        delete p.nextAt;
        return queued;
      }
      ended = gone.ended;
    }
    const { ahead, out } = await this.outboxGate(async () => {
      const first = await this.dispatchEndedFirst(ended, p);
      const at = this.queue.indexOf(p);
      if (at < 0) return { ahead: first, out: null }; // a flush or a drive took it while this waited its turn
      this.queue.splice(at, 1);
      const o = await this.dispatchOnLane(p);
      if (o.held) this.queue.push(p);
      return { ahead: first, out: o };
    });
    if (ahead !== null) void this.settleReconcile("background");
    if (out === null) return null;
    if (out.held || out.timedOut || out.result === null) return queued;
    await this.settleReconcile(out.owed);
    return out.result;
  }

  /**
   * The withdrawal on disk — the row kept, marked, and read back as withdrawn by the next boot.
   * A refused mark falls back to the hard delete: either one keeps a restart from replaying the
   * row, and the in-memory key already keeps this session from sending it.
   */
  protected async markWithdrawn(p: PendingMutation, owe: boolean): Promise<boolean> {
    try {
      await this.store.commitLocal(
        [{ type: OUTBOX_TYPE, id: p.id, entity: { ...outboxEntryOf(p), withdrawn: true, ...(owe ? { withdrawOwed: true } : {}) } }], [],
      );
      return true;
    } catch {
      // No ending is said here: a send's is said once the server has answered, never ahead of it.
      // `true` only when the delete reached the disk: a row neither marked nor deleted can still be sent.
      return this.dropOutbox(p.id);
    }
  }

  /**
   * WHAT THE SERVER LAST SAID TO A CANCEL OF THIS KEY, or `undefined` when it was never asked. After an
   * `unknown`, `unreachable` or `unsupported` means the server could not answer for a send this disk
   * may have put on the wire; nothing means the disk refused the Cancel itself.
   */
  withdrawAnswerOf(key: string): WithdrawSendOutcome | undefined {
    return this.withdrawAnswers.get(key);
  }

  /** The key of every answer waiting to be collected: a send record is owed per KEY, never globally. */
  lateResultKeys(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const r of this.lateResults.values()) out.add(r.key);
    return out;
  }

  /** The browser says it has no network, so a request made now cannot leave this device. */
  protected static knownOffline(): boolean {
    return (globalThis as { navigator?: { onLine?: unknown } }).navigator?.onLine === false;
  }

  /** Ask the server about one Cancel. A throw is an answer nobody could read: `unreachable`. */
  protected async askWithdrawFor(key: string, draftId: string | null): Promise<WithdrawSendAnswer> {
    let answer: WithdrawSendAnswer;
    try {
      answer = await this.adapter.withdrawSend(key, draftId);
    } catch {
      answer = { outcome: "unreachable" };
    }
    this.withdrawAnswers.delete(key);
    this.withdrawAnswers.set(key, answer.outcome);
    if (this.withdrawAnswers.size > 256) this.withdrawAnswers.delete(this.withdrawAnswers.keys().next().value!);
    if (answer.outcome === "unsupported" && !this.unsupportedSaidFor.has(key)) {
      this.unsupportedSaidFor.add(key);
      if (this.unsupportedSaidFor.size > 256) this.unsupportedSaidFor.delete(this.unsupportedSaidFor.values().next().value!);
      try { this.withdrawUnsupported?.(); } catch { /* the log is a courtesy */ }
    }
    return answer;
  }

  protected askWithdraw(p: PendingMutation): Promise<WithdrawSendAnswer> {
    const draftId = p.createdRow?.id ?? (p.mutation as { draftId?: string | null }).draftId ?? null;
    return this.askWithdrawFor(p.key, draftId);
  }

  /** May this send's row have left, on this engine's copy of the disk ({@link persistedWired}). */
  protected rowWired(id: string): boolean {
    const row = this.store.get<unknown>(OUTBOX_TYPE, id);
    return isPersistedOutboxEntry(row) && persistedWired(row);
  }

  /**
   * ONE OWN SEND'S CANCEL, SETTLED BY THE SERVER'S ANSWER — its row is already marked withdrawn.
   * `said` is the Cancel's word; `result` what a surface waiting on the send hears, `null` while the
   * answer is owed. "Withdrawn" only on the server's word, or for a row that never left this disk
   * when the server could not answer; a wired row the server could not answer for is `unknown`.
   */
  protected async settleWithdrawn(
    p: PendingMutation, answer: WithdrawSendAnswer, later = false,
  ): Promise<{ said: WithdrawOutcome; result: MutationResult | null }> {
    const wired = p.wired === true || this.rowWired(p.id);
    const o = answer.outcome;
    /* ASKED AGAIN, AND THE SEND ITSELF FAILED: nothing left, but the person was told it was on its
       way or could not be asked. The send's own failure is the ending, so Send is offered again. */
    if (o === "failed" && later) {
      this.owedWithdraws.delete(p.id);
      this.withdrawnKeys.delete(p.key);
      this.sayEnded(p, "refused");
      await this.dropOutbox(p.id);
      return {
        said: "withdrawn",
        result: {
          id: p.id, key: p.key, status: "rolled_back", seq: null,
          error: new MutationRejectedError("A prior send under this key failed and was not delivered.", {
            code: "send_failed", retryable: false, ...(p.createdRow !== undefined ? { entityId: p.createdRow.id } : {}),
          }),
        },
      };
    }
    if (o === "withdrawn" || o === "failed" || (o === "unsupported" && !wired)) {
      this.owedWithdraws.delete(p.id);
      this.sayEnded(p, "withdrawn");
      await this.answeredWithdrawn(p);
      return { said: "withdrawn", result: withdrawnResult(p) };
    }
    if (o === "already_sent") {
      this.owedWithdraws.delete(p.id);
      this.withdrawnKeys.delete(p.key);
      this.sayEnded(p, "confirmed");
      await this.dropOutbox(p.id);
      return {
        said: "on_the_wire",
        result: {
          id: p.id, key: p.key, status: "confirmed", seq: null,
          firstSend: answer.firstSend ?? { status: "sent", at: this.now().toISOString() },
          ...(p.createdRow !== undefined ? { entityId: p.createdRow.id } : {}),
        },
      };
    }
    if (o === "unverified") {
      this.owedWithdraws.delete(p.id);
      return { said: "on_the_wire", result: await this.parkUnverified(p) };
    }
    /* `in_flight`, `unreachable`, or `unsupported` over a wired row: the Cancel stays owed. What a
       server answered counts toward the ceiling and backs off (its Retry-After first); no connection
       is asked again on the next drive, and counts only where the transport is the server's reach. */
    const counts = o !== "unreachable" || answer.answered === true || this.transportIsUnreachable;
    const result = await this.oweWithdraw(p, counts, answer.retryAfterMs);
    return { said: o === "in_flight" ? "on_the_wire" : wired ? "unknown" : "withdrawn", result };
  }

  /** The server said withdrawn: the row stays marked (a later boot drops it) and nothing is owed. */
  protected async answeredWithdrawn(p: PendingMutation): Promise<void> {
    delete p.withdrawOwed;
    try {
      await this.store.commitLocal([{ type: OUTBOX_TYPE, id: p.id, entity: { ...outboxEntryOf(p), withdrawn: true } }], []);
    } catch {
      await this.dropOutbox(p.id);
    }
  }

  /**
   * THE CANCEL STAYS OWED: off the queue, marked on disk, asked again by every drive and flush.
   * `counts`: an answer that spends the ceiling on the outbox's backoff (never shorter than the
   * server's Retry-After, capped at the outbox's hour); past it the row ends in the abandoned strip
   * as unconfirmed, never withdrawn, and Try again asks the withdraw, never the send.
   */
  protected async oweWithdraw(p: PendingMutation, counts: boolean, retryAfterMs?: number): Promise<MutationResult | null> {
    if (p.withdrawOwed !== true) {
      // The send's own failures say nothing about the Cancel: the debt starts with a clean count.
      p.attempts = 0;
      delete p.nextAt;
    }
    p.withdrawOwed = true;
    delete p.sending;
    this.withdrawnKeys.add(p.key);
    if (counts) {
      const attempts = (p.attempts ?? 0) + 1;
      p.attempts = attempts;
      if (attempts >= OUTBOX_MAX_SERVER_FAILURES) {
        this.owedWithdraws.delete(p.id);
        return this.abandonOwedWithdraw(p);
      }
      const backoff = Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_BACKOFF_CAP_MS);
      // The server's own wait, capped at the outbox's: a week's Retry-After would hold the composer a week.
      p.nextAt = this.now().getTime() + Math.max(backoff, Math.min(retryAfterMs ?? 0, OUTBOX_BACKOFF_CAP_MS));
    }
    this.owedWithdraws.set(p.id, p);
    await this.putOutbox(p);
    return null;
  }

  /** An owed Cancel past its ceiling, kept for the person: unconfirmed, and Try again asks again. */
  protected async abandonOwedWithdraw(p: PendingMutation): Promise<MutationResult | null> {
    const reported = new MutationRejectedError(WITHDRAW_UNCONFIRMED_SENTENCE, {
      code: "send_unverified", retryable: false, ...(p.createdRow !== undefined ? { entityId: p.createdRow.id } : {}),
    });
    const record: PersistedOutboxEntry = {
      ...outboxEntryOf(p), attempts: p.attempts ?? 0,
      lastError: { message: reported.message, code: reported.code, status: null },
    };
    try {
      await this.store.commitLocal([{ type: OUTBOX_ABANDONED_TYPE, id: p.id, entity: record }], [{ type: OUTBOX_TYPE, id: p.id }]);
    } catch {
      // Nothing moved: the debt stays and waits out a full cap, as `abandon` waits.
      p.nextAt = this.now().getTime() + OUTBOX_BACKOFF_CAP_MS;
      this.owedWithdraws.set(p.id, p);
      return null;
    }
    this.sayEnded(p, "refused");
    return { id: p.id, key: p.key, status: "rolled_back", seq: null, error: reported };
  }

  /**
   * THE SERVER COULD NOT CONFIRM THE SEND THIS CANCEL ASKED ABOUT: the send's own unverified ending,
   * parked in the abandoned strip as an unverified send is (Try again asks under the same key).
   */
  protected async parkUnverified(p: PendingMutation): Promise<MutationResult> {
    delete p.withdrawOwed;
    this.withdrawnKeys.delete(p.key);
    const reported = new MutationRejectedError(
      "We couldn't confirm this send. Check your Sent folder before retrying.",
      { code: "send_unverified", retryable: false, ...(p.createdRow !== undefined ? { entityId: p.createdRow.id } : {}) },
    );
    const record: PersistedOutboxEntry = {
      ...outboxEntryOf(p), attempts: 0,
      lastError: { message: reported.message, code: reported.code, status: null },
    };
    this.sayEnded(p, "refused");
    try {
      await this.store.commitLocal([{ type: OUTBOX_ABANDONED_TYPE, id: p.id, entity: record }], [{ type: OUTBOX_TYPE, id: p.id }]);
    } catch {
      this.abandonedLocally.set(p.id, record);
      this.localRefusalRev++;
    }
    return { id: p.id, key: p.key, status: "rolled_back", seq: null, error: reported };
  }

  /** ONE OWED CANCEL, ASKED AGAIN — from a drive, a flush, a claim that met the debt, or Try again. */
  protected async askOwed(p: PendingMutation): Promise<MutationResult> {
    this.overlays.delete(p.id);
    this.withdrawnKeys.add(p.key);
    const waiting: MutationResult = { id: p.id, key: p.key, status: "queued", seq: null };
    if (this.askingWithdraw.has(p.id)) return waiting;
    this.askingWithdraw.add(p.id);
    try {
      const settled = await this.settleWithdrawn(p, await this.askWithdraw(p), true);
      this.overlayRev++;
      this.notify();
      return settled.result ?? waiting;
    } finally {
      this.askingWithdraw.delete(p.id);
    }
  }

  /** Every owed Cancel whose wait is over, asked once; the answers that settled one. */
  protected async askOwedWithdraws(): Promise<MutationResult[]> {
    const ready = this.now().getTime();
    const out: MutationResult[] = [];
    for (const p of [...this.owedWithdraws.values()]) {
      if ((p.nextAt ?? 0) > ready || this.askingWithdraw.has(p.id)) continue;
      const r = await this.askOwed(p);
      if (r.status !== "queued") out.push(r);
    }
    return out;
  }

  /**
   * ANOTHER WINDOW'S SEND, MARKED HERE: the server decides, the disk carries the answer to the owning
   * engine, and the notice goes only after it. Withdrawn: the debt clears and the owning engine is told.
   * The server holds the send: the mark comes off and the owning engine asks under its own key. Anything
   * else leaves the row marked and owed, and whichever engine dispatches it asks again.
   */
  protected async settleForeignWithdraw(key: string, rows: PersistedOutboxEntry[], marked: boolean): Promise<WithdrawOutcome> {
    const e = rows[0]!;
    const draftId = (isCreatedRow(e.createdRow) ? e.createdRow.id : null)
      ?? (e.mutation as { draftId?: string | null }).draftId ?? null;
    const answer = await this.askWithdrawFor(key, draftId);
    /* The wire fact from the disk row the mark's own transaction read into this copy, not only the
       pre-Cancel one. A mark already there wrote nothing, so this copy may be stale: may have left. */
    const wired = !marked || rows.some((r) => persistedWired(r) || this.rowWired(r.id));
    const o = answer.outcome;
    const settle = async (act: OutboxRowAct): Promise<void> => {
      for (const r of rows) await this.store.decideOutboxRow!(r.id, act).catch(() => undefined);
    };
    if (o === "withdrawn" || o === "failed" || (o === "unsupported" && !wired)) {
      await settle({ kind: "answered" });
      this.notices?.post({ t: "withdraw", key, outcome: "withdrawn" });
      return "withdrawn";
    }
    if (o === "already_sent" || o === "unverified") {
      await settle({ kind: "unmark" });
      return "on_the_wire";
    }
    return o === "in_flight" ? "on_the_wire" : wired ? "unknown" : "withdrawn";
  }

  /**
   * Retry every queued mutation (reconnect path), preserving keys and order.
   *
   * Refuses to DISPATCH while {@link outboxHold} stands — a timed-out replay's request is
   * still in the air, and dispatching behind it could land an older value after a newer one —
   * but it still ANSWERS, one `queued` result per entry: `useMailSend.flush` re-arms its
   * backoff timer only when a result says its key is still queued, so an empty array here
   * would read as "nothing left" and stop the very retry loop that will deliver the send once
   * the hold clears. The entries stay queued and persisted; the hold's settle nudges a drive.
   */
  /**
   * IS THERE AN ANSWER WAITING WITH NO CALLER? — a non-destructive read, and the only one. `flushPending()` is the
   * road every such answer travels and it is DESTRUCTIVE by design: the entries it hands back are removed, so exactly
   * one consumer can have them. That makes it unusable as a question. A surface that wants to know whether there is
   * anything to collect had only two bad options — pull on every notification (a poll wearing a subscription's
   * clothes, and it takes the outbox gate each time) or infer it from the QUEUE, which cannot work for the case that
   * matters: a replayed entry leaves the queue the moment its turn is taken, so for a lone one "something is
   * pending" is never observable on a mount that did not issue it, and a rule armed on that transition never fires. Measured, not
   * reasoned: three pulls, all empty, and the answer still sitting in the map. So the question is asked directly.
   */

  /**
   * `notify()` fires immediately after a late answer is recorded, which makes "subscribe, then ask this" exact rather
   * than periodic.
   */
  hasLateResults(): boolean {
    return this.lateResults.size > 0;
  }

  async flushPending(): Promise<MutationResult[]> {
    // THE HOLD IS READ BEFORE JOINING, exactly as `mutate` reads it, and for the same reason:
    // the gate WAITS OUT a standing hold before releasing, so a check inside the gated body
    // could never see one and this method would sit out the hold instead of answering. Its
    // contract is to answer — `useMailSend.flush` re-arms its backoff only when a result says
    // the key is still queued, and an empty array reads as "nothing left".
    /**
     * LATE ANSWERS FIRST AND ABOVE THE HOLD CHECK, because a late answer is the answer to the very
     * request that armed the hold — below it, the settlement a locked composer is waiting on was
     * never handed over while the barrier stood, which is exactly when it exists.
     *
     * CLAIMED on the way in, HANDED OVER BY ID on the way out, never cleared wholesale: the claim
     * is what keeps a concurrent flush from handing one answer over twice or emptying the map
     * under this one, and the per-id removal is what keeps this flush from taking answers it is
     * not handing over.
     */
    const claimed = this.claimLate();
    if (this.outboxHold) {
      return [
        ...this.handOverLate(claimed),
        ...this.queue.map((p) => ({ id: p.id, key: p.key, status: "queued" as const, seq: null })),
      ];
    }
    try {
      // THE SAME SINGLE-FLIGHT every other outbox road takes — see {@link outboxGate}. Without it
      // two surfaces could flush concurrently and, for the null-key read verbs, land newer-then-older.
      const results = await this.outboxGate(() => this.flushPendingInner());
      // AND EVERY OWED CANCEL: the flush is the phone's only road, and a waiting surface's on the web.
      results.push(...await this.askOwedWithdraws());
      // OFF THE LANE. One drain covers the whole batch: they all finished before this line, so a
      // single drive that starts now began after every one of their POSTs returned and carries
      // every echo — the same happens-before the boot replay relies on.
      const owed = this.owedReconciles.splice(0);
      if (owed.length > 0) await this.settleReconcile(owed.includes("await") ? "await" : "background");
      /**
       * AND ANYTHING THAT LANDED WHILE THIS FLUSH WAS OPEN — claimed LAST, so the window covers
       * the reconcile drain too. A verb whose request outran its deadline settles at an arbitrary
       * moment, and that moment is very often inside the flush that is waiting for it: claimed
       * only on the way in, its answer sat in the map until some LATER flush happened to run, so a
       * send's settlement never reached the composer that was locked waiting for it.
       */
      claimed.push(...this.claimLate());
      results.unshift(...this.handOverLate(claimed));
      return results;
    } catch (err) {
      // A flush that never hands its claims over must not hold them: the next one takes them.
      for (const id of claimed) this.lateClaimed.delete(id);
      throw err;
    }
  }

  /** Every unclaimed late answer, marked as this flush's to hand over. */
  protected claimLate(): string[] {
    const ids: string[] = [];
    for (const id of this.lateResults.keys()) {
      if (this.lateClaimed.has(id)) continue;
      this.lateClaimed.add(id);
      ids.push(id);
    }
    return ids;
  }

  /** Hand the claimed answers to their one consumer, removing EXACTLY those — never `clear()`. */
  protected handOverLate(ids: readonly string[]): MutationResult[] {
    const out: MutationResult[] = [];
    for (const id of ids) {
      const r = this.lateResults.get(id);
      if (r !== undefined) out.push(r);
      this.lateResults.delete(id);
      this.lateClaimed.delete(id);
    }
    return out;
  }

  protected async flushPendingInner(): Promise<MutationResult[]> {
    // No in-flight wait and no hold check here: this body runs INSIDE {@link outboxGate}, which
    // does not release it until everything ahead has settled and no hold stands. A hold armed
    // while this was queued is therefore waited out by the gate — which is right for a caller
    // already committed to flushing. The hold that must NOT be waited out is one standing when
    // the host calls; `flushPending` reads that one before joining.
    if (this.outboxHold) {
      return this.queue.map((p) => ({ id: p.id, key: p.key, status: "queued" as const, seq: null }));
    }
    /**
     * NO BACKOFF GATE HERE, AND THAT IS DELIBERATE: `flushPending` is an EXPLICIT "try now" — a host calling it has
     * just done something (finished an action, regained a connection, watched a person press Send) and is asking for
     * this queue to go out. The backoff paces the AUTOMATIC drive, which retries on its own schedule with nobody
     * watching; applying it to a deliberate request means a person pressing a button and nothing happening for thirty
     * seconds, with no way to tell that from a hang. This gate WAS here for one commit, on the reasoning that a bound
     * should hold on every road out of the queue. Three mobile guards said otherwise within a minute: on that
     * platform `outboxAutoReplay` is false, so `flushPending` is the ONLY road, and gating it turned "one 500, then
     * an immediate in-place flush lands the send" into a silent queued state.
     */

    /**
     * The intuition was right about the shape and wrong about which road — the ceiling is what bounds this path, not
     * the delay, and it still applies: eight server-answered failures abandon the verb whether they arrived through
     * the drive or through here.
     */
    // A wait the SERVER named is honoured even here — see `waitIsServerNamed`. Our own backoff is
    // not: this is the explicit try-now road, and on mobile it is the only road.
    const ready = this.now().getTime();
    const serverWait = (p: PendingMutation): boolean => p.waitIsServerNamed === true && (p.nextAt ?? 0) > ready;
    // The snapshot is taken HERE, inside the gate body, and the entries stay on the queue until
    // their own turn — see {@link takeTurn}.
    const batch = this.queue.filter((p) => !serverWait(p)).sort(byAtN);
    // A verb waiting out the server's own interval is reported as queued rather than omitted, so a
    // caller gets one result per verb it is holding.
    const results: MutationResult[] = this.queue.filter(serverWait).map((p) => ({
      id: p.id, key: p.key, status: "queued" as const, seq: null,
    }));
    /**
     * DEADLINE-BOUNDED, like every other dispatch road. A timed-out attempt still OWNS its entry and
     * becomes the order barrier, so the rest of the batch stays queued rather than dispatched behind
     * it: a newer verb must not land before an older one that may yet commit. Reconciles owed by the
     * batch are issued AFTER the lane is released — see `dispatchOnLane`.
     */
    const owedHere: Array<"await" | "background"> = [];
    const answered = new Set<PendingMutation>();
    for (const p of batch) {
      if (this.outboxHold) break;
      // Retired by a same-key press or withdrawn by Cancel while an earlier entry was on the wire:
      // its replacement answers for the key, so this flush says nothing about it.
      if (this.takeTurn(p) === "gone") continue;
      const out = await this.dispatchOnLane(p);
      if (out.held) {
        this.queue.push(p);
        this.queue.sort(byAtN);
        break;
      }
      answered.add(p);
      if (out.timedOut || out.result === null) {
        results.push({ id: p.id, key: p.key, status: "queued", seq: null });
        break;
      }
      if (out.owed !== null) owedHere.push(out.owed);
      results.push(out.result);
    }
    for (const p of batch) {
      if (!answered.has(p) && this.queue.includes(p)) results.push({ id: p.id, key: p.key, status: "queued", seq: null });
    }
    this.owedReconciles.push(...owedHere);
    return results;
  }

  /**
   * ONE ENTRY OFF THE QUEUE, AT ITS OWN TURN — the dequeue rule of the flush and the boot replay.
   * Both lifted their whole batch off the queue before the first dispatch, so while entry 1 was on
   * the wire entries 2..n were in no collection a re-press, a supersession or Cancel could read: a
   * re-press minted a second key and the reply was delivered twice. Called inside a gate body with
   * no await between the read and the splice; `supersedeQueued` and `withdrawQueued` splice
   * synchronously, so an entry they took is "gone" here and is skipped.
   */
  protected takeTurn(p: PendingMutation): "taken" | "gone" {
    const at = this.queue.indexOf(p);
    if (at < 0) return "gone";
    this.queue.splice(at, 1);
    return "taken";
  }

  // Written in a later file of the engine; named here because this one calls them.
  protected abstract ownershipOn(): boolean;
  protected abstract followDisk(): Promise<void>;
  protected abstract sayEnded(p: { key: string; mutation: { kind: string } }, how: "confirmed" | "refused" | "withdrawn"): void;
  protected abstract settleConfirmed(id: string, m: EngineMutation, shadow?: boolean): boolean;
  protected abstract retireShadowsUnder(effects: readonly MutationEffect[]): void;
  protected abstract rekeyPromotedRule(overlayId: string, serverId: string): void;
}

/** The engine's class as this file's bodies name it: the statics they read are declared here. */
const OhmailEngine = EngineOptimisticMutations;
