/**
 * A CALDAV OBJECT, WRITTEN: a new one from a person's draft, a stored one changed in the places a
 * change names and nowhere else, and an invitee's own answer on its line. Each edit changes one
 * place of the tree the calendar core read, and the core's own writer writes the text: nothing of a
 * person's is spliced into the text by hand. A stored object the core read with something left out
 * is never written back.
 */
import {
  ANSWER_PARAMS,
  DEFAULT_LIMITS,
  calendarOf,
  changedOccurrence,
  eventOf,
  formatInstant,
  formatRRule,
  makeParam,
  momentOrUtc,
  newCalendar,
  newEventComponent,
  occurrenceOf,
  readCalendar,
  sameName,
  seriesOf,
  timeProperty,
  withEvent,
  withNewEvent,
  withPartstat,
  withProperty,
  withSequence,
  withText,
  withTimes,
  writeCalendar,
  vtimezoneFrom,
  withParam,
  withPropertyAt,
  zonesOf,
  instant,
  type Attendee,
  type CalEvent,
  type CalObject,
  type Component,
  type EventTime,
  type Occurrence,
  type PartStat,
  type Person,
  type Property,
  type RRule,
  type ZoneSource,
} from "@ohmail/cal-core";
import { VTIMEZONE_SPAN_MAX_DAYS } from "@ohmail/cal-core/limits";
import type { EventChange, EventDraft, EventInvitee } from "../port.js";
import { cancelledDaysOf, carriedExclusions, clockOf, endBefore, endsBeforeDay } from "../series.js";
import { alreadyHolds } from "../write-compare.js";

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

/**
 * One day of the stored object's series, found as the calendar core finds it: the series, the day
 * (`null` where the series has none at `was`: not one of its days, excluded, or cancelled), and the
 * zones the object is read with.
 */
function dayOf(
  stored: { readonly cal: CalObject; readonly master: CalEvent },
  was: EventTime,
  platform: ZoneSource,
): { readonly zones: ZoneSource; readonly day: Occurrence | null } | null {
  if (stored.master.rules.length === 0 || stored.master.recurrenceId !== null) return null;
  const zones = zonesOf(stored.cal, platform);
  const series = seriesOf(stored.cal.events, zones).find((s) => s.master === stored.master);
  return series === undefined ? null : { zones, day: occurrenceOf(series, was, zones) };
}

/** The component that stands for one day: its own where it has one, else one made from the series' (`changedOccurrence`). */
const ownComponent = (
  day: Occurrence,
  zones: ZoneSource,
): { readonly event: CalEvent; readonly made: boolean } => {
  const event = changedOccurrence(day, zones);
  return { event, made: event !== day.event };
};

/**
 * The stored object with ONE day of its series changed, in that day's own component and nowhere
 * else: the component the day has already, or a new one made from the series' as the core makes it,
 * written after the object's last event. The series' own component and every other day stay as they
 * were, line for line. `not_found`: the series has no such day.
 */
export function dayChangedText(
  text: string,
  was: EventTime,
  change: EventChange,
  nowMs: number,
  platform: ZoneSource,
): Edited {
  const stored = storedOf(text);
  if (!stored.ok) return stored;
  const found = dayOf(stored, was, platform);
  if (found === null || found.day === null) return { ok: false, reason: "not_found" };
  const own = ownComponent(found.day, found.zones);
  const next = applied(own.event.component, change);
  if (next === "field_unwritable") return { ok: false, reason: next };
  const day = withSequence(eventOf(stamped(next, nowMs)), (own.event.sequence ?? 0) + 1);
  let cal = own.made ? withNewEvent(stored.cal, day) : withEvent(stored.cal, own.event, day);
  const tz = zonesFor(
    cal,
    [change.start, change.end].filter((t): t is EventTime => t !== undefined),
    false,
    platform,
  );
  if (tz === "field_unwritable") return { ok: false, reason: tz };
  if (tz.length > 0) cal = calendarOf({ ...cal.tree, components: [...tz, ...cal.tree.components] });
  return written(cal);
}

