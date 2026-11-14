/**
 * The forms of a day and of a clock time, read forward from one token. A form looks a few tokens
 * ahead and never back: what came before is handed in as the word before (`prev`). Days are worked
 * out on plain dates from the letter's own day; nothing here knows the reading time or a zone.
 */
import { addDays, dayNumber, isValidDate, weekdayOf } from "../time/arith.js";
import type { PlainDate } from "../time/types.js";
import {
  CURRENCY,
  DASHES,
  DURATION_WORDS,
  NOON_WORDS,
  ORDINAL_SUFFIXES,
  RANGE_WORDS,
  ZONE_WORDS,
  type HalfWord,
  type Lexicon,
} from "./lexicon.js";
import { joined, look, type Token, type TokenReader } from "./text.js";

export interface FormContext {
  readonly r: TokenReader;
  readonly lex: Lexicon;
  readonly letterDay: PlainDate;
  /** The word before the form's first token, lower case; "" at a sentence's start. */
  readonly prev: string;
  /** The form's first token is a number joined behind a stop or colon joined behind a number: "1.5", "3:2". */
  readonly joinedBehind: boolean;
  /** The word before, or before its stop, takes a number of its own: "Raum 5", "Nr. 5" (`noHourAfter`). */
  readonly numbered: boolean;
  /**
   * The token before is a word that names no time and no day and leads to neither: "Teil 2", "table for
   * 4". Not after "um", "ab", "at", "from", "between", a half of the day, a weekday, a month, "today".
   */
  readonly plainBefore: boolean;
  /** The form's first token is a number joined behind a dash joined behind a number: the 2 of "1–2". */
  readonly pairBehind: boolean;
  /**
   * The word before ends a range whose start was not read: "bis 17 Uhr", "until 5pm", "10 to 12:00".
   * English "to" ends one only after a number or "up", "through", "open"; "moved to 3pm" names a new time.
   */
  readonly endOnly: boolean;
  /**
   * The end with no start follows "up to", "through to", "open to": it is passed over whole, with what
   * a dash joins to it ("up to 5pm - 6pm"), so that no part of it is read as a start.
   */
  readonly endPassed: boolean;
  /** The half of the day a word within three tokens before named ("evening", "abends"), or `null`. */
  readonly halfBefore: HalfWord | null;
}

export type DayForm =
  | "whole" // a date with its month: 21 November, 21.11.2026
  | "weekday" // a weekday alone
  | "relative" // today, tomorrow
  | "next_weekday" // "next Sunday", "Saturday week": either of two days
  | "ambiguous_date" // 07/08/2026 with nothing to choose between its readings
  | "range" // 21–23 November: two days
  | "partial" // "the 10th", "next week": a sign of a day, but no day
  | "nothing"; // a chain of dotted numbers: a version, an address

export interface DayMatch {
  readonly form: DayForm;
  /** One day; two for `next_weekday`, `ambiguous_date` and `range`; none for `partial` and `nothing`. */
  readonly days: readonly PlainDate[];
  /** The weekday written beside a whole date, Monday 0; `null` when none was. */
  readonly written: number | null;
  readonly start: number;
  readonly next: number;
}

export interface Clock {
  readonly hour: number;
  readonly minute: number;
}

export interface ClockMatch {
  readonly at: Clock;
  readonly end: Clock | null;
  /** English `7:30` with no marker: read as the afternoon, and never more than a guess. */
  readonly capGuess: boolean;
  /** Written on a 12-hour face with nothing to say which half: either half of the day is the words'. */
  readonly eitherHalf: boolean;
  /** A zone word follows: the time is not on the person's clock. */
  readonly otherZone: boolean;
  /** An hour from 1 to 11 that no marker and no word beside it put in a half of the day. */
  readonly shiftable: boolean;
  /**
   * No clock: the match only says where the words end, so that the walk passes over them whole and never
   * reads an end as a start. `range`: a range after a word that takes a number of its own ("Raum 5 – 17
   * Uhr") or an hour past twelve before am/pm ("13-2pm"); it stands where the day's clock would. `end`:
   * an end with no start after "up to" ("up to 5pm"), with what a dash joins to it.
   */
  readonly passed: "range" | "end" | null;
  readonly start: number;
  readonly next: number;
}

const word = (t: Token | undefined): string => (t !== undefined && t.kind === "word" ? t.low : "");
const isMark = (t: Token | undefined, m: string): boolean =>
  t !== undefined && t.kind === "mark" && t.low === m;
const digits = (t: Token | undefined, min: number, max: number): boolean =>
  t !== undefined && t.kind === "num" && t.end - t.start >= min && t.end - t.start <= max;

