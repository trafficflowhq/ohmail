import { describe, expect, it } from "vitest";
import {
  floating,
  instant,
  intlZones,
  plainDate,
  wall,
  zoned,
  type EventTime,
  type PlainDate,
} from "@ohmail/cal-core";
import {
  allDayLane,
  clockOf,
  dayHead,
  dayOfIso,
  hourLabels,
  freeStretches,
  isoOfDay,
  laneLimits,
  lanesOf,
  nowIn,
  outOfSight,
  placeDays,
  timeGridModel,
  weekDays,
  type GridItem,
} from "../../src/calendar/grid/index.js";

const zones = intlZones();
const ZURICH = "Europe/Zurich";
const item = (id: string, start: EventTime, end: EventTime): GridItem => ({ id, start, end });
const at = (y: number, mo: number, d: number, h: number, mi = 0): EventTime =>
  zoned(wall(y, mo, d, h, mi), ZURICH);
const day = (y: number, mo: number, d: number): PlainDate => plainDate(y, mo, d);
const oneDay = (items: GridItem[], d: PlainDate, zone = ZURICH) =>
  placeDays(items, [d], zone, zones).timed[0]!.map((s) => [s.item.id, s.from, s.to]);

describe("an event across a zone's change of hour sits on its wall-clock minutes", () => {
  it("on 2026-03-29, the 23-hour day in Europe/Zurich, 01:00 to 04:00 stands from 01:00 to 04:00", () => {
    expect(oneDay([item("spring", at(2026, 3, 29, 1), at(2026, 3, 29, 4))], day(2026, 3, 29))).toEqual([
      ["spring", 60, 240],
    ]);
  });

  it("on 2026-10-25, the 25-hour day, 01:00 to 04:00 stands from 01:00 to 04:00", () => {
    expect(oneDay([item("autumn", at(2026, 10, 25, 1), at(2026, 10, 25, 4))], day(2026, 10, 25))).toEqual([
      ["autumn", 60, 240],
    ]);
  });

  it("an event after the change on either day sits at its own hour, not shifted by the hour that went or came", () => {
    const evening = (d: number, mo: number) =>
      item(`evening-${mo}`, at(2026, mo, d, 18), at(2026, mo, d, 19, 30));
    expect(oneDay([evening(29, 3)], day(2026, 3, 29))).toEqual([["evening-3", 1080, 1170]]);
    expect(oneDay([evening(25, 10)], day(2026, 10, 25))).toEqual([["evening-10", 1080, 1170]]);
  });

  it("a moment written in UTC is read on the reader's clock across the change", () => {
    // 00:30Z on 25 October is 02:30 summer time; 03:30Z is 04:30 winter time.
    const utc = item("utc", instant(Date.UTC(2026, 9, 25, 0, 30)), instant(Date.UTC(2026, 9, 25, 3, 30)));
    expect(oneDay([utc], day(2026, 10, 25))).toEqual([["utc", 150, 270]]);
  });

  it("an event inside the hour the clock shows twice stands from its start for as long as it lasts", () => {
    // 02:30 summer time (00:30Z) to 02:15 winter time (01:15Z): 45 minutes.
    const twice = item("twice", instant(Date.UTC(2026, 9, 25, 0, 30)), instant(Date.UTC(2026, 9, 25, 1, 15)));
    expect(oneDay([twice], day(2026, 10, 25))).toEqual([["twice", 150, 195]]);
  });

  it("a zoneless time stands at its written hour for every reader", () => {
    const lunch = item("lunch", floating(wall(2026, 11, 16, 12)), floating(wall(2026, 11, 16, 13)));
    expect(oneDay([lunch], day(2026, 11, 16), "America/New_York")).toEqual([["lunch", 720, 780]]);
  });

  it("a time in another zone is read on the reader's clock", () => {
    const call = item(
      "call",
      zoned(wall(2026, 11, 16, 9), "America/New_York"),
      zoned(wall(2026, 11, 16, 10), "America/New_York"),
    );
    expect(oneDay([call], day(2026, 11, 16))).toEqual([["call", 900, 960]]);
  });
});

