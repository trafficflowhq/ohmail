/**
 * THE MAPPER: one stored object of a provider's page, as the rows `cal_events` keeps of it, with
 * each row's invitees and reminders. Pure: no store, no clock. An object is mapped whole or not at
 * all; one that cannot be kept (an id past the store's bounds, a start nobody can place) is left
 * out, which spares its stored copy from the drop and writes nothing of it.
 *
 * Every time is kept as written (`storedTimeOf`) and the range is derived by the one function the
 * services use too (`derivedRange`). Never stored here: whether an invitation is held back, which
 * calendar is the default, whether a device's copy was cut: those belong to others and are kept on
 * an update.
 */
import { portableCalendarText } from "@ohmail/cal-providers";
import { createHash } from "node:crypto";
import {
  derivedRange, formatDuration, recurrenceKeyOf, recurrenceKeyString, storedTimeOf,
  type Attendee, type CalEvent, type EventTime, type StoredTime, type ZoneSource,
} from "@ohmail/cal-core";
import type { ChangeItem } from "@ohmail/cal-providers";
import {
  CALENDAR_ADDRESS_MAX_BYTES, CALENDAR_OCCURRENCE_KEY_MAX_BYTES, CALENDAR_PROVIDER_ID_MAX_BYTES,
  CALENDAR_UID_MAX_BYTES, connectedAttendee, fitsCalendarBytes,
} from "@trafficflow/db/calendar";
import { storableKey, wholePairs } from "./storable.js";

/** An upsert of a page, as the port hands it. */
export type Upsert = Extract<ChangeItem, { readonly kind: "upsert" }>;

/** A call's address is kept as a link only on TLS and up to this length. */
export const CALL_LINK_MAX_CHARS = 8_192;
/** A reminder further ahead than this is nobody's reminder. */
const ALARM_MAX_MINUTES = 366 * 24 * 60;

/** One row of `cal_events`, without its own id, account and calendar, which the caller's key decides. */
export interface EventRowValues {
  readonly providerId: string;
  /** The provider's version of the object; `null` where it gave none or one no row holds as it is, which never matches anything. */
  readonly versionTag: string | null;
  readonly uid: string;
  readonly recurrenceId: string;
  readonly sequence: number;
  readonly status: "confirmed" | "tentative" | "cancelled";
  readonly title: string;
  readonly notes: string | null;
  readonly place: string | null;
  readonly callLink: string | null;
  readonly startKind: StoredTime["kind"];
  readonly startLocal: string;
  readonly startZone: string | null;
  readonly endKind: StoredTime["kind"] | null;
  readonly endLocal: string | null;
  readonly endZone: string | null;
  readonly duration: string | null;
  readonly thisAndFuture: boolean;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly occurrenceAt: Date | null;
  readonly repeatRule: string | null;
  /** The object's own excluded days; the store unites or replaces them by the provider's kind. */
  readonly excludedDates: readonly StoredTime[];
  readonly addedDates: readonly StoredTime[] | null;
  readonly busy: boolean;
  readonly private: boolean;
  readonly organizer: string | null;
  readonly organizerName: string | null;
  readonly myAnswer: "none" | "accepted" | "declined" | "tentative" | "delegated" | null;
  /** The provider audience could not be kept in full. */
  readonly partial: boolean;
  /** The object's whole text where the provider keeps one (CalDAV, a subscription), on one row of it. */
  readonly original: string | null;
  readonly portableCopy: boolean;
  readonly googleDefaultEvent: boolean;
}

export interface InviteeValues {
  readonly address: string;
  readonly name: string | null;
  readonly role: "chair" | "required" | "optional" | "info";
  readonly answer: "none" | "accepted" | "declined" | "tentative" | "delegated";
}

export interface AlarmValues {
  readonly minutesBefore: number;
  readonly method: "notice" | "mail";
}

export interface MappedRow {
  readonly values: EventRowValues;
  readonly invitees: readonly InviteeValues[];
  readonly alarms: readonly AlarmValues[];
}

/**
 * Why an object was left out: never stored, never dropped for it. `unstorable`: one of its values
 * is something no row can hold (`storable.ts`, or a time that derives no moment), and writing it
 * would fail with every row written beside it, or keep it under a name it could not be found by
 * again.
 */
