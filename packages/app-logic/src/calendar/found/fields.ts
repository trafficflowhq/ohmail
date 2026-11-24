/**
 * THE EVENT AN OFFER MAKES, from the suggestion's proposed times. A whole day with no end lasts the day; a start with
 * no end lasts the default length, added by the calendar core's own arithmetic on the event's clock (a change of hour
 * is time passing, never a wall-clock sum). Nothing of the letter's words is written into the event.
 */
import {
  FOUND_DEFAULT_LENGTH_MINUTES,
  addDays,
  addDuration,
  eventTimeOf,
  storedTimeOf,
  type EventTime,
  type ZoneSource,
} from "@ohmail/cal-core";
import type { CalendarEventFields, CalendarSuggestionRecord, CalendarTime } from "@ohmail/wire";

const DEFAULT_LENGTH = {
  negative: false,
  weeks: 0,
  days: 0,
  hours: 0,
  minutes: FOUND_DEFAULT_LENGTH_MINUTES,
  seconds: 0,
} as const;

/** The start and the end the event is written with, as the core reads them; null where either cannot be read. */
export function timesOf(
  s: Pick<CalendarSuggestionRecord, "proposed">,
  zones: ZoneSource,
): { readonly start: EventTime; readonly end: EventTime } | null {
  const start = eventTimeOf(s.proposed.start);
  if (start === null) return null;
  if (s.proposed.end !== null) {
    const end = eventTimeOf(s.proposed.end);
    return end === null || (end.kind === "date") !== (start.kind === "date") ? null : { start, end };
  }
  const end = start.kind === "date" ? addDays(start, 1) : addDuration(start, DEFAULT_LENGTH, zones);
  return end === null ? null : { start, end };
}

const stored = (t: EventTime): CalendarTime => storedTimeOf(t);

export function fieldsOf(
  s: Pick<CalendarSuggestionRecord, "proposed">,
  zones: ZoneSource,
): CalendarEventFields | null {
  const times = timesOf(s, zones);
  if (times === null) return null;
  return {
    title: s.proposed.title,
    start: stored(times.start),
    end: stored(times.end),
    notes: null,
    place: s.proposed.place,
    callLink: null,
    busy: true,
    private: false,
    repeat: null,
    invitees: [],
    alarms: [],
  };
}
