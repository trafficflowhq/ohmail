/**
 * WHAT A SHELL HANDS THE NOTICES' CALLER OF ITS CALENDAR: the alerts the calendar wants for an account, as the set a
 * surface is handed, and a start on the reader's clock. Every source is read at the moment it is asked, so an alarm
 * added elsewhere, a title switch pressed and a zone travelled to all count at the next settle. A shell with no
 * calendar hands the caller `none` instead.
 */
import type { ZoneSource } from "@ohmail/cal-core";
import { aheadSet, type NoticeAct } from "@ohmail/client-engine";
import type { EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type { CalendarRecord, CalendarSuggestionRecord } from "@ohmail/wire";
import type { CalendarReads } from "../../notices/use-notices.js";
import { mayOffer } from "../found/gate.js";
import { calendarLookOf, calendarSampleOf } from "./sample.js";
import { calendarSnapshotOf } from "./snapshot.js";
import { alertsAhead, noticeClockOf } from "./ahead.js";

/** Where the reads come from: the calendar's port and store, the reader's zone, the person's one title switch. */
export interface CalendarReadsSource {
  liveScope(): string | null;
  ownAddresses(): readonly string[] | null;
  suggestions(): readonly CalendarSuggestionRecord[];
  /** The presented calendar (`port.events()`). */
  events(): readonly EventWithWrites[];
  calendars(): readonly CalendarRecord[];
  /** The reader's zone, by its name. */
  zone(): string;
  readonly zones: ZoneSource;
  /** "Show titles in notifications", as the one reader of this device's choices says it now. */
  showTitles(): boolean;
  /** The acts the surface's notices carry. */
  readonly acts: readonly NoticeAct[];
}

export function calendarReadsOf(source: CalendarReadsSource): CalendarReads {
  return {
    liveScope: source.liveScope,
    changes(previous, nowMs) {
      const ownAddresses = source.ownAddresses();
      if (ownAddresses === null) return null;
      // A calendar can lose detail access while its old event records are still in the mirror.
      const calendars = source.calendars().filter((calendar) => calendar.shown && calendar.access !== "busy");
      const detailed = new Set(calendars.map((calendar) => calendar.id));
      const input = {
        events: source.events().filter(({ record }) => detailed.has(record.calendarId)),
        calendars,
        ownAddresses,
        suggestions: source.suggestions().filter(mayOffer),
        zone: source.zone(),
        zones: source.zones,
      };
      return { sample: calendarSampleOf(input, previous), look: calendarLookOf({ ...input, nowMs }) };
    },
    ahead: (scope, nowMs) =>
      aheadSet(
        scope,
        alertsAhead({
          events: source.events(),
          calendars: source.calendars(),
          zone: source.zone(),
          zones: source.zones,
          nowMs,
          showTitles: source.showTitles(),
          acts: source.acts,
        }),
        nowMs,
      ),
    summary: (scope, nowMs, summaryAt) => {
      const zone = source.zone();
      const copy = calendarSnapshotOf({
        scope,
        nowMs,
        zone,
        zones: source.zones,
        ownAddresses: source.ownAddresses() ?? [],
        events: source.events(),
        calendars: source.calendars(),
        acts: [],
        alertsOn: false,
        showTitles: false,
        widgetTitles: false,
        summaryOn: true,
        summaryAt,
        summaryTitles: source.showTitles(),
      });
      return copy?.summary ? { summary: copy.summary, zone } : null;
    },
    clock: (startMs, nowMs) => noticeClockOf(startMs, nowMs, source.zone(), source.zones),
  };
}
