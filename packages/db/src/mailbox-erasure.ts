import { and, eq, exists, inArray, isNotNull, isNull, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import type { Dialect } from "./dialect/index.js";
import {
  ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS,
  approvals, attachments, auditLog, awayReplies, awayResponderSent, drafts, flagState, folderOps,
  folderState, junkRescues, mailboxCredentials, mailboxFolders, mailboxProfileMirror, mailboxes,
  messageBodies, messageFailures, messageInstances, messageSearch, messageStates, messageTags, messages,
  organizerRequests, outboundSendFingerprints, outboundSentCopies, outboundSends, routingDecisions, threadNotes,
  threads, trackerEvents, unsubscribeExamined, unsubscribeRecords,
} from "./schema-mail.js";
import { recordChanges, recordMailboxRemoved, type LedgerTx, type Tx } from "./change-log.js";
import { eraseIdempotentResponses } from "./idempotency.js";
import { SETTINGS_HASH_KEYS, settingsHashRows } from "./profile-import-ask.js";
import { readAccountErasedAt } from "./erasure-fence.js";
import { rowsAffected as n } from "./rows-affected.js";
import { lockAccountStorage, recomputeAccountStorage, releaseBodyBytes } from "./storage.js";

/**
 * ERASING OHMAIL'S COPY OF ONE MAILBOX'S MAIL, IN BOUNDED STEPS.
 *
 * The request STAMPS ({@link stampMailboxErasure}) and answers; the worker's `mailbox_erasure`
 * pass runs {@link eraseOwedMailbox}, one {@link sweepMailboxStep} per transaction. The resume
 * point is the tombstone alone: `erased_at` set and `erasure_done_at` NULL means owed, and every
 * step deletes what it read, so a restart continues from whatever is left. IMAP is untouched —
 * the mail stays on the person's own server, which is the master; this removes ohmail's copy.
 */

/** How many messages (or drafts) one step names. Every per-row statement is bounded by it. */
export const ERASE_BATCH = 2_000;

/** What the request's stamp found: the receipt it can promise, or that nothing is owed. */
export interface MailboxErasureStamp {
  /** Messages the sweep will erase. The stamp fences every writer, so no more can arrive. */
  messages: number;
  drafts: number;
  /** Drafts in OTHER mailboxes whose reply anchor pointed here, cleared by the stamp. */
  draftsUnanchored: number;
  /** An erasure already finished: nothing was stamped anew and nothing is owed. */
  done: boolean;
}

/** One step's receipt. `done` is set on the step that finished the erasure. */
export interface MailboxSweepStep {
  deleted: Record<string, number>;
  messagesErased: number;
  draftsErased: number;
  draftsUnanchored: number;
  /** The highest change-log seq this step allocated, `null` when it allocated none. */
  seq: bigint | null;
  done: boolean;
}

/** A whole erasure's receipt, the steps summed. */
export type MailboxSweepResult = Omit<MailboxSweepStep, "done">;

const countOf = () => sql<number>`count(*)`.mapWith(Number);

/**
 * THE STAMP, inside the removal's transaction (the caller holds the account row, the lock and the
 * mailbox row, in that order). `isNull` keeps the FIRST stamp on a retry, and it is not a
 * `coalesce` cast because the phone bundle loads this file and its store has no `::timestamptz`.
 * The sibling anchors are cleared here, while every anchored message still exists, so the receipt
 * can count them; the sweep clears any written later before it deletes their message.
 */
export async function stampMailboxErasure(
  tx: Tx, args: { accountId: string; mailboxId: string; now: Date },
): Promise<MailboxErasureStamp> {
  const { accountId, mailboxId, now } = args;
  await tx.update(mailboxes).set({
    erasedAt: now,
    // A press of Import settings dies with the mailbox: its fingerprint is a hash of the settings.
    profileImportAskFingerprint: null, profileImportAskAt: null,
    profileImportAskOutcome: null, profileImportAskReason: null,
  })
    .where(and(
      eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId), isNull(mailboxes.erasedAt),
    ));
  // …and every hash of its settings or its signature that its audit rows hold.
  await forgetSettingsHashes(tx, accountId, mailboxId);
  const [row] = await tx.select({ done: mailboxes.erasureDoneAt }).from(mailboxes)
    .where(eq(mailboxes.id, mailboxId)).limit(1);
  if (row?.done) return { messages: 0, drafts: 0, draftsUnanchored: 0, done: true };

  const draftsUnanchored = n(await tx.update(drafts)
    .set({ inReplyToMessageId: null })
    .where(and(
      eq(drafts.accountId, accountId),
      ne(drafts.mailboxId, mailboxId),
      isNotNull(drafts.inReplyToMessageId),
      exists(tx.select({ one: sql`1` }).from(messages).where(and(
        eq(messages.id, drafts.inReplyToMessageId), eq(messages.mailboxId, mailboxId),
      ))),
    ))) + n(await tx.update(drafts)
    // …and a forward drafted there of a message here: its note stays, its original goes.
    .set({ forwardOfMessageId: null, forwardParts: null })
    .where(and(
      eq(drafts.accountId, accountId),
      ne(drafts.mailboxId, mailboxId),
      isNotNull(drafts.forwardOfMessageId),
      exists(tx.select({ one: sql`1` }).from(messages).where(and(
        eq(messages.id, drafts.forwardOfMessageId), eq(messages.mailboxId, mailboxId),
      ))),
    )));
  // THE RESPONSE CACHE, AT THE STAMP: a stored DTO is a second copy of a draft, and a retry
  // served it for as long as the sweep ran. From this commit a replay of THIS mailbox answers 410;
  // a response that names only another mailbox keeps replaying.
  await eraseIdempotentResponses(tx, accountId, now, { mailboxId });
  const [m] = await tx.select({ c: countOf() }).from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.mailboxId, mailboxId)));
  const [d] = await tx.select({ c: countOf() }).from(drafts)
    .where(and(eq(drafts.accountId, accountId), eq(drafts.mailboxId, mailboxId)));
  return { messages: m?.c ?? 0, drafts: d?.c ?? 0, draftsUnanchored, done: false };
}

