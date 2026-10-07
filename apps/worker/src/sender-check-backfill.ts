import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  fencedAccountWrite, folderState, messages, recordChanges, type ChangeInput, type LedgerTx, type Tx,
} from "@trafficflow/db";
/* The mail leaf, never the barrel: the local engines bundle this pass, and a value import from the
   barrel carries the model half into them (the engine census refuses the build). */
import { claimedIdentity, silentLogger, type Logger } from "@trafficflow/core/mail";

/**
 * THE IDENTITY BACKFILL (mail 0147) — the identity fact for the rows ingested before the column
 * existed, written once. Only the two places a sentence is read at the moment of a decision: the
 * Ohbox and the Screener — inbound mail by construction, so Sent copies (which ingest checks
 * without computing) are out of scope. Per row the fact function, exactly what ingest writes. It
 * writes the fact and, for a marked row only, a `message` update so every mirror repaints it —
 * never a move: already-placed mail stays where it is.
 * Idempotent by construction: the NULL set is the cursor, so a second run writes nothing.
 */

/** Rows per page — one transaction each. */
export const SENDER_CHECK_BACKFILL_BATCH = 500;
/** Pages per call: one, so a cycle tail pays one page and a 20k-row scope takes ~40 cycles. */
export const SENDER_CHECK_BACKFILL_PAGES = 1;

export interface SenderCheckBackfillDeps {
  accountId: string;
  batch?: number;
  maxPages?: number;
  /** The caller's clock, asked before every page after the first; true stops the walk. */
  until?: () => boolean;
  log?: Logger;
}

export interface SenderCheckBackfillResult {
  /** Rows given a fact. */
  checked: number;
  /** Of those, rows the fact marks — each with one `message` update delta. */
  marked: number;
  /** True ⇒ the NULL set in scope answered empty: nothing is left to check. */
  done: boolean;
}

/** The two places a banner is read when a person decides. Archive and Sent rows stay unchecked. */
const IN_SCOPE = ["INBOX", "ohmail/Screener"] as const;

export async function senderCheckBackfillPass(
  db: Tx, deps: SenderCheckBackfillDeps,
): Promise<SenderCheckBackfillResult> {
  const log = deps.log ?? silentLogger;
  const batch = deps.batch ?? SENDER_CHECK_BACKFILL_BATCH;
  const maxPages = deps.maxPages ?? SENDER_CHECK_BACKFILL_PAGES;
  const result: SenderCheckBackfillResult = { checked: 0, marked: 0, done: false };

  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && deps.until?.()) break;
    const n = await fencedAccountWrite(db, { accountId: deps.accountId }, async (tx) => {
      // Newest first: the mail a person is about to read gets its sentence before the backlog.
      const rows = await tx.select({
        id: messages.id, fromName: messages.fromName, fromAddress: messages.fromAddress,
        subject: messages.subject,
      }).from(messages)
        .innerJoin(folderState, eq(folderState.messageId, messages.id))
        .where(and(
          eq(messages.accountId, deps.accountId),
          isNull(messages.senderCheck),
          isNull(messages.deletedAt),
          inArray(folderState.desiredFolder, [...IN_SCOPE]),
        ))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(batch);
      if (rows.length === 0) return { rows: 0, marked: 0 };

      const clean: string[] = [];
      const changes: ChangeInput[] = [];
      for (const r of rows) {
        const fact = claimedIdentity({ fromName: r.fromName, fromAddress: r.fromAddress, subject: r.subject });
        if (fact === undefined) { clean.push(r.id); continue; }
        // `is null` again: a row is written once, whoever reaches it first.
        await tx.update(messages).set({ senderCheck: "impersonation", senderCheckBrand: fact.brand })
          .where(and(eq(messages.id, r.id), isNull(messages.senderCheck)));
        changes.push({ accountId: deps.accountId, entityType: "message", entityId: r.id, op: "update", meta: null });
      }
      if (clean.length > 0) {
        // A clean row changes no DTO, so it costs no delta.
        await tx.update(messages).set({ senderCheck: "none" })
          .where(and(inArray(messages.id, clean), isNull(messages.senderCheck)));
      }
      await recordChanges(tx as unknown as LedgerTx, changes);
      return { rows: rows.length, marked: changes.length };
    });
    result.checked += n.rows;
    result.marked += n.marked;
    if (n.rows < batch) { result.done = true; break; }
  }

  if (result.checked > 0) {
    // The logger's own field names: `scanned` is the rows given a fact this call.
    log.info("sender_check_backfill", { accountId: deps.accountId, scanned: result.checked, marked: result.marked });
  }
  return result;
}
