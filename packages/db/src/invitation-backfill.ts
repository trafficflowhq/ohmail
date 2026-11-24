import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { attachments, messageInstances, messageInvitations, messages, passProgress } from "./schema-mail.js";
import { cursorBehind, mailboxPass, proposed, readPassProgress, writePassProgress } from "./pass-progress.js";
import { recordChanges, type LedgerTx, type Tx } from "./change-log.js";
import { writeInvitation, type InvitationWrite } from "./message-invitations.js";

/**
 * THE PASS OVER STORED MAIL that gives every letter with an invitation its row (mail 0204), its
 * reads and writes on the store. The walk itself, and the re-read of each letter from the mail
 * server, are the worker's (`packages/organizer/src/invitation-backfill.ts`). Per mailbox, in message-id
 * order from a cursor in `pass_progress`; the done mark is written last, so a crash walks again.
 */
const JOB = "invitation_backfill" as const;

/** A stored letter with a calendar part and no row yet, where the mail server holds it. */
export interface InvitationCandidate {
  messageId: string;
  folder: string;
  uidValidity: string;
  uid: number;
  dedupKey: string;
  messageIdHeader: string | null;
  /** The decoded bytes' digest of each calendar part stored at arrival. */
  calendarSha256: string[];
}

/** One page of the walk: the letters read, in order, and the candidates among them. */
export interface InvitationBackfillPage {
  done: boolean;
  cursor: string | null;
  scanned: string[];
  candidates: InvitationCandidate[];
}

const CALENDAR_TYPE = sql`(lower(${attachments.contentType}) like 'text/calendar%' or lower(${attachments.contentType}) like 'application/ics%')`;

/**
 * The pass's place and the next page after it: this mailbox's living letters in id order, and of
 * them the ones with a calendar part stored and no invitation row, each with its primary instance.
 * A letter with no primary instance (the server holds it nowhere ohmail watches) is no candidate.
 */
export async function invitationBackfillPage(
  tx: Tx, accountId: string, mailboxId: string, opts: { after?: string | null; limit: number },
): Promise<InvitationBackfillPage> {
  const marks = await readPassProgress(tx, mailboxPass(JOB, accountId, mailboxId));
  if (marks.doneAt !== null) return { done: true, cursor: null, scanned: [], candidates: [] };
  const after = opts.after === undefined ? marks.cursor : opts.after;
  const scanned = (await tx.select({ id: messages.id }).from(messages)
    .where(and(
      eq(messages.accountId, accountId), eq(messages.mailboxId, mailboxId), isNull(messages.deletedAt),
      ...(after === null ? [] : [gt(messages.id, after)]),
    ))
    .orderBy(asc(messages.id))
    .limit(opts.limit)).map((r) => r.id);
  if (scanned.length === 0) return { done: false, cursor: after, scanned, candidates: [] };
  const rows = await tx.select({
    messageId: messages.id, dedupKey: messages.dedupKey, messageIdHeader: messages.messageIdHeader,
    folder: messageInstances.folder, uidValidity: messageInstances.uidvalidity, uid: messageInstances.uid,
  }).from(messages)
    .innerJoin(messageInstances, and(eq(messageInstances.messageId, messages.id), eq(messageInstances.isPrimary, true)))
    .where(and(
      inArray(messages.id, scanned), eq(messages.accountId, accountId),
      sql`exists (select 1 from ${attachments} where ${attachments.messageId} = ${messages.id} and ${CALENDAR_TYPE})`,
      sql`not exists (select 1 from ${messageInvitations} where ${messageInvitations.accountId} = ${messages.accountId}
        and ${messageInvitations.messageId} = ${messages.id})`,
    ));
  const digests = rows.length === 0 ? [] : await tx.select({ messageId: attachments.messageId, sha: attachments.contentSha256 })
    .from(attachments)
    .where(and(inArray(attachments.messageId, rows.map((r) => r.messageId)), CALENDAR_TYPE));
  const order = new Map(scanned.map((id, i) => [id, i]));
  const candidates = rows.map((r) => ({
    messageId: r.messageId, folder: r.folder, uidValidity: String(r.uidValidity), uid: Number(r.uid), dedupKey: r.dedupKey,
    messageIdHeader: r.messageIdHeader,
    calendarSha256: digests.filter((d) => d.messageId === r.messageId).map((d) => d.sha ?? "").sort(),
  })).sort((a, b) => order.get(a.messageId)! - order.get(b.messageId)!);
  return { done: false, cursor: after, scanned, candidates };
}

/**
 * SETTLE ONE PLACE OF THE WALK, in the caller's transaction: the cursor first (forward only), then
 * the letter's row through the table's one door, then a message change for the letter and for each
 * letter the row changed. `finished` writes the done mark instead of a cursor. Returns the letters
 * changed (none when no row was written).
 */
export async function settleInvitationBackfill(tx: Tx, a: {
  accountId: string; mailboxId: string; cursor: string | null; finished?: boolean; at: Date;
  invitation?: InvitationWrite;
}): Promise<string[]> {
  const key = mailboxPass(JOB, a.accountId, a.mailboxId);
  if (a.finished === true) {
    await writePassProgress(tx, key, { cursor: null, doneAt: a.at }, {
      onExisting: { cursor: null, doneAt: sql`coalesce(${passProgress.doneAt}, ${proposed("doneAt")})` }, now: a.at,
    });
  } else if (a.cursor !== null) {
    await writePassProgress(tx, key, { cursor: a.cursor }, { when: cursorBehind(tx), now: a.at });
  }
  if (a.invitation === undefined) return [];
  const { written, touched } = await writeInvitation(tx, a.invitation);
  if (!written) return [];
  const changed = [a.invitation.messageId, ...touched.filter((id) => id !== a.invitation!.messageId)];
  await recordChanges(tx as LedgerTx, changed.map((id) => ({
    accountId: a.accountId, entityType: "message" as const, entityId: id, op: "update" as const, meta: null,
  })));
  return changed;
}
