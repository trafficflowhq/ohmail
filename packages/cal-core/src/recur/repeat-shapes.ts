import { eventOf, newEventComponent } from "../ical/event.js";
import { momentOrUtc } from "../stored/time.js";
import { daysInMonth, wallFromSeconds } from "../time/arith.js";
import { instant, type EventTime, type ZoneSource } from "../time/types.js";
import type { RRule } from "./rrule.js";
import { expandSeries, seriesOf } from "./series.js";

/** The repeats a person can make, as the proof names them. */
export type RepeatBase =
  | "daily"
  | "every_n_days"
  | "weekdays"
  | "weekly"
  | "weeks_on_days"
  | "monthly_by_date"
  | "monthly_late_date"
  | "monthly_nth_weekday"
  | "monthly_last_weekday"
  | "yearly_by_date"
  | "yearly_by_weekday";

/** How the series ends: on a day (`UNTIL`), after a number of times (`COUNT`), or never. */
export type RepeatEnd = "until" | "count" | "never";

export type RepeatShape = `${RepeatBase}/${RepeatEnd}`;
export type DraftRepeatShape = RepeatShape | `yearly_leap_date/${RepeatEnd}`;

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR"];

/** A position among a single weekday in one month is the same as an ordinal weekday. */
export function normalizeRepeatPosition(rule: RRule): RRule {
  const day = rule.byDay[0];
  const position = rule.bySetPos[0];
  if (
    (rule.freq !== "MONTHLY" && !(rule.freq === "YEARLY" && rule.byMonth.length === 1)) ||
    rule.byDay.length !== 1 ||
    day?.ordinal !== 0 ||
    rule.bySetPos.length !== 1 ||
    position === undefined ||
    Math.abs(position) > 5 ||
    rule.byMonthDay.length ||
    rule.byYearDay.length ||
    rule.byWeekNo.length ||
    rule.byHour.length ||
    rule.byMinute.length ||
    rule.bySecond.length
  )
    return rule;
  return { ...rule, byDay: [{ weekday: day.weekday, ordinal: position }], bySetPos: [] };
}

/** Only these parts are taken: a rule with any other (hours, minutes, week numbers, days of the year, positions) has no shape. */
function plain(rule: RRule): boolean {
  return (
    rule.bySecond.length === 0 &&
    rule.byMinute.length === 0 &&
    rule.byHour.length === 0 &&
    rule.byYearDay.length === 0 &&
    rule.byWeekNo.length === 0 &&
    rule.bySetPos.length === 0 &&
    rule.weekStart === "MO"
  );
}

function baseOf(rule: RRule, customIntervals = false): RepeatBase | null {
  if (!plain(rule)) return null;
  const days = rule.byDay;
  const plainDays = days.every((d) => d.ordinal === 0);
  switch (rule.freq) {
    case "DAILY":
      if (rule.byMonthDay.length > 0 || rule.byMonth.length > 0) return null;
      if (days.length === 0) return rule.interval === 1 ? "daily" : "every_n_days";
      return rule.interval === 1 &&
        plainDays &&
        days.length === 5 &&
        days.every((d) => WEEKDAYS.includes(d.weekday))
        ? "weekdays"
        : null;
    case "WEEKLY":
      if (rule.byMonthDay.length > 0 || rule.byMonth.length > 0 || !plainDays) return null;
      if (rule.interval === 1 && days.length === 5 && days.every((d) => WEEKDAYS.includes(d.weekday)))
        return "weekdays";
      if (rule.interval === 1 && days.length <= 1) return "weekly";
      return customIntervals || rule.interval <= 2 ? "weeks_on_days" : null;
    case "MONTHLY":
      if ((!customIntervals && rule.interval !== 1) || rule.byMonth.length > 0) return null;
      if (days.length === 0) {
        if (rule.byMonthDay.length === 0) return "monthly_by_date";
        if (rule.byMonthDay.length !== 1) return null;
        const d = rule.byMonthDay[0]!;
        return d >= 1 && d <= 28 ? "monthly_by_date" : d >= 29 ? "monthly_late_date" : null;
      }
      if (rule.byMonthDay.length > 0 || days.length !== 1) return null;
      return days[0]!.ordinal === -1
        ? "monthly_last_weekday"
        : days[0]!.ordinal >= 1 && days[0]!.ordinal <= 4
          ? "monthly_nth_weekday"
          : null;
    case "YEARLY":
      if ((!customIntervals && rule.interval !== 1) || rule.byMonth.length > 1) return null;
      if (days.length === 0) return rule.byMonthDay.length <= 1 ? "yearly_by_date" : null;
      return rule.byMonthDay.length === 0 &&
        rule.byMonth.length === 1 &&
        days.length === 1 &&
        days[0]!.ordinal !== 0
        ? "yearly_by_weekday"
        : null;
    default:
      return null;
  }
}

/** The shape of a rule, or `null` for one outside the list: such a rule is proven nowhere. */
export function repeatShapeOf(rule: RRule): RepeatShape | null {
  const base = baseOf(rule);
  if (base === null) return null;
  return `${base}/${rule.until !== null ? "until" : rule.count !== null ? "count" : "never"}`;
}