/**
 * ONE STEP of an owed erasure, in the caller's transaction and under the caller's locks: up to
 * {@link ERASE_BATCH} drafts; once none are left, up to that many messages with everything keyed
 * on them; once none of those are left, the mailbox's own state, its one `mailbox` receipt and the
 * finish stamp. Every statement is keyed by the account as well where a table's index leads with
 * it: without that a message-keyed delete is a scan of the whole deployment's table.
 */
export async function sweepMailboxStep(
  tx: LedgerTx, d: Dialect, args: { accountId: string; mailboxId: string; now: Date },
): Promise<MailboxSweepStep> {
  const { accountId, mailboxId, now } = args;
  const deleted: Record<string, number> = {};
  const drop = async (table: string, run: Promise<unknown>) => {
    deleted[table] = (deleted[table] ?? 0) + n(await run);
  };
  const out = (
    part: Partial<MailboxSweepStep> & Pick<MailboxSweepStep, "done">,
  ): MailboxSweepStep => ({
    deleted, messagesErased: 0, draftsErased: 0, draftsUnanchored: 0, seq: null, ...part,
  });

  /* DRAFTS FIRST, the one-transaction sweep's order: a draft of this mailbox can reply to its own
     messages, and that anchor is a foreign key into the page the next step deletes. */
  const draftPage = await tx.select({ id: drafts.id }).from(drafts)
    .where(and(eq(drafts.accountId, accountId), eq(drafts.mailboxId, mailboxId)))
    .limit(ERASE_BATCH);
  if (draftPage.length > 0) {
    const ids = draftPage.map((r) => r.id);
    const seqs = await recordChanges(tx, ids.map((id) => ({
      accountId, entityType: "draft" as const, entityId: id, op: "delete" as const, meta: null,
    })));
    // A send record names a draft; its `on delete set null` would cut the link it is selected by.
    await drop("outbound_sends", tx.delete(outboundSends)
      .where(and(eq(outboundSends.accountId, accountId), inArray(outboundSends.draftId, ids))));
    // scoped-by: ids — a page of this mailbox's drafts read just above
    await drop("drafts", tx.delete(drafts).where(inArray(drafts.id, ids)));
    return out({ draftsErased: ids.length, seq: seqs[seqs.length - 1] ?? null, done: false });
  }

  const page = await tx.select({ id: messages.id, threadId: messages.threadId }).from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.mailboxId, mailboxId)))
    .limit(ERASE_BATCH);
  if (page.length > 0) return out({ ...(await eraseMessages(tx, d, accountId, mailboxId, page, drop)), done: false });

  /* ── THE MAILBOX'S OWN STATE, AND THE FINISH ──
   * These tables scale with a mailbox's folders, lists and correspondents, not with its messages.
   * `mailbox_profile_mirror` and `organizer_requests` carry no foreign key, so nothing else ever
   * removes them; the response cache is a second copy of drafts and is REPLACED, scoped to this
   * mailbox as its primitive states. The `mailbox` receipt comes last so it carries the
   * erasure's highest seq, and the finish stamp is in the same transaction as it. The counter is
   * recounted first (its lock before the receipt's seq): that repairs bytes an older erase left. */
  await recomputeAccountStorage(tx, d, accountId, now);
  await drop("outbound_sent_copies", tx.delete(outboundSentCopies).where(and(
    eq(outboundSentCopies.accountId, accountId), eq(outboundSentCopies.mailboxId, mailboxId),
  )));
  await drop("outbound_send_fingerprints", tx.delete(outboundSendFingerprints).where(and(
    eq(outboundSendFingerprints.accountId, accountId), eq(outboundSendFingerprints.mailboxId, mailboxId),
  )));
  await drop("away_replies", tx.delete(awayReplies).where(and(
    eq(awayReplies.accountId, accountId), eq(awayReplies.mailboxId, mailboxId),
  )));
  await drop("unsubscribe_records", tx.delete(unsubscribeRecords)
    .where(eq(unsubscribeRecords.mailboxId, mailboxId)));
  await drop("message_failures", tx.delete(messageFailures)
    .where(eq(messageFailures.mailboxId, mailboxId)));
  // Keyed on the mailbox as well; any left once its messages are gone named another's message.
  await drop("message_instances", tx.delete(messageInstances)
    .where(eq(messageInstances.mailboxId, mailboxId)));
  // `folder_ops` before the inventory it would cascade from, so the receipt counts it.
  await drop("folder_ops", tx.delete(folderOps).where(eq(folderOps.mailboxId, mailboxId)));
  await drop("junk_rescues", tx.delete(junkRescues).where(eq(junkRescues.mailboxId, mailboxId)));
  await drop("mailbox_folders", tx.delete(mailboxFolders)
    .where(eq(mailboxFolders.mailboxId, mailboxId)));
  await drop("mailbox_profile_mirror", tx.delete(mailboxProfileMirror)
    .where(eq(mailboxProfileMirror.mailboxId, mailboxId)));
  await drop("organizer_requests", tx.delete(organizerRequests)
    .where(eq(organizerRequests.mailboxId, mailboxId)));
  // Idempotent: the removal this rides already deleted the credential rows.
  await drop("mailbox_credentials", tx.delete(mailboxCredentials)
    .where(eq(mailboxCredentials.mailboxId, mailboxId)));
  deleted["idempotency_keys"] = await eraseIdempotentResponses(tx, accountId, now, { mailboxId });
  const seq = await recordMailboxRemoved(tx, accountId, mailboxId);
  // The receipt retains nothing for the mailbox, its signature included, nor a hash of it or the settings.
  await forgetSettingsHashes(tx, accountId, mailboxId);
  await tx.update(mailboxes).set({ erasureDoneAt: now, signature: null, signatureHtml: null })
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)));
  return out({ seq, done: true });
}

