/**
 * One record of Microsoft Graph as the calendar's own event, and Microsoft's repeat as the one rule
 * grammar every provider's events are kept in.
 *
 * Graph hands over a window's days already expanded and keeps the rule on the series alone. Here a
 * series becomes its rule, a changed day an event of its own that names the day it replaces, and an
 * unchanged day nothing but its identity: the series' identifier and the start it has in the series.
 *
 * Graph's fields are no calendar text and never passed the calendar reader: they go through the
 * core's own writer of a new event, a repeat through the core's own reader of a rule, and every
 * string that keys or names something is held to the reader's ceiling at this door.
 */
import {
  eventOf,
  instant,
  isValidDate,
  isValidWall,
  MAX_LINE_CHARS,
  MAX_PARAM_VALUE_CHARS,
  MAX_UID_CHARS,
  MAX_ZONE_NAME_CHARS,
  MS_PER_SECOND,
  newEventComponent,
  parseRRule,
  plainDate,
  resolveWall,
  timeProperty,
  wallFromSeconds,
  wallIn,
  wallSeconds,
  WINDOWS_ZONES,
  zoned,
  type EventTime,
  type NewEvent,
  type NewPerson,
  type PartStat,
  type PlainDate,
  type Property,
  type RRule,
  type Wall,
  type ZoneSource,
} from "@ohmail/cal-core";
import { addressOf, callLinkOf, filled, instantOfRfc3339, isRecord, leftOut, MAX_PROVIDER_ID_CHARS, pathSegment, type Json, type Left } from "../json-answers.js";
import type { ChangeItem, LeftReason } from "../port.js";

type Upsert = Extract<ChangeItem, { kind: "upsert" }>;

/* ── the repeat ─────────────────────────────────────────────────────────────────────────────────── */

const WEEKDAYS: Readonly<Record<string, string>> = { monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH", friday: "FR", saturday: "SA", sunday: "SU" };
/** "On which instance of the allowed days ... counted from the first instance in the month." */
const PLACES: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };
const MAX_RULE_NUMBER = 1_000_000;

const wholeIn = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);
const wordOf = <T>(table: Readonly<Record<string, T>>, v: unknown): T | null => (typeof v === "string" && Object.hasOwn(table, v) ? table[v]! : null);

function dateOf(v: unknown): PlainDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof v === "string" && v.length === 10 ? v : "");
  if (m === null) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return isValidDate(year, month, day) ? plainDate(year, month, day) : null;
}

/** The weekdays a pattern names, each once: "Required if type is weekly, relativeMonthly, or relativeYearly." */
function weekdaysOf(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 7) return null;
  const days = new Set<string>();
  for (const one of v) {
    const day = wordOf(WEEKDAYS, one);
    if (day === null) return null;
    days.add(day);
  }
  return [...days].join(",");
}

/**
 * A day of the month as Microsoft keeps it: in a month that has no such day the event falls on the
 * month's last. The rule grammar says that as the last of the days up to it.
 */
function monthDay(day: number): string {
  if (day <= 28) return `BYMONTHDAY=${day}`;
  const upTo: number[] = [];
  for (let d = 28; d <= day; d++) upTo.push(d);
  return `BYMONTHDAY=${upTo.join(",")};BYSETPOS=-1`;
}

/**
 * Microsoft's `recurrence` (a pattern and a range) as a rule of the calendar standard's grammar, or
 * `null` for one that cannot be said in it exactly: a repeat drawn wrong is worse than one left out
 * and said. The rule is written from numbers and words of this module's own tables and read back by
 * the core's own reader, so nothing of Microsoft's text reaches it.
 */
