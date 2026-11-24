/**
 * WHICH REPEATS A PROVIDER WAS SEEN TO KEEP AS WRITTEN. A series is written only in a shape that was
 * written at that provider, read back from its own answer, and found equal to what the calendar
 * core expands: a provider that keeps a rule differently would move a person's days without saying
 * so. A shape is added to a provider's row only by the change that brings its recorded proof; every
 * other shape is `repeat_unsupported`, said and visible, never sent.
 */
import {
  dayNumber,
  draftRepeatShape,
  type DraftRepeatShape,
  type RepeatEnd,
  daysInMonth,
  repeatShapeAt,
  repeatShapeOf,
  type RepeatShape,
  momentOrUtc,
  MS_PER_DAY,
  wallIn,
  type EventTime,
  type PlainDate,
  type RRule,
  type Wall,
  type ZoneSource,
} from "@ohmail/cal-core";
import { endedRule } from "./series.js";
import type { ProviderWord } from "./port.js";
import type { Json } from "./json-answers.js";

export {
  repeatShapeAt,
  repeatShapeOf,
  type RepeatShape,
  type RepeatEnd,
  type RepeatBase,
} from "@ohmail/cal-core";

/**
 * Where a repeat proof was run, as a connection can tell it: Google's, Microsoft's and a
 * subscription's own word, and for CalDAV `caldav:` and the server's host as the connection names it
 * (its address's host, with the port where the address names one). Two CalDAV servers are two
 * places: what one keeps of a rule says nothing of another, so a proof made at one proves nothing at
 * another (iCloud among them). The host is the smallest key a connection knows of its server that
 * is honest: nothing it is told by a server names what software keeps the rule.
 */
export type ProofPlace = string;

/** A stored rule the series edit writers can represent. New independent creates still use server proofs. */
export function seriesEditShape(
  place: ProofPlace | null,
  rule: RRule,
  start: EventTime,
  zones: ZoneSource,
  nowMs: number,
): boolean {
  if (place === "microsoft") return recurrenceFor(rule, start, zones) !== null;
  return (
    (place === "google" || place?.startsWith("caldav:") === true) &&
    draftRepeatShape(rule, start, zones, nowMs, true) !== null
  );
}

/** A connection's place (`serverUrl`: a CalDAV connection's stored address), or `null` where it has none: proven nowhere. */
export function proofPlaceOf(provider: ProviderWord, serverUrl: string | null): ProofPlace | null {
  if (provider !== "caldav") return provider;
  if (serverUrl === null) return null;
  let host: string;
  try {
    host = new URL(serverUrl).host.toLowerCase();
  } catch {
    // No address at all: no place, proven nowhere.
    return null;
  }
  return host === "" ? null : `caldav:${host}`;
}

/** The repeats proven at each place a proof was run. */
export type ProvenRepeats = Readonly<Record<ProofPlace, readonly RepeatShape[]>>;

/** The bench's own CalDAV server, where its proof was run (`test/support/fixtures/bench/repeat-proof.json` names it). */
export const BENCH_CALDAV_PLACE: ProofPlace = "caldav:127.0.0.1:8821";

/**
 * The shapes proven at each place, by the recorded proof of the change that added the row (written,
 * read back by the server's own expansion, compared day by day with the core's). A place no row
 * names is proven nothing.
 *
 * - The bench's CalDAV server: every shape, each as a clock time in a zone and as whole days
 *   (`test/support/fixtures/bench/repeat-proof.json`, 144 cases). That server places a clock time its
 *   zone skips elsewhere than the core does, so a series that meets one is no shape at all
 *   (`repeatShapeAt`). It is that server's row and no other's: iCloud's run of the same file is owed,
 *   and until its record is committed no series is written there.
 * - Google: empty until the proof is run at the test account (`google-repeat-proof.live.ts`).
 * - Microsoft: built and not proven; its row waits for a trial at Microsoft itself.
 */
export const PROVEN_REPEATS: ProvenRepeats = {
  google: [],
  [BENCH_CALDAV_PLACE]: [
    "daily/count",
    "daily/never",
    "daily/until",
    "every_n_days/count",
    "every_n_days/never",
    "every_n_days/until",
    "monthly_by_date/count",
    "monthly_by_date/never",
    "monthly_by_date/until",
    "monthly_last_weekday/count",
    "monthly_last_weekday/never",
    "monthly_last_weekday/until",
    "monthly_late_date/count",
    "monthly_late_date/never",
    "monthly_late_date/until",
    "monthly_nth_weekday/count",
    "monthly_nth_weekday/never",
    "monthly_nth_weekday/until",
    "weekdays/count",
    "weekdays/never",
    "weekdays/until",
    "weekly/count",
    "weekly/never",
    "weekly/until",
    "weeks_on_days/count",
    "weeks_on_days/never",
    "weeks_on_days/until",
    "yearly_by_date/count",
    "yearly_by_date/never",
    "yearly_by_date/until",
    "yearly_by_weekday/count",
    "yearly_by_weekday/never",
    "yearly_by_weekday/until",
  ],
  microsoft: [],
  ics: [],
};

