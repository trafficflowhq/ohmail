/**
 * The date grammar's forms, one sentence at a time, in English and German. Each sentence is read as
 * a letter sent on Tuesday 10 November 2026 at 09:00 in Zurich and read an hour later.
 */
import { describe, expect, it } from "vitest";
import { readFound } from "@ohmail/cal-core/found/rules";
import type { FoundLanguage, FoundReading } from "@ohmail/cal-core/found/types";
import { intlZones } from "@ohmail/cal-core/time/zones";
import { NOW, SENT } from "./corpus/letters.js";
import { at } from "./support.js";

const zones = intlZones();

const read = (language: FoundLanguage, body: string): FoundReading =>
  readFound(
    { subject: "", body, sentAt: { kind: "instant", epochMs: at(SENT) }, language, place: "ohbox" },
    { zone: "Europe/Zurich", now: { kind: "instant", epochMs: at(NOW) }, zones },
  );

/** The finding's key, else the first word for what was not offered, else `null` for nothing at all. */
function outcome(r: FoundReading): string | null {
  return r.findings[0]?.key ?? r.notOffered[0]?.why ?? null;
}

const FORMS: readonly (readonly [FoundLanguage, string, string | null])[] = [
  // whole dates, month named
  ["en", "the 21st of November 2026 at 19:30", "2026-11-21T19:30"],
  ["en", "November 21st, 2026 at 6:30 pm", "2026-11-21T18:30"],
  ["en", "21 Nov at 19:30", "2026-11-21T19:30"],
  ["en", "on 3 January at 10:00", "2027-01-03T10:00"],
  ["en", "Sat 21 Nov 2026, 19:30", "2026-11-21T19:30"],
  ["de", "am 21. November um 19:30", "2026-11-21T19:30"],
  ["de", "Samstag, den 21. November 2026, 19:30 Uhr", "2026-11-21T19:30"],
  // whole dates, numeric
  ["en", "on 2026-11-21 at 19:30", "2026-11-21T19:30"],
  ["en", "on 21/11/2026 at 19:30", "2026-11-21T19:30"],
  ["en", "on 11/21/2026 at 19:30", "2026-11-21T19:30"],
  ["en", "on 5/5/2027 at 10:00", "2027-05-05T10:00"],
  ["de", "am 21.11. um 19:30", "2026-11-21T19:30"],
  ["de", "am 21.11.26 um 19:30", "2026-11-21T19:30"],
  ["de", "Sa., 21.11.2026, 19:30 Uhr", "2026-11-21T19:30"],
  ["de", "am 07/08/2027 um 19:30", "2027-08-07T19:30"],
  ["en", "version 1.2.3.4 ships on Sunday at 10:00", "2026-11-15T10:00"],
  ["de", "Version 1.2.3 erscheint", null],
  // weekdays and relative days
  ["en", "See you Sat at 19:30", null],
  ["en", "today at 20:00", "2026-11-10T20:00"],
  ["en", "the day after tomorrow at 9:00", "2026-11-12T09:00"],
  ["en", "this Sunday at 12:30", "2026-11-15T12:30"],
  ["en", "on Tuesday at 12:30", "2026-11-17T12:30"],
  ["de", "Sonnabend um 10 Uhr", "2026-11-14T10:00"],
  ["de", "heute um 18 Uhr", "2026-11-10T18:00"],
  ["de", "am kommenden Freitag um 18 Uhr", "2026-11-13T18:00"],
  ["de", "am Morgen um 10 Uhr", null],
  ["de", "Guten Morgen um 10 Uhr", null],
  ["de", "Montag morgen um 8 Uhr", "2026-11-16T08:00"],
  ["en", "next Sunday at 10:00", "ambiguous_day"],
  ["de", "nächsten Sonntag um 12 Uhr", "ambiguous_day"],
  ["en", "last Sunday at 12:30", null],
  ["en", "yesterday at 10:00", null],
  ["de", "letzten Freitag um 10 Uhr", null],
  ["de", "gestern um 10 Uhr", null],
  ["en", "next week at 10:00", null],
  ["de", "am 10. oder am Sonntag um 12 Uhr", "two_dates"],
  ["en", "Sunday at 10:00 or next week", "two_dates"],
  ["en", "Monday to Friday at 10:00", "two_dates"],
  ["en", "on 21 to 23 November", "two_dates"],
  // clocks
  ["en", "Sunday at 7.30 pm", "2026-11-15T19:30"],
  ["en", "Sunday at 10 a.m.", "2026-11-15T10:00"],
  ["en", "Sunday at 10am", "2026-11-15T10:00"],
  ["en", "Sunday at 12 am", "2026-11-15T00:00"],
  ["en", "Sunday at noon", "2026-11-15T12:00"],
  ["en", "Sunday at 12 o'clock", "2026-11-15T12:00"],
  ["en", "Sunday at 3 o'clock", "weekday_no_time"],
  ["en", "Sunday at 7:30", "2026-11-15T19:30"],
  ["en", "Sunday at 07:30", "2026-11-15T07:30"],
  ["en", "Sunday 7–9pm", "2026-11-15T19:00"],
  ["de", "um 7.30 Uhr am Sonntag", "2026-11-15T07:30"],
  ["de", "um 20 Uhr am 21.11.", "2026-11-21T20:00"],
  ["de", "nachmittags um 3 Uhr am Sonntag", "2026-11-15T15:00"],
  ["de", "um halb acht am Sonntag", "weekday_no_time"],
  ["en", "Sunday, a 2:30 h walk", "weekday_no_time"],
  ["en", "Sunday, from $5 pm", "weekday_no_time"],
  ["en", "Sunday at 19:00 CET", "other_zone"],
  ["en", "Sunday at 19:00 (UTC+1)", "other_zone"],
  // a number after a word that starts no clock, and an end with no start, are no start (the look)
  ["de", "Der Workshop ist am Samstag, 21. November 2026 in Raum 5 bis 17 Uhr.", "2026-11-21"],
  ["de", "Der Workshop ist am Samstag, 21. November 2026 in Raum 1.5 bis 17 Uhr.", "2026-11-21"],
  ["en", "The workshop is on Saturday, 21 November 2026 in room 1.5 until 5pm.", "2026-11-21"],
  ["en", "The workshop is on Saturday, 21 November 2026, 10 to 12:00.", "2026-11-21"],
  ["en", "We are open on Saturday, 21 November 2026 up to 5pm - 6pm.", "2026-11-21"],
  ["en", "We are open on Saturday, 21 November 2026 up to noon - 9:30.", "2026-11-21"],
  ["en", "We are open on Saturday, 21 November 2026 up to 5pm, doors at 3pm.", "2026-11-21T15:00"],
  // a range after a word that takes a number of its own is passed over whole, its end never a start
  ["de", "Der Workshop ist am Samstag, 21. November 2026 in Raum 5 – 17:00.", "2026-11-21"],
  ["de", "Der Workshop ist am Samstag, 21. November 2026, Zimmer Nr. 5 – 17 Uhr.", "2026-11-21"],
  ["en", "The workshop is on Saturday, 21 November 2026, gate 12 - 14:00.", "2026-11-21"],
  ["en", "The workshop is on Saturday, 21 November 2026, room No. 5 - 7pm.", "2026-11-21"],
  // after its number and dash, a range of its own is read; one whose half is only guessed is passed over
  ["de", "Der Workshop ist am Samstag, 21. November 2026, Raum 5 – 14 bis 16 Uhr.", "2026-11-21T14:00"],
  ["en", "The workshop is on Saturday, 21 November 2026, room 5 - 7:30-21:30.", "2026-11-21"],
  ["en", "The workshop is on Saturday, 21 November 2026, room 5 - 7:30 till 21:30.", "2026-11-21"],
  [
    "en",
    "On Sunday we will finally, after all these long weeks of waiting and planning, meet at 10:00",
    "weekday_no_time",
  ],
];