export function ruleOfRecurrence(recurrence: unknown): RRule | null {
  if (!isRecord(recurrence) || !isRecord(recurrence.pattern) || !isRecord(recurrence.range)) return null;
  const { pattern, range } = recurrence;
  const interval = wholeIn(pattern.interval ?? 1, 1, MAX_RULE_NUMBER);
  if (interval === null) return null;
  const parts: string[] = [];
  const days = (): string | null => weekdaysOf(pattern.daysOfWeek);
  const place = (): number | null => (pattern.index === undefined ? 1 : wordOf(PLACES, pattern.index));
  const dayOfMonth = (): number | null => wholeIn(pattern.dayOfMonth, 1, 31);
  const month = (): number | null => wholeIn(pattern.month, 1, 12);
  switch (pattern.type) {
    case "daily":
      parts.push("FREQ=DAILY");
      break;
    case "weekly": {
      const on = days();
      // "firstDayOfWeek ... Default is sunday."
      const begins = pattern.firstDayOfWeek === undefined ? "SU" : wordOf(WEEKDAYS, pattern.firstDayOfWeek);
      if (on === null || begins === null) return null;
      parts.push("FREQ=WEEKLY", `BYDAY=${on}`, `WKST=${begins}`);
      break;
    }
    case "absoluteMonthly": {
      const day = dayOfMonth();
      if (day === null) return null;
      parts.push("FREQ=MONTHLY", monthDay(day));
      break;
    }
    case "relativeMonthly": {
      const [on, at] = [days(), place()];
      if (on === null || at === null) return null;
      // Of several weekdays "the event falls on the first day that satisfies the pattern": the place among them all.
      parts.push("FREQ=MONTHLY", `BYDAY=${on}`, `BYSETPOS=${at}`);
      break;
    }
    case "absoluteYearly": {
      const [day, of] = [dayOfMonth(), month()];
      if (day === null || of === null) return null;
      parts.push("FREQ=YEARLY", `BYMONTH=${of}`, monthDay(day));
      break;
    }
    case "relativeYearly": {
      const [on, at, of] = [days(), place(), month()];
      if (on === null || at === null || of === null) return null;
      parts.push("FREQ=YEARLY", `BYMONTH=${of}`, `BYDAY=${on}`, `BYSETPOS=${at}`);
      break;
    }
    default:
      return null;
  }
  if (interval !== 1) parts.push(`INTERVAL=${interval}`);
  if (range.type === "numbered") {
    const count = wholeIn(range.numberOfOccurrences, 1, MAX_RULE_NUMBER);
    if (count === null) return null;
    parts.push(`COUNT=${count}`);
  } else if (range.type === "endDate") {
    // "Between the startDate and endDate inclusive", on the series' own clock: the rule's end as a day.
    const last = dateOf(range.endDate);
    if (last === null) return null;
    const two = (n: number): string => String(n).padStart(2, "0");
    parts.push(`UNTIL=${String(last.year).padStart(4, "0")}${two(last.month)}${two(last.day)}`);
  } else if (range.type !== "noEnd") return null;
  return parseRRule(parts.join(";"));
}

/* ── times ──────────────────────────────────────────────────────────────────────────────────────── */

/** Microsoft's two names for the clock that is no zone's. */
const UTC_NAMES: ReadonlySet<string> = new Set(["UTC", "tzone://Microsoft/Utc"]);
/** Windows' name for a zone as the name every calendar knows it by; any other name as it stands. */
const zoneNameOf = (name: string): string => (Object.hasOwn(WINDOWS_ZONES, name) ? WINDOWS_ZONES[name]! : name);

const GRAPH_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?$/;
/** A date, a clock time and seven digits of a second's fraction. */
const GRAPH_TIME_MAX_CHARS = 27;

interface Written {
  readonly wall: Wall;
  /** The zone the clock time is written in: UTC unless a zone was asked for, and none is asked for here. */
  readonly zone: string;
}

