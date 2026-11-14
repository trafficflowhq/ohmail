/**
 * THE CALENDAR BESIDE MAIL: the rest of today, for the Ohbox's blank reading column, and what comes up with one person,
 * for their card. Both read the occurrences the views draw (held-back records and hidden calendars already left
 * out), on the reader's clock; what has ended, was cancelled or was declined is not listed.
 */
import { daySpanOf, type DaySpan } from "../spans/days.js";
import { hueOf } from "../offers.js";
import type { ShownOccurrence } from "../window.js";
import type { ReaderNow, TodayRow } from "./contract.js";

interface Placed {
  readonly o: ShownOccurrence;
  readonly span: DaySpan;
}

/** Placed on the reader's days, neither cancelled nor declined; null where the zone cannot be read here. */
function placed(o: ShownOccurrence, now: ReaderNow): Placed | null {
  if (o.record.status === "cancelled" || o.record.myAnswer === "declined") return null;
  const span = daySpanOf(o.occurrence, now.zone, now.zones);
  return span === null ? null : { o, span };
}

/** Whether it is over by now: its end is today and not after this minute. */
function ended({ span }: Placed, now: ReaderNow): boolean {
  if (span.allDay || span.last > now.day) return false;
  if (span.last < now.day) return true;
  const end = span.endMinute ?? 0;
  return span.first === now.day && span.startMinute === end ? end < now.minute : end <= now.minute;
}

function rowOf(p: Placed, now: ReaderNow): TodayRow {
  const { o, span } = p;
  const startMinute = span.allDay || span.first < now.day ? null : span.startMinute;
  const begun =
    !span.allDay &&
    (span.first < now.day || (span.first === now.day && (span.startMinute ?? 0) <= now.minute));
  /* As the views name it: the series' event, and a changed day by the key our server stored. */
  const event = (o.series ?? o.record).id;
  const key = o.occurrence.source === "override" ? o.record.recurrenceId : o.key;
  return {
    id: key === null ? o.record.id : `${event}@${key}`,
    ref: { event, occurrence: key, day: o.day },
    title: o.calendar.access === "busy" ? null : o.record.title,
    hue: hueOf(o.calendar.color),
    day: span.first,
    startMinute,
    allDay: span.allDay,
    now: begun && !ended(p, now),
    toAnswer: o.record.myAnswer === "none",
  };
}

/** Whole days first, then by day and minute (one begun before today first), then by title. */
function earlier(a: TodayRow, b: TodayRow): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const am = a.startMinute ?? -1;
  const bm = b.startMinute ?? -1;
  if (am !== bm) return am - bm;
  return (a.title ?? "").localeCompare(b.title ?? "");
}

/** The rest of today: what stands on today and has not ended. */
export function todayRowsOf(occurrences: readonly ShownOccurrence[], now: ReaderNow): readonly TodayRow[] {
  return occurrences
    .map((o) => placed(o, now))
    .filter(
      (p): p is Placed => p !== null && p.span.first <= now.day && p.span.last >= now.day && !ended(p, now),
    )
    .map((p) => rowOf(p, now))
    .sort(earlier);
}

const named = (o: ShownOccurrence, address: string): boolean =>
  o.record.organizer?.address.toLowerCase() === address ||
  o.record.invitees.some((i) => i.address.toLowerCase() === address);

/** The next `most` events with one person (its organizer or an invitee) that have not ended. */
export function comingUpOf(
  occurrences: readonly ShownOccurrence[],
  address: string,
  most: number,
  now: ReaderNow,
): readonly TodayRow[] {
  const who = address.trim().toLowerCase();
  if (who === "") return [];
  return occurrences
    .filter((o) => named(o, who))
    .map((o) => placed(o, now))
    .filter((p): p is Placed => p !== null && p.span.last >= now.day && !ended(p, now))
    .map((p) => rowOf(p, now))
    .sort(earlier)
    .slice(0, most);
}