/** A word that names a time or a day, or leads to one: a lone hour after it may start a range. */
const leadsToTime = (lex: Lexicon, w: string): boolean =>
  lex.timeBefore.has(w) ||
  lex.timeLabels.has(w) ||
  lex.timeWords.has(w) ||
  lex.halves.has(w) ||
  lex.halfLinks.has(w) ||
  RANGE_WORDS.has(w) ||
  w === lex.betweenAnd[0] ||
  lex.toEndAfter.has(w) ||
  lex.hoursWords.has(w) ||
  lex.hoursAfter.has(w) ||
  lex.hoursEndings.some((e) => w.endsWith(e)) ||
  lex.weekdays.has(w) ||
  lex.weekdaysShort.has(w) ||
  lex.months.has(w) ||
  lex.relative.has(w) ||
  lex.articles.has(w) ||
  lex.ordinalBefore.has(w) ||
  NOON_WORDS.has(w) ||
  w === "uhr";

/**
 * The context of a form at token `i`, from the token before it (`undefined` at a sentence's start).
 * The token two before is read only when the one before is a stop or colon (joined to the form, or
 * ending the word before: "Nr. 5") or English "to" ("10 to 12:00").
 */
export function formContextAt(
  r: TokenReader,
  lex: Lexicon,
  letterDay: PlainDate,
  i: number,
  before: Token | undefined,
  halfBefore: HalfWord | null,
): FormContext {
  const t = r.tokens[i];
  const behind =
    t?.kind === "num" && (isMark(before, ".") || isMark(before, ":")) && joined(before, t)
      ? r.tokens[i - 2]
      : undefined;
  const stopped = isMark(before, ".") ? r.tokens[i - 2] : undefined;
  const owner = stopped !== undefined && joined(stopped, before) ? stopped : before;
  // English "to" ends a range after a number ("10 to 12:00") or a word of `toEndAfter` ("up to 5pm").
  const two = before?.low === "to" ? r.tokens[i - 2] : undefined;
  const endPassed = two?.kind === "word" && lex.toEndAfter.has(two.low);
  return {
    r,
    lex,
    letterDay,
    prev: before?.low ?? "",
    joinedBehind: behind?.kind === "num" && joined(behind, before),
    pairBehind:
      t?.kind === "num" &&
      before?.kind === "mark" &&
      DASHES.has(before.low) &&
      joined(before, t) &&
      r.tokens[i - 2]?.kind === "num" &&
      joined(r.tokens[i - 2], before),
    numbered: lex.noHourAfter.has(owner?.kind === "word" ? owner.low : ""),
    // The "st" of "November 21st" ends the day's own form: no plain word.
    plainBefore:
      before?.kind === "word" &&
      !leadsToTime(lex, before.low) &&
      !(
        ORDINAL_SUFFIXES.has(before.low) &&
        r.tokens[i - 2]?.kind === "num" &&
        joined(r.tokens[i - 2], before)
      ),
    endOnly:
      before !== undefined &&
      RANGE_WORDS.has(before.low) &&
      (before.low !== "to" || two?.kind === "num" || endPassed),
    endPassed,
    halfBefore,
  };
}

/* ── days ───────────────────────────────────────────────────────────────────────────────────────── */

/** A date as written: a year when one is, and one reading or two (an English slash date). */
interface Written {
  readonly readings: readonly {
    readonly year: number | null;
    readonly month: number;
    readonly day: number;
  }[];
  readonly range: boolean;
  readonly next: number;
}

/** The written day nearest the letter's own, among last year, this year and next. */
function nearest(month: number, day: number, letterDay: PlainDate): PlainDate | null {
  const anchor = dayNumber(letterDay);
  let best: PlainDate | null = null;
  for (const year of [letterDay.year - 1, letterDay.year, letterDay.year + 1]) {
    if (!isValidDate(year, month, day)) continue;
    const d: PlainDate = { kind: "date", year, month, day };
    if (best === null || Math.abs(dayNumber(d) - anchor) <= Math.abs(dayNumber(best) - anchor)) best = d;
  }
  return best;
}

function resolve(w: Written["readings"][number], letterDay: PlainDate): PlainDate | null {
  if (w.year === null) return nearest(w.month, w.day, letterDay);
  return isValidDate(w.year, w.month, w.day)
    ? { kind: "date", year: w.year, month: w.month, day: w.day }
    : null;
}

const yearOf = (t: Token): number => (t.end - t.start === 2 ? 2000 + t.value : t.value);

/** A year after a named date: four digits that are no clock. */
function yearAt(c: FormContext, i: number): { year: number | null; next: number } {
  const comma = isMark(look(c.r, i), ",") ? 1 : 0;
  const t = look(c.r, i + comma);
  if (!digits(t, 4, 4) || isMark(look(c.r, i + comma + 1), ":")) return { year: null, next: i };
  return { year: t!.value, next: i + comma + 1 };
}

