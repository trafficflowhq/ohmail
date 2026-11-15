import { createHash } from "node:crypto";
import { sameAddress } from "@trafficflow/db";
import type { EmailAddress, OutboundCalendar } from "@trafficflow/core/mail";
import type { InvitationAnswer } from "@ohmail/wire";
import { ServiceError } from "./errors.js";

/**
 * AN ANSWER'S DRAFT. An answer to an invitation is a letter, and it leaves the way every letter
 * does: one `drafts` row sent by `SendService.send` under the press's key. The row is made once per
 * letter, answer and the answer on record before it, and is marked by its `workflow_dedup_key`.
 * The send path then holds three things where every envelope is built (`SendService.reserve`): a
 * marked draft leaves only with its calendar part, an unmarked one never with one, and a marked
 * one only while its envelope is still the invitation's.
 */

/** The mark an answer's draft carries in `drafts.workflow_dedup_key`. */
export const INVITATION_ANSWER_MARK = "invitation-answer:";

/**
 * THE ANSWER'S DRAFT KEY: one draft per account, letter, answer and the answer on record before
 * this one (`message_invitations.answered_at`, "0" for none). Two presses of one answer meet on one
 * draft; an answer given again after another was recorded is a new draft, and so a new letter.
 */
export function invitationAnswerKey(accountId: string, messageId: string, answer: InvitationAnswer, answeredBefore: Date | null): string {
  const named = JSON.stringify([accountId, messageId, answer, answeredBefore === null ? "0" : answeredBefore.toISOString()]);
  return INVITATION_ANSWER_MARK + createHash("sha256").update(named, "utf8").digest("hex");
}

export function isInvitationAnswerDraft(d: { workflowDedupKey: string | null }): boolean {
  return d.workflowDedupKey !== null && d.workflowDedupKey.startsWith(INVITATION_ANSWER_MARK);
}

/**
 * What the answer's service hands the send beside the draft: the calendar part, and the envelope it
 * was written for, read from the invitation's row.
 */
export interface AnswerCalendar extends OutboundCalendar {
  /** The letter the draft answers. */
  messageId: string;
  /** The mailbox the invitation was read in, which sends the answer. */
  mailboxId: string;
  /** The organizer's address: the draft's one recipient. */
  to: string;
  /** The address that was invited: the sending mailbox's own. */
  from: string;
}

/** The draft fields the envelope check reads. */
export interface AnswerDraftFields {
  workflowDedupKey: string | null;
  mailboxId: string;
  inReplyToMessageId: string | null;
  forwardOfMessageId: string | null;
  to: unknown;
  cc: unknown;
  bcc: unknown;
  sendAt: Date | null;
}

const NOT_ANSWERABLE = "This answer can no longer be sent as it was made. Answer the invitation again.";

/**
 * WHY THIS DRAFT MAY NOT LEAVE AS ASKED, or null. Every other letter: null. An answer's draft sent
 * without its calendar part (the plain send route, Send again, a schedule): refused. A calendar
 * part on any other draft: refused. An answer whose draft no longer names exactly the organizer, no
 * one else, from the invited mailbox, now: refused, so a patched draft never carries an answer.
 */
export function answerEnvelopeRefusal(
  d: AnswerDraftFields, mailboxAddress: string | null | undefined, calendar: AnswerCalendar | undefined,
): ServiceError | null {
  const marked = isInvitationAnswerDraft(d);
  if (!marked && calendar === undefined) return null;
  if (!marked) return new ServiceError("validation_failed", 400, "a calendar part is sent only with an invitation's answer");
  if (calendar === undefined) return new ServiceError("invitation_not_answerable", 422, "An invitation's answer is sent from the invitation.");
  const to = (d.to as EmailAddress[] | null) ?? [];
  const copied = ((d.cc as EmailAddress[] | null) ?? []).length + ((d.bcc as EmailAddress[] | null) ?? []).length;
  const one = to.length === 1 && to[0]!.address === calendar.to && (to[0]!.name ?? "") === "";
  if (!one || copied > 0 || d.sendAt !== null || d.forwardOfMessageId !== null
    || d.inReplyToMessageId !== calendar.messageId || d.mailboxId !== calendar.mailboxId) {
    return new ServiceError("invitation_not_answerable", 422, NOT_ANSWERABLE);
  }
  if (!sameAddress(mailboxAddress, calendar.from)) {
    return new ServiceError("invitation_not_invited", 422, "This mailbox's address is not the one the invitation named.");
  }
  return null;
}

/** RFC 5322's longest line: no Message-ID a thread header names is longer. */
const MESSAGE_ID_MAX_CHARS = 998;

/** A Message-ID as a plain token: printable ASCII, no space and no angle bracket, one `@`. */
function plainMessageId(id: string): boolean {
  if (id.length === 0 || id.length > MESSAGE_ID_MAX_CHARS) return false;
  let ats = 0;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c <= 0x20 || c >= 0x7f || c === 0x3c || c === 0x3e) return false;
    if (c === 0x40) ats++;
  }
  return ats === 1;
}

/**
 * THE THREAD HEADERS AN ANSWER CARRIES. In-Reply-To and References name the letter and its
 * conversation's first letter by their Message-IDs, which their senders wrote: an answer names them
 * only when each is a plain token, else neither (the answer then starts no thread of its own on the
 * organizer's side, and is filed by its calendar part). Every other letter: as it always was.
 */
export function threadHeadersFit(calendar: AnswerCalendar | undefined, inReplyTo: string, references: string | undefined): boolean {
  if (calendar === undefined) return true;
  const chain = (references ?? inReplyTo).split(" ");
  return chain.length <= 2 && chain[chain.length - 1] === inReplyTo && chain.every(plainMessageId);
}
