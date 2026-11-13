/**
 * The four kinds of time a calendar writes (RFC 5545 section 3.3.4 and 3.3.5), kept apart by type so
 * that mixing them does not compile: a date is not an instant, and a clock time with no zone is not
 * a clock time in one.
 */

/** Clock fields as written. `month` is 1 to 12; `second` is kept (a card may drop it, a calendar may not). */
export interface Wall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** `VALUE=DATE`: a calendar day. It is the same day for every viewer and never becomes an instant. */
export interface PlainDate {
  readonly kind: "date";
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** The trailing-Z form: one moment, the same everywhere. */
export interface Instant {
  readonly kind: "instant";
  readonly epochMs: number;
}

/** A clock time in a named zone. `tzid` is the name as written, a vendor's prefix included. */
export interface ZonedTime {
  readonly kind: "zoned";
  readonly wall: Wall;
  readonly tzid: string;
}

/** A clock time with no zone: the same reading on every viewer's clock ("floating"). */
export interface FloatingTime {
  readonly kind: "floating";
  readonly wall: Wall;
}

export type EventTime = PlainDate | Instant | ZonedTime | FloatingTime;

/**
 * Where zone rules come from. Always handed in, never chosen here: the platform's database, a file's
 * own definitions, or one after the other (`time/zones`). An unknown zone answers `null`; nothing in
 * this package turns that into UTC.
 */
export interface ZoneSource {
  /**
   * The zone's distance east of UTC at this instant, in milliseconds, or `null` if the zone is not
   * known here. `left`, when the asker hands it in, is what working the answer out may cost: a
   * source that has to read a definition or follow its rules to answer takes those steps from it.
   */
  offsetAt(tzid: string, epochMs: number, left?: StepsLeft): number | null;
}

/**
 * The steps an asker has left, of its `limits.maxSteps`. A source whose answer takes work draws on
 * them. When they do not cover the work, the source takes what is left, marks the count `unpaid`,
 * answers `null` and remembers nothing: that `null` says nothing about the zone, and whatever the
 * asker was working out with it is dropped.
 */
export interface StepsLeft {
  steps: number;
  unpaid?: boolean;
}

export const plainDate = (year: number, month: number, day: number): PlainDate => ({ kind: "date", year, month, day });
export const instant = (epochMs: number): Instant => ({ kind: "instant", epochMs });
export const zoned = (wall: Wall, tzid: string): ZonedTime => ({ kind: "zoned", wall, tzid });
export const floating = (wall: Wall): FloatingTime => ({ kind: "floating", wall });
export const wall = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Wall => ({ year, month, day, hour, minute, second });
