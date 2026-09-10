import { and, asc, eq, gt, inArray, isNotNull, ne } from "drizzle-orm";
import {
  approvals, attachments, awayReplies, awayResponderSent, drafts, flagState, folderOps,
  folderState, mailboxCredentials, mailboxFolders, mailboxProfileMirror, messageBodies,
  messageFailures, messageInstances, messageStates, messageTags, messages, organizerRequests,
  outboundSendFingerprints, outboundSends, routingDecisions, trackerEvents, unsubscribeRecords,
  recordChanges, type LedgerTx,
} from "@trafficflow/db";
import { rowsAffected as n } from "./rows-affected.js";

/**
 * How many entity ids one receipt batch materializes. The DELETEs below are subqueries with no
 * bind list, so only the receipts have a cardinality — one change row per erased message and
 * per erased draft. Reading the ids in keyset pages bounds this process's memory by the page
 * rather than by the mailbox; `recordChanges` chunks its own INSERT, so this is a memory bound
 * and not a statement bound.
 */
export const ERASE_RECEIPT_PAGE = 2_000;

/** What one mailbox erasure removed, for the receipt the route returns. */
export interface MailboxSweepResult {
  /** Rows removed, per table. */
  deleted: Record<string, number>;
  messagesErased: number;
  draftsErased: number;
  /** Drafts in OTHER mailboxes whose reply anchor pointed here and was cleared. */
  draftsUnanchored: number;
  /** The highest change-log seq this sweep allocated, `null` when it erased nothing. */
  seq: bigint | null;
}


/**
 * Erase ohmail's copy of ONE mailbox, inside the caller's transaction.
 *
 * The caller owns the transaction and must already hold, in this order: the account row
 * `FOR SHARE` (the erasure fence — `erasure-fence.ts` argues why it goes first), the mailbox row
 * `FOR UPDATE`, and the account's thread-structure advisory lock. Acquiring them here instead
 * would put these locks after the caller's and reintroduce the deadlock pair the account sweep's
 * ordering closes.
 *
 * IMAP is untouched: the mail stays on the user's server, because the mailbox is the master.
 * This removes a mirror, not somebody's mail.
 */
