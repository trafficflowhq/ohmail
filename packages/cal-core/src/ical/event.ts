/**
 * One VEVENT as typed values. The event is a view over its component in the tree: reading it
 * interprets nothing away, and an edit makes a new component that differs in the one property
 * named, so what a server or another program wrote beside it survives the round trip.
 */
import { parseRRule, formatRRule, type RRule } from "../recur/rrule.js";
import { MS_PER_SECOND, wallSeconds } from "../time/arith.js";
import type { Duration } from "../time/duration.js";
import type { EventTime, Instant, Wall } from "../time/types.js";
import { componentsOf, propertyOf, withProperty, withPropertyAt, type Component, type Param, type Property } from "./component.js";
import { makeParam, paramOf, sameName } from "./lines.js";
import { escapeText, formatDuration, formatInstant, mailAddressOf, parseDateTime, parseDuration, parsePeriod, splitTextList, timeOf, timeProperty, timesOf, unescapeText } from "./values.js";

export type EventStatus = "TENTATIVE" | "CONFIRMED" | "CANCELLED";
export type Transparency = "OPAQUE" | "TRANSPARENT";
/** The answers an invitee can stand at (RFC 5545 section 3.2.12, for an event). */
export type PartStat = "NEEDS-ACTION" | "ACCEPTED" | "DECLINED" | "TENTATIVE" | "DELEGATED";

export interface Person {
  /** The CN parameter. Sender text: whoever draws it escapes it. */
  readonly name: string | null;
  /** The `mailto:` address in lower case, or `null` for any other kind of address. */
  readonly email: string | null;
  /** The calendar address as written. */
  readonly uri: string;
  /** SENT-BY: who acts for this person, as a mail address. */
  readonly sentBy: string | null;
  /** The line itself, for an edit of it. */
  readonly property: Property;
}

/**
 * Where the last answer taken in from an invitee is noted, on the invitee's own line of the event
 * held: the version it answered and when it was written. RFC 5546 section 2.1.5 orders answers by
 * these two and nothing else in an event holds them, so an answer that was written earlier and
 * arrives later could not be told from a new one. On the line they travel with the event to every
 * device that reads it. A calendar that drops parameters it does not know loses the note and no more.
 */
export const ANSWER_SEQUENCE_PARAM = "X-OHMAIL-REPLY-SEQUENCE";
export const ANSWER_DTSTAMP_PARAM = "X-OHMAIL-REPLY-DTSTAMP";
export const ANSWER_PARAMS: readonly string[] = [ANSWER_SEQUENCE_PARAM, ANSWER_DTSTAMP_PARAM];

/** The last answer taken in from an invitee: the SEQUENCE it answered and its own DTSTAMP (`null` for an answer that carried none). */
export interface AnswerNote {
  readonly sequence: number;
  readonly dtstamp: Instant | null;
}

export interface Attendee extends Person {
  /** ROLE as written, upper case; `null` when not stated (the standard then means a required participant). */
  readonly role: string | null;
  /** PARTSTAT as written, upper case; `null` when not stated (the standard then means "needs action"). */
  readonly partstat: string | null;
  /** RSVP=TRUE: an answer is asked for. */
  readonly rsvp: boolean;
  /** CUTYPE as written, upper case (INDIVIDUAL, GROUP, RESOURCE, ROOM), or `null`. */
  readonly kind: string | null;
  readonly delegatedTo: readonly string[];
  readonly delegatedFrom: readonly string[];
  /** What was noted of the last answer taken in from this invitee, or `null` when nothing was. */
  readonly answered: AnswerNote | null;
}

export interface Alarm {
  readonly action: string | null;
  /** Before or after the start or the end, or at a moment; `null` when the trigger is not readable. */
  readonly trigger: { readonly kind: "relative"; readonly duration: Duration; readonly to: "START" | "END" } | { readonly kind: "absolute"; readonly at: Instant } | null;
  readonly component: Component;
}

