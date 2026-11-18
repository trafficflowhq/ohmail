/**
 * WHAT THE PAGE LEAVES THE PHONE: the calendar's snapshot, version 1, made whole each time from the presented calendar.
 * The page has applied every choice and rule; the phone's side holds none. Alerts are the set a surface is handed, and
 * none unless this device rings alerts (the caller asks the gate's refusals and hands the answer in). Days and the
 * month are laid out on the reader's clock. An event's label is the widgets' own switch's (`eventLabel`); one that has
 * no label (an invitation not shown yet) is neither listed nor counted. An event called off or declined is not listed:
 * a widget has no way to strike it through. The record is read closed before it is answered, as the file's writer
 * reads it again.
 */
import {
  addDays,
  dayNumber,
  daysFromCivil,
  daysInMonth,
  plainDate,
  resolveWall,
  wall,
  weekdayOf,
  type PlainDate,
} from "@ohmail/cal-core";
import {
  CALENDAR_SNAPSHOT_VERSION,
  SNAPSHOT_DAYS,
  SNAPSHOT_DAY_EVENTS_MAX,
  SUMMARY_AT_START,
  aheadSet,
  eventLabel,
  readCalendarSnapshot,
  type CalendarSnapshot,
  type SnapshotDay,
  type SnapshotEvent,
  type SnapshotSummary,
} from "@ohmail/client-engine";
import type { CalendarEventRecord } from "@ohmail/wire";
import { nowIn } from "../grid/days.js";
import { dayNumberOf, daySpanOf } from "../spans/days.js";
import { occurrencesIn } from "../window.js";
import { alertsAhead, noticeClockOf, startMsOf, type AheadInput } from "./ahead.js";

export interface SnapshotInput extends AheadInput {
  /** The account's scope: the snapshot is that account's, and none is made for a scope that is no account's. */
  readonly scope: string;
  /** This device rings the calendar's alerts: the gate's refusals, asked by the caller. */
  readonly alertsOn: boolean;
  /** "Show titles on widgets". */
  readonly widgetTitles: boolean;
  /** The day's summary is switched on, and when it rings: a whole minute of the day. */
  readonly summaryOn: boolean;
  readonly summaryAt: number;
  /** The account's own addresses: an event one of them organizes is no invitation to answer. */
  readonly ownAddresses: readonly string[];
}

/** A day as a notice names it: the weekday counted from Sunday as 0. */
const dateOf = (day: PlainDate) => ({
  month: day.month,
  dom: day.day,
  dow: (weekdayOf(dayNumber(day)) + 1) % 7,
});

/** An invitation the person has still to answer: somebody else's, waiting, not called off. */
function waitsForAnswer(record: CalendarEventRecord, own: ReadonlySet<string>): boolean {
  const organizer = record.organizer?.address.trim().toLowerCase() ?? null;
  return (
    record.myAnswer === "none" && record.status !== "cancelled" && organizer !== null && !own.has(organizer)
  );
}

