import { and, eq } from "drizzle-orm";
import { drafts, mailboxes } from "./schema-mail.js";
import { recordChanges, type LedgerTx, type Tx } from "./change-log.js";
import { isMailboxDisabledReason, type MailboxDisabledReason } from "./mailbox-errors.js";

/**
 * CLOSE THE APPOINTMENTS AN ORGANIZER IS ABOUT TO STOP BEING ABLE TO KEEP.
 *
 * ── THE STATE THIS EXISTS TO DELETE ────────────────────────────────────────────────────────
 *
 * A pending scheduled send (`drafts.status = 'scheduled'`, `send_at` in the future) is an
 * appointment in ONE organizer's own store. It is not part of the portable profile in
 * `ohmail/_meta` — that document carries screener entries, rules, notify rules, the away
 * responder and tag names, and deliberately no per-message state and no drafts — so it does not
 * travel when a mailbox changes hands.
 *
 * Measured end to end on a real mailbox moved from a standalone install to a managed Cloud
 * account: the appointment was made on the standalone install, the mailbox was handed over, and
 * the standalone was relaunched past the due time. It stood down
 * (`organized_elsewhere:cloud`), `syncUntilQuiet()` returned zero cycles on start and on four
 * further polls, and the scheduled-send pass was never entered once — because that pass lives
 * inside the drain, and the drain is behind the organizer gate. Seventeen minutes past due the
 * row still read `status: 'scheduled'`, `send_error: null`, and the Drafts screen still said
 * **"Sends Tue 14:50"** for a time that had gone. Nothing would ever change it: a pending
 * scheduled send did not travel, was never delivered, and was never reported as failed.
 *
 * ── AND WHY THE EXPIRY DID NOT SAVE IT ─────────────────────────────────────────────────────
 *
 * `SCHEDULED_SEND_EXPIRY_MS` exists precisely so that a day-late appointment is closed with a
 * sentence rather than delivered quietly. It is enforced INSIDE `runScheduledSendPass`, which is
 * inside the drain, which is behind the gate — so the one case where the pass can never run
 * again is the one case the expiry cannot reach. **An expiry enforced inside a pass that may
 * never run is not an expiry.** This function is where that enforcement moves to for the
 * stand-down case: the side that is ceasing to organize closes its own appointments, in the
 * stand-down itself, with no pass involved.
 *
 * ── THE FIX IS "FAIL", NOT "TRAVEL", AND THAT IS A RULING RATHER THAN A SHORTCUT ───────────
 *
 * The alternative was to serialize pending appointments into the travelling profile so the new
 * organizer adopts them. It is rejected on three grounds and the third is the decisive one:
 * the profile document is configuration and would have to start carrying a message's
 * recipients, subject and body; leave-anytime means cancellation is not a migration, so a
 * mailbox changing hands is not a promise that scheduled work follows it; and an adopted
 * appointment is a window in which BOTH the old organizer and the new one hold a live
 * appointment for one message, which is the double-send this whole lease exists to prevent.
 * Closing keeps the invariant trivially: the appointment dies with the organizer that made it,
 * the row's `send_key` goes NULL so neither claim arm can ever find it again, and the person is
 * told, in the Drafts row, that it was not sent and where to schedule it again.
 *
 * ── WHAT IT TOUCHES, AND WHAT IT MUST NOT ──────────────────────────────────────────────────
 *
 * ONLY `status = 'scheduled'`. That status provably has no reservation and no live attempt: the
 * pass's claim flips a row to `'draft'` in the same transaction that takes its row lock, and
 * `SendService.reserve` commits the flip to `'sending'` together with the `outbound_sends`
 * INSERT. So:
 *
 *   'draft' + send_key   the CLAIM WINDOW — an invocation is attempting this send right now, or
 *                        died doing it and the pass's recovery arm replays the SAME key. Clearing
 *                        the key here would either cut the ground from under a live attempt or
 *                        strand the replay.
 *   'sending'            a reservation EXISTS. Closing it would clear the key a `pending`
 *                        reservation is resolved by, and leave the stuck-send alarm paging on a
 *                        row nothing can ever finish.
 *   terminal             the finalizers already spoke.
 *
 * A concurrent claim is arbitrated by the row lock rather than by a check: this UPDATE blocks on
 * a row the claim holds, then re-evaluates `status = 'scheduled'` after the claim commits and
 * correctly matches nothing. The claim wins, and the send it is making is the one the organizer
 * was still entitled to make when it started.
 *
 * ── WHY IT LIVES IN THIS PACKAGE ───────────────────────────────────────────────────────────
 *
 * `upsertDesiredSeen`'s reason, verbatim. Four call sites need it — the sidecar's lease gate and
 * its launch catch-up, the worker's `mayOrganize`, and the reconcile cron's stand-down — and the
 * worker may not import `@trafficflow/services` at runtime (its barrel drags an HTML sanitiser
 * into the worker's boot graph, a hard `ERR_REQUIRE_CYCLE_MODULE` on Node 23; see
 * `apps/worker/package.json` "//services-is-test-only"). Two spellings of "close an appointment
 * a stand-down orphaned" would be two answers to what the person is told. This module reaches
 * `schema-mail.js`, `change-log.js` and `mailbox-errors.js` alone, which keeps it inside the
 * desktop engine's closure rule (`index.ts`'s barrel header).
 */

