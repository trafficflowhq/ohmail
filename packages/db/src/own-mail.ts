import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { folderState, mailboxes, messages } from "./schema-mail.js";
import { recordChange, type LedgerTx, type Tx } from "./change-log.js";
import type { Dialect } from "./dialect/index.js";
import { CUTLINE_GATE_FOLDER } from "./screener-cutline.js";

/**
 * THE ACCOUNT'S OWN ADDRESSES, AS THE ORGANIZER READS THEM — every mailbox row of the account,
 * case-folded: the set {@link senderIsOwnSql} tests in SQL, read whole for the router's gate,
 * which decides in memory (`core/rules.ts#evaluateRules`, `ownAddresses`).
 */
export async function readOwnAddresses(db: Tx, accountId: string): Promise<Set<string>> {
  const rows = await db.select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, accountId));
  return new Set(rows.map((r) => r.address.toLowerCase()).filter((a) => a !== ""));
}

/** Own-address rows released per call — one page, bounded like `GATE_RELEASE_BATCH`. */
export const OWN_MAIL_RELEASE_BATCH = 100;

/**
 * THE ONE-TIME REPAIR: own-address mail the ORGANIZER filed into `ohmail/Screener` before the gate
 * skipped it is desired back into INBOX; the visit's reconciler makes the move. Only rows we placed
 * and that sit settled at the gate (`last_set_by = 'us'`, desired = observed): a person's placement
 * is never selected. Excluded as the router would decide them: a failed authentication (still
 * screened) and a sender/domain rule naming the author. Plus the three user-intent exclusions
 * `gate-release.ts` keeps. Idempotent: a released row is no longer at the gate.
 */
export async function releaseOwnMailAtGate(
  tx: LedgerTx, d: Dialect, o: { accountId: string; mailboxId: string; limit: number; now?: Date },
): Promise<number> {
  const t = tx as unknown as Tx;
  const own = [...await readOwnAddresses(t, o.accountId)];
  if (own.length === 0) return 0;
  const from = sql`lower(${messages.fromAddress})`;
  const page = t.select({ messageId: messages.id }).from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(and(
      // Driven by `messages_account_from_addr_idx` — the account's own addresses, read whole.
      eq(messages.accountId, o.accountId),
      inArray(from, own),
      eq(messages.mailboxId, o.mailboxId),
      isNull(messages.deletedAt),
      eq(folderState.lastSetBy, "us"),
      eq(folderState.desiredFolder, CUTLINE_GATE_FOLDER),
      eq(folderState.observedFolder, CUTLINE_GATE_FOLDER),
      sql`(${messages.authVerdict} is null or ${messages.authVerdict} <> 'fail')`,
      sql`not exists (
        select 1 from mailboxes mb
         where mb.id = ${messages.mailboxId}
           and (mb.status = 'disabled' or mb.organizer_role <> 'organizer')
      )`,
      sql`not exists (
        select 1 from rules rg
         where rg.account_id = ${messages.accountId}
           and rg.enabled
           and ((rg.kind = 'sender' and trim(lower(rg.match)) = ${from})
             or (rg.kind = 'domain' and trim(lower(rg.match)) = ${d.domainOf(messages.fromAddress)}))
      )`,
      sql`not exists (select 1 from message_states ms where ms.message_id = ${messages.id} and ms.state <> 'none')`,
      sql`not exists (select 1 from drafts dr where dr.in_reply_to_message_id = ${messages.id})`,
      sql`not exists (select 1 from approvals ap where ap.message_id = ${messages.id} and ap.status <> 'pending')`,
    ))
    .orderBy(asc(messages.id))
    .limit(o.limit);
  const rows = await d.forUpdate(page, { of: folderState });

  const now = o.now ?? new Date();
  for (const r of rows) {
    await t.update(folderState)
      .set({ desiredFolder: "INBOX", lastSetBy: "us", reconcileStatus: "pending", updatedAt: now })
      .where(and(eq(folderState.messageId, r.messageId), eq(folderState.desiredFolder, CUTLINE_GATE_FOLDER)));
    // `meta.from` is the true previous desire, as `gate-release`/`rule-retro` record it: the undo.
    await recordChange(tx, {
      accountId: o.accountId, entityType: "message", entityId: r.messageId, op: "move",
      meta: { from: CUTLINE_GATE_FOLDER, to: "INBOX" },
    });
  }
  return rows.length;
}
