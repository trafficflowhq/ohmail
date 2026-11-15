/**
 * ONE STORED FORM FOR EVERY TIME, and the two ways across: from the calendar core's `EventTime` to
 * the triple a row and a record keep (`kind`, the core's text, the zone's name), and back. A writer
 * stores what this writes; a builder copies the triple untouched; only this file parses it.
 */
import {
  formatDate, formatInstant, formatWall, MS_PER_DAY, MS_PER_SECOND, parseDate, parseDateTime, resolveWall,
  wallSeconds, type EventTime, type Wall, type ZoneSource,
} from "@ohmail/cal-core";
import type { Assert, CalendarTime, Same } from "@ohmail/wire";

/** The wire declares its own kind words, since it imports nothing; they are the core's, exactly. */
type _SameKinds = Assert<Same<CalendarTime["kind"], EventTime["kind"]>>;

/** The stored triple of a time as the core reads it. */
export function storedTimeOf(t: EventTime): CalendarTime {
  switch (t.kind) {
    case "date": return { kind: "date", value: formatDate(t) };
    case "instant": return { kind: "instant", value: formatInstant(t.epochMs) };
    case "zoned": return { kind: "zoned", value: formatWall(t.wall), zone: t.tzid };
    case "floating": return { kind: "floating", value: formatWall(t.wall) };
  }
}

/** The core's time for a stored triple, or `null` for one no writer of this product wrote. */
export function eventTimeOf(t: CalendarTime): EventTime | null {
  if (t.kind === "date") return parseDate(t.value);
  const parsed = parseDateTime(t.value);
  if (parsed === null) return null;
  if (t.kind === "instant") return parsed.utc ? { kind: "instant", epochMs: wallSeconds(parsed.wall) * MS_PER_SECOND } : null;
  if (parsed.utc) return null;
  if (t.kind === "zoned") return typeof t.zone === "string" && t.zone !== "" ? { kind: "zoned", wall: parsed.wall, tzid: t.zone } : null;
  return { kind: "floating", wall: parsed.wall };
}

const wallAsUtc = (w: Wall): number => wallSeconds(w) * MS_PER_SECOND;

/**
 * The moment a time stands for: exact for an instant and for a clock time in a zone this host
 * knows; a day, a floating clock time or an unknown zone READ AS UTC. A range built from such a
 * reading is widened by {@link CALENDAR_RANGE_SLACK_MS} wherever it is asked.
 */
export function momentOrUtc(t: EventTime, zones: ZoneSource): number {
  switch (t.kind) {
    case "instant": return t.epochMs;
    case "date": return Date.UTC(t.year, t.month - 1, t.day);
    case "zoned": return resolveWall(t.wall, t.tzid, zones) ?? wallAsUtc(t.wall);
    case "floating": return wallAsUtc(t.wall);
  }
}

/** Whether {@link momentOrUtc} is exact for this time, or a UTC reading of a clock nobody named. */
export function isExactMoment(t: EventTime, zones: ZoneSource): boolean {
  return t.kind === "instant" || (t.kind === "zoned" && resolveWall(t.wall, t.tzid, zones) !== null);
}

/** The length of one whole day, which is what an event of days with no end lasts. */
export const DAY_MS = MS_PER_DAY;
