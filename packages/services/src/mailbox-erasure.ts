import { and, asc, eq, exists, gt, inArray, isNotNull, isNull, ne, notExists, sql } from "drizzle-orm";
import {
  approvals, attachments, awayReplies, awayResponderSent, drafts, flagState, folderOps,
  folderState, junkRescues, mailboxCredentials, mailboxFolders, mailboxProfileMirror, messageBodies,
  messageFailures, messageInstances, messageStates, messageTags, messages, organizerRequests,
  eraseIdempotentResponses, mailboxes, outboundSendFingerprints, outboundSends, recordChanges,
  recordMailboxRemoved, routingDecisions, threadNotes, threads, trackerEvents,
  unsubscribeRecords, unsubscribeExamined, type LedgerTx,
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

/**
 * How many exclusive threads one page of the thread sweep takes. The receipts page for MEMORY;
 * this one pages because its ids reach a bind list — three statements per page, each carrying
 * the page's ids. 500 keeps a mailbox with a hundred thousand conversations inside the same
 * per-statement bound the rest of this file works to.
 */
export const ERASE_THREAD_PAGE = 500;

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
  args: { accountId: string; mailboxId: string; now: Date },
): Promise<MailboxSweepResult> {
  const { accountId, mailboxId, now } = args;
  const deleted: Record<string, number> = {};
  const drop = async (table: string, run: Promise<unknown>) => {
    deleted[table] = n(await run);
  };

  /* ── THE STAMP, FIRST ─────────────────────────────────────────────────────────────────────
   * `mailboxes.erased_at` before a single row goes, `deleteAccount`'s order one scope down: the
   * row SURVIVES this sweep as a tombstone, so it is the only thing a late writer can be refused
   * by. `isNull` in the WHERE keeps the FIRST stamp on a retried erasure, and it is there rather
   * than a `coalesce` cast because this file is loaded by the phone bundle, whose store has no
   * `::timestamptz` — the dialect census refuses one. Whichever side wins the row lock,
   * a writer fencing on it either waits and sees the stamp, or holds its share and has its rows
   * taken by the deletes below.
   */
  await tx.update(mailboxes)
    .set({ erasedAt: now })
    .where(and(
      eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId), isNull(mailboxes.erasedAt),
    ));

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
  // The per-message marks hang off the record by foreign key, so they go first or the delete
  // below is refused. Keyed by MESSAGE, like the bodies further down.
  await drop("unsubscribe_examined", tx.delete(unsubscribeExamined)
    .where(inArray(unsubscribeExamined.messageId, ownMessageIds)));
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

  // ── 5. THE THREADS AND NOTES THIS MAILBOX ALONE HELD ──────────────────────────────────────
  //
  // A thread carries the SUBJECT and the PARTICIPANTS, and a thread note carries what the
  // person wrote about the conversation. Deleting the messages and leaving those is a mailbox
  // that reads as erased and still answers with its own mail: both endpoints kept serving it.
  // A thread is ACCOUNT-scoped and may hold a sibling mailbox's messages, so exclusivity is
  // asked per thread — a shared thread survives and loses only this mailbox's messages below.
  // `contact_notes` is the deliberate survivor: a note on a contact card belongs to the
  // account's address book, which outlives one mailbox exactly as `contacts` itself does.
  const threadSweep = await sweepExclusiveThreads(tx, accountId, mailboxId);
  deleted["thread_notes"] = threadSweep.notes;
  deleted["threads"] = threadSweep.threads;

  // ── 6. THE MESSAGES ───────────────────────────────────────────────────────────────────────
  //
  // What is left of them. The sweep above already unhooked this mailbox's messages from the
  // threads it removed; a SHARED thread's row stays, carrying the sibling mailbox's messages.
  await drop("messages", tx.delete(messages).where(eq(messages.mailboxId, mailboxId)));

  // ── 7. THE MAILBOX'S OWN STATE ───────────────────────────────────────────────────────────
  //
  // `mailbox_folders` holds the person's folder NAMES and `folder_ops` a rename in their own
  // words; `mailbox_profile_mirror.doc` is the whole published profile (screener addresses, rule
  // text, the away body) and `organizer_requests.payload` a correspondent plus the verdict
  // passed on them. Neither of the last two has a foreign key, so nothing else ever removes
  // them. `folder_ops` precedes the inventory it would cascade from, so the receipt counts it.
  await drop("folder_ops", tx.delete(folderOps).where(eq(folderOps.mailboxId, mailboxId)));
  // `junk_rescues` is the same kind of row as `folder_ops` — a command the person pressed, holding
  // their Junk folder's NAME and a coordinate in it — and it has no foreign key to `messages`
  // (Junk never enters the mirror), so nothing else ever removes it.
  await drop("junk_rescues", tx.delete(junkRescues).where(eq(junkRescues.mailboxId, mailboxId)));
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
  /* AND THE RESPONSE CACHE, WHICH IS A SECOND COPY OF THE MAIL.
   *
   * `idempotency_keys.response_json` holds the whole DTO a mutation answered with — a draft's
   * body and its recipients, kept for 24 hours so a retry after a lost response is idempotent.
   * Nothing treated that as message content, so the sweep above removed the draft and the retry
   * served it back as a 201 describing a draft that no longer existed. Replaced rather than
   * deleted, and account-wide rather than per-mailbox: the primitive's own header argues both. */
  deleted["idempotency_keys"] = await eraseIdempotentResponses(tx, accountId, now);

  /* ── 8. AND THE MAILBOX ITSELF, AS ONE RECEIPT ──
   * Section 1's per-message and per-draft receipts tell a mirror about the mail; nothing told it
   * about the MAILBOX, so a client kept its folder rows, cached bodies and received count for a
   * mailbox this sweep had just erased. One row closes all of them — the same row the standalone
   * install's `wipeLocalMirror` writes — placed LAST so it carries the sweep's highest seq. ONLY
   * WHEN THIS SWEEP TOOK SOMETHING, this method's standing promise: a repeat erase reports zero,
   * deletes nothing and allocates no sequence (`mailbox-erasure.pg.test.ts`), and a second receipt
   * would say nothing a mirror does not already know. Read from what the deletes above removed,
   * never from the arguments.
   */
  const took = receipts.messagesErased > 0 || receipts.draftsErased > 0
    || Object.values(deleted).some((n) => n > 0);
  const seq = took ? await recordMailboxRemoved(tx, accountId, mailboxId) : receipts.seq;

  return { deleted, draftsUnanchored, ...receipts, seq };
}

