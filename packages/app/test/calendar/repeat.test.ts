import { describe, expect, it } from "vitest";
import { createTranslator } from "use-intl/core";
import en from "../../messages/calendar.en.json";
import de from "../../messages/calendar.de.json";
import { repeatLine } from "../../src/calendar/EventActionQuestion.js";
import { repeatPresets, untilForDay } from "../../src/calendar/repeat.js";
import type { Text } from "../../src/text/index.js";

describe("repeats on the event's calendar", () => {
  const day = "2027-03-31";
  const english = createTranslator({ locale: "en", namespace: "calendar", messages: en }) as Text;
  const german = createTranslator({ locale: "de", namespace: "calendar", messages: de }) as Text;

  it("offers rules and sentences for the chosen day including its last weekday", () => {
    const presets = repeatPresets(day);
    expect(presets).toEqual([
      null,
      "FREQ=DAILY",
      "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      "FREQ=WEEKLY;BYDAY=WE",
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
      "FREQ=MONTHLY;BYMONTHDAY=31",
      "FREQ=MONTHLY;BYDAY=-1WE",
      "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=31",
    ]);
    expect(presets.slice(1).map((rule) => repeatLine(rule!, "20270331", english, "en-GB"))).toEqual([
      "Every day",
      "Every weekday (Mon–Fri)",
      "Every week on Wednesday",
      "Every 2 weeks on Wednesday",
      "Every month on the 31st",
      "Every month on the last Wednesday",
      "Every year on 31 March",
    ]);
    expect(repeatPresets("2027-03-24")).toContain("FREQ=MONTHLY;BYDAY=4WE");
  });

  it("describes intervals, multiple days and ends in both languages", () => {
    const rule = "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20270331T073000Z";
    expect(repeatLine(rule, "20270301", english, "en-GB")).toBe(
      "Every 2 weeks on Monday and Thursday, until 31 Mar 2027",
    );
    expect(repeatLine(rule, "20270301", german, "de")).toContain("Montag und Donnerstag");
    expect(repeatLine("FREQ=MONTHLY;INTERVAL=3;BYDAY=2WE;COUNT=4", "20270310", english, "en")).toBe(
      "Every 3 months on the second Wednesday, 4 times",
    );
    expect(repeatLine("FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYMONTHDAY=10", "20270310", english, "en-GB")).toBe(
      "Every 2 years on 10 March",
    );
    expect(repeatLine("FREQ=DAILY;INTERVAL=5", "20270301", english, "en")).toBe("Every 5 days");
  });

  it("ends inclusively on the local event clock across a DST change and on a civil date for whole days", () => {
    expect(untilForDay(day, false, "09:30", "Europe/Zurich")).toBe("20270331T073000Z");
    expect(untilForDay(day, true, "09:30", "Europe/Zurich")).toBe("20270331");
  });
});
