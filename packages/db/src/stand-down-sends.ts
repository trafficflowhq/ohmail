import { and, eq } from "drizzle-orm";
import { drafts, mailboxes } from "./schema-mail.js";
import { recordChanges, type LedgerTx, type Tx } from "./change-log.js";
import { isMailboxDisabledReason, type MailboxDisabledReason } from "./mailbox-errors.js";
import { dialect } from "./dialect/index.js";

/**
 * Close the appointments an organizer is about to stop being able to keep. A pending scheduled
 * send lives in ONE organizer's own store; the portable profile carries no per-message state, so
 * it does not travel. Measured: a mailbox handed to Cloud, the standalone relaunched past due —
 * the scheduled-send pass lives behind the organizer gate, so the row still read `scheduled`
 * seventeen minutes late; the expiry is enforced inside a pass that may never run again. FAIL,
 * not TRAVEL: an adopted appointment would let BOTH organizers hold a live appointment for one
 * message — the double-send the lease prevents. Touches ONLY `status = 'scheduled'`; a concurrent
 * claim is arbitrated by the row lock. Here because the worker may not import services.
 */

/**
 * What the Drafts row quotes. Server copy, not a translated key: `drafts.send_error` is a stored
 * sentence both clients render verbatim inside their own frame, so these say the CAUSE and the
 * ACTION and never restate the failure. Keyed on the stand-down reason: the causes genuinely
 * differ and the product already distinguishes them. The ACTION clause is the same in every
 * member and names no destination: a destination would go stale — the mailbox can come back to
 * this install, and a stored sentence saying "schedule it again on ohmail Cloud" would be
 * standing advice to go somewhere the mailbox no longer is. The cause is past tense for the same
 * reason: a `send_error` outlives its own occasion.
 */
export const STAND_DOWN_SEND_SENTENCES: Record<MailboxDisabledReason, string> = {
  "organized_elsewhere:cloud":
    "ohmail Cloud took over organizing this mailbox, so the scheduled send was not made here. "
    + "Schedule it again where the mailbox is organized now.",
  "organized_elsewhere:local":
    "ohmail on another machine took over organizing this mailbox, so the scheduled send was not "
    + "made here. Schedule it again where the mailbox is organized now.",
  /* NOT "a phone does not send scheduled mail" — that was the first draft of this line and it is
     FALSE. The phone runs the same engine composition as the desktop and nothing gates the
     scheduled-send pass on the organizer kind, so a phone sends due mail exactly while it is
     open. What is true is the bound, and the bound is the detail a person needs. */
  "organized_elsewhere:mobile":
    "A phone took over organizing this mailbox, so the scheduled send was not made here. A phone "
    + "sends scheduled mail only while ohmail is open on it. Schedule it again where the mailbox "
    + "is organized now.",
  "organized_elsewhere:unknown":
    "Another ohmail organizer took over this mailbox, so the scheduled send was not made here. "
    + "Schedule it again where the mailbox is organized now.",
};

/**
 * What a REMOVED mailbox's Drafts row quotes — same storage rule (server copy, quoted verbatim by
 * both clients), a different sentence because the event differs in the one respect that matters.
 * Three clauses, each load-bearing: the CAUSE, past tense ("was removed" stays true however the
 * mailbox is connected again later); what was NOT done — the one thing the person will wonder is
 * whether the message itself is gone from the server, and nothing about a removal ever deletes
 * mail from the mailbox, so saying so is the answer to the question the failure raises; and the
 * ACTION, naming no destination — "connect the mailbox again" is the only true one, since unlike
 * a stand-down there is no other organizer to be sent to.
 */
export const REMOVED_MAILBOX_SEND_SENTENCE =
  "This mailbox was removed from ohmail, so the scheduled send was not made. "
  + "Nothing was deleted from the mail server. Connect the mailbox again to schedule it.";

/**
 * What a RELEASED mailbox's Drafts row quotes (mail 0088) — the third occasion, with its own
 * sentence. The three differ in the only thing a stored sentence must get right: WHERE the
 * message can be sent from now. A stand-down hands the mailbox to another organizer; a removal
 * hands it to nobody and takes the credentials; a RELEASE hands it to nobody and keeps everything
 * — still connected, mirror still growing, one press organizes it here again. Quoting the
 * stand-down's sentence would tell somebody who chose to stop that another install had claimed
 * their mailbox — the class of false statement `MailboxService.delete` clears `disabled_reason`
 * to avoid. Past tense on the cause: the sentence must survive the mailbox being organized again.
 */
export const RELEASED_ORGANIZER_SEND_SENTENCE =
  "This install stopped organizing this mailbox, so the scheduled send was not made. "
  + "Nothing was deleted from the mail server. Organize the mailbox again, or schedule it "
  + "where it is organized now.";

export interface StandDownSendsInput {
  accountId: string;
  mailboxId: string;
  /** The reason the mailbox is standing down — chooses the sentence. */
  reason: MailboxDisabledReason;
  now: Date;
  /**
   * The sentence, when the occasion is not a stand-down (mail 0088). Omitted, it is looked up
   * from {@link reason}; supplied, it replaces the lookup — for the one occasion sharing this
   * function's precondition (`organizer_role = 'reader'`) and not its cause: a deliberate
   * release. A parameter rather than a fourth `reason` member: `MailboxDisabledReason` is a
   * closed set with a CHECK, and a release is NOT a member — nobody organizes this mailbox
   * elsewhere. Not a second exported function like the removal's: a release leaves a READER,
   * sharing this precondition exactly, and a third copy of the guarded UPDATE would be a third
   * place for the lock order to drift. The caller still passes a `reason` for the log line.
   */
  sentence?: string;
}

