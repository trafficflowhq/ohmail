/**
 * The working parts of a series' expansion that know nothing of a window or an allowance: the clock
 * a time is counted on, a time moved on it, how long an event lasts and where an occurrence of it
 * ends, and whether a rule's end has been passed. An expansion is their one user (`recur/series`, `recur/pass`).
 */
import type { CalEvent } from "../ical/event.js";
import { addDays, dayNumber, MS_PER_DAY, MS_PER_SECOND, resolveWall, wallFromSeconds, wallIn, wallSeconds } from "../time/arith.js";
import { addDuration, exactSeconds, nominalDays, shiftWall, type Duration } from "../time/duration.js";
import type { EventTime, Wall, ZoneSource } from "../time/types.js";
import type { Until } from "./rrule.js";

const SECONDS_PER_DAY = 86_400;

/** UTC-12 to UTC+14: how far an instant can lie from a clock reading whose zone is not known. */
export const UNKNOWN_ZONE_BEHIND_MS = 14 * 3_600_000;
export const UNKNOWN_ZONE_AHEAD_MS = 12 * 3_600_000;
/** The most two clock readings can differ by being written in two zones: UTC-12 against UTC+14. */
const ZONES_APART_SECONDS = 26 * 3600;

export type Length =
  | { readonly kind: "none" }
  | { readonly kind: "days"; readonly days: number }
  | { readonly kind: "exact"; readonly ms: number }
  | { readonly kind: "wall"; readonly seconds: number }
  | { readonly kind: "nominal"; readonly duration: Duration };

export const momentOf = (t: EventTime, zones: ZoneSource): number | null => (t.kind === "instant" ? t.epochMs : t.kind === "zoned" ? resolveWall(t.wall, t.tzid, zones) : null);

/** The clock reading a time is counted on: its own, UTC's for an instant, midnight for a day. */
export const clockOf = (t: EventTime): Wall =>
  t.kind === "instant" ? wallFromSeconds(Math.floor(t.epochMs / MS_PER_SECOND)) : t.kind === "date" ? { year: t.year, month: t.month, day: t.day, hour: 0, minute: 0, second: 0 } : t.wall;
export const clockSeconds = (t: EventTime): number => wallSeconds(clockOf(t));

/** A time of the same kind (and zone) as `like`, at this clock reading. */
export function atClock(like: EventTime, w: Wall): EventTime {
  switch (like.kind) {
    case "date":
      return { kind: "date", year: w.year, month: w.month, day: w.day };
    case "instant":
      return { kind: "instant", epochMs: wallSeconds(w) * MS_PER_SECOND };
    case "floating":
      return { kind: "floating", wall: w };
    case "zoned":
      return { kind: "zoned", wall: w, tzid: like.tzid };
  }
}

/** A time moved by so many seconds on its own clock; a day by the whole days in them. */
export function shifted(t: EventTime, seconds: number): EventTime {
  if (seconds === 0) return t;
  if (t.kind === "instant") return { kind: "instant", epochMs: t.epochMs + seconds * MS_PER_SECOND };
  if (t.kind === "date") return addDays(t, Math.trunc(seconds / SECONDS_PER_DAY));
  return { ...t, wall: shiftWall(t.wall, 0, seconds) };
}

/**
 * How long an event lasts, in the way it says so (RFC 5545 section 3.8.5.3): an end gives "the same
 * exact duration" to every instance, a DURATION "the same nominal duration"; whole days count days;
 * a date with neither is one day, a clock time with neither has no length (section 3.6.1).
 */
export function lengthOf(e: CalEvent, zones: ZoneSource): Length {
  const start = e.start;
  if (start === null) return { kind: "none" };
  const end = e.end;
  if (end !== null) {
    if (start.kind === "date" && end.kind === "date") return { kind: "days", days: Math.max(0, dayNumber(end) - dayNumber(start)) };
    if (start.kind === "date" || end.kind === "date") return { kind: "none" };
    const [a, b] = [momentOf(start, zones), momentOf(end, zones)];
    if (a !== null && b !== null) return { kind: "exact", ms: Math.max(0, b - a) };
    if (start.kind !== "instant" && end.kind !== "instant") return { kind: "wall", seconds: Math.max(0, wallSeconds(end.wall) - wallSeconds(start.wall)) };
    return { kind: "none" };
  }
  if (e.duration !== null && !e.duration.negative) return { kind: "nominal", duration: e.duration };
  return start.kind === "date" ? { kind: "days", days: 1 } : { kind: "none" };
}

