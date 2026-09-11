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
 * Ring the worker's doorbell for a filing decision. The API never opens IMAP: a press writes
 * `folder_state` and returns, and the wait used to be the worker's ROTATION. `sync_requested_at`
 * (mail 0049) is the lever: the ~3 s kick scan notices the stamp and serves the mailbox one
 * ordinary bounded turn out of rotation. One column, not a queue — this only says "come sooner",
 * and a lost stamp costs one rotation. The rate limit lives in the UPDATE's predicate: a stamp
 * younger than {@link FILING_DOORBELL_MIN_GAP_MS} is left standing. Disabled mailboxes are
 * excluded; a READER is still rung. Called INSIDE the deciding transaction, LAST, so the stamp
 * commits with the decision or not at all. Returns whether a stamp was written.
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
