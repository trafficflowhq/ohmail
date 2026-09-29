import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { auditAction, auditLog, folderState, messages, type Tx } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
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

/**
 * THE FILINGS STILL IN PLACE, newest first: the pass's audit rows joined to the message they name,
 * kept only while the message is where that row filed it, not deleted and never put back. ONE
 * statement over the account's rows, so a put-back filing leaves the set and the next one below it
 * joins — no window of recent rows that the put-back ones fill (a 400-row window left the older
 * filings unreachable). `only` narrows to the ids an undo names; the join is what admits them.
 */
async function inPlace(
  db: Tx, accountId: string, o: { only?: readonly string[]; limit: number },
): Promise<AutoFiledItem[]> {
  const d = dialect(db);
  const named = sql`${auditLog.payload}->>'messageId'`;
  const to = sql<string>`${auditLog.payload}->>'to'`;
  const rows = await db.select({
    id: messages.id, from: messages.fromAddress, subject: messages.subject, to, at: auditLog.createdAt,
  }).from(auditLog)
    .innerJoin(messages, and(eq(messages.id, d.castUuid(named)), eq(messages.accountId, auditLog.accountId)))
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(
      eq(auditLog.accountId, accountId), eq(auditLog.action, auditAction("screener_auto_apply_move")),
      isNull(messages.deletedAt), isNull(folderState.autoFilingUndoneAt), sql`${folderState.desiredFolder} = ${to}`,
      // The undo's ids, bounded by `AUTO_FILED_PAGE_MAX` at the door and matched only through the join.
      ...(o.only === undefined ? [] : [inArray(messages.id, [...o.only])]),
    ))
    .orderBy(desc(auditLog.createdAt), desc(messages.id))
    .limit(o.limit);
  const seen = new Set<string>();
  return rows.flatMap((r) => {
    if (seen.has(r.id)) return [];
    seen.add(r.id);
    const at = r.at instanceof Date ? r.at : new Date(r.at as unknown as number);
    return [{ messageId: r.id, from: r.from, subject: r.subject, to: String(r.to), filedAt: at.toISOString() }];
  });
}

export async function autoFiledSummary(db: Tx, accountId: string): Promise<AutoFiledPage> {
  const items = await inPlace(db, accountId, { limit: AUTO_FILED_PAGE_MAX + 1 });
  return { items: items.slice(0, AUTO_FILED_PAGE_MAX), more: items.length > AUTO_FILED_PAGE_MAX };
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
  const placed = await inPlace(db, ctx.accountId, { only: ids as string[], limit: 2 * AUTO_FILED_PAGE_MAX });
  const out: AutoFiledUndoResult = { putBack: [], requested: [] };
  const move = new MessageService();
  for (const m of placed) {
    const r = await move.move(ctx, m.messageId, { folder: SCREENER_FOLDER }, { putBackAutoFiling: true });
    ("pending" in r ? out.requested : out.putBack).push(m.messageId);
  }
  return out;
}