/** `21.11.2026`, `21.11.26`, `21.11.`, `2026-11-21`, `21/11/2026`; a chain of four or more numbers is `nothing`. */
function numericAt(c: FormContext, i: number): Written | "nothing" | null {
  const a = look(c.r, i)!;
  const sep = look(c.r, i + 1);
  if (sep === undefined || !joined(a, sep) || sep.kind !== "mark") return null;
  const b = look(c.r, i + 2);
  if (b === undefined || !joined(sep, b) || b.kind !== "num") return null;
  const sep2 = look(c.r, i + 3);
  const y = look(c.r, i + 4);
  const hasYear = joined(b, sep2) && sep2!.low === sep.low && joined(sep2, y) && y!.kind === "num";
  if (sep.low === "." && hasYear && joined(y, look(c.r, i + 5)) && isMark(look(c.r, i + 5), ".")) {
    if (look(c.r, i + 6)?.kind === "num" && joined(look(c.r, i + 5), look(c.r, i + 6))) return "nothing";
  }
  if (sep.low === "-" && digits(a, 4, 4) && hasYear && digits(b, 1, 2) && digits(y, 1, 2))
    return { readings: [{ year: a.value, month: b.value, day: y!.value }], range: false, next: i + 5 };
  if (!digits(a, 1, 2) || !digits(b, 1, 2)) return null;
  if (sep.low === ".") {
    if (hasYear) {
      if (!digits(y, 2, 2) && !digits(y, 4, 4)) return "nothing";
      return { readings: [{ year: yearOf(y!), month: b.value, day: a.value }], range: false, next: i + 5 };
    }
    if (!joined(b, sep2) || sep2!.low !== ".") return null; // "21.11" is a number, "21.11." a date
    if (c.lex.language === "en") return null; // in English "3.5." is a version or an amount
    return { readings: [{ year: null, month: b.value, day: a.value }], range: false, next: i + 4 };
  }
  if (sep.low !== "/" || !hasYear || (!digits(y, 2, 2) && !digits(y, 4, 4))) return null;
  const year = yearOf(y!);
  const dayFirst = { year, month: b.value, day: a.value };
  const monthFirst = { year, month: a.value, day: b.value };
  if (c.lex.language === "de" || a.value > 12) return { readings: [dayFirst], range: false, next: i + 5 };
  if (b.value > 12 || a.value === b.value) return { readings: [monthFirst], range: false, next: i + 5 };
  return { readings: [dayFirst, monthFirst], range: false, next: i + 5 };
}

/** A day of the month as a number with its ordinal mark: `21`, `21st`, `21.`. Returns the token after it. */
function dayNumberAt(c: FormContext, i: number): { day: number; next: number; ordinal: boolean } | null {
  const t = look(c.r, i);
  if (!digits(t, 1, 2) || t!.value < 1 || t!.value > 31) return null;
  const after = look(c.r, i + 1);
  if (
    joined(t, after) &&
    after!.kind === "word" &&
    ORDINAL_SUFFIXES.has(after!.low) &&
    c.lex.language === "en"
  )
    return { day: t!.value, next: i + 2, ordinal: true };
  if (joined(t, after) && isMark(after, ".")) return { day: t!.value, next: i + 2, ordinal: true };
  return { day: t!.value, next: i + 1, ordinal: false };
}

/** A month's name, with the stop a short one may carry. */
function monthAt(c: FormContext, i: number): { month: number; next: number } | null {
  const t = look(c.r, i);
  const month = c.lex.months.get(word(t));
  if (month === undefined) return null;
  return { month, next: isMark(look(c.r, i + 1), ".") && joined(t, look(c.r, i + 1)) ? i + 2 : i + 1 };
}

/** `21 November [2026]`, `the 21st of November`, `21. November`, and `21–23 November` as a range. */
function dayFirstAt(c: FormContext, i: number): Written | null {
  const first = dayNumberAt(c, i);
  if (first === null) return null;
  let j = first.next;
  let second: { day: number; next: number } | null = null;
  const between = look(c.r, j);
  if ((between?.kind === "mark" && DASHES.has(between.low)) || RANGE_WORDS.has(word(between))) {
    second = dayNumberAt(c, j + 1);
    if (second !== null) j = second.next;
  }
  if (word(look(c.r, j)) === "of" && c.lex.language === "en") j += 1;
  const month = monthAt(c, j);
  if (month === null) return null;
  const year = yearAt(c, month.next);
  const reading = (day: number) => ({ year: year.year, month: month.month, day });
  if (second === null)
    return { readings: [reading(first.day)], range: false, next: Math.max(year.next, month.next) };
  if (second.day <= first.day) return null;
  return {
    readings: [reading(first.day), reading(second.day)],
    range: true,
    next: Math.max(year.next, month.next),
  };
}

/** English `November 21[st][,] [2026]`. */
function monthFirstAt(c: FormContext, i: number): Written | null {
  if (c.lex.language !== "en") return null;
  const month = monthAt(c, i);
  if (month === null) return null;
  const day = dayNumberAt(c, month.next);
  if (day === null || isMark(look(c.r, day.next), ":")) return null;
  const year = yearAt(c, day.next);
  return {
    readings: [{ year: year.year, month: month.month, day: day.day }],
    range: false,
    next: Math.max(year.next, day.next),
  };
}

function writtenAt(c: FormContext, i: number): Written | "nothing" | null {
  const t = look(c.r, i);
  if (t?.kind === "num") return numericAt(c, i) ?? dayFirstAt(c, i);
  if (t?.kind === "word") return monthFirstAt(c, i);
  return null;
}

