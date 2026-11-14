import {
  viewOnlyOf,
  recordAtOccurrence,
  type ZoneSource,
  type CalendarConnectionRecord,
  type CalendarPort,
  type CalendarRecord,
} from "@ohmail/app-logic/calendar";
import type { HostContract } from "../host/index.js";
import type { CalendarEventFace } from "./faces.js";
import type { CalendarEventRecord } from "@ohmail/app-logic/calendar";

function owned(record: CalendarEventRecord, own: readonly string[] | null) {
  const organizer = record.organizer?.address.trim().toLowerCase();
  return organizer
    ? own?.some((address) => address.trim().toLowerCase() === organizer) === true
    : record.myAnswer === null && record.invitees.length === 0;
}

/** A stored event this account can change. A changed day must be written through its series. */
export function writableEvent(
  host: HostContract,
  port: CalendarPort,
  id: string,
  own: readonly string[] | null,
) {
  const record = port.events().find((item) => item.record.id === id)?.record;
  if (
    !record ||
    record.heldBack ||
    record.cut ||
    record.status === "cancelled" ||
    record.recurrenceId !== "" ||
    (record.invitees.length > 0 && !record.organizer)
  )
    return null;
  if (!owned(record, own)) return null;
  const calendar = calendarRecord<CalendarRecord>(host, "calendar", record.calendarId);
  if (!calendar?.shown) return null;
  const connection = calendarRecord<CalendarConnectionRecord>(
    host,
    "calendar_connection",
    calendar.connectionId,
  );
  if (viewOnlyOf(calendar, connection)) return null;
  return { record, calendar, connection };
}

export function removableEvent(
  host: HostContract,
  port: CalendarPort,
  face: CalendarEventFace,
  own: readonly string[] | null,
  zones: ZoneSource,
) {
  if (face.viewOnly || face.state === "off") return null;
  const current = writableEvent(host, port, face.ref.event, own);
  if (!current) return null;
  const { record } = current;
  if (
    record.repeat &&
    (record.repeat.rules.length !== 1 ||
      record.repeat.added.length ||
      !record.deleteMembers ||
      !record.deleteScopes?.length)
  )
    return null;
  if (record.repeat) {
    const key = face.ref.occurrence;
    if (!key) return null;
    const changed = recordAtOccurrence(
      record,
      port.events().map(({ record }) => record),
      key,
      zones,
    );
    if (
      !changed ||
      changed.id !== face.recordId ||
      changed.status === "cancelled" ||
      changed.cut ||
      !owned(changed, own)
    )
      return null;
  } else if (face.recordId !== record.id || face.ref.occurrence !== null) return null;
  return current;
}

export function editableEvent(
  host: HostContract,
  port: CalendarPort,
  id: string,
  own: readonly string[] | null,
) {
  const current = writableEvent(host, port, id, own);
  if (
    current?.record.repeat &&
    (!current.record.personalSeries ||
      current.connection?.provider !== "caldav" ||
      current.record.organizer ||
      current.record.invitees.length > 0)
  )
    return null;
  return current;
}

function calendarRecord<T extends { id: string }>(host: HostContract, kind: string, key: string) {
  return (
    host.engine.store.entries<T | null>(kind).find(({ entity }) => entity?.id === key)?.entity ?? undefined
  );
}

/** The write service can transfer an event between calendars of its own Google connection. */
export function moveDestinations(host: HostContract, source: NonNullable<ReturnType<typeof editableEvent>>) {
  const connection = source.connection;
  if (connection?.provider !== "google" || source.record.repeat) return [];
  return host.engine.store
    .entries<CalendarRecord | null>("calendar")
    .flatMap(({ entity: target }) =>
      target &&
      target.id !== source.calendar.id &&
      target.connectionId === connection.id &&
      !viewOnlyOf(target, connection)
        ? [target]
        : [],
    );
}
