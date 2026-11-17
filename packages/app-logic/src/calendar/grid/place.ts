/**
 * WHERE AN EVENT STANDS IN A DAY'S HOURS: by the minutes the reader's clock shows, never by the time that passes. On
 * the night the clocks go forward an event from 01:00 to 04:00 stands from 01:00 to 04:00 though two hours pass; on
 * the night they go back it stands from 01:00 to 04:00 though four pass. A grid of 24 hours has a line for each hour
 * the clock shows, and an event sits on the lines its own times name.
 *
 * A whole-day event (a date, not a time) goes to the lane above the hours (`all-day.ts`); a timed event that runs
 * past midnight stands in each day it touches, cut at the day's edges. A time whose zone is not known here cannot be
 * placed: it is handed back as unplaced, never put at a guessed hour.
 */
import {
  MS_PER_SECOND,
  dayNumber,
  instantOf,
  wallIn,
  wallSeconds,
  type EventTime,
  type PlainDate,
  type ZoneSource,
} from "@ohmail/cal-core";

/** What a grid places: anything with an id and its two times (the end exclusive, as a calendar writes it). */
export interface GridItem {
  readonly id: string;
  readonly start: EventTime;
  readonly end: EventTime;
}

export const MINUTES_PER_DAY = 1440;
const SECONDS_PER_MINUTE = 60;

/** A time as the reader's clock shows it, in minutes on one scale for every day (the wall read as UTC), and its moment where it has one. */
interface Reading {
  readonly wallMinutes: number;
  readonly epochMs: number | null;
}

function readingOf(t: EventTime, zone: string, zones: ZoneSource): Reading | null {
  if (t.kind === "date") return null;
  if (t.kind === "floating") return { wallMinutes: wallSeconds(t.wall) / SECONDS_PER_MINUTE, epochMs: null };
  const at = instantOf(t, zones);
  if (at === null) return null;
  const shown = wallIn(at.epochMs, zone, zones);
  return shown === null
    ? null
    : { wallMinutes: Math.floor(wallSeconds(shown) / SECONDS_PER_MINUTE), epochMs: at.epochMs };
}

/** A timed event's span on the reader's clock, in wall minutes on the one scale; `null` when it cannot be read here. */
export function wallSpanOf(
  item: GridItem,
  zone: string,
  zones: ZoneSource,
): { from: number; to: number } | null {
  const a = readingOf(item.start, zone, zones);
  const z = readingOf(item.end, zone, zones);
  if (a === null || z === null) return null;
  if (z.wallMinutes > a.wallMinutes) return { from: a.wallMinutes, to: z.wallMinutes };
  /* The clock went back inside the event (02:30 summer time to 02:15 winter time): the end's reading is not after the
     start's, so the event stands from its start for as long as it lasts. */
  const lasts =
    a.epochMs !== null && z.epochMs !== null
      ? Math.max(0, (z.epochMs - a.epochMs) / (SECONDS_PER_MINUTE * MS_PER_SECOND))
      : 0;
  return { from: a.wallMinutes, to: a.wallMinutes + lasts };
}

/** One event's part in one day: from and to in minutes of that day (0 to 1440), and whether it goes on before or after. */
export interface Segment<T extends GridItem = GridItem> {
  readonly item: T;
  readonly from: number;
  readonly to: number;
  /** It began on an earlier day. */
  readonly before: boolean;
  /** It goes on into a later day. */
  readonly after: boolean;
}

export interface PlacedDays<T extends GridItem> {
  /** One list a day, in the order of the days handed in; each list in order of start, the longer first. */
  readonly timed: readonly (readonly Segment<T>[])[];
  /** Whole-day events: the lane's to place. */
  readonly allDay: readonly T[];
  /** Timed events whose zone is not known here: said, never drawn at a guessed hour. */
  readonly unplaced: readonly T[];
}

const bySpan = <T extends GridItem>(a: Segment<T>, b: Segment<T>): number =>
  a.from - b.from || b.to - a.to || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0);

/** Every item placed on the days handed in. */
export function placeDays<T extends GridItem>(
  items: readonly T[],
  days: readonly PlainDate[],
  zone: string,
  zones: ZoneSource,
): PlacedDays<T> {
  const timed: Segment<T>[][] = days.map(() => []);
  const allDay: T[] = [];
  const unplaced: T[] = [];
  const firsts = days.map((d) => dayNumber(d) * MINUTES_PER_DAY);
  for (const item of items) {
    if (item.start.kind === "date") {
      allDay.push(item);
      continue;
    }
    const span = wallSpanOf(item, zone, zones);
    if (span === null) {
      unplaced.push(item);
      continue;
    }
    firsts.forEach((first, i) => {
      const last = first + MINUTES_PER_DAY;
      // In the day: it starts inside it, or began before and has not ended; an event of no length stands at its start.
      const inside =
        span.to > span.from ? span.from < last && span.to > first : span.from >= first && span.from < last;
      if (!inside) return;
      timed[i]!.push({
        item,
        from: Math.max(span.from, first) - first,
        to: Math.min(span.to, last) - first,
        before: span.from < first,
        after: span.to > last,
      });
    });
  }
  for (const list of timed) list.sort(bySpan);
  return { timed, allDay, unplaced };
}
