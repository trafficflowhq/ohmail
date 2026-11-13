/**
 * One record of Google's event list as the calendar's own event.
 *
 * Google's fields are no calendar text and never passed the calendar reader, so nothing here reads
 * past it: the fields go through the core's own writer of a new event (`newEventComponent`),
 * Google's recurrence lines through the core's scan of one content line, and the result is the
 * core's view of that component. Every string that keys or names something is held to the reader's
 * ceiling at this door; a record that breaks one is left out by the reader's word.
 */
import {
  eventOf,
  instant,
  isValidDate,
  MAX_LINE_CHARS,
  MAX_PARAMS_PER_LINE,
  MAX_PARAM_VALUE_CHARS,
  MAX_UID_CHARS,
  MAX_ZONE_NAME_CHARS,
  newEventComponent,
  plainDate,
  resolveWall,
  sameName,
  scanContentLine,
  timeProperty,
  wallIn,
  zoned,
  type CalEvent,
  type EventTime,
  type NewEvent,
  type NewPerson,
  type PartStat,
  type Property,
  type ZoneSource,
} from "@ohmail/cal-core";
import { addressOf, callLinkOf, filled as text, instantOfRfc3339, isRecord, leftOut, MAX_PROVIDER_ID_CHARS, pathSegment, type Json, type Left } from "../json-answers.js";
import type { ChangeItem, LeftReason } from "../port.js";

/** What one record is. A cancelled day of a series names its series by Google's id; the series' UID stands on it only sometimes. */
export type Converted =
  | { readonly kind: "item"; readonly item: ChangeItem }
  | { readonly kind: "cancelled_day"; readonly masterId: string; readonly masterSegment: string; readonly uid: string | null; readonly originalStart: EventTime }
  | { readonly kind: "left"; readonly left: Left };

/* ── times ──────────────────────────────────────────────────────────────────────────────────────── */

function dayOf(value: string): EventTime | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.length === 10 ? value : "");
  if (m === null) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return isValidDate(year, month, day) ? plainDate(year, month, day) : null;
}

/**
 * Google's `{ date }` or `{ dateTime, timeZone }` in the calendar's kinds of time. Google writes the
 * moment with whatever offset the calendar is shown in, and names the event's own zone beside it:
 * the clock time in that zone is worked out from the moment, never cut out of the text. A zone the
 * platform does not know, and a clock time its zone shows twice, stay the moment they are.
 */
function timeOf(v: unknown, zones: ZoneSource): EventTime | null | "zone_name_too_long" {
  if (!isRecord(v)) return null;
  if (typeof v.date === "string") return dayOf(v.date);
  const at = typeof v.dateTime === "string" ? instantOfRfc3339(v.dateTime) : null;
  if (at === null) return null;
  const zone = text(v.timeZone);
  if (zone === undefined) return instant(at);
  if (zone.length > MAX_ZONE_NAME_CHARS) return "zone_name_too_long";
  const wall = wallIn(at, zone, zones);
  return wall !== null && resolveWall(wall, zone, zones) === at ? zoned(wall, zone) : instant(at);
}

/* ── people ─────────────────────────────────────────────────────────────────────────────────────── */

function personOf(v: unknown): NewPerson | null {
  if (!isRecord(v)) return null;
  const email = addressOf(v.email);
  if (email === undefined) return null;
  const name = text(v.displayName);
  return name === undefined || name.length > MAX_PARAM_VALUE_CHARS ? { email } : { email, name };
}

const ANSWERS: Readonly<Record<string, PartStat>> = { needsAction: "NEEDS-ACTION", accepted: "ACCEPTED", declined: "DECLINED", tentative: "TENTATIVE" };