/**
 * WHAT THE DRAFTS ROW QUOTES. Server copy, not a translated key: `drafts.send_error` is a stored
 * sentence and both clients render it verbatim inside their own frame — the webapp's
 * `scheduleFailedNote` ("This message wasn't sent at its scheduled time: {reason}") and the
 * phone's identical one. So these say the CAUSE and the ACTION and never restate the failure.
 *
 * Keyed on the stand-down reason because the three CAUSES genuinely differ and the product
 * already distinguishes them in the mailbox strip (`standDown_organized_elsewhere_*`).
 *
 * The ACTION clause is deliberately the same in all three and names no destination. A destination
 * would go stale: the mailbox can come back to this install afterwards ("Organize from this
 * machine"), and a stored sentence saying "schedule it again on ohmail Cloud" would then be
 * standing advice to go somewhere the mailbox no longer is. The cause is written in the past
 * tense for the same reason — it stays true whatever happens to the mailbox next. A `send_error`
 * outlives its own occasion, so every clause in it has to.
 */
export const STAND_DOWN_SEND_SENTENCES: Record<MailboxDisabledReason, string> = {
  "organized_elsewhere:cloud":
    "ohmail Cloud took over organizing this mailbox, so the scheduled send was not made here. "
    + "Schedule it again where the mailbox is organized now.",
  "organized_elsewhere:local":
    "ohmail on another machine took over organizing this mailbox, so the scheduled send was not "
    + "made here. Schedule it again where the mailbox is organized now.",
  "organized_elsewhere:unknown":
    "Another ohmail organizer took over this mailbox, so the scheduled send was not made here. "
    + "Schedule it again where the mailbox is organized now.",
};

/**
 * WHAT A REMOVED MAILBOX'S DRAFTS ROW QUOTES. Same storage rule as the record above — server
 * copy, written once, quoted verbatim by both clients inside their own frame — and a DIFFERENT
 * sentence because the event is different in the one respect that matters to a reader.
 *
 * Three clauses, and each is load-bearing:
 *
 *  · THE CAUSE, past tense. "was removed" stays true however the mailbox is connected again
 *    later, which a stored sentence has to survive; the stand-down record's header states the
 *    same rule and this is the same discipline applied to a different occasion.
 *  · WHAT WAS **NOT** DONE. A person who has just removed a mailbox is being told, by a draft
 *    they wrote, that something did not happen — and the one thing they will wonder is whether
 *    the message itself is gone from the server. It is not, and nothing about a removal ever
 *    deletes mail from the mailbox. Saying so here is not reassurance nobody asked for; it is
 *    the answer to the question the failure raises.
 *  · THE ACTION, naming no destination. "Connect the mailbox again" is the only true one:
 *    unlike a stand-down there is no other organizer to be sent to, and a sentence pointing at
 *    one would be advice to go somewhere the mailbox is not.
 */
export const REMOVED_MAILBOX_SEND_SENTENCE =
  "This mailbox was removed from ohmail, so the scheduled send was not made. "
  + "Nothing was deleted from the mail server. Connect the mailbox again to schedule it.";

