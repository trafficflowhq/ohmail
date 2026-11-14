import {
  viewOnlyOf,
  type CalendarConnectionRecord,
  type CalendarPort,
  type CalendarRecord,
} from "@ohmail/app-logic/calendar";
import type { HostContract } from "../host/index.js";

/** An event this account may open in the editor. */
export function editableEvent(
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
  if (
    record.organizer
      ? !own?.some(
          (address) => address.trim().toLowerCase() === record.organizer!.address.trim().toLowerCase(),
        )
      : record.myAnswer !== null
  )
    return null;
  const find = <T extends { id: string }>(kind: string, key: string) =>
    host.engine.store.entries<T | null>(kind).find(({ entity }) => entity?.id === key)?.entity ?? undefined;
  const calendar = find<CalendarRecord>("calendar", record.calendarId);
  if (!calendar?.shown) return null;
  const connection = find<CalendarConnectionRecord>("calendar_connection", calendar.connectionId);
  if (viewOnlyOf(calendar, connection)) return null;
  if (
    record.repeat &&
    (!record.personalSeries ||
      connection?.provider !== "caldav" ||
      record.organizer ||
      record.invitees.length > 0)
  )
    return null;
  return { record, calendar };
}