/**
 * Delete every thread this mailbox ALONE held, and the notes pinned to those threads.
 *
 * Exclusive means: the thread carries at least one message of this mailbox and none of any other.
 * Two `EXISTS` rather than a `GROUP BY`, so the predicate stops at the first sibling message.
 *
 * ORDER inside a page is forced by the two foreign keys into `threads` that outlive this erasure.
 * `drafts.thread_id` can point here from a SIBLING mailbox — the person's unsent words in a
 * mailbox they did not erase, so it is cleared and not deleted, the same answer section 2 gives
 * the reply anchor. `messages.thread_id` still points here because section 6 has not run yet, and
 * by exclusivity every one of those messages is about to go with the mailbox; clearing it first is
 * what lets the thread row go now, while the predicate that names it is still readable.
 *
 * Paged, and the page is re-selected rather than walked by cursor: each pass deletes the rows it
 * read, so the next selection starts at what is left and the loop ends when nothing is exclusive.
 */
async function sweepExclusiveThreads(
  tx: LedgerTx, accountId: string, mailboxId: string,
): Promise<{ threads: number; notes: number }> {
  let notes = 0;
  let removed = 0;
  for (;;) {
    const page = await tx.select({ id: threads.id }).from(threads)
      .where(and(
        eq(threads.accountId, accountId),
        exists(tx.select({ one: sql`1` }).from(messages)
          .where(and(eq(messages.threadId, threads.id), eq(messages.mailboxId, mailboxId)))),
        notExists(tx.select({ one: sql`1` }).from(messages)
          .where(and(eq(messages.threadId, threads.id), ne(messages.mailboxId, mailboxId)))),
      ))
      .orderBy(asc(threads.id))
      .limit(ERASE_THREAD_PAGE);
    if (page.length === 0) return { threads: removed, notes };
    const ids = page.map((r) => r.id);
    notes += n(await tx.delete(threadNotes).where(inArray(threadNotes.threadId, ids)));
    await tx.update(drafts).set({ threadId: null })
      .where(and(eq(drafts.accountId, accountId), inArray(drafts.threadId, ids)));
    await tx.update(messages).set({ threadId: null })
      .where(and(eq(messages.mailboxId, mailboxId), inArray(messages.threadId, ids)));
    removed += n(await tx.delete(threads).where(inArray(threads.id, ids)));
  }
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
