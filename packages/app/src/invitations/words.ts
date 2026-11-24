/** WHEN A LISTED EVENT IS, in words: its day, and its hours or "all day"; a day across many days names its last. */
import { clockTime, dayLong, dayShort, yearOf, type DaySpan } from "@ohmail/app-logic/calendar";
import type { Text } from "../text/index.js";

/** `t` reads the list's own namespace, which holds `allDay` and `span` ("{from}–{to}"). */
export function whenOf(
  span: DaySpan | null,
  day: string,
  today: string,
  locale: string,
  t: Text,
  long = false,
): string {
  const name = (id: string) => (long ? dayLong : dayShort)(id, locale, yearOf(today));
  if (span === null) return name(day);
  if (span.allDay)
    return span.last === span.first
      ? `${name(span.first)}, ${t("allDay")}`
      : t("span", { from: name(span.first), to: name(span.last) });
  const from = clockTime(span.startMinute ?? 0, locale);
  const to = span.endMinute === null ? null : clockTime(span.endMinute, locale);
  const hours = to === null || to === from ? from : t("span", { from, to });
  return `${name(span.first)}, ${hours}`;
}
