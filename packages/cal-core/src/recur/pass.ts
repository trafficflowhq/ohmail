/**
 * One series on its way into the occurrences found: one pass of an expansion (`recur/series` is its
 * one caller, and says what an expansion is). Everything here draws on the allowance of the call it
 * is part of: steps for what is looked at, times for what is worked out with the zone's rules, and
 * the zone source asked on those same steps. A pass makes nothing the call has not paid for: when a
 * zone's answer is refused for want of steps, what was being worked out with it is dropped.
 */
import type { AddedDate, CalEvent } from "../ical/event.js";
import type { Limits } from "../limits.js";
import { MS_PER_SECOND, resolveWall, wallFromSeconds, wallIn, wallSeconds } from "../time/arith.js";
import { addDuration } from "../time/duration.js";
import type { EventTime, StepsLeft, ZoneSource } from "../time/types.js";
import { walkRule } from "./expand.js";
import { recurrenceKeyOf, recurrenceKeyString } from "./key.js";
import type { ExpansionStop, ExpansionWindow, Occurrence, Series } from "./series.js";
import { atClock, clockOf, clockSeconds, endOf, lengthOf, pastUntil, reachOf, shifted, UNKNOWN_ZONE_AHEAD_MS, UNKNOWN_ZONE_BEHIND_MS, type Length } from "./span.js";

const SECONDS_PER_DAY = 86_400;
/** Slack around a window when a rule is walked on the clock: two days cover any zone and any clock change. */
const WALK_SLACK_SECONDS = 2 * SECONDS_PER_DAY;

/** What an expansion may still spend, over everything it is handed. The zone source is asked on the same steps. */
export interface Allowance extends StepsLeft {
  resolved: number;
}
/** `id`: the occurrence's key as a string, made the first time two occurrences of one series at one moment have to be put in order, and then kept. */
export type Found = { readonly occurrence: Occurrence; readonly at: number; id?: string };

/** One series on its way into `found`: what it is expanded with, what may still be spent, and whether a ceiling has stopped it. */
interface Pass {
  readonly series: Series;
  readonly window: ExpansionWindow;
  readonly zones: ZoneSource;
  readonly limits: Limits;
  readonly left: Allowance;
  readonly found: Found[];
  /** The key string of the one occurrence asked for, wherever it now stands; `null` for every occurrence that touches the window. */
  readonly only: string | null;
  /** The window on the clock scale, with the slack that covers any zone. */
  readonly windowFrom: number;
  readonly windowTo: number;
  /** Times this series may still have worked out. */
  own: number;
  /** The ceilings met so far, by the whole call. */
  readonly stops: Set<ExpansionStop>;
}

/** One more time worked out with the zone's rules, if the series and the call still hold one. */
function resolveOne(pass: Pass): boolean {
  if (pass.left.resolved <= 0 || pass.own <= 0) {
    pass.stops.add("too_many_occurrences");
    return false;
  }
  pass.left.resolved--;
  pass.own--;
  return true;
}

/**
 * Was a zone's answer refused for want of steps? Then what was being worked out with it is not to
 * be trusted and is dropped, and nothing more is made: the call's steps are gone.
 */
function cutShort(pass: Pass): boolean {
  if (!pass.left.unpaid) return false;
  pass.stops.add("out_of_steps");
  return true;
}

/** Where a time stands on the instant scale, and whether that is exact. */
function place(pass: Pass, t: EventTime): { ms: number; exact: boolean } {
  const exact = t.kind === "instant" ? t.epochMs : resolveWall(clockOf(t), t.kind === "zoned" ? t.tzid : pass.window.viewerZone, pass.zones);
  return exact === null ? { ms: clockSeconds(t) * MS_PER_SECOND, exact: false } : { ms: exact, exact: true };
}

/** The occurrence into `found` when it touches the window, or is the one asked for. */
function keep(pass: Pass, occurrence: Occurrence): void {
  const [from, to] = [place(pass, occurrence.start), place(pass, occurrence.end)];
  if (pass.only === null) {
    const early = from.exact ? 0 : UNKNOWN_ZONE_BEHIND_MS;
    const late = to.exact ? 0 : UNKNOWN_ZONE_AHEAD_MS;
    const startsBefore = from.ms - early < pass.window.endMs;
    const reaches = to.ms + late > pass.window.startMs || from.ms + (from.exact ? 0 : UNKNOWN_ZONE_AHEAD_MS) >= pass.window.startMs;
    if (!startsBefore || !reaches) return;
  }
  if (cutShort(pass)) return;
  pass.found.push({ occurrence, at: from.ms });
}

