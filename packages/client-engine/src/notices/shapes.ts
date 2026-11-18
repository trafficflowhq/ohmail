/**
 * THE SHAPES A NOTICE'S VALUES HAVE: a whole number in its range, an instant, an id, an account's
 * scope, a time as numbers. The makers build from these and the closed readers hold to them, so
 * "an id" and "a count" mean one thing wherever a notice is made or read.
 */
import { NOTICE_COUNT_MAX, type Clock } from "./kinds.js";

/** The last instant a date can name, in milliseconds since the epoch. */
export const INSTANT_MAX_MS = 8_640_000_000_000_000;

export const whole = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

/** Milliseconds since the epoch: a whole number no date lies beyond. */
export const instant = (n: unknown): n is number => whole(n, 0, INSTANT_MAX_MS);

/** An id as the app's own stores mint them: short, and no character that could be read as words. */
export function idOf(id: unknown): string | null {
  return typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : null;
}

/**
 * An account's scope as a shell hands it in: the shape of the session's own marker. The demo's
 * word and a surface with no account have none, so nothing is ever set to ring for either.
 */
export function scopeOf(scope: unknown): string | null {
  return typeof scope === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(scope) ? scope : null;
}

/** `clock` rebuilt from numbers in their ranges, or `null`. Nothing of the object handed in is kept. */
export function clockOf(clock: Clock | null | undefined): Clock | null {
  if (typeof clock !== "object" || clock === null || !whole(clock.hour, 0, 23) || !whole(clock.minute, 0, 59)) return null;
  const { day } = clock;
  if (day === "today" || day === "tomorrow") return { hour: clock.hour, minute: clock.minute, day };
  if (typeof day !== "object" || day === null || !whole(day.month, 1, 12) || !whole(day.dom, 1, 31) || !whole(day.dow, 0, 6)) return null;
  return { hour: clock.hour, minute: clock.minute, day: { month: day.month, dom: day.dom, dow: day.dow } };
}

/** A count that may be nothing: a whole number from 0 to the largest a notice says. */
export const tally = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), NOTICE_COUNT_MAX) : 0);

/** The id of the alert for one start and one lead of an event: closed parts, so a moved start is another alert. */
export function aheadIdOf(eventId: string, startMs: number, leadMin: number): string {
  return `${eventId}.${startMs}.${leadMin}`;
}