describe("placing events on the days shown", () => {
  it("an event past midnight stands in both days, cut at their edges", () => {
    const placed = placeDays(
      [item("late", at(2026, 11, 17, 22), at(2026, 11, 18, 2))],
      [day(2026, 11, 17), day(2026, 11, 18)],
      ZURICH,
      zones,
    );
    expect(placed.timed.map((l) => l.map((s) => [s.from, s.to, s.before, s.after]))).toEqual([
      [[1320, 1440, false, true]],
      [[0, 120, true, false]],
    ]);
  });

  it("an event of no length stands at its start on its day only", () => {
    const placed = placeDays(
      [item("mark", at(2026, 11, 17, 9), at(2026, 11, 17, 9))],
      [day(2026, 11, 16), day(2026, 11, 17)],
      ZURICH,
      zones,
    );
    expect(placed.timed.map((l) => l.map((s) => [s.from, s.to]))).toEqual([[], [[540, 540]]]);
  });

  it("a whole day goes to the lane, and a time in a zone nobody knows is unplaced, never put at a guessed hour", () => {
    const whole = item("whole", plainDate(2026, 11, 17), plainDate(2026, 11, 18));
    const lost = item(
      "lost",
      zoned(wall(2026, 11, 17, 9), "Nowhere/Atlantis"),
      zoned(wall(2026, 11, 17, 10), "Nowhere/Atlantis"),
    );
    const placed = placeDays([whole, lost], [day(2026, 11, 17)], ZURICH, zones);
    expect(placed.timed[0]).toEqual([]);
    expect(placed.allDay.map((i) => i.id)).toEqual(["whole"]);
    expect(placed.unplaced.map((i) => i.id)).toEqual(["lost"]);
  });

  it("each day's list is in order of start, the longer first", () => {
    const items = [
      item("b", at(2026, 11, 17, 10), at(2026, 11, 17, 11)),
      item("c", at(2026, 11, 17, 9), at(2026, 11, 17, 9, 30)),
      item("a", at(2026, 11, 17, 9), at(2026, 11, 17, 12)),
    ];
    expect(oneDay(items, day(2026, 11, 17)).map((r) => r[0])).toEqual(["a", "c", "b"]);
  });
});

describe("overlapping events", () => {
  const limits = laneLimits(60);
  const lane = (items: GridItem[]) =>
    lanesOf(placeDays(items, [day(2026, 11, 12)], ZURICH, zones).timed[0]!, limits).map((l) => [
      l.item.id,
      l.column,
      l.columns,
      l.lap,
      l.room,
    ]);

  it("a later start half an hour or more after the earlier laps over it, which keeps the minutes above the lap", () => {
    expect(
      lane([
        item("a", at(2026, 11, 12, 10), at(2026, 11, 12, 12)),
        item("b", at(2026, 11, 12, 11), at(2026, 11, 12, 12)),
      ]),
    ).toEqual([
      ["a", 0, 1, false, 60],
      ["b", 1, 2, true, null],
    ]);
  });

  it("closer starts stand side by side", () => {
    expect(
      lane([
        item("a", at(2026, 11, 12, 10), at(2026, 11, 12, 11)),
        item("b", at(2026, 11, 12, 10, 15), at(2026, 11, 12, 11)),
      ]),
    ).toEqual([
      ["a", 0, 2, false, null],
      ["b", 1, 2, false, null],
    ]);
  });

  it("three at once stand side by side, and one after them stands alone", () => {
    const three = [
      item("a", at(2026, 11, 12, 9), at(2026, 11, 12, 12)),
      item("b", at(2026, 11, 12, 10), at(2026, 11, 12, 11)),
      item("c", at(2026, 11, 12, 10, 30), at(2026, 11, 12, 11, 30)),
      item("d", at(2026, 11, 12, 13), at(2026, 11, 12, 14)),
    ];
    expect(lane(three).map((r) => [r[0], r[1], r[2], r[3]])).toEqual([
      ["a", 0, 3, false],
      ["b", 1, 3, false],
      ["c", 2, 3, false],
      ["d", 0, 1, false],
    ]);
  });

  it("a later start laps only over what started well before it: a third under it stands side by side", () => {
    expect(
      lane([
        item("a", at(2026, 11, 12, 9), at(2026, 11, 12, 10)),
        item("b", at(2026, 11, 12, 9, 30), at(2026, 11, 12, 11)),
        item("c", at(2026, 11, 12, 10), at(2026, 11, 12, 11)),
      ]),
    ).toEqual([
      ["a", 0, 2, false, null],
      ["b", 1, 2, false, null],
      ["c", 0, 2, false, null],
    ]);
  });

  it("a short event is reckoned as tall as it is drawn: the next one beside its drawn foot stands beside it", () => {
    expect(
      lane([
        item("a", at(2026, 11, 12, 10), at(2026, 11, 12, 10, 5)),
        item("b", at(2026, 11, 12, 10, 10), at(2026, 11, 12, 11)),
      ]).map((r) => r[2]),
    ).toEqual([2, 2]);
  });
});