/** A written date as a match, a weekday written beside it choosing between two readings. */
function wholeMatch(w: Written, written: number | null, c: FormContext, start: number): DayMatch | null {
  const days = w.readings.map((x) => resolve(x, c.letterDay)).filter((d): d is PlainDate => d !== null);
  if (days.length === 0 || (w.range && days.length < 2)) return null;
  if (w.range) return { form: "range", days, written, start, next: w.next };
  if (days.length === 1) return { form: "whole", days, written, start, next: w.next };
  const agreeing = written === null ? [] : days.filter((d) => weekdayOf(dayNumber(d)) === written);
  if (agreeing.length === 1) return { form: "whole", days: agreeing, written, start, next: w.next };
  return { form: "ambiguous_date", days, written, start, next: w.next };
}

const partial = (start: number, next: number): DayMatch => ({
  form: "partial",
  days: [],
  written: null,
  start,
  next,
});

/** The first such weekday strictly after the letter's day. */
export function weekdayAfter(letterDay: PlainDate, weekday: number): PlainDate {
  const ahead = (weekday - weekdayOf(dayNumber(letterDay)) + 7) % 7;
  return addDays(letterDay, ahead === 0 ? 7 : ahead);
}

/** A weekday a week or two after the coming one: either of two days, never guessed. */
const shifted = (c: FormContext, weekday: number, start: number, next: number): DayMatch => {
  const coming = weekdayAfter(c.letterDay, weekday);
  return {
    form: "next_weekday",
    days: [addDays(coming, 7), addDays(coming, 14)],
    written: null,
    start,
    next,
  };
};

/** "in two weeks", "in einer Woche" at token `j`: the token after it, or `null`. */
function weeksAt(c: FormContext, j: number): number | null {
  if (word(look(c.r, j)) !== "in") return null;
  const count = look(c.r, j + 1);
  if (count === undefined || !(count.kind === "num" || c.lex.counts.has(count.low))) return null;
  return c.lex.week.has(word(look(c.r, j + 2))) ? j + 3 : null;
}

/** After a weekday: "week", "after next", "in two weeks". The token after them, or `null`. */
function shiftAfter(c: FormContext, j: number): number | null {
  const w = word(look(c.r, j));
  if (c.lex.language === "en" && c.lex.week.has(w)) return j + 1;
  if (w === "after" && word(look(c.r, j + 1)) === "next") return j + 2;
  return weeksAt(c, j);
}

/** A weekday, full or short, and the date it stands before when there is one. */
function weekdayAt(c: FormContext, i: number, weekday: number, short: boolean): DayMatch | null {
  let j = i + 1;
  if (short && isMark(look(c.r, j), ".")) j += 1;
  if (isMark(look(c.r, j), ",")) j += 1;
  if (c.lex.articles.has(word(look(c.r, j)))) j += 1;
  const w = writtenAt(c, j);
  if (w !== null && w !== "nothing") {
    const m = wholeMatch(w, weekday, c, i);
    if (m !== null) return m;
  }
  if (short) return null;
  const shift = shiftAfter(c, i + 1);
  if (shift !== null) return shifted(c, weekday, i, shift);
  return {
    form: "weekday",
    days: [weekdayAfter(c.letterDay, weekday)],
    written: null,
    start: i,
    next: i + 1,
  };
}

/** "a week on Saturday", "in zwei Wochen am Samstag": a weekday shifted from before it, or a partial day. */
function weekBeforeAt(c: FormContext, i: number): DayMatch | null {
  const t = word(look(c.r, i));
  let j: number | null = null;
  if (c.lex.language === "en" && c.lex.week.has(t) && word(look(c.r, i + 1)) === "on") j = i + 2;
  const weeks = j === null ? weeksAt(c, i) : null;
  if (weeks !== null)
    j = c.lex.articles.has(word(look(c.r, weeks))) || word(look(c.r, weeks)) === "on" ? weeks + 1 : weeks;
  if (j === null) return null;
  const weekday = c.lex.weekdays.get(word(look(c.r, j)));
  if (weekday !== undefined) return shifted(c, weekday, i, j + 1);
  return weeks === null ? null : partial(i, weeks);
}

