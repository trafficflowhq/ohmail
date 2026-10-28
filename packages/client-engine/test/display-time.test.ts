/**
 * The row stamp — `messageDisplayTime`.
 *
 * This function shipped with NO test, which is why it rendered a bare weekday name for every
 * message not sent today: a mail from March showed "Tue", sitting in a date-sorted list
 * directly above one from yesterday that also showed "Tue". Owner-reported.
 *
 * The assertions below are about AMBIGUITY, not about formatting taste. The one property
 * worth defending is that two messages the reader would want to tell apart never carry the
 * same stamp, so the interesting cases are the boundaries: day 6 vs day 7, and December of
 * last year vs December of this one.
 *
 * THE ZONE IS PASSED EXPLICITLY, and that is what makes these UTC expectations a choice. This
 * package has no reader to ask, so a default would mean the boundaries below were being measured
 * against whatever zone the machine running the suite happens to sit in — which is how a file that
 * reads as a careful boundary analysis silently stops testing the boundary it names. The reader's
 * own zone is exercised where there IS a reader: `apps/webapp/test/reader-zone.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { messageDisplayTime } from "../src/selectors.js";
import { appointmentStamp, shownDateOf } from "../src/stamp.js";

// A Wednesday, so every weekday boundary below is easy to read off by hand.
const NOW = new Date("2026-08-02T12:00:00Z");
const at = (iso: string) => messageDisplayTime({ date: iso } as never, NOW, "UTC");

describe("messageDisplayTime", () => {
  it("shows the clock for today, read in the zone it was given", () => {
    expect(at("2026-08-02T09:07:00Z")).toBe("09:07");
    expect(at("2026-08-02T23:59:00Z")).toBe("23:59");
  });

  it("shows a weekday AND THE CLOCK for the six days a weekday name is still unique", () => {
    /* THE TIME USED TO VANISH AT THE READER'S MIDNIGHT. A message stamped "09:00" became a bare
       "Sat" the moment the day turned, so the one band a reader scans most — this week — was the
       one band that answered "which day" and refused to answer "when". The shape is a superset of
       today's: the clock stays for six days and only the day name is added in front of it. */
    expect(at("2026-08-01T09:00:00Z")).toBe("Sat 09:00"); // 1 day ago
    expect(at("2026-07-27T09:00:00Z")).toBe("Mon 09:00"); // 6 days ago — the last unambiguous one
  });

  it("names the weekday in the reader's language, and the digits are the same digits", () => {
    // The "German twins" the plan asks for are `Intl`'s, so no catalogue key exists to go missing —
    // and the clock is not `Intl`-formatted at all, which is why only the word changes.
    const de = (iso: string) =>
      messageDisplayTime({ date: iso } as never, NOW, "UTC", "de");
    expect(de("2026-08-01T09:00:00Z")).toBe("Sa 09:00");
    expect(de("2026-07-27T09:00:00Z")).toBe("Mo 09:00");
    // A combined `Intl` weekday+time pattern renders "Sa., 09:00" in German — a comma no caller
    // chose. The two parts are composed here precisely so that cannot happen.
    expect(de("2026-08-01T09:00:00Z")).not.toContain(",");
  });

  it("MIDNIGHT IN THE BAND IS 00, NEVER 24", () => {
    /* The `hour12: false` trap, at the one instant it shows: an ICU build that reads that spelling
       as h24 renders midnight as "24:07" AND bands the row against the wrong day. The clock comes
       from `zonedFields`, which asks for `h23` by name and folds a 24 back to 0. */
    expect(at("2026-08-01T00:07:00Z")).toBe("Sat 00:07");
    expect(at("2026-08-01T00:07:00Z")).not.toContain("24:");
  });

  it("the band and the clock are read in the SAME zone, so neither can name the other's day", () => {
    /* 23:59 UTC on the 1st is already 01:59 on the 2nd in Zurich — a different day AND a different
       clock. A fix that moved the clock into the reader's zone and left the band on UTC would
       render "Sat 01:59", naming Saturday's weekday over Sunday's hour. */
    const zurich = (iso: string) =>
      messageDisplayTime({ date: iso } as never, NOW, "Europe/Zurich");
    expect(at("2026-08-01T23:59:00Z")).toBe("Sat 23:59");
    expect(zurich("2026-08-01T23:59:00Z")).toBe("01:59");
  });

  it("stops using a weekday the moment it would repeat", () => {
    // 7 days ago is the SAME weekday as today. A reader cannot tell it from today's mail,
    // and this is precisely the row that was reported.
    expect(at("2026-07-26T09:00:00Z")).toBe("26 Jul");
    expect(at("2026-07-26T09:00:00Z")).not.toBe("Sun");
  });

  it("never renders a bare weekday for an old message", () => {
    const march = at("2026-03-17T09:00:00Z");
    expect(march).toBe("17 Mar");
    expect(WEEKDAYS).not.toContain(march);
  });

  it("carries the year only when it is not the current one", () => {
    expect(at("2026-01-04T09:00:00Z")).toBe("4 Jan");
    expect(at("2025-12-30T09:00:00Z")).toBe("30 Dec 2025");
  });

  it("distinguishes the same day-and-month across years", () => {
    // Without the year suffix these two collapse onto one stamp.
    expect(at("2026-02-14T09:00:00Z")).not.toBe(at("2025-02-14T09:00:00Z"));
  });

  it("dates a future row rather than calling it a weekday", () => {
    // A resurfaced/scheduled row. "Fri" reads as the past for something that has not happened.
    expect(at("2026-08-07T09:00:00Z")).toBe("7 Aug");
  });

  it("still hands fixture rows their verbatim stamp", () => {
    expect(messageDisplayTime({ time: "09:12", date: "2020-01-01T00:00:00Z" } as never, NOW, "UTC")).toBe("09:12");
  });

  it("answers empty for a missing or unparseable date rather than 'Invalid Date'", () => {
    expect(messageDisplayTime({} as never, NOW, "UTC")).toBe("");
    expect(at("not-a-date")).toBe("");
  });

  it("a letter with no Date header, or one dated after it arrived, shows its arrival", () => {
    // `sortAt` is the arrival for both (`sortAtOf`): a header two days ahead is not when it came.
    const arrived = "2026-08-02T09:07:00Z";
    const show = (date: string | null) => messageDisplayTime({ date, sortAt: arrived } as never, NOW, "UTC");
    expect(show(null)).toBe("09:07");
    expect(show("not-a-date")).toBe("09:07");
    expect(show("2026-08-04T09:07:00Z")).toBe("09:07");
    // A header at or before its sort instant is still what the row shows, a week-old one included.
    expect(show("2026-08-02T09:05:00Z")).toBe("09:05");
    expect(show("2026-07-26T09:00:00Z")).toBe("26 Jul");
    // The exact forms and the rail date the same instant (`shownDateOf`).
    expect(shownDateOf({ date: "2026-08-04T09:07:00Z", sortAt: arrived })).toBe(arrived);
    expect(shownDateOf({ date: null, sortAt: arrived })).toBe(arrived);
    expect(shownDateOf({ date: "2026-08-02T09:05:00Z", sortAt: arrived })).toBe("2026-08-02T09:05:00Z");
  });

  it("reads the same instant differently in a different zone — the parameter is load-bearing", () => {
    /* 23:59 UTC on 2 August is 01:59 on the 3rd in Zurich, which is TOMORROW relative to `NOW`.
       A future row is dated rather than named, so the two zones disagree about both the clock and
       the band. If this ever matches the UTC line above, the zone is being ignored. */
    const late = { date: "2026-08-02T23:59:00Z" } as never;
    expect(messageDisplayTime(late, NOW, "UTC")).toBe("23:59");
    expect(messageDisplayTime(late, NOW, "Europe/Zurich")).toBe("3 Aug");
  });
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* A SET TIME: a resurface on 25 Dec read "Fri 10:00" on a Friday afternoon — seven
   hours overdue to the reader, three months away in fact. The bands above, either side of now,
   with the clock on every one. */
