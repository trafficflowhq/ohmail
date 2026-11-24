/**
 * A row's range, worked out in the calendar core (`packages/cal-core/src/stored/event-range.ts`) so
 * that the calendar's sync derives it with the same function as the services. Said here again for
 * the services' own callers, through the core's index as every other import of the core here.
 */
export {
  CALENDAR_RANGE_SLACK_MS, derivedRange, type EventRange, type EventRangeInput,
} from "@ohmail/cal-core";


import type { calEvents } from "@trafficflow/db/mail";
import type { CalendarTime } from "@ohmail/wire";
import {
  eventOf, keyTimeOf, newEventComponent, occurrenceOf, parseDuration, recurrenceKeyString, seriesOf, timeProperty,
  type EventTime,
} from "@ohmail/cal-core";
import { intlZones } from "@ohmail/cal-core/time/zones";
import { eventTimeOf } from "./time.js";

const zones = intlZones();

/** Check a named occurrence against the stored repeat, dates and exceptions published for this record. */
export function storedOccurrence(
  event: Pick<typeof calEvents.$inferSelect, "recurrenceId" | "addedDates" | "excludedDates" | "repeatRule" | "startKind" | "startLocal" | "startZone" | "endKind" | "endLocal" | "endZone" | "uid" | "duration">,
  occurrence: string,
) {
  // Recurrence dates retain their own zone, unlike the times in the outgoing part.
  const storedDates = (raw: unknown): EventTime[] =>
    Array.isArray(raw) ? raw.flatMap((value: CalendarTime) => {
      const time = value && eventTimeOf(value);
      return time ? [time] : [];
    }) : [];
  const added = storedDates(event.addedDates);
  if (event.recurrenceId !== "" || (event.repeatRule === null && added.length === 0)) return event.recurrenceId === occurrence;
  if (!occurrence) return false;
  const start = eventTimeOf({ kind: event.startKind as CalendarTime["kind"], value: event.startLocal, zone: event.startZone ?? undefined });
  const was = keyTimeOf(occurrence, start);
  if (!start || !was || (was.kind === "instant" && !Number.isSafeInteger(was.epochMs))) return false;
  const end = event.endKind && event.endLocal
    ? eventTimeOf({ kind: event.endKind as CalendarTime["kind"], value: event.endLocal, zone: event.endZone ?? undefined })
    : null;
  const component = newEventComponent({
    uid: event.uid, dtstamp: { kind: "instant", epochMs: 0 }, start, end: end ?? undefined,
    duration: event.duration ? parseDuration(event.duration) ?? undefined : undefined,
  });
  const master = eventOf({ ...component, properties: [
    ...component.properties,
    ...(event.repeatRule?.split("\n").map((value) => ({ name: "RRULE", value, params: [] })) ?? []),
    ...storedDates(event.excludedDates).map((date) => timeProperty("EXDATE", date)),
    ...added.map((date) => timeProperty("RDATE", date)),
  ] });
  const [series] = seriesOf([master], zones);
  const found = series && occurrenceOf(series, was, zones);
  return !!found && recurrenceKeyString(found.key) === occurrence;
}
