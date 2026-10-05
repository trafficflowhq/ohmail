import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { heldOutByFolds, type FoldMember } from "@trafficflow/core/conversation-fold";
import { isSentFolderPath } from "@trafficflow/core/mail";
import { isHeldFolder } from "@trafficflow/core/destinations";
import type { Db } from "./context.js";
import { materializeMessagesInOrder } from "./dto/materialize.js";
import type { MessageDTO } from "./dto/types.js";

/**
 * How many members of a page's conversations the fold reads, newest first. A bound, not a
 * guarantee: a conversation past it is folded over its newest members, which is where a pin and
 * the reply that pulled it forward are.
 */
export const FOLD_MEMBERS_MAX = 500;

const ms = (iso: string | null | undefined): number | null => {
  const t = iso == null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * One wire row as the fold reads it — the client's `isFromSomeone` over the same DTO: not the
 * account's own Sent copy (which an own-sent calendar acknowledgement is too), not the away
 * responder's answer, not a stored `method=REPLY`.
 */
export function foldMemberOf(m: MessageDTO): FoldMember {
  return {
    id: m.id, threadId: m.threadId, unread: m.unread,
    arrivedMs: ms(m.sortAt) ?? ms(m.date) ?? ms(m.arrivedAt),
    fromSomeone: !isSentFolderPath(m.folder) && m.autoReplyByUs !== true && m.itipReplyHeader !== true,
    state: m.triage?.state ?? null, setAtMs: ms(m.triage?.setAt),
    // The filed folder, as the client reads its presented one: a held reply joins no fold.
    placed: !isHeldFolder(m.folder),
  };
}

/**
 * THE MEMBERS OF A RESURFACED CONVERSATION AMONG `items` — what "New for you" holds out, by the
 * fold the Ohbox builds its resurfaced rows with (`@trafficflow/core/conversation-fold`). One read
 * of the page's conversations; a page with no thread reads nothing.
 */
export async function heldOutByResurfacedFolds(
  db: Db, accountId: string, items: readonly MessageDTO[],
): Promise<Set<string>> {
  const threads = [...new Set(items.map((m) => m.threadId).filter((t): t is string => t !== null))];
  if (threads.length === 0) return new Set();
  // scoped-by: eq(messages.accountId, accountId)
  const rows = await db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.accountId, accountId), inArray(messages.threadId, threads), isNull(messages.deletedAt)))
    .orderBy(desc(messages.date), desc(messages.id))
    .limit(FOLD_MEMBERS_MAX);
  const members = await materializeMessagesInOrder(db, accountId, rows.map((r) => r.id));
  return heldOutByFolds(members.map(foldMemberOf));
}
