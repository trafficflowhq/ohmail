import type { SeriesCancellation } from "./series-audience.js";
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

/** The fields a person may name for the days a press on a day and the days after it gives a series of their own. */
export const CONTINUED_FIELDS = ["title", "notes", "place", "callLink", "busy", "private", "alarms"] as const;
export type ContinuedField = (typeof CONTINUED_FIELDS)[number];

/**
 * Where the second half of a press on a day and the days after it comes from: the series (its
 * event's id), the day its days go on from (that day's key), and which of the new series' fields
 * the person named. The new series is made from that series' own component, and of the act's
 * fields only these, its start, its end and its repeat are written anew.
 */
export interface CalendarWriteContinuation {
  /** A split recorded with a version-bound audience, whose continuation is created before its end. */
  readonly confirmed?: true;
  readonly eventId: string;
  readonly at: string;
  readonly named: readonly ContinuedField[];
  readonly personalSeries?: true;
}

/** The provider copy of a separately changed occurrence reviewed by the person. */
export interface CalendarWriteException {
  readonly id: string;
  readonly providerId: string;
  readonly version: string;
  readonly occurrence: string;
  readonly masterReceipt?: {
    readonly version: string;
    readonly exceptionEndMs?: number;
    readonly exceptionSnapshot?: string;
  };
}

/**
 * What a `cal_writes` row's `payload` holds while it is owed: the act, the row it waits for
 * (`after`, a write of the same event recorded before it), and for one half of a two-part act which
 * half it is and the press's key (and, for the second half of a press on a day and the days after
 * it, where it comes from). An applied row keeps none of it: at most the day a series' end ended
 * it at ({@link appliedPayloadOf}).
 */
export type CalendarTransferProgress =
  | { readonly phase: "creating" }
  | { readonly phase: "verifying" | "removing" | "rollback"; readonly id: string; readonly version: string };

export interface CalendarTransfer {
  readonly source: string;
  readonly fields: CalendarEventFields;
  readonly progress?: CalendarTransferProgress;
}

