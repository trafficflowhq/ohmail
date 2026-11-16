/**
 * A CALDAV OBJECT, WRITTEN: a new one from a person's draft, a stored one changed in the places a
 * change names and nowhere else, and an invitee's own answer on its line. Each edit changes one
 * place of the tree the calendar core read, and the core's own writer writes the text: nothing of a
 * person's is spliced into the text by hand. A stored object the core read with something left out
 * is never written back.
 */
import {
  DEFAULT_LIMITS,
  calendarOf,
  eventOf,
  formatInstant,
  formatRRule,
  makeParam,
  momentOrUtc,
  newCalendar,
  newEventComponent,
  readCalendar,
  sameName,
  withEvent,
  withPartstat,
  withProperty,
  withSequence,
  withText,
  withTimes,
  writeCalendar,
  vtimezoneFrom,
  instant,
  type CalEvent,
  type CalObject,
  type Component,
  type EventTime,
  type PartStat,
  type Property,
  type ZoneSource,
} from "@ohmail/cal-core";
import { VTIMEZONE_SPAN_MAX_DAYS } from "@ohmail/cal-core/limits";
import type { EventChange, EventDraft, EventInvitee } from "../port.js";

const PRODID = "-//ohmail//calendar//EN";
const DAY_MS = 86_400_000;

export type Edited =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "left_out" | "field_unwritable" | "not_found" };

const plain = (name: string, value: string): Property => ({ name, params: [], value });

/** Every line of `name` out of a component, then `lines` after its others. */
function withLines(c: Component, name: string, lines: readonly Property[]): Component {
  return { ...c, properties: [...c.properties.filter((p) => !sameName(p.name, name)), ...lines] };
}