/** One added date (RDATE): a start, and for a period its own end or length. */
export interface AddedDate {
  readonly start: EventTime;
  readonly end: EventTime | null;
  readonly duration: Duration | null;
}

export interface CalEvent {
  readonly component: Component;
  readonly uid: string | null;
  /** RECURRENCE-ID: the occurrence this component stands for, when it is not the series itself. */
  readonly recurrenceId: EventTime | null;
  /** RANGE=THISANDFUTURE on the recurrence id. */
  readonly thisAndFuture: boolean;
  /** 0 to 2^31-1; `null` when absent or unreadable. */
  readonly sequence: number | null;
  readonly dtstamp: Instant | null;
  readonly created: Instant | null;
  readonly lastModified: Instant | null;
  readonly start: EventTime | null;
  /** DTEND as written (exclusive for whole days); beside it or instead of it, DURATION. */
  readonly end: EventTime | null;
  readonly duration: Duration | null;
  readonly summary: string | null;
  readonly description: string | null;
  readonly location: string | null;
  readonly status: EventStatus | null;
  readonly transparency: Transparency | null;
  /** CLASS as written, upper case (PUBLIC, PRIVATE, CONFIDENTIAL). */
  readonly classification: string | null;
  readonly organizer: Person | null;
  readonly attendees: readonly Attendee[];
  /** Every RRULE with its text; `rule` is `null` for one this package cannot follow. */
  readonly rules: readonly { readonly text: string; readonly rule: RRule | null }[];
  readonly added: readonly AddedDate[];
  readonly excluded: readonly EventTime[];
  readonly alarms: readonly Alarm[];
  readonly url: string | null;
  readonly categories: readonly string[];
}

const SEQUENCE_MAX = 2 ** 31 - 1;

const text = (p: Property | null): string | null => (p === null ? null : unescapeText(p.value));
const word = (p: Property | null): string | null => (p === null ? null : p.value.trim().toUpperCase());
const moment = (p: Property | null): Instant | null => {
  const t = p === null ? null : timeOf(p);
  return t !== null && t.kind === "instant" ? t : null;
};
const upper = (p: Property, name: string): string | null => {
  const v = paramOf(p, name);
  return v === null ? null : v.toUpperCase();
};
/** Nobody: the list of an invitee who delegates to no one and for no one, one for every invitee and never changed. */
const NOBODY: readonly string[] = Object.freeze([]);
const addresses = (p: Property, name: string): readonly string[] => {
  const param = p.params.find((x) => sameName(x.name, name));
  return param === undefined ? NOBODY : param.values.flatMap((v) => mailAddressOf(v) ?? []);
};

function personOf(p: Property): Person {
  const sentBy = paramOf(p, "SENT-BY");
  return { name: paramOf(p, "CN"), email: mailAddressOf(p.value), uri: p.value.trim(), sentBy: sentBy === null ? null : mailAddressOf(sentBy), property: p };
}

function answerNoteOf(p: Property): AnswerNote | null {
  const sequence = paramOf(p, ANSWER_SEQUENCE_PARAM)?.trim() ?? "";
  if (!/^\d{1,10}$/.test(sequence) || Number(sequence) > SEQUENCE_MAX) return null;
  const stamp = parseDateTime(paramOf(p, ANSWER_DTSTAMP_PARAM)?.trim() ?? "");
  return { sequence: Number(sequence), dtstamp: stamp !== null && stamp.utc ? { kind: "instant", epochMs: wallSeconds(stamp.wall) * MS_PER_SECOND } : null };
}

function attendeeOf(p: Property): Attendee {
  return {
    ...personOf(p),
    role: upper(p, "ROLE"),
    partstat: upper(p, "PARTSTAT"),
    rsvp: upper(p, "RSVP") === "TRUE",
    kind: upper(p, "CUTYPE"),
    delegatedTo: addresses(p, "DELEGATED-TO"),
    delegatedFrom: addresses(p, "DELEGATED-FROM"),
    answered: answerNoteOf(p),
  };
}

