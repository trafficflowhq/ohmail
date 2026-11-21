/**
 * THE OCCURRENCES OF A SPAN OF DAYS, derived on every version from what the engine holds and never kept. The core
 * expands every series over one window; an invitation not yet shown and a calendar that is not shown are left out;
 * an expansion that stopped at a ceiling says so (`capped`), so a view never draws a short list as whole.
 */
import {
  civilFromDays,
  dateOf,
  dayNumber,
  expandAll,
  localDay,
  recurrenceKeyString,
  MS_PER_DAY,
  type ExpansionStop,
  type Occurrence,
  type PlainDate,
  type ZoneSource,
} from "@ohmail/cal-core";
import type { EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type { CalendarEventRecord, CalendarRecord, CalendarWindow } from "@ohmail/wire";
import type { HeldSpan } from "./port.js";
import { seriesOfRecords } from "./records.js";

export interface SpanQuery {
  /** The first and the last day of the span, both drawn. */
  readonly from: PlainDate;
  readonly to: PlainDate;
}

/** One occurrence on screen, with the record it stands for, the series' own record and its calendar. */
export interface ShownOccurrence {
  readonly occurrence: Occurrence;
  /** The occurrence's key string in its series; null for an event that does not repeat. */
  readonly key: string | null;
  /** Its first day on the reader's clock, `YYYY-MM-DD`: the day a view opens it at. */
  readonly day: string;
  /** The record the occurrence is drawn from: the series', or the changed day's. */
  readonly record: CalendarEventRecord;
  /** The series' own record where there is one (the event a write on the series names). */
  readonly series: CalendarEventRecord | null;
  /** What waits for the record, and why a write was refused. */
  readonly writes: EventWithWrites;
  readonly calendar: CalendarRecord;
}

export interface SpanOccurrences {
  readonly shown: readonly ShownOccurrence[];
  readonly capped: boolean;
  readonly stoppedBy: readonly ExpansionStop[];
}

export interface OccurrenceInput {
  readonly events: readonly EventWithWrites[];
  readonly calendars: readonly CalendarRecord[];
  readonly query: SpanQuery;
  /** The reader's zone: whole days and clock times without a zone are read in it. */
  readonly zone: string;
  readonly zones: ZoneSource;
}

/**
 * A span's window in milliseconds, wide enough for any zone: a day either side of the span's days read as UTC, so
 * no occurrence of a drawn day is left out by the reader's offset. A view places each one on its own days.
 */
export function windowOf(query: SpanQuery): { startMs: number; endMs: number } {
  return {
    startMs: (dayNumber(query.from) - 1) * MS_PER_DAY,
    endMs: (dayNumber(query.to) + 2) * MS_PER_DAY,
  };
}

export function occurrencesIn(input: OccurrenceInput): SpanOccurrences {
  const calendars = new Map(input.calendars.filter((c) => c.shown).map((c) => [c.id, c] as const));
  const held = input.events.filter((e) => !e.record.heldBack && calendars.has(e.record.calendarId));
  const byRecord = new Map(held.map((e) => [e.record.id, e] as const));
  const made = seriesOfRecords(held.map((e) => e.record));
  const { startMs, endMs } = windowOf(input.query);
  const expansion = expandAll(made.series, { startMs, endMs, viewerZone: input.zone }, input.zones);
  const shown: ShownOccurrence[] = [];
  for (const occurrence of expansion.occurrences) {
    const record = made.recordOf(occurrence.event);
    const writes = record === undefined ? undefined : byRecord.get(record.id);
    const calendar = record === undefined ? undefined : calendars.get(record.calendarId);
    if (record === undefined || writes === undefined || calendar === undefined) continue;
    /* A time in a zone this device does not know keeps the day its own clock writes: a view cannot place it in the
       hours, so it says it is not shown; it is never dropped unsaid. Only on a day of the span is it counted. */
    const start = occurrence.start;
    const known = localDay(start, input.zone, input.zones);
    const first = known ?? (start.kind === "zoned" ? dateOf(start.wall) : null);
    if (first === null) continue;
    if (
      known === null &&
      (dayNumber(first) < dayNumber(input.query.from) || dayNumber(first) > dayNumber(input.query.to))
    )
      continue;
    const series = made.masterOf(occurrence.event) ?? null;
    const key =
      occurrence.source === "single"
        ? null
        : occurrence.source === "override" && !record.thisAndFuture
          ? record.recurrenceId
          : recurrenceKeyString(occurrence.key);
    if (
      series &&
      key !== null &&
      byRecord
        .get(series.id)
        ?.removals?.some(
          (scope) =>
            scope.kind === "record" ||
            scope.at === key ||
            (scope.kind === "following" && /^-?\d+$/.test(key) && Number(key) >= Number(scope.at)),
        )
    )
      continue;
    shown.push({
      occurrence,
      key,
      day: dayIdOfNumber(dayNumber(first)),
      record,
      series,
      writes,
      calendar,
    });
  }
  return { shown, capped: expansion.capped, stoppedBy: expansion.stoppedBy };
}

/** The days before which, and after which, the device holds nothing: where a view offers Load earlier, and says so. */
export interface SpanEdge {
  /** The first day held, where days before it lie at the provider; null when the span starts inside what is held. */
  readonly earlier: string | null;
  /** The last day held, where days after it lie at the provider; null when the span ends inside what is held. */
  readonly later: string | null;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
/** A civil day by its number, written `YYYY-MM-DD`; it reads no zone. */
function dayIdOfNumber(days: number): string {
  const { year, month, day } = civilFromDays(days);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/**
 * Where the span meets the edges of what this device holds: the served window counted from today, its start widened
 * by every span loaded on purpose that reaches it. Compared with what is held, never with today alone.
 */
export function edgeOf(
  query: SpanQuery,
  held: { readonly window: CalendarWindow; readonly loaded: readonly HeldSpan[] },
  today: PlainDate,
): SpanEdge {
  let fromMs = (dayNumber(today) - held.window.daysBack) * MS_PER_DAY;
  for (const span of [...held.loaded].sort((a, b) => b.toMs - a.toMs))
    if (span.fromMs < fromMs && span.toMs >= fromMs - MS_PER_DAY) fromMs = span.fromMs;
  const spanFromMs = dayNumber(query.from) * MS_PER_DAY;
  const lastHeld = dayNumber(today) + held.window.daysAhead;
  return {
    earlier: spanFromMs < fromMs ? dayIdOfNumber(Math.floor(fromMs / MS_PER_DAY)) : null,
    later: dayNumber(query.to) > lastHeld ? dayIdOfNumber(lastHeld) : null,
  };
}