/**
 * The hashes naming this mailbox's settings or signature come off its audit rows, which stay
 * (`settingsHashRows`). At the stamp, after which the fence refuses a new row, and again at the
 * finish, for the rows a stamp by an older build left. Returns how many rows it wrote.
 */
async function forgetSettingsHashes(tx: Tx, accountId: string, mailboxId: string): Promise<number> {
  const rows = await settingsHashRows(tx, { accountId, mailboxId });
  for (const r of rows) {
    await tx.update(auditLog).set({ payload: r.payload })
      .where(and(eq(auditLog.id, r.id), eq(auditLog.accountId, accountId)));
  }
  return rows.length;
}

/**
 * One page of messages and everything keyed on them. The receipts come first, while the ids are
 * still readable: one `delete` change per message, so a mirror tombstones instead of rendering
 * mail the server no longer holds. Child before parent throughout; `approvals` before
 * `routing_decisions`, which it references. The counter row is locked before the receipts, the
 * order ingest takes it in (reserve, then the change), and loses the deleted bodies' bytes.
 */
async function eraseMessages(
  tx: LedgerTx, d: Dialect, accountId: string, mailboxId: string,
  page: Array<{ id: string; threadId: string | null }>,
  drop: (table: string, run: Promise<unknown>) => Promise<void>,
): Promise<Pick<MailboxSweepStep, "messagesErased" | "draftsUnanchored" | "seq">> {
  const ids = page.map((r) => r.id);
  await lockAccountStorage(tx, d, accountId);
  const seqs = await recordChanges(tx, ids.map((id) => ({
    accountId, entityType: "message" as const, entityId: id, op: "delete" as const, meta: null,
  })));
  // A reply or a forward drafted in a SIBLING mailbox after the stamp: it keeps its text, loses its anchor.
  const draftsUnanchored = n(await tx.update(drafts).set({ inReplyToMessageId: null })
    .where(and(
      eq(drafts.accountId, accountId), ne(drafts.mailboxId, mailboxId),
      inArray(drafts.inReplyToMessageId, ids),
    ))) + n(await tx.update(drafts).set({ forwardOfMessageId: null, forwardParts: null })
    .where(and(
      eq(drafts.accountId, accountId), ne(drafts.mailboxId, mailboxId),
      inArray(drafts.forwardOfMessageId, ids),
    )));
  const decisions = tx.select({ id: routingDecisions.id }).from(routingDecisions).where(and(
    eq(routingDecisions.accountId, accountId), inArray(routingDecisions.messageId, ids)));
  await drop("approvals", tx.delete(approvals).where(and(
    eq(approvals.accountId, accountId), inArray(approvals.messageId, ids))));
  // An approval can name the decision without the message; it references that row too.
  await drop("approvals", tx.delete(approvals).where(and(
    eq(approvals.accountId, accountId), inArray(approvals.routingDecisionId, decisions))));
  await drop("routing_decisions", tx.delete(routingDecisions).where(and(
    eq(routingDecisions.accountId, accountId), inArray(routingDecisions.messageId, ids))));
  await drop("attachments", tx.delete(attachments).where(and(
    eq(attachments.accountId, accountId), inArray(attachments.messageId, ids))));
  // scoped-by: ids — a page of this mailbox's messages read by the step
  await drop("message_tags", tx.delete(messageTags).where(inArray(messageTags.messageId, ids)));
  // scoped-by: ids — a page of this mailbox's messages read by the step
  await drop("message_states", tx.delete(messageStates).where(inArray(messageStates.messageId, ids)));
  await drop("tracker_events", tx.delete(trackerEvents).where(and(
    eq(trackerEvents.accountId, accountId), inArray(trackerEvents.messageId, ids))));
  // A CORRESPONDENT's address, held because this mailbox answered them.
  await drop("away_responder_sent", tx.delete(awayResponderSent).where(and(
    eq(awayResponderSent.accountId, accountId), inArray(awayResponderSent.messageId, ids))));
  await drop("away_replies", tx.delete(awayReplies).where(and(
    eq(awayReplies.accountId, accountId), inArray(awayReplies.messageId, ids))));
  // scoped-by: ids — a page of this mailbox's messages read by the step
  await drop("unsubscribe_examined", tx.delete(unsubscribeExamined)
    .where(inArray(unsubscribeExamined.messageId, ids)));
  /* A list record is keyed by the message that carried it, and examined rows of LATER pages can
     name it, so those go first — they are this mailbox's too. The mailbox-keyed rest goes last. */
  const records = tx.select({ id: unsubscribeRecords.id }).from(unsubscribeRecords).where(and(
    eq(unsubscribeRecords.accountId, accountId), inArray(unsubscribeRecords.messageId, ids)));
  await drop("unsubscribe_examined", tx.delete(unsubscribeExamined)
    .where(inArray(unsubscribeExamined.recordId, records)));
  await drop("unsubscribe_records", tx.delete(unsubscribeRecords).where(and(
    eq(unsubscribeRecords.accountId, accountId), inArray(unsubscribeRecords.messageId, ids))));
  // scoped-by: ids — a page of this mailbox's messages read by the step
  await drop("message_instances", tx.delete(messageInstances)
    .where(inArray(messageInstances.messageId, ids)));
  // The bodies and the read state key off the MESSAGE and carry no `account_id` at all.
  // scoped-by: ids — a page of this mailbox's messages read by the step
  // The bytes come from the delete itself, so a body a trim emptied meanwhile gives back nothing twice;
  // so does the count of letters emptied for space, by the marker each deleted row carried.
  const bodies = await tx.delete(messageBodies).where(inArray(messageBodies.messageId, ids)).returning({
    bytes: sql<number>`octet_length(${messageBodies.text}) + coalesce(octet_length(${messageBodies.html}), 0)`,
    withheld: messageBodies.withheldReason,
  });
  await drop("message_bodies", Promise.resolve(bodies));
  const freed = bodies.reduce((sum, b) => sum + Number(b.bytes), 0);
  const emptied = bodies.filter((b) => b.withheld === "storage_cap").length;
  if (freed > 0 || emptied > 0) await releaseBodyBytes(tx, d, accountId, freed, emptied);
  // The search documents (mail 0125) carry the body's words — with the bodies, before `messages`.
  // scoped-by: ids — a page of this mailbox's messages read by the step
  await drop("message_search", tx.delete(messageSearch).where(inArray(messageSearch.messageId, ids)));
  // scoped-by: ids — a page of this mailbox's messages read by the step
  await drop("folder_state", tx.delete(folderState).where(inArray(folderState.messageId, ids)));
  // scoped-by: ids — a page of this mailbox's messages read by the step
  await drop("flag_state", tx.delete(flagState).where(inArray(flagState.messageId, ids)));

  const threadSeq = await eraseExclusiveThreads(tx, accountId, mailboxId, page, drop);

  // scoped-by: ids — a page of this mailbox's messages read by the step
  await drop("messages", tx.delete(messages).where(inArray(messages.id, ids)));
  return { messagesErased: ids.length, draftsUnanchored, seq: threadSeq ?? seqs[seqs.length - 1] ?? null };
}

