/**
 * WHEN SOMETHING LAST HAPPENED, as a settings line says it: the clock today, the day before that, on the reader's own
 * clock and through the calendar's one way of writing days and times.
 */
import { clockTime, dayShort, isoOfDay, nowIn, readerZones } from "@ohmail/app-logic/calendar";
import { useLocale, useTimeZone } from "../text/index.js";

export function useWhen(): (iso: string | null) => string | null {
  const locale = useLocale();
  const zone = useTimeZone();
  return (iso) => {
    if (iso === null) return null;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return null;
    const zones = readerZones();
    const at = nowIn(ms, zone, zones);
    const today = nowIn(Date.now(), zone, zones);
    if (at === null || today === null) return null;
    const day = isoOfDay(at.day);
    return day === isoOfDay(today.day) ? clockTime(at.minutes, locale) : dayShort(day, locale);
  };
}
