import { describe, expect, it } from "vitest";
import { instant, intlZones, plainDate, wall, zoned, type EventTime } from "@ohmail/cal-core";
import {
  daySpanOf,
  monthWeeks,
  monthOfDay,
  shiftMonth,
  type MonthQuery,
} from "../../../src/calendar/spans/index.js";

const zones = intlZones();
const ZONE = "Europe/Zurich";
const at = (y: number, mo: number, d: number, h = 0, mi = 0): EventTime => zoned(wall(y, mo, d, h, mi), ZONE);
const item = (id: string, start: EventTime, end: EventTime) => ({ id, start, end });
const base = (
  items: readonly ReturnType<typeof item>[],
  more: Partial<MonthQuery<ReturnType<typeof item>>> = {},
) =>
  monthWeeks({
    month: "2026-11",
    weekStart: 0,
    today: "2026-11-16",
    picked: null,
    zone: ZONE,
    zones,
    weekNumbers: false,
    items,
    keyOf: (x) => x.id,
    open: null,
    ...more,
  });

describe("a moment's days in the reader's zone", () => {
  it("a whole day ends before its exclusive end", () => {
    expect(daySpanOf(item("a", plainDate(2026, 11, 2), plainDate(2026, 11, 5)), ZONE, zones)).toMatchObject({
      first: "2026-11-02",
      last: "2026-11-04",
      allDay: true,
      startMinute: null,
    });
  });
  it("a timed event that ends at midnight stays on its own day", () => {
    expect(daySpanOf(item("a", at(2026, 11, 3, 22), at(2026, 11, 4, 0)), ZONE, zones)).toMatchObject({
      first: "2026-11-03",
      last: "2026-11-03",
      startMinute: 22 * 60,
    });
  });
  it("an instant is read on the reader's clock, not the browser's", () => {
    /* 23:30 UTC on 1 November is 00:30 on 2 November in Zurich. */
    const s = daySpanOf(
      item("a", instant(Date.UTC(2026, 10, 1, 23, 30)), instant(Date.UTC(2026, 10, 2, 0, 30))),
      ZONE,
      zones,
    );
    expect(s).toMatchObject({ first: "2026-11-02", last: "2026-11-02", startMinute: 30 });
  });
  it("on the night the clocks go back, a 01:30 start is read at its clock minutes", () => {
    const s = daySpanOf(item("a", at(2026, 10, 25, 1, 30), at(2026, 10, 25, 4, 0)), ZONE, zones);
    expect(s).toMatchObject({ first: "2026-10-25", startMinute: 90 });
  });
  it("a zone nobody knows is not guessed", () => {
    expect(
      daySpanOf(
        item("a", zoned(wall(2026, 11, 3, 9), "Nowhere/Land"), zoned(wall(2026, 11, 3, 10), "Nowhere/Land")),
        ZONE,
        zones,
      ),
    ).toBeNull();
  });
});