/** A day expression starting at token `i`, or `null`. */
export function readDayAt(c: FormContext, i: number): DayMatch | null {
  const t = look(c.r, i);
  if (t === undefined) return null;
  if (t.kind === "num") {
    if (CURRENCY.has(c.prev)) return null;
    const w = writtenAt(c, i);
    if (w === "nothing") return { form: "nothing", days: [], written: null, start: i, next: chainEnd(c, i) };
    if (w !== null) return wholeMatch(w, null, c, i);
    const ord = dayNumberAt(c, i);
    if (ord !== null && ord.ordinal && c.lex.ordinalBefore.has(c.prev)) {
      const after = look(c.r, ord.next);
      if (!(after?.kind === "num" && joined(look(c.r, ord.next - 1), after))) return partial(i, ord.next);
    }
    return null;
  }
  if (t.kind !== "word") return null;
  const lex = c.lex;
  if (
    lex.language === "en" &&
    t.low === "day" &&
    word(look(c.r, i + 1)) === "after" &&
    word(look(c.r, i + 2)) === "tomorrow"
  )
    return { form: "relative", days: [addDays(c.letterDay, 2)], written: null, start: i, next: i + 3 };
  const relative = lex.relative.get(t.low);
  if (relative !== undefined) {
    if (t.low === "morgen" && lex.morgenAfter.has(c.prev)) return null;
    return { form: "relative", days: [addDays(c.letterDay, relative)], written: null, start: i, next: i + 1 };
  }
  if (lex.next.has(t.low)) {
    const after = word(look(c.r, i + 1));
    const weekday = lex.weekdays.get(after);
    if (weekday !== undefined) {
      const coming = weekdayAfter(c.letterDay, weekday);
      return {
        form: "next_weekday",
        days: [coming, addDays(coming, 7)],
        written: null,
        start: i,
        next: i + 2,
      };
    }
    return lex.week.has(after) ? partial(i, i + 2) : null;
  }
  if (lex.afterNext.has(t.low)) {
    const after = word(look(c.r, i + 1));
    const weekday = lex.weekdays.get(after);
    if (weekday !== undefined) return shifted(c, weekday, i, i + 2);
    return lex.week.has(after) ? partial(i, i + 2) : null;
  }
  const before = weekBeforeAt(c, i);
  if (before !== null) return before;
  const full = lex.weekdays.get(t.low);
  if (full !== undefined) return weekdayAt(c, i, full, false);
  const short = lex.weekdaysShort.get(t.low);
  if (short !== undefined) return weekdayAt(c, i, short, true);
  const w = monthFirstAt(c, i);
  return w === null ? null : wholeMatch(w, null, c, i);
}

/** The end of a run of numbers joined by stops: `192.168.1.1`, read as one thing that is no day. */
function chainEnd(c: FormContext, i: number): number {
  let j = i;
  while (
    look(c.r, j)?.kind === "num" &&
    isMark(look(c.r, j + 1), ".") &&
    joined(look(c.r, j), look(c.r, j + 1))
  ) {
    if (!joined(look(c.r, j + 1), look(c.r, j + 2))) return j + 2;
    j += 2;
  }
  return j + 1;
}

/* ── clocks ─────────────────────────────────────────────────────────────────────────────────────── */

type Half = "am" | "pm" | "uhr" | null;

interface Face {
  readonly hour: number;
  readonly minute: number;
  readonly half: Half;
  readonly colon: boolean;
  /** The hour as written had one digit. */
  readonly oneDigit: boolean;
  readonly next: number;
}

/** `am`, `pm`, `a.m.`, `p.m.`, or German `Uhr`, at token `j`. */
function halfAt(c: FormContext, j: number): { half: Half; next: number } {
  const w = word(look(c.r, j));
  if (w === "uhr") return { half: "uhr", next: j + 1 };
  if (c.lex.language !== "en") return { half: null, next: j };
  if (w === "am" || w === "pm") return { half: w, next: j + 1 };
  if ((w === "a" || w === "p") && isMark(look(c.r, j + 1), ".") && word(look(c.r, j + 2)) === "m") {
    const next = isMark(look(c.r, j + 3), ".") ? j + 4 : j + 3;
    return { half: w === "a" ? "am" : "pm", next };
  }
  return { half: null, next: j };
}

/** A clock face at token `i`: `19:30`, `7.30 pm`, `10.30 Uhr`, `7pm`, `19 Uhr`, `12 o'clock`; `bare` admits a lone hour. */
function faceAt(c: FormContext, i: number, bare: boolean): Face | null {
  const h = look(c.r, i);
  if (!digits(h, 1, 2)) return null;
  const sep = look(c.r, i + 1);
  const m = look(c.r, i + 2);
  const withMinutes =
    joined(h, sep) && joined(sep, m) && digits(m, 2, 2) && (sep!.low === ":" || sep!.low === ".");
  const j = withMinutes ? i + 3 : i + 1;
  const half = halfAt(c, j);
  const colon = withMinutes && sep!.low === ":";
  if (half.half === null && !colon) {
    if (
      h!.value === 12 &&
      c.lex.language === "en" &&
      word(look(c.r, j)) === "o" &&
      word(look(c.r, j + 2)) === "clock"
    )
      return { hour: 12, minute: 0, half: null, colon: false, oneDigit: false, next: j + 3 };
    if (!bare) return null;
  }
  const minute = withMinutes ? m!.value : 0;
  if (minute > 59) return null;
  const limit = half.half === "am" || half.half === "pm" ? 12 : 23;
  if (h!.value > limit || ((half.half === "am" || half.half === "pm") && h!.value === 0)) return null;
  return {
    hour: h!.value,
    minute,
    half: half.half,
    colon,
    oneDigit: h!.end - h!.start === 1,
    next: half.next,
  };
}

/** The face on a 24-hour clock, the half it names applied. */
function onClock(f: Face): Clock {
  if (f.half === "pm") return { hour: f.hour === 12 ? 12 : f.hour + 12, minute: f.minute };
  if (f.half === "am") return { hour: f.hour === 12 ? 0 : f.hour, minute: f.minute };
  return { hour: f.hour, minute: f.minute };
}

