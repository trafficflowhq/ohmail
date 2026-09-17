/**
 * Taking a removed mailbox's mail off this machine — the standalone door's half of "start empty".
 * Not in `MailboxService.delete`, which is the HOSTED door's too, where the row and the mirror are
 * separate (deleting mail rows would delete the wrong copy); on the standalone door the local
 * database is BOTH server and mirror, so a removal that leaves the mail removed nothing a person can
 * see. Measured without it: the credential went, the mail stayed, and re-connecting the address
 * inserted a SECOND row (a tombstone is correctly not reused) after which the feed served both rows'
 * copies of every message. The order here is the FK graph's (children first, nothing cascades), kept
 * topological by `local-mirror-census.test.ts`. Deliberately left: `threads`/`tags`, `mailbox_credentials`, `account_settings`, and the tombstoned row.
 */

import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  attachments, drafts, flagState, folderOps, folderState, mailboxFolders, messageBodies,
  messageFailures, messageInstances, messageStates, messageTags, messages, outboundSends,
  recordMailboxRemoved, routingDecisions, trackerEvents, unsubscribeExamined, unsubscribeRecords,
  type LedgerTx, type Tx,
} from "@trafficflow/db";

import type { LocalDb } from "./db.js";

/**
 * Every table this wipe empties, in the order it empties them, named as the schema names them.
 *
 * Exported for the census test alone — the wipe itself uses the drizzle objects below, because a
 * string list that drove the deletes would be a second spelling of the schema and would not
 * typecheck against it. This is the list a reader checks, and the test checks it against the FK
 * graph rather than against a copy of itself.
 */
export const WIPED_TABLES: readonly string[] = [
  "outbound_sends",
  "drafts",
  "message_tags",
  "unsubscribe_records",
  "attachments",
  "tracker_events",
  "message_states",
  "routing_decisions",
  "message_bodies",
  "flag_state",
  "folder_state",
  "message_instances",
  "message_failures",
  "folder_ops",
  "mailbox_folders",
  "messages",
];

/**
 * Delete everything this install mirrored for one mailbox, and SAY SO in the change log so the
 * window's own mirror drops it too. Idempotent; safe on an empty store.
 *
 * NOT a transaction, and that is a decision. The caller has already committed the tombstone and
 * the credential deletion, so a failure part-way here leaves a REMOVED mailbox with some mail
 * still on disk — untidy, harmless, and recoverable by removing again. Wrapping it would put a
 * long multi-table delete inside the same lock as a lifecycle write, on a database also serving
 * the window, for no correctness this needs.
 */
export async function wipeLocalMirror(
  db: LocalDb, args: { accountId: string; mailboxId: string },
): Promise<void> {
  const { accountId, mailboxId } = args;
  await deleteMailboxRows(db, mailboxId);

  /* ── THE RECEIPT, AND IT IS PART OF THE WIPE RATHER THAN BESIDE IT ──
   * On this door the local database is BOTH server and mirror — but the WINDOW is not this
   * database: it runs its own mirror and learns what exists only from the change log it drains, so
   * the deletes above take the mail off disk and change nothing on screen until one row says it
   * (`recordMailboxRemoved`), from which the client cascades its dependents. INSIDE this function
   * so no caller can take the mail without saying so, and AFTER the deletes so the receipt is only
   * ever true. Its own transaction, because `recordChanges` allocates the account's next seq under
   * the counter's row lock and refuses an autocommit handle, and a transaction is what makes the
   * wake fire at COMMIT rather than for a row that rolled back.
   */
  await db.transaction(async (tx) => {
    await recordMailboxRemoved(tx as unknown as LedgerTx, accountId, mailboxId);
  });
}

/**
 * The TABLE WALK alone, with no receipt and no transaction of its own — {@link wipeLocalMirror}'s
 * body, named so the Cloud door can run the same deletes inside ITS page transaction when the
 * hosted feed says a mailbox was erased. One spelling of "what a mailbox's mail is", because two
 * would drift the moment a table is added; `local-mirror-census.test.ts` reads {@link WIPED_TABLES}
 * against the FK graph and so covers both callers. Takes the generic query runner rather than
 * {@link LocalDb}: the standalone door hands the top-level handle, the Cloud door the page's
 * transaction handle, and the statements are identical.
 */
