import { and, eq, inArray, sql } from "drizzle-orm";
import { drafts, folderState, messageStates, messages } from "./schema-mail.js";
import type { Tx } from "./change-log.js";
import { dialect } from "./dialect/index.js";
import { weAnsweredThisSenderWhere } from "./we-answered.js";

/**
 * WHY A MESSAGE STAYED WHEN ITS SENDER'S RULE MOVED THE REST — the leave-alone set of the rule's
 * backlog pass (`apps/worker/src/rule-retro.ts`), asked of named messages by the same facts: a
 * failed authentication check, a triage state, a reply, a filing made in another mail app. `null`
 * for a message none of them describes (another rule's, or the pass's other bounds); the sheet
 * then names no reason rather than a wrong one. The order picks one class where several hold.
 */
export type StayedWhy = "failed-checks" | "set-aside" | "replied" | "filed-elsewhere";

/** Ids per ask: the sheet asks about what it shows, and a query string carries them. */
export const WHY_STAYED_IDS_MAX = 100;

export async function whyTheyStayed(
  tx: Tx, accountId: string, messageIds: readonly string[], ownAddresses: readonly string[],
): Promise<Map<string, StayedWhy>> {
  const out = new Map<string, StayedWhy>();
  const ids = [...new Set(messageIds)].slice(0, WHY_STAYED_IDS_MAX);
  if (ids.length === 0) return out;
  const d = dialect(tx);
  const flag = (q: ReturnType<typeof sql>) => sql<number>`case when ${q} then 1 else 0 end`;
  const rows = await tx.select({
    id: messages.id,
    auth: messages.authVerdict,
    setBy: folderState.lastSetBy,
    triaged: flag(sql`exists (select 1 from ${messageStates} ms
      where ms.message_id = ${messages.id} and ms.state <> 'none')`),
    drafted: flag(sql`exists (select 1 from ${drafts} dr where dr.in_reply_to_message_id = ${messages.id})`),
    answered: flag(weAnsweredThisSenderWhere(d, {
      accountId: sql`${messages.accountId}`, threadId: sql`${messages.threadId}`,
      fromAddress: sql`${messages.fromAddress}`, ownAddresses,
    })),
  }).from(messages)
    .leftJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(eq(messages.accountId, accountId), inArray(messages.id, ids)));
  for (const r of rows) {
    const why: StayedWhy | null = r.auth === "fail" ? "failed-checks"
      : Number(r.triaged) === 1 ? "set-aside"
        : Number(r.drafted) === 1 || Number(r.answered) === 1 ? "replied"
          : r.setBy === "external" ? "filed-elsewhere"
            : null;
    if (why !== null) out.set(r.id, why);
  }
  return out;
}