/** Is one day of the stored object's series as a change wants it? Asked after a refused precondition. */
export function dayHolds(text: string, was: EventTime, change: EventChange, platform: ZoneSource): boolean {
  const stored = storedOf(text);
  if (!stored.ok) return false;
  const found = dayOf(stored, was, platform);
  return (
    found !== null &&
    found.day !== null &&
    found.day.event.recurrenceId !== null &&
    alreadyHolds(change, found.day.event, found.zones)
  );
}

/**
 * The stored object with ONE day of its series cancelled: that day's time among the series' excluded
 * days (one EXDATE line more, written as the series writes its start), and the day's own component,
 * where it has one, taken out. Nothing else moves. `absent`: the series has no such day already.
 */
export function dayCancelledText(
  text: string,
  was: EventTime,
  platform: ZoneSource,
): Edited | { readonly ok: true; readonly absent: true } {
  const stored = storedOf(text);
  if (!stored.ok) return stored;
  const found = dayOf(stored, was, platform);
  if (found === null) return { ok: false, reason: "not_found" };
  if (found.day === null) return { ok: true, absent: true };
  const at = changedOccurrence({ ...found.day, event: stored.master }, found.zones).recurrenceId;
  if (at === null) return { ok: false, reason: "field_unwritable" };
  const master = stored.master.component;
  const excluded = eventOf({ ...master, properties: [...master.properties, timeProperty("EXDATE", at)] });
  let cal = withEvent(stored.cal, stored.master, excluded);
  if (
    found.day.event !== stored.master &&
    found.day.event.recurrenceId !== null &&
    !found.day.event.thisAndFuture
  ) {
    cal = withEvent(cal, found.day.event, null);
  }
  return written(cal);
}

/**
 * May `was`, a day the stored object's series does not have, stand in a series of its own made from another copy of the series:
 * does the series end before it (its end on a day, or its count of days, before it) without excluding that day itself? A day past
 * its end is no day cancelled (the fourth recheck's finding of a removal shown done while its days stand). But a day the series
 * excludes (an EXDATE line of its own, or a cancelled component of that very day) is cancelled past its end too: a series made of
 * this copy carries its excluded days, so the day stands nowhere, and a cancel whose own request wrote that line before the
 * series was ended is done, not refused.
 */
export function dayOfAnotherCopy(text: string, was: EventTime, platform: ZoneSource): boolean {
  const stored = storedOf(text);
  if (!stored.ok || stored.master.rules.length !== 1) return false;
  const rule = stored.master.rules[0]!.rule;
  if (rule === null) return false;
  const zones = zonesOf(stored.cal, platform);
  const at = momentOrUtc(was, zones);
  if (excludedDaysOf(stored.cal.events, stored.master, zones).some((day) => momentOrUtc(day, zones) === at))
    return false;
  return endsBeforeDay(rule, stored.master.start, stored.master.end, at, zones);
}

/**
 * Does the stored object's series go on from `was`: its one rule read, and its end (on a day, or its count of days) not before that
 * day? Asked before the days from that day on are made a series of their own: where the series has them, they stand there. An
 * object the core does not read so says nothing here (what is made of it says its own word).
 */
export function seriesGoesOnFrom(text: string, was: EventTime, platform: ZoneSource): boolean {
  const stored = storedOf(text);
  if (!stored.ok || stored.master.rules.length !== 1) return false;
  const rule = stored.master.rules[0]!.rule;
  if (rule === null) return false;
  const zones = zonesOf(stored.cal, platform);
  return !endsBeforeDay(rule, stored.master.start, stored.master.end, momentOrUtc(was, zones), zones);
}

/** Is one day of the stored object's series cancelled already (no day of the series stands at `was`)? */
export function dayAbsent(text: string, was: EventTime, platform: ZoneSource): boolean {
  const stored = storedOf(text);
  if (!stored.ok) return false;
  const found = dayOf(stored, was, platform);
  return found !== null && found.day === null;
}

