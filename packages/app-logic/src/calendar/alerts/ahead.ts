/**
 * THE CALENDAR'S ALERTS, AS THE PAGE MAKES THEM: one for each occurrence near now and each of its alarms the ringing
 * rule lets ring (`ringingLeads`), made by the one maker (`aheadAlert`). A busy-only calendar supplies occupied
 * time, so its retained events stay out of this calculation. For the events that remain, the ringing rule checks
 * status, answer, visibility and alarm method. This calculation places an occurrence's start on the clock:
 * a time in a zone at its moment, a clock with no zone and a whole day on the reader's own clock, a whole day
 * from its midnight. A start in an unknown zone cannot be placed.
 *
 * Pure: the presented events (the person's waiting writes laid over), the calendars, the reader's zone and its rules,
 * and now are handed in.
 */
import {
  addDays,
  daysFromCivil,
  instantOf,
  instantOfFloating,
  resolveWall,
  wall,
  wallIn,
  weekdayOf,
  type EventTime,
  type ZoneSource,
} from "@ohmail/cal-core";
import {
  AHEAD_DAYS,
  AHEAD_LATE_MS,
  NOTICE_LEAD_MAX_MIN,
  aheadAlert,
  ringingLeads,
  type Clock,
  type NoticeAct,
  type NoticeAhead,
} from "@ohmail/client-engine";
import type { EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type { CalendarRecord } from "@ohmail/wire";
import { nowIn } from "../grid/days.js";
import { occurrencesIn } from "../window.js";

const DAY_MS = 86_400_000;

export interface AheadInput {
  /** The presented calendar: each event with the person's waiting writes laid over (`port.events()`). */
  readonly events: readonly EventWithWrites[];
  readonly calendars: readonly CalendarRecord[];
  /** The reader's zone, by its name. */
  readonly zone: string;
  readonly zones: ZoneSource;
  readonly nowMs: number;
  /** The person's choice to show titles in notifications. */
  readonly showTitles: boolean;
  /** The acts the surface's notices carry. */
  readonly acts: readonly NoticeAct[];
}

/**
 * An occurrence's start as a moment: a time in a zone at its moment, a clock with no zone read on the reader's clock,
 * a whole day at the reader's midnight of that day (the real one, on the nights the clocks change). `null` where the
 * zone is not known here.
 */
export function startMsOf(start: EventTime, zone: string, zones: ZoneSource): number | null {
  switch (start.kind) {
    case "instant":
    case "zoned":
      return instantOf(start, zones)?.epochMs ?? null;
    case "floating":
      return instantOfFloating(start, zone, zones)?.epochMs ?? null;
    case "date":
      return resolveWall(wall(start.year, start.month, start.day), zone, zones);
  }
}

/**
 * The alerts the calendar wants from `nowMs` less what may ring late to `nowMs` and eight days, unsorted: `aheadSet`
 * sorts, bounds and dedupes them for a surface. The occurrences are read from the reader's yesterday as far as an
 * alarm four weeks ahead of the window's last day reaches back into it. An expansion that stopped at its ceiling still
 * answers what it found.
 */
export function alertsAhead(input: AheadInput): NoticeAhead[] {
  const today = nowIn(input.nowMs, input.zone, input.zones);
  if (today === null) return [];
  const { shown } = occurrencesIn({
    events: input.events,
    calendars: input.calendars.filter((calendar) => calendar.access !== "busy"),
    query: {
      from: addDays(today.day, -1),
      to: addDays(today.day, AHEAD_DAYS + Math.ceil(NOTICE_LEAD_MAX_MIN / 1440)),
    },
    zone: input.zone,
    zones: input.zones,
  });
  const from = input.nowMs - AHEAD_LATE_MS;
  const until = input.nowMs + AHEAD_DAYS * DAY_MS;
  const out: NoticeAhead[] = [];
  for (const o of shown) {
    // A changed day of a series rings by its own record's alarms, under its own record's id.
    const leads = ringingLeads(o.record, o.calendar);
    if (leads.length === 0) continue;
    const start = o.occurrence.start;
    const startMs = startMsOf(start, input.zone, input.zones);
    if (startMs === null) continue;
    const call = typeof o.record.callLink === "string" && o.record.callLink !== "";
    const acts = call ? input.acts : input.acts.filter((act) => act !== "join");
    const event = {
      id: o.record.id,
      title: o.record.title,
      private: o.record.private,
      heldBack: o.record.heldBack,
    };
    for (const leadMin of leads) {
      const alert = aheadAlert(event, input.showTitles, {
        startMs,
        allDay: start.kind === "date",
        leadMin,
        acts,
      });
      if (alert !== null && alert.atMs >= from && alert.atMs <= until) out.push(alert);
    }
  }
  return out;
}

/**
 * A start on the reader's clock, as a notice drawn at `nowMs` says it: the hour and the minute there, and the day as
 * `today` or `tomorrow` by the reader's own days (not by hours), else the date with its weekday counted from Sunday as
 * 0. `null` where the zone is not known here.
 */
export function noticeClockOf(startMs: number, nowMs: number, zone: string, zones: ZoneSource): Clock | null {
  const at = wallIn(startMs, zone, zones);
  const now = wallIn(nowMs, zone, zones);
  if (at === null || now === null) return null;
  const day = daysFromCivil(at.year, at.month, at.day);
  const ahead = day - daysFromCivil(now.year, now.month, now.day);
  return {
    hour: at.hour,
    minute: at.minute,
    day:
      ahead === 0
        ? "today"
        : ahead === 1
          ? "tomorrow"
          : { month: at.month, dom: at.day, dow: (weekdayOf(day) + 1) % 7 },
  };
}

/** Resolve a reminder against the occurrences still held by this calendar. */
export function reminderOccurrence(
  events: readonly EventWithWrites[],
  id: string,
  startMs: number,
  zone: string,
  zones: ZoneSource,
): { day: string; open: string } | null {
  if (!Number.isSafeInteger(startMs) || startMs < 0) return null;
  const day = nowIn(startMs, zone, zones)?.day;
  if (!day) return null;
  const calendars = [...new Set(events.map(({ record }) => record.calendarId))].map(
    (calendarId) => ({ id: calendarId, shown: true }) as CalendarRecord,
  );
  const { shown } = occurrencesIn({ events, calendars, query: { from: day, to: day }, zone, zones });
  const match = shown.find(
    (o) => o.record.id === id && startMsOf(o.occurrence.start, zone, zones) === startMs,
  );
  if (!match) return null;
  const series = (match.series ?? match.record).id;
  return { day: match.day, open: match.key === null ? match.record.id : `${series}@${match.key}` };
}