function alarmOf(c: Component): Alarm {
  const p = propertyOf(c, "TRIGGER");
  let trigger: Alarm["trigger"] = null;
  if (p !== null) {
    const at = timeOf(p);
    const duration = parseDuration(p.value);
    if (duration !== null) trigger = { kind: "relative", duration, to: upper(p, "RELATED") === "END" ? "END" : "START" };
    else if (at !== null && at.kind === "instant") trigger = { kind: "absolute", at };
  }
  return { action: word(propertyOf(c, "ACTION")), trigger, component: c };
}

function addedOf(p: Property): AddedDate[] {
  if ((paramOf(p, "VALUE") ?? "").toUpperCase() !== "PERIOD") return timesOf(p).map((start) => ({ start, end: null, duration: null }));
  const tzid = paramOf(p, "TZID");
  const at = (x: { wall: Wall; utc: boolean }): EventTime =>
    x.utc ? { kind: "instant", epochMs: wallSeconds(x.wall) * MS_PER_SECOND } : tzid ? { kind: "zoned", wall: x.wall, tzid } : { kind: "floating", wall: x.wall };
  return p.value.split(",").flatMap((v) => {
    const period = parsePeriod(v.trim());
    return period === null ? [] : [{ start: at(period.start), end: period.end === null ? null : at(period.end), duration: period.duration }];
  });
}

/** The names an event's view has a word for. */
const WORDS: ReadonlySet<string> = new Set([
  "UID", "RECURRENCE-ID", "SEQUENCE", "DTSTAMP", "CREATED", "LAST-MODIFIED", "DTSTART", "DTEND", "DURATION", "SUMMARY", "DESCRIPTION", "LOCATION", "STATUS", "TRANSP", "CLASS",
  "ORGANIZER", "ATTENDEE", "RRULE", "RDATE", "EXDATE", "URL", "CATEGORIES",
]);
const NO_LINES: readonly Property[] = Object.freeze([]);

/**
 * An event's own lines under the names its view has words for, each name's in the order written.
 * Every line is looked at once for all of them; asked of the component name by name, an event of
 * half a million lines was gone through once for each of the names. A name is compared without
 * regard to case, as `sameName` compares it.
 */
function linesOf(component: Component): ReadonlyMap<string, readonly Property[]> {
  const lines = new Map<string, Property[]>();
  for (const p of component.properties) {
    const name = p.name.toUpperCase();
    if (!WORDS.has(name)) continue;
    const held = lines.get(name);
    if (held === undefined) lines.set(name, [p]);
    else held.push(p);
  }
  return lines;
}

