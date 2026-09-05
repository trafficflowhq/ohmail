/**
 * ═══ WHEN A MESSAGE ARRIVED, AS A READER READS IT — every stamp in the product, from here ═══
 *
 * A time of day used to be composed in seven places across three packages, and the copies had
 * already drifted in the way that matters: two of them asked `Intl` for `hour12: false`, which is
 * NOT a synonym for a 24-hour clock — it resolves to h24 on some builds and renders midnight as
 * "24:10". Six sites carried a hand-written repair for that; the seventh did not, and it also read
 * the BROWSER's zone rather than the reader's, so it was the one stamp in the product that could
 * disagree with every other stamp beside it about what time it was.
 *
 * So there is one module. Every hour in the tree goes through {@link clock}.
 *
 * ── THE BANDS, AND WHY THERE ARE THREE OF THEM ──────────────────────────────────────────────
 *
 * A list is scanned by its stamps, so each band shows the least that still tells rows apart:
 *
 *   · the same calendar day  → `09:12` — the day is not in question, only the time;
 *   · the last six days      → `Mon 09:12` — a weekday name is unique for six days and repeats on
 *                              the seventh, which is exactly where this band ends;
 *   · beyond                 → `2 Aug`, and `30 Dec 2025` outside the current year, because a bare
 *                              day-and-month on a message from another year is the same ambiguity
 *                              in a slower form.
 *
 * The middle band used to be the weekday ALONE, and the time simply vanished from a message the
 * moment the reader's midnight passed. The shape now is a superset: a message stamped `09:12`
 * today reads `Fri 09:12` tomorrow and keeps its time for six days.
 *
 * `Yesterday 09:12` was considered and is not what this does. It is a word among numbers and
 * abbreviations, it is the widest non-dated stamp on the list, and it would need a catalogue this
 * package deliberately does not have — the whole reason the shape is weekday-plus-clock is that
 * `Intl` names the weekday and the digits come from the reader's own zone, so no translation
 * exists to go missing.
 *
 * ── TWO PARTS, NEVER ONE COMBINED PATTERN ───────────────────────────────────────────────────
 *
 * `weekdayClock` asks `Intl` for the WEEKDAY and composes the clock itself, rather than asking for
 * one formatter with both. A combined German pattern renders `Sa., 00:07` — a comma the caller
 * never chose and cannot remove — and the separator would then vary by locale in a column that is
 * read by its shape. The weekday is a word and belongs to `Intl`; the clock is digits and belongs
 * to the reader's zone.
 *
 * ── AND THE CLOCK IS NEVER `Intl`-FORMATTED ─────────────────────────────────────────────────
 *
 * {@link clock} reads {@link zonedFields}, which already pins `hourCycle: "h23"` and folds a 24
 * hour back to 0, and pads the two numbers itself. That is what makes it exact rather than
 * approximately right: there is no second formatter for the hour to come out of wrong, and the
 * separator is ours, which is what the callers that put a weekday or a date in front of it depend
 * on. A 24-hour clock in both languages is deliberate — this product has two locales carrying no
 * region, and ICU resolves a bare `en` to a 12-hour cycle, which would be a guess about the reader
 * rather than a fact about them.
 */
import { zonedDayNumber, zonedFields } from "./zone.js";
import type { EngineMessage } from "./types.js";

/**
 * THE DAY AND MONTH NAMES, FROM `Intl`, IN THE CALLER'S LOCALE AND THE READER'S ZONE.
 *
 * Three hardcoded English arrays used to stand here, and they are the most-repeated words in the
 * product: every message row outside today renders one, every Receipts day heading renders one, and
 * every screened-out sender carries one. A German reader saw "Tue", "Thursday" and "2 Aug".
 *
 * THE LOCALE IS A PARAMETER AND DEFAULTS TO ENGLISH, which is what keeps this package free of an
 * i18n dependency: it has no catalogue, no provider and no opinion about language, and its own
 * tests keep asserting the English strings they always did. The web app is the caller that passes
 * a reader's locale.
 *
 * Cached by locale-and-zone-and-shape: constructing a formatter is the expensive part and these
 * are called once per visible row.
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
 * A MESSAGE'S ROW STAMP — the three bands at the top of this file, applied to one message.
 *
 * `time` wins where a row carries one — and NO ROW THIS PRODUCT SERVES DOES any more. The demo's
 * fixtures used to set it, which meant the rule below never ran over them and the demo showed a
 * shape frozen at whatever was typed; the adapter stopped copying it onto the message, so every
 * row — demo and server-fed alike — derives its stamp from `date` here. The branch stays because
 * the field is still on the type and a caller may set it; it is no longer the demo's path. It lives in this package rather than in the web app
 * because the Screener mints rows for senders that have no message behind them at all, and the
 * phone reads the same function.
 *
 * A message with no `Date:` header answers "" — spam and scripts routinely omit it, and there is no
 * instant to format. Callers render no stamp rather than an empty one.
 *
 * A FUTURE date (a resurfaced or scheduled row) takes the dated branch: `daysAgo` goes negative,
 * and a weekday for something that has not happened yet reads as the past.
 *
 * The zone is REQUIRED and has no default. Every band is a statement about the reader's calendar,
 * so it cannot be computed without knowing which calendar that is, and a default would make the
 * wrong answer the quiet one — a call site that forgot would render a plausible, well-formatted,
 * two-hours-wrong stamp, and nothing in the type system, the suite or the screen would say so.
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