const minutesOf = (k: Clock): number => k.hour * 60 + k.minute;
/** English `7:30` with no marker and no leading zero: an afternoon reading, never more than a guess. */
const isUnmarkedAfternoon = (c: FormContext, f: Face): boolean =>
  c.lex.language === "en" && f.colon && f.half === null && f.oneDigit && f.hour >= 1 && f.hour <= 7;

interface Settled {
  readonly at: Clock;
  /** Never more than a guess. */
  readonly cap: boolean;
  /** Either half of the day is the words'. */
  readonly either: boolean;
  /** An hour from 1 to 11 that no marker and no word beside it put in a half of the day. */
  readonly shiftable?: boolean;
}

/**
 * A face with the half of the day a word beside it names. A marker on the face wins; then the word:
 * the evening moves an hour up to 11 to the afternoon, the night an hour from 6 to 11, the morning
 * keeps it. With neither, an unmarked English hour from 1 to 7 is the afternoon and a guess.
 */
function settled(c: FormContext, f: Face, half: HalfWord | null): Settled {
  if (f.half === "am" || f.half === "pm") return { at: onClock(f), cap: false, either: false };
  if (half !== null) {
    const up = half !== "am" && f.hour >= (half === "night" ? 6 : 1) && f.hour <= 11;
    const hour = up ? f.hour + 12 : half === "am" && f.hour === 12 ? 0 : f.hour;
    return { at: { hour, minute: f.minute }, cap: false, either: false };
  }
  const shiftable = f.hour >= 1 && f.hour <= 11;
  if (isUnmarkedAfternoon(c, f))
    return { at: { hour: f.hour + 12, minute: f.minute }, cap: true, either: true, shiftable };
  return { at: onClock(f), cap: false, either: f.half === null && f.hour >= 1 && f.hour <= 12, shiftable };
}

/** "1:30 at night", "12 at night": the night after which day? A clock read neither way. */
const nightUnsure = (f: Face, half: HalfWord | null): boolean =>
  half === "night" && f.half !== "am" && f.half !== "pm" && (f.hour < 6 || f.hour === 12);

/** A word that names the half of the day at token `j`, or after one or two small words: "in the evening". */
function halfAfter(c: FormContext, j: number): { half: HalfWord; next: number } | null {
  for (let k = j; k <= j + 2; k += 1) {
    const w = word(look(c.r, k));
    const half = c.lex.halves.get(w);
    if (half !== undefined) return { half, next: k + 1 };
    if (!c.lex.halfLinks.has(w)) return null;
  }
  return null;
}

/** A zone said in words within two words after a clock: "London time", "New Yorker Zeit", "Ortszeit". */
function zoneInWordsAt(c: FormContext, j: number): number | null {
  const { zoneTime, zoneEnding, zoneEndingNot } = c.lex;
  for (let k = j; k <= j + 1; k += 1) {
    const w = word(look(c.r, k));
    if (w === "") return null;
    if (zoneTime.has(w)) return k + 1;
    if (
      zoneEnding !== null &&
      w.length > zoneEnding.length + 1 &&
      w.endsWith(zoneEnding) &&
      !zoneEndingNot.has(w)
    )
      if (word(look(c.r, k + 1)) === "zeit") return k + 2;
  }
  return null;
}

/** A zone word after a clock, with its offset and brackets: `CET`, `(UTC+1)`, `PT`, `(ET)`, `London time`. */
function zoneAt(c: FormContext, j: number): number | null {
  const open = isMark(look(c.r, j), "(") ? 1 : 0;
  const w = word(look(c.r, j + open));
  if (!ZONE_WORDS.has(w) && !c.lex.zoneWords.has(w)) return zoneInWordsAt(c, j + open);
  let k = j + open + 1;
  const sign = look(c.r, k);
  if ((isMark(sign, "+") || isMark(sign, "-") || isMark(sign, "−")) && look(c.r, k + 1)?.kind === "num")
    k += 2;
  if (open === 1 && isMark(look(c.r, k), ")")) k += 1;
  return k;
}

