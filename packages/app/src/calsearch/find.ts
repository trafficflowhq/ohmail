import { searchEvents, type DayId, type ViewEvent, type ZoneSource } from "@ohmail/app-logic/calendar";

export function findCalendarEvents(
  query: string,
  items: readonly ViewEvent[],
  today: DayId,
  zone: string,
  zones: ZoneSource,
) {
  return searchEvents({
    query,
    items,
    keyOf: (event) => event.id,
    textOf: (event) => [event.title, event.second, ...event.people, event.notes],
    today,
    zone,
    zones,
  });
}
