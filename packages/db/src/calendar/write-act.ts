/**
 * A PERSON'S ACT ON AN EVENT, AS THE WRITE QUEUE KEEPS IT: one parser for the route that records it
 * and for the drain that reads it back, so that a stored row holds nothing the door would not take
 * and an act of a shape this version does not know is refused, never guessed at.
 *
 * The parser reads shapes and bounds only: closed keys, the right types, uuids, times in the store's
 * spelling, lists and texts within their limits. What needs the calendar's rules (a repeat's
 * grammar, a zone, an address) the door asks of the calendar core, and the drain again where it
 * turns an act into a provider's request.
 */
import type {
  CalendarChangeScope, CalendarEventAct, CalendarEventFields, CalendarRemoveScope, CalendarTime, CalendarWriteInvitee,
} from "@ohmail/wire";
import { CALENDAR_ADDRESS_MAX_BYTES, CALENDAR_OCCURRENCE_KEY_MAX_BYTES, fitsCalendarBytes } from "./bounds.js";

/** Every bound of a write, each a first value. */
export const CALENDAR_WRITE_LIMITS = {
  /** The key a device makes for one press: printable, at most this long. */
  keyChars: 64,
  /** One act, as JSON. */
  payloadBytes: 65_536,
  invitees: 100,
  alarms: 5,
  /** A reminder at most four weeks before its event. */
  alarmMinutes: 40_320,
  /** Writes waiting or refused, per account and per event. */
  openPerAccount: 200,
  openPerEvent: 8,
  titleChars: 1_000,
  placeChars: 2_000,
  notesChars: 32_000,
  linkChars: 8_192,
  nameChars: 200,
  repeatChars: 1_000,
  zoneChars: 64,
} as const;

/** The queue's own spelling of an act, and the version of that spelling. */
export const CALENDAR_WRITE_PAYLOAD_VERSION = 1;

/**
 * What a `cal_writes` row's `payload` holds while it is owed: the act, the row it waits for
 * (`after`, a write of the same event recorded before it), and for one half of a two-part act which
 * half it is and the press's key. An applied row keeps none of it.
 */
export interface CalendarWritePayload {
  readonly v: typeof CALENDAR_WRITE_PAYLOAD_VERSION;
  readonly act: CalendarEventAct;
  readonly after: string | null;
  readonly part: { readonly of: string; readonly n: 1 | 2 } | null;
}

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** `o` has every key of `required`, and none outside `required` and `optional`. */
function closed(o: Obj, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(o).every((k) => allowed.has(k)) && required.every((k) => Object.hasOwn(o, k));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isWriteUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v.toLowerCase()) && v === v.toLowerCase();

const PRINTABLE_KEY = /^[\x21-\x7e]+$/;
/** A press's key as a device makes it: printable ASCII, at most `keyChars`. */
export const isWriteKey = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= CALENDAR_WRITE_LIMITS.keyChars && PRINTABLE_KEY.test(v);

/** Is every code unit of `s` a character, or half of a whole pair? */
function wholePairs(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit < 0xd800 || unit > 0xdbff) continue;
    const next = s.charCodeAt(i + 1);
    if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    i++;
  }
  return true;
}

/** A text a row can hold: no U+0000, no half of a pair, at most `max` characters. */
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max && !v.includes("\u0000") && wholePairs(v);
const textOrNull = (v: unknown, max: number): v is string | null => v === null || text(v, max);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v));

const TIME_VALUE: Readonly<Record<CalendarTime["kind"], RegExp>> = {
  date: /^\d{8}$/,
  instant: /^\d{8}T\d{6}Z$/,
  zoned: /^\d{8}T\d{6}$/,
  floating: /^\d{8}T\d{6}$/,
};
const ZONE_NAME = /^[A-Za-z0-9_+\-/]+$/;

function timeOf(v: unknown): CalendarTime | null {
  if (!isObject(v) || typeof v.kind !== "string" || !Object.hasOwn(TIME_VALUE, v.kind)) return null;
  const kind = v.kind as CalendarTime["kind"];
  if (kind === "zoned") {
    if (!closed(v, ["kind", "value", "zone"])) return null;
    if (typeof v.zone !== "string" || v.zone.length > CALENDAR_WRITE_LIMITS.zoneChars || !ZONE_NAME.test(v.zone)) return null;
  } else if (!closed(v, ["kind", "value"])) return null;
  if (typeof v.value !== "string" || !TIME_VALUE[kind].test(v.value)) return null;
  return kind === "zoned" ? { kind, value: v.value, zone: v.zone as string } : { kind, value: v.value };
}

