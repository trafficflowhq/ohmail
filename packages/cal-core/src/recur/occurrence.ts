/**
 * One occurrence of a series as a component of its own: what an edit of one day, or an answer to
 * one day, is made on, so that the series stays as it was.
 */
import { propertyOf, withProperty, type Component, type Param } from "../ical/component.js";
import { ANSWER_PARAMS, eventOf, withParam, type CalEvent } from "../ical/event.js";
import { sameName } from "../ical/lines.js";
import { timeProperty } from "../ical/values.js";
import { isValidWall, wallIn } from "../time/arith.js";
import type { EventTime, ZoneSource } from "../time/types.js";
import type { RecurrenceKey } from "./key.js";
import type { Occurrence } from "./series.js";

/**
 * The time a key names, written the way the series writes its own (`like`): what a RECURRENCE-ID for
 * it holds. On the series' own clock where that reading is one a calendar can write (the years 1 to
 * 9999), else as the instant: at either end of the calendar a zone's clock can show a year no text has.
 */
function timeOfKey(key: RecurrenceKey, like: EventTime, zones: ZoneSource): EventTime {
  if (key.kind === "date") return key.date;
  if (key.kind === "wall") return key.tzid === "" ? { kind: "floating", wall: key.wall } : { kind: "zoned", wall: key.wall, tzid: key.tzid };
  const shown = like.kind === "zoned" ? wallIn(key.epochMs, like.tzid, zones) : null;
  return shown !== null && like.kind === "zoned" && isValidWall(shown) ? { kind: "zoned", wall: shown, tzid: like.tzid } : { kind: "instant", epochMs: key.epochMs };
}

/** What belongs to a series and not to one day of it. */
const NOT_OF_ONE_DAY = ["RRULE", "RDATE", "EXDATE", "EXRULE", "RECURRENCE-ID"];

/**
 * An occurrence as a component of its own: the lines of the component that describes it, without
 * the rule and the added and excluded dates, with the occurrence's id and its own start and end.
 * Beside its series it takes that day's place and no other. An occurrence that is such a component
 * already is that component. What was noted of invitees' answers to the series is not carried
 * over: it was not about this day.
 */
export function changedOccurrence(o: Occurrence, zones: ZoneSource): CalEvent {
  const base = o.event;
  if (base.recurrenceId !== null && !base.thisAndFuture) return base;
  const from = base.component;
  const params = (name: string): readonly Param[] => propertyOf(from, name)?.params ?? [];
  const id = timeProperty("RECURRENCE-ID", timeOfKey(o.key, base.recurrenceId ?? base.start ?? o.start, zones));
  const kept = from.properties
    .filter((p) => !NOT_OF_ONE_DAY.some((name) => sameName(p.name, name)))
    .map((p) => (sameName(p.name, "ATTENDEE") ? ANSWER_PARAMS.reduce((line, name) => withParam(line, name, null), p) : p));
  const at = kept.findIndex((p) => sameName(p.name, "DTSTART"));
  let component: Component = { ...from, properties: at < 0 ? [...kept, id] : [...kept.slice(0, at), id, ...kept.slice(at)] };
  component = withProperty(component, "DTSTART", timeProperty("DTSTART", o.start, params("DTSTART")));
  if (propertyOf(from, "DTEND") !== null) component = withProperty(component, "DTEND", timeProperty("DTEND", o.end, params("DTEND")));
  return eventOf(component);
}
