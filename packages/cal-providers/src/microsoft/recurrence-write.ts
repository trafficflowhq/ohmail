import {
  dayNumber,
  MS_PER_DAY,
  wallIn,
  type EventTime,
  type PlainDate,
  type RRule,
  type Wall,
  type ZoneSource,
} from "@ohmail/cal-core";
import type { Json } from "../json-answers.js";

const weekdays = {
  SU: "sunday",
  MO: "monday",
  TU: "tuesday",
  WE: "wednesday",
  TH: "thursday",
  FR: "friday",
  SA: "saturday",
} as const;
const indexes: Readonly<Record<number, string>> = {
  1: "first",
  2: "second",
  3: "third",
  4: "fourth",
  [-1]: "last",
};

type Day = Pick<PlainDate, "year" | "month" | "day">;
const wallDate = (ms: number): Day => {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};
const utcDay = (d: Day): number => dayNumber(d) * MS_PER_DAY;

const dateName = (d: Day): string =>
  `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

export const priorDate = (d: Day): string => dateName(wallDate(utcDay(d) - MS_PER_DAY));

export function dateOfTime(time: EventTime): Day | null {
  if (time.kind === "date") return time;
  if (time.kind === "zoned") return time.wall;
  return time.kind === "instant" && Number.isFinite(time.epochMs) ? wallDate(time.epochMs) : null;
}

/** Graph clamps an absolute day to the month's end. Accept an RFC rule only when it says the same. */
function absoluteDay(rule: RRule, start: Day): number | null {
  const last = rule.byMonthDay.at(-1) ?? start.day;
  if (last < 1 || last > 31) return null;
  if (rule.byMonthDay.length <= 1 && rule.bySetPos.length === 0 && last <= 28) return last;
  return rule.bySetPos.length === 1 &&
    rule.bySetPos[0] === -1 &&
    last >= 29 &&
    rule.byMonthDay.length === last - 27 &&
    rule.byMonthDay.every((day, index) => day === 28 + index)
    ? last
    : null;
}

function patternFor(rule: RRule, start: Day): Json | null {
  if (
    rule.bySecond.length ||
    rule.byMinute.length ||
    rule.byHour.length ||
    rule.byYearDay.length ||
    rule.byWeekNo.length
  )
    return null;
  const interval = rule.interval;
  const daysOfWeek = rule.byDay.map((day) => weekdays[day.weekday]);
  const plainDays = rule.byDay.every((day) => day.ordinal === 0);
  const startWeekday = Object.values(weekdays)[new Date(utcDay(start)).getUTCDay()]!;
  if (rule.freq === "DAILY" || rule.freq === "WEEKLY") {
    if (rule.byMonth.length || rule.byMonthDay.length || rule.bySetPos.length || !plainDays) return null;
    if (rule.freq === "DAILY" && daysOfWeek.length === 0) return { type: "daily", interval };
    if (rule.freq === "DAILY" && interval !== 1) return null;
    return {
      type: "weekly",
      interval,
      firstDayOfWeek: weekdays[rule.weekStart],
      daysOfWeek: daysOfWeek.length ? daysOfWeek : [startWeekday],
    };
  }
  const yearly = rule.freq === "YEARLY";
  if ((!yearly && rule.freq !== "MONTHLY") || rule.byMonth.length > Number(yearly)) return null;
  const month = rule.byMonth[0] ?? start.month;
  if (daysOfWeek.length === 0) {
    const dayOfMonth = absoluteDay(rule, start);
    if (dayOfMonth === null) return null;
    return yearly
      ? { type: "absoluteYearly", interval, dayOfMonth, month }
      : { type: "absoluteMonthly", interval, dayOfMonth };
  }
  if (rule.byMonthDay.length || (yearly && rule.byMonth.length !== 1)) return null;
  const ordinal =
    plainDays && rule.bySetPos.length === 1
      ? rule.bySetPos[0]!
      : rule.byDay.length === 1 && rule.bySetPos.length === 0
        ? rule.byDay[0]!.ordinal
        : 0;
  const index = indexes[ordinal];
  if (index === undefined) return null;
  return yearly
    ? { type: "relativeYearly", interval, daysOfWeek, index, month }
    : { type: "relativeMonthly", interval, daysOfWeek, index };
}

/** Graph ends by local date. A timed UNTIL before the series' clock time excludes that date. */
function lastDate(until: NonNullable<RRule["until"]>, start: EventTime, zones: ZoneSource): string | null {
  if (until.kind === "date") return dateName(until);
  const end =
    until.kind === "floating"
      ? until.wall
      : wallIn(until.epochMs, start.kind === "zoned" ? start.tzid : "Etc/UTC", zones);
  const time =
    start.kind === "zoned"
      ? start.wall
      : start.kind === "instant"
        ? wallIn(start.epochMs, "Etc/UTC", zones)
        : null;
  if (end === null || time === null) return null;
  const second = (w: Wall): number => (w.hour * 60 + w.minute) * 60 + w.second;
  return second(end) < second(time) ? priorDate(end) : dateName(end);
}

export function recurrenceFor(rule: RRule, start: EventTime, zones: ZoneSource): Json | null {
  const day = dateOfTime(start);
  if (day === null) return null;
  const pattern = patternFor(rule, day);
  if (pattern === null) return null;
  const startDate = dateName(day);
  const recurrenceTimeZone = start.kind === "zoned" ? start.tzid : "UTC";
  const range = { startDate, recurrenceTimeZone };
  if (rule.until !== null) {
    const endDate = lastDate(rule.until, start, zones);
    return endDate === null || endDate < startDate
      ? null
      : { pattern, range: { ...range, type: "endDate", endDate } };
  }
  return rule.count === null
    ? { pattern, range: { ...range, type: "noEnd" } }
    : { pattern, range: { ...range, type: "numbered", numberOfOccurrences: rule.count } };
}