const WEEK = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** The day a series starts on, on its own clock. An edit can also keep a stored UTC series. */
function startDay(
  start: EventTime,
  allowUtc: boolean,
): { readonly year: number; readonly month: number; readonly day: number } | null {
  if (start.kind === "date") return start;
  if (start.kind === "zoned") return start.wall;
  return allowUtc && start.kind === "instant" && Number.isFinite(start.epochMs)
    ? wallFromSeconds(Math.floor(start.epochMs / 1000))
    : null;
}

/** Is the start's day one the rule names (its lists filled from the start where the rule leaves them unsaid)? */
function inStep(
  rule: RRule,
  base: RepeatBase,
  d: { readonly year: number; readonly month: number; readonly day: number },
): boolean {
  const weekday = WEEK[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()]!;
  const length = daysInMonth(d.year, d.month);
  /** Which such weekday of the month the day is, from the start (1) or from the end (-1). */
  const nth = (ordinal: number): boolean =>
    ordinal > 0
      ? Math.floor((d.day - 1) / 7) + 1 === ordinal
      : -(Math.floor((length - d.day) / 7) + 1) === ordinal;
  const days = rule.byDay;
  switch (base) {
    case "daily":
    case "every_n_days":
      return true;
    case "weekdays":
      return WEEKDAYS.includes(weekday);
    case "weekly":
    case "weeks_on_days":
      return days.length === 0 || days.some((x) => x.weekday === weekday);
    case "monthly_by_date":
    case "monthly_late_date":
      return rule.byMonthDay.length === 0 || rule.byMonthDay[0] === d.day;
    case "monthly_nth_weekday":
    case "monthly_last_weekday":
      return days[0]!.weekday === weekday && nth(days[0]!.ordinal);
    case "yearly_by_date":
      return (
        (rule.byMonth.length === 0 || rule.byMonth[0] === d.month) &&
        (rule.byMonthDay.length === 0 || rule.byMonthDay[0] === d.day)
      );
    case "yearly_by_weekday":
      return rule.byMonth[0] === d.month && days[0]!.weekday === weekday && nth(days[0]!.ordinal);
  }
}

const DAY_MS = 86_400_000;
/**
 * How far ahead from today a series with no end is held against the days its zone skips: ten years,
 * the span a written zone definition covers. Past it a series' days are not looked at: a day that
 * falls in a skipped hour there is placed as the server places it (an hour apart from the core,
 * where the server is the bench's).
 */
const SKIP_LOOK_DAYS = 3_660;
/** How far a series with a count is expanded to find its last day. */
const COUNT_LOOK_DAYS = 400 * 366;

/** The zone's forward jumps (its clocks skip a stretch) between two moments, each its first moment of the new offset and the offsets before and after; `null` for a zone the source does not know. */
function jumpsOf(
  tzid: string,
  fromMs: number,
  toMs: number,
  zones: ZoneSource,
): { readonly at: number; readonly before: number; readonly after: number }[] | null {
  const at = (ms: number): number | null => zones.offsetAt(tzid, ms);
  const out: { at: number; before: number; after: number }[] = [];
  for (let week = Math.floor(fromMs / DAY_MS) * DAY_MS - DAY_MS; week < toMs + DAY_MS; week += 7 * DAY_MS) {
    const [a, b] = [at(week), at(week + 7 * DAY_MS)];
    if (a === null || b === null) return null;
    if (b <= a) continue;
    for (let day = week; day < week + 7 * DAY_MS; day += DAY_MS) {
      const [before, after] = [at(day), at(day + DAY_MS)];
      if (before === null || after === null) return null;
      if (after <= before) continue;
      // The first moment of the new offset, to the second.
      let [lo, hi] = [day, day + DAY_MS];
      while (hi - lo > 1_000) {
        const mid = lo + Math.floor((hi - lo) / 2 / 1_000) * 1_000;
        if (at(mid) === before) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, before, after });
    }
  }
  return out;
}

/**
 * Does one of the series' own days, from `fromMs` to `toMs`, fall at a clock time its zone skips (its
 * clocks jump over it, as Europe/Zurich's skip 02:00 to 03:00 one Sunday night in March)? A day of
 * the series is one its rule names from its start; a jump on a day the rule does not name skips no
 * day of it. `null` where it cannot be said: a zone the source does not know, an expansion that
 * stops at its ceiling.
 */