function attendeeLine(p: EventInvitee): Property {
  return {
    name: "ATTENDEE",
    params: [
      ...(p.name === null ? [] : [makeParam("CN", [p.name])]),
      makeParam("ROLE", [p.optional ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT"]),
      makeParam("PARTSTAT", ["NEEDS-ACTION"]),
      makeParam("RSVP", ["TRUE"]),
    ],
    value: `mailto:${p.email}`,
  };
}

/** A reminder that shows `minutes` before the start. */
function alarmOf(minutes: number): Component {
  return {
    name: "VALARM",
    properties: [
      plain("ACTION", "DISPLAY"),
      plain("DESCRIPTION", "Reminder"),
      plain("TRIGGER", minutes === 0 ? "PT0S" : `-PT${minutes}M`),
    ],
    components: [],
  };
}

/** The fields of a draft or a change, each in its one place of the event's component. */
function applied(c: Component, f: EventChange): Component | "field_unwritable" {
  let event: CalEvent = eventOf(c);
  if (f.summary !== undefined) event = withText(event, "SUMMARY", f.summary === "" ? null : f.summary);
  if (f.description !== undefined) event = withText(event, "DESCRIPTION", f.description);
  if (f.location !== undefined) event = withText(event, "LOCATION", f.location);
  if (f.start !== undefined || f.end !== undefined) {
    if (f.start === undefined || f.end === undefined) return "field_unwritable";
    event = withTimes(event, f.start, f.end);
  }
  let next = event.component;
  if (f.url !== undefined) next = withProperty(next, "URL", f.url === null ? null : plain("URL", f.url));
  if (f.busy !== undefined)
    next = withProperty(next, "TRANSP", plain("TRANSP", f.busy ? "OPAQUE" : "TRANSPARENT"));
  if (f.private !== undefined)
    next = withProperty(next, "CLASS", plain("CLASS", f.private ? "PRIVATE" : "PUBLIC"));
  if (f.rule !== undefined)
    next = withLines(next, "RRULE", f.rule === null ? [] : [plain("RRULE", formatRRule(f.rule))]);
  if (f.attendees !== undefined) {
    next = withLines(next, "ATTENDEE", f.attendees.map(attendeeLine));
    if (f.organizer !== undefined)
      next = withProperty(
        next,
        "ORGANIZER",
        f.organizer === null ? null : plain("ORGANIZER", `mailto:${f.organizer}`),
      );
  }
  if (f.alarms !== undefined) {
    next = {
      ...next,
      components: [...next.components.filter((k) => !sameName(k.name, "VALARM")), ...f.alarms.map(alarmOf)],
    };
  }
  return next;
}

/** The zones the times name that the calendar defines nowhere, each defined over the span it is used in. */
function zonesFor(
  cal: CalObject,
  times: readonly EventTime[],
  series: boolean,
  zones: ZoneSource,
): Component[] | "field_unwritable" {
  const defined = new Set(cal.timezones.map((z) => z.tzid));
  const out: Component[] = [];
  for (const t of times) {
    if (t.kind !== "zoned" || defined.has(t.tzid)) continue;
    const startMs = momentOrUtc(t, zones);
    const span = { startMs, endMs: series ? startMs + VTIMEZONE_SPAN_MAX_DAYS * DAY_MS : startMs + DAY_MS };
    const zone = vtimezoneFrom(t.tzid, zones, span);
    if (zone === null) return "field_unwritable";
    defined.add(t.tzid);
    out.push(zone);
  }
  return out;
}

const written = (cal: CalObject): Edited => {
  const text = writeCalendar(cal);
  return text.ok ? { ok: true, text: text.text } : { ok: false, reason: "field_unwritable" };
};

/** A new object of one event, under `uid`, stamped `nowMs`. */
export function newObjectText(draft: EventDraft, uid: string, nowMs: number, zones: ZoneSource): Edited {
  const base = newEventComponent({
    uid,
    dtstamp: instant(Math.floor(nowMs / 1000) * 1000),
    start: draft.start,
    end: draft.end,
    ...(draft.rule === null ? {} : { rule: draft.rule }),
  });
  const event = applied(base, { ...draft, rule: undefined });
  if (event === "field_unwritable") return { ok: false, reason: event };
  const shell = newCalendar({ prodid: PRODID, events: [event] });
  const tz = zonesFor(shell, [draft.start, draft.end], draft.rule !== null, zones);
  if (tz === "field_unwritable") return { ok: false, reason: tz };
  return written(newCalendar({ prodid: PRODID, timezones: tz, events: [event] }));
}

/** The stored object read as the core reads it, or the word that keeps it from being written back. */
function storedOf(
  text: string,
):
  { readonly ok: true; readonly cal: CalObject; readonly master: CalEvent } | Extract<Edited, { ok: false }> {
  const read = readCalendar(text, DEFAULT_LIMITS);
  if (!read.ok) return { ok: false, reason: "left_out" };
  // Read with something left out: what was dropped would be lost in what is written back.
  if (read.dropped.length > 0) return { ok: false, reason: "left_out" };
  const master =
    read.calendar.events.find((e) => e.recurrenceId === null) ??
    (read.calendar.events.length === 1 ? read.calendar.events[0]! : null);
  return master === null ? { ok: false, reason: "not_found" } : { ok: true, cal: read.calendar, master };
}

/** The event as the stored object holds it, for a comparison: the series' own, or the one event. */
export function heldEvent(text: string): CalEvent | null {
  const stored = storedOf(text);
  return stored.ok ? stored.master : null;
}

const stamped = (c: Component, nowMs: number): Component => {
  const at = formatInstant(Math.floor(nowMs / 1000) * 1000);
  return withProperty(
    withProperty(c, "DTSTAMP", plain("DTSTAMP", at)),
    "LAST-MODIFIED",
    plain("LAST-MODIFIED", at),
  );
};

/** The stored object with the change written into its event, its sequence moved on and its stamps now. */
export function changedObjectText(
  text: string,
  change: EventChange,
  nowMs: number,
  zones: ZoneSource,
): Edited {
  const stored = storedOf(text);
  if (!stored.ok) return stored;
  const next = applied(stored.master.component, change);
  if (next === "field_unwritable") return { ok: false, reason: next };
  const sequenced = withSequence(eventOf(stamped(next, nowMs)), (stored.master.sequence ?? 0) + 1);
  let cal = withEvent(stored.cal, stored.master, sequenced);
  const times = [change.start, change.end].filter((t): t is EventTime => t !== undefined);
  const series = (change.rule ?? null) !== null || stored.master.rules.length > 0;
  const tz = zonesFor(cal, times, series, zones);
  if (tz === "field_unwritable") return { ok: false, reason: tz };
  if (tz.length > 0) cal = calendarOf({ ...cal.tree, components: [...tz, ...cal.tree.components] });
  return written(cal);
}

/** The stored object with one invitee's answer on its own line, nothing else moved. */
export function answeredObjectText(text: string, as: string, reply: PartStat, nowMs: number): Edited {
  const stored = storedOf(text);
  if (!stored.ok) return stored;
  const answered = withPartstat(stored.master, as, reply);
  if (answered === null) return { ok: false, reason: "not_found" };
  return written(
    withEvent(
      stored.cal,
      stored.master,
      eventOf(
        withProperty(
          answered.component,
          "DTSTAMP",
          plain("DTSTAMP", formatInstant(Math.floor(nowMs / 1000) * 1000)),
        ),
      ),
    ),
  );
}

/** The UID of a stored object's events, where they all have one. */
export function uidOfText(text: string): string | null {
  const read = readCalendar(text, DEFAULT_LIMITS);
  if (!read.ok) return null;
  const uids = new Set(read.calendar.events.map((e) => e.uid));
  return uids.size === 1 ? ([...uids][0] ?? null) : null;
}