/**
 * The threads this page touches that the mailbox ALONE holds — a thread carries the SUBJECT and
 * the PARTICIPANTS, and its notes what the person wrote, so leaving them is a mailbox that still
 * answers with its own mail. Shared threads survive and lose only this mailbox's messages. For an
 * exclusive one, every message of this mailbox in it is unhooked (later pages included) and a
 * sibling's draft keeps its text and loses the thread, before the thread row goes. Each one gets
 * a `thread` delete in the same transaction, so every mirror drops it; returns the last seq.
 */
async function eraseExclusiveThreads(
  tx: LedgerTx, accountId: string, mailboxId: string,
  page: Array<{ threadId: string | null }>,
  drop: (table: string, run: Promise<unknown>) => Promise<void>,
): Promise<bigint | null> {
  // Both counts on every page, zero included: "no thread was this mailbox's alone" is an answer.
  await drop("threads", Promise.resolve(0));
  await drop("thread_notes", Promise.resolve(0));
  const touched = [...new Set(page.map((r) => r.threadId).filter((t): t is string => t !== null))];
  if (touched.length === 0) return null;
  const exclusive = (await tx.select({ id: threads.id }).from(threads).where(and(
    eq(threads.accountId, accountId),
    inArray(threads.id, touched),
    notExists(tx.select({ one: sql`1` }).from(messages).where(and(
      eq(messages.accountId, accountId), eq(messages.threadId, threads.id),
      ne(messages.mailboxId, mailboxId),
    ))),
  ))).map((r) => r.id);
  if (exclusive.length === 0) return null;
  const seqs = await recordChanges(tx, exclusive.map((id) => ({
    accountId, entityType: "thread" as const, entityId: id, op: "delete" as const, meta: null,
  })));
  await drop("thread_notes", tx.delete(threadNotes)
    .where(and(eq(threadNotes.accountId, accountId), inArray(threadNotes.threadId, exclusive))));
  await tx.update(drafts).set({ threadId: null })
    .where(and(eq(drafts.accountId, accountId), inArray(drafts.threadId, exclusive)));
  await tx.update(messages).set({ threadId: null }).where(and(
    eq(messages.accountId, accountId), eq(messages.mailboxId, mailboxId),
    inArray(messages.threadId, exclusive),
  ));
  // scoped-by: exclusive — this account's threads the mailbox alone holds, read just above
  await drop("threads", tx.delete(threads).where(inArray(threads.id, exclusive)));
  return seqs[seqs.length - 1] ?? null;
}

