/**
 * A recurrence rule walked on the clock it was written for (RFC 5545 section 3.3.10). The walk
 * knows no zone: it hands back clock readings in order, and whoever asked turns each into an
 * instant. That is what keeps a class at six in the evening across a clock change.
 *
 * The standard's table of "expand" and "limit" comes out as one question asked of every day of a
 * period (a year, a month, a week or a day, by FREQ): is this day in the rule? What the rule leaves
 * unsaid is taken from the start, as the standard says: the weekday of a weekly rule, the day of a
 * monthly or yearly one. A day that does not exist (30 February, the 31st of a short month) is not
 * in any period and so is skipped, never moved.
 *
 * A rule is a stranger's text, so the walk counts what it does and ends by that count. A step is a
 * day it asks about (for a rule of hours, minutes or seconds: a period), a reading it hands back,
 * and a place BYSETPOS names in a period, whether the period has that many readings or not. Nothing
 * else is made: a rule's lists are sorted and turned into lookups once, before the first day is
 * asked, and the readings of a period are worked out one at a time, never laid out. A line whose
 * hour, minute and second lists multiply to more readings for a day than a line may name
 * (`MAX_CLOCK_READINGS_PER_DAY`) is not walked at all.
 */
import { MAX_CLOCK_READINGS_PER_DAY } from "../limits.js";
import { civilFromDays, dayOfYear, daysFromCivil, daysInMonth, daysInYear, wallFromSeconds, wallSeconds, weekdayOf, WEEKDAYS, weekOf, weeksInYear } from "../time/arith.js";
import type { Wall } from "../time/types.js";
import type { RRule } from "./rrule.js";

const SECONDS_PER_DAY = 86_400;
/** The last day a calendar has: 31 December 9999. */
const LAST_DAY = daysFromCivil(9999, 12, 31);

export interface WalkOptions {
  /** The start is a date: the rule's clock parts are ignored, as the standard demands. */
  readonly dateOnly: boolean;
  /** Periods that end before this reading are skipped unlooked-at. Used only where the rule has no COUNT. */
  readonly from?: Wall;
  /** The walk ends at the first period that begins after this reading, whether or not it found anything before. */
  readonly to?: Wall;
  /**
   * What the walk may spend: one step for every day it asks the rule about (a month the rule leaves out
   * is one; for a rule of hours, minutes or seconds every period is one), one for every reading it
   * hands back, and with BYSETPOS one for every place the rule names in a period that has readings.
   * A period that is opened is asked whole, so the count can pass this by one period's days and places.
   */
  readonly maxSteps: number;
  /** How many instances one period may hold: a year of every second is thirty-one million, and nobody asked for them. */
  readonly maxPerPeriod: number;
  /** How many clock readings the rule's own hour, minute and second lists may name for one day, multiplied. `MAX_CLOCK_READINGS_PER_DAY` when left out. */
  readonly maxPerDay?: number;
}

/** The ceiling a walk stopped at: its steps were spent, one period held more readings than a period may, or the rule's lists name more readings for a day than a rule may. */
export type WalkStop = "out_of_steps" | "too_many_in_a_period" | "rule_too_dense";

export interface RuleWalk {
  /** The next instance, later than the one before; `null` when the rule has ended, the walk has reached its end or has stopped at a ceiling. */
  next(): Wall | null;
  /** The walk stopped at a ceiling, not because the rule or the walk's range ended. */
  readonly capped: boolean;
  /** Which ceiling that was; `null` when it was none. */
  readonly stoppedBy: WalkStop | null;
  /** Steps spent so far. */
  readonly steps: number;
}

const sortedUnique = (values: readonly number[]): number[] => [...new Set(values)].sort((a, b) => a - b);

