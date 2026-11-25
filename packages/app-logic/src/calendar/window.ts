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
  eventTimeOf,
  keyTimeOf,
  momentOrUtc,
  occurrenceOf,
  storedTimeOf,
  recurrenceKeyString,
  MS_PER_DAY,
  type ExpansionStop,
  type Occurrence,
  type PlainDate,
  type ZoneSource,
} from "@ohmail/cal-core";
import { withCalendarFields, type EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type { CalendarEventRecord, CalendarRecord, CalendarWindow } from "@ohmail/wire";
import type { HeldSpan } from "./port.js";
import type { GridItem } from "./grid/place.js";
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
  readonly hiddenBusy: readonly GridItem[];
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

/** Explicit Hide belongs to one attendee copy, including its replaced occurrence. */
export function explicitlyHidden(
  record: CalendarEventRecord,
  series: CalendarEventRecord | null | undefined,
  key: string | null,
  access: CalendarRecord["access"] | undefined,
): boolean {
  if (access !== "owner" || !record.hideAttendee) return false;
  const hiddenAt = (source: CalendarEventRecord) =>
    source.hiddenOccurrences?.some((at) => at === "" || at === key) === true;
  return (
    hiddenAt(record) ||
    (!!series &&
      series.calendarId === record.calendarId &&
      series.uid === record.uid &&
      series.hideAttendee === record.hideAttendee &&
      series.organizer?.address === record.organizer?.address &&
      hiddenAt(series))
  );
}

export function occurrencesIn(input: OccurrenceInput): SpanOccurrences {
  const calendars = new Map(input.calendars.filter((c) => c.shown).map((c) => [c.id, c] as const));
  const held = input.events.filter((e) => !e.record.heldBack && calendars.has(e.record.calendarId));
  const drawn = withOccurrenceEdits(held, input.zones);
  const byRecord = new Map(drawn.map((e) => [e.record, e] as const));
  const made = seriesOfRecords(drawn.map((e) => e.record));
  const { startMs, endMs } = windowOf(input.query);
  const expansion = expandAll(made.series, { startMs, endMs, viewerZone: input.zone }, input.zones);
  const shown: ShownOccurrence[] = [];
  const hiddenBusy: GridItem[] = [];
  for (const occurrence of expansion.occurrences) {
    const record = made.recordOf(occurrence.event);
    const writes = record === undefined ? undefined : byRecord.get(record);
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
    if (explicitlyHidden(record, series, key, calendar.access)) {
      if (record.busy) hiddenBusy.push({ id: record.id, start, end: occurrence.end });
      continue;
    }
    if (
      (record.status === "cancelled" || record.myAnswer === "declined") &&
      [record, series].some((source) => source?.removedOccurrences?.some((at) => at === "" || at === key))
    )
      continue;
    if (
      series &&
      key !== null &&
      byRecord
        .get(series)
        ?.removals?.some(
          (scope) =>
            scope.kind === "record" ||
            scope.at === key ||
            (scope.kind === "following" && /^-?\d+$/.test(key) && Number(key) >= Number(scope.at)),
        )
    )
      continue;
    // An answer to this one day, made on the series' record: the day shows it while it waits, and its wait or refusal.
    const own = occurrence.source === "rule" ? writes.answers?.find((a) => a.at === key) : undefined;
    shown.push({
      occurrence,
      key,
      day: dayIdOfNumber(dayNumber(first)),
      record: own?.waiting ? { ...record, myAnswer: own.answer } : record,
      series,
      writes: own
        ? { ...writes, waiting: own.waiting, refusal: own.refusal, refusedWriteId: own.refusedWriteId }
        : writes,
      calendar,
    });
  }
  return { shown, hiddenBusy, capped: expansion.capped, stoppedBy: expansion.stoppedBy };
}

/** Lay queued edits over the same recurrence keys the provider uses for its confirmed overrides. */
function withOccurrenceEdits(held: EventWithWrites[], zones: ZoneSource): EventWithWrites[] {
  const changes: EventWithWrites[] = [];
  const replaced = new Set<CalendarEventRecord>();
  for (const master of held) {
    if (!master.occurrenceEdits?.length) continue;
    const { record } = master;
    const members = held.filter(
      ({ record: member }) =>
        member.calendarId === record.calendarId &&
        (record.uid === "" ? member.id === record.id : member.uid === record.uid),
    );
    const made = seriesOfRecords(members.map((member) => member.record));
    // Prefer the newest part of a split series that contains the original occurrence.
    const seriesByStart = made.series
      .map((series) => {
        const start = series.master?.start ?? null;
        return { series, start, at: start === null ? -Infinity : momentOrUtc(start, zones) };
      })
      .sort((a, b) => b.at - a.at);
    if (seriesByStart.length === 0) continue;
    const first = eventTimeOf(record.start);
    const byKey = new Map<string, EventWithWrites>();
    for (const edit of master.occurrenceEdits) {
      let day: Occurrence | null = null;
      for (const { series, start } of seriesByStart) {
        const key = keyTimeOf(edit.at, start ?? first);
        if (key !== null) day = occurrenceOf(series, key, zones);
        if (day !== null) break;
      }
      const source = day && made.recordOf(day.event);
      if (!day || !source) continue;
      if (source.recurrenceId === edit.at && !source.thisAndFuture) replaced.add(source);
      const prior = byKey.get(edit.at)?.record ?? {
        ...source,
        recurrenceId: edit.at,
        thisAndFuture: false,
        start: storedTimeOf(day.start),
        end: storedTimeOf(day.end),
        duration: null,
        repeat: null,
      };
      byKey.set(edit.at, {
        record: withCalendarFields(prior, edit.change),
        waiting: edit.waiting,
        refusal: null,
        refusedWriteId: null,
      });
    }
    changes.push(...byKey.values());
  }
  return changes.length ? [...held.filter(({ record }) => !replaced.has(record)), ...changes] : held;
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