/** Graph's `{ dateTime, timeZone }` as written. */
function writtenOf(v: unknown): Written | null | "zone_name_too_long" {
  if (!isRecord(v) || typeof v.dateTime !== "string" || v.dateTime.length > GRAPH_TIME_MAX_CHARS) return null;
  const m = GRAPH_TIME.exec(v.dateTime);
  if (m === null) return null;
  const wall = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]) };
  if (!isValidWall(wall)) return null;
  const zone = filled(v.timeZone) ?? "UTC";
  return zone.length > MAX_ZONE_NAME_CHARS ? "zone_name_too_long" : { wall, zone };
}

/** The moment a written time names, or `null` where its zone is one nobody knows. */
const momentOf = (w: Written, zones: ZoneSource): number | null => (UTC_NAMES.has(w.zone) ? wallSeconds(w.wall) * MS_PER_SECOND : resolveWall(w.wall, zoneNameOf(w.zone), zones));

const isMidnight = (w: Wall): boolean => w.hour === 0 && w.minute === 0 && w.second === 0;

/**
 * A moment on an event's own clock. `known` says whether that clock could be read: where it could
 * not (Outlook's own "custom" zone, a name no platform has) the moment stands, which is right for one
 * event and no ground for a rule.
 */
function onClock(ms: number, zoneName: string | undefined, zones: ZoneSource): { readonly time: EventTime; readonly known: boolean } {
  if (zoneName === undefined) return { time: instant(ms), known: false };
  if (UTC_NAMES.has(zoneName)) return { time: instant(ms), known: true };
  const zone = zoneNameOf(zoneName);
  const wall = wallIn(ms, zone, zones);
  if (wall === null) return { time: instant(ms), known: false };
  // A clock time its zone shows twice stays the moment it is.
  return resolveWall(wall, zone, zones) === ms ? { time: zoned(wall, zone), known: true } : { time: instant(ms), known: false };
}

/**
 * The day a whole-day event names. Microsoft sets such an event "to midnight ... in the same time
 * zone" and answers in UTC: the day is the one written where that is a midnight, else the one whose
 * midnight on the event's own clock the moment is.
 */
function dayOnClock(w: Written, zoneName: string | undefined, zones: ZoneSource): PlainDate | null {
  if (isMidnight(w.wall)) return plainDate(w.wall.year, w.wall.month, w.wall.day);
  const ms = momentOf(w, zones);
  const own = ms === null || zoneName === undefined || UTC_NAMES.has(zoneName) ? null : wallIn(ms, zoneNameOf(zoneName), zones);
  return own !== null && isMidnight(own) ? plainDate(own.year, own.month, own.day) : null;
}

interface Times {
  readonly start: EventTime;
  readonly end: EventTime | null;
  /** Could the start's own clock be read? A rule is followed on that clock and on no other. */
  readonly known: boolean;
}

/** A record's start and end in the calendar's kinds of time. `clock` names the series' own zone where the record is a series. */
function timesOf(raw: Json, zones: ZoneSource, clock?: string): Times | LeftReason {
  const [startZone, endZone] = [clock ?? filled(raw.originalStartTimeZone), filled(raw.originalEndTimeZone)];
  if ((startZone?.length ?? 0) > MAX_ZONE_NAME_CHARS || (endZone?.length ?? 0) > MAX_ZONE_NAME_CHARS) return "zone_name_too_long";
  const [from, to] = [writtenOf(raw.start), raw.end === undefined || raw.end === null ? undefined : writtenOf(raw.end)];
  if (from === "zone_name_too_long" || to === "zone_name_too_long") return "zone_name_too_long";
  if (from === null || to === null) return "unreadable";
  if (raw.isAllDay === true) {
    const [first, after] = [dayOnClock(from, startZone, zones), to === undefined ? undefined : dayOnClock(to, endZone ?? startZone, zones)];
    return first === null || after === null ? "unreadable" : { start: first, end: after ?? null, known: true };
  }
  const [startMs, endMs] = [momentOf(from, zones), to === undefined ? undefined : momentOf(to, zones)];
  if (startMs === null || endMs === null) return "unreadable";
  const start = onClock(startMs, startZone, zones);
  return { start: start.time, end: endMs === undefined ? null : onClock(endMs, endZone ?? startZone, zones).time, known: start.known };
}

