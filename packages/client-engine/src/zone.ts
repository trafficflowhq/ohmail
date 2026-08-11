/**
 * AN INSTANT, READ AS A WALL CLOCK IN A NAMED ZONE — and back again.
 *
 * Every date the engine and the app store is a UTC instant, and that does not change. What changes
 * is that a stamp on screen must be read in the READER's zone: a message that arrived at
 * 2026-08-11T14:32Z is "16:32" to someone in Zurich, and it is on the NEXT calendar day to someone
 * in Auckland. Three questions follow from that, and this file is the only place any of them is
 * answered:
 *
 *  · what wall clock does this instant show there — {@link zonedFields};
 *  · which calendar day is it there, so "today / this week / dated" can band on the reader's
 *    midnights rather than UTC's — {@link zonedDayNumber}, {@link zonedWeekday};
 *  · and the inverse, which is the one with teeth: what UTC instant is 09:00 there —
 *    {@link zonedInstant}.
 *
 * ── WHY THE INVERSE IS NOT `utc + offset` ───────────────────────────────────────────────────
 *
 * A zone's offset is not a constant. Zurich is +01:00 for half the year and +02:00 for the other
 * half, so a resurface preset that adds a fixed offset to a UTC midnight is wrong by an hour on one
 * side of every DST transition, and the transition is exactly when nobody is testing. Worse, the
 * offset is a function of the INSTANT, and minting a wall clock means we do not have the instant
 * yet — that is the circularity. {@link zonedInstant} resolves it by iterating: guess the instant
 * with the offset that applies at the naive one, then re-read the offset AT THAT GUESS and correct.
 * Two passes settle every real zone, because the correction only ever moves the instant by the size
 * of a DST shift and the offset is locally constant on either side of one.
 *
 * ── AND WHY `Intl` RATHER THAN A ZONE LIBRARY ───────────────────────────────────────────────
 *
 * The platform ships the IANA database, keeps it updated with the OS, and this package takes no
 * dependencies it does not have to — it is bundled into the desktop app. `formatToParts` with a
 * `timeZone` is the whole mechanism; everything here is arithmetic on the six numbers it returns.
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

/**
 * The UTC instant at which `zone` reads the given wall clock.
 *
 * The inverse of {@link zonedFields}, and the function every resurface preset is built on: "09:00
 * tomorrow" is a wall clock, and what gets stored is the instant. See the file header for why the
 * second pass is not redundant.
 *
 * A wall clock that does not exist — 02:30 on a spring-forward morning — answers the instant the
 * clock jumps to (03:30), and one that happens twice answers the SECOND, standard-time occurrence.
 * Neither is reachable from this product, whose presets all mint 09:00; both are pinned in
 * `test/zone.test.ts` so they stay decisions rather than accidents.
 */
export function zonedInstant(wall: ZonedWallClock, zone: string): Date {
  const naive = Date.UTC(
    wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0, wall.second ?? 0,
  );
  const firstPass = naive - offsetAt(naive, zone);
  return new Date(naive - offsetAt(firstPass, zone));
}
