/**
 * THE RESURFACE HORIZONS, for the reader's chooser: Tomorrow, Next week and a picked day, each at the chosen wall clock
 * in the reader's zone, and the wall clock each booked. Cut from the web shell's `format.ts` word for word, with the
 * zone an argument where that file asks the shell's active one: the same composition (`composeZonedWallClock`), the
 * same small-hours rule (`morningDayOffset`), the same floor for the day picker (`firstDayOffset`), the same 09:00
 * when nothing is stored. Storage is unchanged: `bubbleUpAt` stays a UTC instant.
 */
import {
  appointmentStamp,
  composeZonedWallClock,
  firstDayOffset,
  fullDateTime,
  morningDayOffset,
  zonedFields,
  zonedWeekday,
  type WallClockVerdict,
} from "@ohmail/client-engine";

/**
 * A HORIZON: the instant a resurface was booked for, and the wall clock it READS as. `time` comes off the instant,
 * never off the digits that were typed, so a surface labelled from it states the booking; `verdict` says whether
 * the two could differ.
 */
export interface ResurfaceHorizon {
  /** The instant to dispatch, as the UTC ISO string every `bubbleUpAt` is stored as. */
  iso: string;
  /** `'HH:MM'` where the reader is: what the chooser says, read back off `iso`. */
  time: string;
  verdict: WallClockVerdict;
}

/** THE PRODUCT'S HOUR when nobody has chosen one. Mirrors the server's `DEFAULT_RESURFACE_TIME`. */
export const DEFAULT_RESURFACE_TIME = "09:00";

/** `'HH:MM'`, 24-hour: the shape a stored resurface time has, the server's own. */
const RESURFACE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A stored or typed `'HH:MM'` as calendar fields, falling back to 09:00 for anything else. */
export function resurfaceClock(hhmm: string | null | undefined): { hour: number; minute: number } {
  const use = hhmm != null && RESURFACE_TIME_RE.test(hhmm) ? hhmm : DEFAULT_RESURFACE_TIME;
  return { hour: Number(use.slice(0, 2)), minute: Number(use.slice(3, 5)) };
}

/** A calendar day in `zone` at a chosen wall clock: the one place a horizon is composed. */
function clockOn(
  zone: string,
  year: number,
  month: number,
  day: number,
  at: string | null | undefined,
): ResurfaceHorizon {
  const { hour, minute } = resurfaceClock(at);
  const booked = composeZonedWallClock({ year, month, day, hour, minute }, zone);
  return {
    iso: booked.instant.toISOString(),
    time: `${pad(booked.hour)}:${pad(booked.minute)}`,
    verdict: booked.verdict,
  };
}

/** How many days forward from `base` the coming `weekday` is: never 0, so today is next week's. */
function daysUntil(base: Date, zone: string, weekday: number): number {
  const diff = (weekday - zonedWeekday(base, zone) + 7) % 7;
  return diff === 0 ? 7 : diff;
}

/** Tomorrow at `at` where the reader is; in the small hours it is the coming morning. */
export function tomorrowAtIn(base: Date, at: string | null | undefined, zone: string): ResurfaceHorizon {
  const f = zonedFields(base, zone);
  return clockOn(zone, f.year, f.month, f.day + morningDayOffset(base, zone, resurfaceClock(at)), at);
}

/** The first day `at` is still ahead (today or tomorrow): the day picker's floor. */
export function firstDayAtIn(base: Date, at: string | null | undefined, zone: string): ResurfaceHorizon {
  const f = zonedFields(base, zone);
  return clockOn(zone, f.year, f.month, f.day + firstDayOffset(base, zone, resurfaceClock(at)), at);
}

/** The coming Monday at that time, never "later today": a Monday resolves to the next one. */
export function nextWeekAtIn(base: Date, at: string | null | undefined, zone: string): ResurfaceHorizon {
  const f = zonedFields(base, zone);
  return clockOn(zone, f.year, f.month, f.day + daysUntil(base, zone, 1), at);
}

/** Resurface's Tomorrow and Next week; `nextWeek` is null when it is the same instant (a Sunday). */
export function resurfaceHorizonsIn(
  base: Date,
  at: string | null | undefined,
  zone: string,
): { tomorrow: ResurfaceHorizon; nextWeek: ResurfaceHorizon | null } {
  const tomorrow = tomorrowAtIn(base, at, zone);
  const nextWeek = nextWeekAtIn(base, at, zone);
  return { tomorrow, nextWeek: nextWeek.iso === tomorrow.iso ? null : nextWeek };
}

/** A picked calendar day (`YYYY-MM-DD`) at `at` where the reader is. */
export function dayAtIn(day: string, at: string | null | undefined, zone: string): ResurfaceHorizon {
  const picked = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  const f = picked
    ? { year: Number(picked[1]), month: Number(picked[2]), day: Number(picked[3]) }
    : zonedFields(new Date(day), zone);
  return clockOn(zone, f.year, f.month, f.day, at);
}

/** The calendar day (`YYYY-MM-DD`) an instant falls on in `zone`. */
export function dayValueIn(iso: string, zone: string): string {
  const f = zonedFields(new Date(iso), zone);
  return `${String(f.year).padStart(4, "0")}-${pad(f.month)}-${pad(f.day)}`;
}

/** A horizon as a sentence names it: `09:00` today, `Wed 09:00` inside the week, `16 Nov, 09:00` past it. */
export function horizonStamp(h: ResurfaceHorizon, now: Date, zone: string, locale: string): string {
  return appointmentStamp(new Date(h.iso), now, zone, locale);
}

/** A horizon named whole, as a day of a picker says it: `Fri 20 Nov 2026, 09:00`. */
export function horizonFull(h: ResurfaceHorizon, zone: string, locale: string): string {
  return fullDateTime(new Date(h.iso), zone, locale);
}