const DRAFT_ENDS = ["count", "never", "until"] as const satisfies readonly RepeatEnd[];
const editorShapes: readonly DraftRepeatShape[] = [
  ...PROVEN_REPEATS[BENCH_CALDAV_PLACE]!,
  ...DRAFT_ENDS.map((end) => `yearly_leap_date/${end}` as const),
];
const graphShapes = editorShapes.filter(
  (shape) => !shape.startsWith("monthly_late_date/") && !shape.startsWith("yearly_leap_date/"),
);

/** Rule shapes covered by the create writers' stand-in round trips. */
export function repeatShapesForDraft(place: ProofPlace | null): readonly DraftRepeatShape[] {
  if (place === "microsoft") return graphShapes;
  return place === "google" || place?.startsWith("caldav:") ? editorShapes : [];
}

/** Check the selected rule and its actual start before recording or sending it. */
export function draftRepeatSupported(
  place: ProofPlace | null,
  rule: RRule,
  start: EventTime,
  zones: ZoneSource,
  nowMs: number,
): boolean {
  const shape = draftRepeatShape(rule, start, zones, nowMs);
  return (
    shape !== null &&
    repeatShapesForDraft(place).includes(shape) &&
    (place !== "microsoft" || recurrenceFor(rule, start, zones) !== null)
  );
}

/** The row of a place: its own, or none. */
const rowOf = (place: ProofPlace | null, proven: ProvenRepeats): readonly RepeatShape[] =>
  place !== null && Object.hasOwn(proven, place) ? proven[place]! : [];

/** May a series of this rule be written at this place? */
export function repeatProven(
  place: ProofPlace | null,
  rule: RRule,
  proven: ProvenRepeats = PROVEN_REPEATS,
): boolean {
  const shape = repeatShapeOf(rule);
  return shape !== null && rowOf(place, proven).includes(shape);
}

/** May a series of this rule, from this start, be written at this place? Its shape as written ({@link repeatShapeAt}) is in the place's row. */
export function seriesProven(
  place: ProofPlace | null,
  rule: RRule,
  start: EventTime,
  zones: ZoneSource,
  nowMs: number,
  proven: ProvenRepeats = PROVEN_REPEATS,
): boolean {
  const shape = repeatShapeAt(rule, start, zones, nowMs);
  return shape !== null && rowOf(place, proven).includes(shape);
}

/** A proved series can only offer the remove scopes its writer implements. */
export function repeatDeleteScopes(
  place: ProofPlace | null,
  rule: RRule,
  first: EventTime,
  zones: ZoneSource,
  nowMs: number,
  proven: ProvenRepeats = PROVEN_REPEATS,
): readonly ("record" | "occurrence" | "following")[] {
  if (place === "google" || place === "microsoft")
    return seriesEditShape(place, rule, first, zones, nowMs) ? ["record", "occurrence"] : [];
  if (!place?.startsWith("caldav:")) return [];
  if (!seriesProven(place, rule, first, zones, nowMs, proven)) {
    return draftRepeatSupported(place, rule, first, zones, nowMs) ? ["record"] : [];
  }
  const ended = endedRule(rule, first, momentOrUtc(first, zones) + MS_PER_DAY, zones);
  return ended && repeatProven(place, ended, proven)
    ? ["record", "occurrence", "following"]
    : ["record", "occurrence"];
}

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

/**
 * Graph clamps an absolute day to the month's end. Accept an RFC rule only when it says the same:
 * a day every month it names has (`shortest`: 28 for a monthly rule, the named month's shortest
 * length for a yearly one), or the month's last day spelled out with BYSETPOS=-1.
 */
function absoluteDay(rule: RRule, start: Day, shortest: number): number | null {
  const last = rule.byMonthDay.at(-1) ?? start.day;
  if (last < 1 || last > 31) return null;
  if (rule.byMonthDay.length <= 1 && rule.bySetPos.length === 0 && last <= shortest) return last;
  return rule.bySetPos.length === 1 &&
    rule.bySetPos[0] === -1 &&
    last >= 29 &&
    rule.byMonthDay.length === last - 27 &&
    rule.byMonthDay.every((day, index) => day === 28 + index)
    ? last
    : null;
}

function graphPatternFor(rule: RRule, start: Day): Json | null {
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
    if (daysOfWeek.length && !daysOfWeek.includes(startWeekday)) return null;
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
    const dayOfMonth = absoluteDay(rule, start, yearly ? daysInMonth(2001, month) : 28);
    if (
      dayOfMonth === null ||
      (yearly && month !== start.month) ||
      Math.min(dayOfMonth, daysInMonth(start.year, start.month)) !== start.day
    )
      return null;
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
  if (
    index === undefined ||
    (yearly && month !== start.month) ||
    !relativeStartsOn(start, daysOfWeek, ordinal)
  )
    return null;
  return yearly
    ? { type: "relativeYearly", interval, daysOfWeek, index, month }
    : { type: "relativeMonthly", interval, daysOfWeek, index };
}

function relativeStartsOn(start: Day, days: readonly string[], ordinal: number): boolean {
  const first = new Date(utcDay({ ...start, day: 1 })).getUTCDay();
  const names = Object.values(weekdays);
  const matching = Array.from({ length: daysInMonth(start.year, start.month) }, (_, day) => day + 1).filter(
    (day) => days.includes(names[(first + day - 1) % 7]!),
  );
  return matching.at(ordinal > 0 ? ordinal - 1 : ordinal) === start.day;
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
  const pattern = graphPatternFor(rule, day);
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
