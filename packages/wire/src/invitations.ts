/**
 * AN INVITATION, AS MAIL: what a letter's calendar part said about its event (kept at ingest in
 * `message_invitations`, mail 0204) and the answer a person gives it by mail. The calendar's own
 * records are not here; this is the part of an invitation that ships with the calendar off.
 */
import type { CalendarTime } from "./calendar.js";
import type { ISODateTime } from "./base.js";
import type { SendAnswer } from "./routes.js";

/**
 * What the letter asks, as its calendar part's own METHOD line says it (RFC 5546). These methods
 * keep a row: a published event, or a calendar with no METHOD, is not an invitation. A REQUEST whose
 * event says `STATUS:CANCELLED` is kept as a CANCEL.
 */
export type InvitationMethod = "REQUEST" | "REPLY" | "CANCEL" | "COUNTER" | "DECLINECOUNTER";

export interface InvitationProposalTimes {
  start: CalendarTime;
  end: CalendarTime;
}

export interface InvitationProposal extends InvitationProposalTimes {
  attendee: string;
}

/** An answer to an invitation: the three a calendar takes from an invitee. */
export type InvitationAnswer = "accepted" | "tentative" | "declined";

/**
 * THE INVITATION A LETTER CARRIES — `MessageDTO.invitation`. Present only on a letter that has a row
 * in `message_invitations`; ABSENT, never null, on every other letter and from a server older than
 * the field. No title, place or invitee list travels: the card reads those from the letter itself.
 */
export interface MessageInvitationDTO {
  method: InvitationMethod;
  /** Stable identity for a personal calendar copy of this invitation. */
  calendarEventId?: string;
  /** DTSTART of the closest earlier revision from the same organizer where it is on record. */
  previous?: { start: string | null; startsAt: ISODateTime | null };
  /** The interval proposed and the attendee named by this proposal or its refusal. */
  proposal?: InvitationProposal;
  /** The event's UID as the invitation wrote it. Compared, never drawn. */
  uid: string;
  /**
   * The occurrence it names, as the card's reader keys a RECURRENCE-ID (the instant's milliseconds,
   * else zone, clock time and day form); `""` for the whole series.
   */
  recurrenceId: string;
  /** The revision: SEQUENCE, 0 where the invitation wrote none. */
  sequence: number;
  /** DTSTART as written (a date, a clock time, or a clock time in UTC), or null where none was readable. */
  start: string | null;
  /** The instant the start means, where one can be told; null for a time in an unknown zone or none. */
  startsAt: ISODateTime | null;
  /** The organizer's address, only when it is one plain address. */
  organizer: string | null;
  /**
   * Which address of this mailbox the invitation named, as the invitation spelled it; null when it
   * named none (a forwarded invitation, a list). On a REPLY: set only on the person's own reply.
   * On a DECLINECOUNTER: the attendee named by the organizer's refusal.
   */
  invitedAddress: string | null;
  /**
   * On a REQUEST, the answer this mailbox has given on record; on a REPLY, the answer the letter
   * carries. Null for none.
   */
  answer: InvitationAnswer | null;
  /** When that answer was given, where one is on record. */
  answeredAt: ISODateTime | null;
}

/** `POST /messages/:id/invitation/answer` — the person's press. */
export interface InvitationAnswerBody {
  answer: InvitationAnswer;
  /** The answer the card showed when it was pressed (`MessageInvitationDTO.answer`); null for none. */
  basis: InvitationAnswer | null;
}

/**
 * What the press came to. `already`: the answer asked is the answer on record, and nothing was sent.
 * The other words are the send route's, as `SendAnswer.status` states them.
 */
export interface InvitationAnswerResult {
  status: "sent" | "already" | "unverified" | "queued" | "in_flight" | "failed";
  answer: InvitationAnswer;
  answeredAt?: ISODateTime;
  message?: string;
  sentCopy?: SendAnswer["sentCopy"];
}

/**
 * The press as a device's queue carries it. A mail act (it ships with the calendar off); it joins
 * the queue's union with the card that presses it.
 */
export interface InvitationAnswerAct {
  kind: "invitation_answer";
  messageId: string;
  answer: InvitationAnswer;
  basis: InvitationAnswer | null;
}
