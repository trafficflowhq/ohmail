/**
 * Days, months and clock times in the reader's language. A day is a civil date: it is written through
 * the platform's formatter at UTC midnight of that date, so no zone can move it to another day.
 */
import { dayNumberOf, monthOfDay, type DayId, type MonthId } from "./days.js";

const made = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string, options: Intl.DateTimeFormatOptions, zone = "UTC"): Intl.DateTimeFormat {
  const key = `${locale}|${zone}|${JSON.stringify(options)}`;
  let f = made.get(key);
  if (!f) {
    /* The product's English writes the day before the month: "Fri 20 Nov". */
    f = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : locale, { ...options, timeZone: zone });
    made.set(key, f);
  }
  return f;
}
const atNoon = (id: DayId): Date => new Date((dayNumberOf(id) ?? 0) * 86_400_000 + 43_200_000);

/** "Tuesday 10 November", "Dienstag, 10. November"; the year where it is not `thisYear`. */
export const dayLong = (id: DayId, locale: string, thisYear?: string): string =>
  formatter(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(thisYear && id.slice(0, 4) !== thisYear ? { year: "numeric" } : {}),
  }).format(atNoon(id));

/** "Fri 20 Nov", "Fr., 20. Nov."; the year where it is not `thisYear`. */
export const dayShort = (id: DayId, locale: string, thisYear?: string): string =>
  formatter(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(thisYear && id.slice(0, 4) !== thisYear ? { year: "numeric" } : {}),
  }).format(atNoon(id));

/** "1 Dec": a month's first day in a grid. */
export const dayAndMonth = (id: DayId, locale: string): string =>
  formatter(locale, { day: "numeric", month: "short" }).format(atNoon(id));

/** "November", or "November 2027" where the year is not `thisYear`. */
export const monthName = (m: MonthId, locale: string, thisYear?: string | null): string =>
  formatter(locale, {
    month: "long",
    ...(thisYear === null || (thisYear && m.slice(0, 4) !== thisYear) ? { year: "numeric" } : {}),
  }).format(atNoon(`${m}-01`));

/** The weekdays in the week's order: "Mon"…, or one letter each ("narrow"). */
export function weekdayNames(locale: string, weekStart: number, width: "short" | "narrow"): string[] {
  const f = formatter(locale, { weekday: width });
  /* 2024-01-01 was a Monday. */
  return Array.from({ length: 7 }, (_, i) =>
    f.format(new Date(Date.UTC(2024, 0, 1 + ((weekStart + i) % 7), 12))),
  );
}

/** Minutes after midnight on the clock: "09:00". */
export const clockTime = (minute: number, locale: string): string =>
  formatter(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(Date.UTC(2024, 0, 1, Math.floor(minute / 60) % 24, minute % 60)),
  );

/** A calendar day key and a clock reading for a notification in the calendar's zone. */
export const dayKeyAt = (atMs: number, zone: string): DayId => formatter("sv-SE", {}, zone).format(atMs);
export const clockTimeAt = (atMs: number, zone: string): string =>
  formatter("en-GB", { hour: "2-digit", minute: "2-digit" }, zone).format(atMs);

export const yearOf = (id: DayId): string => id.slice(0, 4);
export const sameMonth = (a: DayId, b: DayId): boolean => monthOfDay(a) === monthOfDay(b);

/** "10 May", "9 May 2027": a date in running text. */
export const dayDate = (id: DayId, locale: string, thisYear?: string): string =>
  formatter(locale, {
    day: "numeric",
    month: "long",
    ...(thisYear && id.slice(0, 4) !== thisYear ? { year: "numeric" } : {}),
  }).format(atNoon(id));

/** The dates at each end of a calendar week. */
export function weekTitle(
  first: DayId,
  last: DayId,
  locale: string,
  thisYear: string,
  short = false,
): string {
  return formatter(locale, {
    day: "numeric",
    month: short || monthOfDay(first) !== monthOfDay(last) ? "short" : "long",
    ...(yearOf(first) !== thisYear || yearOf(last) !== thisYear ? { year: "numeric" } : {}),
  })
    .formatRange(atNoon(first), atNoon(last))
    .replace(/\s*–\s*/g, " – ");
}