export async function deleteMailboxRows(db: Tx, mailboxId: string): Promise<void> {
  /** The mailbox's own messages, as a subquery — never a list of ids read into memory. */
  const ownMessages = db.select({ id: messages.id }).from(messages)
    .where(eq(messages.mailboxId, mailboxId));
  const ownDrafts = db.select({ id: drafts.id }).from(drafts)
    .where(eq(drafts.mailboxId, mailboxId));

  // ── DRAFTS FIRST, AND WHAT THEY POINT AT ──────────────────────────────────────────────────
  await db.delete(outboundSends).where(inArray(outboundSends.draftId, ownDrafts));
  await db.delete(drafts).where(eq(drafts.mailboxId, mailboxId));
  /* A draft in ANOTHER mailbox replying to a message in THIS one. Nullable, so the reply loses its
     thread rather than the draft being destroyed — a person's unsent words are not this
     removal's to take. This was written as "unreachable on a one-mailbox install and cheap", true
     of an install that held one mailbox and reached only after a remove-and-re-add put two rows
     beside each other. An install holds several mailboxes now, so it is an ORDINARY arm: a reply
     drafted in one mailbox to a message in another is a thing people do, and removing the second
     mailbox must take the message without taking the unsent words. */
  await db.update(drafts)
    .set({ inReplyToMessageId: null })
    .where(and(isNotNull(drafts.inReplyToMessageId), inArray(drafts.inReplyToMessageId, ownMessages)));

  // ── THE MESSAGES' OWN CHILDREN ────────────────────────────────────────────────────────────
  await db.delete(messageTags).where(inArray(messageTags.messageId, ownMessages));
  // The per-message marks hang off the record by foreign key, so they go first.
  await db.delete(unsubscribeExamined).where(inArray(unsubscribeExamined.messageId, ownMessages));
  await db.delete(unsubscribeRecords).where(eq(unsubscribeRecords.mailboxId, mailboxId));
  await db.delete(attachments).where(inArray(attachments.messageId, ownMessages));
  await db.delete(trackerEvents).where(inArray(trackerEvents.messageId, ownMessages));
  await db.delete(messageStates).where(inArray(messageStates.messageId, ownMessages));
  await db.delete(routingDecisions).where(inArray(routingDecisions.messageId, ownMessages));
  await db.delete(messageBodies).where(inArray(messageBodies.messageId, ownMessages));
  await db.delete(flagState).where(inArray(flagState.messageId, ownMessages));
  await db.delete(folderState).where(inArray(folderState.messageId, ownMessages));

  // ── AND THE MAILBOX'S OWN ─────────────────────────────────────────────────────────────────
  await db.delete(messageInstances).where(eq(messageInstances.mailboxId, mailboxId));
  await db.delete(messageFailures).where(eq(messageFailures.mailboxId, mailboxId));
  /* `folder_ops` before `mailbox_folders`: it references both, and the folder row is the parent. */
  await db.delete(folderOps).where(eq(folderOps.mailboxId, mailboxId));
  await db.delete(mailboxFolders).where(eq(mailboxFolders.mailboxId, mailboxId));
  await db.delete(messages).where(eq(messages.mailboxId, mailboxId));
}

/**
 * How many rows this install still holds for a mailbox — the wipe's own read-back, for tests and
 * for a caller that wants to log what it removed. Counts MESSAGES alone: every other table in the
 * list hangs off one, so a message count of zero with children left behind is an FK violation the
 * database would not have permitted.
 */
export async function mirroredMessageCount(db: LocalDb, mailboxId: string): Promise<number> {
  const [row] = await db
    .select({ n: dialect(db).castInt(sql`count(*)`).mapWith(Number) as unknown as SQL<number> })
    .from(messages)
    .where(eq(messages.mailboxId, mailboxId));
  return row?.n ?? 0;
}

/**
 * HAS THIS MAILBOX EVER PUT ANYTHING IN THE MIRROR, AND HAS ANYTHING BEEN WRITTEN OFF —
 * the two facts the first-sync state is derived from, in one read each.
 *
 * `limit(1)` and never a count: the question is "any", it is asked on every unsettled drain, and
 * both columns are indexed by `mailboxId`. `wroteOff` tells an EMPTY mailbox apart from one whose
 * mail could not be stored — the ingest's quarantine writes a `message_failures` row when a
 * message exhausts its attempts. Read only where there are no messages at all: one written-off
 * message among thousands of good ones says nothing about the first sync.
 */
export async function mirroredFirstSyncFacts(
  db: LocalDb, mailboxId: string,
): Promise<{ hasMessage: boolean; wroteOff: boolean }> {
  const seen = await db
    .select({ id: messages.id }).from(messages)
    .where(eq(messages.mailboxId, mailboxId)).limit(1);
  if (seen.length > 0) return { hasMessage: true, wroteOff: false };
  const failed = await db
    .select({ id: messageFailures.id }).from(messageFailures)
    .where(eq(messageFailures.mailboxId, mailboxId)).limit(1);
  return { hasMessage: false, wroteOff: failed.length > 0 };
}
