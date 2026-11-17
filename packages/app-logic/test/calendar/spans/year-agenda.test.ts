import { describe, expect, it } from "vitest";
import { intlZones, plainDate, wall, zoned, type EventTime } from "@ohmail/cal-core";
import { agendaDays, agendaFrom, spanOfView, yearMonths } from "../../../src/calendar/spans/index.js";

const zones = intlZones();
const ZONE = "Europe/Zurich";
const at = (y: number, mo: number, d: number, h = 0, mi = 0): EventTime => zoned(wall(y, mo, d, h, mi), ZONE);
const item = (id: string, start: EventTime, end: EventTime) => ({ id, start, end });
const keyOf = (x: { id: string }) => x.id;

describe("the year", () => {
  const year = (items: readonly ReturnType<typeof item>[], picked: string | null = null) =>
    yearMonths({ year: 2026, weekStart: 0, today: "2026-11-16", picked, zone: ZONE, zones, items, keyOf });
  it("twelve months of six weeks, each day of its own month in it", () => {
    const y = year([]);
    expect(y.months.map((m) => m.month)).toEqual(
      Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`),
    );
    expect(y.months.every((m) => m.days.length === 42)).toBe(true);
    expect(y.months[1]!.days.filter((d) => !d.outside)).toHaveLength(28);
    expect(y.months[10]!.hot).toBe(true);
    expect(y.months[0]!.hot).toBe(false);
  });
  it("a day with something is busy, in its own month only", () => {
    const y = year([item("a", at(2026, 3, 2, 9), at(2026, 3, 2, 10))]);
    const march = y.months[2]!.days.find((d) => d.id === "2026-03-02")!;
    expect(march.busy).toBe(true);
    expect(y.months[2]!.days.filter((d) => d.busy)).toHaveLength(1);
    /* 2 March also stands as a day of February's last row, stepped back: not marked there. */
    const feb = y.months[1]!.days.find((d) => d.id === "2026-03-02");
    expect(feb?.busy).toBe(false);
  });
  it("a run of two days or more is a line under its days, broken at the week's edge", () => {
    const y = year([item("trip", plainDate(2026, 11, 13), plainDate(2026, 11, 18))]);
    const nov = y.months[10]!.days;
    const run = (id: string) => nov.find((d) => d.id === id)!.run;
    expect(run("2026-11-12")).toBeNull();
    expect(run("2026-11-13")).toEqual({ key: "trip", first: true, last: false });
    expect(run("2026-11-15")).toEqual({ key: "trip", first: false, last: true });
    expect(run("2026-11-16")).toEqual({ key: "trip", first: true, last: false });
    expect(run("2026-11-17")).toEqual({ key: "trip", first: false, last: true });
    expect(run("2026-11-18")).toBeNull();
  });
  it("a single whole day draws no run", () => {
    const y = year([item("one", plainDate(2026, 11, 13), plainDate(2026, 11, 14))]);
    expect(y.months[10]!.days.find((d) => d.id === "2026-11-13")!.run).toBeNull();
  });
});

describe("the agenda", () => {
  it("days as groups from a day on; days with nothing left out except today", () => {
    const { days } = agendaDays({
      from: "2026-11-15",
      days: 5,
      today: "2026-11-16",
      zone: ZONE,
      zones,
      keyOf,
      items: [
        item("b", at(2026, 11, 18, 14), at(2026, 11, 18, 15)),
        item("a", at(2026, 11, 18, 9), at(2026, 11, 18, 10)),
        item("w", plainDate(2026, 11, 18), plainDate(2026, 11, 19)),
      ],
    });
    expect(days.map((d) => [d.day, d.today, d.rows.map((r) => r.key)])).toEqual([
      ["2026-11-16", true, []],
      ["2026-11-18", false, ["w", "a", "b"]],
    ]);
  });
  it("a run across days stands on each of its days, its first day once marked first", () => {
    const { days } = agendaDays({
      from: "2026-11-13",
      days: 3,
      today: "2026-11-01",
      zone: ZONE,
      zones,
      keyOf,
      items: [item("t", plainDate(2026, 11, 13), plainDate(2026, 11, 16))],
    });
    expect(days.map((d) => d.rows.map((r) => [r.key, r.first]))).toEqual([
      [["t", true]],
      [["t", false]],
      [["t", false]],
    ]);
  });
  it("the first day asked for stands even when empty, where the view asks so", () => {
    const { days } = agendaDays({
      from: "2026-11-20",
      days: 2,
      today: "2026-11-16",
      zone: ZONE,
      zones,
      keyOf,
      items: [],
      keepFirst: true,
    });
    expect(days.map((d) => d.day)).toEqual(["2026-11-20"]);
  });
  it("counts an event in a time zone this device does not know, so the view can say it", () => {
    const unknown = (h: number) => zoned(wall(2026, 11, 18, h, 0), "Customized Time Zone");
    const got = agendaDays({
      from: "2026-11-16",
      days: 5,
      today: "2026-11-16",
      zone: ZONE,
      zones,
      keyOf,
      items: [item("ol", unknown(9), unknown(10)), item("a", at(2026, 11, 18, 9), at(2026, 11, 18, 10))],
    });
    expect(got.unplaced).toBe(1);
    expect(got.days.flatMap((d) => d.rows.map((r) => r.key))).toEqual(["a"]);
  });
  it("its first day is today while the span on screen holds today, else the span's first day", () => {
    expect(agendaFrom(spanOfView("month", "2026-11-18", 0), "2026-11-16")).toBe("2026-11-16");
    expect(agendaFrom(spanOfView("month", "2026-12-03", 0), "2026-11-16")).toBe("2026-12-01");
    expect(agendaFrom(spanOfView("week", "2026-11-25", 0), "2026-11-16")).toBe("2026-11-23");
    expect(agendaFrom(spanOfView("year", "2027-01-01", 0), "2026-11-16")).toBe("2027-01-01");
    expect(agendaFrom(spanOfView("day", "2026-11-20", 0), "2026-11-16")).toBe("2026-11-20");
  });
});