export type MapRefusal = "id_too_long" | "uid_too_long" | "occurrence_too_long" | "no_range" | "twice" | "unstorable";

export type Mapped = { readonly ok: true; readonly rows: readonly MappedRow[] } | { readonly ok: false; readonly reason: MapRefusal };

export interface MapContext {
  readonly zones: ZoneSource;
  /** The account's own addresses in lower case: its mailboxes' and the connection's principal where that is one. */
  readonly ownAddresses: ReadonlySet<string>;
  readonly principal?: string | null;
}

/** The key a store keeps an occurrence under: the core's one form, `''` for a series or a single event. */
export function occurrenceKey(t: EventTime | null, zones: ZoneSource): string {
  return t === null ? "" : recurrenceKeyString(recurrenceKeyOf(t, zones));
}

const DIGITS = "0123456789";
const allDigits = (s: string): boolean => s !== "" && [...s].every((c) => DIGITS.includes(c));

/**
 * A time that has this occurrence key, as far as a key says one: the way back from
 * {@link occurrenceKey}. A key of milliseconds is that moment (a whole day is kept as its UTC
 * midnight, which has the same key); a key of a clock time is that clock time, in its zone or in
 * none. `null` for the empty key and for any text that is no key of the core's.
 */
export function timeOfKey(key: string): EventTime | null {
  const digits = key.startsWith("-") ? key.slice(1) : key;
  if (allDigits(digits)) {
    const epochMs = Number(key);
    return Number.isSafeInteger(epochMs) ? { kind: "instant", epochMs } : null;
  }
  // `<zone>|YYYYMMDDTHHMM[SS]|false`: read from its end, since a zone's name is a stranger's text.
  const tail = "|false";
  if (!key.endsWith(tail)) return null;
  const cut = key.lastIndexOf("|", key.length - tail.length - 1);
  if (cut < 0) return null;
  const [tzid, clock] = [key.slice(0, cut), key.slice(cut + 1, key.length - tail.length)];
  const [day, time] = [clock.slice(0, 8), clock.slice(9)];
  if (clock[8] !== "T" || !allDigits(day) || day.length !== 8 || !allDigits(time) || (time.length !== 4 && time.length !== 6)) return null;
  const n = (text: string, from: number, to: number): number => Number(text.slice(from, to));
  const wall = { year: n(day, 0, 4), month: n(day, 4, 6), day: n(day, 6, 8), hour: n(time, 0, 2), minute: n(time, 2, 4), second: time.length === 6 ? n(time, 4, 6) : 0 };
  return tzid === "" ? { kind: "floating", wall } : { kind: "zoned", wall, tzid };
}

/** A UID for an event that names none: stable for the object, and never a UID a writer could have meant. */
export function uidOf(event: CalEvent, providerId: string): string {
  if (event.uid !== null && event.uid !== "") return event.uid;
  return `no-uid:${createHash("sha256").update(providerId).digest("hex").slice(0, 32)}`;
}

const STATUS: Readonly<Record<string, EventRowValues["status"]>> = {
  CONFIRMED: "confirmed", TENTATIVE: "tentative", CANCELLED: "cancelled",
};
const ROLE: Readonly<Record<string, InviteeValues["role"]>> = {
  CHAIR: "chair", "REQ-PARTICIPANT": "required", "OPT-PARTICIPANT": "optional", "NON-PARTICIPANT": "info",
};
const ANSWER: Readonly<Record<string, InviteeValues["answer"]>> = {
  "NEEDS-ACTION": "none", ACCEPTED: "accepted", DECLINED: "declined", TENTATIVE: "tentative", DELEGATED: "delegated",
};

/** A link to a call: an https address the URL reader accepts, short enough to keep. */
function callLinkOf(url: string | null): string | null {
  if (url === null || url.length > CALL_LINK_MAX_CHARS || !URL.canParse(url)) return null;
  return new URL(url).protocol === "https:" ? url : null;
}

