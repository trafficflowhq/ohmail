/**
 * THE DAYS A TIME GRID SHOWS, AND NOW ON THEM. A day is a calendar date; which days a week holds is counted from the
 * week's first day, and now is read on the reader's clock in the reader's zone. Nothing here asks `Date`'s getters
 * or the browser's zone: the zone is handed in by name and its rules come from the source handed in.
 */
import {
  addDays,
  civilFromDays,
  dayNumber,
  isValidDate,
  plainDate,
  wallIn,
  weekdayOf,
  type PlainDate,
  type ZoneSource,
} from "@ohmail/cal-core";

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` as a day, or `null` for anything that is no real date. */
export function dayOfIso(text: string | null | undefined): PlainDate | null {
  const m = text == null ? null : ISO_DAY.exec(text);
  if (m === null) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return isValidDate(year, month, day) ? plainDate(year, month, day) : null;
}

const two = (n: number): string => String(n).padStart(2, "0");

/** A day written `YYYY-MM-DD`: the app's own name for it (an address's anchor, a column's id). */
export const isoOfDay = (d: PlainDate): string =>
  `${String(d.year).padStart(4, "0")}-${two(d.month)}-${two(d.day)}`;

export const sameDay = (a: PlainDate, b: PlainDate): boolean => dayNumber(a) === dayNumber(b);

/** The weekday of a day, Monday 0 to Sunday 6. */
export const weekdayOfDay = (d: PlainDate): number => weekdayOf(dayNumber(d));

/**
 * The days of the week a day stands in: `count` days from the week's first day (`weekStart`, Monday 0). Seven for a
 * week; a narrower room may ask for fewer, still counted from the week's first day.
 */
export function weekDays(anchor: PlainDate, weekStart: number, count = 7): PlainDate[] {
  const first = dayNumber(anchor) - ((weekdayOf(dayNumber(anchor)) - weekStart + 7) % 7);
  return Array.from({ length: count }, (_, i) => {
    const { year, month, day } = civilFromDays(first + i);
    return plainDate(year, month, day);
  });
}

/** The span a step moves by: a week moves seven days, a day one. */
export const stepDays = (anchor: PlainDate, days: number, by: 1 | -1): PlainDate =>
  addDays(anchor, days * by);

/** Now on the reader's clock: its day and its minutes of the day. `null` when the zone is not known here. */
export function nowIn(
  nowMs: number,
  zone: string,
  zones: ZoneSource,
): { day: PlainDate; minutes: number } | null {
  const shown = wallIn(nowMs, zone, zones);
  if (shown === null) return null;
  return { day: plainDate(shown.year, shown.month, shown.day), minutes: shown.hour * 60 + shown.minute };
}