export interface StandDownSendsInput {
  accountId: string;
  mailboxId: string;
  /** The reason the mailbox is standing down — chooses the sentence. */
  reason: MailboxDisabledReason;
  now: Date;
}

export interface StandDownSendsResult {
  /** Appointments closed with a sentence. Zero is the ordinary case. */
  closed: number;
  /** The drafts that were closed — the log line's evidence, and nothing else reads it. */
  draftIds: string[];
  /**
   * THE HIGHEST `change_log` SEQ THIS CLOSE EMITTED, or null when it closed nothing.
   *
   * The delta contract's `X-Sync-Seq` echo (the delta contract's own rule: every write advances the sequence it echoes) needs a number to echo, and
   * the seqs exist — `recordChanges` returns them and this used to drop them on the floor. A
   * caller that answers 204 with no seq leaves the mirror that made the request with no target
   * to wait for: it converges on the next `/sync` drain or on the NOTIFY, both of which are
   * later than read-your-writes, and one of which can be missed.
   *
   * The HIGHEST of the batch, because that is what the contract echoes and what the wake names.
   */
  seq: bigint | null;
}

/**
 * THE UPDATE ITSELF, shared by the two events that end an organizer's right to keep an
 * appointment — a stand-down and a REMOVAL. Private: the precondition is what distinguishes
 * them, and a caller that could pick its own sentence could write one that is not true of
 * either event.
 *
 * Everything the header says about what this touches applies here and is not repeated: only
 * `status = 'scheduled'`, both halves of the bookkeeping cleared so neither claim arm can find
 * the row again, and the change rows written in the same transaction so no mirror observes the
 * closed row without the `draft` update that announces it.
 *
 * It takes a `tx` that ALREADY holds the mailbox row. Both callers read that row `FOR UPDATE`
 * before calling, which is where the lock order (mailbox before draft) is kept — putting the
 * read in here would hide the one ordering decision this module makes.
 */
async function closeAppointmentsWithSentence(
  // `LedgerTx` and not `Tx`: `recordChanges` allocates change sequence numbers and needs a real
  // transaction handle, not any query runner. Both callers already have one — they are inside
  // `db.transaction` — so this is the type the shared core has always effectively required.
  tx: LedgerTx,
  input: { accountId: string; mailboxId: string; sentence: string; now: Date },
): Promise<StandDownSendsResult> {
  const closed = await tx.update(drafts)
    .set({
      status: "draft",
      // The appointment is over: both halves of the bookkeeping go, which is also what makes
      // the row unfindable by either claim arm (both require a standing `send_key`).
      sendAt: null,
      sendKey: null,
      sendError: input.sentence,
      updatedAt: input.now,
    })
    .where(and(
      eq(drafts.accountId, input.accountId),
      eq(drafts.mailboxId, input.mailboxId),
      // ONLY a standing appointment. See the header for why 'draft', 'sending' and the
      // terminal statuses are somebody else's rows.
      eq(drafts.status, "scheduled"),
    ))
    .returning({ id: drafts.id });
  let seq: bigint | null = null;
  if (closed.length > 0) {
    const seqs = await recordChanges(tx, closed.map((r) => ({
      accountId: input.accountId, entityType: "draft" as const, entityId: r.id,
      op: "update" as const, meta: null,
    })));
    seq = seqs[seqs.length - 1] ?? null;
  }
  return { closed: closed.length, draftIds: closed.map((r) => r.id), seq };
}

/**
 * Close every pending appointment on ONE mailbox, with the stand-down sentence.
 *
 * Scoped by account AND mailbox: an account may hold several mailboxes and only the one standing
 * down loses its appointments. The account predicate is also what lets the planner use
 * `drafts_account_updated_idx` rather than scanning every live appointment in the database.
 *
 * ONE TRANSACTION with the change rows, so no mirror can ever observe the closed row without the
 * `draft` update that announces it — the phone's Scheduled screen and the webapp's Drafts list
 * both learn this the way they learn every other draft change.
 *
 * THROWS on a database fault, deliberately: the callers are stand-down paths that each have
 * their own logging convention and their own answer to a failed write, and every one of them
 * has a retry — the desktop re-runs this on its next launch while the row still says stood down,
 * and on Cloud the hosted pass refuses a `disabled` mailbox at due time and closes the row
 * itself. Swallowing here would hide the fault from all four of them.
 */