function inviteesOf(v: unknown): NonNullable<NewEvent["attendees"]> {
  if (!Array.isArray(v)) return [];
  const out: NonNullable<NewEvent["attendees"]>[number][] = [];
  for (const one of v) {
    const person = personOf(one);
    if (person === null) continue;
    const answer = typeof one.responseStatus === "string" && Object.hasOwn(ANSWERS, one.responseStatus) ? ANSWERS[one.responseStatus] : undefined;
    out.push({ ...person, role: one.optional === true ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT", ...(answer === undefined ? {} : { partstat: answer }) });
  }
  return out;
}

/* ── the repeat ─────────────────────────────────────────────────────────────────────────────────── */

/** The lines Google keeps a repeat in ("RRULE, EXRULE, RDATE and EXDATE lines"). A line of another name is no part of it and is not taken. */
const RECURRENCE_NAMES: readonly string[] = ["RRULE", "EXRULE", "RDATE", "EXDATE"];

/**
 * Google's recurrence lines as properties, each taken apart by the core's own scan of a content
 * line. A line that is none, or that breaks a ceiling the reader holds, spoils the event: a repeat
 * drawn wrong is worse than an event left out and said.
 */
function recurrenceOf(v: unknown): readonly Property[] | LeftReason {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return "unreadable";
  const out: Property[] = [];
  for (const line of v) {
    if (typeof line !== "string" || /[\r\n]/.test(line)) return "unreadable";
    if (line.length > MAX_LINE_CHARS) return "line_too_long";
    const scanned = scanContentLine(line, MAX_PARAMS_PER_LINE);
    if (scanned === "too_many_parameters") return scanned;
    if (scanned === null) return "unreadable";
    if (!RECURRENCE_NAMES.some((name) => sameName(scanned.name, name))) continue;
    for (const param of scanned.params) {
      const tooLong = !param.bare && (param.values.length === 0 || param.values.some((value) => value.length > MAX_ZONE_NAME_CHARS));
      if (tooLong && sameName(param.name.trim(), "TZID")) return "zone_name_too_long";
    }
    out.push(scanned);
  }
  return out;
}

/* ── one record ─────────────────────────────────────────────────────────────────────────────────── */

const STATUS: Readonly<Record<string, NonNullable<NewEvent["status"]>>> = { confirmed: "CONFIRMED", tentative: "TENTATIVE" };
const SHOWN_AS: Readonly<Record<string, NonNullable<NewEvent["transparency"]>>> = { opaque: "OPAQUE", transparent: "TRANSPARENT" };
const CLASS: Readonly<Record<string, string>> = { public: "PUBLIC", private: "PRIVATE", confidential: "CONFIDENTIAL" };
const SEQUENCE_MAX = 2 ** 31 - 1;

/** A call's link: Google's own for its meetings, as it stands on the record. */
function linkOf(e: Json): string | undefined {
  const own = callLinkOf(e.hangoutLink);
  if (own !== undefined) return own;
  const entries = isRecord(e.conferenceData) && Array.isArray(e.conferenceData.entryPoints) ? e.conferenceData.entryPoints : [];
  for (const entry of entries) if (isRecord(entry) && entry.entryPointType === "video") return callLinkOf(entry.uri);
  return undefined;
}

/**
 * One record of an event list. `nowMs` stands in for a stamp the record does not carry.
 *
 * A record that is cancelled is a removal: of the stored object itself, or, where it names a series
 * and the day it stood on, of that one day. Everything else is the object as it now stands.
 */
export function convertEvent(raw: unknown, zones: ZoneSource, nowMs: number): Converted {
  const left = (id: string, reason: LeftReason): Converted => ({ kind: "left", left: leftOut(id, reason) });
  if (!isRecord(raw)) return left("", "unreadable");
  const id = text(raw.id);
  if (id === undefined) return left("", "unreadable");
  if (id.length > MAX_PROVIDER_ID_CHARS) return left(id, "uid_too_long");
  const master = text(raw.recurringEventId);
  if (master !== undefined && master.length > MAX_PROVIDER_ID_CHARS) return left(id, "uid_too_long");
  // An id is asked for and written by its place in an address. One that can stand in none is no id.
  const masterSegment = master === undefined ? "" : pathSegment(master);
  if (pathSegment(id) === null || masterSegment === null) return left("", "unreadable");
  const written = text(raw.iCalUID);
  if (written !== undefined && written.length > MAX_UID_CHARS) return left(id, "uid_too_long");

  const original = master === undefined ? null : timeOf(raw.originalStartTime, zones);
  if (original === "zone_name_too_long") return left(id, original);
  if (raw.status === "cancelled") {
    if (master === undefined) return { kind: "item", item: { kind: "gone", id } };
    return original === null ? left(id, "unreadable") : { kind: "cancelled_day", masterId: master, masterSegment, uid: written ?? null, originalStart: original };
  }
  // A changed day that does not say which day it changes cannot be put with its series.
  if (master !== undefined && original === null) return left(id, "unreadable");

  const start = timeOf(raw.start, zones);
  const end = timeOf(raw.end, zones);
  if (start === "zone_name_too_long" || end === "zone_name_too_long") return left(id, "zone_name_too_long");
  if (start === null) return left(id, "unreadable");
  const [summary, description, location] = [text(raw.summary), text(raw.description), text(raw.location)];
  for (const value of [summary, description, location]) if (value !== undefined && value.length > MAX_LINE_CHARS) return left(id, "line_too_long");
  const repeat = master === undefined ? recurrenceOf(raw.recurrence) : [];
  if (typeof repeat === "string") return left(id, repeat);

  const updated = typeof raw.updated === "string" ? instantOfRfc3339(raw.updated) : null;
  const created = typeof raw.created === "string" ? instantOfRfc3339(raw.created) : null;
  const sequence = typeof raw.sequence === "number" && Number.isInteger(raw.sequence) && raw.sequence >= 0 && raw.sequence <= SEQUENCE_MAX ? raw.sequence : undefined;
  const status = typeof raw.status === "string" && Object.hasOwn(STATUS, raw.status) ? STATUS[raw.status] : undefined;
  const shownAs = typeof raw.transparency === "string" && Object.hasOwn(SHOWN_AS, raw.transparency) ? SHOWN_AS[raw.transparency] : undefined;
  const organizer = personOf(raw.organizer);
  const link = linkOf(raw);
  const made = newEventComponent({
    // A changed day carries its series' UID; where Google wrote none, the series' own id keeps the two together.
    uid: written ?? master ?? id,
    dtstamp: instant(updated ?? created ?? nowMs),
    start,
    ...(end === null ? {} : { end }),
    ...(original === null ? {} : { recurrenceId: original }),
    ...(summary === undefined ? {} : { summary }),
    ...(description === undefined ? {} : { description }),
    ...(location === undefined ? {} : { location }),
    ...(sequence === undefined ? {} : { sequence }),
    ...(status === undefined ? {} : { status }),
    ...(shownAs === undefined ? {} : { transparency: shownAs }),
    ...(link === undefined ? {} : { url: link }),
    ...(organizer === null ? {} : { organizer }),
    attendees: inviteesOf(raw.attendees),
  });
  const more: Property[] = [...repeat];
  if (created !== null) more.push(timeProperty("CREATED", instant(created)));
  if (updated !== null) more.push(timeProperty("LAST-MODIFIED", instant(updated)));
  if (typeof raw.visibility === "string" && Object.hasOwn(CLASS, raw.visibility)) more.push({ name: "CLASS", params: [], value: CLASS[raw.visibility]! });
  const event: CalEvent = eventOf({ ...made, properties: [...made.properties, ...more] });
  // The entity tag is what a change is made against. A record without one (a recorded exchange keeps none) is told apart by its last change.
  const version = text(raw.etag) ?? text(raw.updated) ?? "";
  return { kind: "item", item: { kind: "upsert", id, version: version.length > MAX_PROVIDER_ID_CHARS ? "" : version, event, text: null } };
}