function inviteeOf(v: unknown): CalendarWriteInvitee | null {
  if (!isObject(v) || !closed(v, ["address", "name", "role"])) return null;
  if (typeof v.address !== "string" || v.address === "" || !fitsCalendarBytes(v.address, CALENDAR_ADDRESS_MAX_BYTES) || !text(v.address, CALENDAR_ADDRESS_MAX_BYTES)) return null;
  if (!textOrNull(v.name, CALENDAR_WRITE_LIMITS.nameChars)) return null;
  if (v.role !== "required" && v.role !== "optional") return null;
  return { address: v.address, name: v.name, role: v.role };
}

const FIELD_KEYS = ["title", "start", "end", "notes", "place", "callLink", "busy", "private", "repeat", "invitees", "alarms"] as const;

/** One field of an event as a person writes it, checked; `undefined` where it is not one. */
function fieldOf(key: (typeof FIELD_KEYS)[number], v: unknown): unknown {
  const L = CALENDAR_WRITE_LIMITS;
  switch (key) {
    case "title": return text(v, L.titleChars) ? v : undefined;
    case "start":
    case "end": return timeOf(v) ?? undefined;
    case "notes": return textOrNull(v, L.notesChars) ? v : undefined;
    case "place": return textOrNull(v, L.placeChars) ? v : undefined;
    case "callLink": return v === null || (text(v, L.linkChars) && v.startsWith("https://")) ? v : undefined;
    case "busy":
    case "private": return typeof v === "boolean" ? v : undefined;
    case "repeat": return v === null || (typeof v === "string" && v !== "" && v.length <= L.repeatChars && PRINTABLE_KEY.test(v)) ? v : undefined;
    case "invitees": {
      if (!Array.isArray(v) || v.length > L.invitees) return undefined;
      const out = v.map(inviteeOf);
      if (out.some((i) => i === null)) return undefined;
      const addresses = new Set(out.map((i) => i!.address.toLowerCase()));
      return addresses.size === out.length ? out : undefined;
    }
    case "alarms": {
      if (!Array.isArray(v) || v.length > L.alarms) return undefined;
      const ok = v.every((m) => typeof m === "number" && Number.isInteger(m) && m >= 0 && m <= L.alarmMinutes);
      return ok && new Set(v).size === v.length ? [...v] : undefined;
    }
  }
}

/** An event's fields: every one of them (a new event), or at least one (a change). */
function fieldsOf(v: unknown, whole: true): CalendarEventFields | null;
function fieldsOf(v: unknown, whole: false): Partial<CalendarEventFields> | null;
function fieldsOf(v: unknown, whole: boolean): Partial<CalendarEventFields> | null {
  if (!isObject(v)) return null;
  if (whole ? !closed(v, FIELD_KEYS) : !closed(v, [], FIELD_KEYS)) return null;
  const out: Record<string, unknown> = {};
  for (const key of FIELD_KEYS) {
    if (!Object.hasOwn(v, key)) continue;
    const field = fieldOf(key, v[key]);
    if (field === undefined) return null;
    out[key] = field;
  }
  return Object.keys(out).length === 0 ? null : (out as Partial<CalendarEventFields>);
}

const occurrenceKey = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && fitsCalendarBytes(v, CALENDAR_OCCURRENCE_KEY_MAX_BYTES) && text(v, CALENDAR_OCCURRENCE_KEY_MAX_BYTES);

function changeScopeOf(v: unknown): CalendarChangeScope | null {
  if (!isObject(v)) return null;
  if (v.kind === "record") return closed(v, ["kind"]) ? { kind: "record" } : null;
  if (v.kind === "occurrence") return closed(v, ["kind", "at"]) && occurrenceKey(v.at) ? { kind: "occurrence", at: v.at } : null;
  if (v.kind === "following") {
    return closed(v, ["kind", "at", "newEventId"]) && occurrenceKey(v.at) && isWriteUuid(v.newEventId)
      ? { kind: "following", at: v.at, newEventId: v.newEventId } : null;
  }
  return null;
}

function removeScopeOf(v: unknown): CalendarRemoveScope | null {
  if (!isObject(v)) return null;
  if (v.kind === "record") return closed(v, ["kind"]) ? { kind: "record" } : null;
  if (v.kind === "occurrence") return closed(v, ["kind", "at"]) && occurrenceKey(v.at) ? { kind: "occurrence", at: v.at } : null;
  if (v.kind === "following") return closed(v, ["kind", "at"]) && occurrenceKey(v.at) ? { kind: "following", at: v.at } : null;
  return null;
}

