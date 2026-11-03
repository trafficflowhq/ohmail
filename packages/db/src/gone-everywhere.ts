import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { folderState, mailboxes, messageInstances } from "./schema-mail.js";

/**
 * A LETTER GONE FROM THE SERVER, AS THE STORE PROVES IT: no copy on record, not filed to its
 * mailbox's Trash, and no filing owed. A filing still owed is our own tombstone, never a lost
 * letter: a landed delete parks its copy in Trash with none on record, and a restore or a move out
 * of there waits on the organizer. One spelling, for the delete verb's already-gone answer and the
 * gone-letter tidy; `messageId` and `mailboxId` name the row's own columns.
 */
export function goneEverywhereWhere(row: { messageId: SQLWrapper; mailboxId: SQLWrapper }): SQL {
  return sql`(not exists (
      select 1 from ${messageInstances} ge_mi where ge_mi.message_id = ${row.messageId}
    ) and not exists (
      select 1 from ${folderState} ge_fs join ${mailboxes} ge_mb on ge_mb.id = ${row.mailboxId}
       where ge_fs.message_id = ${row.messageId}
         and (ge_fs.desired_folder = ge_mb.trash_folder or ge_fs.reconcile_status = 'pending')
    ))`;
}