/* ── people and words ───────────────────────────────────────────────────────────────────────────── */

function personOf(v: unknown): NewPerson | null {
  const written = isRecord(v) && isRecord(v.emailAddress) ? v.emailAddress : null;
  const email = written === null ? undefined : addressOf(written.address);
  if (written === null || email === undefined) return null;
  const name = filled(written.name);
  return name === undefined || name.length > MAX_PARAM_VALUE_CHARS ? { email } : { email, name };
}

const ANSWERS: Readonly<Record<string, PartStat>> = { accepted: "ACCEPTED", declined: "DECLINED", tentativelyAccepted: "TENTATIVE", organizer: "ACCEPTED" };
const ROLES: Readonly<Record<string, string>> = { required: "REQ-PARTICIPANT", optional: "OPT-PARTICIPANT", resource: "NON-PARTICIPANT" };

function inviteesOf(v: unknown): NonNullable<NewEvent["attendees"]> {
  if (!Array.isArray(v)) return [];
  const out: NonNullable<NewEvent["attendees"]>[number][] = [];
  for (const one of v) {
    const person = personOf(one);
    if (person === null) continue;
    const answer = isRecord(one.status) ? wordOf(ANSWERS, one.status.response) : null;
    out.push({ ...person, role: wordOf(ROLES, one.type) ?? "REQ-PARTICIPANT", ...(answer === null ? {} : { partstat: answer }) });
  }
  return out;
}

/** "The possible values are: normal, personal, private, and confidential." What its owner marked personal is not shown as public. */
const CLASS: Readonly<Record<string, string>> = { personal: "PRIVATE", private: "PRIVATE", confidential: "CONFIDENTIAL" };
/** "free, tentative, busy, oof, workingElsewhere, unknown": only free leaves the time open. */
const SHOWN_AS: Readonly<Record<string, NonNullable<NewEvent["transparency"]>>> = { free: "TRANSPARENT", tentative: "OPAQUE", busy: "OPAQUE", oof: "OPAQUE", workingElsewhere: "OPAQUE" };

/* ── one record ─────────────────────────────────────────────────────────────────────────────────── */

/** What a day of a series needs of the series: the identifier its days are known by, and its clock. */
export interface SeriesClock {
  readonly uid: string;
  readonly wholeDays: boolean;
  /** The zone's name as the calendar writes it, or `null` for UTC. A zone nobody knows makes no series. */
  readonly zone: string | null;
}

interface Shape {
  readonly uid: string;
  readonly times: Times;
  readonly recurrenceId?: EventTime;
  readonly rule?: RRule;
}

/** The record's own id, or what is said of a record that has none. An id is asked for and written by its place in an address. */
function idOf(raw: Json): string | Left {
  const id = filled(raw.id);
  if (id === undefined || pathSegment(id) === null) return leftOut("", "unreadable");
  return id.length > MAX_PROVIDER_ID_CHARS ? leftOut(id, "uid_too_long") : id;
}

