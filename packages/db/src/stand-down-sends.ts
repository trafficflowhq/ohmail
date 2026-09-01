import { and, eq } from "drizzle-orm";
import { drafts } from "./schema-mail.js";
import { recordChanges, type Tx } from "./change-log.js";
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
    const closed = await tx.update(drafts)
      .set({
        status: "draft",
        // The appointment is over: both halves of the bookkeeping go, which is also what makes
        // the row unfindable by either claim arm (both require a standing `send_key`).
        sendAt: null,
        sendKey: null,
        sendError: STAND_DOWN_SEND_SENTENCES[reason],
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
    if (closed.length > 0) {
      await recordChanges(tx, closed.map((r) => ({
        accountId: input.accountId, entityType: "draft" as const, entityId: r.id,
        op: "update" as const, meta: null,
      })));
    }
    return { closed: closed.length, draftIds: closed.map((r) => r.id) };
  });
}