export async function sweepMailboxData(
  tx: LedgerTx,
  args: { accountId: string; mailboxId: string },
): Promise<MailboxSweepResult> {
  const { accountId, mailboxId } = args;
  const deleted: Record<string, number> = {};
  const drop = async (table: string, run: Promise<unknown>) => {
    deleted[table] = n(await run);
  };

  // Subqueries, never materialized id lists: `account-deletion-service.ts` records what an id
  // list per message costs — one bind parameter per row against a collection with no ceiling, so
  // erasure stopped working for exactly the largest mailboxes. These resolve at every line that
  // uses them because the rows they read are still present until section 5.
  const ownMessageIds = tx.select({ id: messages.id })
    .from(messages).where(eq(messages.mailboxId, mailboxId));
  const ownDraftIds = tx.select({ id: drafts.id })
    .from(drafts).where(eq(drafts.mailboxId, mailboxId));

  // ── 1. THE RECEIPTS, BEFORE THE DELETES THAT MAKE THEIR IDS UNREADABLE ───────────────────
  //
  // One `delete` change per message and per draft, so a mirror tombstones instead of rendering
  // mail the server no longer holds. `MessageService.delete` sets the convention: the entity id
  // is the whole receipt and a client cascades its own dependents from it.
  const receipts = await recordSweepReceipts(tx, accountId, mailboxId);

  // ── 2. A REPLY ANCHOR IN A SIBLING MAILBOX IS CLEARED, NOT DELETED ───────────────────────
  //
  // `drafts.in_reply_to_message_id` references `messages` with no cascade, so an unsent draft in
  // ANOTHER mailbox replying into this one would refuse the `messages` delete below and take the
  // whole erasure with it. That draft is the person's own unsent words in a mailbox they did not
  // erase: it survives and loses only its anchor, which is the answer
  // `outbound_sends.draft_id` already gives with `on delete set null`.
  const draftsUnanchored = n(await tx.update(drafts)
    .set({ inReplyToMessageId: null })
    .where(and(
      eq(drafts.accountId, accountId),
      ne(drafts.mailboxId, mailboxId),
      isNotNull(drafts.inReplyToMessageId),
      inArray(drafts.inReplyToMessageId, ownMessageIds),
    )));

  // ── 3. EVERYTHING KEYED ON A MESSAGE OF THIS MAILBOX ─────────────────────────────────────
  //
  // Child before parent throughout. `approvals` precedes `routing_decisions` because it
  // references one, and both precede `messages`.
  await drop("approvals", tx.delete(approvals)
    .where(inArray(approvals.messageId, ownMessageIds)));
  await drop("routing_decisions", tx.delete(routingDecisions)
    .where(inArray(routingDecisions.messageId, ownMessageIds)));
  await drop("attachments", tx.delete(attachments)
    .where(inArray(attachments.messageId, ownMessageIds)));
  await drop("message_tags", tx.delete(messageTags)
    .where(inArray(messageTags.messageId, ownMessageIds)));
  await drop("message_states", tx.delete(messageStates)
    .where(inArray(messageStates.messageId, ownMessageIds)));
  await drop("tracker_events", tx.delete(trackerEvents)
    .where(inArray(trackerEvents.messageId, ownMessageIds)));
  // These two carry a CORRESPONDENT's address — somebody else's personal data, held because this
  // mailbox answered them. `away_replies` is keyed on the mailbox as well as the message.
  await drop("away_responder_sent", tx.delete(awayResponderSent)
    .where(inArray(awayResponderSent.messageId, ownMessageIds)));
  await drop("away_replies", tx.delete(awayReplies)
    .where(eq(awayReplies.mailboxId, mailboxId)));
  await drop("unsubscribe_records", tx.delete(unsubscribeRecords)
    .where(eq(unsubscribeRecords.mailboxId, mailboxId)));
  await drop("message_instances", tx.delete(messageInstances)
    .where(eq(messageInstances.mailboxId, mailboxId)));
  // The bodies and the two read-state tables key off the MESSAGE and carry no `account_id` at
  // all, which is why an account-scoped sweep alone could never see them. Read state is user
  // data.
  await drop("message_bodies", tx.delete(messageBodies)
    .where(inArray(messageBodies.messageId, ownMessageIds)));
  await drop("folder_state", tx.delete(folderState)
    .where(inArray(folderState.messageId, ownMessageIds)));
  await drop("flag_state", tx.delete(flagState)
    .where(inArray(flagState.messageId, ownMessageIds)));

  // ── 4. SENDS AND DRAFTS ──────────────────────────────────────────────────────────────────
  //
  // A send record names a message this mailbox sent, so it goes with the mailbox; its fingerprint
  // carries the mailbox column and is deleted by it. Both before `drafts`, whose
  // `on delete set null` would otherwise cut the link the sends are selected by.
  await drop("outbound_send_fingerprints", tx.delete(outboundSendFingerprints)
    .where(eq(outboundSendFingerprints.mailboxId, mailboxId)));
  await drop("outbound_sends", tx.delete(outboundSends)
    .where(inArray(outboundSends.draftId, ownDraftIds)));
  await drop("drafts", tx.delete(drafts).where(eq(drafts.mailboxId, mailboxId)));

  // ── 5. THE MESSAGES ──────────────────────────────────────────────────────────────────────
  //
  // `threads` are account-scoped and a thread can hold messages from a sibling mailbox, so they
  // are deliberately left: erasing one would delete another mailbox's mail structure.
  await drop("messages", tx.delete(messages).where(eq(messages.mailboxId, mailboxId)));

  // ── 6. THE MAILBOX'S OWN STATE ───────────────────────────────────────────────────────────
  //
  // `mailbox_folders` holds the person's folder NAMES and `folder_ops` a rename in their own
  // words; `mailbox_profile_mirror.doc` is the whole published profile (screener addresses, rule
  // text, the away body) and `organizer_requests.payload` a correspondent plus the verdict
  // passed on them. Neither of the last two has a foreign key, so nothing else ever removes
  // them. `folder_ops` precedes the inventory it would cascade from, so the receipt counts it.
  await drop("folder_ops", tx.delete(folderOps).where(eq(folderOps.mailboxId, mailboxId)));
  await drop("mailbox_folders", tx.delete(mailboxFolders)
    .where(eq(mailboxFolders.mailboxId, mailboxId)));
  await drop("message_failures", tx.delete(messageFailures)
    .where(eq(messageFailures.mailboxId, mailboxId)));
  await drop("mailbox_profile_mirror", tx.delete(mailboxProfileMirror)
    .where(eq(mailboxProfileMirror.mailboxId, mailboxId)));
  await drop("organizer_requests", tx.delete(organizerRequests)
    .where(eq(organizerRequests.mailboxId, mailboxId)));
  // Idempotent rather than assumed: the disconnect this rides already deleted the credential
  // row, and a re-run of the erasure finds nothing here.
  await drop("mailbox_credentials", tx.delete(mailboxCredentials)
    .where(eq(mailboxCredentials.mailboxId, mailboxId)));

  return { deleted, draftsUnanchored, ...receipts };
}

/**
 * Page the ids by KEYSET and hand each page to `recordChanges` — the one change-log writer
 * (`change-notify-chokepoint.test.ts` proves nothing else inserts), so the wake fires and the
 * seqs stay gap-free. Keyset and not OFFSET: an offset walk re-scans everything it has already
 * read, which is the per-page cost this page size exists to avoid.
 */
async function recordSweepReceipts(
  tx: LedgerTx, accountId: string, mailboxId: string,
): Promise<{ seq: bigint | null; messagesErased: number; draftsErased: number }> {
  let seq: bigint | null = null;

  const walk = async (
    read: (after: string | null) => Promise<{ id: string }[]>,
    entityType: "message" | "draft",
  ): Promise<number> => {
    let seen = 0;
    let after: string | null = null;
    for (;;) {
      const rows = await read(after);
      if (rows.length === 0) return seen;
      const seqs = await recordChanges(tx, rows.map((r) => ({
        accountId, entityType, entityId: r.id, op: "delete" as const, meta: null,
      })));
      const last = seqs[seqs.length - 1];
      if (last !== undefined) seq = last;
      seen += rows.length;
      if (rows.length < ERASE_RECEIPT_PAGE) return seen;
      after = rows[rows.length - 1]!.id;
    }
  };

  const messagesErased = await walk((after) => {
    const where = after === null
      ? eq(messages.mailboxId, mailboxId)
      : and(eq(messages.mailboxId, mailboxId), gt(messages.id, after));
    return tx.select({ id: messages.id }).from(messages)
      .where(where).orderBy(asc(messages.id)).limit(ERASE_RECEIPT_PAGE);
  }, "message");

  const draftsErased = await walk((after) => {
    const where = after === null
      ? eq(drafts.mailboxId, mailboxId)
      : and(eq(drafts.mailboxId, mailboxId), gt(drafts.id, after));
    return tx.select({ id: drafts.id }).from(drafts)
      .where(where).orderBy(asc(drafts.id)).limit(ERASE_RECEIPT_PAGE);
  }, "draft");

  return { seq, messagesErased, draftsErased };
}
