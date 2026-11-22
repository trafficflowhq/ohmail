/**
 * FROM THE DEVICE'S RECORDS TO THE CALENDAR CORE'S SERIES. The mirror holds `CalendarEventRecord`s; the core expands
 * `Series` of `CalEvent`. A series is the records of one calendar that share a uid. A record that replaces one day
 * (`recurrenceId !== ""`) is a changed day under the key string our server stored, never keyed again here: the
 * device's zone rules may differ from the server's, and a key worked out twice could name another day.
 *
 * Pure: the records in, the series and the way back to each record out.
 */
import {
  eventTimeOf,
  occurrenceOf,
  recurrenceKeyString,
  keyTimeOf,
  parseDuration,
  parseRRule,
  type CalEvent,
  type Component,
  type EventStatus,
  type EventTime,
  type Series,
  type ZoneSource,
} from "@ohmail/cal-core";
import type { CalendarEventRecord, CalendarTime } from "@ohmail/wire";

/** The expansion reads none of a component's lines: every event stands on its fields. */
const NO_LINES: Component = { name: "VEVENT", properties: [], components: [] };

const STATUS: Readonly<Record<CalendarEventRecord["status"], EventStatus>> = {
  confirmed: "CONFIRMED",
  tentative: "TENTATIVE",
  cancelled: "CANCELLED",
};

const timeOf = (t: CalendarTime): EventTime | null => eventTimeOf(t);
export { keyTimeOf };

/** One record as the core reads an event; `recurrenceId` is what the record replaces, rebuilt by its series. */
export function calEventOf(record: CalendarEventRecord, recurrenceId: EventTime | null = null): CalEvent {
  const repeat = recurrenceId === null ? record.repeat : null;
  return {
    component: NO_LINES,
    uid: record.uid === "" ? null : record.uid,
    recurrenceId,
    thisAndFuture: record.thisAndFuture,
    sequence: record.sequence,
    dtstamp: null,
    created: null,
    lastModified: null,
    start: timeOf(record.start),
    end: record.end === null ? null : timeOf(record.end),
    duration: record.duration === null ? null : parseDuration(record.duration),
    summary: record.title,
    description: record.notes,
    location: record.place,
    status: STATUS[record.status],
    transparency: record.busy ? "OPAQUE" : "TRANSPARENT",
    classification: record.private ? "PRIVATE" : null,
    organizer: null,
    attendees: [],
    rules: (repeat?.rules ?? []).map((text) => ({ text, rule: parseRRule(text) })),
    added: (repeat?.added ?? [])
      .map(timeOf)
      .filter((t): t is EventTime => t !== null)
      .map((start) => ({ start, end: null, duration: null })),
    excluded: (repeat?.excluded ?? []).map(timeOf).filter((t): t is EventTime => t !== null),
    alarms: [],
    url: null,
    categories: [],
  };
}

export interface RecordSeries {
  readonly series: readonly Series[];
  /** The record an expanded occurrence's event was made from. */
  readonly recordOf: (event: CalEvent) => CalendarEventRecord | undefined;
  /** The series' own record (the one without a day it replaces), where the device holds it. */
  readonly masterOf: (event: CalEvent) => CalendarEventRecord | undefined;
}

/** The records grouped into series by calendar and uid; a record with no uid stands alone. */
export function seriesOfRecords(records: readonly CalendarEventRecord[]): RecordSeries {
  const groups = new Map<string, CalendarEventRecord[]>();
  for (const r of records) {
    const group = r.uid === "" ? `id\u0000${r.id}` : `uid\u0000${r.calendarId}\u0000${r.uid}`;
    const list = groups.get(group);
    if (list) list.push(r);
    else groups.set(group, [r]);
  }
  const back = new WeakMap<CalEvent, CalendarEventRecord>();
  const master = new WeakMap<CalEvent, CalendarEventRecord>();
  const series: Series[] = [];
  for (const list of groups.values()) {
    const own = list.find((r) => r.recurrenceId === "") ?? null;
    const ownEvent = own === null ? null : calEventOf(own);
    const start = ownEvent?.start ?? null;
    const overrides = new Map<string, CalEvent>();
    for (const r of list) {
      if (r.recurrenceId === "") continue;
      const changed = calEventOf(r, keyTimeOf(r.recurrenceId, start ?? timeOf(r.start)));
      overrides.set(r.recurrenceId, changed);
      back.set(changed, r);
      if (own !== null) master.set(changed, own);
    }
    if (ownEvent !== null && own !== null) {
      back.set(ownEvent, own);
      master.set(ownEvent, own);
    }
    series.push({ uid: list[0]!.uid, master: ownEvent, overrides, cancelled: new Set() });
  }
  return { series, recordOf: (e) => back.get(e), masterOf: (e) => master.get(e) };
}

/** Resolve the selected recurrence against the current records, including range overrides. */
export function recordAtOccurrence(
  master: CalendarEventRecord,
  records: readonly CalendarEventRecord[],
  key: string,
  zones: ZoneSource,
): CalendarEventRecord | undefined {
  const changed = records.filter(
    (r) => r.calendarId === master.calendarId && r.uid === master.uid && r.recurrenceId && !r.heldBack,
  );
  const exact = changed.find((r) => !r.thisAndFuture && r.recurrenceId === key);
  if (exact) return exact;
  const was = keyTimeOf(key, eventTimeOf(master.start));
  if (!was) return undefined;
  const made = seriesOfRecords([master, ...changed]);
  const found = occurrenceOf(made.series[0]!, was, zones);
  return found && recurrenceKeyString(found.key) === key ? made.recordOf(found.event) : undefined;
}
