/**
 * THE ONE PLACE A ROW'S RANGE IS WORKED OUT.
 *
 * `cal_events` keeps every time as written; `starts_at`, `ends_at` and `occurrence_at` exist only
 * so that "which events can touch these days" is a question an index answers. They are derived
 * here and nowhere else, by every writer, so the first load, the device's span and the sweep all
 * read the same range. Exact for an instant and a known zone; a day, a floating clock time or an
 * unknown zone is read as UTC, and every reader widens its span by {@link CALENDAR_RANGE_SLACK_MS}.
 */
import {
  exactSeconds, intlZones, MAX_OCCURRENCES_PER_EXPANSION, MAX_STEPS_PER_EXPANSION,
  nominalDays, parseDateTime, parseDuration, parseRRule, resolveWall, walkRule, wallSeconds,
  type EventTime, type Until, type ZoneSource,
} from "@ohmail/cal-core";
import { atClock, clockOf, UNKNOWN_ZONE_BEHIND_MS } from "@ohmail/cal-core/recur/span";
import type { CalendarTime } from "@ohmail/wire";
import { DAY_MS, eventTimeOf, momentOrUtc } from "./time.js";

/** How far a time read as UTC can be from the moment it meant: the earliest clock on Earth. */
export const CALENDAR_RANGE_SLACK_MS = UNKNOWN_ZONE_BEHIND_MS;

/** What a row's range is derived from: its times as written, its rules and its added dates. */
export interface EventRangeInput {
  readonly start: CalendarTime;
  readonly end: CalendarTime | null;
  /** iCalendar's form (`PT1H`), never beside an end. */
  readonly duration: string | null;
  /** RRULE values. */
  readonly rules: readonly string[];
  readonly added: readonly CalendarTime[];
  /** The calendar core's key of the occurrence this row replaces; `""` for none. */
  readonly recurrenceId: string;
}

export interface EventRange {
  readonly startsAt: Date;
  /** `null` only for a series that does not end. */
  readonly endsAt: Date | null;
  readonly occurrenceAt: Date | null;
}

/**
 * The row's range, or `null` when its start cannot be read: such a row is in no window on any
 * device, so a writer refuses it rather than store it.
 */
export function derivedRange(input: EventRangeInput, zones: ZoneSource = intlZones()): EventRange | null {
  const start = eventTimeOf(input.start);
  if (start === null) return null;
  const startMs = momentOrUtc(start, zones);
  const length = lengthOf(start, startMs, input, zones);
  let firstMs = startMs;
  let lastEndMs: number | null = startMs + length;
  for (const a of input.added) {
    const t = eventTimeOf(a);
    if (t === null) continue;
    const at = momentOrUtc(t, zones);
    firstMs = Math.min(firstMs, at);
    lastEndMs = Math.max(lastEndMs, at + length);
  }
  if (input.rules.length > 0) {
    const lastStart = lastStartOf(start, startMs, input.rules, zones);
    lastEndMs = lastStart === null ? null : Math.max(lastEndMs, lastStart + length);
  }
  const occurrenceAt = input.recurrenceId === "" ? null : occurrenceMoment(input.recurrenceId, zones);
  // A row that replaces an occurrence nobody can place hides nothing anywhere: refused like a start.
  if (input.recurrenceId !== "" && occurrenceAt === null) return null;
  return { startsAt: new Date(firstMs), endsAt: lastEndMs === null ? null : new Date(lastEndMs), occurrenceAt };
}

/** How long one occurrence lasts: to its end, for its length, or a day for a day with neither. */
function lengthOf(start: EventTime, startMs: number, input: EventRangeInput, zones: ZoneSource): number {
  if (input.end !== null) {
    const end = eventTimeOf(input.end);
    if (end !== null) return Math.max(0, momentOrUtc(end, zones) - startMs);
  }
  if (input.duration !== null) {
    const d = parseDuration(input.duration);
    if (d !== null) return Math.max(0, nominalDays(d) * DAY_MS + exactSeconds(d) * 1000);
  }
  return start.kind === "date" ? DAY_MS : 0;
}

/**
 * The latest start any rule can reach, or `null` when one never ends: no COUNT and no UNTIL, a
 * rule the core cannot read, or one whose walk stopped at a ceiling before its end. An endless
 * answer is the safe one — the series is then held in every span after its start.
 */
function lastStartOf(start: EventTime, startMs: number, rules: readonly string[], zones: ZoneSource): number | null {
  let last = startMs;
  for (const text of rules) {
    const rule = parseRRule(text);
    if (rule === null || (rule.count === null && rule.until === null)) return null;
    if (rule.until !== null) {
      last = Math.max(last, untilMoment(rule.until, zones));
      continue;
    }
    const walk = walkRule(rule, clockOf(start), {
      dateOnly: start.kind === "date",
      maxSteps: MAX_STEPS_PER_EXPANSION,
      maxPerPeriod: MAX_OCCURRENCES_PER_EXPANSION,
    });
    for (let w = walk.next(); w !== null; w = walk.next()) last = Math.max(last, momentOrUtc(atClock(start, w), zones));
    if (walk.capped) return null;
  }
  return last;
}

/** The latest moment an UNTIL lets a start be at: a whole day's end for a date. */
function untilMoment(until: Until, zones: ZoneSource): number {
  return until.kind === "date" ? momentOrUtc(until, zones) + DAY_MS : momentOrUtc(until, zones);
}

/**
 * The moment of the occurrence a key names (the core's `recurrenceKeyString`): milliseconds for an
 * instant or a day, else `zone|clock|false`, read in that zone where it is known and as UTC where not.
 */
function occurrenceMoment(key: string, zones: ZoneSource): Date | null {
  if (/^-?\d{1,16}$/.test(key)) return new Date(Number(key));
  const [tzid, clock] = key.split("|");
  const parsed = clock === undefined ? null : parseDateTime(clock.length === 13 ? `${clock}00` : clock);
  if (parsed === null || tzid === undefined) return null;
  const ms = tzid === "" ? null : resolveWall(parsed.wall, tzid, zones);
  return new Date(ms ?? wallSeconds(parsed.wall) * 1000);
}