/** The event a record's fields make, in the shape its kind gives it. `nowMs` stands in for a stamp the record does not carry. */
function upsertOf(raw: Json, id: string, shape: Shape, nowMs: number): Upsert | LeftReason {
  const body = isRecord(raw.body) ? raw.body : null;
  // A body in markup is read as Microsoft's own plain preview of it: nothing here takes markup apart.
  const description = (body !== null && body.contentType === "text" ? filled(body.content) : undefined) ?? filled(raw.bodyPreview);
  const [summary, location] = [filled(raw.subject), isRecord(raw.location) ? filled(raw.location.displayName) : undefined];
  for (const value of [summary, description, location]) if (value !== undefined && value.length > MAX_LINE_CHARS) return "line_too_long";
  const changed = typeof raw.lastModifiedDateTime === "string" ? instantOfRfc3339(raw.lastModifiedDateTime) : null;
  const created = typeof raw.createdDateTime === "string" ? instantOfRfc3339(raw.createdDateTime) : null;
  const shownAs = wordOf(SHOWN_AS, raw.showAs);
  const organizer = personOf(raw.organizer);
  const link = isRecord(raw.onlineMeeting) ? callLinkOf(raw.onlineMeeting.joinUrl) : undefined;
  const made = newEventComponent({
    uid: shape.uid,
    dtstamp: instant(changed ?? created ?? nowMs),
    start: shape.times.start,
    ...(shape.times.end === null ? {} : { end: shape.times.end }),
    ...(shape.recurrenceId === undefined ? {} : { recurrenceId: shape.recurrenceId }),
    ...(shape.rule === undefined ? {} : { rule: shape.rule }),
    ...(summary === undefined ? {} : { summary }),
    ...(description === undefined ? {} : { description }),
    ...(location === undefined ? {} : { location }),
    ...(raw.isCancelled === true ? { status: "CANCELLED" as const } : {}),
    ...(shownAs === null ? {} : { transparency: shownAs }),
    ...(link === undefined ? {} : { url: link }),
    ...(organizer === null ? {} : { organizer }),
    attendees: inviteesOf(raw.attendees),
  });
  const more: Property[] = [];
  if (created !== null) more.push(timeProperty("CREATED", instant(created)));
  if (changed !== null) more.push(timeProperty("LAST-MODIFIED", instant(changed)));
  const cls = wordOf(CLASS, raw.sensitivity);
  if (cls !== null) more.push({ name: "CLASS", params: [], value: cls });
  // The entity tag is the precondition a change is made against; the change key is what it is made of.
  const version = filled(raw["@odata.etag"]) ?? filled(raw.changeKey) ?? "";
  return { kind: "upsert", id, version: version.length > MAX_PROVIDER_ID_CHARS ? "" : version, event: eventOf({ ...made, properties: [...made.properties, ...more] }), text: null };
}

/** One record of a calendar view. A day of a series is not an event yet: it is put with its series first. */
export type ViewRecord =
  | { readonly kind: "item"; readonly item: ChangeItem }
  | { readonly kind: "day"; readonly id: string; readonly seriesId: string; readonly seriesSegment: string; readonly originalStartMs: number; readonly changed: boolean; readonly raw: Json }
  | { readonly kind: "left"; readonly left: Left };

export function recordOf(raw: unknown, zones: ZoneSource, nowMs: number): ViewRecord {
  if (!isRecord(raw)) return { kind: "left", left: leftOut("", "unreadable") };
  const id = idOf(raw);
  if (typeof id !== "string") return { kind: "left", left: id };
  const left = (reason: LeftReason): ViewRecord => ({ kind: "left", left: leftOut(id, reason) });
  // "@removed": whatever its reason, the object of this id is no longer in the days asked for.
  if (raw["@removed"] !== undefined) return { kind: "item", item: { kind: "gone", id } };
  if (raw.type === "occurrence" || raw.type === "exception") {
    const seriesId = filled(raw.seriesMasterId);
    const seriesSegment = seriesId === undefined || seriesId.length > MAX_PROVIDER_ID_CHARS ? null : pathSegment(seriesId);
    // "originalStart ... always in UTC": which day of its series this is.
    const originalStartMs = typeof raw.originalStart === "string" ? instantOfRfc3339(raw.originalStart) : null;
    if (seriesId === undefined || seriesSegment === null || originalStartMs === null) return left("unreadable");
    return { kind: "day", id, seriesId, seriesSegment, originalStartMs, changed: raw.type === "exception", raw };
  }
  if (raw.type === "seriesMaster") {
    const series = seriesOfRecord(raw, zones, nowMs);
    return typeof series === "string" ? left(series) : { kind: "item", item: series.item };
  }
  if (raw.type !== "singleInstance") return left("unreadable");
  const uid = uidOf(raw);
  if (uid === null) return left("uid_too_long");
  const times = timesOf(raw, zones);
  if (typeof times === "string") return left(times);
  const item = upsertOf(raw, id, { uid, times }, nowMs);
  return typeof item === "string" ? left(item) : { kind: "item", item };
}

