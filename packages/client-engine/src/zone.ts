/**
 * An instant, read as a wall clock in a named zone — and back again. Stored
 * dates stay UTC instants; a stamp on screen is read in the reader's zone:
 * the wall clock there ({@link zonedFields}), the calendar day there
 * ({@link zonedDayNumber}, {@link zonedWeekday}), and the inverse — what
 * UTC instant is 09:00 there ({@link zonedInstant}, {@link composeZonedWallClock}).
 * The inverse is not `utc + offset`: the offset depends on the instant being
 * minted, and on two nights a year a wall clock names no instant or two of
 * them, so the candidates are bracketed and read back. Intl ships IANA.
 */

/** An instant's wall-clock fields in some zone. `month` is 1-12; `hour` is 0-23. */
export interface ZonedFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * One formatter per zone. Constructing a `DateTimeFormat` is the expensive part and these are
 * called once per visible row.
 *
 * The locale is pinned to `en-US` and is not the caller's: nothing here renders WORDS. It reads
 * numbers back out of `formatToParts`, and a locale with non-Latin digits (`ar-EG`, `hi-IN-u-nu-deva`)
 * would make `Number(part.value)` return `NaN` — a silently wrong date rather than an error. The
 * reader's locale governs the day and month NAMES, which are minted by the callers of this file.
 */
const FIELD_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function fieldFormatter(zone: string): Intl.DateTimeFormat {
  let fmt = FIELD_FORMATTERS.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      /* h23, explicitly. `en-US` defaults to a 12-hour cycle, and the other way of asking for 24
         (`hour12: false`) resolves to h24 on some ICU builds — which renders midnight as "24" and
         would put an hour of every day on the wrong date. */
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FIELD_FORMATTERS.set(zone, fmt);
  }
  return fmt;
}

/**
 * The wall clock an instant shows in `zone`.
 *
 * Throws for an unknown zone (`Intl`'s own `RangeError`) and for an invalid instant, and both are
 * meant to be loud: a stamp that quietly falls back to UTC is the defect this file exists to fix.
 */
export function zonedFields(instant: Date, zone: string): ZonedFields {
  const parts = fieldFormatter(zone).formatToParts(instant);
  const read = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  const hour = read("hour");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    /* Belt and braces for the hour cycle above: an ICU build that answers 24 for midnight would
       otherwise print "24:10" and, worse, band that row against the wrong day. */
    hour: hour === 24 ? 0 : hour,
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * Whole days from the epoch to the instant's calendar date IN `zone` — the number that bands a
 * stamp.
 *
 * Subtracting two of these is the count of MIDNIGHTS between them as the reader crosses them, which
 * is what "today", "yesterday" and "this week" actually mean. The old code subtracted UTC midnights,
 * so for a reader east of UTC every message between the reader's midnight and UTC's read as
 * yesterday's, and for a reader west of it every message in the same window read as tomorrow's.
 */
export function zonedDayNumber(instant: Date, zone: string): number {
  const f = zonedFields(instant, zone);
  return Math.round(Date.UTC(f.year, f.month - 1, f.day) / 86_400_000);
}

/** The instant's weekday in `zone`, `0` = Sunday — the same numbering as `Date#getUTCDay`. */
export function zonedWeekday(instant: Date, zone: string): number {
  const f = zonedFields(instant, zone);
  return new Date(Date.UTC(f.year, f.month - 1, f.day)).getUTCDay();
}

/** How far `zone` is ahead of UTC at `utcMs`, in milliseconds. */
function offsetAt(utcMs: number, zone: string): number {
  /* Floored to the second because `formatToParts` cannot report milliseconds: comparing a
     sub-second instant against a whole-second reading would report an offset up to 999 ms out. */
  const whole = Math.floor(utcMs / 1000) * 1000;
  const f = zonedFields(new Date(whole), zone);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - whole;
}

/** A wall clock to mint an instant from. Out-of-range fields normalize, as `Date.UTC` does. */
export interface ZonedWallClock {
  year: number;
  /** 1-12. `13` rolls into January of the next year, and `0` back into December of the last. */
  month: number;
  /** `0` is the last day of the previous month; a day past the month's end rolls forward. */
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}

/** The day either side of a wall clock — the bracket every transition near it falls inside. */
const DAY_MS = 86_400_000;

/** Every instant that can read as one wall clock: the earlier, the later where the hour repeats,
 *  and whether the wall clock exists at all. */
interface WallClockInstants {
  /** The earliest instant reading as the requested wall clock — or, where none does, the instant
   *  the clock jumps to (the wall clock plus the hour that was skipped). */
  instant: Date;
  /** The second occurrence, on a night the wall clock happens twice; `null` otherwise. */
  later: Date | null;
  /** False when that wall clock does not exist in `zone` — a spring-forward morning. */
  exists: boolean;
}

/**
 * The instants a wall clock can name in `zone`.
 *
 * The offsets a day either side bracket any transition near it, so those two readings give every
 * candidate; the ones that read BACK as the request are the real occurrences — none on a
 * spring-forward morning, two on an autumn one. This is the whole of the zone arithmetic: the two
 * exported doors below differ only in which occurrence they answer with.
 */
function wallClockInstants(wall: ZonedWallClock, zone: string): WallClockInstants {
  const naive = Date.UTC(
    wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0, wall.second ?? 0,
  );
  const readsAsRequested = (t: number): boolean => {
    const f = zonedFields(new Date(t), zone);
    return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) === naive;
  };
  /* The pre-transition offset first: on a missing wall clock it is the one that lands AFTER the
     gap, which is the instant the clock jumps to. */
  const fromBefore = naive - offsetAt(naive - DAY_MS, zone);
  const fromAfter = naive - offsetAt(naive + DAY_MS, zone);
  const real = [...new Set([fromBefore, fromAfter])].sort((a, b) => a - b).filter(readsAsRequested);
  if (real.length === 0) return { instant: new Date(fromBefore), later: null, exists: false };
  return {
    instant: new Date(real[0]),
    later: real.length > 1 ? new Date(real[real.length - 1]) : null,
    exists: true,
  };
}

