import { searchEvents, type DayId, type ViewEvent, type ZoneSource } from "@ohmail/app-logic/calendar";

export function findCalendarEvents(
  query: string,
  items: readonly ViewEvent[],
  today: DayId,
  zone: string,
  zones: ZoneSource,
  date?: DayId,
  includeText = false,
) {
  return searchEvents({
    query,
    ...(date ? { date, includeText } : {}),
    items,
    keyOf: (event) => event.id,
    textOf: (event) => [event.title, event.second, ...event.people, event.notes],
    today,
    zone,
    zones,
  });
}
