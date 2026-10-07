import { and, eq, inArray, isNull } from "drizzle-orm";
import { messages, recordChanges, type ChangeInput, type LedgerTx, type Tx } from "@trafficflow/db";
import { claimedIdentity } from "./sender-check.js";

/** A row the check has not reached: what the fact reads, and nothing else. */
export interface UncheckedRow { id: string; fromName: string | null; fromAddress: string; subject: string }

/**
 * THE ONE WRITE OF THE FACT FOR ROWS THE INGEST NEVER CHECKED (mail 0147) — the backfill's page,
 * and the act's, the passes' and a press's own read of the rows they are about to decide. Per row
 * the fact function; a marked row gets its column and one `message` update delta, so every mirror
 * repaints it with the sentence; a clean row `'none'`, no delta. `is null` again on every write: a
 * row is written once, whoever reaches it first. Returns the rows it marked.
 */
export async function writeSenderChecks(
  tx: Tx, accountId: string, rows: readonly UncheckedRow[],
): Promise<UncheckedRow[]> {
  const clean: string[] = [];
  const marked: UncheckedRow[] = [];
  const changes: ChangeInput[] = [];
  for (const r of rows) {
    const fact = claimedIdentity({ fromName: r.fromName, fromAddress: r.fromAddress, subject: r.subject });
    if (fact === undefined) { clean.push(r.id); continue; }
    await tx.update(messages).set({ senderCheck: "impersonation", senderCheckBrand: fact.brand })
      .where(and(eq(messages.id, r.id), isNull(messages.senderCheck)));
    marked.push(r);
    changes.push({ accountId, entityType: "message", entityId: r.id, op: "update", meta: null });
  }
  if (clean.length > 0) {
    await tx.update(messages).set({ senderCheck: "none" })
      .where(and(inArray(messages.id, clean), isNull(messages.senderCheck)));
  }
  await recordChanges(tx as unknown as LedgerTx, changes);
  return marked;
}

/** Ids per read: one statement's parameters stay well inside either store's bound. */
const CHECK_BY_ID_BATCH = 500;

/**
 * The held rows a press is about to move, by id: those the check never reached are checked now,
 * through {@link writeSenderChecks}, so a claim among them is marked before anything moves.
 */
export async function checkUncheckedById(tx: Tx, accountId: string, ids: readonly string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += CHECK_BY_ID_BATCH) {
    const rows = await tx.select({
      id: messages.id, fromName: messages.fromName, fromAddress: messages.fromAddress, subject: messages.subject,
    }).from(messages).where(and(
      eq(messages.accountId, accountId), inArray(messages.id, ids.slice(i, i + CHECK_BY_ID_BATCH)), isNull(messages.senderCheck),
    ));
    if (rows.length > 0) await writeSenderChecks(tx, accountId, rows);
  }
}