/** The parts every act on an existing event names, checked: its id, the copy's time, the key it follows. */
function based(v: Obj, own: readonly string[]): { eventId: string; base: string; after?: string } | null {
  if (!closed(v, ["kind", "eventId", "base", ...own], ["after"])) return null;
  if (!isWriteUuid(v.eventId) || !isIso(v.base)) return null;
  if (Object.hasOwn(v, "after") && !isWriteKey(v.after)) return null;
  return { eventId: v.eventId, base: v.base, ...(Object.hasOwn(v, "after") ? { after: v.after as string } : {}) };
}

/**
 * An act as a device sent it, or as a row keeps it, or `null` for anything else: an unknown kind,
 * a key no act has, a field of the wrong shape, a list or a text past its bound.
 */
export function parseCalendarAct(v: unknown): CalendarEventAct | null {
  if (!isObject(v) || typeof v.kind !== "string") return null;
  switch (v.kind) {
    case "calendar_event_create": {
      if (!closed(v, ["kind", "eventId", "calendarId", "event"]) || !isWriteUuid(v.eventId) || !isWriteUuid(v.calendarId)) return null;
      const event = fieldsOf(v.event, true);
      return event === null ? null : { kind: v.kind, eventId: v.eventId, calendarId: v.calendarId, event };
    }
    case "calendar_event_update": {
      const b = based(v, ["scope", "change"]);
      const scope = changeScopeOf(v.scope);
      const change = fieldsOf(v.change, false);
      return b === null || scope === null || change === null ? null : { kind: v.kind, ...b, scope, change };
    }
    case "calendar_event_delete": {
      const b = based(v, ["scope"]);
      const scope = removeScopeOf(v.scope);
      return b === null || scope === null ? null : { kind: v.kind, ...b, scope };
    }
    case "calendar_event_move": {
      const b = based(v, ["toCalendarId"]);
      return b === null || !isWriteUuid(v.toCalendarId) ? null : { kind: v.kind, ...b, toCalendarId: v.toCalendarId };
    }
    case "calendar_event_answer": {
      const b = based(v, ["scope", "answer"]);
      const scope = changeScopeOf(v.scope);
      if (b === null || scope === null || scope.kind === "following") return null;
      if (v.answer !== "accepted" && v.answer !== "tentative" && v.answer !== "declined") return null;
      return { kind: v.kind, ...b, scope, answer: v.answer };
    }
    default:
      return null;
  }
}

/**
 * Is this stored event a series, or one day of one: its own repeat rule or added days, or the day it
 * replaces? No act touches such a row until series are written, each repeat proven at its provider:
 * the door refuses it, and the drain refuses one recorded before that.
 */
export function isSeriesRow(row: { readonly repeatRule: string | null; readonly recurrenceId: string; readonly addedDates: unknown }): boolean {
  return (row.repeatRule !== null && row.repeatRule !== "") || row.recurrenceId !== ""
    || (Array.isArray(row.addedDates) && row.addedDates.length > 0);
}

/** The payload a row is recorded with. */
export function writePayloadOf(act: CalendarEventAct, after: string | null, part: CalendarWritePayload["part"]): CalendarWritePayload {
  return { v: CALENDAR_WRITE_PAYLOAD_VERSION, act, after, part };
}

/** A row's payload as this version reads it, or `null` for one it does not know: an applied row's, another version's, a damaged one. */
export function parseWritePayload(v: unknown): CalendarWritePayload | null {
  if (!isObject(v) || !closed(v, ["v", "act", "after", "part"]) || v.v !== CALENDAR_WRITE_PAYLOAD_VERSION) return null;
  const act = parseCalendarAct(v.act);
  if (act === null) return null;
  if (v.after !== null && !isWriteUuid(v.after)) return null;
  let part: CalendarWritePayload["part"] = null;
  if (v.part !== null) {
    if (!isObject(v.part) || !closed(v.part, ["of", "n"]) || !isWriteKey(v.part.of) || (v.part.n !== 1 && v.part.n !== 2)) return null;
    part = { of: v.part.of, n: v.part.n };
  }
  return { v: CALENDAR_WRITE_PAYLOAD_VERSION, act, after: v.after, part };
}