/** The rule with what it leaves unsaid filled in from its start. */
function withDefaults(rule: RRule, start: Wall): RRule {
  const startWeekday = WEEKDAYS[weekdayOf(daysFromCivil(start.year, start.month, start.day))]!;
  const names = (r: RRule): boolean => r.byDay.length > 0 || r.byMonthDay.length > 0 || r.byYearDay.length > 0;
  switch (rule.freq) {
    case "YEARLY":
      if (names(rule)) return rule;
      if (rule.byWeekNo.length > 0) return { ...rule, byDay: [{ ordinal: 0, weekday: startWeekday }] };
      return { ...rule, byMonth: rule.byMonth.length > 0 ? rule.byMonth : [start.month], byMonthDay: [start.day] };
    case "MONTHLY":
      return names(rule) || rule.byWeekNo.length > 0 ? rule : { ...rule, byMonthDay: [start.day] };
    case "WEEKLY":
      return names(rule) ? rule : { ...rule, byDay: [{ ordinal: 0, weekday: startWeekday }] };
    default:
      return rule;
  }
}

/** A rule's lists as lookups: `null` where the rule names nothing of the kind. A number from the end of a month, a year or a period is negative, as written. */
interface Plan {
  readonly months: ReadonlySet<number> | null;
  readonly monthDays: ReadonlySet<number> | null;
  readonly yearDays: ReadonlySet<number> | null;
  readonly weekNos: ReadonlySet<number> | null;
  /** By weekday, Monday first: named plain (`every`), and the numbers it is named with. */
  readonly weekdays: readonly ({ every: boolean; readonly ordinals: Set<number> } | null)[] | null;
  readonly hours: ReadonlySet<number> | null;
  readonly minutes: ReadonlySet<number> | null;
  readonly seconds: ReadonlySet<number> | null;
  /** The places BYSETPOS names, each once. */
  readonly positions: readonly number[] | null;
  /** The day a week begins on, Monday 0. */
  readonly weekStart: number;
}

const setOf = (values: readonly number[]): ReadonlySet<number> | null => (values.length > 0 ? new Set(values) : null);

function planOf(rule: RRule): Plan {
  let weekdays: ({ every: boolean; readonly ordinals: Set<number> } | null)[] | null = null;
  if (rule.byDay.length > 0) {
    weekdays = [null, null, null, null, null, null, null];
    for (const d of rule.byDay) {
      const held = (weekdays[WEEKDAYS.indexOf(d.weekday)] ??= { every: false, ordinals: new Set<number>() });
      if (d.ordinal === 0) held.every = true;
      else held.ordinals.add(d.ordinal);
    }
  }
  return {
    months: setOf(rule.byMonth),
    monthDays: setOf(rule.byMonthDay),
    yearDays: setOf(rule.byYearDay),
    weekNos: setOf(rule.byWeekNo),
    weekdays,
    hours: setOf(rule.byHour),
    minutes: setOf(rule.byMinute),
    seconds: setOf(rule.bySecond),
    positions: rule.bySetPos.length > 0 ? [...new Set(rule.bySetPos)] : null,
    weekStart: WEEKDAYS.indexOf(rule.weekStart),
  };
}

/** Is `n`, or its place counted from the end of `length`, in the list? */
const named = (list: ReadonlySet<number>, n: number, length: number): boolean => list.has(n) || list.has(n - length - 1);

/** Is this day one the rule names? `inMonth`: a numbered weekday counts within its month, else within its year. */
function dayIsIn(plan: Plan, days: number, inMonth: boolean): boolean {
  const { year, month, day } = civilFromDays(days);
  if (plan.months !== null && !plan.months.has(month)) return false;
  const monthLength = daysInMonth(year, month);
  if (plan.monthDays !== null && !named(plan.monthDays, day, monthLength)) return false;
  const ofYear = dayOfYear(year, month, day);
  const yearLength = daysInYear(year);
  if (plan.yearDays !== null && !named(plan.yearDays, ofYear, yearLength)) return false;
  if (plan.weekNos !== null) {
    const { weekYear, week } = weekOf(days, plan.weekStart);
    if (!named(plan.weekNos, week, weeksInYear(weekYear, plan.weekStart))) return false;
  }
  if (plan.weekdays !== null) {
    const weekday = plan.weekdays[weekdayOf(days)];
    if (weekday === null || weekday === undefined) return false;
    if (!weekday.every) {
      const [position, length] = inMonth ? [day, monthLength] : [ofYear, yearLength];
      // The first Monday is 1, the last is -1: which one this day is, counted from either end.
      if (!weekday.ordinals.has(Math.floor((position - 1) / 7) + 1) && !weekday.ordinals.has(-(Math.floor((length - position) / 7) + 1))) return false;
    }
  }
  return true;
}