describe("the lane above the hours", () => {
  const week = weekDays(day(2026, 11, 18), 0);
  it("a run takes the first free row; its end is the day after its last", () => {
    const lane = allDayLane(
      [
        item("trip", plainDate(2026, 11, 14), plainDate(2026, 11, 19)),
        item("holiday", plainDate(2026, 11, 18), plainDate(2026, 11, 19)),
        item("fair", plainDate(2026, 11, 19), plainDate(2026, 11, 22)),
      ],
      week,
    );
    expect(lane.pills.map((p) => [p.item.id, p.first, p.last, p.row, p.before, p.after])).toEqual([
      ["trip", 0, 2, 0, true, false],
      ["holiday", 2, 2, 1, false, false],
      ["fair", 3, 5, 0, false, false],
    ]);
    expect(lane.rows).toBe(2);
  });

  it("a whole day outside the days shown is not in the lane", () => {
    expect(allDayLane([item("before", plainDate(2026, 11, 1), plainDate(2026, 11, 2))], week).pills).toEqual(
      [],
    );
  });
});

describe("the days and now", () => {
  it("a week counts from its first day: Monday or Sunday", () => {
    expect(weekDays(day(2026, 11, 18), 0).map(isoOfDay)).toEqual([
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      "2026-11-21",
      "2026-11-22",
    ]);
    expect(weekDays(day(2026, 11, 18), 6)[0]).toEqual(day(2026, 11, 15));
  });

  it("an anchor that is no real date reads as none", () => {
    expect(dayOfIso("2026-02-30")).toBeNull();
    expect(dayOfIso("tomorrow")).toBeNull();
    expect(dayOfIso("2026-02-28")).toEqual(day(2026, 2, 28));
  });

  it("now is the reader's clock in the reader's zone, across the change of hour", () => {
    expect(nowIn(Date.UTC(2026, 2, 29, 1, 30), ZURICH, zones)).toEqual({
      day: day(2026, 3, 29),
      minutes: 210,
    });
    expect(nowIn(Date.UTC(2026, 10, 15, 23, 30), ZURICH, zones)).toEqual({
      day: day(2026, 11, 16),
      minutes: 30,
    });
    expect(nowIn(0, "Nowhere/Atlantis", zones)).toBeNull();
  });
});

describe("what a day's hours say beside the events", () => {
  const segs = placeDays(
    [
      item("early", at(2026, 11, 12, 6), at(2026, 11, 12, 6, 30)),
      item("mid", at(2026, 11, 12, 10), at(2026, 11, 12, 11)),
      item("late", at(2026, 11, 12, 22), at(2026, 11, 12, 23)),
    ],
    [day(2026, 11, 12)],
    ZURICH,
    zones,
  ).timed[0]!;

  it("what lies wholly above and below the hours in view, the nearest first", () => {
    const out = outOfSight(segs, { from: 7 * 60, to: 21 * 60 }, 30);
    expect([out.above.map((s) => s.item.id), out.below.map((s) => s.item.id)]).toEqual([["early"], ["late"]]);
    expect(outOfSight(segs, { from: 6 * 60 + 20, to: 24 * 60 }, 30).above).toEqual([]);
  });

  it("free stretches of an hour or more, at their middle", () => {
    expect(freeStretches(segs)).toEqual([
      { at: 6 * 60 + 30 + 105, minutes: 210 },
      { at: 11 * 60 + 330, minutes: 660 },
    ]);
  });
});

