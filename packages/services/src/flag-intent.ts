import { sql } from "drizzle-orm";
import { flagState, type Tx } from "@trafficflow/db";

/**
 * Upsert `flag_state` desired=<seen>, us — preserving `observed_seen` on conflict.
 *
 * ONE implementation for every service that writes a read-state INTENT — `MessageService`'s
 * PATCH routes and `TriageService`'s resurface re-unread. It was a private method on
 * `MessageService` until the resurface event needed the same write; a second copy would have
 * been a second answer to when a `\Seen` round trip is owed. (`bubbleUpPass` carries its own
 * inline twin, stated there: its module is the desktop bundle's import boundary and may reach
 * drizzle and the mail tables only, never this package.)
 *
 * `observedSeen` is only ever supplied for the INSERT, and the fallback is the message's
 * current `messages.unread`: before anyone has expressed an intent, the read model IS what the
 * server last told us. On conflict the column is deliberately omitted from the `set`, exactly
 * as `upsertDesired` omits `observedFolder` — the worker owns it, and an API request that
 * overwrote it would erase the record of what IMAP actually says and make the reconciler
 * believe it had already converged.
 *
 * `reconcileStatus` is therefore recomputed IN SQL against the STORED `observed_seen`, not
 * against the value guessed at call time: on the update path the caller's guess is stale by
 * definition. Both writers use the same rule — `pending` only when desired ≠ observed — so a
 * no-op click never queues an IMAP round trip.
 */
export async function upsertDesiredSeen(
  tx: Tx, id: string, observedSeen: boolean, desiredSeen: boolean, now: Date,
): Promise<void> {
  await tx.insert(flagState).values({
    messageId: id, desiredSeen, observedSeen,
    lastSetBy: "us", reconcileStatus: desiredSeen === observedSeen ? "reconciled" : "pending",
    conflict: false,
  }).onConflictDoUpdate({
    target: flagState.messageId,
    set: {
      desiredSeen, lastSetBy: "us", conflict: false, updatedAt: now,
      reconcileStatus: sql`case when ${flagState.observedSeen} = ${desiredSeen} then 'reconciled' else 'pending' end`,
    },
  });
}
