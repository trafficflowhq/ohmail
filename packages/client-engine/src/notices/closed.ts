/**
 * WHAT CROSSES TO A NATIVE SIDE IS READ CLOSED. An alert set ahead and the phone's snapshot leave
 * the page for code that rings and draws with the app closed, so each is read here member by
 * member before anything holds it: a record with exactly its members, each a number in its range,
 * a word of its list, an id, or a label. A spare member, a missing or inherited one, a word that is
 * not listed, a number out of range: no record at all, never a record with the rest. What is
 * answered is a copy; a title is taken as one clean line again, never as it was handed.
 */
import { AHEAD_ID_MAX, AHEAD_MAX, type AheadSet, type NoticeAhead } from "./emitter.js";
import { NOTICE_ACTS, NOTICE_COUNT_MAX, NOTICE_LEAD_MAX_MIN, type Clock, type EventLabel, type NoticeAct, type NoticeDate } from "./kinds.js";
import { cleanNoticeText } from "./label.js";
import { aheadIdOf, idOf, instant, scopeOf, whole } from "./shapes.js";
import {
  CALENDAR_SNAPSHOT_VERSION, SNAPSHOT_DAYS, SNAPSHOT_DAY_EVENTS_MAX,
  type CalendarSnapshot, type SnapshotDay, type SnapshotEvent, type SnapshotMonth, type SnapshotSummary, type SummaryEvent,
} from "./snapshot.js";

/** The longest title text a reader looks at before cleaning it: far past what the label ever writes. */
const TITLE_IN_MAX = 1024;

type Members<T> = { readonly [K in keyof T]: unknown };

/**
 * The own members of `raw` when it is a record holding exactly `names`, each a plain value: `null`
 * for an array, a function, a record with a member too many (a symbol too) or too few, a member it
 * only inherits, or one behind a getter.
 */
function exactly<T>(raw: unknown, names: readonly (keyof T & string)[]): Members<T> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  if (Reflect.ownKeys(raw).length !== names.length) return null;
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const member = Object.getOwnPropertyDescriptor(raw, name);
    if (member === undefined || !("value" in member)) return null;
    out[name] = member.value;
  }
  return out as Members<T>;
}

/** A real list of at most `max`, each element read by `one`: `null` when any element is none. */
function listOf<T>(raw: unknown, max: number, one: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw) || raw.length > max) return null;
  const out: T[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const read = one(raw[i]);
    if (read === null) return null;
    out.push(read);
  }
  return out;
}

/** An event's label: one of the two closed words alone, or a title with its text and nothing else. */
export function readLabel(raw: unknown): EventLabel | null {
  const word = exactly<{ as: string }>(raw, ["as"]);
  if (word !== null) return word.as === "busy" || word.as === "event" ? { as: word.as } : null;
  const titled = exactly<{ as: string; text: string }>(raw, ["as", "text"]);
  if (titled === null || titled.as !== "title" || typeof titled.text !== "string" || titled.text.length > TITLE_IN_MAX) return null;
  const text = cleanNoticeText(titled.text);
  return text === null ? null : { as: "title", text };
}

/** The closed acts, in the list's own order, each once. */
function readActs(raw: unknown): NoticeAct[] | null {
  if (!Array.isArray(raw) || raw.length > NOTICE_ACTS.length) return null;
  const acts = NOTICE_ACTS.filter((act) => raw.includes(act));
  return acts.length === raw.length && acts.every((act, i) => raw[i] === act) ? acts : null;
}

const AHEAD_MEMBERS = ["id", "eventId", "atMs", "startMs", "allDay", "label", "leadMin", "acts"] as const;

/**
 * One alert set ahead, or `null`. Beyond its members' own shapes it holds what the maker made: it
 * rings its lead before its start, and its id is its event, its start and its lead.
 */
export function readAhead(raw: unknown): NoticeAhead | null {
  const m = exactly<NoticeAhead>(raw, AHEAD_MEMBERS);
  if (m === null) return null;
  const eventId = idOf(m.eventId);
  const label = readLabel(m.label);
  const acts = readActs(m.acts);
  if (eventId === null || label === null || acts === null) return null;
  if (!instant(m.atMs) || !instant(m.startMs) || !whole(m.leadMin, 0, NOTICE_LEAD_MAX_MIN)) return null;
  if (m.allDay !== true && m.allDay !== false) return null;
  if (m.atMs !== m.startMs - m.leadMin * 60_000) return null;
  const id = aheadIdOf(eventId, m.startMs, m.leadMin);
  if (m.id !== id || id.length > AHEAD_ID_MAX) return null;
  return { id, eventId, atMs: m.atMs, startMs: m.startMs, allDay: m.allDay, label, leadMin: m.leadMin, acts };
}

/** A set's alerts: at most the bound, ascending by their minute, each id once. One that is none refuses all. */
function readAlerts(raw: unknown): NoticeAhead[] | null {
  const alerts = listOf(raw, AHEAD_MAX, readAhead);
  if (alerts === null) return null;
  const ids = new Set<string>();
  for (let i = 0; i < alerts.length; i += 1) {
    const alert = alerts[i]!;
    if (ids.has(alert.id) || (i > 0 && alerts[i - 1]!.atMs > alert.atMs)) return null;
    ids.add(alert.id);
  }
  return alerts;
}

/** One account's alerts as a surface is handed them, or `null`. */
export function readAheadSet(raw: unknown): AheadSet | null {
  const m = exactly<AheadSet>(raw, ["scope", "alerts"]);
  if (m === null) return null;
  const scope = scopeOf(m.scope);
  const alerts = readAlerts(m.alerts);
  return scope === null || alerts === null ? null : { scope, alerts };
}

