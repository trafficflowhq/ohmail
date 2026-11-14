/**
 * THE PHONE'S SNAPSHOT AS THE PAGE MAKES IT: the alerts this device rings, today and two more days, the month's marked
 * days, the invitations to answer and the day's summary, laid out on the reader's clock and read closed before it is
 * handed on. Zone rules are handed in.
 */
import { describe, expect, it } from "vitest";
import { intlZones } from "@ohmail/cal-core";
import { readCalendarSnapshot, type CalendarSnapshot } from "@ohmail/client-engine";
import type { EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type { CalendarEventRecord } from "@ohmail/wire";
import { calendarSnapshotOf, type SnapshotInput } from "../../src/calendar/alerts/index.js";
import { OWN, ZURICH, calendarOf, event, invitation } from "./invitations/fixtures.js";

const zones = intlZones();
/** Monday 16 November 2026, 09:00 in Zurich. */
const NOW = Date.UTC(2026, 10, 16, 8, 0);

const held = (record: CalendarEventRecord): EventWithWrites => ({
  record,
  waiting: null,
  refusal: null,
  refusedWriteId: null,
});
const zurich = (day: string, clock: string) => ({
  kind: "zoned" as const,
  value: `${day}T${clock}`,
  zone: ZURICH,
});
const wholeDay = (day: string, next: string) => ({
  start: { kind: "date" as const, value: day },
  end: { kind: "date" as const, value: next },
});

function snapshotOf(
  records: readonly CalendarEventRecord[],
  over: Partial<SnapshotInput> = {},
): CalendarSnapshot {
  const made = calendarSnapshotOf({
    events: records.map(held),
    calendars: [calendarOf()],
    zone: ZURICH,
    zones,
    nowMs: NOW,
    showTitles: true,
    acts: [],
    scope: "mb-1",
    alertsOn: true,
    widgetTitles: true,
    summaryOn: false,
    summaryAt: 420,
    ownAddresses: [OWN],
    ...over,
  });
  if (made === null) throw new Error("no snapshot was made");
  return made;
}
const listed = (s: CalendarSnapshot) =>
  s.days.map((d) => [d.date.dom, d.events.map((e) => e.eventId), d.more]);

describe("the phone's snapshot", () => {
  it("lays the days and the month out on the reader's clock: a whole day and a clock with no zone stay on their day", () => {
    const records = [
      event("zoned", "20261118"),
      event("evening", "20261118", {
        start: zurich("20261118", "200000"),
        end: zurich("20261118", "210000"),
      }),
      event("fair", "20261117", wholeDay("20261117", "20261118")),
      event("late", "20261118", {
        start: { kind: "floating", value: "20261118T233000" },
        end: null,
        duration: "PT20M",
      }),
      event("later", "20261127"),
    ];
    const here = snapshotOf(records);
    expect(listed(here)).toEqual([
      [16, [], 0],
      [17, ["fair"], 0],
      [18, ["zoned", "evening", "late"], 0],
    ]);
    expect(here.days.map((d) => d.date.dow)).toEqual([1, 2, 3]);
    expect(here.month).toEqual({ year: 2026, month: 11, marked: [17, 18, 27] });
    const tokyo = snapshotOf(records, { zone: "Asia/Tokyo" });
    // 20:00 in Zurich is 04:00 the next morning in Tokyo: off the three days, and marked on the 19th.
    expect(listed(tokyo)).toEqual([
      [16, [], 0],
      [17, ["fair"], 0],
      [18, ["zoned", "late"], 0],
    ]);
    expect(tokyo.month.marked).toEqual([17, 18, 19, 27]);
    expect(tokyo.zone).toBe("Asia/Tokyo");
  });

  it("a whole day starts at its own midnight on the nights the clocks change", () => {
    const s = snapshotOf([event("spring", "20260329", wholeDay("20260329", "20260330"))], {
      nowMs: Date.UTC(2026, 2, 28, 12, 0),
    });
    expect(s.days[1]!.events[0]).toMatchObject({
      eventId: "spring",
      allDay: true,
      startMs: Date.UTC(2026, 2, 28, 23, 0),
      endMs: Date.UTC(2026, 2, 29, 22, 0),
    });
  });

  it("a widget's label follows the widgets' switch, a private event is Busy, and the alerts keep the notices' switch", () => {
    const records = [
      event("lunch", "20261116", {
        start: zurich("20261116", "120000"),
        end: zurich("20261116", "130000"),
        title: "Lunch",
        alarms: [{ minutesBefore: 10, method: "notice" }],
      }),
      event("doctor", "20261117", { title: "Doctor", private: true }),
    ];
    const labels = (s: CalendarSnapshot) => [
      s.days[0]!.events[0]!.label,
      s.days[1]!.events[0]!.label,
      s.alerts[0]?.label,
    ];
    expect(labels(snapshotOf(records))).toEqual([
      { as: "title", text: "Lunch" },
      { as: "busy" },
      { as: "title", text: "Lunch" },
    ]);
    expect(labels(snapshotOf(records, { widgetTitles: false }))).toEqual([
      { as: "event" },
      { as: "busy" },
      { as: "title", text: "Lunch" },
    ]);
    expect(labels(snapshotOf(records, { showTitles: false }))).toEqual([
      { as: "title", text: "Lunch" },
      { as: "busy" },
      { as: "event" },
    ]);
  });

  it("replaces the details of retained invitations when the same calendar becomes busy-only", () => {
    const record = invitation("shared", "20261116", {
      title: "Planning meeting",
      place: "Room twelve",
      notes: "Discuss renewal",
      start: zurich("20261116", "100000"),
      end: zurich("20261116", "103000"),
      alarms: [{ minutesBefore: 10, method: "notice" }],
    });
    const ownBlock = event("private", "20261116", {
      calendarId: "personal",
      title: "Personal appointment",
      private: true,
    });
    const personal = { ...calendarOf(), id: "personal" };
    const calendars = [calendarOf(), personal];
    const before = snapshotOf([record, ownBlock], { calendars, summaryOn: true, summaryAt: 18 * 60 });
    expect(before.days[0]!.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: "shared",
          label: { as: "title", text: record.title },
          toAnswer: true,
        }),
      ]),
    );
    expect(before.summary?.toAnswer).toBe(1);

    const after = snapshotOf([record, ownBlock], {
      calendars: [{ ...calendars[0]!, access: "busy" }, personal],
      summaryOn: true,
      summaryAt: 18 * 60,
    });
    expect(after.scope).toBe(before.scope);
    expect(after.days[0]!.events).toEqual([
      expect.objectContaining({ eventId: "private", label: { as: "busy" }, toAnswer: false }),
      expect.objectContaining({
        eventId: "shared",
        label: { as: "busy" },
        toAnswer: false,
        startMs: Date.UTC(2026, 10, 16, 9),
        endMs: Date.UTC(2026, 10, 16, 9, 30),
      }),
    ]);
    expect(after.alerts).toEqual([]);
    expect(after.toAnswer).toBe(0);
    expect(after.summary?.toAnswer).toBe(0);
  });

  it("twenty events in a day: twelve listed, all day first, the rest counted", () => {
    const records = [
      ...Array.from({ length: 19 }, (_, i) =>
        event(`e${String(i).padStart(2, "0")}`, "20261117", {
          start: zurich(
            "20261117",
            `${String(8 + Math.floor(i / 2)).padStart(2, "0")}${i % 2 === 0 ? "00" : "30"}00`,
          ),
          end: null,
          duration: "PT15M",
        }),
      ),
      event("all-day", "20261117", wholeDay("20261117", "20261118")),
    ];
    const [, day] = snapshotOf(records).days;
    expect(day!.events).toHaveLength(12);
    expect(day!.more).toBe(8);
    expect(day!.events.map((e) => e.eventId)).toEqual(["all-day", ...records.slice(0, 11).map((r) => r.id)]);
  });

  it("no alerts while this device does not ring them; nothing called off or declined is listed; invitations to answer are counted", () => {
    const records = [
      event("standup", "20261116", {
        start: zurich("20261116", "100000"),
        end: zurich("20261116", "103000"),
        alarms: [{ minutesBefore: 10, method: "notice" }],
      }),
      event("off", "20261116", { status: "cancelled" }),
      invitation("no", "20261117", { myAnswer: "declined" }),
      invitation("waits", "20261117"),
      invitation("later", "20261209"),
      invitation("held", "20261117", { heldBack: true }),
      event("mine", "20261117", { organizer: { address: OWN, name: null }, myAnswer: "none" }),
    ];
    const on = snapshotOf(records);
    expect(on.alerts.map((a) => a.eventId)).toEqual(["standup"]);
    expect(snapshotOf(records, { alertsOn: false }).alerts).toEqual([]);
    expect(listed(on)).toEqual([
      [16, ["standup"], 0],
      [17, ["mine", "waits"], 0],
      [18, [], 0],
    ]);
    expect(on.days[1]!.events.map((e) => e.toAnswer)).toEqual([false, true]);
    // The month's: one waits on the 17th; the one in December lies past the snapshot's last day.
    expect(on.toAnswer).toBe(1);
  });

  it("the day's summary: none while it is off; else at its minute today, or tomorrow once today's has come", () => {
    const records = [
      event("standup", "20261117", {
        start: zurich("20261117", "093000"),
        end: zurich("20261117", "100000"),
      }),
      event("fair", "20261117", wholeDay("20261117", "20261118")),
      invitation("waits", "20261118"),
    ];
    expect(snapshotOf(records).summary).toBeNull();
    expect(snapshotOf(records, { summaryOn: true }).summary).toEqual({
      atMs: Date.UTC(2026, 10, 17, 6, 0),
      events: 2,
      first: { hour: 9, minute: 30, day: "today" },
      toAnswer: 1,
    });
    expect(snapshotOf(records, { summaryOn: true, summaryAt: 18 * 60 }).summary).toMatchObject({
      atMs: Date.UTC(2026, 10, 16, 17, 0),
      events: 0,
      first: null,
    });
  });

  it("none for a scope that is no account's, and the record it answers reads closed again as it is", () => {
    expect(
      calendarSnapshotOf({
        events: [],
        calendars: [],
        zone: ZURICH,
        zones,
        nowMs: NOW,
        showTitles: true,
        acts: [],
        scope: "demo:fixtures",
        alertsOn: true,
        widgetTitles: true,
        summaryOn: true,
        summaryAt: 420,
        ownAddresses: [],
      }),
    ).toBeNull();
    const s = snapshotOf(
      [
        event("standup", "20261116", {
          title: "Standup‮",
          alarms: [{ minutesBefore: 10, method: "notice" }],
        }),
      ],
      { summaryOn: true },
    );
    expect(readCalendarSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(s.days[0]!.events[0]!.label).toEqual({ as: "title", text: "Standup" });
  });
});
