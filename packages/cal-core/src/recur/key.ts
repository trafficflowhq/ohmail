/**
 * The key of one occurrence of a series: what a changed occurrence names with its RECURRENCE-ID,
 * what a provider that hands over expanded days names as the original start, and what a store keeps
 * an occurrence under. One form for all of them, so that the same occurrence met twice is one.
 */
import { dayNumber, MS_PER_SECOND, resolveWall } from "../time/arith.js";
import type { EventTime, PlainDate, Wall, ZoneSource } from "../time/types.js";

const SECONDS_PER_DAY = 86_400;

/**
 * Which occurrence of a series: the moment it was first at, where that can be said; else the clock
 * time as written with its zone's name (empty for none); a day for a series of whole days.
 */
export type RecurrenceKey =
  | { readonly kind: "instant"; readonly epochMs: number }
  | { readonly kind: "wall"; readonly wall: Wall; readonly tzid: string }
  | { readonly kind: "date"; readonly date: PlainDate };

export function recurrenceKeyOf(t: EventTime, zones: ZoneSource): RecurrenceKey {
  switch (t.kind) {
    case "date":
      return { kind: "date", date: t };
    case "instant":
      return { kind: "instant", epochMs: t.epochMs };
    case "floating":
      return { kind: "wall", wall: t.wall, tzid: "" };
    case "zoned": {
      const epochMs = resolveWall(t.wall, t.tzid, zones);
      return epochMs === null ? { kind: "wall", wall: t.wall, tzid: t.tzid } : { kind: "instant", epochMs };
    }
  }
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * The key as a string to compare and to store. The same form the invitation card's reader gives a
 * RECURRENCE-ID: the milliseconds of the moment, or of a day's UTC midnight; else zone, clock time
 * to the minute (seconds only when there are any) and `false` for "not a whole day".
 */
export function recurrenceKeyString(key: RecurrenceKey): string {
  if (key.kind === "instant") return String(key.epochMs);
  if (key.kind === "date") return String(dayNumber(key.date) * SECONDS_PER_DAY * MS_PER_SECOND);
  const w = key.wall;
  return `${key.tzid}|${pad(w.year, 4)}${pad(w.month)}${pad(w.day)}T${pad(w.hour)}${pad(w.minute)}${w.second === 0 ? "" : pad(w.second)}|false`;
}
