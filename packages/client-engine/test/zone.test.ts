/**
 * THE ZONE ARITHMETIC — the four primitives every reader-zone stamp and every resurface horizon is
 * built on.
 *
 * `selectors.ts` bands a row stamp with {@link zonedDayNumber} and reads its clock with
 * {@link zonedFields}; `apps/webapp/app/shell/format.ts` mints "tomorrow at 09:00" with
 * {@link zonedInstant}. Those two files are tested through what a reader sees; this one tests the
 * arithmetic underneath, because the arithmetic has cases a product surface never reaches — a wall
 * clock that does not exist, one that happens twice, a day number past the end of a year.
 *
 * Europe/Zurich throughout, because it is the reporting reader's zone and because it HAS a DST rule
 * with known transitions: forward at 02:00 on 29 March 2026, back at 03:00 on 25 October 2026. A
 * zone without one (UTC) cannot tell a correct implementation from a fixed-offset guess.
 */
import { describe, expect, it } from "vitest";
import {
  composeZonedWallClock, firstDayOffset, morningDayOffset, zonedDayNumber, zonedFields, zonedInstant, zonedWeekday,
} from "../src/zone.js";

const Z = "Europe/Zurich";
const at = (iso: string) => new Date(iso);

describe("zonedFields", () => {
  it("reads an instant's wall clock where the reader is", () => {
    expect(zonedFields(at("2026-08-11T14:32:00Z"), Z)).toMatchObject({
      year: 2026, month: 8, day: 11, hour: 16, minute: 32,
    });
  });

  it("moves the DATE, not only the hour", () => {
    expect(zonedFields(at("2026-08-04T22:10:00Z"), Z)).toMatchObject({
      year: 2026, month: 8, day: 5, hour: 0, minute: 10,
    });
  });

  it("reads midnight as hour 0 — never 24, which would date the row a day early", () => {
    expect(zonedFields(at("2026-08-10T22:00:00Z"), Z).hour).toBe(0);
    expect(zonedFields(at("2026-08-11T00:00:00Z"), "UTC").hour).toBe(0);
  });

  it("applies the winter offset in winter and the summer one in summer", () => {
    expect(zonedFields(at("2026-01-11T14:32:00Z"), Z).hour).toBe(15);
    expect(zonedFields(at("2026-08-11T14:32:00Z"), Z).hour).toBe(16);
  });

  it("refuses a zone it does not know rather than quietly falling back", () => {
    expect(() => zonedFields(at("2026-08-11T14:32:00Z"), "Middle/Earth")).toThrow();
  });
});

describe("zonedDayNumber", () => {
  it("counts the reader's calendar days, so a late-evening instant is already tomorrow", () => {
    const late = at("2026-08-11T22:10:00Z"); // 00:10 on the 12th in Zurich
    expect(zonedDayNumber(late, Z) - zonedDayNumber(at("2026-08-11T09:00:00Z"), Z)).toBe(1);
    expect(zonedDayNumber(late, "UTC") - zonedDayNumber(at("2026-08-11T09:00:00Z"), "UTC")).toBe(0);
  });

  it("counts one day across the spring-forward night, which is 23 hours long", () => {
    /* 86 400 000 milliseconds apart is not one day here, and dividing by it would answer 0. */
    const before = at("2026-03-28T12:00:00Z");
    const after = at("2026-03-29T12:00:00Z");
    expect(zonedDayNumber(after, Z) - zonedDayNumber(before, Z)).toBe(1);
  });
});

describe("zonedWeekday", () => {
  it("names the weekday of the reader's calendar day, not of the UTC one", () => {
    /* 2026-08-11 is a Tuesday. At 22:10Z it is Wednesday in Zurich and still Tuesday in UTC. */
    expect(zonedWeekday(at("2026-08-11T22:10:00Z"), "UTC")).toBe(2);
    expect(zonedWeekday(at("2026-08-11T22:10:00Z"), Z)).toBe(3);
  });
});