/** The record's identifier across calendars, its own id where it carries none; `null` past the reader's ceiling. */
function uidOf(raw: Json): string | null {
  const uid = filled(raw.iCalUId) ?? filled(raw.id) ?? "";
  return uid === "" || uid.length > MAX_UID_CHARS ? null : uid;
}

/**
 * A series as Microsoft keeps it on its master: the event with its rule, and the clock its days are
 * told on. A series whose rule cannot be said exactly, or whose clock nobody can read, is not made.
 */
export function seriesOfRecord(raw: Json, zones: ZoneSource, nowMs: number): { readonly item: Upsert; readonly series: SeriesClock } | LeftReason {
  const id = idOf(raw);
  if (typeof id !== "string" || raw.type !== "seriesMaster") return "unreadable";
  const uid = uidOf(raw);
  if (uid === null) return "uid_too_long";
  const rule = ruleOfRecurrence(raw.recurrence);
  if (rule === null) return "unreadable";
  // "recurrenceTimeZone ... If not specified, the time zone of the event is used."
  const range = isRecord(raw.recurrence) && isRecord(raw.recurrence.range) ? raw.recurrence.range : {};
  const clock = filled(range.recurrenceTimeZone) ?? filled(raw.originalStartTimeZone);
  const times = timesOf(raw, zones, clock);
  if (typeof times === "string") return times;
  if (!times.known) return "unreadable";
  const item = upsertOf(raw, id, { uid, times, rule }, nowMs);
  if (typeof item === "string") return item;
  const { start } = times;
  // A series of whole days still has a clock: Microsoft may tell a day of it by that clock's midnight.
  const zone = start.kind === "zoned" ? start.tzid : start.kind === "date" && clock !== undefined && !UTC_NAMES.has(clock) ? zoneNameOf(clock) : null;
  return { item, series: { uid, wholeDays: start.kind === "date", zone } };
}

/** A moment as the series tells its days: the day for a series of whole days, else the clock time in the series' zone. */
function onSeriesClock(ms: number, series: SeriesClock, zones: ZoneSource): EventTime | null {
  if (!series.wholeDays) return series.zone === null ? instant(ms) : onClock(ms, series.zone, zones).time;
  const own = series.zone === null ? null : wallIn(ms, series.zone, zones);
  const utc = wallFromSeconds(Math.floor(ms / MS_PER_SECOND));
  const day = own !== null && isMidnight(own) ? own : isMidnight(utc) ? utc : null;
  return day === null ? null : plainDate(day.year, day.month, day.day);
}

/**
 * A day of a series put with its series: its identity, and for a changed day the event that replaces
 * it, or the reason that event cannot be read (the day was shown all the same, and is no cancelled
 * one). `null` where the day itself cannot be told. Microsoft gives every day an identifier of its
 * own ("different for each occurrence in a recurring series"); the day is known by its series'.
 */
export function dayOfSeries(
  day: Extract<ViewRecord, { kind: "day" }>,
  series: SeriesClock,
  zones: ZoneSource,
  nowMs: number,
): { readonly seen: { readonly uid: string; readonly originalStart: EventTime }; readonly item: Upsert | LeftReason | null } | null {
  const originalStart = onSeriesClock(day.originalStartMs, series, zones);
  if (originalStart === null) return null;
  const seen = { uid: series.uid, originalStart };
  if (!day.changed) return { seen, item: null };
  const times = timesOf(day.raw, zones);
  return { seen, item: typeof times === "string" ? times : upsertOf(day.raw, day.id, { uid: series.uid, times, recurrenceId: originalStart }, nowMs) };
}
