/**
 * THE TWO COLUMNS THAT SAY HOW FAR THIS MAILBOX HAS GOT — written here, because on a desktop
 * install there is nobody else to write them.
 *
 * `mailboxes.last_sync_at` and `mailboxes.initial_import_completed_at` are what the client's sync
 * line reads to decide whether to say anything and what: a null `last_sync_at` means "not one pass
 * has completed", and a null `initial_import_completed_at` means "the first import is not known to
 * be finished". On a hosted account both are written by the server-side sync worker, which runs
 * outside this process and is not part of this repository. On a desktop install the worker IS this
 * process — the local organizer on the standalone door, the mirror pull on the hosted one — and
 * neither was writing them.
 *
 * The consequence was not a missing decoration. The client's ladder reads an unwritten
 * `initial_import_completed_at` as a FLOOR: while it is null the strip says "Syncing your mail"
 * regardless of what the mirror is doing, absolutely for the first day after the mailbox row was
 * made. So a desktop install would have announced an import in progress for a day over a mailbox
 * that finished in ninety seconds — which is why the window used to be given no mailbox facts at
 * all, and therefore had no first-sync progress either. Writing the truth is what lets it have one.
 *
 * ── WHAT EACH ONE MEANS, WHICH IS NOT THE SAME THING ────────────────────────────────────────
 *
 * `last_sync_at` is "a pass finished". It is written after every completed pass, including ones
 * that found nothing, and the client reads it only as `=== null` — "has anything at all happened
 * yet".
 *
 * `initial_import_completed_at` is written ONCE and only when a pass has drained with NO BACKLOG
 * LEFT. That is the same condition the hosted worker applies and it is the condition that makes the
 * stamp worth reading: a pass that stopped because it hit its own cycle bound has not finished the
 * import, and stamping there would tell somebody their mailbox was complete while half of it was
 * still on its way.
 */

import { and, eq, isNull } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import type { LocalDb } from "./db.js";

/**
 * Record that a pass has completed for this mailbox, and — the first time one drains completely —
 * that the initial import is done.
 *
 * `drained` is the caller's answer to "was there anything left?". Passing `false` writes only the
 * pass stamp, which is the honest record of a pass that ran out of cycles rather than out of work.
 *
 * The second write is guarded on `IS NULL` in the statement rather than by reading first, so it is
 * naturally once-only and safe against two passes finishing close together.
 */
export async function stampSynced(
  db: LocalDb,
  mailboxId: string,
  now: Date,
  drained: boolean,
): Promise<void> {
  await db.update(mailboxes).set({ lastSyncAt: now }).where(eq(mailboxes.id, mailboxId));
  if (!drained) return;
  await db
    .update(mailboxes)
    .set({ initialImportCompletedAt: now })
    .where(and(eq(mailboxes.id, mailboxId), isNull(mailboxes.initialImportCompletedAt)));
}
