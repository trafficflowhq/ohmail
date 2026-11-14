/**
 * THE INVITATIONS, as three groups worked out from the occurrences the calendar shows and kept by nobody. An
 * invitation is an event the account was asked to: it carries the account's own answer and an organizer who is none
 * of the account's addresses. Held-back records and hidden calendars are already left out of the occurrences.
 */
import { momentOrUtc, type ZoneSource } from "@ohmail/cal-core";
import type { CalendarConnectionRecord } from "@ohmail/wire";
import { viewOnlyOf } from "../offers.js";
import { daySpanOf } from "../spans/days.js";
import type { ShownOccurrence } from "../window.js";
import type { InvitationRow } from "./contract.js";

export interface InvitationsInput {
  /** The occurrences from today to the last day the device holds. */
  readonly occurrences: readonly ShownOccurrence[];
  readonly connections: ReadonlyMap<string, CalendarConnectionRecord>;
  /** The account's own addresses: an event one of them organizes is no invitation. */
  readonly ownAddresses: readonly string[];
  /** Today on the reader's clock, `YYYY-MM-DD`. */
  readonly todayKey: string;
  readonly zone: string;
  readonly zones: ZoneSource;
}

export interface InvitationGroups {
  readonly toAnswer: readonly InvitationRow[];
  /** Cancelled by its organizer: struck, with no answer to give. */
  readonly changed: readonly InvitationRow[];
  readonly answered: readonly InvitationRow[];
  /** How many wait for an answer. */
  readonly waiting: number;
}

const ANSWERED = new Set(["accepted", "tentative", "declined"]);

function isInvitation(o: ShownOccurrence, own: ReadonlySet<string>): boolean {
  const { myAnswer, organizer } = o.record;
  return myAnswer !== null && organizer !== null && !own.has(organizer.address.trim().toLowerCase());
}

function rowOf(o: ShownOccurrence, input: InvitationsInput): InvitationRow {
  const { record, writes, calendar } = o;
  const connection = input.connections.get(calendar.connectionId);
  /* As the views name it: the series' event, and a changed day by the key our server stored. */
  const key = o.occurrence.source === "override" ? record.recurrenceId : o.key;
  return {
    ref: { event: (o.series ?? record).id, occurrence: key, day: o.day },
    recordId: record.id,
    title: record.title,
    day: o.day,
    organizer: record.organizer?.name || record.organizer?.address || "",
    calendarId: calendar.id,
    answer: record.myAnswer ?? "none",
    cancelled: record.status === "cancelled",
    waiting: writes.waiting,
    refusal: writes.refusal,
    refusedWriteId: writes.refusedWriteId,
    viewOnly: viewOnlyOf(calendar, connection),
    connectionStopped: connection !== undefined && connection.status !== "active",
    when: daySpanOf(o.occurrence, input.zone, input.zones),
    place: record.place,
  };
}

export function invitationsOf(input: InvitationsInput): InvitationGroups {
  const own = new Set(input.ownAddresses.map((a) => a.trim().toLowerCase()));
  const at = (o: ShownOccurrence) => momentOrUtc(o.occurrence.start, input.zones);
  const first = new Map<string, ShownOccurrence>();
  for (const o of input.occurrences) {
    if (o.day < input.todayKey || !isInvitation(o, own)) continue;
    const before = first.get(o.record.id);
    if (before === undefined || o.day < before.day || (o.day === before.day && at(o) < at(before)))
      first.set(o.record.id, o);
  }
  const rows = [...first.values()]
    .sort((a, b) => (a.day === b.day ? at(a) - at(b) : a.day < b.day ? -1 : 1))
    .map((o) => rowOf(o, input));
  const toAnswer = rows.filter((r) => !r.cancelled && r.answer === "none");
  return {
    toAnswer,
    changed: rows.filter((r) => r.cancelled),
    answered: rows.filter((r) => !r.cancelled && ANSWERED.has(r.answer)),
    waiting: toAnswer.length,
  };
}

/** The count the calendar's rail and its switch say. */
export const invitationCountOf = (groups: InvitationGroups): number => groups.waiting;