export interface CalendarWritePayload {
  readonly v: typeof CALENDAR_WRITE_PAYLOAD_VERSION;
  readonly act: CalendarEventAct;
  readonly after: string | null;
  readonly part: { readonly of: string; readonly n: 1 | 2; readonly from?: CalendarWriteContinuation } | null;
  /** A cancellation may already have landed before its explicit retry reset the attempt counter. */
  readonly cancellationAttempted?: true;
  readonly exception?: CalendarWriteException;
  readonly seriesCancellation?: SeriesCancellation;
  readonly transfer?: CalendarTransfer;
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

/** An exception's broader scopes review both copies, carried in the existing base stamp. */
export function exceptionBaseOf(base: unknown): readonly [string, string] | null {
  if (typeof base !== "string" || base.length > 55) return null;
  const [occurrence, series, ...extra] = base.split("/");
  return extra.length === 0 && isIso(occurrence) && isIso(series) ? [occurrence, series] : null;
}

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
function based(v: Obj, own: readonly string[], optional: readonly string[] = [], pairedBase = false): { eventId: string; base: string; after?: string } | null {
  if (!closed(v, ["kind", "eventId", "base", ...own], ["after", ...optional])) return null;
  if (!isWriteUuid(v.eventId) || !(isIso(v.base) || (pairedBase && typeof v.base === "string" && exceptionBaseOf(v.base)))) return null;
  if (Object.hasOwn(v, "after") && !isWriteKey(v.after)) return null;
  return { eventId: v.eventId, base: v.base, ...(Object.hasOwn(v, "after") ? { after: v.after as string } : {}) };
}

function attendeeCopyOf(value: unknown) {
  if (!isObject(value) || !closed(value, ["calendarId", "attendee"]) ||
    !isWriteUuid(value.calendarId) || !text(value.attendee, CALENDAR_ADDRESS_MAX_BYTES) ||
    !fitsCalendarBytes(value.attendee, CALENDAR_ADDRESS_MAX_BYTES) || !value.attendee) return null;
  return { calendarId: value.calendarId, attendee: value.attendee };
}

function audienceOf(a: unknown) {
  const address = (s: unknown): s is string => typeof s === "string" && s !== "" &&
    text(s, CALENDAR_ADDRESS_MAX_BYTES) && fitsCalendarBytes(s, CALENDAR_ADDRESS_MAX_BYTES);
  if (!isObject(a) || !closed(a, ["organizer", "guests"]) ||
    (a.organizer !== null && !address(a.organizer)) || !Array.isArray(a.guests) ||
    a.guests.length > CALENDAR_WRITE_LIMITS.invitees || !a.guests.every(address) ||
    (a.guests.length > 0 && a.organizer === null)) return null;
  const guests = a.guests.map((s) => s.trim().toLowerCase());
  if (new Set(guests).size !== guests.length || guests.includes("")) return null;
  return { organizer: a.organizer?.trim().toLowerCase() ?? null, guests };
}

/**
 * An act as a device sent it, or as a row keeps it, or `null` for anything else: an unknown kind,
 * a key no act has, a field of the wrong shape, a list or a text past its bound.
 */
export function parseCalendarAct(v: unknown): CalendarEventAct | null {
  if (!isObject(v) || typeof v.kind !== "string") return null;
  switch (v.kind) {
    case "calendar_event_create": {
      if (!closed(v, ["kind", "eventId", "calendarId", "event"], ["invitationMessageId", "repeatSelected"]) || !isWriteUuid(v.eventId) || !isWriteUuid(v.calendarId)) return null;
      const event = fieldsOf(v.event, true);
      const invitation = v.invitationMessageId;
      if (invitation !== undefined && (!isWriteUuid(invitation) || event?.invitees.length)) return null;
      if (v.repeatSelected !== undefined && (v.repeatSelected !== true || invitation !== undefined || !event?.repeat)) return null;
      return event === null ? null : { kind: v.kind, eventId: v.eventId, calendarId: v.calendarId, event,
        ...(typeof invitation === "string" && { invitationMessageId: invitation }),
        ...(v.repeatSelected === true && { repeatSelected: true }) };
    }
    case "calendar_event_update": {
      const scope = changeScopeOf(v.scope);
      const pairedBase = scope !== null && scope.kind !== "occurrence" && Object.hasOwn(v, "audience") && !Object.hasOwn(v, "after");
      const b = based(v, ["scope", "change"], ["audience", "personalSeries", "invitationMessageId"], pairedBase);
      const change = fieldsOf(v.change, false);
      if (b === null || scope === null || change === null) return null;
      const invitation = v.invitationMessageId;
      if (invitation !== undefined) {
        return isWriteUuid(invitation) && scope.kind === "record" && change.busy !== undefined &&
          !Object.hasOwn(v, "audience") && !Object.hasOwn(v, "personalSeries")
          ? { kind: v.kind, ...b, scope, change, invitationMessageId: invitation } : null;
      }
      if (Object.hasOwn(v, "personalSeries")) {
        if (v.personalSeries !== true || Object.hasOwn(v, "audience") ||
          !Object.keys(change).every((field) => ["title", "notes", "place", "busy", "private"].includes(field))) return null;
        return { kind: v.kind, ...b, scope, change, personalSeries: true };
      }
      if (!Object.hasOwn(v, "audience")) return { kind: v.kind, ...b, scope, change };
      const audience = audienceOf(v.audience);
      return (scope.kind !== "record" && change.invitees !== undefined) || !audience ? null
        : { kind: v.kind, ...b, scope, change, audience };
    }
    case "calendar_event_delete": {
      const scope = removeScopeOf(v.scope);
      const hide = v.hide === true;
      if (Object.hasOwn(v, "hide") && (!hide || v.localOnly !== true || Object.hasOwn(v, "cancelledBy"))) return null;
      const b = based(v, ["scope"], ["audience", "localOnly", "cancellationMessage", "cancelledBy", "hide", "copy"],
        hide && scope?.kind === "occurrence");
      if (b === null || scope === null) return null;
      const copy = attendeeCopyOf(v.copy);
      if (hide ? copy === null : Object.hasOwn(v, "copy")) return null;
      const cancelledBy = v.cancelledBy;
      if (cancelledBy !== undefined && (v.localOnly !== true || !isWriteUuid(cancelledBy))) return null;
      if (Object.hasOwn(v, "localOnly")) return v.localOnly === true && scope.kind !== "following" && b.after === undefined && !Object.hasOwn(v, "audience") && !Object.hasOwn(v, "cancellationMessage")
        ? { kind: v.kind, ...b, scope, localOnly: true, ...(copy && { hide: true, copy }), ...(typeof cancelledBy === "string" && { cancelledBy }) } : null;
      const message = v.cancellationMessage;
      if (Object.hasOwn(v, "cancellationMessage") &&
        (scope.kind !== "record" || typeof message !== "string" || !message.trim() || message.length > CALENDAR_WRITE_LIMITS.titleChars ||
          !Object.hasOwn(v, "audience"))) return null;
      if (!Object.hasOwn(v, "audience")) return { kind: v.kind, ...b, scope };
      const audience = audienceOf(v.audience);
      return audience ? { kind: v.kind, ...b, scope, audience, ...(typeof message === "string" && { cancellationMessage: message }) } : null;
    }
    case "calendar_event_move": {
      const b = based(v, ["toCalendarId"], ["audience", "copyThenRemove"]);
      if (b === null || !isWriteUuid(v.toCalendarId) ||
        (Object.hasOwn(v, "copyThenRemove") && (v.copyThenRemove !== true || b.after !== undefined))) return null;
      const move = { kind: v.kind, ...b, toCalendarId: v.toCalendarId,
        ...(v.copyThenRemove === true && { copyThenRemove: true as const }) } as const;
      if (!Object.hasOwn(v, "audience")) return move;
      const audience = audienceOf(v.audience);
      return audience ? { ...move, audience } : null;
    }
    case "calendar_event_answer": {
      const b = based(v, ["scope", "answer"], ["copy"], !Object.hasOwn(v, "after") && changeScopeOf(v.scope)?.kind === "occurrence");
      const scope = changeScopeOf(v.scope);
      if (b === null || scope === null || scope.kind === "following") return null;
      if (v.answer !== "accepted" && v.answer !== "tentative" && v.answer !== "declined") return null;
      const copy = attendeeCopyOf(v.copy);
      if (Object.hasOwn(v, "copy") && copy === null) return null;
      return { kind: v.kind, ...b, scope, answer: v.answer, ...(copy && { copy }) };
    }
    default:
      return null;
  }
}

/**
 * Is this stored event a series, or one day of one: its own repeat rule or added days, or the day it
 * replaces?
 */
export function isSeriesRow(row: { readonly repeatRule: string | null; readonly recurrenceId: string; readonly addedDates: unknown }): boolean {
  return (row.repeatRule !== null && row.repeatRule !== "") || row.recurrenceId !== ""
    || (Array.isArray(row.addedDates) && row.addedDates.length > 0);
}

/**
 * What a stored event is, to a write: one event (`single`), a series by one repeat rule (`series`),
 * one day of a series that the provider holds changed (`day`), or a series whose days are listed or
 * that has more than one rule (`listed`), which no write makes.
 */
export type CalendarWriteRow = "single" | "series" | "day" | "listed";

/**
 * The stored event as a write reads it: what makes it a series, its start as stored, its excluded
 * days, and whose it is (its organizer's address, and the account's own answer on it where the
 * account is one of its invitees).
 */
export interface CalendarWriteRowFacts {
  readonly repeatRule: string | null;
  readonly recurrenceId: string;
  readonly addedDates: unknown;
  readonly excludedDates: unknown;
  readonly startKind: string;
  readonly startLocal: string;
  readonly startZone: string | null;
  /**
   * Whom the event names as its organizer, as door and drain read it off the stored text alike
   * (the providers' `storedObjectFacts`; where the store keeps no text, its own organizer): `null`
   * where its text shows no organizer in any spelling and no invitee the reader takes no address
   * from; else the one mail address its ORGANIZER lines name; `""` where the text does not show it
   * so (a line the reader takes no address from, or takes not at all, a principal's path, a urn; no
   * ORGANIZER line beside an invitee told by no address), which is never one of the account's own.
   */
  readonly organizer: string | null;
  readonly myAnswer: string | null;
  /**
   * Does the event's own component exclude days by a rule of their own (EXRULE) beside its repeat?
   * The store keeps no field of it: door and drain read it off the stored text alike (the providers'
   * `storedObjectFacts`). A series of more than one rule, which no act writes.
   */
  readonly excludesByRule: boolean;
  /**
   * Does a changed day of the series speak for the days after it too (RANGE=THISANDFUTURE), as its
   * stored text says (read as `excludesByRule` is)? Such a series is not split: a series of their own
   * made of its days from one on would lose what that day says of them.
   */
  readonly reachesForward: boolean;
}

export function writeRowOf(row: CalendarWriteRowFacts): CalendarWriteRow {
  if (row.recurrenceId !== "") return "day";
  if (row.excludesByRule || (Array.isArray(row.addedDates) && row.addedDates.length > 0)) return "listed";
  if (row.repeatRule === null || row.repeatRule === "") return "single";
  return row.repeatRule.includes("\n") ? "listed" : "series";
}

/** The days of a series that are not as its rule makes them: its excluded days and the changed days stored beside it. */
export function changedDaysOf(row: Pick<CalendarWriteRowFacts, "excludedDates">, changedRows: number): number {
  return (Array.isArray(row.excludedDates) ? row.excludedDates.length : 0) + changedRows;
}

/**
 * Is this text a day's key as the store writes it (`recurrence_id`): the milliseconds of the moment the
 * day was first at (a whole day's at its UTC midnight), or, where that moment cannot be said, its zone,
 * its clock time to the minute (seconds where it has any) and `false`.
 */
export function isOccurrenceKey(key: string): boolean {
  if (/^-?\d{1,16}$/.test(key)) return Number.isSafeInteger(Number(key));
  const tail = "|false";
  if (!key.endsWith(tail)) return false;
  const cut = key.lastIndexOf("|", key.length - tail.length - 1);
  return cut >= 0 && /^\d{8}T\d{4}(\d{2})?$/.test(key.slice(cut + 1, key.length - tail.length));
}

const sameStart = (t: CalendarTime, row: CalendarWriteRowFacts): boolean =>
  t.kind === row.startKind && t.value === row.startLocal && (t.zone ?? null) === row.startZone;

/** An address as an event names it, to compare with the account's own: lower case, without `mailto:`. */
const addressOf = (a: string): string => a.trim().toLowerCase().replace(/^mailto:/, "");

/** Positive organizer authority is independent of the calendar's write access. */
export function verifiedOrganizer(
  organizer: string | null, own: ReadonlySet<string>,
): boolean {
  const address = organizer === null ? "" : addressOf(organizer);
  return address !== "" && own.has(address);
}

export function sharedCopyNeedsProtection(
  row: Pick<CalendarWriteRowFacts, "organizer">, own: ReadonlySet<string>, access: string,
): boolean {
  return access === "writer" && !verifiedOrganizer(row.organizer, own);
}

/** An invitation on an owned calendar can name the account by an attendee address we do not know. */
export function isAttendeeCopy(
  row: Pick<CalendarWriteRowFacts, "organizer" | "myAnswer">, own: ReadonlySet<string>, access: string,
): boolean {
  if (verifiedOrganizer(row.organizer, own)) return false;
  if (access === "owner") return row.organizer !== null || row.myAnswer !== null;
  return row.myAnswer !== null;
}

/**
 * Why a write may not be made on a stored event, with the word the drain refuses it with:
 * `read_only` where the event is not the account's to change, `repeat_unsupported` where the act
 * is no shape of a series this version writes. The door answers the first `calendar_read_only`
 * (409), the second `validation_failed` (400).
 */
export interface CalendarWriteActRefusal {
  readonly word: "read_only" | "repeat_unsupported";
  readonly why: string;
}

/**
 * Why this act may not be written on this stored event as it stands, or `null`. One rule for the
 * door and the drain: a row the door recorded before a check is not sent either. `changedDays`:
 * {@link changedDaysOf}; `own`: the account's own addresses, lower case.
 *
 * - An attendee copy takes only the account's answer. Other events can be changed when the
 *   calendar grants write access, even when someone else organized the event.
 * - A series' listed days, or a series of more than one rule, are written by no act.
 * - One day of a series is named through its series (scope `occurrence` on the series' own row),
 *   never as a record of its own: a record's act on it would reach the series it stands in.
 * - Only a series has days to name.
 * - A series with changed days keeps its start, its repeat and its invitees: its changed days are
 *   named by the days its start and repeat make, and would then name days it no longer has.
 */
export function writeActRefusal(
  row: CalendarWriteRowFacts, act: Exclude<CalendarEventAct, { kind: "calendar_event_create" }>, changedDays: number, own: ReadonlySet<string>,
  access: string, reviewedException = false,
): CalendarWriteActRefusal | null {
  const readOnly = (why: string): CalendarWriteActRefusal => ({ word: "read_only", why });
  const shape = (why: string): CalendarWriteActRefusal => ({ word: "repeat_unsupported", why });
  if (isAttendeeCopy(row, own, access)) {
    if (act.kind !== "calendar_event_answer") return readOnly("this event is someone else's invitation: it takes an answer and nothing else");
    if (row.myAnswer === null) return readOnly("the account is not invited to this event");
  } else if (act.kind === "calendar_event_answer") return readOnly("the account is not invited to this event");
  const kind = writeRowOf(row);
  if (sharedCopyNeedsProtection(row, own, access)) {
    if (act.kind === "calendar_event_update" &&
      (row.organizer === "" || kind !== "single" || reviewedException || act.scope.kind !== "record" ||
        Object.keys(act.change).some((key) => !["title", "start", "end", "place", "notes"].includes(key)))) {
      return readOnly("this shared copy only takes changes to its own event details");
    }
    if (act.kind === "calendar_event_move" && row.organizer !== null)
      return readOnly("this shared copy cannot be moved to another calendar");
  }
  if (kind === "listed") return shape("a series with days listed, or with more than one rule, is not written");
  if (kind === "day") return shape("one day of a series is written through its series");
  if (kind === "series" && act.kind === "calendar_event_update" && act.change.invitees !== undefined)
    return shape("editing an existing repeat keeps its confirmed invitees");
  const scope = "scope" in act ? act.scope.kind : "record";
  if (scope !== "record" && kind !== "series") return shape("only a series has days to name");
  if ("scope" in act && act.scope.kind !== "record" && !isOccurrenceKey(act.scope.at)) return shape("a day of a series is named by its key");
  // The days from one on are told from a moment: the series ends the second before it, and goes on from it.
  if ("scope" in act && act.scope.kind === "following" && !/^\d{1,16}$/.test(act.scope.at)) {
    return shape("a day and the days after it are named by the moment the day was first at");
  }
  if (scope === "occurrence" && act.kind === "calendar_event_update" && (act.change.repeat !== undefined || act.change.invitees !== undefined)) {
    return shape("one day of a series has no repeat and no invitees of its own");
  }
  // The days from one day on go to a series of their own: a repeat they keep, and the invitees the series has.
  if (scope === "following" && act.kind === "calendar_event_update" && (act.change.repeat === null || act.change.invitees !== undefined)) {
    return shape("a day and the days after it keep a repeat, and the series' invitees");
  }
  // A changed day that speaks for the days after it would be lost to them in a series of their own (and those after the cut would go
  // back to the series' own time): such a series is not split.
  if (scope === "following" && act.kind === "calendar_event_update" && row.reachesForward) {
    return shape("a series with a changed day that speaks for the days after it (RANGE=THISANDFUTURE) is not split");
  }
  if (kind === "series" && changedDays > 0 && act.kind === "calendar_event_update" && scope === "record") {
    const c = act.change;
    if (c.repeat !== undefined || c.invitees !== undefined || (c.start !== undefined && !sameStart(c.start, row) && !(reviewedException && changedDays === 1))) {
      return shape("a series with changed days keeps its start, its repeat and its invitees");
    }
  }
  return null;
}

/** The payload a row is recorded with. */
export function writePayloadOf(act: CalendarEventAct, after: string | null, part: CalendarWritePayload["part"], exception?: CalendarWriteException): CalendarWritePayload {
  return { v: CALENDAR_WRITE_PAYLOAD_VERSION, act, after, part, ...(exception && { exception }) };
}

/**
 * What an applied row keeps in place of its act: nothing of the person's. A write that ended a
 * series before one of its days (a day and the days after it: the first part of a press, or their
 * removal alone) keeps that day, by its key and nothing else: the queue asks it of a later write of
 * the same series whether an end found at the provider may be this row's (the end it made is the
 * series ended at that day), and of a press's second part whether its first ended the series at the
 * day it goes on from. Every other applied row keeps nothing (`{}`).
 */
export function appliedPayloadOf(act: CalendarEventAct | null): { readonly ended: string } | Record<string, never> {
  return act !== null && "scope" in act && act.scope.kind === "following" && /^\d{1,16}$/.test(act.scope.at) ? { ended: act.scope.at } : {};
}

/** The day an applied row ended its series at ({@link appliedPayloadOf}), by its key; `null` for a row that keeps none, or any other payload. */
export function endedDayOf(payload: unknown): string | null {
  return isObject(payload) && closed(payload, ["ended"]) && typeof payload.ended === "string" && /^\d{1,16}$/.test(payload.ended) ? payload.ended : null;
}

function continuationOf(v: unknown): CalendarWriteContinuation | null {
  if (!isObject(v) || !closed(v, ["eventId", "at", "named"], ["personalSeries", "confirmed"]) ||
    (Object.hasOwn(v, "personalSeries") && v.personalSeries !== true) ||
    (Object.hasOwn(v, "confirmed") && v.confirmed !== true) ||
    !isWriteUuid(v.eventId) || !occurrenceKey(v.at) || !Array.isArray(v.named)) return null;
  const allowed: ReadonlySet<string> = new Set(CONTINUED_FIELDS);
  const named = v.named.filter((n): n is ContinuedField => typeof n === "string" && allowed.has(n));
  return named.length === v.named.length && new Set(named).size === named.length
    ? { eventId: v.eventId, at: v.at, named, ...(v.personalSeries === true && { personalSeries: true }),
      ...(v.confirmed === true && { confirmed: true }) }
    : null;
}

function storedExceptionOf(v: unknown): CalendarWriteException | null {
  if (!isObject(v) || !closed(v, ["id", "providerId", "version", "occurrence"], ["masterReceipt"]) ||
    !isWriteUuid(v.id) || !text(v.providerId, 8192) || !v.providerId ||
    !text(v.version, 8192) || !v.version || !occurrenceKey(v.occurrence)) return null;
  let masterReceipt: CalendarWriteException["masterReceipt"];
  if (Object.hasOwn(v, "masterReceipt")) {
    const r = v.masterReceipt;
    if (!isObject(r) || !closed(r, ["version"], ["exceptionEndMs", "exceptionSnapshot"]) || !text(r.version, 8192) || !r.version)
      return null;
    const end = r.exceptionEndMs;
    if (Object.hasOwn(r, "exceptionEndMs") &&
      (typeof end !== "number" || !Number.isSafeInteger(end) || Math.abs(end) > 8.64e15)) return null;
    const snapshot = r.exceptionSnapshot;
    if (Object.hasOwn(r, "exceptionSnapshot") &&
      (typeof snapshot !== "string" || !/^[0-9a-f]{64}$/.test(snapshot))) return null;
    masterReceipt = { version: r.version, ...(typeof end === "number" && { exceptionEndMs: end }),
      ...(typeof snapshot === "string" && { exceptionSnapshot: snapshot }) };
  }
  return { id: v.id, providerId: v.providerId, version: v.version, occurrence: v.occurrence,
    ...(masterReceipt && { masterReceipt }) };
}

/** A row's payload as this version reads it, or `null` for one it does not know: an applied row's, another version's, a damaged one. */
function cancellationOf(value: unknown, act: CalendarEventAct): SeriesCancellation | null {
  if (act.kind !== "calendar_event_delete" || act.scope.kind !== "record" || !act.audience || act.localOnly ||
    !isObject(value) || !closed(value, ["message", "overrides"]) || typeof value.message !== "string" ||
    value.message.length > CALENDAR_WRITE_LIMITS.titleChars || !Array.isArray(value.overrides) ||
    value.overrides.length > CALENDAR_WRITE_LIMITS.invitees) return null;
  const overrides: { id: string; version: string }[] = [];
  const seen = new Set<string>();
  for (const entry of value.overrides) {
    if (!isObject(entry) || !closed(entry, ["id", "version"]) ||
      typeof entry.id !== "string" || !entry.id || entry.id.length > 2048 || seen.has(entry.id) ||
      typeof entry.version !== "string" || !entry.version || entry.version.length > 2048) return null;
    seen.add(entry.id);
    overrides.push({ id: entry.id, version: entry.version });
  }
  return { overrides, message: value.message };
}

function transferOf(value: unknown, act: CalendarEventAct): CalendarTransfer | null {
  if (act.kind !== "calendar_event_move" || act.after || (act.audience && act.audience.guests.length) ||
    !isObject(value) || !closed(value, ["source", "fields"], ["progress"]) || typeof value.source !== "string" || !value.source || value.source.length > 2048) return null;
  const fields = fieldsOf(value.fields, true);
  if (!fields || fields.invitees.length) return null;
  if (!Object.hasOwn(value, "progress")) return { fields, source: value.source };
  const p = value.progress;
  if (!isObject(p)) return null;
  if (p.phase === "creating" && closed(p, ["phase"])) return { fields, source: value.source, progress: { phase: p.phase } };
  if ((p.phase !== "verifying" && p.phase !== "removing" && p.phase !== "rollback") ||
    !closed(p, ["phase", "id", "version"]) || typeof p.id !== "string" || !p.id || p.id.length > 2048 ||
    typeof p.version !== "string" || !p.version || p.version.length > 2048) return null;
  return { fields, source: value.source, progress: { phase: p.phase, id: p.id, version: p.version } };
}

export function parseWritePayload(v: unknown): CalendarWritePayload | null {
  if (!isObject(v) || !closed(v, ["v", "act", "after", "part"], ["cancellationAttempted", "exception", "seriesCancellation", "transfer"]) || v.v !== CALENDAR_WRITE_PAYLOAD_VERSION) return null;
  const act = parseCalendarAct(v.act);
  if (act === null) return null;
  if (Object.hasOwn(v, "cancellationAttempted") && (v.cancellationAttempted !== true || act.kind !== "calendar_event_delete")) return null;
  if (v.after !== null && !isWriteUuid(v.after)) return null;
  let part: CalendarWritePayload["part"] = null;
  if (v.part !== null) {
    if (!isObject(v.part) || !closed(v.part, ["of", "n"], ["from"]) || !isWriteKey(v.part.of) || (v.part.n !== 1 && v.part.n !== 2)) return null;
    if (!Object.hasOwn(v.part, "from")) part = { of: v.part.of, n: v.part.n };
    else {
      const from = continuationOf(v.part.from);
      if (from === null || v.part.n !== 2) return null;
      part = { of: v.part.of, n: v.part.n, from };
    }
  }
  const exception = Object.hasOwn(v, "exception") ? storedExceptionOf(v.exception) : undefined;
  if (exception === null) return null;
  const seriesCancellation = Object.hasOwn(v, "seriesCancellation") ? cancellationOf(v.seriesCancellation, act) : undefined;
  if (seriesCancellation === null) return null;
  const transfer = Object.hasOwn(v, "transfer") ? transferOf(v.transfer, act) : undefined;
  if (transfer === null || (transfer && (part || v.after))) return null;
  if (exception && (
    exception.id !== act.eventId ||
    !(act.kind === "calendar_event_update" && act.audience || act.kind === "calendar_event_answer" && exceptionBaseOf(act.base)) ||
    (act.scope.kind !== "record" && (act.scope.at !== exception.occurrence || exception.masterReceipt !== undefined))
  )) return null;
  return { v: CALENDAR_WRITE_PAYLOAD_VERSION, act, after: v.after, part, ...(exception && { exception }),
    ...(v.cancellationAttempted === true && { cancellationAttempted: true }), ...(seriesCancellation && { seriesCancellation }), ...(transfer && { transfer }) };
}