/**
 * One period's readings in order, as seconds on the clock scale: how many there are, and which the
 * n-th is. None is made before it is asked for: a period of a thousand readings of which the walk
 * hands back one costs that one.
 */
interface Period {
  readonly count: number;
  at(n: number): number;
}
const NOTHING: Period = { count: 0, at: () => 0 };

/** Where the places BYSETPOS names lie among `count` readings in order (1 is the first, -1 the last): in order, each once. */
function placesIn(count: number, positions: readonly number[]): number[] {
  const places: number[] = [];
  for (const p of positions) {
    const n = p > 0 ? p - 1 : count + p;
    if (n >= 0 && n < count) places.push(n);
  }
  return sortedUnique(places);
}

/** How many of a period's readings are at or before `second`: found by halving, the readings are in order. */
function upTo(period: Period, second: number): number {
  let [lo, hi] = [0, period.count];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (period.at(mid) <= second) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The walk of a line that is not walked: its start where a walk hands the start back, and then the
 * word for why there is no more. None of the line's lists is looked at.
 */
function unwalked(rule: RRule, start: Wall, options: WalkOptions): RuleWalk {
  const later = rule.count === null && options.from !== undefined && wallSeconds(options.from) > wallSeconds(start);
  let [steps, over] = [0, false];
  let stoppedBy: WalkStop | null = null;
  return {
    get capped() {
      return stoppedBy !== null;
    },
    get stoppedBy() {
      return stoppedBy;
    },
    get steps() {
      return steps;
    },
    next(): Wall | null {
      if (over) return null;
      if (!later && steps === 0) {
        steps = 1;
        // A rule of one instance has ended with its start, and met no ceiling.
        over = rule.count === 1;
        return start;
      }
      over = true;
      stoppedBy = "rule_too_dense";
      return null;
    },
  };
}

/**
 * Walk a rule from its start. The start itself is always the first instance ("the DTSTART property
 * value always counts as the first occurrence"), whether or not the rule would name it; with `from`
 * later than the start it is left out, like everything else before `from`. COUNT ends the walk;
 * UNTIL is the asker's to apply, because it is an instant and the walk has none.
 */
export function walkRule(given: RRule, start: Wall, options: WalkOptions): RuleWalk {
  // The clock readings the line's lists name for a day, by the lengths of the lists alone: a line past the ceiling is known for one before a member of them is looked at.
  const named = options.dateOnly ? 1 : (given.byHour.length || 1) * (given.byMinute.length || 1) * (given.bySecond.length || 1);
  if (named > (options.maxPerDay ?? MAX_CLOCK_READINGS_PER_DAY)) return unwalked(given, start, options);
  const rule = withDefaults(given, start);
  const plan = planOf(rule);
  const startSeconds = wallSeconds(start);
  const startDay = daysFromCivil(start.year, start.month, start.day);
  const skipTo = given.count === null && options.from !== undefined && wallSeconds(options.from) > startSeconds ? options.from : null;
  const endSeconds = options.to === undefined ? Infinity : wallSeconds(options.to);
  const subDaily = rule.freq === "HOURLY" || rule.freq === "MINUTELY" || rule.freq === "SECONDLY";
  const unit = rule.freq === "HOURLY" ? 3600 : rule.freq === "MINUTELY" ? 60 : 1;
  /*
   * The clock readings of a day the rule names, as its three lists in order: the n-th reading is
   * worked out from them, and the 86,400 a rule can name are never one list. What a list leaves
   * unsaid is the start's; a start that is a date has midnight and nothing else.
   */
  const inOrder = (list: readonly number[], ofStart: number): number[] => (options.dateOnly ? [0] : sortedUnique(list.length > 0 ? list : [ofStart]));
  const [hourList, minuteList, secondList] = [inOrder(rule.byHour, start.hour), inOrder(rule.byMinute, start.minute), inOrder(rule.bySecond, start.second)];
  const perDay = hourList.length * minuteList.length * secondList.length;
  const clockAt = (n: number): number =>
    hourList[Math.floor(n / (minuteList.length * secondList.length))]! * 3600 + minuteList[Math.floor(n / secondList.length) % minuteList.length]! * 60 + secondList[n % secondList.length]!;
  const inMonth = rule.freq === "MONTHLY" || (rule.freq === "YEARLY" && rule.byMonth.length > 0);
  /** The months a yearly rule names, in order: only their days can be in it, so only they are asked. */
  const monthsOfYear = rule.freq === "YEARLY" && rule.byMonth.length > 0 ? sortedUnique(rule.byMonth) : null;

  /** The day the start's week begins on. */
  const weekBase = startDay - ((weekdayOf(startDay) - plan.weekStart + 7) % 7);
  /** Where a reading falls on the rule's own scale: years, months, weeks since the start's, days, hours, minutes or seconds. */
  const unitOf = (w: Wall): number => {
    const days = daysFromCivil(w.year, w.month, w.day);
    switch (rule.freq) {
      case "YEARLY":
        return w.year;
      case "MONTHLY":
        return w.year * 12 + (w.month - 1);
      case "WEEKLY":
        return Math.floor((days - weekBase) / 7);
      case "DAILY":
        return days;
      default:
        return Math.floor(wallSeconds(w) / unit);
    }
  };
  const base = unitOf(start);

  let steps = 0;

  /** The first second of period number `k` on the clock scale; `null` when it lies past the calendar's last day. */
  const beginsAt = (k: number): number | null => {
    const at = base + k * rule.interval;
    switch (rule.freq) {
      case "YEARLY":
        return at > 9999 ? null : daysFromCivil(at, 1, 1) * SECONDS_PER_DAY;
      case "MONTHLY":
        return Math.floor(at / 12) > 9999 ? null : daysFromCivil(Math.floor(at / 12), (at % 12) + 1, 1) * SECONDS_PER_DAY;
      case "WEEKLY":
        return weekBase + at * 7 > LAST_DAY ? null : (weekBase + at * 7) * SECONDS_PER_DAY;
      case "DAILY":
        return at > LAST_DAY ? null : at * SECONDS_PER_DAY;
      default:
        return Math.floor((at * unit) / SECONDS_PER_DAY) > LAST_DAY ? null : at * unit;
    }
  };

  /** The days of a run of `length` days from `first` that are in the rule; each day asked is a step. */
  const daysIn = (first: number, length: number, into: number[]): void => {
    steps += length;
    for (let d = first; d < first + length && d <= LAST_DAY; d++) if (dayIsIn(plan, d, inMonth)) into.push(d);
  };

  /** The readings of period number `k`, before BYSETPOS picks among them. Its days are asked here, a step each; its readings are not made. */
  const readingsOf = (k: number): Period | "too many" => {
    const at = base + k * rule.interval;
    const days: number[] = [];
    switch (rule.freq) {
      case "YEARLY":
        if (monthsOfYear === null) daysIn(daysFromCivil(at, 1, 1), daysInYear(at), days);
        else for (const month of monthsOfYear) daysIn(daysFromCivil(at, month, 1), daysInMonth(at, month), days);
        break;
      case "MONTHLY": {
        const year = Math.floor(at / 12);
        const month = (at % 12) + 1;
        if (plan.months !== null && !plan.months.has(month)) steps++;
        else daysIn(daysFromCivil(year, month, 1), daysInMonth(year, month), days);
        break;
      }
      case "WEEKLY":
        daysIn(weekBase + at * 7, 7, days);
        break;
      case "DAILY":
        daysIn(at, 1, days);
        break;
      default: {
        const seconds = at * unit;
        const day = Math.floor(seconds / SECONDS_PER_DAY);
        steps++;
        if (options.dateOnly || !dayIsIn(plan, day, false)) return NOTHING;
        const ofDay = seconds - day * SECONDS_PER_DAY;
        const [hour, minute, second] = [Math.floor(ofDay / 3600), Math.floor((ofDay % 3600) / 60), ofDay % 60];
        if (plan.hours !== null && !plan.hours.has(hour)) return NOTHING;
        if (rule.freq !== "HOURLY" && plan.minutes !== null && !plan.minutes.has(minute)) return NOTHING;
        if (rule.freq === "SECONDLY" && plan.seconds !== null && !plan.seconds.has(second)) return NOTHING;
        // An hour holds its listed minutes, each with its listed seconds; a minute its listed seconds; a second itself.
        const hourBegins = day * SECONDS_PER_DAY + hour * 3600;
        if (rule.freq === "HOURLY") return { count: minuteList.length * secondList.length, at: (n) => hourBegins + minuteList[Math.floor(n / secondList.length)]! * 60 + secondList[n % secondList.length]! };
        if (rule.freq === "MINUTELY") return { count: secondList.length, at: (n) => hourBegins + minute * 60 + secondList[n]! };
        return { count: 1, at: () => seconds };
      }
    }
    if (days.length === 0) return NOTHING;
    if (days.length * perDay > options.maxPerPeriod) return "too many";
    return { count: days.length * perDay, at: (n) => days[Math.floor(n / perDay)]! * SECONDS_PER_DAY + clockAt(n % perDay) };
  };

  let k = skipTo === null ? 0 : Math.max(0, Math.floor((unitOf(skipTo) - base) / rule.interval));
  /** The period being handed back: its readings from `cursor` to `end`, or with BYSETPOS the places picked from it. */
  let period = NOTHING;
  let places: number[] | null = null;
  let [cursor, end] = [0, 0];
  let startGiven = skipTo !== null;
  let yielded = 0;
  let stoppedBy: WalkStop | null = null;
  let ended = false;
  const stop = (at: WalkStop | null): null => {
    stoppedBy = at;
    ended = true;
    return null;
  };

  /** Open the next period for handing back: what lies at or before the start is no instance and is passed over without being made. */
  const open = (): boolean => {
    const found = readingsOf(k++);
    if (found === "too many") return false;
    period = found;
    if (plan.positions !== null && found.count > 0) {
      // Every place named is looked for: a step each, found or not. What is found is paid for with that.
      steps += plan.positions.length;
      places = placesIn(found.count, plan.positions).filter((n) => found.at(n) > startSeconds);
      [cursor, end] = [0, places.length];
    } else {
      places = null;
      [cursor, end] = [found.count > 0 && found.at(0) <= startSeconds ? upTo(found, startSeconds) : 0, found.count];
    }
    return true;
  };

  return {
    get capped() {
      return stoppedBy !== null;
    },
    get stoppedBy() {
      return stoppedBy;
    },
    get steps() {
      return steps;
    },
    next(): Wall | null {
      if (ended || (rule.count !== null && yielded >= rule.count)) return null;
      if (!startGiven) {
        startGiven = true;
        yielded++;
        steps++;
        return start;
      }
      if (subDaily && options.dateOnly) return null;
      while (cursor >= end) {
        if (steps >= options.maxSteps) return stop("out_of_steps");
        const begins = beginsAt(k);
        if (begins === null || begins > endSeconds) return stop(null);
        if (!open()) return stop("too_many_in_a_period");
      }
      if (places !== null) {
        yielded++;
        return wallFromSeconds(period.at(places[cursor++]!));
      }
      if (steps >= options.maxSteps) return stop("out_of_steps");
      yielded++;
      steps++;
      return wallFromSeconds(period.at(cursor++));
    },
  };
}
