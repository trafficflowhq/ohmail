import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { fencedAccountWrite } from "./erasure-fence.js";
import { accountLifecycleNotices } from "./schema-cloud.js";
import { mailboxes } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * THE CATCH-UP AFTER A REOPENING (cloud 0040's `reopened` row): its anchor, the worker's plant and
 * the one test for "not told yet", together so the writers cannot disagree. A row is UNTOLD
 * (`sent_at = anchor`, planted by the hosted worker before its roster pass spends the anchor) or TOLD
 * (`sent_at` is the database clock when `GET /account/access` answered it). Only EQUALITY reads as
 * untold: the park and the block are the worker's clock and `sent_at` the database's, so an ordering
 * between them is no fact about the row. Bound: an untold row is told at the first open read however
 * late, until a roster pass reads the account closed again ({@link dropUntoldCatchUps}).
 */

/** The closure the catch-up is dated from: the newest park, else the newest `account_closed` block. */
function anchorOfRows(): SQL<Date | null> {
  return sql<Date | null>`coalesce(max(${mailboxes.organizerParkedAt}), max(${mailboxes.syncBlockedSince}) filter (where ${mailboxes.syncBlockedReason} = 'account_closed'))`;
}

/** A `reopened` row nobody has been told yet. The door's tell reads it too, so it is spelled once. */
export function untoldCatchUpWhere(): SQL {
  return sql`${accountLifecycleNotices.sentAt} = ${accountLifecycleNotices.anchor}`;
}

/** The anchor as the account's rows state it now, or `null` when they state none. */
export async function reopenAnchorOf(db: Tx, accountId: string): Promise<Date | null> {
  const [row] = await db.select({ at: anchorOfRows().mapWith(mailboxes.organizerParkedAt) })
    .from(mailboxes).where(eq(mailboxes.accountId, accountId));
  return row?.at ?? null;
}

/**
 * THE PLANT: the anchor recorded, untold, before the pass that clears it. Fenced like every writer
 * of an account's rows, so it can never land after the account's erasure. Returns the planted anchor,
 * or `null` when there was none to plant or the row was there already (planted, or told by a door
 * that read first). Throws `AccountErasedError` for an erased account; any other throw is a fault.
 */
export async function plantReopenedCatchUp(db: Tx, accountId: string): Promise<Date | null> {
  return fencedAccountWrite(db, { accountId }, async (tx) => {
    const rows = await tx.insert(accountLifecycleNotices)
      .select(sql`select ${accountId}::uuid, 'reopened', a.at, a.at
        from (select ${anchorOfRows()} as at from ${mailboxes} where ${mailboxes.accountId} = ${accountId}) a
        where a.at is not null`)
      .onConflictDoNothing()
      .returning({ anchor: accountLifecycleNotices.anchor });
    return rows[0]?.anchor ?? null;
  });
}

/** The newest untold row's anchor, or `null`. */
export async function untoldCatchUpOf(db: Tx, accountId: string): Promise<Date | null> {
  const [row] = await db.select({ anchor: accountLifecycleNotices.anchor })
    .from(accountLifecycleNotices)
    .where(and(
      eq(accountLifecycleNotices.accountId, accountId),
      eq(accountLifecycleNotices.kind, "reopened"),
      untoldCatchUpWhere(),
    ))
    .orderBy(desc(accountLifecycleNotices.anchor))
    .limit(1);
  return row?.anchor ?? null;
}

/**
 * A NEW CLOSURE ENDS AN UNTOLD CATCH-UP. A reopening no client read before the account closed again
 * would otherwise be told at the next reopening in its place, dated from the older closure. The
 * worker calls this at the first roster pass that reads the account parked, never behind the block
 * grace. Fenced like the plant; returns how many rows went.
 */
export async function dropUntoldCatchUps(db: Tx, accountId: string): Promise<number> {
  return fencedAccountWrite(db, { accountId }, async (tx) => {
    const rows = await tx.delete(accountLifecycleNotices)
      .where(and(
        eq(accountLifecycleNotices.accountId, accountId),
        eq(accountLifecycleNotices.kind, "reopened"),
        untoldCatchUpWhere(),
      ))
      .returning({ anchor: accountLifecycleNotices.anchor });
    return rows.length;
  });
}
