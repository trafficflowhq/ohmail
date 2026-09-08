import { and, eq, isNull, lt, ne, or } from "drizzle-orm";

import { mailboxes } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * The youngest a standing `sync_requested_at` may be before a filing decision re-stamps it.
 *
 * 5 s, the same figure and the same argument as the pull verb's `PULL_MIN_GAP_MS`
 * (`mailbox-service.ts`): comfortably past the worker's ~3 s kick scan, so a stamp older than
 * this is one the scan has plausibly missed (or a worker that is down), and re-stamping is signal
 * rather than hammering. Named separately rather than imported because `packages/services` is
 * downstream of this package — the VALUE is one decision, recorded in both doc blocks, and the
 * census test beside this module pins them equal.
 */
export const FILING_DOORBELL_MIN_GAP_MS = 5_000;

/**
 * ═══ RING THE WORKER'S DOORBELL FOR A FILING DECISION ════════════════════════════════════════
 *
 * ── THE MEASURED WAIT THIS EXISTS TO END ────────────────────────────────────────────────────
 *
 * Invariant #3: the API never opens IMAP. A press writes `folder_state` and returns; the worker
 * performs the move. What decides how long that takes is the worker's ROTATION, not a per-mailbox
 * timer: a 60 s tick QUEUES one serialized pass, every mailbox gets one bounded turn in it, and
 * `reconcileFolders` runs on that turn. So a single pending move waits the rest of the running
 * pass plus its own turn — minutes on a deployment with a dozen mailboxes, and longer on a first
 * rotation after a restart, when every mailbox's turn is a cold one.
 *
 * That wait was invisible and unnecessary. `sync_requested_at` (mail 0049) is exactly the lever:
 * the worker's ~3 s kick scan notices the stamp, marks the mailbox woken, and the cycle serves it
 * one ORDINARY bounded turn out of rotation. Folder operations ring it, a send rings it, the pull
 * verb rings it, the Not-junk rescue rings it — and a FILING DECISION, the most common write in
 * the product, did not. It was the one user action whose result waited for a rotation.
 *
 * ── WHY IT IS ONE COLUMN AND NOT A QUEUE ────────────────────────────────────────────────────
 *
 * The doorbell is not a work item: the reconcile pass reads the pending rows itself. This only
 * says "come sooner". So there is nothing to enqueue, nothing to de-duplicate, and a lost stamp
 * costs one rotation rather than a move — the poll is the floor beneath it either way.
 *
 * ── THE RATE LIMIT LIVES IN THE UPDATE'S OWN PREDICATE, AS THE PULL VERB'S DOES ─────────────
 *
 * A stamp younger than {@link FILING_DOORBELL_MIN_GAP_MS} is LEFT STANDING — it is already being
 * answered, and the kick clears it within seconds of acting on it. So screening fifty messages in
 * a row degrades to one worker visit per gap per mailbox rather than fifty. No token bucket and no
 * new table: the column IS the state, and the failure mode of the predicate being wrong is one
 * extra bounded visit, never an unbounded one.
 *
 * `ne(status, 'disabled')` is the same narrowing every other writer of this column applies: a
 * mailbox the user disconnected or the lease stood down is not owed a visit, and stamping one
 * would ask the worker to wake for a mailbox it will correctly decline to serve. A READER is
 * deliberately still rung — the decision it records is drained by the organizer through the
 * request path, and the sooner the organizer's own cycle comes round the sooner that happens.
 *
 * ── CALLED INSIDE THE DECIDING TRANSACTION, AND `folder-ops-service` SET THAT PRECEDENT ─────
 *
 * The stamp commits with the decision or not at all, which is the only ordering that cannot
 * announce work that was rolled back. `folder-ops-service.ts` writes this column inside its own
 * transaction for the same reason, so a mailbox-row UPDATE inside a message-writing transaction
 * is an established chain here rather than a new one. Call it LAST, after the `folder_state`
 * write: the mailbox row is then always the final lock in the chain.
 *
 * `now` is the caller's clock on both sides of the comparison — the value written and the age
 * threshold — so the throttle cannot be widened or narrowed by a skew between two clocks. The
 * column's only reader is the worker's kick scan, which compares against its own instant; a few
 * hundred milliseconds of API-to-worker skew cannot matter to a five-second gap, which is why
 * this does not need the pull verb's stricter DB-clock discipline (that one exists because the
 * pull verb RETURNS its stamp as a client-side settle baseline, and this returns nothing).
 *
 * Returns whether a stamp was actually written — `false` means one was already standing. The
 * boolean is the throttle's own effect, and the control that watches it asserts on that rather
 * than on the column, because "already ringing" and "declined to ring" are the same column value.
 */
export async function ringFilingDoorbell(
  tx: Tx, mailboxId: string, now: Date,
): Promise<boolean> {
  const rung = await tx.update(mailboxes)
    .set({ syncRequestedAt: now })
    .where(and(
      eq(mailboxes.id, mailboxId),
      ne(mailboxes.status, "disabled"),
      // `isNull` FIRST, for `dueNow`'s reason one table over: a comparison alone yields NULL on
      // an unstamped row, which a WHERE reads as false — so the mailbox that has never been rung
      // would be the one mailbox this could not ring.
      or(
        isNull(mailboxes.syncRequestedAt),
        lt(mailboxes.syncRequestedAt, new Date(now.getTime() - FILING_DOORBELL_MIN_GAP_MS)),
      ),
    ))
    .returning({ id: mailboxes.id });
  return rung.length > 0;
}