function meetsSkippedClock(
  rule: RRule,
  start: Extract<EventTime, { kind: "zoned" }>,
  fromMs: number,
  toMs: number,
  zones: ZoneSource,
): boolean | null {
  const jumps = jumpsOf(start.tzid, fromMs, toMs, zones);
  if (jumps === null) return null;
  if (jumps.length === 0) return false;
  const [series] = seriesOf(
    [eventOf(newEventComponent({ uid: "skip", dtstamp: instant(0), start, end: start, rule }))],
    zones,
  );
  if (series === undefined) return null;
  const ofDay = ((start.wall.hour * 60 + start.wall.minute) * 60 + start.wall.second) * 1_000;
  for (const j of jumps) {
    // The clock times skipped, as clock times on the scale of UTC: from the jump's start to its end.
    const [lo, hi] = [j.at + j.before, j.at + j.after];
    for (const midnight of new Set([
      Math.floor(lo / DAY_MS) * DAY_MS,
      Math.floor((hi - 1) / DAY_MS) * DAY_MS,
    ])) {
      const clock = midnight + ofDay;
      if (clock < lo || clock >= hi) continue;
      // The series' clock time is skipped that day: is the day one of the series' own?
      const found = expandSeries(
        series,
        { startMs: j.at - 2 * DAY_MS, endMs: j.at + 2 * DAY_MS, viewerZone: start.tzid },
        zones,
      );
      if (found.capped) return null;
      const day = new Date(midnight);
      const own = found.occurrences.some(
        (o) =>
          o.start.kind === "zoned" &&
          o.start.wall.year === day.getUTCFullYear() &&
          o.start.wall.month === day.getUTCMonth() + 1 &&
          o.start.wall.day === day.getUTCDate(),
      );
      if (own) return true;
    }
  }
  return false;
}

/** How far a series runs, as a moment: its UNTIL's, its last day's for a count (`null` where the core cannot tell it), or `null` with no end. */
function lastOf(rule: RRule, start: EventTime, zones: ZoneSource): number | null | "unknown" {
  if (rule.until !== null) return momentOrUtc(rule.until, zones);
  if (rule.count === null) return null;
  const [series] = seriesOf(
    [eventOf(newEventComponent({ uid: "last", dtstamp: instant(0), start, end: start, rule }))],
    zones,
  );
  if (series === undefined) return "unknown";
  const from = momentOrUtc(start, zones);
  const found = expandSeries(
    series,
    { startMs: from - DAY_MS, endMs: from + COUNT_LOOK_DAYS * DAY_MS, viewerZone: "Etc/UTC" },
    zones,
  );
  const last = found.occurrences.at(-1);
  return found.capped || last === undefined ? "unknown" : momentOrUtc(last.start, zones);
}

/**
 * The shape of a series as it is written, from its start: `null` where no write may make it. Only a
 * series whose start is one of the rule's own days (RFC 5545: a start the rule does not name makes
 * a set that is "undefined"), whose end (`UNTIL`) is told as the start is and is not before it, and
 * whose start is a whole day or a clock time in a zone; a monthly rule that takes its day from a
 * start on the 29th or later is the late date's shape, whatever it names. A series one of whose own
 * days falls at a clock time its zone skips is no shape either (the bench's server places such a
 * day elsewhere than the calendar core does): its days are looked at from today (`nowMs`), or its
 * start where that is later, to its end (its UNTIL, its count's last day), or ten years on where it
 * has no end (past them nothing is looked at; see `SKIP_LOOK_DAYS`).
 */
export function repeatShapeAt(
  rule: RRule,
  start: EventTime,
  zones: ZoneSource,
  nowMs: number,
  allowUtc = false,
  customIntervals = false,
): RepeatShape | null {
  const base = baseOf(rule, customIntervals);
  const d = startDay(start, allowUtc);
  if (base === null || d === null || !inStep(rule, base, d)) return null;
  const u = rule.until;
  const from = momentOrUtc(start, zones);
  if (u !== null) {
    if (start.kind === "date" ? u.kind !== "date" : u.kind !== "instant") return null;
    const before =
      u.kind === "date"
        ? Date.UTC(u.year, u.month - 1, u.day) < Date.UTC(d.year, d.month - 1, d.day)
        : u.kind === "instant" && u.epochMs < from;
    if (before) return null;
  }
  if (start.kind === "zoned") {
    if (!Number.isFinite(from) || !Number.isFinite(nowMs)) return null;
    const looked = Math.max(from, nowMs);
    const last = lastOf(rule, start, zones);
    if (last === "unknown") return null;
    const to = last === null ? looked + SKIP_LOOK_DAYS * DAY_MS : last;
    if (to >= looked && meetsSkippedClock(rule, start, looked, to, zones) !== false) return null;
  }
  const late = base === "monthly_by_date" && rule.byMonthDay.length === 0 && d.day >= 29;
  return `${late ? "monthly_late_date" : base}/${u !== null ? "until" : rule.count !== null ? "count" : "never"}`;
}

/** Editor rules also include custom intervals. A leap date needs its own capability because some writers clamp it. */
export function draftRepeatShape(
  rule: RRule,
  start: EventTime,
  zones: ZoneSource,
  nowMs: number,
  allowUtc = false,
): DraftRepeatShape | null {
  const shape = repeatShapeAt(normalizeRepeatPosition(rule), start, zones, nowMs, allowUtc, true);
  if (!shape?.startsWith("yearly_by_date/")) return shape;
  const day = startDay(start, allowUtc);
  if (day?.month !== 2 || day.day !== 29) return shape;
  return `yearly_leap_date/${rule.until !== null ? "until" : rule.count !== null ? "count" : "never"}`;
}
