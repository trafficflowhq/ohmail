import { eventTimeOf, type ZoneSource } from "@ohmail/app-logic/calendar";
import type { CalendarAct, CalendarRemoveScope } from "@ohmail/wire";
import { editBase, type EditableEvent } from "./editable-event.js";
import type { CalendarEventFace } from "./faces.js";
import { changedTimes, type EventChange } from "./event-time-change.js";
import { eventUpdate, type guestUpdate } from "./guest-update.js";

export function reviewedEventAct(
  change: EventChange,
  face: CalendarEventFace,
  current: EditableEvent,
  scope: CalendarRemoveScope,
  zone: string,
  zones: ZoneSource,
  newId: () => string,
  audience: ReturnType<typeof guestUpdate>["audience"],
  cancellationMessage?: string,
): CalendarAct | null {
  const { record, exception } = current;
  const stamped = { eventId: record.id, base: record.updatedAt };
  if (change.kind === "delete")
    return {
      kind: "calendar_event_delete",
      ...stamped,
      scope,
      ...(scope.kind === "record" &&
        current.connection?.provider === "microsoft" &&
        record.deleteMembers?.some((member) => member.at !== null) &&
        cancellationMessage && { cancellationMessage }),
      ...((record.repeat || audience.guests.length > 0) && { audience }),
    };
  if (change.kind === "calendar") {
    return {
      kind: "calendar_event_move",
      ...stamped,
      toCalendarId: change.target,
      ...((record.repeat || audience.guests.length > 0) && { audience }),
    };
  }
  // The whole series moves from its stored start. A single occurrence starts where it is drawn.
  const wholeSeries = scope.kind === "record" && record.repeat !== null;
  const start = wholeSeries ? eventTimeOf(record.start) : face.start;
  const end = wholeSeries ? record.end && eventTimeOf(record.end) : face.end;
  if (!start || !end) return null;
  const times = changedTimes(change, { ...face, start, end }, zone, zones);
  if (!times) return null;
  if (change.kind === "resize-time" && (!record.repeat || wholeSeries) && record.end) {
    if (change.edge === "start") times.end = record.end;
    else times.start = record.start;
  }
  const updateScope = scope.kind === "following" ? { ...scope, newEventId: newId() } : scope;
  return eventUpdate(exception ?? record, editBase(current, updateScope), times, updateScope, { audience });
}
