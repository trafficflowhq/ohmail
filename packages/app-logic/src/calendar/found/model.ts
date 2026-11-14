/**
 * FROM MAIL, as rows: the suggestions the mirror holds that the gate lets through, from today on, each with the event
 * Add would write and, where the same event already stands on a shown calendar, the way to it. Worked out on every
 * version and kept by nobody. No letter is read here: the words shown are the record's own text.
 */
import { eventTimeOf, momentOrUtc, type EventTime, type ZoneSource } from "@ohmail/cal-core";
import type { EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type {
  CalendarConnectionRecord,
  CalendarEventRecord,
  CalendarRecord,
  CalendarSuggestionRecord,
} from "@ohmail/wire";
import type { ListedRef } from "../invitations/index.js";
import { viewOnlyOf } from "../offers.js";
import { daySpanOf } from "../spans/days.js";
import type { FoundRow } from "./contract.js";
import { fieldsOf, timesOf } from "./fields.js";
import { mayOffer } from "./gate.js";

export interface FoundInput {
  readonly suggestions: readonly CalendarSuggestionRecord[];
  readonly events: readonly EventWithWrites[];
  readonly calendars: readonly CalendarRecord[];
  /** Today on the reader's clock, `YYYY-MM-DD`: nothing that starts before it is offered. */
  readonly todayKey: string;
  readonly zone: string;
  readonly zones: ZoneSource;
}

const titleKey = (title: string) => title.trim().toLowerCase();
const isDay = (t: EventTime) => t.kind === "date";

/** The same event on a shown calendar: the same title and the same start, both whole days or both timed. */
function alreadyOnOf(
  start: EventTime,
  title: string,
  day: string,
  events: readonly CalendarEventRecord[],
  zones: ZoneSource,
): ListedRef | null {
  const at = momentOrUtc(start, zones);
  for (const record of events) {
    const own = eventTimeOf(record.start);
    if (own === null || isDay(own) !== isDay(start) || titleKey(record.title) !== titleKey(title)) continue;
    if (momentOrUtc(own, zones) === at) return { event: record.id, occurrence: null, day };
  }
  return null;
}

export function foundOf(input: FoundInput): FoundRow[] {
  const shown = new Set(input.calendars.filter((c) => c.shown).map((c) => c.id));
  const standing = input.events
    .map((e) => e.record)
    .filter((r) => shown.has(r.calendarId) && !r.heldBack && r.status !== "cancelled");
  const rows: { row: FoundRow; at: number }[] = [];
  for (const s of input.suggestions) {
    if (!mayOffer(s)) continue;
    const times = timesOf(s, input.zones);
    const fields = fieldsOf(s, input.zones);
    const when = times === null ? null : daySpanOf(times, input.zone, input.zones);
    if (times === null || fields === null || when === null || when.first < input.todayKey) continue;
    rows.push({
      at: momentOrUtc(times.start, input.zones),
      row: {
        id: s.id,
        title: s.proposed.title,
        day: when.first,
        when,
        place: s.proposed.place,
        sourceWords: s.sourceWords,
        fields,
        alreadyOn: alreadyOnOf(times.start, s.proposed.title, when.first, standing, input.zones),
      },
    });
  }
  return rows
    .sort((a, b) => (a.row.day === b.row.day ? a.at - b.at : a.row.day < b.row.day ? -1 : 1))
    .map((r) => r.row);
}

/** How many offers wait to be added: the rail's count. */
export const foundCountOf = (rows: readonly FoundRow[]): number =>
  rows.filter((r) => r.alreadyOn === null).length;

/**
 * The calendar Add writes into, among the calendars that are shown and can be written, so what Add makes is read back
 * as on the calendar: the one the settings name for new events where it is one of them, else the first of them in the
 * order they are shown. None: nothing can be added, and Add is not drawn.
 */
export function targetCalendarOf(
  calendars: readonly CalendarRecord[],
  connections: ReadonlyMap<string, CalendarConnectionRecord>,
  preferred: string | null,
): CalendarRecord | null {
  const open = calendars.filter((c) => c.shown && !viewOnlyOf(c, connections.get(c.connectionId)));
  return open.find((c) => c.id === preferred) ?? open[0] ?? null;
}
