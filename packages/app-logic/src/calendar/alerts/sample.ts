/**
 * THE CALENDAR AS THE NOTICES' GATE COMPARES IT, AND WHAT THE GATE LOOKS UP TO NAME AN EVENT. The sample holds ids,
 * instants and closed words, never a title; the look is read only to make a notice the gate has decided on.
 *
 * Read from the presented calendar (the person's waiting writes laid over), so it is what the person sees. NEVER THE
 * PERSON'S OWN CHANGE: an event with a write of this device's that waits, or that the calendar has refused, keeps its
 * place in `invitations` as the sample before had it, and is left out of `standing` and `answers` until the write has
 * gone through. Left out, not carried: the provider's echo of the person's own move then meets no entry to compare
 * with, and the next real change is compared with the event as the echo left it.
 */
import { eventTimeOf, type ZoneSource } from "@ohmail/cal-core";
import type { CalendarLook, CalendarSample, CalendarStanding } from "@ohmail/client-engine";
import type { EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type {
  CalendarAnswer,
  CalendarEventRecord,
  CalendarRecord,
  CalendarSuggestionRecord,
} from "@ohmail/wire";
import { noticeClockOf, startMsOf } from "./ahead.js";

export interface CalendarSampleInput {
  /** The presented calendar: each event with this device's waiting writes laid over (`port.events()`). */
  readonly events: readonly EventWithWrites[];
  readonly calendars: readonly CalendarRecord[];
  /** What letters seem to propose, not yet decided. */
  readonly suggestions: readonly CalendarSuggestionRecord[];
  /** The account's own addresses: an event one of them organizes is the person's own. */
  readonly ownAddresses: readonly string[];
  /** The reader's zone, by its name: where a whole day or a clock with no zone starts. */
  readonly zone: string;
  readonly zones: ZoneSource;
}

/** The invitee answers a sample counts, in the order the gate names them: yes, maybe, no. */
const COUNTED: readonly CalendarAnswer[] = ["accepted", "tentative", "declined"];

const addressOf = (address: string): string => address.trim().toLowerCase();

function startOf(record: CalendarEventRecord, zone: string, zones: ZoneSource): number | null {
  const start = eventTimeOf(record.start);
  return start === null ? null : startMsOf(start, zone, zones);
}

/** The calendar's part of a notice sample, with `before` the sample the caller compared last (or `null`). */
export function calendarSampleOf(input: CalendarSampleInput, before: CalendarSample | null): CalendarSample {
  const own = new Set(input.ownAddresses.map(addressOf));
  const shown = new Set(input.calendars.filter((c) => c.shown === true).map((c) => c.id));
  const invitations = new Set<string>();
  const standing = new Map<string, CalendarStanding>();
  const answers = new Map<string, readonly [number, number, number]>();
  for (const { record, waiting } of input.events) {
    // An invitation not shown yet, and anything on a calendar that is not shown, is in none of the four.
    if (record.heldBack !== false || !shown.has(record.calendarId)) continue;
    const mine = waiting !== null || record.writes.length > 0;
    const organizer = record.organizer === null ? null : addressOf(record.organizer.address);
    if (record.myAnswer !== null && organizer !== null && !own.has(organizer)) {
      // Somebody else's event the person is in.
      const waits = record.myAnswer === "none" && record.status !== "cancelled";
      if (mine ? (before === null ? waits : before.invitations.has(record.id)) : waits)
        invitations.add(record.id);
      if (mine) continue;
      const startMs = startOf(record, input.zone, input.zones);
      if (startMs !== null) {
        const { kind, value } = record.start;
        const wall = kind === "date" || kind === "floating" ? { readerTime: { kind, value } } : {};
        standing.set(record.id, { startMs, status: record.status, ...wall });
      }
      continue;
    }
    const organizes = organizer === null ? record.myAnswer === null : own.has(organizer);
    const invitees = record.invitees.filter((i) => !own.has(addressOf(i.address)));
    if (mine || !organizes || invitees.length === 0) continue;
    const [yes, maybe, no] = COUNTED.map((answer) => invitees.filter((i) => i.answer === answer).length);
    answers.set(record.id, [yes!, maybe!, no!]);
  }
  return { invitations, standing, answers, found: new Set(input.suggestions.map((s) => s.id)) };
}

export interface CalendarLookInput {
  /** The presented calendar, as the sample read it. */
  readonly events: readonly EventWithWrites[];
  readonly suggestions: readonly CalendarSuggestionRecord[];
  readonly zone: string;
  readonly zones: ZoneSource;
  /** When the notice is drawn: what today and tomorrow are. */
  readonly nowMs: number;
}

/** What the gate looks up to make a calendar notice it has decided on. */
export function calendarLookOf(input: CalendarLookInput): CalendarLook {
  const events = new Map(input.events.map((e) => [e.record.id, e.record] as const));
  const proposed = new Map(input.suggestions.map((s) => [s.id, s] as const));
  return {
    event(id) {
      const r = events.get(id);
      if (r === undefined) return null;
      return {
        noticed: { id: r.id, title: r.title, private: r.private, heldBack: r.heldBack },
        allDay: r.start.kind === "date",
      };
    },
    found(id) {
      const s = proposed.get(id);
      const start = s === undefined ? null : eventTimeOf(s.proposed.start);
      return start === null ? null : startMsOf(start, input.zone, input.zones);
    },
    clock(startMs, readerTime) {
      if (readerTime === undefined) return noticeClockOf(startMs, input.nowMs, input.zone, input.zones);
      const wall = eventTimeOf(readerTime);
      const instant = wall === null ? null : startMsOf(wall, input.zone, input.zones);
      return instant === null ? null : noticeClockOf(instant, input.nowMs, input.zone, input.zones);
    },
  };
}