function readDate(raw: unknown): NoticeDate | null {
  const m = exactly<NoticeDate>(raw, ["month", "dom", "dow"]);
  if (m === null || !whole(m.month, 1, 12) || !whole(m.dom, 1, 31) || !whole(m.dow, 0, 6)) return null;
  return { month: m.month, dom: m.dom, dow: m.dow };
}

function readClock(raw: unknown): Clock | null {
  const m = exactly<Clock>(raw, ["hour", "minute", "day"]);
  if (m === null || !whole(m.hour, 0, 23) || !whole(m.minute, 0, 59)) return null;
  if (m.day === "today" || m.day === "tomorrow") return { hour: m.hour, minute: m.minute, day: m.day };
  const day = readDate(m.day);
  return day === null ? null : { hour: m.hour, minute: m.minute, day };
}

function readEvent(raw: unknown): SnapshotEvent | null {
  const m = exactly<SnapshotEvent>(raw, ["eventId", "label", "startMs", "endMs", "allDay", "toAnswer"]);
  if (m === null) return null;
  const eventId = idOf(m.eventId);
  const label = readLabel(m.label);
  if (eventId === null || label === null || !instant(m.startMs)) return null;
  if (m.endMs !== null && (!instant(m.endMs) || m.endMs < m.startMs)) return null;
  if ((m.allDay !== true && m.allDay !== false) || (m.toAnswer !== true && m.toAnswer !== false)) return null;
  return { eventId, label, startMs: m.startMs, endMs: m.endMs, allDay: m.allDay, toAnswer: m.toAnswer };
}

function readDay(raw: unknown): SnapshotDay | null {
  const m = exactly<SnapshotDay>(raw, ["year", "date", "events", "more"]);
  if (m === null || !whole(m.year, 1, 9999) || !whole(m.more, 0, NOTICE_COUNT_MAX)) return null;
  const date = readDate(m.date);
  const events = listOf(m.events, SNAPSHOT_DAY_EVENTS_MAX, readEvent);
  return date === null || events === null ? null : { year: m.year, date, events, more: m.more };
}

function readMonth(raw: unknown): SnapshotMonth | null {
  const m = exactly<SnapshotMonth>(raw, ["year", "month", "marked"]);
  if (m === null || !whole(m.year, 1, 9999) || !whole(m.month, 1, 12)) return null;
  const marked = listOf(m.marked, 31, (day) => (whole(day, 1, 31) ? day : null));
  if (marked === null || marked.some((day, i) => i > 0 && marked[i - 1]! >= day)) return null;
  return { year: m.year, month: m.month, marked };
}

function readSummaryEvent(raw: unknown): SummaryEvent | null {
  const m = exactly<SummaryEvent>(raw, ["label", "startMs", "allDay"]);
  if (m === null || !instant(m.startMs) || typeof m.allDay !== "boolean") return null;
  const label = readLabel(m.label);
  return label === null ? null : { label, startMs: m.startMs, allDay: m.allDay };
}

function readSummary(raw: unknown): SnapshotSummary | null {
  const fields = ["atMs", "events", "first", "toAnswer"] as const;
  const m = exactly<SnapshotSummary>(raw, fields) ?? exactly<SnapshotSummary>(raw, [...fields, "agenda"]);
  if (m === null || !instant(m.atMs) || !whole(m.events, 0, NOTICE_COUNT_MAX) || !whole(m.toAnswer, 0, NOTICE_COUNT_MAX)) return null;
  const first = m.first === null ? null : readClock(m.first);
  if (m.first !== null && first === null) return null;
  const agenda = m.agenda === undefined ? undefined : listOf(m.agenda, SNAPSHOT_DAY_EVENTS_MAX, readSummaryEvent);
  if (agenda === null || (agenda && agenda.length > m.events)) return null;
  return { atMs: m.atMs, events: m.events, first, toAnswer: m.toAnswer, ...(agenda ? { agenda } : {}) };
}

/** A zone by its name as the zone database writes names: no space, nothing that is not a name. */
const ZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;

const SNAPSHOT_MEMBERS = ["v", "scope", "writtenAt", "zone", "alerts", "days", "month", "toAnswer", "summary"] as const;

/**
 * The page's record for the phone, version 1, or `null`. What writes the file reads the record
 * through here first, so the file never holds anything but these members.
 */
export function readCalendarSnapshot(raw: unknown): CalendarSnapshot | null {
  const m = exactly<CalendarSnapshot>(raw, SNAPSHOT_MEMBERS);
  if (m === null || m.v !== CALENDAR_SNAPSHOT_VERSION) return null;
  const scope = scopeOf(m.scope);
  if (scope === null || !instant(m.writtenAt) || typeof m.zone !== "string" || !ZONE.test(m.zone)) return null;
  const alerts = readAlerts(m.alerts);
  const days = listOf(m.days, SNAPSHOT_DAYS, readDay);
  const month = readMonth(m.month);
  if (alerts === null || days === null || month === null || !whole(m.toAnswer, 0, NOTICE_COUNT_MAX)) return null;
  const summary = m.summary === null ? null : readSummary(m.summary);
  if (m.summary !== null && summary === null) return null;
  return { v: CALENDAR_SNAPSHOT_VERSION, scope, writtenAt: m.writtenAt, zone: m.zone, alerts, days, month, toAnswer: m.toAnswer, summary };
}
