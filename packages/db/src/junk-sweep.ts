import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { folderState, messages } from "./schema-mail.js";

/**
 * THE ONE-TIME QUARANTINE→\Junk SWEEP'S CANDIDATE PREDICATE — stated ONCE, here, because two
 * programs count the same rows and must agree: the API's preview (`GET /screener/junk/sweep`,
 * "what a press would move") and the worker's pass (`junkSweepPass`, what it then moves). Two
 * hand-written copies of this clause would drift in exactly the direction that shows on screen —
 * an offer naming a number the sweep never reaches.
 *
 * A candidate is a message that is
 *
 *  · physically in the pre-native spam pile (`native_locator ->> 'folder'`, the primary
 *    instance's mirror — the set a per-message move can act on),
 *  · alive in the mirror (not tombstoned), and
 *  · still DESIRED there (`folder_state.desired_folder`). This third term is the user-always-wins
 *    rule: a member the user has since moved records a newer desired folder that the reconciler
 *    has not executed yet, and sweeping it into Junk would overwrite that intent. Such a row is
 *    the reconciler's, not the sweep's.
 *
 * Callers JOIN `folder_state` on `messages.id` and apply this WHERE — the join is theirs so each
 * can select what it needs (the pass wants subjects and locators, the preview wants a count).
 */
export const JUNK_SWEEP_SOURCE_PILE = "ohmail/Quarantine";

export function junkSweepCandidateWhere(accountId: string, mailboxId: string): SQL {
  return and(
    eq(messages.mailboxId, mailboxId),
    eq(messages.accountId, accountId),
    isNull(messages.deletedAt),
    sql`${messages.nativeLocator} ->> 'folder' = ${JUNK_SWEEP_SOURCE_PILE}`,
    eq(folderState.desiredFolder, JUNK_SWEEP_SOURCE_PILE),
  )!;
}
