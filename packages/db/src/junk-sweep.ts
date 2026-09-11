import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { folderState, messages } from "./schema-mail.js";

/**
 * The one-time quarantine to Junk sweep's candidate predicate — stated ONCE, because two programs
 * count the same rows and must agree: the API's preview (`GET /screener/junk/sweep`, what a press
 * would move) and the worker's pass (`junkSweepPass`, what it then moves); two copies would drift
 * in the direction that shows on screen — an offer naming a number the sweep never reaches. A
 * candidate is physically in the pre-native spam pile (`native_locator ->> 'folder'`), alive in
 * the mirror (not tombstoned), and still DESIRED there (`folder_state.desired_folder`) — the
 * user-always-wins rule: a member the user has since moved is the reconciler's, not the sweep's.
 * Callers JOIN `folder_state` on `messages.id` and apply this WHERE — the join is theirs.
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