/** Invitees by mail address only, each once, in the order written; an address past the store's bound is not kept. */
function inviteesOf(attendees: readonly Attendee[]): InviteeValues[] {
  const out = new Map<string, InviteeValues>();
  for (const a of attendees) {
    if (a.email === null || out.has(a.email) || !fitsCalendarBytes(a.email, CALENDAR_ADDRESS_MAX_BYTES)) continue;
    out.set(a.email, {
      address: a.email,
      name: a.name,
      role: ROLE[a.role ?? "REQ-PARTICIPANT"] ?? "required",
      answer: ANSWER[a.partstat ?? "NEEDS-ACTION"] ?? "none",
    });
  }
  return [...out.values()];
}

/** Reminders that ring at or before the start, each once. Absolute and end-relative ones are not kept. */
function alarmsOf(event: CalEvent): AlarmValues[] {
  const out = new Map<string, AlarmValues>();
  for (const a of event.alarms) {
    if (a.trigger === null || a.trigger.kind !== "relative" || a.trigger.to !== "START") continue;
    const d = a.trigger.duration;
    const signedMinutes = (d.negative ? -1 : 1) * ((d.weeks * 7 + d.days) * 1440 + d.hours * 60 + d.minutes + d.seconds / 60);
    const minutesBefore = Math.round(-signedMinutes);
    if (minutesBefore < 0 || minutesBefore > ALARM_MAX_MINUTES) continue;
    const method = a.action === "EMAIL" ? "mail" : "notice";
    out.set(`${minutesBefore}|${method}`, { minutesBefore, method });
  }
  return [...out.values()];
}

/** The largest whole number an `integer` column takes. */
const INTEGER_MAX = 2_147_483_647;

/** Does any text in `v`, however deep, hold U+0000? No text or JSON column of Postgres takes one. */
function holdsNul(v: unknown): boolean {
  if (typeof v === "string") return v.includes("\u0000");
  if (Array.isArray(v)) return v.some(holdsNul);
  if (v !== null && typeof v === "object" && !(v instanceof Date)) return Object.values(v).some(holdsNul);
  return false;
}

/** Does this Date hold a moment? One derived from a length no clock reaches holds none. */
const isMoment = (d: Date): boolean => Number.isFinite(d.getTime());

/**
 * Can the store keep this row as it is? Every text of it, its invitees' included, without U+0000;
 * the three texts it is found again by as they are; the times it keeps as JSON in whole characters
 * (a JSON column refuses half a pair); the three moments its range is derived as, each one a Date
 * holds (a length of a thousand million weeks derives none, and such a Date fails before the store
 * is asked, with the page beside it); its counter inside an integer. A person who can put an event
 * into someone's calendar can write any of these, and one such row must cost that event alone,
 * never the page it came on.
 */
function storable(row: MappedRow): boolean {
  if (holdsNul(row)) return false;
  const v = row.values;
  if (!storableKey(v.providerId) || !storableKey(v.uid) || !storableKey(v.recurrenceId)) return false;
  if (![v.startsAt, v.endsAt, v.occurrenceAt].every((d) => d === null || isMoment(d))) return false;
  for (const t of [...v.excludedDates, ...(v.addedDates ?? [])]) {
    if (!wholePairs(t.value) || !wholePairs(t.zone ?? "")) return false;
  }
  return Number.isInteger(v.sequence) && Math.abs(v.sequence) <= INTEGER_MAX;
}

