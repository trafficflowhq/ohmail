import {
  viewOnlyOf,
  recordAtOccurrence,
  type ZoneSource,
  type CalendarConnectionRecord,
  type CalendarPort,
  type CalendarRecord,
} from "@ohmail/app-logic/calendar";
import type { CalendarChangeScope } from "@ohmail/wire";
import type { HostContract } from "../host/index.js";
import type { CalendarEventFace } from "./faces.js";
import type { CalendarEventRecord } from "@ohmail/app-logic/calendar";

export function eventOwned(record: CalendarEventRecord, own: readonly string[] | null) {
  if (record.repeat && record.personalSeries) return true;
  const organizer = record.organizer?.address.trim().toLowerCase();
  return organizer
    ? own?.some((address) => address.trim().toLowerCase() === organizer) === true
    : record.myAnswer === null && record.invitees.length === 0;
}

function writableRecord(
  record: CalendarEventRecord,
  own: readonly string[] | null,
  series?: CalendarEventRecord,
) {
  const organizer = record.organizer?.address.trim().toLowerCase();
  return (
    !record.heldBack &&
    !record.cut &&
    record.status !== "cancelled" &&
    (record.invitees.length === 0 || record.organizer !== null) &&
    (eventOwned(record, own) ||
      (series?.personalSeries === true &&
        Boolean(organizer) &&
        organizer === series.organizer?.address.trim().toLowerCase()))
  );
}

function editableSeries(record: CalendarEventRecord, connection: CalendarConnectionRecord | undefined) {
  return (
    !record.repeat ||
    (record.repeat.rules.length === 1 &&
      record.repeat.added.length === 0 &&
      (connection?.provider === "caldav" ||
        connection?.provider === "google" ||
        connection?.provider === "microsoft"))
  );
}

export function canEditRecord(
  record: CalendarEventRecord,
  connection: CalendarConnectionRecord | undefined,
  own: readonly string[] | null,
  series?: CalendarEventRecord | null,
) {
  if (record.recurrenceId === "") return writableRecord(record, own) && editableSeries(record, connection);
  return (
    !!series?.repeat &&
    !record.thisAndFuture &&
    record.uid === series.uid &&
    record.calendarId === series.calendarId &&
    writableRecord(record, own, series) &&
    writableRecord(series, own) &&
    editableSeries(series, connection)
  );
}

/** A stored event this account can change. A changed day must be written through its series. */
export function writableEvent(
  host: HostContract,
  port: CalendarPort,
  id: string,
  own: readonly string[] | null,
) {
  const record = port.events().find((item) => item.record.id === id)?.record;
  if (!record || record.recurrenceId !== "" || !writableRecord(record, own)) return null;
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
      !eventOwned(changed, own)
    )
      return null;
  } else if (face.recordId !== record.id || face.ref.occurrence !== null) return null;
  return current;
}

export function editableEvent(
  host: HostContract,
  port: CalendarPort,
  face: CalendarEventFace,
  own: readonly string[] | null,
) {
  const current = writableEvent(host, port, face.ref.event, own);
  if (!current) return null;
  const { record, connection } = current;
  const exception =
    face.recordId === record.id
      ? null
      : port.events().find(({ record: entry }) => entry.id === face.recordId)?.record;
  if (
    exception === undefined ||
    (exception && exception.recurrenceId !== face.ref.occurrence) ||
    !canEditRecord(exception ?? record, connection, own, record)
  )
    return null;
  return { ...current, exception };
}

export type EditableEvent = NonNullable<ReturnType<typeof editableEvent>>;

export function editBase(current: Pick<EditableEvent, "record" | "exception">, scope?: CalendarChangeScope) {
  const { record, exception } = current;
  if (!exception) return record.updatedAt;
  return scope?.kind === "occurrence" ? exception.updatedAt : `${exception.updatedAt}/${record.updatedAt}`;
}

export function editVersions(current: Pick<EditableEvent, "record" | "exception">) {
  return JSON.stringify([current.record.updatedAt, current.exception?.id, current.exception?.updatedAt]);
}

export const editSchedule = ({ record, exception }: Pick<EditableEvent, "record" | "exception">) =>
  JSON.stringify([
    record.calendarId,
    record.start,
    record.end,
    record.repeat,
    exception?.start,
    exception?.end,
  ]);

function calendarRecord<T extends { id: string }>(host: HostContract, kind: string, key: string) {
  return (
    host.engine.store.entries<T | null>(kind).find(({ entity }) => entity?.id === key)?.entity ?? undefined
  );
}

/** The write service can transfer an event between calendars of its own Google connection. */
export function moveDestinations(host: HostContract, source: NonNullable<ReturnType<typeof writableEvent>>) {
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