/**
 * A range whose start is written with dotted minutes and no marker of its own, the usual Swiss and
 * German way, in the look's course letter: the start and the end the words give.
 */
const RANGES: readonly (readonly [FoundLanguage, string, string, string])[] = [
  ["de", "9.00 – 16.00 Uhr", "09:00", "16:00"],
  ["de", "10.00-12.00 Uhr", "10:00", "12:00"],
  ["de", "19.30–21.00 Uhr", "19:30", "21:00"],
  ["de", "von 19.30 bis 21.00 Uhr", "19:30", "21:00"],
  ["de", "19.30 bis 21 Uhr", "19:30", "21:00"],
  ["de", "8.15 bis 9.45 Uhr", "08:15", "09:45"],
  ["de", "9.30-11 Uhr", "09:30", "11:00"],
  ["en", "7.30-9pm", "19:30", "21:00"],
  ["en", "7.30 to 9.30 pm", "19:30", "21:30"],
  ["en", "9.30-11am", "09:30", "11:00"],
];

const course = (language: FoundLanguage, words: string): string =>
  language === "de"
    ? `Der Kurs ist am Samstag, 21. November 2026, ${words} im Saal.`
    : `The course is on Saturday, 21 November 2026, ${words} in the hall.`;

describe("the date grammar's forms", () => {
  for (const [language, sentence, expected] of FORMS) {
    it(`${language}: ${sentence}`, () => {
      expect(outcome(read(language, sentence))).toBe(expected);
    });
  }

  for (const [language, words, start, end] of RANGES) {
    it(`${language}: a range ${words}`, () => {
      const found = read(language, course(language, words)).findings[0];
      expect(found?.key).toBe(`2026-11-21T${start}`);
      expect(found?.level).toBe("dated");
      expect(found?.event.endGiven).toBe(true);
      const wall = found?.event.end?.kind === "zoned" ? found.event.end.wall : null;
      const p = (n: number) => String(n).padStart(2, "0");
      expect(wall === null ? null : `${p(wall.hour)}:${p(wall.minute)}`).toBe(end);
    });
  }

  it("reads an end from a range, and drops one that is not after the start", () => {
    const ranged = read("en", "Sunday from 10:00 to 12:00").findings[0]!;
    expect(ranged.event.endGiven).toBe(true);
    expect(ranged.event.end).toMatchObject({ wall: { hour: 12, minute: 0 } });
    const backwards = read("en", "Sunday from 12:00 to 10:00").findings[0]!;
    expect(backwards.event.endGiven).toBe(false);
    expect(backwards.event.end).toMatchObject({ wall: { hour: 13, minute: 0 } });
    const late = read("en", "Sunday 11–1pm").findings[0]!;
    expect(late.event.start).toMatchObject({ wall: { hour: 11 } });
    expect(late.event.end).toMatchObject({ wall: { hour: 13 } });
  });

  it("asks only about a sentence with a time in it the rules could not read", () => {
    expect(read("en", "Sunday at 3 o'clock").askable).toHaveLength(1);
    expect(read("de", "Sonntag um zwölf").askable).toHaveLength(1);
    expect(read("de", "am Sonntag um zwölf Uhr").askable).toHaveLength(1);
    expect(read("en", "See you on Sunday").askable).toHaveLength(0);
    expect(read("en", `Sunday at twelve, ${"and so on ".repeat(60)}`).askable).toHaveLength(0);
    expect(read("en", "Sunday at twelve.\nMonday at one.\nFriday at two.").askable).toHaveLength(2);
  });

  it("keeps a sentence open over a stop after a number or an abbreviation", () => {
    expect(outcome(read("de", "am So. 15. Nov. um 12 Uhr"))).toBe("2026-11-15T12:00");
    expect(outcome(read("en", "Sunday. At 10:00"))).toBe("weekday_no_time");
  });
});