export async function closeStoodDownAppointments(
  db: Tx, input: StandDownSendsInput,
): Promise<StandDownSendsResult> {
  // `markMailboxStoodDown`'s coercion, applied to the sentence rather than to the column: an
  // unrecognised reason must not mean an appointment keeps lying. Unreachable from today's
  // tree — the parameter is already typed — and it is what keeps the record lookup total.
  const reason: MailboxDisabledReason =
    isMailboxDisabledReason(input.reason) ? input.reason : "organized_elsewhere:unknown";
  return db.transaction(async (tx) => {
    // ── THE ROW MUST ACTUALLY BE STOOD DOWN, READ INSIDE THIS TRANSACTION ──────────────────
    //
    // Every caller has just decided to stand down, so this looks redundant — and it is not. The
    // DECISION is process-local; the durable stand-down is a row, and the two can disagree in
    // exactly one direction that matters. On Cloud, `markMailboxStoodDown` is FENCED: an
    // instance that read a stand-down verdict and then lost the shard has its lifecycle write
    // refused, and its close must be refused with it — otherwise a deposed leader cancels an
    // appointment the successor legitimately accepted after re-organizing the mailbox. Reading
    // the row is how this write inherits the fence's answer without taking the fence, which it
    // must not: `lifecycleWhere` also refuses a mailbox that is ALREADY disabled, so a close
    // gated on the fenced write's own return value would never run for the population this
    // whole function exists for — an install stood down long before this code existed.
    //
    // `FOR UPDATE`, AND THE MAILBOX ROW IS TAKEN BEFORE ANY DRAFT — the order this codebase
    // already keeps, and the reason it keeps it is written out beside the other pass that locks
    // this row ("Recorded here so the next reader does not 'fix' the order back").
    //
    // The lock is what makes this check MEAN anything. A plain read stood here for one round and
    // was wrong: it and the UPDATE below take separate snapshots under READ COMMITTED, so a
    // lifecycle transition committing `connected` between them left the UPDATE running with a
    // predicate that no longer looked at the mailbox at all — and it would then cancel an
    // appointment a successor had legitimately accepted. Holding the row instead totally orders
    // this against every writer of `mailboxes` (the stand-down, the takeover, the re-enable),
    // which is the whole set of transitions that could make this close wrong.
    //
    // It cannot deadlock with scheduling, and that was checked rather than assumed:
    // `ScheduleService.schedule` locks the DRAFT and only READS the mailbox — it takes no lock on
    // this row, so there is no cycle to close. (A deadlock argument against this lock stood here
    // for one round and rested on that premise being false.)
    //
    // WHAT THE LOCK DOES NOT EXCLUDE, and why that is acceptable rather than merely accepted.
    // The residual is one interleaving: a schedule that read the mailbox as connected, has not
    // yet taken its draft lock when this UPDATE scans past the row, and commits `'scheduled'`
    // afterwards. (The other order is already safe — this UPDATE blocks on the draft lock the
    // scheduler holds, then re-evaluates against the committed row and closes it.) Two standing
    // properties bound it:
    //
    //  · on a DESKTOP install the window does not exist. That store serves the engine and the
    //    app's own requests over a SINGLE connection, so two transactions on it cannot interleave
    //    at all — and it is the door on which this orphan was observed.
    //  · on a hosted account the scheduled-send pass is the standing backstop: it claims the due
    //    row, `SendService.reserve` refuses a mailbox whose row is `disabled`, and the
    //    appointment is closed with a sentence then.
    //
    // So the residual is an appointment reported as failed WHEN IT COMES DUE rather than at the
    // stand-down — a later honest failure, not the silent one this function exists for. Both
    // properties are held by tests beside their own code rather than by this comment.
    //
    // ── THE PREDICATE IS `organizer_role = 'reader'` (mail 0083), NOT `disabled` + A REASON ──
    //
    // It used to read `status='disabled' AND disabled_reason IS NOT NULL`, because that pair WAS
    // the stand-down: the loser stopped entirely. A loser is now a READER — connected, syncing,
    // on the roster — so the old predicate matches nothing a stand-down writes any more, and
    // leaving it would have made this function silently close zero appointments for ever: the
    // exact orphan it exists to prevent, restored, with the tests still green because they set
    // up the row the old way.
    //
    // The discriminator against a REMOVAL survives the change intact and gets sharper. A removal
    // is `status='disabled'` with no reason and keeps `organizer_role='organizer'` — nothing
    // demoted it, the row is simply a tombstone — so the two preconditions are now disjoint on a
    // column each, rather than on two readings of one. That matters because the sentences differ
    // in the only thing they must get right: "schedule it again where the mailbox is organized
    // now" is true of a handover and false about a mailbox nobody organizes.
    const [mb] = await tx.select({ role: mailboxes.organizerRole })
      .from(mailboxes).where(eq(mailboxes.id, input.mailboxId)).for("update").limit(1);
    if (!mb || mb.role !== "reader") {
      return { closed: 0, draftIds: [], seq: null };
    }
    return closeAppointmentsWithSentence(tx, {
      accountId: input.accountId,
      mailboxId: input.mailboxId,
      sentence: STAND_DOWN_SEND_SENTENCES[reason],
      now: input.now,
    });
  });
}

