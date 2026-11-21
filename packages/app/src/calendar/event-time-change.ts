import { addDays, isoOfDay, reschedule, resizeTime, type ZoneSource } from "@ohmail/app-logic/calendar";
import type { CalendarEventFace } from "./faces.js";
import type { DayEdge } from "./view.js";

export type EventChange =
  | { kind: "delete" }
  | { kind: "calendar"; target: string }
  | { kind: "time"; days: number; minutes: number }
  | { kind: "resize"; edge: DayEdge; days: number }
  | { kind: "resize-time"; edge: DayEdge; minutes: number };

export function resizedDays(
  start: CalendarEventFace["start"],
  end: CalendarEventFace["end"],
  edge: DayEdge,
  days: number,
) {
  if (start.kind !== "date" || end.kind !== "date") return null;
  const first = isoOfDay(start);
  const last = addDays(isoOfDay(end), -1);
  const shifted = addDays(edge === "start" ? first : last, days);
  return edge === "start"
    ? { first: shifted > last ? last : shifted, last }
    : { first, last: shifted < first ? first : shifted };
}

export function canStartTimeChange(
  face: CalendarEventFace,
  change: EventChange,
  zone: string,
  zones: ZoneSource,
) {
  if (change.kind === "time") return Boolean(change.days || change.minutes);
  if (change.kind === "resize-time")
    return resizeTime(face, change.edge, change.minutes, zone, zones) !== null;
  if (change.kind !== "resize") return true;
  const range = resizedDays(face.start, face.end, change.edge, change.days);
  const before = resizedDays(face.start, face.end, change.edge, 0);
  return !!range && (range.first !== before?.first || range.last !== before.last);
}

export function changedTimes(change: EventChange, face: CalendarEventFace, zone: string, zones: ZoneSource) {
  if (change.kind === "time")
    return reschedule(face.start, face.end, change.days, change.minutes, zone, zones);
  if (change.kind === "resize-time") return resizeTime(face, change.edge, change.minutes, zone, zones);
  if (change.kind !== "resize") return null;
  const range = resizedDays(face.start, face.end, change.edge, change.days);
  return (
    range && {
      start: { kind: "date" as const, value: range.first.replaceAll("-", "") },
      end: { kind: "date" as const, value: addDays(range.last, 1).replaceAll("-", "") },
    }
  );
}
