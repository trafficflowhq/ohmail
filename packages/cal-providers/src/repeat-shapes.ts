/**
 * WHICH REPEATS A PROVIDER WAS SEEN TO KEEP AS WRITTEN. A series is written only in a shape that was
 * written at that provider, read back from its own answer, and found equal to what the calendar
 * core expands: a provider that keeps a rule differently would move a person's days without saying
 * so. A shape is added to a provider's row only by the change that brings its recorded proof; every
 * other shape is `repeat_unsupported`, said and visible, never sent.
 */
import type { RRule } from "@ohmail/cal-core";
import type { ProviderWord } from "./port.js";

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

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR"];

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

function baseOf(rule: RRule): RepeatBase | null {
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
      return rule.interval <= 2 ? "weeks_on_days" : null;
    case "MONTHLY":
      if (rule.interval !== 1 || rule.byMonth.length > 0) return null;
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
      if (rule.interval !== 1 || rule.byMonth.length > 1) return null;
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

/**
 * The shapes each provider was proven to keep, by the recorded proof of the change that added the
 * row. Empty everywhere until the proof's run (written at the bench's CalDAV server and at the
 * Google and iCloud test accounts, read back, compared with the core's expansion) brings its rows.
 * Microsoft is built and not proven: its rows wait for a trial at Microsoft itself.
 */
export const PROVEN_REPEATS: Readonly<Record<ProviderWord, readonly RepeatShape[]>> = {
  google: [],
  caldav: [],
  microsoft: [],
  ics: [],
};

/** May a series of this rule be written at this provider? */
export function repeatProven(
  provider: ProviderWord,
  rule: RRule,
  proven: Readonly<Record<ProviderWord, readonly RepeatShape[]>> = PROVEN_REPEATS,
): boolean {
  const shape = repeatShapeOf(rule);
  return shape !== null && proven[provider].includes(shape);
}