/**
 * The stored object with its series ended before one of its days (`was`, which is not its first):
 * its one repeat rule ends there (UNTIL, in place of any COUNT), its sequence moves on, and the
 * components of its changed days from that day on are taken out with the days they named. Every
 * other line, and every changed day before it, stays as it was. `not_found`: the series has no
 * such day. `keepCancelled`, where those days go on as a series of their own: the days from that
 * day on that the series cancels by a component of their own stay excluded days of it, as EXDATE
 * lines (they exclude nothing past its end), so that the copy the new series is made from still
 * says which of its days are cancelled.
 */
export function seriesEndedText(
  text: string,
  was: EventTime,
  nowMs: number,
  platform: ZoneSource,
  o: { readonly keepCancelled: boolean } = { keepCancelled: false },
): Edited {
  const stored = storedOf(text);
  if (!stored.ok) return stored;
  const rule = stored.master.rules.length === 1 ? stored.master.rules[0]!.rule : null;
  const found = dayOf(stored, was, platform);
  if (rule === null || found === null || found.day === null) return { ok: false, reason: "not_found" };
  const at = changedOccurrence({ ...found.day, event: stored.master }, found.zones).recurrenceId;
  const first = stored.master.start;
  if (at === null || first === null || momentOrUtc(at, found.zones) <= momentOrUtc(first, found.zones))
    return { ok: false, reason: "field_unwritable" };
  const from = momentOrUtc(at, found.zones);
  const ended: RRule = { ...rule, count: null, until: endBefore(at, found.zones) };
  const ruled = withProperty(stored.master.component, "RRULE", plain("RRULE", formatRRule(ended)));
  const kept = o.keepCancelled
    ? cancelledNotExcluded(stored.cal.events, stored.master, found.zones).filter(
        (t) => momentOrUtc(t, found.zones) >= from,
      )
    : [];
  const master =
    kept.length === 0
      ? ruled
      : { ...ruled, properties: [...ruled.properties, ...kept.map((t) => timeProperty("EXDATE", t))] };
  let cal = withEvent(
    stored.cal,
    stored.master,
    withSequence(eventOf(stamped(master, nowMs)), (stored.master.sequence ?? 0) + 1),
  );
  for (const day of cal.events) {
    if (
      day.uid === stored.master.uid &&
      day.recurrenceId !== null &&
      momentOrUtc(day.recurrenceId, found.zones) >= from
    )
      cal = withEvent(cal, day, null);
  }
  return written(cal);
}

/**
 * Does the stored object's series end before that day already, exactly where a series' end before
 * that day ends it (UNTIL the second before it, or the day before for whole days, and no count),
 * with no changed day of it from there on? Asked of a copy that is not the one a write was made
 * on: only then was it this write that ended it (an earlier attempt landed). A copy that ends
 * elsewhere, earlier among them, is someone else's.
 */
export function seriesEndsBefore(text: string, was: EventTime, platform: ZoneSource): boolean {
  const stored = storedOf(text);
  if (!stored.ok || stored.master.rules.length !== 1 || stored.master.start === null) return false;
  const rule = stored.master.rules[0]!.rule;
  const zones = zonesOf(stored.cal, platform);
  const from = momentOrUtc(was, zones);
  const day = clockOf(stored.master.start, from, zones);
  if (rule === null || rule.until === null || rule.count !== null || day === null) return false;
  const until = endBefore(day, zones);
  if (until === null) return false;
  let same: boolean;
  if (until.kind === "date")
    same =
      rule.until.kind === "date" &&
      rule.until.year === until.year &&
      rule.until.month === until.month &&
      rule.until.day === until.day;
  else
    same = until.kind === "instant" && rule.until.kind === "instant" && rule.until.epochMs === until.epochMs;
  return (
    same &&
    !stored.cal.events.some(
      (e) =>
        e.uid === stored.master.uid && e.recurrenceId !== null && momentOrUtc(e.recurrenceId, zones) >= from,
    )
  );
}

/** The lines of a series' own component a new series of its days does not take: the counter of the series' own versions, its making, and its excluded days (written anew). */
const NOT_CARRIED = ["SEQUENCE", "CREATED", "EXDATE"];

