/**
 * A length of time as a calendar writes it (RFC 5545 section 3.3.6): weeks and days are nominal
 * ("the duration of a week or a day depends on its position in the calendar"), hours, minutes and
 * seconds are exact, and "the number of days MUST be added first". A day across a clock change is
 * therefore 23 or 25 hours long, and twenty-four hours is not a day.
 */
import { addDays, MS_PER_SECOND, resolveWall, wallFromSeconds, wallIn, wallSeconds } from "./arith.js";
import type { EventTime, Wall, ZoneSource } from "./types.js";

export interface Duration {
  readonly negative: boolean;
  readonly weeks: number;
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
}

const SECONDS_PER_DAY = 86_400;

/** The nominal part in days, signed. */
export const nominalDays = (d: Duration): number => (d.negative ? -1 : 1) * (d.weeks * 7 + d.days);
/** The exact part in seconds, signed. */
export const exactSeconds = (d: Duration): number => (d.negative ? -1 : 1) * (d.hours * 3600 + d.minutes * 60 + d.seconds);

/** A whole number of seconds as a duration of days and clock time. */
export function durationOfSeconds(total: number): Duration {
  const abs = Math.abs(Math.trunc(total));
  return {
    negative: total < 0,
    weeks: 0,
    days: Math.floor(abs / SECONDS_PER_DAY),
    hours: Math.floor((abs % SECONDS_PER_DAY) / 3600),
    minutes: Math.floor((abs % 3600) / 60),
    seconds: abs % 60,
  };
}

const inRange = (w: Wall): boolean => w.year >= 1 && w.year <= 9999;

/** A clock reading moved by whole days and then by seconds, on the clock alone. */
export function shiftWall(w: Wall, days: number, seconds: number): Wall {
  return wallFromSeconds(wallSeconds(w) + days * SECONDS_PER_DAY + seconds);
}

/**
 * `t` plus `d`, in the kind `t` has. Days first, by the calendar; then the clock part as elapsed
 * time where the zone is known, so that an hour added before a clock change lands where a watch
 * would. A date takes the days alone. `null` when the result leaves the years 1 to 9999.
 */
export function addDuration(t: EventTime, d: Duration, zones: ZoneSource): EventTime | null {
  const days = nominalDays(d);
  const seconds = exactSeconds(d);
  if (!Number.isFinite(days) || !Number.isFinite(seconds)) return null;
  if (t.kind === "instant") {
    const epochMs = t.epochMs + (days * SECONDS_PER_DAY + seconds) * MS_PER_SECOND;
    return Math.abs(epochMs) <= 8.64e15 ? { kind: "instant", epochMs } : null;
  }
  if (t.kind === "date") {
    const moved = addDays(t, days + Math.trunc(seconds / SECONDS_PER_DAY));
    return moved.year >= 1 && moved.year <= 9999 ? moved : null;
  }
  const byDays = shiftWall(t.wall, days, 0);
  if (!inRange(byDays)) return null;
  if (t.kind === "floating" || seconds === 0) return finish(t, t.kind === "floating" ? shiftWall(byDays, 0, seconds) : byDays);
  const at = resolveWall(byDays, t.tzid, zones);
  const shown = at === null ? null : wallIn(at + seconds * MS_PER_SECOND, t.tzid, zones);
  return finish(t, shown ?? shiftWall(byDays, 0, seconds));
}

function finish(t: Exclude<EventTime, { kind: "instant" | "date" }>, w: Wall): EventTime | null {
  if (!inRange(w)) return null;
  return t.kind === "floating" ? { kind: "floating", wall: w } : { kind: "zoned", wall: w, tzid: t.tzid };
}