export interface RemovedMailboxSendsInput {
  accountId: string;
  mailboxId: string;
  now: Date;
}

/**
 * Close every pending appointment on a mailbox the USER HAS JUST REMOVED.
 *
 * ── WHY THIS IS NOT `closeStoodDownAppointments` WITH A FOURTH REASON ───────────────────────
 *
 * The two events differ in the only thing the stored sentence has to get right: WHERE the
 * message can be sent from now. A stand-down hands the mailbox to another organizer, so
 * "schedule it again where the mailbox is organized now" is both true and actionable. A removal
 * hands it to NOBODY — the row is a tombstone, the credentials are gone, and there is no
 * "where" to send the reader to. Storing a stand-down sentence on a removal would be the exact
 * class of false statement `MailboxService.delete` already clears `disabled_reason` to avoid:
 * telling somebody another install has claimed a mailbox they themselves disconnected.
 *
 * The PRECONDITION is the mirror image of the stand-down's and is the reason both live here:
 * `disabled` with a reason is a stand-down, `disabled` with none is a removal, and that
 * discriminator is the product's, not this module's (`identity.ts` resurrects a paused mailbox
 * and never a retired one; the census in `packages/db/test` refuses a null-reason write as a
 * stand-down site for the same reason). One module, one spelling of the UPDATE, two
 * preconditions and two sentences — which is what keeps the two events from drifting into two
 * answers about what the person is told.
 *
 * ── IT RUNS INSIDE THE CALLER'S TRANSACTION, AND THAT IS THE POINT ──────────────────────────
 *
 * `MailboxService.delete` already holds this mailbox row `FOR UPDATE` and is, in the same
 * transaction, writing the tombstone and deleting the credentials. Closing the appointments
 * anywhere else would leave a window in which the mailbox has no credentials and a live
 * appointment still points at it. The row read below is therefore a re-read of a row this
 * transaction already owns — free, and it is what makes the function total: it refuses to close
 * anything on a mailbox that is not, at this instant, a removal.
 */
export async function closeRemovedMailboxAppointments(
  db: Tx, input: RemovedMailboxSendsInput,
): Promise<StandDownSendsResult> {
  return db.transaction(async (tx) => {
    // The stand-down's read, with the mirrored predicate. `FOR UPDATE` for the same reason and
    // in the same order (mailbox before draft): the caller holds this row already, so this is a
    // no-op re-entry there, and it keeps the function correct for any future caller that does
    // not.
    const [mb] = await tx.select({ status: mailboxes.status, reason: mailboxes.disabledReason })
      .from(mailboxes).where(eq(mailboxes.id, input.mailboxId)).for("update").limit(1);
    if (!mb || mb.status !== "disabled" || mb.reason !== null) {
      return { closed: 0, draftIds: [], seq: null };
    }
    return closeAppointmentsWithSentence(tx, {
      accountId: input.accountId,
      mailboxId: input.mailboxId,
      sentence: REMOVED_MAILBOX_SEND_SENTENCE,
      now: input.now,
    });
  });
}