/**
 * THE WHOLE ERASURE IN THE CALLER'S TRANSACTION — the stamp, then steps until done. For a caller
 * whose mailbox is small or who must order the erasure against another writer in one
 * transaction; the request never takes it, because a large mailbox does not fit in one.
 */
export async function sweepMailboxData(
  tx: LedgerTx, d: Dialect, args: { accountId: string; mailboxId: string; now: Date },
): Promise<MailboxSweepResult> {
  const stamp = await stampMailboxErasure(tx, args);
  const total: MailboxSweepResult = {
    deleted: {}, messagesErased: 0, draftsErased: 0, draftsUnanchored: stamp.draftsUnanchored, seq: null,
  };
  if (stamp.done) return total;
  for (;;) {
    const step = await sweepMailboxStep(tx, d, args);
    addStep(total, step);
    if (step.done) return total;
  }
}

function addStep(total: MailboxSweepResult, step: MailboxSweepStep): void {
  for (const [table, rows] of Object.entries(step.deleted)) {
    total.deleted[table] = (total.deleted[table] ?? 0) + rows;
  }
  total.messagesErased += step.messagesErased;
  total.draftsErased += step.draftsErased;
  total.draftsUnanchored += step.draftsUnanchored;
  if (step.seq !== null) total.seq = step.seq;
}

