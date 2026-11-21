/**
 * WHICH REPEATS A PROVIDER WAS SEEN TO KEEP AS WRITTEN. A series is written only in a shape that was
 * written at that provider, read back from its own answer, and found equal to what the calendar
 * core expands: a provider that keeps a rule differently would move a person's days without saying
 * so. A shape is added to a provider's row only by the change that brings its recorded proof; every
 * other shape is `repeat_unsupported`, said and visible, never sent.
 */
import {
  eventOf,
  expandSeries,
  instant,
  momentOrUtc,
  wallFromSeconds,
  MS_PER_DAY,
  newEventComponent,
  seriesOf,
  type EventTime,
  type RRule,
  type ZoneSource,
} from "@ohmail/cal-core";
import { endedRule } from "./series.js";
import type { ProviderWord } from "./port.js";
import { recurrenceFor } from "./microsoft/recurrence-write.js";

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

const WEEK = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const monthLength = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

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
  const length = monthLength(d.year, d.month);
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
): RepeatShape | null {
  const base = baseOf(rule);
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
    repeatShapeAt(rule, start, zones, nowMs, true) !== null
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
  if (!seriesProven(place, rule, first, zones, nowMs, proven)) return [];
  if (!place?.startsWith("caldav:")) return ["record"];
  const ended = endedRule(rule, first, momentOrUtc(first, zones) + MS_PER_DAY, zones);
  return ended && repeatProven(place, ended, proven)
    ? ["record", "occurrence", "following"]
    : ["record", "occurrence"];
}
