import { folderState, type Tx } from "@trafficflow/db";

/**
 * ONE WRITER FOR THE FILING INTENT — `ohbox-tidy`, `rule-retro` and `screener-auto` each wrote
 * this upsert themselves until 0.21.
 *
 * Write the INTENT and nothing else: the new desired folder, observed untouched.
 * `reconcile_status` is DERIVED (desired ≠ observed ⇒ `pending`), so a row can never claim a
 * convergence it does not have, and `pending` is what makes the worker's reconciler perform the
 * physical move. A copy of this that drifted would file a message in the database and never in
 * the mailbox — `desired-intent-one-writer.test.ts` refuses a second declaration.
 */
export async function upsertDesiredFolder(
  t: Tx,
  row: { messageId: string; observedFolder: string },
  destination: string,
  now: Date,
): Promise<void> {
  const reconcileStatus = destination === row.observedFolder ? "reconciled" : "pending";
  await t.insert(folderState).values({
    messageId: row.messageId, desiredFolder: destination, observedFolder: row.observedFolder,
    lastSetBy: "us", reconcileStatus, conflict: false,
  }).onConflictDoUpdate({
    target: folderState.messageId,
    set: {
      desiredFolder: destination, observedFolder: row.observedFolder, lastSetBy: "us",
      reconcileStatus, conflict: false, updatedAt: now,
    },
  });
}