/** What {@link eraseOwedMailbox} did to one mailbox in one run. */
export interface OwedErasureRun extends MailboxSweepResult {
  steps: number;
  /** The erasure finished in this run. */
  done: boolean;
  /** Not owed when this run looked — finished by another runner, never stamped, or its account erased. */
  skipped: boolean;
}

/**
 * Run up to `maxSteps` steps of ONE owed erasure, each its own transaction, in the lock order
 * every erasure holds: the account row FOR SHARE (an account being erased is its own sweep's to
 * finish), the account's thread-structure lock, then the mailbox row FOR UPDATE, re-read so a
 * step never runs on an erasure somebody else finished; inside the step, the `account_storage`
 * row, then the change-log sequence, then the rows it deletes. `until` ends the run between steps.
 */
export async function eraseOwedMailbox(
  db: Tx, d: Dialect,
  args: { accountId: string; mailboxId: string; now: () => Date; maxSteps: number; until?: () => boolean },
): Promise<OwedErasureRun> {
  const run: OwedErasureRun = {
    deleted: {}, messagesErased: 0, draftsErased: 0, draftsUnanchored: 0, seq: null,
    steps: 0, done: false, skipped: false,
  };
  while (run.steps < args.maxSteps && !(args.until?.() ?? false)) {
    const step = await db.transaction(async (raw) => {
      const tx = raw as unknown as LedgerTx;
      if ((await readAccountErasedAt(tx, d, args.accountId)) != null) return null;
      await d.advisoryLock(tx, ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS, args.accountId);
      const [row] = await d.forUpdate(
        tx.select({ erasedAt: mailboxes.erasedAt, doneAt: mailboxes.erasureDoneAt }).from(mailboxes)
          .where(and(eq(mailboxes.id, args.mailboxId), eq(mailboxes.accountId, args.accountId)))
          .limit(1),
        { mode: "update" });
      if (!row || row.erasedAt === null || row.doneAt !== null) return null;
      return sweepMailboxStep(tx, d, { accountId: args.accountId, mailboxId: args.mailboxId, now: args.now() });
    });
    if (step === null) { run.skipped = run.steps === 0; return run; }
    run.steps += 1;
    addStep(run, step);
    if (step.done) { run.done = true; return run; }
  }
  return run;
}