describe("the month's weeks", () => {
  it("six weeks from the week of the first, Monday first, with the other months' days stepped back", () => {
    const m = base([]);
    expect(m.weeks).toHaveLength(6);
    expect(m.weeks[0]!.days[0]!.id).toBe("2026-10-26");
    expect(m.weeks[0]!.days[0]!.outside).toBe(true);
    expect(m.weeks[0]!.days[6]!.id).toBe("2026-11-01");
    expect(m.weeks[0]!.days[6]!.outside).toBe(false);
    expect(m.weeks[5]!.days[6]!.id).toBe("2026-12-06");
    expect(m.weeks[2]!.days[0]).toMatchObject({ id: "2026-11-09", day: 9 });
    expect(
      m.weeks
        .flatMap((w) => w.days)
        .filter((d) => d.today)
        .map((d) => d.id),
    ).toEqual(["2026-11-16"]);
  });
  it("a week that starts on Sunday starts the grid on Sunday", () => {
    expect(base([], { weekStart: 6 }).weeks[0]!.days[0]!.id).toBe("2026-11-01");
  });
  it("the week's number where the setting is on, and week 53 at the end of 2026", () => {
    const m = base([], { month: "2026-12", weekNumbers: true });
    expect(m.weeks[0]!.number).toEqual({ week: 49, weekYear: 2026 });
    expect(m.weeks[4]!.number).toEqual({ week: 53, weekYear: 2026 });
    expect(base([]).weeks[0]!.number).toBeNull();
  });
  it("a run across days is one piece per week, with where it goes on", () => {
    const m = base([item("trip", plainDate(2026, 11, 13), plainDate(2026, 11, 18))]);
    const w2 = m.weeks[2]!.pieces;
    const w3 = m.weeks[3]!.pieces;
    expect(w2).toEqual([
      expect.objectContaining({
        key: "trip",
        from: 4,
        to: 6,
        row: 0,
        run: true,
        goesOnAfter: true,
        goesOnBefore: false,
      }),
    ]);
    expect(w3).toEqual([
      expect.objectContaining({
        key: "trip",
        from: 0,
        to: 1,
        row: 0,
        run: true,
        goesOnBefore: true,
        goesOnAfter: false,
      }),
    ]);
  });
  it("a day shows four lines, or three and how many more", () => {
    const four = [9, 10, 11, 12].map((h) => item(`e${h}`, at(2026, 11, 18, h), at(2026, 11, 18, h + 1)));
    const day = (m: ReturnType<typeof base>) => m.weeks[3]!.days[2]!;
    const m4 = base(four);
    expect(m4.weeks[3]!.pieces.filter((p) => p.from === 2)).toHaveLength(4);
    expect(day(m4).more).toBe(0);
    const five = [...four, item("e13", at(2026, 11, 18, 13), at(2026, 11, 18, 14))];
    const m5 = base(five);
    expect(m5.weeks[3]!.pieces.filter((p) => p.from === 2).map((p) => p.key)).toEqual(["e9", "e10", "e11"]);
    expect(day(m5).more).toBe(2);
  });
  it("timed lines stand in the order of their start, whole days first", () => {
    const m = base([
      item("late", at(2026, 11, 18, 15), at(2026, 11, 18, 16)),
      item("early", at(2026, 11, 18, 8), at(2026, 11, 18, 9)),
      item("whole", plainDate(2026, 11, 18), plainDate(2026, 11, 19)),
    ]);
    expect(m.weeks[3]!.pieces.map((p) => [p.key, p.row])).toEqual([
      ["whole", 0],
      ["early", 1],
      ["late", 2],
    ]);
  });
  it("the open event is never behind +N", () => {
    const five = [9, 10, 11, 12, 13].map((h) => item(`e${h}`, at(2026, 11, 18, h), at(2026, 11, 18, h + 1)));
    const m = base(five, { open: "e13" });
    expect(m.weeks[3]!.pieces.map((p) => p.key)).toEqual(["e9", "e10", "e13"]);
    expect(m.weeks[3]!.days[2]!.more).toBe(2);
  });
  it("a run that would stand below the third line on a full day is left to +N on each of its days", () => {
    const runs = [
      item("r1", plainDate(2026, 11, 16), plainDate(2026, 11, 21)),
      item("r2", plainDate(2026, 11, 16), plainDate(2026, 11, 20)),
      item("r3", plainDate(2026, 11, 16), plainDate(2026, 11, 19)),
      item("r4", plainDate(2026, 11, 17), plainDate(2026, 11, 18)),
    ];
    const timed = [8, 9].map((h) => item(`t${h}`, at(2026, 11, 17, h), at(2026, 11, 17, h + 1)));
    const m = base([...runs, ...timed]);
    const keys = m.weeks[3]!.pieces.map((p) => p.key);
    expect(keys).toContain("r1");
    expect(keys).not.toContain("r4");
    expect(m.weeks[3]!.days[1]!.more).toBe(3);
  });
  it("the picked day is marked where it is not today", () => {
    const m = base([], { picked: "2026-11-18" });
    expect(m.weeks[3]!.days[2]!.picked).toBe(true);
    expect(base([], { picked: "2026-11-16" }).weeks[3]!.days[0]!.picked).toBe(false);
  });
});

describe("months by name", () => {
  it("the month of a day, and the month before and after across a year's end", () => {
    expect(monthOfDay("2026-11-16")).toBe("2026-11");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });
});
