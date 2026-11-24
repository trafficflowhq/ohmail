/**
 * THE DEVICE'S RECORDS AS SERIES, AND A SPAN'S OCCURRENCES: a changed day drawn once in its new place, a cancelled day
 * not at all, the stored key never worked out again, an invitation not yet shown and a hidden calendar left out, and
 * the edge of what the device holds measured against what it holds.
 */
import { describe, expect, it } from "vitest";
import { intlZones, type PlainDate } from "@ohmail/cal-core";
import type { EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type { CalendarEventRecord, CalendarRecord } from "@ohmail/wire";
import { edgeOf, keyTimeOf, occurrencesIn } from "../../src/calendar/index.js";

const zones = intlZones();
const ZURICH = "Europe/Zurich";
const UPDATED = "2026-11-01T08:00:00.000Z";
const day = (iso: string): PlainDate => {
  const [year, month, d] = iso.split("-").map(Number) as [number, number, number];
  return { kind: "date", year, month, day: d };
};
/** The key our server stores for a Monday at nine in Zurich: the moment, in milliseconds. */
const mondayAtNine = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return String(Date.UTC(y, m - 1, d, 8, 0, 0));
};

function calendar(id: string, over: Partial<CalendarRecord> = {}): CalendarRecord {
  return {
    id,
    connectionId: "conn-1",
    name: "Studio",
    color: "#3366cc",
    access: "owner",
    shown: true,
    timeZone: ZURICH,
    window: null,
    defaultAlarms: [],
    lastSyncedAt: null,
    errorCode: null,
    updatedAt: UPDATED,
    ...over,
  };
}
function event(id: string, over: Partial<CalendarEventRecord> = {}): CalendarEventRecord {
  return {
    id,
    calendarId: "cal-1",
    uid: "standup@studio.test",
    recurrenceId: "",
    thisAndFuture: false,
    sequence: 0,
    status: "confirmed",
    title: "Standup",
    notes: null,
    place: null,
    callLink: null,
    start: { kind: "zoned", value: "20261102T090000", zone: ZURICH },
    end: { kind: "zoned", value: "20261102T093000", zone: ZURICH },
    duration: null,
    startsAt: "2026-11-02T08:00:00.000Z",
    endsAt: "2026-11-23T08:30:00.000Z",
    occurrenceAt: null,
    repeat: { rules: ["FREQ=WEEKLY;COUNT=4"], excluded: [], added: [] },
    busy: true,
    private: false,
    organizer: null,
    myAnswer: null,
    heldBack: false,
    invitees: [],
    alarms: [],
    cut: false,
    writes: [],
    updatedAt: UPDATED,
    ...over,
  };
}
const held = (r: CalendarEventRecord): EventWithWrites => ({
  record: r,
  waiting: null,
  refusal: null,
  refusedWriteId: null,
});

/** The weekly standup: the third Monday moved to Tuesday at ten, the fourth cancelled. */
const SERIES = [
  event("standup"),
  event("standup-moved", {
    recurrenceId: mondayAtNine("2026-11-16"),
    repeat: null,
    start: { kind: "zoned", value: "20261117T100000", zone: ZURICH },
    end: { kind: "zoned", value: "20261117T103000", zone: ZURICH },
    title: "Standup, moved",
  }),
  event("standup-off", { recurrenceId: mondayAtNine("2026-11-23"), repeat: null, status: "cancelled" }),
];
const NOVEMBER = { from: day("2026-11-01"), to: day("2026-11-30") };

const daysOf = (events: readonly CalendarEventRecord[], calendars = [calendar("cal-1")]) =>
  occurrencesIn({ events: events.map(held), calendars, query: NOVEMBER, zone: ZURICH, zones }).shown.map(
    (o) => [o.day, o.record.title, o.key !== null] as const,
  );