export interface StandDownSendsResult {
  /** Appointments closed with a sentence. Zero is the ordinary case. */
  closed: number;
  /** The drafts that were closed — the log line's evidence, and nothing else reads it. */
  draftIds: string[];
  /**
   * The highest `change_log` seq this close emitted, or null when it closed nothing. The delta
   * contract's `X-Sync-Seq` echo needs a number (every write advances the sequence it echoes),
   * and the seqs exist — `recordChanges` returns them and this used to drop them on the floor. A
   * caller that answers 204 with no seq leaves the mirror that made the request with no target to
   * wait for: it converges on the next `/sync` drain or on the NOTIFY, both later than
   * read-your-writes, one of which can be missed. The HIGHEST of the batch, because that is what
   * the contract echoes and what the wake names.
   */
  seq: bigint | null;
}

/**
 * The UPDATE itself, shared by the two events that end an organizer's right to keep an
 * appointment — a stand-down and a REMOVAL. Private: the precondition is what distinguishes them,
 * and a caller that could pick its own sentence could write one true of neither event. Only
 * `status = 'scheduled'`; both halves of the bookkeeping cleared so neither claim arm can find
 * the row again; the change rows written in the same transaction so no mirror observes the closed
 * row without the `draft` update announcing it. Takes a `tx` that ALREADY holds the mailbox row:
 * both callers read it `FOR UPDATE` first — the lock order (mailbox before draft) is kept there,
 * and putting the read in here would hide the one ordering decision this module makes.
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
 * Close every pending appointment on ONE mailbox, with the stand-down sentence. Scoped by account
 * AND mailbox: only the mailbox standing down loses its appointments, and the account predicate
 * lets the planner use `drafts_account_updated_idx` rather than scanning every live appointment.
 * ONE transaction with the change rows, so no mirror observes the closed row without the `draft`
 * update announcing it. THROWS on a database fault, deliberately: the callers are stand-down
 * paths with their own logging and their own retry — the desktop re-runs this on its next launch
 * while the row still says stood down, and on Cloud the hosted pass refuses a `disabled` mailbox
 * at due time and closes the row itself. Swallowing here would hide the fault from all of them.
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
    // The row must actually BE stood down, read inside THIS transaction. The decision is
    // process-local; the durable stand-down is a row, and they can disagree where it matters: on
    // Cloud the lifecycle write is FENCED — a deposed instance's close must be refused with it,
    // or it cancels an appointment the successor accepted; reading the row inherits the fence's
    // answer. `FOR UPDATE`, mailbox before any draft: a plain read stood here one round and was
    // wrong — separate snapshots under READ COMMITTED. No deadlock with scheduling: the scheduler
    // locks the DRAFT and only reads the mailbox. The residual — a schedule committing after this
    // UPDATE — is bounded: a desktop store is one serialized connection, and the hosted pass
    // refuses a `disabled` mailbox at due time. The predicate is `organizer_role = 'reader'`
    // (mail 0083): the loser is now a READER; the old predicate would close nothing forever.
    /* THE ROW LOCK THROUGH THE SEAM. On the device store it is the identity, and that is not a
       weakening: the store is reached through ONE serialized connection, so there is no second
       writer for a lock to exclude — a second connection to the same file does not contend, it
       fails. Read from the handle the CALLER passed, which every caller brands: a driver's
       transaction object carries none of its own, and the nested one opened below carries none
       either. */
    const d = dialect(db);
    const [mb] = await d.forUpdate(tx.select({ role: mailboxes.organizerRole })
      .from(mailboxes).where(eq(mailboxes.id, input.mailboxId)).limit(1));
    if (!mb || mb.role !== "reader") {
      return { closed: 0, draftIds: [], seq: null };
    }
    return closeAppointmentsWithSentence(tx, {
      accountId: input.accountId,
      mailboxId: input.mailboxId,
      // An explicit sentence wins; otherwise the reason chooses. See `StandDownSendsInput.sentence`
      // for why the release supplies one rather than adding a fourth `reason` member.
      sentence: input.sentence ?? STAND_DOWN_SEND_SENTENCES[reason],
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
 * Close every pending appointment on a mailbox the user has just REMOVED. Not the stand-down
 * close with a fourth reason: the two events differ in WHERE the message can be sent from now — a
 * stand-down hands the mailbox to another organizer; a removal hands it to NOBODY, and a
 * stand-down sentence on a removal would claim another install took a mailbox the person
 * disconnected. The precondition is the mirror image: `disabled` with a reason is a stand-down,
 * with none a removal. One module, one UPDATE, two preconditions, two sentences. Runs INSIDE the
 * caller's transaction: `MailboxService.delete` already holds the mailbox row `FOR UPDATE` —
 * closing anywhere else leaves a window with no credentials and a live appointment.
 */
export async function closeRemovedMailboxAppointments(
  db: Tx, input: RemovedMailboxSendsInput,
): Promise<StandDownSendsResult> {
  return db.transaction(async (tx) => {
    // The stand-down's read, with the mirrored predicate. The row lock for the same reason and
    // in the same order (mailbox before draft): the caller holds this row already, so this is a
    // no-op re-entry there, and it keeps the function correct for any future caller that does
    // not.
    const d = dialect(db);
    const [mb] = await d.forUpdate(tx.select({ status: mailboxes.status, reason: mailboxes.disabledReason })
      .from(mailboxes).where(eq(mailboxes.id, input.mailboxId)).limit(1));
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
