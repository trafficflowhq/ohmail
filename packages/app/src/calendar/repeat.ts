import type { Text } from "../text/index.js";
import {
  eventTimeOf,
  parseRRule,
  draftRepeatShape,
  addDays,
  dayOfIso,
  readerZones,
  weekdayOfDay,
  wallInstants,
} from "@ohmail/app-logic/calendar";

export const WEEK = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export function repeatPresets(day: string): (string | null)[] {
  const date = dayOfIso(day)!;
  const weekday = WEEK[weekdayOfDay(date)]!;
  const last = addDays(day, 7).slice(0, 7) !== day.slice(0, 7);
  const ordinal = last ? -1 : Math.ceil(date.day / 7);
  return [
    null,
    "FREQ=DAILY",
    "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    "FREQ=WEEKLY;BYDAY=" + weekday,
    "FREQ=WEEKLY;INTERVAL=2;BYDAY=" + weekday,
    "FREQ=MONTHLY;BYMONTHDAY=" + date.day,
    "FREQ=MONTHLY;BYDAY=" + ordinal + weekday,
    "FREQ=YEARLY;BYMONTH=" + date.month + ";BYMONTHDAY=" + date.day,
  ];
}

export function untilForDay(day: string, allDay: boolean, from: string, zone: string): string | null {
  const date = dayOfIso(day);
  if (!date) return null;
  if (allDay) return day.replaceAll("-", "");
  const [hour, minute] = from.split(":").map(Number);
  if (hour === undefined || minute === undefined) return null;
  const [epoch] = wallInstants({ ...date, hour, minute, second: 0 }, zone, readerZones());
  return epoch === undefined ? null : new Date(epoch).toISOString().replace(/[-:]/g, "").replace(".000", "");
}

export function repeatFits(
  value: string,
  start: Parameters<typeof eventTimeOf>[0] | undefined,
  shapes?: readonly string[],
  allowUtc = false,
): boolean {
  if (!shapes?.length || !start) return false;
  const rule = parseRRule(value);
  const first = eventTimeOf(start);
  const shape = rule && first && draftRepeatShape(rule, first, readerZones(), Date.now(), allowUtc);
  return !!shape && shapes.includes(shape);
}

/** The sentence that keeps a repeat from this calendar (it proved no repeat, or not this one), or `null`. */
export function repeatRefusal(
  value: string | null | undefined,
  start: Parameters<typeof eventTimeOf>[0] | undefined,
  shapes: readonly string[] | undefined,
  t: Text,
  allowUtc = false,
): string | null {
  if (!value || repeatFits(value, start, shapes, allowUtc)) return null;
  return t(shapes?.length ? "repeat.unsupported" : "repeat.unavailable");
}
