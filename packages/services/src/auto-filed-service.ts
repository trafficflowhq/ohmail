import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { auditAction, auditLog, folderState, messages, type Tx } from "@trafficflow/db";
import { SCREENER_FOLDER } from "./screener-service.js";
import { MessageService } from "./message-service.js";
import { ServiceError } from "./errors.js";
import { bridgeTx, type ServiceContext } from "./context.js";

/**
 * WHAT THE SCREENER FILED ON ITS OWN, AND PUTTING IT BACK (row 140). The auto-apply pass writes
 * one `screener_auto_apply_move` audit row per message it files, with the undo as its inverse.
 * The read lists the recent ones still where the pass put them; the undo moves each back to the
 * gate through the ordinary move door and marks `folder_state.auto_filing_undone_at` in the same
 * transaction, which the pass's candidate statement reads as its sixth exclusion — put back is
 * never filed again. Both write desired state only: the reconciler moves the mail.
 */

/** Items one read lists and one undo may name. */
export const AUTO_FILED_PAGE_MAX = 100;
/** Audit rows read per page, newest first: the pass writes one per move, so a window, not a walk. */
const AUDIT_WINDOW = 400;

export interface AutoFiledItem {
  messageId: string;
  from: string | null;
  subject: string | null;
  /** Where the pass filed it — where it still is. */
  to: string;
  filedAt: string;
}

export interface AutoFiledPage {
  items: AutoFiledItem[];
  /** More than {@link AUTO_FILED_PAGE_MAX} are still in place; the page is the newest. */
  more: boolean;
}

interface Filed { messageId: string; to: string; at: Date }

/** The newest move per message out of the account's recent audit rows. */
async function recentMoves(db: Tx, accountId: string, only?: readonly string[]): Promise<Filed[]> {
  const rows = await db.select({ payload: auditLog.payload, at: auditLog.createdAt }).from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, auditAction("screener_auto_apply_move"))))
    .orderBy(desc(auditLog.createdAt))
    .limit(AUDIT_WINDOW);
  const seen = new Set<string>();
  const out: Filed[] = [];
  for (const r of rows) {
    const p = (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as { messageId?: unknown; to?: unknown } | null;
    if (typeof p?.messageId !== "string" || typeof p.to !== "string" || seen.has(p.messageId)) continue;
    seen.add(p.messageId);
    if (only === undefined || only.includes(p.messageId)) out.push({ messageId: p.messageId, to: p.to, at: r.at });
  }
  return out;
}

/** The moves whose message is still where the pass put it, not deleted, never put back. */
async function stillInPlace(db: Tx, accountId: string, moves: readonly Filed[]): Promise<Array<Filed & { from: string | null; subject: string | null }>> {
  if (moves.length === 0) return [];
  // The ids are this account's own audit rows, bounded by `AUDIT_WINDOW` — never a caller's list.
  const rows = await db.select({
    id: messages.id, from: messages.fromAddress, subject: messages.subject, desired: folderState.desiredFolder,
  }).from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(
      eq(messages.accountId, accountId), isNull(messages.deletedAt), isNull(folderState.autoFilingUndoneAt),
      inArray(messages.id, moves.map((m) => m.messageId)),
    ));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return moves.flatMap((m) => {
    const r = byId.get(m.messageId);
    return r !== undefined && r.desired === m.to ? [{ ...m, from: r.from, subject: r.subject }] : [];
  });
}

export async function autoFiledSummary(db: Tx, accountId: string): Promise<AutoFiledPage> {
  const placed = await stillInPlace(db, accountId, await recentMoves(db, accountId));
  return {
    items: placed.slice(0, AUTO_FILED_PAGE_MAX).map((m) => ({
      messageId: m.messageId, from: m.from, subject: m.subject, to: m.to, filedAt: m.at.toISOString(),
    })),
    more: placed.length > AUTO_FILED_PAGE_MAX,
  };
}

export interface AutoFiledUndoResult {
  /** Put back: desired at the gate again, marked never to be filed automatically. */
  putBack: string[];
  /** Sent as a request to the install that organizes the mailbox; nothing written here. */
  requested: string[];
}

/**
 * PUT BACK — each named message the pass filed and that is still where it put it. A name that is
 * not such a message is skipped, so a replay puts nothing back twice and says so.
 */
export async function undoAutoFiled(
  ctx: ServiceContext, opts: { messageIds?: unknown },
): Promise<AutoFiledUndoResult> {
  const ids = opts.messageIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > AUTO_FILED_PAGE_MAX
      || ids.some((id) => typeof id !== "string" || id === "" || id.length > 64)) {
    throw new ServiceError("validation_failed", 400, `messageIds must be 1 to ${AUTO_FILED_PAGE_MAX} ids`);
  }
  const db = bridgeTx(ctx.db);
  const placed = await stillInPlace(db, ctx.accountId, await recentMoves(db, ctx.accountId, ids as string[]));
  const out: AutoFiledUndoResult = { putBack: [], requested: [] };
  const move = new MessageService();
  for (const m of placed) {
    const r = await move.move(ctx, m.messageId, { folder: SCREENER_FOLDER }, { putBackAutoFiling: true });
    ("pending" in r ? out.requested : out.putBack).push(m.messageId);
  }
  return out;
}