/** A clock time starting at token `i`, with its end when a range gives one, or `null`. */
export function readClockAt(c: FormContext, i: number): ClockMatch | null {
  // An amount, the minutes of "1.5" or "3:2", and an end with no start ("bis 17 Uhr") start no clock.
  if (c.joinedBehind) return null;
  if (CURRENCY.has(c.prev)) return noStartAt(c, i);
  const t = look(c.r, i);
  if (t === undefined) return null;
  if (c.endOnly) return c.endPassed ? endOnlyAt(c, i) : noStartAt(c, i);
  if (t.kind === "word") {
    if (c.lex.language !== "en" || !NOON_WORDS.has(t.low)) return null;
    // "noon-5pm", "from noon to 9pm": the end is passed over with it, never read as a start (and, as
    // "from noon to 3pm" always read, not as an end).
    const range = rangeAt(c, i + 1, true);
    return finish(
      c,
      i,
      { at: { hour: 12, minute: 0 }, cap: false, either: false },
      null,
      range?.next ?? i + 1,
    );
  }
  const first = faceAt(c, i, false);
  if (first !== null) {
    const range = rangeAt(c, first.next, false);
    const after = halfAfter(c, range?.next ?? first.next);
    const half = after?.half ?? c.halfBefore;
    if (nightUnsure(first, half)) return null;
    const end = range === null ? null : settled(c, range.face, half).at;
    return finish(c, i, settled(c, first, half), end, after?.next ?? range?.next ?? first.next);
  }
  // `7–9pm`, `10 bis 12 Uhr`: a lone hour takes the half its end names.
  const lone = faceAt(c, i, true);
  if (lone === null) return null;
  const range = rangeAt(c, lone.next, true);
  if (range === null) return null;
  // An hour past twelve takes no `pm`: "21.11 - 9pm", "13-2pm", "Court 14 - 7pm-9pm" are no range.
  const pastTwelve = (range.face.half === "am" || range.face.half === "pm") && lone.hour > 12;
  if (c.numbered || pastTwelve || labelled(c, i, lone, range) || chained(c, range)) {
    // "Raum 5 – 14–16 Uhr", "Room 3 - 2pm - 4pm", "Court 14 - 7pm-9pm", "5 – 12pm-9pm": the number is
    // not the hour, and what follows its dash is read as a clock of its own. With an end of its own it is
    // the range; a clock alone ("Raum 5 – 17 Uhr", "13-2pm", "Teil 2 – 14 Uhr"), or one whose half is
    // only guessed ("room 5 – 7:30 till 21:30"), is passed over to its end, so that no part of it is read
    // as a start; "Gleis 3 – 5" is no clock. What follows is read without a word before it, and a chain
    // only before a marked or colon face, which no lone hour starts: it reads no deeper than twice.
    const sep = look(c.r, lone.next);
    const tight = joined(look(c.r, lone.next - 1), sep) && joined(sep, look(c.r, lone.next + 1));
    const pairBehind = tight && lone.next === i + 1 && sep?.kind === "mark" && DASHES.has(sep.low);
    const own = readClockAt(
      {
        ...c,
        prev: "",
        numbered: false,
        plainBefore: false,
        pairBehind,
        endOnly: false,
        endPassed: false,
        joinedBehind: false,
      },
      lone.next + 1,
    );
    if (own === null)
      return pastTwelve && !c.numbered ? passedOver(i, onClock(lone), range.next, "range") : null;
    // "Halle 1–2 – 9 Uhr", "Kurs 1–2 – 14 Uhr": a tight dash joins two numbers of the word; the second
    // starts no range.
    const pair =
      (c.numbered || c.plainBefore) &&
      tight &&
      own.start === lone.next + 1 &&
      faceAt(c, lone.next + 1, false) === null;
    if (own.passed === null && own.end !== null && !own.capGuess && !pair) return own;
    return passedOver(i, onClock(lone), own.next, "range");
  }
  if (range.face.half === null) return range.face.colon ? colonEndAt(c, i, lone, range) : null;
  const after = halfAfter(c, range.next);
  const half = after?.half ?? c.halfBefore;
  if (nightUnsure(range.face, half)) return null;
  const end = settled(c, range.face, half).at;
  let at = settled(c, { ...lone, half: range.face.half }, half).at;
  if (minutesOf(at) >= minutesOf(end)) at = onClock({ ...lone, half: null });
  return finish(c, i, { at, cap: false, either: false }, end, after?.next ?? range.next);
}

interface Range {
  readonly face: Face;
  readonly next: number;
}

/**
 * "Teil 2 – 14 Uhr", "table for 4 - 7pm": a lone hour up to twelve after a plain word, before a spaced
 * dash, is the word's number, as after "Raum"; so is any lone number after one before a dash and a colon
 * clock with no marker ("court 5-7:30"). "Frühstück 7 – 9 Uhr" is read so too: the whole day.
 */
function labelled(c: FormContext, i: number, lone: Face, range: Range): boolean {
  if (!c.plainBefore || lone.next !== i + 1) return false;
  const sep = look(c.r, lone.next);
  if (sep?.kind !== "mark" || !DASHES.has(sep.low)) return false;
  if (range.face.half === null && range.face.colon) return true;
  const before = joined(look(c.r, i), sep);
  const after = joined(sep, look(c.r, lone.next + 1));
  // "Kurs 1–2 – 14 Uhr": a pair of numbers before a spaced dash is the word's too.
  if (before && after) return range.face.half === null && !range.face.colon && spacedDashAt(c, range.next);
  return lone.hour <= 12 && !before && !after;
}

/** A dash with a space on each side at token `j`. */
function spacedDashAt(c: FormContext, j: number): boolean {
  const d = look(c.r, j);
  return (
    d?.kind === "mark" && DASHES.has(d.low) && !joined(look(c.r, j - 1), d) && !joined(d, look(c.r, j + 1))
  );
}

/** "5 – 12pm-9pm", "14 – 19.30 Uhr-21 Uhr": after the number's dash a clock that a dash joins to more. */
const chained = (c: FormContext, range: Range): boolean =>
  (range.face.half !== null || range.face.colon) && rangeAt(c, range.next, true) !== null;

