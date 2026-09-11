/**
 * When a message arrived, as a reader reads it — every stamp in the product;
 * every hour goes through {@link clock} (`hour12: false` is not a 24-hour
 * clock and once rendered "24:10"). Three bands: same calendar day → `09:12`;
 * last six days → `Mon 09:12` (a weekday repeats on the seventh, where the
 * band ends); beyond → `2 Aug`, with the year outside the current one.
 * `weekdayClock` asks Intl only for the weekday and composes the clock itself
 * (a combined German pattern renders `Sa., 00:07`); the clock is never
 * Intl-formatted — `zonedFields` pins h23; deliberate, as bare `en` is 12-hour.
 */
import { zonedDayNumber, zonedFields } from "./zone.js";
import type { EngineMessage } from "./types.js";

/**
 * Day and month names from Intl, in the caller's locale and the reader's
 * zone — three hardcoded English arrays once stood here, the most-repeated
 * words in the product (a German reader saw "Tue" and "2 Aug"). The locale
 * is a parameter defaulting to English, which keeps this package free of an
 * i18n dependency: no catalogue, no provider; the web app passes the
 * reader's locale. Cached by locale-zone-shape — constructing a formatter is
 * the expensive part and these run once per visible row.
 */
const NAMERS = new Map<string, Intl.DateTimeFormat>();

export function named(
  locale: string, opts: Intl.DateTimeFormatOptions, d: Date, zone: string,
): string {
  const key = `${locale}|${zone}|${opts.weekday ?? ""}|${opts.month ?? ""}`;
  let fmt = NAMERS.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { ...opts, timeZone: zone });
    NAMERS.set(key, fmt);
  }
  return fmt.format(d);
}

/**
 * Midnights apart IN THE READER'S ZONE. Positive = in the past; negative = dated in the future.
 *
 * The reader's midnights and not UTC's, because that is what "today" and "yesterday" mean to the
 * person reading. Banded on UTC, every message a Zurich reader received between their midnight and
 * 01:00 (02:00 in summer) was stamped with yesterday's weekday, and a message from 01:30 on the
 * 1st of a month was dated to the last day of the previous one.
 */
export function daysAgo(d: Date, now: Date, zone: string): number {
  return zonedDayNumber(now, zone) - zonedDayNumber(d, zone);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The wall clock an instant shows in `zone`, as "HH:MM" — zero-padded, 24-hour, ASCII colon.
 *
 * Every hour rendered anywhere in the product comes from here. Throws for an unknown zone and for
 * an invalid instant, exactly as {@link zonedFields} does and for the reason written there: a clock
 * that quietly falls back to UTC is the defect that file exists to prevent. A caller that must
 * survive a bad zone says so with its own `try`.
 */
export function clock(instant: Date, zone: string): string {
  const f = zonedFields(instant, zone);
  return `${pad2(f.hour)}:${pad2(f.minute)}`;
}

/** "Mon 09:12" / "Mo 09:12" — a day inside this week, at a time. */
export function weekdayClock(instant: Date, zone: string, locale = "en"): string {
  return `${named(locale, { weekday: "short" }, instant, zone)} ${clock(instant, zone)}`;
}

/** "12 Sep, 18:00" — a day past this week, at a time. */
export function dateClock(instant: Date, zone: string, locale = "en"): string {
  const f = zonedFields(instant, zone);
  return `${f.day} ${named(locale, { month: "short" }, instant, zone)}, ${clock(instant, zone)}`;
}

/** "Wed 5 Aug 2026, 14:32" — the exact instant, for a hover title and the details disclosure. */
export function fullDateTime(instant: Date, zone: string, locale = "en"): string {
  const f = zonedFields(instant, zone);
  return (
    `${named(locale, { weekday: "short" }, instant, zone)} ${f.day} `
    + `${named(locale, { month: "short" }, instant, zone)} ${f.year}, ${clock(instant, zone)}`
  );
}

/**
 * A message's row stamp — the three bands at the top of this file, applied to one message. `time` wins where a row
 * carries one, and no row this product serves does any more: the demo's fixtures used to set it, freezing the demo's
 * shape at whatever was typed; the adapter stopped copying it, so every row derives its stamp from `date` here. The
 * branch stays because the field is still on the type. It lives in this package because the Screener mints rows for
 * senders with no message behind them, and the phone reads the same function.
 */

/**
 * No `Date:` header answers "" — spam and scripts routinely omit it, and there is no instant to format; callers
 * render no stamp rather than an empty one. A FUTURE date (a resurfaced or scheduled row) takes the dated branch:
 * `daysAgo` goes negative, and a weekday for something that has not happened reads as the past. The zone is REQUIRED
 * and has no default: every band is a statement about the reader's calendar, and a defaulted call site would render a
 * plausible, well-formatted, two-hours-wrong stamp with nothing in the type system, the suite or the screen saying
 * so.
 */
export function messageStamp(
  m: Pick<EngineMessage, "time" | "date">,
  now: Date,
  /** The IANA zone the reader is in. REQUIRED — see above. */
  zone: string,
  /** Which language to name the day and month in. English by default — see {@link named}. */
  locale = "en",
): string {
  if (m.time) return m.time;
  if (!m.date) return "";
  const d = new Date(m.date);
  if (Number.isNaN(d.getTime())) return "";

  const ago = daysAgo(d, now, zone);
  if (ago === 0) return clock(d, zone);
  if (ago >= 1 && ago <= 6) return weekdayClock(d, zone, locale);

  const f = zonedFields(d, zone);
  const stamp = `${f.day} ${named(locale, { month: "short" }, d, zone)}`;
  return f.year === zonedFields(now, zone).year ? stamp : `${stamp} ${f.year}`;
}
