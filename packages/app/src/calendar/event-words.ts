import { clockTime, dayShort, daySpanOf, eventTimeOf, type ZoneSource } from "@ohmail/app-logic/calendar";
import type { CalendarTime } from "@ohmail/wire";
import type { Text } from "../text/index.js";
import type { CalendarEventFace } from "./faces.js";
import type { EventDraft } from "./event-draft.js";

export function guestNames(names: readonly string[], locale: string, t: Text, shorten = true): string {
  const list =
    shorten && names.length > 3
      ? [...names.slice(0, 2), t("edit.others", { count: names.length - 2 })]
      : names;
  return new Intl.ListFormat(locale === "en" ? "en-GB" : locale).format(list);
}

export function draftWhen({ day, allDay, from, to }: EventDraft, locale: string): string {
  const date = dayShort(day, locale);
  return allDay ? date : `${date}, ${from}–${to}`;
}

export function eventWhen(
  { start, end }: { start?: CalendarTime; end?: CalendarTime | null },
  zone: string,
  zones: ZoneSource,
  locale: string,
  length = false,
): string | null {
  const a = start && eventTimeOf(start);
  const b = end && eventTimeOf(end);
  if (!a) return null;
  const span = daySpanOf({ start: a, end: b || a }, zone, zones);
  if (!span) return null;
  const date = dayShort(span.first, locale);
  if (span.startMinute === null) return date;
  const from = clockTime(span.startMinute, locale);
  if (!length || span.endMinute === null) return `${date}, ${from}`;
  return `${from}–${clockTime(span.endMinute, locale)}`;
}

export function calendarInterval(
  event: Pick<CalendarEventFace, "start" | "end" | "ref">,
  zone: string,
  zones: ZoneSource,
  today: string,
  locale: string,
  t: Text,
) {
  const span = daySpanOf(event, zone, zones);
  const end = daySpanOf({ start: event.end, end: event.end }, zone, zones);
  const date = (day: string) => dayShort(day, locale, today.slice(0, 4));
  const dated = (day: string, minute: number | null) =>
    minute === null ? date(day) : t("atTime", { day: date(day), time: clockTime(minute, locale) });
  let when = date(event.ref.day);
  if (span !== null) {
    when = dated(span.first, span.startMinute);
    const last = span.allDay ? span.last : end?.first;
    if (last !== undefined && last !== span.first) {
      when = t("interval", { first: when, last: dated(last, span.endMinute) });
    } else if (span.endMinute !== null && span.endMinute !== span.startMinute) {
      when += `–${clockTime(span.endMinute, locale)}`;
    }
  }
  return when;
}