/**
 * No shorter than the event lasts, from its clock readings alone and without a question to the
 * zone: what its end is written later than its start, and what two zones can add to that.
 */
export function reachOf(e: { readonly start: EventTime | null; readonly end: EventTime | null; readonly duration: Duration | null }): number {
  if (e.start === null) return 0;
  if (e.end !== null) return Math.max(0, clockSeconds(e.end) - clockSeconds(e.start)) + ZONES_APART_SECONDS;
  if (e.duration !== null && !e.duration.negative) return nominalDays(e.duration) * SECONDS_PER_DAY + exactSeconds(e.duration) + ZONES_APART_SECONDS;
  return e.start.kind === "date" ? SECONDS_PER_DAY : 0;
}

/** The end of an occurrence that starts at `start` and lasts `length`; `endLike` gives the zone an exact end is shown in. */
export function endOf(start: EventTime, length: Length, endLike: EventTime | null, zones: ZoneSource): EventTime {
  switch (length.kind) {
    case "none":
      return start;
    case "days":
      return start.kind === "date" ? addDays(start, length.days) : start;
    case "nominal":
      return addDuration(start, length.duration, zones) ?? start;
    case "wall":
      return start.kind === "floating" || start.kind === "zoned" ? { ...start, wall: shiftWall(start.wall, 0, length.seconds) } : start;
    case "exact": {
      const at = momentOf(start, zones);
      if (at === null) return start.kind === "floating" || start.kind === "zoned" ? { ...start, wall: shiftWall(start.wall, 0, Math.round(length.ms / MS_PER_SECOND)) } : start;
      const zone = endLike !== null && endLike.kind === "zoned" ? endLike.tzid : start.kind === "zoned" ? start.tzid : null;
      const shown = zone === null ? null : wallIn(at + length.ms, zone, zones);
      return shown !== null && zone !== null ? { kind: "zoned", wall: shown, tzid: zone } : { kind: "instant", epochMs: at + length.ms };
    }
  }
}

/**
 * Has a rule's end been passed? A day ends the rule with that day on the series' own clock; a moment
 * is a moment.
 *
 * A series of whole days ended by a moment is not the standard's form (the two "MUST have the same
 * value type") and is common all the same: a writer puts down the last day's midnight on its own
 * clock, in UTC, which east of UTC is the evening before. Nobody says which clock that was, so a day
 * is past only when its midnight could be on no clock at or before that moment: a writer's midnight
 * lies up to fourteen hours before the day's own in UTC. A writer that ends its rule on the last
 * second of the last day instead (23:59:59) is read as naming the midnight that day began with.
 * One day stays out of reach: a writer fourteen hours ahead of UTC cannot be told from one ten
 * hours behind, and is read as that one.
 */
export function pastUntil(until: Until | null, start: EventTime, w: Wall, zones: ZoneSource): boolean {
  if (until === null) return false;
  if (until.kind === "date") return dayNumber(w) > dayNumber(until);
  if (until.kind === "floating") return wallSeconds(w) > wallSeconds(until.wall);
  if (start.kind === "date") {
    const second = ((Math.floor(until.epochMs / MS_PER_SECOND) % 60) + 60) % 60;
    const lastMidnight = second === 59 ? until.epochMs + MS_PER_SECOND - MS_PER_DAY : until.epochMs;
    return dayNumber(w) * MS_PER_DAY - UNKNOWN_ZONE_BEHIND_MS >= lastMidnight;
  }
  return (momentOf(start, zones) ?? wallSeconds(w) * MS_PER_SECOND) > until.epochMs;
}