/**
 * "14-15:30", "19–21:30", "between 7 and 9:30": a lone hour and an end with minutes by colon and no
 * marker. The start is read as the end is: the range, when the hour as written is before the end and both
 * read in one half of the day. Else the words are passed over whole, so that the end is never read as a
 * start ("7-9:30" reads 7 in the afternoon and 9:30 in the morning: the whole day). After "to" or "bis"
 * ("9 to 17:00") the end stays one with no start.
 */
function colonEndAt(c: FormContext, i: number, lone: Face, range: Range): ClockMatch | null {
  // "9 to 17:00": an end with no start. "1–2 – 7:30": the hour ends a pair, and the clock is its own.
  // "2 – 19:30 - 21 Uhr": the colon clock starts a range of its own. Each is left to the walk, as before.
  const sep = look(c.r, lone.next);
  const tight = joined(look(c.r, lone.next - 1), sep) && joined(sep, look(c.r, lone.next + 1));
  if (RANGE_WORDS.has(word(sep)) || (c.pairBehind && !tight) || rangeAt(c, range.next, true) !== null)
    return null;
  const after = halfAfter(c, range.next);
  const half = after?.half ?? c.halfBefore;
  const next = after?.next ?? range.next;
  // "5-7-9:30": a chain of three numbers; "11-1:30 at night": the night after which day? Passed over whole.
  if (c.pairBehind || nightUnsure(range.face, half)) return passedOver(i, onClock(lone), next, "range");
  const end = settled(c, range.face, half);
  const start = settled(c, { ...lone, colon: true }, half);
  const before = lone.hour * 60 + lone.minute < range.face.hour * 60 + range.face.minute;
  // Both in one half of the day: "7-9:30" reads 7 in the afternoon and 9:30 in the morning, "night 5 –
  // 7:30" moves the end and not the start.
  const oneHalf = start.at.hour - lone.hour === end.at.hour - range.face.hour;
  if (!before || !oneHalf || minutesOf(start.at) >= minutesOf(end.at))
    return passedOver(i, onClock(lone), next, "range");
  const either = start.either || end.either;
  return finish(
    c,
    i,
    { at: start.at, cap: start.cap || end.cap, either, shiftable: start.shiftable },
    end.at,
    next,
  );
}

/**
 * `– 22:00`, `to 9pm`, `bis 12 Uhr` after a start, and `and 4pm` after one that follows "between";
 * `bare` admits a lone hour as the end.
 */
function rangeAt(c: FormContext, j: number, bare: boolean): Range | null {
  const sep = look(c.r, j);
  const [between, and] = c.lex.betweenAnd;
  const joins = RANGE_WORDS.has(word(sep)) || (c.prev === between && word(sep) === and);
  if (!((sep?.kind === "mark" && DASHES.has(sep.low)) || joins)) return null;
  const face = faceAt(c, j + 1, bare);
  return face === null ? null : { face, next: face.next };
}

/** The words from token `i` to `next`, passed over whole: no clock, no end. */
function passedOver(i: number, at: Clock, next: number, passed: "range" | "end"): ClockMatch {
  const none = { capGuess: false, eitherHalf: false, otherZone: false, shiftable: false };
  return { at, end: null, ...none, passed, start: i, next };
}

/**
 * An amount or an end with no start ("$ 7", "bis 17 Uhr") is no clock. When a dash or a range word joins
 * more to it ("bis 17–18 Uhr", "$ 7-9pm"), all of it is passed over, so that no part of it is read as a start.
 */
function noStartAt(c: FormContext, i: number): ClockMatch | null {
  const noon = c.lex.language === "en" && NOON_WORDS.has(word(look(c.r, i)));
  const lone = noon ? null : faceAt(c, i, true);
  if (!noon && lone === null) return null;
  return rangeAt(c, lone?.next ?? i + 1, true) === null ? null : endOnlyAt(c, i);
}

/** An end with no start after "up to" ("up to 5pm", "up to noon"), and every range a dash joins to it: passed over. */
function endOnlyAt(c: FormContext, i: number): ClockMatch | null {
  const noon = c.lex.language === "en" && NOON_WORDS.has(word(look(c.r, i)));
  const lone = noon ? null : faceAt(c, i, true);
  if (!noon && lone === null) return null;
  let next = lone === null ? i + 1 : lone.next;
  for (let range = rangeAt(c, next, true); range !== null; range = rangeAt(c, next, true)) next = range.next;
  return passedOver(i, lone === null ? { hour: 12, minute: 0 } : onClock(lone), next, "end");
}

function finish(
  c: FormContext,
  i: number,
  start: Settled,
  rangeEnd: Clock | null,
  next: number,
): ClockMatch | null {
  if (DURATION_WORDS.has(word(look(c.r, next)))) return null;
  const zone = zoneAt(c, next);
  const end = rangeEnd !== null && minutesOf(rangeEnd) > minutesOf(start.at) ? rangeEnd : null;
  return {
    at: start.at,
    end,
    capGuess: start.cap,
    eitherHalf: start.either,
    otherZone: zone !== null,
    shiftable: start.shiftable === true,
    passed: null,
    start: i,
    next: zone ?? next,
  };
}