/** The calendar's snapshot for `scope`, or `null` where the scope is no account's or the reader's zone is not known. */
export function calendarSnapshotOf(input: SnapshotInput): CalendarSnapshot | null {
  const alerts = aheadSet(input.scope, input.alertsOn ? alertsAhead(input) : [], input.nowMs);
  const today = nowIn(input.nowMs, input.zone, input.zones);
  if (alerts === null || today === null) return null;
  const own = new Set(input.ownAddresses.map((a) => a.trim().toLowerCase()));
  const { year, month } = today.day;
  const firstOfMonth = plainDate(year, month, 1);
  const monthFrom = dayNumber(firstOfMonth);
  const monthTo = daysFromCivil(year, month, daysInMonth(year, month));
  const shownDays = Array.from({ length: SNAPSHOT_DAYS }, (_, i) => addDays(today.day, i));
  const lastDay = Math.max(monthTo, dayNumber(shownDays[SNAPSHOT_DAYS - 1]!));
  const { shown } = occurrencesIn({
    events: input.events,
    calendars: input.calendars,
    query: { from: firstOfMonth, to: addDays(firstOfMonth, lastDay - monthFrom) },
    zone: input.zone,
    zones: input.zones,
  });

  const listed: { first: number; last: number; event: SnapshotEvent }[] = [];
  for (const o of shown) {
    const { record } = o;
    if (record.status === "cancelled" || record.myAnswer === "declined") continue;
    const label = eventLabel(record, input.widgetTitles);
    const span = daySpanOf(o.occurrence, input.zone, input.zones);
    const startMs = startMsOf(o.occurrence.start, input.zone, input.zones);
    if (label === null || span === null || startMs === null) continue;
    // An end only where the event states one, a length or an end.
    const endMs =
      record.end !== null || record.duration !== null
        ? startMsOf(o.occurrence.end, input.zone, input.zones)
        : null;
    listed.push({
      first: dayNumberOf(span.first)!,
      last: dayNumberOf(span.last)!,
      event: {
        eventId: record.id,
        label,
        startMs,
        endMs: endMs !== null && endMs >= startMs ? endMs : null,
        allDay: span.allDay,
        toAnswer: waitsForAnswer(record, own),
      },
    });
  }

  // Each listed day: all day first, then by start.
  const days: SnapshotDay[] = shownDays.map((day) => {
    const n = dayNumber(day);
    const events = listed
      .filter((l) => l.first <= n && n <= l.last)
      .map((l) => l.event)
      .sort(
        (a, b) =>
          Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs || (a.eventId < b.eventId ? -1 : 1),
      );
    return {
      year: day.year,
      date: dateOf(day),
      events: events.slice(0, SNAPSHOT_DAY_EVENTS_MAX),
      more: Math.max(0, events.length - SNAPSHOT_DAY_EVENTS_MAX),
    };
  });

  const marked = new Set<number>();
  for (const l of listed)
    for (let n = Math.max(l.first, monthFrom); n <= Math.min(l.last, monthTo); n += 1)
      marked.add(n - monthFrom + 1);

  // Invitations the person still has to answer, from today to the snapshot's last day: one for each event.
  const todayN = dayNumber(today.day);
  const toAnswer = new Set(
    listed.filter((l) => l.last >= todayN && l.event.toAnswer).map((l) => l.event.eventId),
  ).size;

  return readCalendarSnapshot({
    v: CALENDAR_SNAPSHOT_VERSION,
    scope: alerts.scope,
    writtenAt: input.nowMs,
    zone: input.zone,
    alerts: alerts.alerts,
    days,
    month: { year, month, marked: [...marked].sort((a, b) => a - b) },
    toAnswer,
    summary: input.summaryOn ? summaryOf(input, shownDays, today.minutes, days, toAnswer) : null,
  });
}

/** The day's summary: at its minute today, or tomorrow where today's has come, with that day's events. */
function summaryOf(
  input: SnapshotInput,
  shownDays: readonly PlainDate[],
  nowMinutes: number,
  days: readonly SnapshotDay[],
  toAnswer: number,
): SnapshotSummary | null {
  const at =
    Number.isInteger(input.summaryAt) && input.summaryAt >= 0 && input.summaryAt <= 1439
      ? input.summaryAt
      : SUMMARY_AT_START;
  const which = at > nowMinutes ? 0 : 1;
  const day = shownDays[which]!;
  const atMs = resolveWall(
    wall(day.year, day.month, day.day, Math.floor(at / 60), at % 60),
    input.zone,
    input.zones,
  );
  if (atMs === null) return null;
  const listed = days[which]!;
  const timed = listed.events.filter((e) => !e.allDay);
  const first = timed.length === 0 ? null : noticeClockOf(timed[0]!.startMs, atMs, input.zone, input.zones);
  return { atMs, events: listed.events.length + listed.more, first, toAnswer };
}