/** How many finished erasures one backlog clear reads (signatures, settings hashes). */
const SIGNATURE_BACKLOG_PAGE = 50;

/**
 * A finished erasure retains nothing, its signature included; the last step clears it, and this
 * clears the ones finished before it did (nothing re-runs a finished erasure). Safe to repeat;
 * one row per statement, so it holds at most one mailbox lock. Returns how many it cleared.
 */
export async function clearErasedSignatures(db: Tx, scope?: SQL): Promise<number> {
  const kept = and(
    isNotNull(mailboxes.erasureDoneAt),
    or(isNotNull(mailboxes.signature), isNotNull(mailboxes.signatureHtml)),
  );
  const rows = await db.select({ id: mailboxes.id, accountId: mailboxes.accountId }).from(mailboxes)
    .where(scope ? and(kept, scope) : kept).limit(SIGNATURE_BACKLOG_PAGE);
  let cleared = 0;
  for (const r of rows) {
    cleared += (await db.update(mailboxes).set({ signature: null, signatureHtml: null })
      .where(and(eq(mailboxes.id, r.id), eq(mailboxes.accountId, r.accountId), kept))
      .returning({ id: mailboxes.id })).length;
  }
  return cleared;
}

/**
 * …nor any hash of its settings or signature on its audit rows: the stamp and the last step take
 * them off ({@link SETTINGS_HASH_KEYS}), and this takes them off the erasures finished before they
 * did, instead of leaving them to the audit trail's year. Safe to repeat; one audit row per
 * statement. Returns how many mailboxes it cleared.
 */
export async function clearErasedSettingsHashes(db: Tx, scope?: SQL): Promise<number> {
  const holdsAHash = or(...Object.entries(SETTINGS_HASH_KEYS).map(([action, keys]) => and(
    eq(auditLog.action, action),
    or(...keys.map((k) => sql`${auditLog.payload}->>${k} is not null`)),
  )));
  const owed = and(
    isNotNull(mailboxes.erasureDoneAt),
    exists(db.select({ one: sql`1` }).from(auditLog).where(and(
      eq(auditLog.accountId, mailboxes.accountId),
      sql`${auditLog.payload}->>'mailboxId' = cast(${mailboxes.id} as text)`,
      holdsAHash,
    ))),
  );
  const rows = await db.select({ id: mailboxes.id, accountId: mailboxes.accountId }).from(mailboxes)
    .where(scope ? and(owed, scope) : owed).limit(SIGNATURE_BACKLOG_PAGE);
  let cleared = 0;
  for (const r of rows) {
    if ((await forgetSettingsHashes(db, r.accountId, r.id)) > 0) cleared += 1;
  }
  return cleared;
}

/** Messages an owed erasure has left, for the list's `erasure.remaining`. */
export async function erasureRemaining(db: Tx, accountId: string, mailboxId: string): Promise<number> {
  const [m] = await db.select({ c: countOf() }).from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.mailboxId, mailboxId)));
  return m?.c ?? 0;
}