/** A changed occurrence that speaks for every later one too (RANGE=THISANDFUTURE): from where, by how much it moves them and how long they then last, or that they are cancelled from there on. */
interface Range {
  readonly from: number;
  readonly cancelled: boolean;
  readonly shiftSeconds: number;
  readonly length: Length;
  readonly event: CalEvent;
}

/** The series' ranges in order of where they begin. One far before the window still governs the days in it, so each is placed. */
function rangesOf(pass: Pass): Range[] {
  const ranges: Range[] = [];
  for (const o of pass.series.overrides.values()) {
    if (!o.thisAndFuture || o.recurrenceId === null || (o.start === null && o.status !== "CANCELLED")) continue;
    if (!resolveOne(pass)) break;
    const was = o.recurrenceId;
    const start = o.start ?? was;
    const wasClock = was.kind === "instant" && start.kind === "zoned" ? (wallIn(was.epochMs, start.tzid, pass.zones) ?? clockOf(was)) : clockOf(was);
    const range: Range = { from: place(pass, was).ms, cancelled: o.status === "CANCELLED", shiftSeconds: clockSeconds(start) - wallSeconds(wasClock), length: lengthOf(o, pass.zones), event: o };
    if (cutShort(pass)) break;
    ranges.push(range);
  }
  return ranges.sort((a, b) => a.from - b.from);
}

/** The latest range that begins at or before this place: found by halving, a series may carry many. */
function rangeAt(ranges: readonly Range[], at: number): Range | undefined {
  let [lo, hi] = [0, ranges.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid]!.from <= at) lo = mid + 1;
    else hi = mid;
  }
  return ranges[lo - 1];
}

/**
 * What the series' own component makes: its start, its rules' instances and its added dates, less
 * the excluded, the cancelled and the changed ones. A rule is walked on the clock from just before
 * the window to just after it, and only what lies in that range is worked out with the zone.
 */
function fromMaster(pass: Pass, master: CalEvent, first: EventTime, gone: ReadonlySet<string>): void {
  const { series, zones, limits, left, stops } = pass;
  const ranges = rangesOf(pass);
  if (left.unpaid) return;
  const startSeconds = clockSeconds(first);
  const repeats = master.rules.length > 0 || master.added.length > 0;
  // What can touch the window began no earlier than the longest occurrence before it, and was moved there by no more than the furthest move.
  const reach = ranges.reduce((most, r) => Math.max(most, Math.abs(r.shiftSeconds) + reachOf(r.event)), reachOf(master));
  const [fromSeconds, toSeconds] = [pass.windowFrom - reach, pass.windowTo + reach];
  let length: Length | null = null;
  const ownEnd = (start: EventTime): EventTime => endOf(start, (length ??= lengthOf(master, zones)), master.end, zones);

  const excluded = new Set<string>();
  for (const t of master.excluded) {
    const at = clockSeconds(t);
    // A day's margin: an excluded time may be written on another clock than the series is.
    if (at < fromSeconds - SECONDS_PER_DAY || at > toSeconds + SECONDS_PER_DAY) continue;
    if (!resolveOne(pass)) break;
    const id = recurrenceKeyString(recurrenceKeyOf(t, zones));
    if (cutShort(pass)) return;
    excluded.add(id);
  }
  const seen = new Set<string>();
  const instance = (start: EventTime, own: AddedDate | null): void => {
    const key = recurrenceKeyOf(start, zones);
    const id = recurrenceKeyString(key);
    if (seen.has(id)) return;
    seen.add(id);
    if ((pass.only !== null && id !== pass.only) || excluded.has(id) || gone.has(id) || series.overrides.has(id)) return;
    const range = rangeAt(ranges, place(pass, start).ms);
    if (range !== undefined) {
      if (range.cancelled) return;
      const at = shifted(start, range.shiftSeconds);
      keep(pass, { uid: series.uid, key, start: at, end: endOf(at, range.length, range.event.end, zones), source: "override", event: range.event });
      return;
    }
    const end = own === null ? ownEnd(start) : (own.end ?? (own.duration === null ? ownEnd(start) : (addDuration(start, own.duration, zones) ?? start)));
    keep(pass, { uid: series.uid, key, start, end, source: repeats ? "rule" : "single", event: master });
  };

  if (master.rules.every((r) => r.rule === null) && startSeconds >= fromSeconds && startSeconds <= toSeconds && resolveOne(pass)) instance(first, null);
  if (left.unpaid) return;
  let walked = 0;
  for (const { rule } of master.rules) {
    if (rule === null) continue;
    if (++walked > limits.maxRules) {
      stops.add("too_many_rules");
      break;
    }
    if (left.steps <= 0) {
      stops.add("out_of_steps");
      break;
    }
    const walk = walkRule(rule, clockOf(first), {
      dateOnly: first.kind === "date",
      from: wallFromSeconds(fromSeconds),
      to: wallFromSeconds(toSeconds),
      maxSteps: left.steps,
      maxPerPeriod: limits.maxOccurrences,
      maxPerDay: limits.maxPerDay,
    });
    // The walk's steps come out of the allowance as they are spent, so that a zone asked meanwhile is asked on what is truly left.
    let paid = 0;
    const settle = (): void => {
      left.steps -= walk.steps - paid;
      paid = walk.steps;
    };
    for (let w = walk.next(); w !== null; w = walk.next()) {
      settle();
      const seconds = wallSeconds(w);
      if (seconds > toSeconds) break;
      // Before the range nothing is asked of the zone: a rule with a count is walked from its start, and most of that lies here.
      if (seconds < fromSeconds) continue;
      const before = left.steps;
      const start = atClock(first, w);
      // The start is the first occurrence whatever the rule's end says.
      if (seconds !== startSeconds && pastUntil(rule.until, start, w, zones)) break;
      if (!resolveOne(pass)) break;
      instance(start, null);
      if (left.unpaid) break;
      // The zone took the steps the walk still counted on.
      if (left.steps < before && left.steps <= 0) {
        stops.add("out_of_steps");
        break;
      }
    }
    settle();
    if (walk.stoppedBy !== null) stops.add(walk.stoppedBy);
    if (cutShort(pass)) return;
  }
  for (const added of master.added) {
    const at = clockSeconds(added.start);
    const ends = added.end !== null || added.duration !== null ? at + reachOf(added) : at;
    if (at > toSeconds || ends < fromSeconds) continue;
    if (!resolveOne(pass)) break;
    instance(added.start, added);
    if (left.unpaid) break;
  }
}

