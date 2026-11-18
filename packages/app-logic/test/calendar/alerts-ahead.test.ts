/**
 * THE CALENDAR'S ALERTS AS THE PAGE MAKES THEM: one alert per occurrence and per alarm the ringing rule lets ring,
 * at the start less the lead, on the reader's clock where the start has no zone of its own. The zone rules are
 * handed in, never read from the platform's clock; what a surface is handed is the set `aheadSet` makes of them.
 */
import { describe, expect, it } from "vitest";
import { intlZones } from "@ohmail/cal-core";
import { AHEAD_DAYS, aheadSet, type NoticeAct, type NoticeAhead } from "@ohmail/client-engine";
import { eventsWithWrites, type EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type { CalendarAlarm, CalendarEventRecord, CalendarRecord } from "@ohmail/wire";
import {
  alertsAhead,
  calendarReadsOf,
  noticeClockOf,
  type AheadInput,
} from "../../src/calendar/alerts/index.js";
import { ZURICH, calendarOf, event, invitation } from "./invitations/fixtures.js";

const zones = intlZones();
const TOKYO = "Asia/Tokyo";
const MIN = 60_000;
const DAY = 86_400_000;
/** Sunday 15 November 2026, 13:00 in Zurich. */
const NOW = Date.UTC(2026, 10, 15, 12, 0);
const SCOPE = "mb-1";
const BOTH: readonly NoticeAct[] = ["join", "again"];

const notice = (...minutes: number[]): CalendarAlarm[] =>
  minutes.map((minutesBefore) => ({ minutesBefore, method: "notice" }));
const held = (record: CalendarEventRecord): EventWithWrites => ({
  record,
  waiting: null,
  refusal: null,
  refusedWriteId: null,
});
/** A time in Zurich on a day (`YYYYMMDD`), as the store keeps it. */
const zurich = (day: string, clock = "090000") => ({
  kind: "zoned" as const,
  value: `${day}T${clock}`,
  zone: ZURICH,
});
const onDay = (day: string) => ({ kind: "date" as const, value: day });

function ahead(records: readonly CalendarEventRecord[], over: Partial<AheadInput> = {}): NoticeAhead[] {
  return alertsAhead({
    events: records.map(held),
    calendars: [calendarOf()],
    zone: ZURICH,
    zones,
    nowMs: NOW,
    showTitles: true,
    acts: BOTH,
    ...over,
  });
}
/** What a surface is handed: the set of those alerts. */
const handed = (alerts: readonly NoticeAhead[], nowMs = NOW): readonly NoticeAhead[] =>
  aheadSet(SCOPE, alerts, nowMs)?.alerts ?? [];

describe("the alerts the calendar wants ahead", () => {
  it("a timed event with alarms of 10 and 0 minutes: two alerts at the start less each lead", () => {
    const alerts = handed(ahead([event("standup", "20261116", { alarms: notice(10, 0) })]));
    const start = Date.UTC(2026, 10, 16, 8, 0); // 09:00 in Zurich
    expect(alerts.map((a) => [a.atMs, a.startMs, a.leadMin, a.allDay])).toEqual([
      [start - 10 * MIN, start, 10, false],
      [start, start, 0, false],
    ]);
    expect(new Set(alerts.map((a) => a.id)).size).toBe(2);
    expect(alerts.every((a) => a.eventId === "standup")).toBe(true);
  });

  it("a whole day in Zurich with an alarm of 900 minutes starts at that day's midnight and rings 09:00 the day before", () => {
    const [alert] = ahead([
      event("fair", "20261118", { start: onDay("20261118"), end: onDay("20261119"), alarms: notice(900) }),
    ]);
    expect(alert).toMatchObject({ startMs: Date.UTC(2026, 10, 17, 23, 0), allDay: true, leadMin: 900 });
    expect(alert!.atMs).toBe(Date.UTC(2026, 10, 17, 8, 0)); // 09:00 on the 17th in Zurich
  });

  it("a reader in Tokyo: a time in a zone keeps its moment; a whole day and a clock with no zone move with the reader", () => {
    const records = [
      event("zoned", "20261118", { alarms: notice(0) }),
      event("day", "20261118", { start: onDay("20261118"), end: onDay("20261119"), alarms: notice(0) }),
      event("floating", "20261118", {
        start: { kind: "floating", value: "20261118T090000" },
        end: { kind: "floating", value: "20261118T093000" },
        alarms: notice(0),
      }),
    ];
    const startOf = (alerts: readonly NoticeAhead[], id: string) =>
      alerts.find((a) => a.eventId === id)!.startMs;
    const here = ahead(records);
    const there = ahead(records, { zone: TOKYO });
    expect(startOf(there, "zoned")).toBe(startOf(here, "zoned"));
    expect(startOf(here, "day")).toBe(Date.UTC(2026, 10, 17, 23, 0));
    expect(startOf(there, "day")).toBe(Date.UTC(2026, 10, 17, 15, 0));
    expect(startOf(here, "floating")).toBe(Date.UTC(2026, 10, 18, 8, 0));
    expect(startOf(there, "floating")).toBe(Date.UTC(2026, 10, 18, 0, 0));
  });

  it("on the nights the clocks change a whole day starts at its own real midnight: days of 23 and of 25 hours", () => {
    /** Whole days, each `[day, the day after]`, with an alarm at their start. */
    const wholeDays = (days: readonly [string, string][], nowMs: number) =>
      handed(
        ahead(
          days.map(([day, next]) =>
            event(`d${day}`, day, { start: onDay(day), end: onDay(next), alarms: notice(0) }),
          ),
          { nowMs },
        ),
        nowMs,
      ).map((a) => a.startMs);
    const spring = wholeDays(
      [
        ["20260329", "20260330"],
        ["20260330", "20260331"],
      ],
      Date.UTC(2026, 2, 28, 22, 0),
    );
    expect(spring).toEqual([Date.UTC(2026, 2, 28, 23, 0), Date.UTC(2026, 2, 29, 22, 0)]);
    expect(spring[1]! - spring[0]!).toBe(23 * 60 * MIN);
    const autumn = wholeDays(
      [
        ["20261025", "20261026"],
        ["20261026", "20261027"],
      ],
      Date.UTC(2026, 9, 24, 21, 0),
    );
    expect(autumn).toEqual([Date.UTC(2026, 9, 24, 22, 0), Date.UTC(2026, 9, 25, 23, 0)]);
    expect(autumn[1]! - autumn[0]!).toBe(25 * 60 * MIN);
  });

  it("a weekly series: the next day rings, the day left out does not, a changed day rings at its own time by its own alarms", () => {
    const series = event("weekly", "20261102", {
      repeat: { rules: ["FREQ=WEEKLY"], excluded: [zurich("20261123")], added: [] },
      endsAt: null,
      alarms: notice(10, 2880),
    });
    const changed = event("weekly-30", "20261130", {
      uid: series.uid,
      recurrenceId: String(Date.UTC(2026, 10, 30, 8, 0)),
      start: zurich("20261130", "103000"),
      end: zurich("20261130", "110000"),
      alarms: notice(10_080),
    });
    const alerts = handed(ahead([series, changed]));
    expect(alerts.map((a) => [a.eventId, a.startMs, a.leadMin])).toEqual([
      ["weekly", Date.UTC(2026, 10, 16, 8, 0), 10],
      ["weekly-30", Date.UTC(2026, 10, 30, 9, 30), 10_080],
    ]);
  });

  it("a series whose next day is inside the window and the one after it outside: exactly the one inside", () => {
    const series = event("weekly", "20261102", {
      repeat: { rules: ["FREQ=WEEKLY"], excluded: [], added: [] },
      endsAt: null,
      alarms: notice(10),
    });
    const nowMs = Date.UTC(2026, 10, 16, 9, 0);
    const alerts = handed(ahead([series], { nowMs }), nowMs);
    expect(alerts.map((a) => a.startMs)).toEqual([Date.UTC(2026, 10, 23, 8, 0)]);
  });

  it("an alarm whose minute passed 119 seconds ago is still handed on; one 121 seconds ago is not", () => {
    const at = (id: string, secondsAgo: number) => {
      const start = new Date(NOW - secondsAgo * 1000 + 10 * MIN).toISOString().replace(/[-:]|\.\d{3}/g, "");
      return event(id, "20261115", {
        start: { kind: "instant", value: start },
        end: null,
        duration: "PT30M",
        alarms: notice(10),
      });
    };
    const alerts = handed(ahead([at("late", 119), at("too-late", 121)]));
    expect(alerts.map((a) => [a.eventId, NOW - a.atMs])).toEqual([["late", 119_000]]);
  });

  it("the window's far edge: an alert eight days ahead exactly is handed on, one a millisecond further is not", () => {
    const records = [event("edge", "20261123", { alarms: notice(0) })];
    const atMs = Date.UTC(2026, 10, 23, 8, 0);
    const exactly = atMs - AHEAD_DAYS * DAY;
    expect(handed(ahead(records, { nowMs: exactly }), exactly).map((a) => a.atMs)).toEqual([atMs]);
    expect(handed(ahead(records, { nowMs: exactly - 1 }), exactly - 1)).toEqual([]);
  });

  const silent: readonly [string, Partial<CalendarEventRecord>, (readonly CalendarRecord[])?][] = [
    ["declined", { myAnswer: "declined", organizer: { address: "marco@elsewhere.test", name: "Marco" } }],
    ["cancelled", { status: "cancelled" }],
    ["held back", { heldBack: true }],
    ["on a calendar that is not shown", {}, [calendarOf({ shown: false })]],
    ["on a calendar the device does not hold", { calendarId: "cal-gone" }],
    ["an alarm that is a letter", { alarms: [{ minutesBefore: 10, method: "mail" }] }],
    ["a lead beyond four weeks", { alarms: notice(40_321) }],
  ];
  for (const [what, over, calendars] of silent) {
    it(`no alert for an event ${what}`, () => {
      const records = [event("quiet", "20261116", { alarms: notice(10), ...over })];
      expect(ahead(records, calendars === undefined ? {} : { calendars })).toEqual([]);
    });
  }

  it("a private event is Busy whatever the switch; with titles hidden an event is Event; else its title", () => {
    const [mine] = ahead([event("lunch", "20261116", { title: "Lunch with Jo", alarms: notice(10) })]);
    const [kept] = ahead([
      event("doctor", "20261116", { title: "Doctor", private: true, alarms: notice(10) }),
    ]);
    const [hidden] = ahead([event("lunch", "20261116", { title: "Lunch with Jo", alarms: notice(10) })], {
      showTitles: false,
    });
    expect([mine!.label, kept!.label, hidden!.label]).toEqual([
      { as: "title", text: "Lunch with Jo" },
      { as: "busy" },
      { as: "event" },
    ]);
  });

  it("an invitation the person answered yes to rings, with Join only where it has a call", () => {
    const [plain] = ahead([invitation("crit", "20261116", { myAnswer: "accepted", alarms: notice(10) })]);
    const [call] = ahead([
      invitation("crit", "20261116", {
        myAnswer: "accepted",
        alarms: notice(10),
        callLink: "https://calls.example/x",
      }),
    ]);
    expect(plain!.acts).toEqual(["again"]);
    expect(call!.acts).toEqual(["join", "again"]);
  });

  it("an event a write of the person's moved, still waiting, rings at the moved time and not the provider's", () => {
    const record = event("moved", "20261116", { alarms: notice(10) });
    const events = eventsWithWrites(
      [record],
      [
        {
          key: "k-1",
          act: {
            kind: "calendar_event_update",
            eventId: "moved",
            base: record.updatedAt,
            scope: { kind: "record" },
            change: { start: zurich("20261117", "140000"), end: zurich("20261117", "150000") },
          },
        },
      ],
    );
    const alerts = alertsAhead({
      events,
      calendars: [calendarOf()],
      zone: ZURICH,
      zones,
      nowMs: NOW,
      showTitles: true,
      acts: BOTH,
    });
    expect(alerts.map((a) => a.startMs)).toEqual([Date.UTC(2026, 10, 17, 13, 0)]);
  });

  it("seventy alarms due: a surface is handed sixty-four, the nearest", () => {
    /** Seventy starts on Monday, five minutes apart within each hour from 10:00 to 16:45. */
    const clock = (i: number) =>
      `${String(10 + Math.floor(i / 10)).padStart(2, "0")}${String((i % 10) * 5).padStart(2, "0")}00`;
    const records = Array.from({ length: 70 }, (_, i) =>
      event(`e${i}`, "20261116", {
        start: zurich("20261116", clock(i)),
        end: null,
        duration: "PT5M",
        alarms: notice(0),
      }),
    );
    const alerts = handed(ahead(records));
    expect(alerts).toHaveLength(64);
    expect(alerts.map((a) => a.eventId)).toEqual(records.slice(0, 64).map((r) => r.id));
  });

  it("a start in a zone this device does not know makes no alert, and nothing is thrown", () => {
    const record = event("far", "20261116", {
      start: { kind: "zoned", value: "20261116T090000", zone: "Mars/Olympus" },
      end: { kind: "zoned", value: "20261116T093000", zone: "Mars/Olympus" },
      alarms: notice(10),
    });
    expect(ahead([record])).toEqual([]);
  });
});

describe("a notice's clock: the start on the reader's clock, today and tomorrow by the reader's days", () => {
  /** 09:00 on Monday 16 November in Zurich. */
  const now = Date.UTC(2026, 10, 16, 8, 0);
  const rows: readonly [string, number, number, string, unknown][] = [
    ["later today", Date.UTC(2026, 10, 16, 13, 0), now, ZURICH, { hour: 14, minute: 0, day: "today" }],
    ["tomorrow", Date.UTC(2026, 10, 17, 8, 30), now, ZURICH, { hour: 9, minute: 30, day: "tomorrow" }],
    [
      "a later day, Sunday counted as 0",
      Date.UTC(2026, 10, 22, 18, 5),
      now,
      ZURICH,
      { hour: 19, minute: 5, day: { month: 11, dom: 22, dow: 0 } },
    ],
    [
      "a Friday",
      Date.UTC(2026, 10, 20, 18, 0),
      now,
      ZURICH,
      { hour: 19, minute: 0, day: { month: 11, dom: 20, dow: 5 } },
    ],
    [
      "ten minutes past midnight, read at ten to: tomorrow",
      Date.UTC(2026, 10, 16, 23, 10),
      Date.UTC(2026, 10, 16, 22, 50),
      ZURICH,
      { hour: 0, minute: 10, day: "tomorrow" },
    ],
    [
      "five to midnight, read at ten to: today",
      Date.UTC(2026, 10, 16, 22, 55),
      Date.UTC(2026, 10, 16, 22, 50),
      ZURICH,
      { hour: 23, minute: 55, day: "today" },
    ],
    [
      "the same moment read in Tokyo",
      Date.UTC(2026, 10, 16, 13, 0),
      now,
      TOKYO,
      { hour: 22, minute: 0, day: "today" },
    ],
    [
      "an evening in Zurich is the next morning in Tokyo",
      Date.UTC(2026, 10, 16, 18, 0),
      now,
      TOKYO,
      { hour: 3, minute: 0, day: "tomorrow" },
    ],
  ];
  for (const [what, startMs, nowMs, zone, clock] of rows) {
    it(what, () => {
      expect(noticeClockOf(startMs, nowMs, zone, zones)).toEqual(clock);
    });
  }

  it("a zone this device does not know says no clock", () => {
    expect(noticeClockOf(now, now, "Mars/Olympus", zones)).toBeNull();
  });
});

describe("the reads a shell hands the notices' caller", () => {
  it("each source is read when asked: an alarm added, a title switch pressed, a zone travelled to all count", () => {
    let records = [event("standup", "20261116")];
    let showTitles = true;
    let zone = ZURICH;
    const reads = calendarReadsOf({
      liveScope: () => SCOPE,
      ownAddresses: () => [],
      suggestions: () => [],
      events: () => records.map(held),
      calendars: () => [calendarOf()],
      zone: () => zone,
      zones,
      showTitles: () => showTitles,
      acts: BOTH,
    });
    expect(reads.ahead(SCOPE, NOW)).toEqual({ scope: SCOPE, alerts: [] });
    records = [event("standup", "20261116", { alarms: notice(10) })];
    expect(reads.ahead(SCOPE, NOW)?.alerts.map((a) => [a.eventId, a.label])).toEqual([
      ["standup", { as: "title", text: "standup" }],
    ]);
    showTitles = false;
    expect(reads.ahead(SCOPE, NOW)?.alerts[0]?.label).toEqual({ as: "event" });
    const start = Date.UTC(2026, 10, 16, 8, 0);
    expect(reads.clock(start, NOW)).toEqual({ hour: 9, minute: 0, day: "tomorrow" });
    zone = TOKYO;
    expect(reads.clock(start, NOW)).toEqual({ hour: 17, minute: 0, day: "tomorrow" });
  });

  it("a scope that is no account's is handed nothing to ring", () => {
    const reads = calendarReadsOf({
      liveScope: () => SCOPE,
      ownAddresses: () => [],
      suggestions: () => [],
      events: () => [held(event("standup", "20261116", { alarms: notice(10) }))],
      calendars: () => [calendarOf()],
      zone: () => ZURICH,
      zones,
      showTitles: () => true,
      acts: [],
    });
    expect(reads.ahead("demo:fixtures", NOW)).toBeNull();
    expect(reads.ahead(SCOPE, NOW)?.alerts[0]?.acts).toEqual([]);
  });
});
