import { sql } from "drizzle-orm";
import { flagState } from "./schema-mail.js";
import { boolLiteral } from "./dialect/index.js";
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
  /** When the decision was placed (`flag_state.decided_at`): a press's floor, else `now`. */
  decidedAt: Date = now,
): Promise<void> {
  await upsertDesiredSeenMany(tx, [{ id, observedSeen }], desiredSeen, now, decidedAt);
}

/**
 * {@link upsertDesiredSeen} for a batch that takes ONE decision: one multi-row statement, each row
 * carrying its own `observedSeen` for the INSERT arm. Ids must be distinct (one row may not take
 * the conflict arm twice in a statement); an empty batch writes nothing.
 */
export async function upsertDesiredSeenMany(
  tx: Tx, rows: ReadonlyArray<{ id: string; observedSeen: boolean }>, desiredSeen: boolean, now: Date,
  decidedAt: Date = now,
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(flagState).values(rows.map((r) => ({
    messageId: r.id, desiredSeen, observedSeen: r.observedSeen,
    lastSetBy: "us", reconcileStatus: desiredSeen === r.observedSeen ? "reconciled" : "pending",
    conflict: false, decidedAt,
  }))).onConflictDoUpdate({
    target: flagState.messageId,
    set: {
      desiredSeen, lastSetBy: "us", conflict: false, updatedAt: now, decidedAt,
      // A literal, not a bound boolean: the device store's test driver refuses one by position.
      reconcileStatus: sql`case when ${flagState.observedSeen} = ${boolLiteral(desiredSeen)} then 'reconciled' else 'pending' end`,
    },
  });
}
