/**
 * THE GRID'S OWN WRITING: a day's head in the reader's language, and a clock time as the hours write it (24 hours,
 * as the calendar's design does in both languages). A day is a date, so it is written in UTC: the reader's zone has
 * nothing to move on it.
 */
import { MS_PER_DAY, dayNumber, type PlainDate } from "@ohmail/cal-core";

export interface DayHead {
  /** The weekday in short. */
  readonly weekday: string;
  /** The date's number. */
  readonly date: string;
  /** The day said in full. */
  readonly label: string;
}

const heads = new Map<string, { short: Intl.DateTimeFormat; full: Intl.DateTimeFormat }>();

function formattersOf(locale: string): { short: Intl.DateTimeFormat; full: Intl.DateTimeFormat } {
  let held = heads.get(locale);
  if (held === undefined) {
    held = {
      short: new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }),
      full: new Intl.DateTimeFormat(locale, {
        timeZone: "UTC",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    };
    heads.set(locale, held);
  }
  return held;
}

export function dayHead(day: PlainDate, locale: string): DayHead {
  const at = dayNumber(day) * MS_PER_DAY;
  const f = formattersOf(locale);
  return { weekday: f.short.format(at), date: String(day.day), label: f.full.format(at) };
}

const two = (n: number): string => String(n).padStart(2, "0");

/** Minutes of the day as the hours write them: `07:00`, `24:00` for the day's end. */
export function clockOf(minutes: number): string {
  const whole = Math.max(0, Math.min(1440, Math.round(minutes)));
  return `${two(Math.floor(whole / 60))}:${two(whole % 60)}`;
}

/** One label for each hour line from `first` to `last`, both drawn. */
export function hourLabels(first: number, last: number): string[] {
  return Array.from({ length: last - first + 1 }, (_, i) => clockOf((first + i) * 60));
}