function rowOf(item: Upsert, ctx: MapContext, original: string | null): MappedRow | MapRefusal {
  const e = item.event;
  if (e.start === null) return "no_range";
  const uid = uidOf(e, item.id);
  if (!fitsCalendarBytes(uid, CALENDAR_UID_MAX_BYTES)) return "uid_too_long";
  const recurrenceId = occurrenceKey(e.recurrenceId, ctx.zones);
  if (!fitsCalendarBytes(recurrenceId, CALENDAR_OCCURRENCE_KEY_MAX_BYTES)) return "occurrence_too_long";
  const start = storedTimeOf(e.start);
  // An end beats a length: a row keeps one of the two.
  const end = e.end === null ? null : storedTimeOf(e.end);
  const duration = end === null && e.duration !== null ? formatDuration(e.duration) : null;
  const rules = e.rules.map((r) => r.text.trim()).filter((t) => t !== "");
  const added = e.added.map((a) => storedTimeOf(a.start));
  const range = derivedRange({ start, end, duration, rules, added, recurrenceId }, ctx.zones);
  if (range === null) return "no_range";
  const invitees = inviteesOf(e.attendees);
  const attendees = e.attendees.filter((a) => a.email !== null &&
    (a.role === null || a.role === "REQ-PARTICIPANT" || a.role === "OPT-PARTICIPANT"));
  const verified = connectedAttendee(attendees.flatMap((a) => a.email === null ? [] : [a.email]),
    ctx.principal, ctx.ownAddresses);
  const mine = verified === null || (item.selfAttendee !== undefined && item.selfAttendee !== verified)
    ? undefined : attendees.find((a) => a.email?.toLowerCase() === verified);
  const row: MappedRow = {
    values: {
      providerId: item.id,
      // Handed back to the provider letter for letter: a version the store cannot hold as it is, is none.
      versionTag: item.version === "" || !storableKey(item.version) ? null : item.version,
      uid,
      recurrenceId,
      sequence: e.sequence ?? 0,
      status: STATUS[e.status ?? "CONFIRMED"] ?? "confirmed",
      title: e.summary ?? "",
      notes: e.description,
      place: e.location,
      callLink: callLinkOf(e.url),
      startKind: start.kind,
      startLocal: start.value,
      startZone: start.zone ?? null,
      endKind: end?.kind ?? null,
      endLocal: end?.value ?? null,
      endZone: end?.zone ?? null,
      duration,
      thisAndFuture: e.thisAndFuture,
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      occurrenceAt: range.occurrenceAt,
      repeatRule: rules.length > 0 ? rules.join("\n") : null,
      excludedDates: e.excluded.map(storedTimeOf),
      addedDates: added.length > 0 ? added : null,
      busy: e.transparency !== "TRANSPARENT",
      private: e.classification === "PRIVATE" || e.classification === "CONFIDENTIAL",
      organizer: e.organizer?.email ?? null,
      organizerName: e.organizer?.email == null ? null : e.organizer.name,
      myAnswer: mine === undefined ? null : ANSWER[mine.partstat ?? "NEEDS-ACTION"] ?? "none",
      partial: item.audienceIncomplete === true ||
        e.attendees.some((a) => a.email === null || !fitsCalendarBytes(a.email, CALENDAR_ADDRESS_MAX_BYTES)),
      original,
      portableCopy: item.portableCopy === true || (original !== null && portableCalendarText(original)),
      googleDefaultEvent: item.googleDefaultEvent === true,
    },
    invitees,
    alarms: alarmsOf(e),
  };
  return storable(row) ? row : "unstorable";
}

/**
 * The rows of ONE stored object: every upsert of a page that carries its id. Where the object is
 * one text (CalDAV, a subscription) the text rides on one row, the series' own where there is one.
 * Two events for one occurrence inside one object's text is no object any store can hold: left
 * out whole. A record with no text of its own that a page hands twice at one version (Microsoft's
 * series, on the page itself and asked for again for its first day) is one record: the last stands.
 */
export function rowsOfObject(upserts: readonly Upsert[], ctx: MapContext): Mapped {
  const first = upserts[0];
  if (first === undefined) return { ok: true, rows: [] };
  if (!fitsCalendarBytes(first.id, CALENDAR_PROVIDER_ID_MAX_BYTES)) return { ok: false, reason: "id_too_long" };
  const textOn = upserts.findIndex((u) => u.event.recurrenceId === null);
  const rows = new Map<string, { readonly row: MappedRow; readonly from: Upsert }>();
  for (const [i, u] of upserts.entries()) {
    const row = rowOf(u, ctx, i === (textOn < 0 ? 0 : textOn) ? u.text : null);
    if (typeof row === "string") return { ok: false, reason: row };
    const before = rows.get(row.values.recurrenceId)?.from;
    const sameRecord = before !== undefined && before.text === null && u.text === null && u.version !== "" && before.version === u.version;
    if (before !== undefined && !sameRecord) return { ok: false, reason: "twice" };
    rows.set(row.values.recurrenceId, { row, from: u });
  }
  return { ok: true, rows: [...rows.values()].map((r) => r.row) };
}