describe("the grid as a view draws it", () => {
  const week = weekDays(day(2026, 11, 18), 0);
  const events = [
    item("standup", at(2026, 11, 16, 9), at(2026, 11, 16, 9, 30)),
    item("review", at(2026, 11, 18, 14), at(2026, 11, 18, 16)),
    item("fair", plainDate(2026, 11, 19), plainDate(2026, 11, 21)),
  ];
  const model = (
    o: {
      nowMs?: number;
      inView?: { from: number; to: number } | null;
      picked?: PlainDate | null;
      free?: boolean;
    } = {},
  ) =>
    timeGridModel({
      events,
      days: week,
      zone: ZURICH,
      zones,
      nowMs: o.nowMs ?? Date.UTC(2026, 10, 18, 14, 0),
      hourPx: 48,
      inView: o.inView ?? null,
      picked: o.picked ?? null,
      free: o.free ?? false,
    });

  it("places each block in px from 00:00 at the hour's height", () => {
    const m = model();
    expect(m.days[0]!.blocks.map((b) => [b.item.id, b.top, b.height])).toEqual([["standup", 432, 24]]);
    expect(m.days[2]!.blocks.map((b) => [b.item.id, b.top, b.height])).toEqual([["review", 672, 96]]);
    expect(m.lane.pills.map((p) => [p.item.id, p.first, p.last])).toEqual([["fair", 3, 4]]);
  });

  it("now stands on today only, and crosses the block it falls in", () => {
    const m = model();
    expect(m.now).toEqual({ minutes: 15 * 60 });
    expect(m.days.map((d) => d.today)).toEqual([false, false, true, false, false, false, false]);
    expect(m.days[2]!.blocks[0]!.nowCrosses).toBe(true);
    expect(model({ nowMs: Date.UTC(2026, 10, 30, 9) }).now).toBeNull();
  });

  it("the day picked is marked where it is not today", () => {
    expect(model({ picked: day(2026, 11, 19) }).days.map((d) => d.picked)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(model({ picked: day(2026, 11, 18) }).days.some((d) => d.picked)).toBe(false);
  });

  it("nothing is out of sight before the hours have been measured; after, what lies above and below", () => {
    expect(model().days[0]!.above).toEqual([]);
    const m = model({ inView: { from: 10 * 60, to: 13 * 60 } });
    expect([m.days[0]!.above.map((s) => s.item.id), m.days[2]!.below.map((s) => s.item.id)]).toEqual([
      ["standup"],
      ["review"],
    ]);
  });

  it("free stretches only where asked (the day alone)", () => {
    expect(model().days.every((d) => d.free.length === 0)).toBe(true);
  });
});

describe("the grid's writing", () => {
  it("a day's head in the reader's language, whatever the reader's zone", () => {
    expect(dayHead(day(2026, 11, 16), "en")).toEqual({
      weekday: "Mon",
      date: "16",
      label: "Monday, November 16, 2026",
    });
    const de = dayHead(day(2026, 11, 16), "de");
    // The short weekday's dot differs between ICU releases; the day and its number do not.
    expect([de.weekday.slice(0, 2), de.date, de.label]).toEqual(["Mo", "16", "Montag, 16. November 2026"]);
  });

  it("the hours write the clock in 24 hours, to 24:00", () => {
    expect([clockOf(0), clockOf(450), clockOf(1440)]).toEqual(["00:00", "07:30", "24:00"]);
    expect(hourLabels(22, 24)).toEqual(["22:00", "23:00", "24:00"]);
  });
});