/** The typed view of a VEVENT component. Never refuses: what is missing or unreadable is `null`. */
export function eventOf(component: Component): CalEvent {
  const lines = linesOf(component);
  const all = (name: string): readonly Property[] => lines.get(name) ?? NO_LINES;
  const prop = (name: string): Property | null => lines.get(name)?.[0] ?? null;
  const time = (name: string): EventTime | null => {
    const p = prop(name);
    return p === null ? null : timeOf(p);
  };
  const recurrence = prop("RECURRENCE-ID");
  const sequenceText = prop("SEQUENCE")?.value.trim() ?? "";
  const sequenceNumber = /^\d{1,10}$/.test(sequenceText) ? Number(sequenceText) : NaN;
  const organizer = prop("ORGANIZER");
  const status = word(prop("STATUS"));
  const transparency = word(prop("TRANSP"));
  const durationText = prop("DURATION");
  const uid = text(prop("UID"))?.trim() ?? "";
  return {
    component,
    uid: uid === "" ? null : uid,
    recurrenceId: recurrence === null ? null : timeOf(recurrence),
    thisAndFuture: recurrence !== null && upper(recurrence, "RANGE") === "THISANDFUTURE",
    sequence: Number.isInteger(sequenceNumber) && sequenceNumber <= SEQUENCE_MAX ? sequenceNumber : null,
    dtstamp: moment(prop("DTSTAMP")),
    created: moment(prop("CREATED")),
    lastModified: moment(prop("LAST-MODIFIED")),
    start: time("DTSTART"),
    end: time("DTEND"),
    duration: durationText === null ? null : parseDuration(durationText.value),
    summary: text(prop("SUMMARY")),
    description: text(prop("DESCRIPTION")),
    location: text(prop("LOCATION")),
    status: status === "TENTATIVE" || status === "CONFIRMED" || status === "CANCELLED" ? status : null,
    transparency: transparency === "OPAQUE" || transparency === "TRANSPARENT" ? transparency : null,
    classification: word(prop("CLASS")),
    organizer: organizer === null ? null : personOf(organizer),
    attendees: all("ATTENDEE").map(attendeeOf),
    rules: all("RRULE").map((p) => ({ text: p.value, rule: parseRRule(p.value) })),
    added: all("RDATE").flatMap(addedOf),
    excluded: all("EXDATE").flatMap(timesOf),
    alarms: componentsOf(component, "VALARM").map(alarmOf),
    url: prop("URL")?.value.trim() ?? null,
    categories: all("CATEGORIES").flatMap((p) => splitTextList(p.value)),
  };
}

/* ── edits: each returns the event over a component that differs in the one place named ─────────── */

const keepParams = (c: Component, name: string): readonly Param[] => propertyOf(c, name)?.params ?? [];

/** SUMMARY, DESCRIPTION or LOCATION set to this text (its parameters stay), or taken out with `null`. */
export function withText(event: CalEvent, name: "SUMMARY" | "DESCRIPTION" | "LOCATION", value: string | null): CalEvent {
  const next = value === null ? null : { name, params: keepParams(event.component, name), value: escapeText(value) };
  return eventOf(withProperty(event.component, name, next));
}

/** The event at a new start and end. DURATION is taken out when an end is given; with no end, both are. */
export function withTimes(event: CalEvent, start: EventTime, end: EventTime | null): CalEvent {
  let c = withProperty(event.component, "DTSTART", timeProperty("DTSTART", start, keepParams(event.component, "DTSTART")));
  c = withProperty(c, "DTEND", end === null ? null : timeProperty("DTEND", end, keepParams(event.component, "DTEND")));
  return eventOf(withProperty(c, "DURATION", null));
}

export const withSequence = (event: CalEvent, sequence: number): CalEvent =>
  eventOf(withProperty(event.component, "SEQUENCE", { name: "SEQUENCE", params: [], value: String(sequence) }));

export const withStatus = (event: CalEvent, status: EventStatus | null): CalEvent =>
  eventOf(withProperty(event.component, "STATUS", status === null ? null : { name: "STATUS", params: [], value: status }));

/** A property line with one parameter set (replaced where it stands, else added at the end) or, with `null`, taken out. */
export function withParam(p: Property, name: string, values: readonly string[] | null): Property {
  const at = p.params.findIndex((x) => sameName(x.name, name));
  if (values === null) return at < 0 ? p : { ...p, params: p.params.filter((_, i) => i !== at) };
  const made = makeParam(at < 0 ? name : p.params[at]!.name, values);
  return { ...p, params: at < 0 ? [...p.params, made] : p.params.map((x, i) => (i === at ? made : x)) };
}

/** The event with one invitee's answer set, found by mail address. `null` when nobody on the event has that address. */
export function withPartstat(event: CalEvent, email: string, partstat: PartStat): CalEvent | null {
  const wanted = email.trim().toLowerCase();
  const invitee = event.attendees.find((a) => a.email === wanted);
  if (invitee === undefined) return null;
  return eventOf(withPropertyAt(event.component, invitee.property, withParam(invitee.property, "PARTSTAT", [partstat])));
}