/**
 * The days a stored series cancels by a component of their own that its EXDATE lines do not name
 * already, each told on the series' own clock (as an EXDATE line of it tells a day): the days a
 * series' end keeps as excluded days, and a series of their own carries.
 */
function cancelledNotExcluded(events: readonly CalEvent[], master: CalEvent, zones: ZoneSource): EventTime[] {
  const first = master.start;
  const named = new Set(master.excluded.map((e) => momentOrUtc(e, zones)));
  return cancelledDaysOf(events, master).flatMap((t) => {
    const at = momentOrUtc(t, zones);
    if (named.has(at)) return [];
    named.add(at);
    return [(first === null ? null : clockOf(first, at, zones)) ?? t];
  });
}

/** Every day a stored series excludes: its EXDATE lines', as they are written, then the days it cancels by a component of their own. */
const excludedDaysOf = (events: readonly CalEvent[], master: CalEvent, zones: ZoneSource): EventTime[] => [
  ...master.excluded,
  ...cancelledNotExcluded(events, master, zones),
];

/**
 * A new object of the days of the stored object's series from its day `cut` on, made from the
 * series' own component. Every line the series carries is carried as it is: its categories, its
 * attachments, its alarms, its organizer, the lines no reader has a field for. Only what a new
 * series must differ in is written anew: its UID (`uid`), its stamps, its start and end, its repeat
 * (`rule`), its excluded days from `cut` on (moved with a new time of that day), and the fields
 * `change` names. Its invitees are asked again (NEEDS-ACTION, RSVP=TRUE); its organizer and the
 * organizer's own line among them are kept as they are. Its changed days are not carried. A zone it
 * names is the stored object's own definition where it has one.
 * `field_unwritable`: its excluded days from `cut` on cannot be carried to its start, or the series
 * names its days by more than its one rule.
 */