/**
 * The UTC instant at which `zone` reads the given wall clock — the inverse of {@link zonedFields}.
 * Where the wall clock happens twice this answers the LAST occurrence, which is what an instant
 * closing a window wants (`dayEnd`'s 23:59:59 ends the day it names, not an hour into it), and
 * where it does not happen at all it answers the instant the clock jumps to. A wall clock a PERSON
 * chose goes through {@link composeZonedWallClock} instead: it answers the first of two and says
 * which of the three cases it was, so the surface can state the time it booked.
 */
export function zonedInstant(wall: ZonedWallClock, zone: string): Date {
  const { instant, later } = wallClockInstants(wall, zone);
  return later ?? instant;
}

/** Which rule produced an instant — `exact`, or the boundary the wall clock landed on. */
export type WallClockVerdict = "exact" | "shifted_forward" | "first_of_two";

/** A composed wall clock: the instant to store, the rule that produced it, and the clock it READS
 *  as in the zone — equal to the request only when the verdict is `exact`. */
export interface ZonedComposition {
  instant: Date;
  verdict: WallClockVerdict;
  hour: number;
  minute: number;
}

/**
 * A wall clock somebody CHOSE, as the instant to book — the one composition the horizons use.
 *
 * Three deterministic answers: the instant itself; `shifted_forward` where that wall clock does not
 * exist, which books the first instant after the skipped hour (02:30 on a spring morning books
 * 03:30); and `first_of_two` where it happens twice, which books the earlier occurrence — a chosen
 * time comes round when the reader's clock FIRST reads it. `hour`/`minute` are read back off the
 * instant, so a caller labelling its horizon from them cannot show a time it did not book.
 */
export function composeZonedWallClock(wall: ZonedWallClock, zone: string): ZonedComposition {
  const { instant, later, exists } = wallClockInstants(wall, zone);
  const verdict: WallClockVerdict =
    !exists ? "shifted_forward" : later === null ? "exact" : "first_of_two";
  const f = zonedFields(instant, zone);
  return { instant, verdict, hour: f.hour, minute: f.minute };
}