describe("zonedInstant", () => {
  it("mints a wall clock as the instant the reader's clock shows it", () => {
    expect(zonedInstant({ year: 2026, month: 8, day: 12, hour: 9 }, Z).toISOString())
      .toBe("2026-08-12T07:00:00.000Z");
    expect(zonedInstant({ year: 2026, month: 1, day: 12, hour: 9 }, Z).toISOString())
      .toBe("2026-01-12T08:00:00.000Z");
  });

  /**
   * THE SECOND PASS, WATCHED.
   *
   * 01:30 on 29 March is CET (+1) but the offset AT THE NAIVE INSTANT (01:30Z, which is already
   * 03:30 CEST) is +2. A single-pass implementation subtracts the wrong one and lands at 23:30 the
   * evening before — an hour early, on the previous day. This is the case that fails if the
   * refinement in `zonedInstant` is ever removed as redundant.
   */
  it("corrects itself when the naive guess falls on the other side of a transition", () => {
    expect(zonedInstant({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, Z).toISOString())
      .toBe("2026-03-29T00:30:00.000Z");
    expect(zonedInstant({ year: 2026, month: 3, day: 29, hour: 3, minute: 30 }, Z).toISOString())
      .toBe("2026-03-29T01:30:00.000Z");
  });

  it("a wall clock that never happens answers the instant the clock jumps to", () => {
    /* 02:30 on 29 March does not exist in Zurich — the clock goes 01:59:59 → 03:00:00. Rather than
       throw, this answers the instant that reads 03:30, which is 02:30 plus the hour that was
       skipped. A chosen resurface time reaches this every spring; `composeZonedWallClock` below is
       the door that also SAYS so, and this one is pinned to the same instant. */
    const minted = zonedInstant({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, Z);
    expect(minted.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(zonedFields(minted, Z)).toMatchObject({ hour: 3, minute: 30 });
  });

  it("a wall clock that happens twice answers the SECOND one", () => {
    /* 02:30 on 25 October happens at 00:30Z (still CEST) and again at 01:30Z (CET). This door
       answers the later one, which is what an instant CLOSING a window wants (`dayEnd`'s
       23:59:59 ends the day it names); a time somebody chose goes through the other door. */
    const minted = zonedInstant({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, Z);
    expect(minted.toISOString()).toBe("2026-10-25T01:30:00.000Z");
    expect(zonedFields(minted, Z)).toMatchObject({ hour: 2, minute: 30 });
  });

  it("normalizes an out-of-range day across the end of a month and a year", () => {
    /* `tomorrowNine` adds 1 to the calendar day and hands the result straight here, so 31 August
       plus one has to become 1 September without the caller doing any month arithmetic. */
    expect(zonedInstant({ year: 2026, month: 8, day: 32, hour: 9 }, Z).toISOString())
      .toBe("2026-09-01T07:00:00.000Z");
    expect(zonedInstant({ year: 2026, month: 12, day: 32, hour: 9 }, Z).toISOString())
      .toBe("2027-01-01T08:00:00.000Z");
  });

  it("is the composition's own answer wherever a wall clock is unambiguous", () => {
    /* The two doors are ONE arithmetic: they may differ only on the repeated hour. Every other
       wall clock of both transition days has to agree, or there are two rules in the product. */
    for (const [month, day] of [[3, 29], [10, 25]] as const) {
      for (let hour = 0; hour < 24; hour++) {
        const wall = { year: 2026, month, day, hour, minute: 30 };
        const composed = composeZonedWallClock(wall, Z);
        if (composed.verdict === "first_of_two") continue;
        expect(composed.instant.toISOString(), `${month}/${day} ${hour}:30`)
          .toBe(zonedInstant(wall, Z).toISOString());
      }
    }
  });

  it("round-trips against zonedFields for every hour of a transition day", () => {
    /* The property the two functions owe each other: minting a wall clock and reading it back
       returns the wall clock, for every hour of the two days a fixed-offset implementation gets
       wrong. The one exception is the hour that does not exist, asserted above. */
    for (const [month, day] of [[3, 29], [10, 25], [8, 11]] as const) {
      for (let hour = 0; hour < 24; hour++) {
        if (month === 3 && day === 29 && hour === 2) continue; // does not exist
        const back = zonedFields(zonedInstant({ year: 2026, month, day, hour, minute: 15 }, Z), Z);
        expect({ m: back.month, d: back.day, h: back.hour, min: back.minute })
          .toEqual({ m: month, d: day, h: hour, min: 15 });
      }
    }
  });
});

describe("composeZonedWallClock", () => {
  /**
   * THE DOOR A CHOSEN TIME GOES THROUGH. Three verdicts, each a decision somebody can read off
   * the surface: the time asked for, the first instant after a skipped hour, and the earlier of
   * two where the hour repeats. The dates are fixed and the zone is named — a case that read the
   * machine's clock would answer differently on a laptop that had travelled.
   */
  it("answers `exact` and the clock it was given on an ordinary day", () => {
    const composed = composeZonedWallClock({ year: 2026, month: 8, day: 12, hour: 14, minute: 30 }, Z);
    expect(composed.verdict).toBe("exact");
    expect(composed.instant.toISOString()).toBe("2026-08-12T12:30:00.000Z");
    expect([composed.hour, composed.minute]).toEqual([14, 30]);
  });

  it("shifts FORWARD past an hour the clocks skip, and says it did", () => {
    /* 02:30 does not exist on 28 March 2027 in Zurich. The booking is the first instant after the
       missing hour — 03:30 — and `hour`/`minute` are read back off it, so a chooser labelled from
       them states 03:30 rather than the 02:30 nobody can have. */
    const composed = composeZonedWallClock({ year: 2027, month: 3, day: 28, hour: 2, minute: 30 }, Z);
    expect(composed.verdict).toBe("shifted_forward");
    expect(composed.instant.toISOString()).toBe("2027-03-28T01:30:00.000Z");
    expect([composed.hour, composed.minute]).toEqual([3, 30]);
  });

  it("takes the FIRST of two where the hour comes round twice", () => {
    /* 02:30 on 25 October 2026 happens at 00:30Z (CEST) and again at 01:30Z (CET). A chosen time
       comes round when the reader's clock FIRST reads it — the opposite end from `zonedInstant`,
       which is the window-closing door. */
    const composed = composeZonedWallClock({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, Z);
    expect(composed.verdict).toBe("first_of_two");
    expect(composed.instant.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(zonedInstant({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, Z).toISOString())
      .toBe("2026-10-25T01:30:00.000Z");
    expect([composed.hour, composed.minute]).toEqual([2, 30]);
  });

  it("holds in a zone whose change is half an hour, and in one that skips at midnight", () => {
    /* Lord Howe moves by 30 minutes and New York's autumn hour repeats on a different date — the
       rule is the zone's, never a hard-coded hour. Both are read back off the instant. */
    const lh = composeZonedWallClock({ year: 2026, month: 4, day: 5, hour: 1, minute: 45 }, "Australia/Lord_Howe");
    expect([lh.verdict, lh.hour, lh.minute]).toEqual(["first_of_two", 1, 45]);
    const santiago = composeZonedWallClock({ year: 2026, month: 9, day: 6, hour: 0, minute: 30 }, "America/Santiago");
    expect([santiago.verdict, santiago.hour, santiago.minute]).toEqual(["shifted_forward", 1, 30]);
  });

  it("still normalizes a day past the end of the month — the horizons hand it one", () => {
    const composed = composeZonedWallClock({ year: 2026, month: 8, day: 32, hour: 9 }, Z);
    expect(composed.instant.toISOString()).toBe("2026-09-01T07:00:00.000Z");
    expect([composed.verdict, composed.hour]).toEqual(["exact", 9]);
  });
});

describe("morningDayOffset and firstDayOffset", () => {
  const nine = { hour: 9, minute: 0 };
  it("after midnight on the autumn night, 'tomorrow morning' is the coming one, across the change", () => {
    // 00:28 CEST on Sunday 25 October 2026; the clocks go back at 03:00, 09:00 is CET.
    const from = at("2026-10-24T22:28:00Z");
    expect(morningDayOffset(from, Z, nine)).toBe(0);
    expect(firstDayOffset(from, Z, nine)).toBe(0);
  });

  it("…and on the spring night", () => {
    expect(morningDayOffset(at("2027-03-27T23:28:00Z"), Z, nine)).toBe(0);
  });

  it("is tomorrow once the night is over, or once the hour has gone", () => {
    expect(morningDayOffset(at("2026-10-25T05:00:00Z"), Z, nine)).toBe(1); // 06:00 CET
    expect(morningDayOffset(at("2026-10-24T22:28:00Z"), Z, { hour: 0, minute: 15 })).toBe(1);
    expect(morningDayOffset(at("2026-08-11T12:00:00Z"), Z, { hour: 18, minute: 0 })).toBe(1);
  });

  it("firstDayOffset lets a later hour today be booked at any time of day", () => {
    expect(firstDayOffset(at("2026-08-11T12:00:00Z"), Z, { hour: 18, minute: 0 })).toBe(0);
    expect(firstDayOffset(at("2026-08-11T12:00:00Z"), Z, nine)).toBe(1);
  });
});
