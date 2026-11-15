/**
 * THE RECONCILE QUEUES, ONE ACCOUNT AT A TIME (mail 0181). Every sync cycle asks each mailbox for its
 * due folder moves and `\Seen` writes. Each queue is read through a partial index of its pending rows
 * keyed by the message's account (`folder_state_pending_queue_idx`, `flag_state_pending_queue_idx`),
 * which every row carries since mail 0201; the poll binds its mailbox's account, so it
 * reads its own account's queue in order, however long another account's is. The mailbox stays the
 * caller's term: the account is the index range, the mailbox a filter on the join.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { flagState, mailboxes } from "./schema-mail.js";
import { outstandingFilingsOf } from "./folder-state-pending.js";

/** `mailboxId`'s account, as a scalar subquery the statement runs once. */
function accountOf(mailboxId: string): SQL {
  return sql`(select ${mailboxes.accountId} from ${mailboxes} where ${mailboxes.id} = ${mailboxId})`;
}

/** The folder queue of `mailboxId`'s account. */
export function folderQueueOf(mailboxId: string): SQL {
  return outstandingFilingsOf(accountOf(mailboxId));
}

/** The read-state queue of `mailboxId`'s account. */
export function flagQueueOf(mailboxId: string): SQL {
  return eq(flagState.accountId, accountOf(mailboxId));
}
