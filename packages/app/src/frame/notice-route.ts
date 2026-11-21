import { daySpanOf, eventTimeOf, type CalendarPort } from "@ohmail/app-logic/calendar";
import { fragmentOf } from "./route.js";

/** A notification can only open an event still held by the calendar serving this frame. */
export function calendarNoticeFragment(port: CalendarPort, id: string, zone: string): string | null {
  const event = port.events().find(({ record }) => record.id === id)?.record;
  if (!event) return null;
  const start = eventTimeOf(event.start);
  const day = start && daySpanOf({ start, end: start }, zone)?.first;
  return fragmentOf({ place: "week", sub: day || null, open: event.id, words: {}, stage: null });
}
