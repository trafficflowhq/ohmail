import type { CalendarSettingsWire } from "@ohmail/app-logic/calendar";

type SavedHours = Pick<CalendarSettingsWire, "dayFromMinute" | "dayToMinute">;

export function hoursInView(settings: SavedHours | null): { from: number; to: number } {
  return {
    from: settings?.dayFromMinute ?? 6 * 60,
    to: settings?.dayToMinute ?? 22 * 60,
  };
}