describe("a series as the device holds it", () => {
  it("draws a changed day once, in its new place, and a cancelled day not at all", () => {
    expect(daysOf(SERIES)).toEqual([
      ["2026-11-02", "Standup", true],
      ["2026-11-09", "Standup", true],
      ["2026-11-17", "Standup, moved", true],
    ]);
  });

  it("names each day of the series by the key our server stored", () => {
    const shown = occurrencesIn({
      events: SERIES.map(held),
      calendars: [calendar("cal-1")],
      query: NOVEMBER,
      zone: ZURICH,
      zones,
    }).shown;
    expect(shown[2]!.key).toBe(mondayAtNine("2026-11-16"));
    expect(shown[2]!.series?.id).toBe("standup");
  });

  it("draws an answer to one day on that day alone, waiting or refused, and the other days as the series stands", () => {
    const at = mondayAtNine("2026-11-09");
    const series = event("standup", { myAnswer: "none" });
    const day = (answers: EventWithWrites["answers"]) =>
      occurrencesIn({
        events: [{ ...held(series), answers }],
        calendars: [calendar("cal-1")],
        query: NOVEMBER,
        zone: ZURICH,
        zones,
      }).shown.map((o) => [o.key === at, o.record.myAnswer, o.writes.waiting, o.writes.refusal] as const);
    expect(
      day([{ at, answer: "tentative", waiting: "provider", refusal: null, refusedWriteId: null }]),
    ).toEqual([
      [false, "none", null, null],
      [true, "tentative", "provider", null],
      [false, "none", null, null],
      [false, "none", null, null],
    ]);
    expect(
      day([{ at, answer: null, waiting: null, refusal: "version_stale", refusedWriteId: "w-1" }]),
    ).toEqual([
      [false, "none", null, null],
      [true, "none", null, "version_stale"],
      [false, "none", null, null],
      [false, "none", null, null],
    ]);
  });

  it("draws an event that does not repeat once, with no key", () => {
    const single = event("dentist", { uid: "dentist@studio.test", repeat: null, title: "Dentist" });
    expect(daysOf([single])).toEqual([["2026-11-02", "Dentist", false]]);
  });

  it("leaves out an invitation not yet shown and a calendar that is hidden", () => {
    expect(daysOf([event("held", { heldBack: true, repeat: null })])).toEqual([]);
    expect(daysOf(SERIES, [calendar("cal-1", { shown: false })])).toEqual([]);
  });

  it("keeps an event in a zone the device does not know, on the day its own clock writes, so a view can say it", () => {
    const outlook = (dayStamp: string) =>
      event(`outlook-${dayStamp}`, {
        uid: `outlook-${dayStamp}@studio.test`,
        repeat: null,
        title: `Supplier call ${dayStamp}`,
        start: { kind: "zoned", value: `${dayStamp}T090000`, zone: "Customized Time Zone" },
        end: { kind: "zoned", value: `${dayStamp}T100000`, zone: "Customized Time Zone" },
      });
    expect(daysOf([outlook("20261118")])).toEqual([["2026-11-18", "Supplier call 20261118", false]]);
    // Written on the day after the span: it is no day of this span, so no view of it counts it.
    expect(daysOf([outlook("20261201")])).toEqual([]);
  });

  it("keeps an event at half past midnight on the span's first day for a reader far east of UTC", () => {
    const AUCKLAND = "Pacific/Auckland";
    const early = event("early", {
      uid: "early@studio.test",
      repeat: null,
      title: "Early ferry",
      start: { kind: "zoned", value: "20261101T003000", zone: AUCKLAND },
      end: { kind: "zoned", value: "20261101T013000", zone: AUCKLAND },
    });
    const shown = occurrencesIn({
      events: [held(early)],
      calendars: [calendar("cal-1")],
      query: NOVEMBER,
      zone: AUCKLAND,
      zones,
    }).shown;
    expect(shown.map((o) => [o.day, o.record.title])).toEqual([["2026-11-01", "Early ferry"]]);
  });

  it("says the expansion stopped at its ceiling, never a short list as whole", () => {
    const busy = event("every-minute", { repeat: { rules: ["FREQ=MINUTELY"], excluded: [], added: [] } });
    const found = occurrencesIn({
      events: [held(busy)],
      calendars: [calendar("cal-1")],
      query: NOVEMBER,
      zone: ZURICH,
      zones,
    });
    expect(found.capped).toBe(true);
    expect(found.stoppedBy.length).toBeGreaterThan(0);
  });
});

