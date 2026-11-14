/**
 * WHICH REPEATS A WRITE MAY SEND: each rule a person can make has one shape, a rule outside the list
 * has none, and a shape is sendable only where its provider's row names it. Every row is empty until
 * a recorded proof brings it, so today no series leaves for any provider.
 */
import { parseRRule } from "@ohmail/cal-core";
import { describe, expect, it } from "vitest";
import { PROVEN_REPEATS, repeatProven, repeatShapeOf } from "../src/repeat-shapes.js";

const shape = (text: string) => repeatShapeOf(parseRRule(text)!);

describe("a repeat's shape", () => {
  it("names each repeat a person can make, with how it ends", () => {
    const rows: [string, string | null][] = [
      ["FREQ=DAILY", "daily/never"],
      ["FREQ=DAILY;INTERVAL=3;COUNT=10", "every_n_days/count"],
      ["FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "weekdays/never"],
      ["FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20270101T000000Z", "weekdays/until"],
      ["FREQ=WEEKLY", "weekly/never"],
      ["FREQ=WEEKLY;BYDAY=TU", "weekly/never"],
      ["FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=6", "weeks_on_days/count"],
      ["FREQ=MONTHLY;BYMONTHDAY=15", "monthly_by_date/never"],
      ["FREQ=MONTHLY;BYMONTHDAY=31", "monthly_late_date/never"],
      ["FREQ=MONTHLY;BYDAY=2TU", "monthly_nth_weekday/never"],
      ["FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20271231", "monthly_last_weekday/until"],
      ["FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29", "yearly_by_date/never"],
      ["FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", "yearly_by_weekday/never"],
      // Outside the list: no shape, sendable nowhere.
      ["FREQ=HOURLY", null],
      ["FREQ=DAILY;BYHOUR=9,17", null],
      ["FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2", null],
      ["FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,FR", null],
      ["FREQ=YEARLY;BYWEEKNO=20", null],
      ["FREQ=WEEKLY;WKST=SU;BYDAY=MO", null],
    ];
    expect(rows.map(([text]) => [text, shape(text)])).toEqual(rows);
  });

  it("is sendable only where its provider's row names it, and every row is empty until a proof brings it", () => {
    expect(Object.values(PROVEN_REPEATS).every((row) => row.length === 0)).toBe(true);
    const weekly = parseRRule("FREQ=WEEKLY")!;
    expect(repeatProven("google", weekly)).toBe(false);
    expect(repeatProven("google", weekly, { ...PROVEN_REPEATS, google: ["weekly/never"] })).toBe(true);
    expect(repeatProven("caldav", weekly, { ...PROVEN_REPEATS, google: ["weekly/never"] })).toBe(false);
    expect(
      repeatProven("google", parseRRule("FREQ=HOURLY")!, { ...PROVEN_REPEATS, google: ["weekly/never"] }),
    ).toBe(false);
  });
});
