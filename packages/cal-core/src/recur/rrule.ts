/**
 * A recurrence rule (RFC 5545 section 3.3.10) read into a value and written back. A rule this
 * reader does not understand whole is `null`: a repeat drawn wrong is worse than a repeat not drawn,
 * and the rule's own text stays in the calendar's tree either way.
 */
import { parseDate, parseDateTime, formatDate, formatInstant, formatWall } from "../ical/values.js";
import { MS_PER_SECOND, wallSeconds, WEEKDAYS, type Weekday } from "../time/arith.js";
import type { FloatingTime, Instant, PlainDate } from "../time/types.js";

export type Frequency = "SECONDLY" | "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
const FREQUENCIES: readonly Frequency[] = ["SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
/**
 * The list of a part a rule does not write, one for every rule and never changed. A rule writes two
 * or three of its nine lists: an empty list of its own for each of the others was most of what a
 * rule held, and a text of nothing but short rules was held in forty times its size.
 */
const NONE: readonly never[] = Object.freeze([]);

/** `ordinal` 0 is every such weekday; 1 the first, -1 the last of the month or the year. */
export interface ByDay {
  readonly ordinal: number;
  readonly weekday: Weekday;
}

/** A rule's end as it was written: a day, a moment, or a clock time with no zone. */
export type Until = PlainDate | Instant | FloatingTime;

export interface RRule {
  readonly freq: Frequency;
  readonly interval: number;
  readonly count: number | null;
  readonly until: Until | null;
  readonly bySecond: readonly number[];
  readonly byMinute: readonly number[];
  readonly byHour: readonly number[];
  readonly byDay: readonly ByDay[];
  readonly byMonthDay: readonly number[];
  readonly byYearDay: readonly number[];
  readonly byWeekNo: readonly number[];
  readonly byMonth: readonly number[];
  readonly bySetPos: readonly number[];
  /** WKST: the day a week begins on. Monday unless the rule says otherwise. */
  readonly weekStart: Weekday;
}

/** The largest INTERVAL and COUNT read: beyond a million neither names a calendar anybody keeps. */
const MAX_RULE_NUMBER = 1_000_000;

/** The numbers a list names, each once, in the order first written. A member written again is told by one look, however long the list. */
function numbers(value: string, min: number, max: number, signed: boolean): number[] | null {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of value.split(",")) {
    if (!/^[+-]?\d{1,3}$/.test(part.trim())) return null;
    const n = Number(part);
    const size = Math.abs(n);
    if (size < min || size > max || (n < 0 && !signed) || (signed && n === 0)) return null;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function byDays(value: string): ByDay[] | null {
  const out: ByDay[] = [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(part.trim().toUpperCase());
    if (!m) return null;
    const ordinal = m[1] === undefined ? 0 : Number(m[1]);
    if (m[1] !== undefined && (ordinal === 0 || Math.abs(ordinal) > 53)) return null;
    // Told apart by number and weekday, of which there are 749: `+1MO` and `1MO` are one.
    const id = `${ordinal}${m[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ordinal, weekday: m[2] as Weekday });
  }
  return out;
}

/** Every part a rule can have. A part of another name makes a rule this reader cannot follow, and is not held to find that out. */
const PART_NAMES: ReadonlySet<string> = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYSECOND", "BYMINUTE", "BYHOUR", "BYDAY", "BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYMONTH", "BYSETPOS", "WKST", "RSCALE", "SKIP"]);

function until(value: string): Until | null {
  const day = parseDate(value);
  if (day !== null) return day;
  const at = parseDateTime(value);
  if (at === null) return null;
  return at.utc ? { kind: "instant", epochMs: wallSeconds(at.wall) * MS_PER_SECOND } : { kind: "floating", wall: at.wall };
}

/** The rule a RRULE value holds, or `null` when it is not one this reader can follow exactly. */
export function parseRRule(value: string): RRule | null {
  const parts = new Map<string, string>();
  for (const segment of value.trim().split(";")) {
    if (segment.trim() === "") continue;
    const eq = segment.indexOf("=");
    if (eq <= 0) return null;
    const key = segment.slice(0, eq).trim().toUpperCase();
    if (!PART_NAMES.has(key) || parts.has(key)) return null;
    parts.set(key, segment.slice(eq + 1).trim());
  }
  const take = (key: string): string | undefined => {
    const v = parts.get(key);
    parts.delete(key);
    return v;
  };
  // The word itself is the table's, not a piece of the text read.
  const written = (take("FREQ") ?? "").toUpperCase();
  const freq = FREQUENCIES.find((f) => f === written);
  if (freq === undefined) return null;
  const whole = (key: string, fallback: number | null): number | null | undefined => {
    const v = take(key);
    if (v === undefined) return fallback;
    return /^\d{1,7}$/.test(v) && Number(v) >= 1 && Number(v) <= MAX_RULE_NUMBER ? Number(v) : undefined;
  };
  const interval = whole("INTERVAL", 1);
  const count = whole("COUNT", null);
  if (interval === undefined || interval === null || count === undefined) return null;
  const list = (key: string, min: number, max: number, signed: boolean): readonly number[] | null => {
    const v = take(key);
    return v === undefined ? NONE : numbers(v, min, max, signed);
  };
  const untilText = take("UNTIL");
  const end = untilText === undefined ? null : until(untilText.toUpperCase());
  const dayText = take("BYDAY");
  const days: readonly ByDay[] | null = dayText === undefined ? NONE : byDays(dayText);
  const weekStartText = (take("WKST") ?? "MO").toUpperCase();
  const weekStart = WEEKDAYS.find((d) => d === weekStartText);
  const lists = {
    bySecond: list("BYSECOND", 0, 59, false),
    byMinute: list("BYMINUTE", 0, 59, false),
    byHour: list("BYHOUR", 0, 23, false),
    byMonthDay: list("BYMONTHDAY", 1, 31, true),
    byYearDay: list("BYYEARDAY", 1, 366, true),
    byWeekNo: list("BYWEEKNO", 1, 53, true),
    byMonth: list("BYMONTH", 1, 12, false),
    bySetPos: list("BYSETPOS", 1, 366, true),
  };
  // RFC 7529's calendar scale: the Gregorian one, skipping nothing, is the rule as it stands.
  const scale = take("RSCALE");
  const skip = take("SKIP");
  if ((scale !== undefined && scale.toUpperCase() !== "GREGORIAN") || (skip !== undefined && skip.toUpperCase() !== "OMIT")) return null;
  if (parts.size > 0 || days === null || (untilText !== undefined && end === null) || weekStart === undefined) return null;
  // "The UNTIL or COUNT rule parts are OPTIONAL, but they MUST NOT occur in the same 'recur'": which of the two ends such a rule is nobody's to guess.
  if (count !== null && end !== null) return null;
  for (const v of Object.values(lists)) if (v === null) return null;
  // A numbered weekday means something only in a month or a year, and not beside week numbers.
  const numbered = days.some((d) => d.ordinal !== 0);
  if (numbered && ((freq !== "MONTHLY" && freq !== "YEARLY") || lists.byWeekNo!.length > 0)) return null;
  return {
    freq,
    interval,
    count,
    until: end,
    bySecond: lists.bySecond!,
    byMinute: lists.byMinute!,
    byHour: lists.byHour!,
    byDay: days,
    byMonthDay: lists.byMonthDay!,
    byYearDay: lists.byYearDay!,
    byWeekNo: lists.byWeekNo!,
    byMonth: lists.byMonth!,
    bySetPos: lists.bySetPos!,
    weekStart,
  };
}

/** A rule as a RRULE value, parts in the standard's order, defaults left out. */
export function formatRRule(rule: RRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== null) {
    const u = rule.until;
    parts.push(`UNTIL=${u.kind === "date" ? formatDate(u) : u.kind === "instant" ? formatInstant(u.epochMs) : formatWall(u.wall)}`);
  }
  const list = (key: string, values: readonly number[]): void => {
    if (values.length > 0) parts.push(`${key}=${values.join(",")}`);
  };
  list("BYSECOND", rule.bySecond);
  list("BYMINUTE", rule.byMinute);
  list("BYHOUR", rule.byHour);
  if (rule.byDay.length > 0) parts.push(`BYDAY=${rule.byDay.map((d) => `${d.ordinal === 0 ? "" : d.ordinal}${d.weekday}`).join(",")}`);
  list("BYMONTHDAY", rule.byMonthDay);
  list("BYYEARDAY", rule.byYearDay);
  list("BYWEEKNO", rule.byWeekNo);
  list("BYMONTH", rule.byMonth);
  list("BYSETPOS", rule.bySetPos);
  if (rule.weekStart !== "MO") parts.push(`WKST=${rule.weekStart}`);
  return parts.join(";");
}
