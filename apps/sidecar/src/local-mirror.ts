/**
 * TAKING A REMOVED MAILBOX'S MAIL OFF THIS MACHINE — the standalone door's half of "start empty".
 *
 * ── WHY THIS IS NOT IN `MailboxService.delete` ────────────────────────────────────────────────
 *
 * That method is the HOSTED door's too, and there the two things are genuinely separate: the
 * server keeps the row and the mirror lives in somebody's browser, so deleting mail rows would be
 * deleting the wrong copy. On the standalone door the local database is BOTH — it is the server
 * the window talks to and the mirror the window renders — so a removal that tombstones the row and
 * leaves the mail is a removal that removed nothing a person can see.
 *
 * ── WHAT WAS MEASURED WITHOUT IT ──────────────────────────────────────────────────────────────
 *
 * "Forget it and start empty" was pressed. The credential went, the appointments were closed with
 * an honest sentence, and the mail list stayed on screen behind the welcome dialog. Then the same
 * address was connected again — and `ensureLocalWorld` correctly does NOT reuse a tombstone (a
 * tombstone is not a mailbox), so a SECOND row was inserted beside the first.
 *
 * From that moment the feed served BOTH rows' copies of every message. The counters in the rail
 * doubled, the sync line reported twice the mailbox's size, and every conversation in every list
 * was a thread with one other message in it: its own duplicate. That is not a rendering fault to
 * be papered over downstream — the second copy is really in the store, it really has its own id,
 * and every view derived from the store agrees with every other one about it.
 *
 * The doubling is the visible end of it. The removal is where it starts.
 *
 * ── THE ORDER IS THE WHOLE IMPLEMENTATION, AND IT IS THE FOREIGN KEYS' ORDER ──────────────────
 *
 * Nothing here is `ON DELETE CASCADE`, so children go first or the statement throws. The list
 * below is a topological order over the FK graph the mail schema declares, and
 * `local-mirror-census.test.ts` is what keeps it one: it re-derives the set of tables that
 * reference `messages` or `mailboxes` from `schema-mail.ts` and fails when one of them is missing
 * here. A table added later without a line here would otherwise either throw on a real removal or —
 * worse, if its FK were nullable — leave rows behind and reintroduce the doubling quietly.
 *
 * ── WHAT IS DELIBERATELY LEFT ─────────────────────────────────────────────────────────────────
 *
 *  · `threads` and `tags` are ACCOUNT-scoped, not mailbox-scoped. A thread with no messages left
 *    in it is inert (every read of it is through `messages`), and deleting them would reach across
 *    into a mailbox this removal is not about.
 *  · `mailbox_credentials` is deleted by `MailboxService.delete`, inside its own transaction, and
 *    is not repeated here. One writer.
 *  · `account_settings` — the screening window, the dormancy dial, the onboarding stamp. These are
 *    the INSTALL's answers, not the mailbox's, and re-adding a mailbox should not re-ask somebody
 *    what they already told this machine. The consent stamp that matters is on the mailbox row and
 *    goes with it.
 *  · The MAILBOX ROW ITSELF. `MailboxService.delete` tombstones it and the tombstone is
 *    load-bearing: `ensureLocalWorld` reads it to know this address was removed rather than never
 *    seen, and the change log the window is holding refers to it. Deleting the row would also make
 *    every `mailbox_id` in the change feed dangle.
 */

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  attachments, drafts, flagState, folderOps, folderState, mailboxFolders, messageBodies,
  messageFailures, messageInstances, messageStates, messageTags, messages, outboundSends,
  routingDecisions, trackerEvents, unsubscribeRecords,
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
 * Delete everything this install mirrored for one mailbox. Idempotent; safe on an empty store.
 *
 * NOT a transaction, and that is a decision rather than an omission. The caller has already
 * committed the tombstone and the credential deletion — the acts that make the mailbox stop
 * working — so a failure part-way through here leaves a REMOVED mailbox with some of its mail
 * still on disk, which is untidy and harmless, and is recoverable by removing again. Wrapping it
 * would instead put a long multi-table delete inside the same lock as a lifecycle write, on a
 * database that is also serving the window, for no correctness this needs.
 */
export async function wipeLocalMirror(db: LocalDb, mailboxId: string): Promise<void> {
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
     removal's to take. Unreachable on a one-mailbox install and cheap; it exists because after a
     remove-and-re-add there ARE two rows, which is the state this whole file is about. */
  await db.update(drafts)
    .set({ inReplyToMessageId: null })
    .where(and(isNotNull(drafts.inReplyToMessageId), inArray(drafts.inReplyToMessageId, ownMessages)));

  // ── THE MESSAGES' OWN CHILDREN ────────────────────────────────────────────────────────────
  await db.delete(messageTags).where(inArray(messageTags.messageId, ownMessages));
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
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(messages)
    .where(eq(messages.mailboxId, mailboxId));
  return row?.n ?? 0;
}
