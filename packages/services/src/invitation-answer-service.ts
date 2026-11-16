import { and, desc, eq, isNull, like, ne } from "drizzle-orm";
import {
  drafts, invitationStanding, mailboxes, messageInvitations, messages, outboundSends, recordChanges, recordInvitationAnswer,
  sameAddress, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { createLogger, invitationReplyText, type Logger } from "@trafficflow/core/mail";
import type { InvitationAnswer, InvitationAnswerResult } from "@ohmail/wire";
import { bridgeTx, withAccountTx, type ServiceContext } from "./context.js";
import { draftsService, type DraftsService } from "./drafts-service.js";
import { ServiceError } from "./errors.js";
import { requireUuid } from "./ids.js";
import { INVITATION_ANSWER_MARK, invitationAnswerKey } from "./invitation-answer-draft.js";
import { SEND_WITHDRAWN_SENTENCE, sendService, type SendDeps, type SendResult, type SendService } from "./send-service.js";

/**
 * AN INVITATION ANSWERED BY MAIL: Yes, Maybe or No on the card of a letter that carries an
 * invitation, sent as an iTIP REPLY from the address that was invited, to the organizer alone, once,
 * and only on the person's press. Mail, so it works with the calendar off.
 *
 * The answer is a letter like any other: one draft (made once per letter, answer and the answer on
 * record before it) sent by `SendService.send` under the press's key, so it has one Message-ID, an
 * owed Sent copy, and its place in the conversation. Its calendar part is written from the stored
 * row alone (core's `invitation-reply`). The answer is recorded on the row only once the send says
 * `sent`, never before; the Sent copy's own ingest records it again, which also covers a send that
 * ended `queued` and an answer given in another mail client.
 *
 * An entry of its own (`@trafficflow/services/invitation-answer`), in no barrel, called by one
 * route: no rule, workflow, pass or setting reaches it.
 */

/** A press on an invitation's card, as the route reads it. */
export interface InvitationPress {
  messageId: string;
  answer: unknown;
  /** The answer the card showed when it was pressed; null for none. */
  basis: unknown;
  /** The press's `Idempotency-Key`: the send's own key. */
  key: string;
}

/** The stored row of the letter answered. */
export type InvitationRow = typeof messageInvitations.$inferSelect;

/**
 * An answer through the person's calendar provider, where one holds the event: the outcome, or
 * null to answer by mail. Both write the same ledger (`message_invitations.answer`), so never both.
 */
export type AnswerViaProvider = (ctx: ServiceContext, row: InvitationRow) => Promise<InvitationAnswerResult | null>;

export interface InvitationAnswerDeps {
  /** The send's own deps, as the send route builds them (`sendDepsOf`). */
  send: SendDeps;
  /** Absent: every answer goes by mail. Injected at the composition root by the calendar's own entry. */
  viaProvider?: AnswerViaProvider;
  /** Test seams; the process's singletons by default. */
  sends?: Pick<SendService, "send">;
  drafts?: Pick<DraftsService, "createOnce">;
  log?: Logger;
}

/** What the press came to, and the change a client drains past before it reads the field. */
export interface InvitationAnswerOutcome {
  result: InvitationAnswerResult;
  seq: number | null;
}

const ANSWERS: ReadonlySet<string> = new Set<InvitationAnswer>(["accepted", "tentative", "declined"]);
/** The reply's Subject and its one sentence: product words, never the letter's own. */
const SUBJECT: Readonly<Record<InvitationAnswer, string>> = { accepted: "Accepted", tentative: "Tentatively accepted", declined: "Declined" };
const SAID: Readonly<Record<InvitationAnswer, string>> = { accepted: "has accepted", tentative: "has tentatively accepted", declined: "has declined" };

const defaultLog = createLogger({ service: "send" });

function answerWord(raw: unknown, field: string): InvitationAnswer {
  if (typeof raw === "string" && ANSWERS.has(raw)) return raw as InvitationAnswer;
  throw new ServiceError("validation_failed", 400, `${field} must be accepted, tentative or declined`);
}

const notAnswerable = (why: string): ServiceError => new ServiceError("invitation_not_answerable", 422, why);
const cancelled = (): ServiceError => new ServiceError("invitation_cancelled", 409, "The organizer cancelled this event.");

/** The letter's row, the letter's conversation and its mailbox. Another account's letter, a deleted one, one without a row: the missing letter's 404. */
async function readInvitation(ctx: ServiceContext, messageId: string) {
  const db = bridgeTx(ctx.db);
  const [found] = await db.select({ row: messageInvitations, threadId: messages.threadId }).from(messageInvitations)
    .innerJoin(messages, and(eq(messages.id, messageInvitations.messageId), eq(messages.accountId, messageInvitations.accountId)))
    .where(and(eq(messageInvitations.accountId, ctx.accountId), eq(messageInvitations.messageId, messageId), isNull(messages.deletedAt)))
    .limit(1);
  if (found === undefined) throw new ServiceError("not_found", 404, "message not found");
  const [mailbox] = await db.select({ address: mailboxes.address, status: mailboxes.status }).from(mailboxes)
    .where(and(eq(mailboxes.id, found.row.mailboxId), eq(mailboxes.accountId, ctx.accountId))).limit(1);
  return { row: found.row, threadId: found.threadId, mailbox: mailbox ?? null };
}

/** The calendar part this row and press write, or null when it cannot be written exactly. */
function replyText(row: InvitationRow, answer: InvitationAnswer, stamp: Date): string | null {
  if (row.organizer === null || row.invitedAddress === null) return null;
  return invitationReplyText({
    uid: row.uid, recurrenceId: row.recurrenceId, sequence: row.sequence, startRaw: row.startRaw, startsAt: row.startsAt,
    organizer: row.organizer, invitedAddress: row.invitedAddress, answer, stamp,
  });
}

/**
 * WHY THIS INVITATION TAKES NO ANSWER FROM THIS MAILBOX, or null: a cancellation; a letter that asks
 * nothing (a reply, a counter-proposal) or the person's own event; an invitation that named another
 * address (forwarded, a list, an alias) or a mailbox whose address moved; no organizer to write to;
 * a later cancellation or revision from the same organizer; an occurrence the reply cannot name.
 */
async function refusalOf(
  ctx: ServiceContext, row: InvitationRow, address: string | null, answer: InvitationAnswer,
): Promise<ServiceError | null> {
  if (row.method === "CANCEL") return cancelled();
  if (row.method !== "REQUEST") return notAnswerable("This letter asks for no answer.");
  if (row.organizer === null) return notAnswerable("This invitation names no organizer to answer.");
  if (sameAddress(row.organizer, address)) return notAnswerable("This is your own event.");
  if (row.invitedAddress === null || !sameAddress(row.invitedAddress, address)) {
    return new ServiceError("invitation_not_invited", 422, "This invitation was sent to another address.");
  }
  const standing = await invitationStanding(bridgeTx(ctx.db), {
    accountId: ctx.accountId, mailboxId: row.mailboxId, uid: row.uid, recurrenceId: row.recurrenceId,
    sequence: row.sequence, organizer: row.organizer, stampedAt: row.stampedAt,
  });
  if (standing.cancelled) return cancelled();
  if (standing.replacedBy !== null) {
    return new ServiceError("invitation_replaced", 409, "A newer invitation replaced this one.", { messageId: standing.replacedBy });
  }
  if (replyText(row, answer, ctx.now()) === null) return notAnswerable("This invitation's occurrence cannot be answered by mail.");
  return null;
}

/**
 * THE ANSWER'S INSTANT, its reply's DTSTAMP, read in the transaction that makes its draft, under the
 * invitation row's lock: now, in whole seconds as DTSTAMP is written, and later than every answer
 * this letter has had, so an organizer takes each newer answer as newer. Two presses of different
 * answers at once meet on the lock, and the second is stamped after the first.
 */
async function nextStamp(ctx: ServiceContext, tx: Tx, messageId: string): Promise<Date> {
  const [held] = await dialect(ctx.db).forUpdate(tx.select({ answeredAt: messageInvitations.answeredAt }).from(messageInvitations)
    .where(and(eq(messageInvitations.accountId, ctx.accountId), eq(messageInvitations.messageId, messageId))).limit(1));
  // An answer's draft is a reply to the letter and forwards nothing.
  const [latest] = await tx.select({ at: drafts.createdAt }).from(drafts)
    .where(and(
      eq(drafts.accountId, ctx.accountId), eq(drafts.inReplyToMessageId, messageId), isNull(drafts.forwardOfMessageId),
      like(drafts.workflowDedupKey, `${INVITATION_ANSWER_MARK}%`),
    ))
    .orderBy(desc(drafts.createdAt)).limit(1);
  const second = (d: Date): number => Math.floor(d.getTime() / 1000) * 1000;
  let at = second(ctx.now());
  for (const before of [held?.answeredAt ?? null, latest?.at ?? null]) {
    if (before !== null && second(before) + 1000 > at) at = second(before) + 1000;
  }
  return new Date(at);
}

/**
 * THE ANSWER IS RECORDED, once its letter left: on this letter's row and on every living letter of
 * the same organizer asking the same of this mailbox, each with a message change; and this letter's
 * other answers that are still drafts go, with their changes. One transaction.
 */
async function recorded(
  ctx: ServiceContext, row: InvitationRow, answer: InvitationAnswer, draft: { id: string; createdAt: Date }, sent: SendResult | null,
): Promise<InvitationAnswerOutcome> {
  const seq = await withAccountTx(ctx, async (tx) => {
    const touched = await recordInvitationAnswer(bridgeTx(tx), {
      accountId: ctx.accountId, mailboxId: row.mailboxId, uid: row.uid, recurrenceId: row.recurrenceId,
      sequence: row.sequence, organizer: row.organizer, answer, at: draft.createdAt,
    });
    // Only this letter's other answers: replies that forward nothing, under the answer's mark.
    const stale = await tx.delete(drafts).where(and(
      eq(drafts.accountId, ctx.accountId), eq(drafts.inReplyToMessageId, row.messageId), isNull(drafts.forwardOfMessageId),
      eq(drafts.status, "draft"), isNull(drafts.sendKey), ne(drafts.id, draft.id), like(drafts.workflowDedupKey, `${INVITATION_ANSWER_MARK}%`),
    )).returning({ id: drafts.id });
    const seqs = await recordChanges(tx, [
      ...touched.map((id) => ({ accountId: ctx.accountId, entityType: "message" as const, entityId: id, op: "update" as const, meta: null })),
      ...stale.map((d) => ({ accountId: ctx.accountId, entityType: "draft" as const, entityId: d.id, op: "delete" as const, meta: null })),
    ]);
    return seqs.length === 0 ? null : Number(seqs[seqs.length - 1]);
  }, { mailboxId: row.mailboxId });
  const latest = Math.max(seq ?? 0, sent?.seq ?? 0);
  return {
    result: {
      status: sent === null ? "already" : "sent", answer, answeredAt: draft.createdAt.toISOString(),
      ...(sent?.sentCopy ? { sentCopy: sent.sentCopy } : {}),
    },
    seq: latest > 0 ? latest : null,
  };
}

/** A key a Cancel tombstoned (`POST /sends/withdraw`) sends nothing, and makes no draft either. */
async function refuseWithdrawnKey(ctx: ServiceContext, key: string): Promise<void> {
  const [held] = await bridgeTx(ctx.db).select({ status: outboundSends.status }).from(outboundSends)
    .where(and(eq(outboundSends.accountId, ctx.accountId), eq(outboundSends.idempotencyKey, key))).limit(1);
  if (held?.status === "withdrawn") throw new ServiceError("send_withdrawn", 409, SEND_WITHDRAWN_SENTENCE, undefined, false);
}

/** A draft some other press holds: what became of it. */
async function heldElsewhere(
  ctx: ServiceContext, row: InvitationRow, answer: InvitationAnswer, draft: { id: string; createdAt: Date },
): Promise<InvitationAnswerOutcome> {
  const [d] = await bridgeTx(ctx.db).select({ status: drafts.status }).from(drafts)
    .where(and(eq(drafts.id, draft.id), eq(drafts.accountId, ctx.accountId))).limit(1);
  if (d?.status === "sent") return recorded(ctx, row, answer, draft, null);
  return { result: { status: d?.status === "unverified" ? "unverified" : "in_flight", answer }, seq: null };
}

/** The steps of one press, after its words were read; see the module's header. */
async function answerOnce(
  ctx: ServiceContext, messageId: string, answer: InvitationAnswer, basis: InvitationAnswer | null, key: string,
  deps: InvitationAnswerDeps,
): Promise<InvitationAnswerOutcome> {
  const { row, threadId, mailbox } = await readInvitation(ctx, messageId);
  const refused = await refusalOf(ctx, row, mailbox?.address ?? null, answer);
  if (refused !== null) throw refused;
  if (row.answer === answer) {
    return { result: { status: "already", answer, ...(row.answeredAt ? { answeredAt: row.answeredAt.toISOString() } : {}) }, seq: null };
  }
  if ((row.answer ?? null) !== basis) {
    throw new ServiceError("invitation_answered_elsewhere", 409, "This invitation was answered elsewhere meanwhile.", { answer: row.answer });
  }
  if (mailbox?.status === "disabled") {
    throw new ServiceError("mailbox_disabled", 409, "This mailbox is disconnected and cannot send. Reconnect it, or pick another sender.");
  }
  if (deps.viaProvider !== undefined) {
    const taken = await deps.viaProvider(ctx, row);
    if (taken !== null) return { result: taken, seq: null };
  }
  await refuseWithdrawnKey(ctx, key);

  const draft = await (deps.drafts ?? draftsService).createOnce(ctx, {
    mailboxId: row.mailboxId, threadId, inReplyToMessageId: messageId, forwardOfMessageId: null, subject: SUBJECT[answer],
    body: `${mailbox!.address} ${SAID[answer]} this invitation.`, to: [{ name: null, address: row.organizer! }],
  }, invitationAnswerKey(ctx.accountId, messageId, answer, row.answeredAt), { createdAt: (tx) => nextStamp(ctx, tx, messageId) });
  if (draft.status === "sent" || draft.status === "sending" || draft.status === "unverified") {
    return heldElsewhere(ctx, row, answer, draft);
  }
  const text = replyText(row, answer, draft.createdAt);
  if (text === null) throw notAnswerable("This invitation's occurrence cannot be answered by mail.");

  let sent: SendResult;
  try {
    sent = await (deps.sends ?? sendService).send(ctx, draft.id, key, deps.send, {
      calendar: { method: "REPLY", text, messageId, mailboxId: row.mailboxId, to: row.organizer!, from: row.invitedAddress! },
    });
  } catch (err) {
    // Another press took the draft between this one's read and its reservation.
    if (err instanceof ServiceError && err.code === "conflict") return heldElsewhere(ctx, row, answer, draft);
    // The draft went with another answer recorded meanwhile.
    if (err instanceof ServiceError && err.code === "not_found") {
      const now = await readInvitation(ctx, messageId);
      throw new ServiceError("invitation_answered_elsewhere", 409, "This invitation was answered elsewhere meanwhile.", { answer: now.row.answer });
    }
    throw err;
  }
  // A key that already named another letter's send answers from that send: nothing of this one left.
  if (sent.draftId !== draft.id) {
    throw new ServiceError("conflict", 409, "This key belongs to another letter's send; nothing was sent for this answer.");
  }
  if (sent.status === "sent") return recorded(ctx, row, answer, draft, sent);
  return { result: { status: sent.status, answer }, seq: sent.status === "queued" || sent.status === "unverified" ? sent.seq : null };
}

/**
 * ANSWER AN INVITATION BY MAIL, on the person's press. One line per press in the log: the account,
 * the letter and the outcome's word, never an address or a UID.
 */
export async function answerInvitation(
  ctx: ServiceContext, press: InvitationPress, deps: InvitationAnswerDeps,
): Promise<InvitationAnswerOutcome> {
  const messageId = requireUuid(press.messageId, "messageId");
  const answer = answerWord(press.answer, "answer");
  const basis = press.basis === null ? null : answerWord(press.basis, "basis");
  const log = deps.log ?? defaultLog;
  try {
    const out = await answerOnce(ctx, messageId, answer, basis, press.key, deps);
    log.info("invitation_answer", { accountId: ctx.accountId, messageId, outcome: out.result.status });
    return out;
  } catch (err) {
    if (err instanceof ServiceError) log.info("invitation_answer", { accountId: ctx.accountId, messageId, outcome: err.code });
    throw err;
  }
}