describe("appointmentStamp", () => {
  const FRIDAY = new Date("2026-09-25T15:35:00Z");
  const set = (iso: string, zone = "UTC") => appointmentStamp(new Date(iso), FRIDAY, zone);

  it("names the date of a set time past this week — 25 Dec is not this Friday", () => {
    expect(set("2026-12-25T10:00:00Z")).toBe("25 Dec, 10:00");
  });

  it("shows the clock alone today, the weekday inside the week either side", () => {
    expect(set("2026-09-25T18:00:00Z")).toBe("18:00");
    expect(set("2026-10-01T09:00:00Z")).toBe("Thu 09:00");
    expect(set("2026-09-19T09:00:00Z")).toBe("Sat 09:00");
  });

  it("ends the weekday band on the seventh day, where the weekday repeats", () => {
    expect(set("2026-10-02T09:00:00Z")).toBe("2 Oct, 09:00");
    expect(set("2026-09-18T09:00:00Z")).toBe("18 Sep, 09:00");
  });

  it("adds the year outside the current one", () => {
    expect(set("2027-01-08T09:00:00Z")).toBe("8 Jan 2027, 09:00");
  });

  it("bands on the reader's midnights", () => {
    expect(set("2026-09-25T22:30:00Z")).toBe("22:30");
    expect(set("2026-09-25T22:30:00Z", "Europe/Zurich")).toBe("Sat 00:30");
  });
});
