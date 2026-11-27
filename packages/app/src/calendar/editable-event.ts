import {
  deleteAudienceOf,
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

function verifiedEventOrganizer(record: CalendarEventRecord, own: readonly string[] | null) {
  if (record.ownOrganizer !== undefined) return record.ownOrganizer;
  const organizer = record.organizer?.address.trim().toLowerCase();
  return !!organizer && own?.some((address) => address.trim().toLowerCase() === organizer) === true;
}

export function eventOwned(record: CalendarEventRecord, own: readonly string[] | null) {
  if (record.ownOrganizer === false) return false;
  return (
    verifiedEventOrganizer(record, own) ||
    (record.repeat && record.personalSeries) ||
    (record.organizer === null && record.myAnswer === null && record.invitees.length === 0)
  );
}

export function canProposeRecord(record: CalendarEventRecord, own: readonly string[] | null) {
  return (
    own !== null &&
    record.organizer !== null &&
    record.myAnswer !== null &&
    record.status !== "cancelled" &&
    !record.heldBack &&
    !record.cut &&
    !record.thisAndFuture &&
    !eventOwned(record, own)
  );
}

export function movePending(record: CalendarEventRecord) {
  return record.writes.some(
    ({ state, act }) =>
      state === "pending" && act?.kind === "calendar_event_move" && act.copyThenRemove === true,
  );
}

function writableRecord(
  record: CalendarEventRecord,
  own: readonly string[] | null,
  access: CalendarRecord["access"],
) {
  return (
    record.ownOrganizer !== false &&
    !movePending(record) &&
    !record.heldBack &&
    !record.cut &&
    record.status !== "cancelled" &&
    (eventOwned(record, own) ||
      (record.myAnswer === null &&
        access === "writer" &&
        (record.sharedWithoutOrganizer ||
          ((record.invitees.length === 0 || record.organizer !== null) &&
            (own !== null || record.invitees.length === 0)))))
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
  access: CalendarRecord["access"],
  series?: CalendarEventRecord | null,
) {
  if (
    access === "writer" &&
    !verifiedEventOrganizer(record, own) &&
    (record.repeat || record.recurrenceId !== "")
  ) {
    const members = (record.repeat ? record : series)?.deleteMembers;
    if (
      connection?.provider !== "caldav" ||
      !members?.length ||
      members.some(({ organizer, guests }) => organizer !== null || guests.length > 0)
    )
      return false;
  }
  if (record.recurrenceId === "")
    return writableRecord(record, own, access) && editableSeries(record, connection);
  return (
    !!series?.repeat &&
    !record.thisAndFuture &&
    record.uid === series.uid &&
    record.calendarId === series.calendarId &&
    writableRecord(record, own, access) &&
    writableRecord(series, own, access) &&
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
  if (!record || record.recurrenceId !== "") return null;
  const calendar = calendarRecord<CalendarRecord>(host, "calendar", record.calendarId);
  if (!calendar?.shown || !writableRecord(record, own, calendar.access)) return null;
  const connection = calendarRecord<CalendarConnectionRecord>(
    host,
    "calendar_connection",
    calendar.connectionId,
  );
  if (viewOnlyOf(calendar, connection)) return null;
  const verifiedOrganizer = verifiedEventOrganizer(record, own);
  return {
    record,
    calendar,
    connection,
    verifiedOrganizer,
    sharedCopy: calendar.access === "writer" && !verifiedOrganizer,
  };
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
    if (!changed || changed.id !== face.recordId || !writableRecord(changed, own, current.calendar.access))
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
    !canEditRecord(exception ?? record, connection, own, current.calendar.access, record)
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

function nativeMoveTo(source: NonNullable<ReturnType<typeof writableEvent>>, target: CalendarRecord) {
  return (
    target.connectionId === source.connection?.id &&
    ((source.connection.provider === "google" && source.verifiedOrganizer) ||
      (source.connection.provider === "caldav" &&
        source.calendar.nativeMove === true &&
        target.nativeMove === true))
  );
}

export function hasGuests(record: CalendarEventRecord) {
  const organizer = record.organizer?.address.trim().toLowerCase();
  return (
    record.invitees.some(({ address }) => address.trim().toLowerCase() !== organizer) ||
    record.deleteMembers?.some(({ guests }) => guests.some(({ address }) => address !== organizer)) === true
  );
}

type MoveRestriction = "account" | "provider" | "event";
export type EventMoveOptions = {
  destinations: readonly CalendarRecord[];
  moveRestriction: MoveRestriction | null;
};

export function seriesMoveAudience(record: CalendarEventRecord) {
  return record.deleteMembers ? deleteAudienceOf(record.deleteMembers, { kind: "record" }) : null;
}

function googleMoveBlocked(record: CalendarEventRecord): boolean {
  return (
    record.googleDefaultEvent !== true ||
    (record.repeat !== null &&
      (record.repeat.excluded.length > 0 || record.deleteMembers?.some(({ at }) => at !== null) === true))
  );
}

export function eventMoveOptions(
  host: HostContract,
  source: ReturnType<typeof writableEvent>,
): EventMoveOptions {
  if (!source) return { destinations: [], moveRestriction: null };
  const { record, connection } = source;
  if (
    (source.sharedCopy && (record.organizer || hasGuests(record))) ||
    (record.repeat && (!record.deleteScopes?.includes("record") || !seriesMoveAudience(record))) ||
    (connection?.provider === "google" && (!source.verifiedOrganizer || googleMoveBlocked(record)))
  )
    return { destinations: [], moveRestriction: "event" };

  const other = host.engine.store
    .entries<CalendarRecord | null>("calendar")
    .flatMap(({ entity }) => (entity && entity.id !== source.calendar.id ? [entity] : []));
  const eligible = other.filter(
    (target) => target.access === "owner" && target.connectionId === connection?.id,
  );
  const destinations = eligible.filter(
    (target) => !viewOnlyOf(target, connection) && nativeMoveTo(source, target),
  );
  const moveRestriction =
    connection?.provider === "microsoft" || destinations.length < eligible.length
      ? "provider"
      : destinations.length === 0 || eligible.length < other.length
        ? "account"
        : null;
  return { destinations, moveRestriction };
}

export function moveDestinations(host: HostContract, source: NonNullable<ReturnType<typeof writableEvent>>) {
  return eventMoveOptions(host, source).destinations;
}