/** The changed occurrences, each where it now stands. */
function fromOverrides(pass: Pass, gone: ReadonlySet<string>): void {
  for (const [id, override] of pass.series.overrides) {
    if (pass.left.unpaid) break;
    if (gone.has(id) || override.start === null || override.recurrenceId === null) continue;
    const at = clockSeconds(override.start);
    if (pass.only !== null ? id !== pass.only : at > pass.windowTo || at + reachOf(override) < pass.windowFrom) continue;
    if (!resolveOne(pass)) break;
    const end = endOf(override.start, lengthOf(override, pass.zones), override.end, pass.zones);
    keep(pass, { uid: pass.series.uid, key: recurrenceKeyOf(override.recurrenceId, pass.zones), start: override.start, end, source: "override", event: override });
  }
}

/**
 * One series into `found`. With `only`, the one occurrence with that key string wherever it now
 * stands; else every occurrence that touches the window. The ceilings it meets go into `stops`.
 */
export function expandInto(series: Series, window: ExpansionWindow, zones: ZoneSource, limits: Limits, left: Allowance, found: Found[], only: string | null, stops: Set<ExpansionStop>): void {
  const master = series.master;
  // The series itself, and every date and changed occurrence it lists: looked at once each, by their clock readings alone.
  const listed = 1 + series.overrides.size + (master === null ? 0 : master.excluded.length + master.added.length);
  if (left.steps < listed) {
    left.steps = 0;
    stops.add("out_of_steps");
    return;
  }
  left.steps -= listed;
  const windowFrom = Math.floor(window.startMs / MS_PER_SECOND) - WALK_SLACK_SECONDS;
  const windowTo = Math.ceil(window.endMs / MS_PER_SECOND) + WALK_SLACK_SECONDS;
  const pass: Pass = { series, window, zones, limits, left, found, only, windowFrom, windowTo, own: limits.maxOccurrences, stops };
  const gone = new Set(series.cancelled);
  for (const [key, override] of series.overrides) if (override.status === "CANCELLED") gone.add(key);
  if (master !== null && master.start !== null) fromMaster(pass, master, master.start, gone);
  fromOverrides(pass, gone);
  cutShort(pass);
}

/**
 * What was found, in order of start; at one start by UID, and in one series by key. A comparison is
 * over no more than a UID's and a key's ceilings (`MAX_UID_CHARS`, `MAX_ZONE_NAME_CHARS`), and a key's
 * string is made once for an occurrence, not once for each comparison.
 */
export const inOrder = (found: Found[]): Occurrence[] => {
  const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const idOf = (f: Found): string => (f.id ??= recurrenceKeyString(f.occurrence.key));
  found.sort((a, b) => a.at - b.at || text(a.occurrence.uid, b.occurrence.uid) || text(idOf(a), idOf(b)));
  return found.map((f) => f.occurrence);
};
