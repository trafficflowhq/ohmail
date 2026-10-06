/**
 * The three columns that say how far this mailbox has got — written here, because on a desktop install
 * there is nobody else to. `last_sync_at` is "a pass finished" (read only as `=== null`);
 * `initial_import_completed_at` is written ONCE, when a pass drained with NO BACKLOG, and null means
 * "the first import is not known to be finished"; `sync_progress_at` is when a pass last ran out of
 * cycles with that stamp still null — the import's own clock, which search reads past the first day.
 * On a hosted account the worker writes all three; on a desktop install the worker IS this process.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import type { LocalDb } from "./db.js";

/**
 * WHAT A PASS'S STAMPS SAY ABOUT THE IMPORT — the two facts a first-sync instrument needs.
 *
 * Both come out of the statements that decide the stamps, so a line about the import cannot come
 * to disagree with the column a screen reads. `importStamped` is the once-ever transition and is
 * true for exactly one pass on exactly one install, because the database's `IS NULL` guard is
 * what decides it — not a flag in a process that a relaunch resets.
 */
export interface SyncStamps {
  /** Was `initial_import_completed_at` still unwritten when this pass finished? */
  importWasOpen: boolean;
  /** Did THIS call write it — the import finishing, once ever? */
  importStamped: boolean;
}

/**
 * Record that a pass has completed for this mailbox, and — the first time one drains completely —
 * that the initial import is done. `drained` is the caller's answer to "was there anything left?":
 * `false` writes only the pass stamp, the honest record of a pass that ran out of cycles rather than
 * out of work. The second write is guarded on `IS NULL` in the statement rather than by reading
 * first, so it is naturally once-only and safe against two passes finishing close together — and its
 * `RETURNING` is the authority on whether the import finished HERE. The first statement's `RETURNING`
 * carries the stamp as it stood at no extra read, since the pass write does not touch that column.
 * An undrained pass also moves `sync_progress_at` in that first statement, only while the stamp is null.
 */
export async function stampSynced(
  db: LocalDb,
  mailboxId: string,
  now: Date,
  drained: boolean,
  /**
   * When this pass BEGAN, for `last_sync_at` — never its end: an adopted external move is stamped
   * with this column as a lower bound of the move (mail 0145), and a pass's end can postdate a move
   * its scans missed. Absent = `now` (the Cloud mirror, which adopts nothing).
   */
  passStartedAt: Date = now,
): Promise<SyncStamps> {
  const progress = sql`case when ${mailboxes.initialImportCompletedAt} is null then ${dialect(db).ts(now)}
    else ${mailboxes.syncProgressAt} end`;
  const passed = await db
    .update(mailboxes)
    .set(drained ? { lastSyncAt: passStartedAt } : { lastSyncAt: passStartedAt, syncProgressAt: progress })
    .where(eq(mailboxes.id, mailboxId))
    .returning({ importCompletedAt: mailboxes.initialImportCompletedAt });
  // No row ⇒ the mailbox was removed while this pass ran. There is no import to report either way.
  const importWasOpen = passed.length > 0 && passed[0]!.importCompletedAt === null;
  if (!drained || !importWasOpen) return { importWasOpen, importStamped: false };
  const stamped = await db
    .update(mailboxes)
    .set({ initialImportCompletedAt: now })
    .where(and(eq(mailboxes.id, mailboxId), isNull(mailboxes.initialImportCompletedAt)))
    .returning({ id: mailboxes.id });
  return { importWasOpen, importStamped: stamped.length > 0 };
}
