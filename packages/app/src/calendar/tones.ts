import { hueOf, type CalendarRecord } from "@ohmail/app-logic/calendar";
import { CALENDAR_HUES } from "@ohmail/tokens";

export type CalendarTones = ReadonlyMap<string, number | "neutral">;

/** Colourless calendars take turns through the palette in id order, including hidden calendars. */
export function calendarTones(calendars: readonly CalendarRecord[]): CalendarTones {
  const tones = new Map<string, number | "neutral">();
  const withoutColour: string[] = [];
  for (const calendar of calendars) {
    if (calendar.color === null) withoutColour.push(calendar.id);
    else tones.set(calendar.id, hueOf(calendar.color));
  }
  withoutColour.sort().forEach((id, index) => {
    tones.set(id, CALENDAR_HUES[index % CALENDAR_HUES.length]!);
  });
  return tones;
}
