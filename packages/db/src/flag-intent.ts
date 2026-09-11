import { sql } from "drizzle-orm";
import { flagState } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * Upsert `flag_state` desired=<seen>, us — preserving `observed_seen` on conflict. The ONE
 * spelling of the read-state intent: three writers had three inline copies (the worker may not
 * import services at runtime) — three answers to when a `\Seen` round trip is owed — so it moved
 * down the spine, reaching `schema-mail.js` alone. The reconciler's writer is NOT this function:
 * `DrizzleRepo.upsertFlagState` writes desired AND observed with a backoff reset; the census test
 * pins every other `insert(flagState)` out of the tree. `observedSeen` is only supplied for the
 * INSERT; on conflict the column is omitted — the worker owns it. `reconcileStatus` is recomputed
 * IN SQL against the STORED `observed_seen`, so a no-op click never queues an IMAP round trip.
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