describe("a stored key read back", () => {
  it("is a moment for a timed series, a day for a series of whole days, and a clock time where no moment was said", () => {
    const nine = Date.UTC(2026, 10, 16, 8);
    expect(keyTimeOf(String(nine), { kind: "instant", epochMs: 0 })).toEqual({
      kind: "instant",
      epochMs: nine,
    });
    expect(keyTimeOf(String(Date.UTC(2026, 10, 16)), day("2026-11-02"))).toEqual(day("2026-11-16"));
    expect(keyTimeOf("Europe/Zurich|20260329T0230|false", null)).toEqual({
      kind: "zoned",
      tzid: ZURICH,
      wall: { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 },
    });
    expect(keyTimeOf("|20261116T0900|false", null)).toMatchObject({ kind: "floating" });
    expect(keyTimeOf("not a key", null)).toBeNull();
  });
});

describe("the edge of what this device holds", () => {
  const today = day("2026-11-16");
  const window = { daysBack: 30, daysAhead: 365, maxRows: 5000 };

  it("is offered where the span starts before the served window", () => {
    expect(edgeOf({ from: day("2026-10-01"), to: day("2026-10-31") }, { window, loaded: [] }, today)).toEqual(
      { earlier: "2026-10-17", later: null },
    );
    expect(edgeOf({ from: day("2026-11-01"), to: day("2026-11-30") }, { window, loaded: [] }, today)).toEqual(
      { earlier: null, later: null },
    );
  });

  it("is said where the span ends after the served window's last day", () => {
    // 365 days ahead of 16 November 2026: the last day held is 16 November 2027.
    expect(edgeOf({ from: day("2027-11-01"), to: day("2027-11-30") }, { window, loaded: [] }, today)).toEqual(
      { earlier: null, later: "2027-11-16" },
    );
    expect(edgeOf({ from: day("2027-11-10"), to: day("2027-11-16") }, { window, loaded: [] }, today)).toEqual(
      { earlier: null, later: null },
    );
  });

  it("moves back with a span loaded on purpose that reaches the window", () => {
    const loaded = [{ fromMs: Date.UTC(2026, 8, 1), toMs: Date.UTC(2026, 9, 17) }];
    expect(edgeOf({ from: day("2026-10-01"), to: day("2026-10-31") }, { window, loaded }, today)).toEqual({
      earlier: null,
      later: null,
    });
    expect(edgeOf({ from: day("2026-08-01"), to: day("2026-08-31") }, { window, loaded }, today)).toEqual({
      earlier: "2026-09-01",
      later: null,
    });
  });
});

it.each([
  ["occurrence", ["2026-11-02", "2026-11-17"]],
  ["following", ["2026-11-02"]],
] as const)(
  "hides only the dates under a pending %s deletion and restores them on Undo",
  (kind, remaining) => {
    const at = mondayAtNine("2026-11-09");
    const rows = SERIES.map(held);
    const list = (events: readonly EventWithWrites[]) =>
      occurrencesIn({
        events,
        calendars: [calendar("cal-1")],
        query: NOVEMBER,
        zone: ZURICH,
        zones,
      }).shown.map(({ day }) => day);
    expect(list([{ ...rows[0]!, removals: [{ kind, at }] }, ...rows.slice(1)])).toEqual(remaining);
    expect(list(rows)).toEqual(["2026-11-02", "2026-11-09", "2026-11-17"]);
  },
);