/**
 * The event with one invitee's answer taken in: the answer on the invitee's line, and beside it the
 * version it answered and its stamp, so that an earlier answer arriving later can be told. `null`
 * when nobody on the event has that address.
 */
export function withAnswer(event: CalEvent, email: string, partstat: PartStat, answer: AnswerNote): CalEvent | null {
  const wanted = email.trim().toLowerCase();
  const invitee = event.attendees.find((a) => a.email === wanted);
  if (invitee === undefined) return null;
  let line = withParam(invitee.property, "PARTSTAT", [partstat]);
  line = withParam(line, ANSWER_SEQUENCE_PARAM, [String(answer.sequence)]);
  line = withParam(line, ANSWER_DTSTAMP_PARAM, answer.dtstamp === null ? null : [formatInstant(answer.dtstamp.epochMs)]);
  return eventOf(withPropertyAt(event.component, invitee.property, line));
}

/* ── a new event ────────────────────────────────────────────────────────────────────────────────── */

export interface NewPerson {
  readonly email: string;
  readonly name?: string;
}

export interface NewEvent {
  readonly uid: string;
  /** Handed in: this package reads no clock. */
  readonly dtstamp: Instant;
  readonly start: EventTime;
  readonly end?: EventTime;
  readonly duration?: Duration;
  readonly recurrenceId?: EventTime;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly rule?: RRule;
  readonly sequence?: number;
  readonly status?: EventStatus;
  readonly transparency?: Transparency;
  readonly url?: string;
  readonly organizer?: NewPerson;
  readonly attendees?: readonly (NewPerson & { readonly role?: string; readonly partstat?: PartStat; readonly rsvp?: boolean })[];
}

/** A VEVENT component written new, in the standard's forms. A zone it names needs its definition beside it (`vtimezoneFrom`). */
export function newEventComponent(e: NewEvent): Component {
  const plain = (name: string, value: string): Property => ({ name, params: [], value });
  const person = (name: string, p: NewPerson, more: readonly Param[] = []): Property => ({
    name,
    params: [...(p.name === undefined ? [] : [makeParam("CN", [p.name])]), ...more],
    value: `mailto:${p.email}`,
  });
  const properties: Property[] = [plain("UID", escapeText(e.uid)), timeProperty("DTSTAMP", e.dtstamp)];
  if (e.recurrenceId !== undefined) properties.push(timeProperty("RECURRENCE-ID", e.recurrenceId));
  properties.push(timeProperty("DTSTART", e.start));
  if (e.end !== undefined) properties.push(timeProperty("DTEND", e.end));
  else if (e.duration !== undefined) properties.push(plain("DURATION", formatDuration(e.duration)));
  if (e.rule !== undefined) properties.push(plain("RRULE", formatRRule(e.rule)));
  if (e.summary !== undefined) properties.push(plain("SUMMARY", escapeText(e.summary)));
  if (e.description !== undefined) properties.push(plain("DESCRIPTION", escapeText(e.description)));
  if (e.location !== undefined) properties.push(plain("LOCATION", escapeText(e.location)));
  if (e.url !== undefined) properties.push(plain("URL", e.url));
  if (e.organizer !== undefined) properties.push(person("ORGANIZER", e.organizer));
  for (const a of e.attendees ?? []) {
    properties.push(
      person("ATTENDEE", a, [
        ...(a.role === undefined ? [] : [makeParam("ROLE", [a.role])]),
        makeParam("PARTSTAT", [a.partstat ?? "NEEDS-ACTION"]),
        ...(a.rsvp ? [makeParam("RSVP", ["TRUE"])] : []),
      ]),
    );
  }
  properties.push(plain("SEQUENCE", String(e.sequence ?? 0)));
  if (e.status !== undefined) properties.push(plain("STATUS", e.status));
  if (e.transparency !== undefined) properties.push(plain("TRANSP", e.transparency));
  return { name: "VEVENT", properties, components: [] };
}
