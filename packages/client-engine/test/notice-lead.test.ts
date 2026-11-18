/**
 * HOW AN ALERT SAYS ITS LEAD. A lead is a whole number of minutes from none to four weeks: the
 * product's own steps, and whatever alarm an event already has at its provider. Every such number
 * has words that are true for it; anything else has none, so no alert is made for it. The table is
 * the desktop shell's too.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOTICE_LEAD_MAX_MIN, leadWords, type LeadWords } from "@ohmail/client-engine";

const TABLE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "notice-lead-words.json"), "utf8")) as {
  rows: { leadMin: number; allDay: boolean; as: LeadWords["as"]; count: number | null }[];
};

/** The minutes the words stand for, read back: what makes them true. */
function minutesOf(words: LeadWords): number {
  if (!("count" in words)) return words.as === "tomorrow" ? 1440 : 0;
  return words.count * { minutes: 1, hours: 60, days: 1440, weeks: 10_080 }[words.as];
}

describe("an alert's lead in words", () => {
  it("says each lead as the table the desktop's shell reads too says", () => {
    expect(TABLE.rows.length).toBeGreaterThan(30);
    for (const row of TABLE.rows) {
      const want = row.count === null ? { as: row.as } : { as: row.as, count: row.count };
      expect(leadWords(row.leadMin, row.allDay), `${row.leadMin} ${row.allDay ? "all day" : "timed"}`).toEqual(want);
    }
  });

  it("is true for every whole number of minutes in the range: the same minutes for a time of day, the day count for a whole day", () => {
    for (let lead = 0; lead <= NOTICE_LEAD_MAX_MIN; lead += 1) {
      const timed = leadWords(lead, false)!;
      if (minutesOf(timed) !== lead) throw new Error(`${lead} minutes is said as ${JSON.stringify(timed)}`);
      if ("count" in timed && timed.count < 1) throw new Error(`${lead}: a count under one`);
      const day = leadWords(lead, true)!;
      if (minutesOf(day) !== Math.ceil(lead / 1440) * 1440) throw new Error(`${lead} minutes before a whole day is said as ${JSON.stringify(day)}`);
      if (day.as === "minutes" || day.as === "hours" || day.as === "now") throw new Error(`${lead}: a whole day said by the clock`);
    }
  });

  it("has no words for anything that is not such a number", () => {
    for (const lead of [-1, -0.5, 1.5, NOTICE_LEAD_MAX_MIN + 1, Number.NaN, Number.POSITIVE_INFINITY, "10" as never, null as never]) {
      expect(leadWords(lead, false), String(lead)).toBeNull();
      expect(leadWords(lead, true), String(lead)).toBeNull();
    }
  });
});
