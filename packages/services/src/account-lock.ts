import { eq } from "drizzle-orm";
import { accounts, type LedgerTx } from "@trafficflow/db";
import type { Dialect } from "@trafficflow/db/dialect";

/**
 * THE ACCOUNT ROW, `FOR UPDATE` — the HEAD of the mailbox lock order. Three doors take it before
 * they touch a `mailboxes` row: `delete` reads the same row first (the erasure fence, `FOR SHARE`)
 * and locks the mailbox second, so a door that took the mailbox first and reached the allowance
 * gate second closed the cycle and Postgres killed one side with `40P01`. EXCLUSIVE, not shared,
 * and through the dialect seam so a single-writer device store gets a no-op clause.
 * ITS OWN MODULE: `mailbox-service.ts` is mounted by the LOCAL API too, so an edge from it into
 * `mailbox-allowance.ts` would convey that file's Postgres-only statements into the device
 * engine's bundle. This module carries none, which the dialect census re-measures.
 */
export async function lockAccountRow(tx: LedgerTx, d: Dialect, accountId: string): Promise<void> {
  await d.forUpdate(tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).limit(1));
}