export function continuedObjectText(
  text: string,
  cut: EventTime,
  uid: string,
  start: EventTime,
  end: EventTime,
  rule: RRule,
  change: EventChange,
  nowMs: number,
  platform: ZoneSource,
): Edited {
  const stored = storedOf(text);
  if (!stored.ok) return stored;
  const master = stored.master;
  if (master.rules.length !== 1 || master.recurrenceId !== null || master.start === null)
    return { ok: false, reason: "not_found" };
  if (master.added.length > 0 || master.component.properties.some((p) => sameName(p.name, "EXRULE")))
    return { ok: false, reason: "field_unwritable" };
  const zones = zonesOf(stored.cal, platform);
  const day = clockOf(master.start, momentOrUtc(cut, zones), zones);
  if (day === null) return { ok: false, reason: "field_unwritable" };
  const excluded = carriedExclusions(day, excludedDaysOf(stored.cal.events, master, zones), start, zones);
  if (excluded === null) return { ok: false, reason: "field_unwritable" };
  // The series' own lines in their order: its name and its repeat (with its excluded days) where they stood; its times and stamps
  // are written anew in their places below.
  const lines: Property[] = [];
  for (const p of master.component.properties) {
    if (sameName(p.name, "RRULE"))
      lines.push(plain("RRULE", formatRRule(rule)), ...excluded.map((e) => timeProperty("EXDATE", e)));
    else if (sameName(p.name, "UID")) lines.push(plain("UID", uid));
    else if (!NOT_CARRIED.some((n) => sameName(p.name, n))) lines.push(p);
  }
  let event = withTimes(eventOf({ ...master.component, properties: lines }), start, end);
  // The fields the person named for those days, each in its one place.
  const named = applied(event.component, change);
  if (named === "field_unwritable") return { ok: false, reason: named };
  event = eventOf(stamped(named, nowMs));
  // A new series asks its invitees again; their answers were to the series it comes from. The organizer's own line is no
  // invitee to be asked: it is kept as it is, as the organizer's own line is.
  for (const a of event.attendees) {
    if (organizersOwn(event.organizer, a)) continue;
    let line = withParam(withParam(a.property, "PARTSTAT", ["NEEDS-ACTION"]), "RSVP", ["TRUE"]);
    for (const note of ANSWER_PARAMS) line = withParam(line, note, null);
    event = eventOf(withPropertyAt(event.component, a.property, line));
  }
  // Its zones: the stored object's own definitions where it has them, else made over the series' span.
  const tzids = [...new Set([start, end, ...excluded].flatMap((t) => (t.kind === "zoned" ? [t.tzid] : [])))];
  const timezones: Component[] = [];
  for (const tzid of tzids) {
    const own = stored.cal.tree.components.find(
      (k) =>
        sameName(k.name, "VTIMEZONE") &&
        k.properties.some((p) => sameName(p.name, "TZID") && p.value === tzid),
    );
    if (own !== undefined) {
      timezones.push(own);
      continue;
    }
    const startMs = momentOrUtc(start, platform);
    const made = vtimezoneFrom(tzid, platform, {
      startMs,
      endMs: startMs + VTIMEZONE_SPAN_MAX_DAYS * DAY_MS,
    });
    if (made === null) return { ok: false, reason: "field_unwritable" };
    timezones.push(made);
  }
  return written(newCalendar({ prodid: PRODID, timezones, events: [event.component] }));
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

/**
 * The stored object with the account's answer for ONE day of its series, in that day's own component
 * (the one it has, or one made from the series' as the core makes it): the series' own answer and
 * every other day stay as they were. `not_found`: no such day, or no line of the account's on it.
 */
export function dayAnsweredText(
  text: string,
  was: EventTime,
  as: string,
  reply: PartStat,
  nowMs: number,
  platform: ZoneSource,
): Edited {
  const stored = storedOf(text);
  if (!stored.ok) return stored;
  const found = dayOf(stored, was, platform);
  if (found === null || found.day === null) return { ok: false, reason: "not_found" };
  const own = ownComponent(found.day, found.zones);
  const answered = withPartstat(own.event, as, reply);
  if (answered === null) return { ok: false, reason: "not_found" };
  const day = eventOf(
    withProperty(
      answered.component,
      "DTSTAMP",
      plain("DTSTAMP", formatInstant(Math.floor(nowMs / 1000) * 1000)),
    ),
  );
  return written(own.made ? withNewEvent(stored.cal, day) : withEvent(stored.cal, own.event, day));
}

/**
 * Is this line of an event the organizer's own: the one whose value is the ORGANIZER's own (the same
 * mail address, whatever its case; else the same text, a principal's path or a urn as the server
 * writes it)? A line of another value is an invitee, whatever it says beside its value.
 */
function organizersOwn(organizer: Person | null, a: Attendee): boolean {
  if (organizer === null) return false;
  return organizer.email !== null ? a.email === organizer.email : a.email === null && a.uri === organizer.uri;
}

/** The invitees of an event other than its organizer's own line: the people a server that schedules sends an invitation to. */
export function inviteesOf(event: CalEvent): CalEvent["attendees"] {
  return event.attendees.filter((a) => !organizersOwn(event.organizer, a));
}

/** Does the account's line already hold that answer, for the series (`was` null) or for one day of it with a component of its own? */
export function answerHolds(
  text: string,
  was: EventTime | null,
  as: string,
  reply: PartStat,
  platform: ZoneSource,
): boolean {
  const stored = storedOf(text);
  if (!stored.ok) return false;
  let event: CalEvent = stored.master;
  if (was !== null) {
    const found = dayOf(stored, was, platform);
    if (found === null || found.day === null || found.day.event.recurrenceId === null) return false;
    event = found.day.event;
  }
  const wanted = as.trim().toLowerCase();
  return event.attendees.some((a) => a.email === wanted && (a.partstat ?? "NEEDS-ACTION") === reply);
}

/** The UID of a stored object's events, where they all have one. */
export function uidOfText(text: string): string | null {
  const read = readCalendar(text, DEFAULT_LIMITS);
  if (!read.ok) return null;
  const uids = new Set(read.calendar.events.map((e) => e.uid));
  return uids.size === 1 ? ([...uids][0] ?? null) : null;
}
