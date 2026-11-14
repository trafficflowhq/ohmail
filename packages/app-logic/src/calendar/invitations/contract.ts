/**
 * THE INVITATIONS' ROW, as a type: what the list draws of one invitation. Worked out from the mirror on every version
 * and kept by nobody.
 */
import type { CalendarAnswer, CalendarReason, CalendarWriteFault } from "@ohmail/wire";
import type { DaySpan } from "../spans/days.js";

/** One event as a list names it: the event, the day of a series it stands for (null: not a series), and its day. */
export interface ListedRef {
  readonly event: string;
  readonly occurrence: string | null;
  readonly day: string;
}

/** One invitation, at its first occurrence from today on. */
export interface InvitationRow {
  /** As the views name it: the series' event, and a changed day by the key our server stored. */
  readonly ref: ListedRef;
  /** The record an answer names: a changed day's own record, else the event's. */
  readonly recordId: string;
  readonly title: string;
  /** Its first day on the reader's clock, `YYYY-MM-DD`. */
  readonly day: string;
  /** Who invites: the organizer's name, else the address. */
  readonly organizer: string;
  readonly calendarId: string;
  /** The account's own answer as the overlay lays it: `none` while it waits. */
  readonly answer: CalendarAnswer;
  /** Its organizer cancelled it. */
  readonly cancelled: boolean;
  /** Where an answer waits: on this device, or with the calendar. */
  readonly waiting: "device" | "provider" | null;
  readonly refusal: CalendarWriteFault | CalendarReason | null;
  /** The refused write that can be sent again or let go. */
  readonly refusedWriteId: string | null;
  /** Its calendar can be looked at and not answered from here. */
  readonly viewOnly: boolean;
  /** Its calendar's connection waits for the person (the reason it is view only, where it is). */
  readonly connectionStopped: boolean;
  /** Its days and hours on the reader's clock; null where its zone is not known here. */
  readonly when: DaySpan | null;
  readonly place: string | null;
}
