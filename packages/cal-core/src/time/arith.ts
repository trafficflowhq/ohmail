/**
 * Calendar arithmetic on plain numbers: days, months, weekdays, week numbers, and the step from a
 * clock time in a zone to an instant and back. No `Date` and no platform call: the proleptic
 * Gregorian calendar is integer arithmetic, and a zone's offset is asked of the source handed in.
 */
import type { EventTime, FloatingTime, Instant, PlainDate, Wall, ZonedTime, ZoneSource } from "./types.js";

export const MS_PER_SECOND = 1000;
export const MS_PER_DAY = 86_400_000;
const SECONDS_PER_DAY = 86_400;

/** Weekdays in the order the week numbers below use: Monday is 0. */
export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
export const daysInYear = (year: number): number => (isLeapYear(year) ? 366 : 365);
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const daysInMonth = (year: number, month: number): number => (month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1]!);

/** Days since 1970-01-01 of a calendar date (negative before it). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The calendar date of a day number. */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** The weekday of a day number, Monday 0 to Sunday 6. 1970-01-01 was a Thursday. */
export const weekdayOf = (days: number): number => (((days + 3) % 7) + 7) % 7;

/** 1 for 1 January. */
export const dayOfYear = (year: number, month: number, day: number): number => daysFromCivil(year, month, day) - daysFromCivil(year, 1, 1) + 1;

export const isValidDate = (year: number, month: number, day: number): boolean =>
  Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day) && year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);

export const isValidWall = (w: Wall): boolean =>
  isValidDate(w.year, w.month, w.day) && w.hour >= 0 && w.hour <= 23 && w.minute >= 0 && w.minute <= 59 && w.second >= 0 && w.second <= 59;

/** A clock reading as seconds since the epoch, as if it were UTC. The package's one scale for comparing walls. */
export const wallSeconds = (w: Wall): number => daysFromCivil(w.year, w.month, w.day) * SECONDS_PER_DAY + w.hour * 3600 + w.minute * 60 + w.second;

export function wallFromSeconds(seconds: number): Wall {
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  const rest = seconds - days * SECONDS_PER_DAY;
  const { year, month, day } = civilFromDays(days);
  return { year, month, day, hour: Math.floor(rest / 3600), minute: Math.floor((rest % 3600) / 60), second: rest % 60 };
}

export const dateOf = (w: Wall): PlainDate => ({ kind: "date", year: w.year, month: w.month, day: w.day });

/** Are two times written the same: the same kind, the same fields, the same zone name? Nothing is resolved. */
export function sameTime(a: EventTime, b: EventTime): boolean {
  switch (a.kind) {
    case "date":
      return b.kind === "date" && a.year === b.year && a.month === b.month && a.day === b.day;
    case "instant":
      return b.kind === "instant" && a.epochMs === b.epochMs;
    case "floating":
      return b.kind === "floating" && wallSeconds(a.wall) === wallSeconds(b.wall);
    case "zoned":
      return b.kind === "zoned" && a.tzid === b.tzid && wallSeconds(a.wall) === wallSeconds(b.wall);
  }
}
export const dayNumber = (d: { year: number; month: number; day: number }): number => daysFromCivil(d.year, d.month, d.day);

export function addDays(d: PlainDate, n: number): PlainDate {
  const { year, month, day } = civilFromDays(dayNumber(d) + n);
  return { kind: "date", year, month, day };
}

/* ── week numbers (RFC 5545 section 3.3.10, ISO 8601 with a movable first day) ──────────────────── */

/** The day number on which week 1 of `year` begins: the first week, starting on `weekStart`, with four or more of its days in the year. */
export function weekOneStart(year: number, weekStart: number): number {
  const jan1 = daysFromCivil(year, 1, 1);
  const into = (weekdayOf(jan1) - weekStart + 7) % 7;
  return into <= 3 ? jan1 - into : jan1 - into + 7;
}

export const weeksInYear = (year: number, weekStart: number): number => (weekOneStart(year + 1, weekStart) - weekOneStart(year, weekStart)) / 7;

/** The week a day belongs to, and the year that week is counted in (which is not always the day's own). */
export function weekOf(days: number, weekStart: number): { weekYear: number; week: number } {
  const { year } = civilFromDays(days);
  if (days >= weekOneStart(year + 1, weekStart)) return { weekYear: year + 1, week: 1 };
  const start = weekOneStart(year, weekStart);
  if (days < start) return { weekYear: year - 1, week: Math.floor((days - weekOneStart(year - 1, weekStart)) / 7) + 1 };
  return { weekYear: year, week: Math.floor((days - start) / 7) + 1 };
}

/* ── a clock time in a zone, and an instant ─────────────────────────────────────────────────────── */

/**
 * How far either side of a clock reading the zone is asked for its offset. Offsets run from UTC-12
 * to UTC+14, so the true instant lies within a day of the reading taken as UTC.
 */
const PROBE_MS = MS_PER_DAY;

/**
 * The instant at which `w` is on the clock in `tzid`, or `null` when the source does not know the
 * zone. RFC 5545 section 3.3.5 for the two readings a clock change makes special: one the clock
 * shows twice is the first of the two; one the clock skips is read "using the UTC offset before the
 * gap".
 */
export function resolveWall(w: Wall, tzid: string, zones: ZoneSource): number | null {
  const local = wallSeconds(w) * MS_PER_SECOND;
  const before = zones.offsetAt(tzid, local - PROBE_MS);
  const after = zones.offsetAt(tzid, local + PROBE_MS);
  if (before === null || after === null) return null;
  if (before === after) return local - before;
  const early = local - before;
  const late = local - after;
  const earlyHolds = zones.offsetAt(tzid, early) === before;
  const lateHolds = zones.offsetAt(tzid, late) === after;
  if (earlyHolds && lateHolds) return Math.min(early, late);
  if (lateHolds) return late;
  return early; // it holds, or the reading was skipped: the offset before the gap either way
}

/** What the clock shows in `tzid` at an instant, or `null` when the zone is not known. */
export function wallIn(epochMs: number, tzid: string, zones: ZoneSource): Wall | null {
  const offset = zones.offsetAt(tzid, epochMs);
  return offset === null ? null : wallFromSeconds(Math.floor((epochMs + offset) / MS_PER_SECOND));
}

/** A time that names its moment, as that moment. A date or a zoneless clock time is not accepted: it has none. */
export function instantOf(t: Instant | ZonedTime, zones: ZoneSource): Instant | null {
  if (t.kind === "instant") return t;
  const epochMs = resolveWall(t.wall, t.tzid, zones);
  return epochMs === null ? null : { kind: "instant", epochMs };
}

/** A zoneless clock time as the moment it is for one viewer: read on the viewer's own clock (RFC 5545 section 3.3.5). */
export function instantOfFloating(t: FloatingTime, viewerZone: string, zones: ZoneSource): Instant | null {
  const epochMs = resolveWall(t.wall, viewerZone, zones);
  return epochMs === null ? null : { kind: "instant", epochMs };
}

/**
 * The day a person sees a time on. A date is its own day for everyone; a zoneless clock time is on
 * its written day for everyone; a moment falls on the day the viewer's clock shows then. `null`
 * when that cannot be said: the time's own zone, or the viewer's, is not known to the source.
 */
export function localDay(t: EventTime, viewerZone: string, zones: ZoneSource): PlainDate | null {
  if (t.kind === "date") return t;
  if (t.kind === "floating") return dateOf(t.wall);
  const at = instantOf(t, zones);
  if (at === null) return null;
  const shown = wallIn(at.epochMs, viewerZone, zones);
  return shown === null ? null : dateOf(shown);
}
