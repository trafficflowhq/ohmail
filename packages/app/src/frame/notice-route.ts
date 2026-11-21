import { readerZones, reminderOccurrence } from "@ohmail/app-logic/calendar/alerts";
import { daySpanOf, eventTimeOf, type CalendarPort } from "@ohmail/app-logic/calendar";
import { fragmentOf } from "./route.js";

/** A notification can only open an event still held by the calendar serving this frame. */
export function calendarNoticeFragment(
  port: CalendarPort,
  id: string,
  zone: string,
  startMs?: number,
): string | null {
  const event = port.events().find(({ record }) => record.id === id)?.record;
  if (!event) return null;
  if (startMs !== undefined) {
    const occurrence = reminderOccurrence(port.events(), id, startMs, zone, readerZones());
    return occurrence
      ? fragmentOf({ place: "week", sub: occurrence.day, open: occurrence.open, words: {}, stage: null })
      : null;
  }
  const start = eventTimeOf(event.start);
  const day = start && daySpanOf({ start, end: start }, zone)?.first;
  return fragmentOf({ place: "week", sub: day || null, open: event.id, words: {}, stage: null });
}
