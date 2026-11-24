/**
 * What a stranger's letter can cost a reading: every step is counted (every look at a token among
 * them), the count grows no faster than the text, the costliest text known in a given language is
 * half the ceiling and the costliest letter known, its language left to its words, stays under it, a
 * reading that runs out of steps offers nothing, and no pattern runs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FOUND_STEPS, MAX_FOUND_SUBJECT_CHARS, MAX_FOUND_TEXT_CHARS } from "@ohmail/cal-core";
import { readFound } from "@ohmail/cal-core/found/rules";
import type { FoundLanguage, FoundLimits, FoundReading } from "@ohmail/cal-core/found/types";
import { intlZones } from "@ohmail/cal-core/time/zones";
import { NOW, SENT } from "./corpus/letters.js";
import { at } from "./support.js";

const zones = intlZones();
const UNBOUNDED: FoundLimits = { maxTextChars: 10 * MAX_FOUND_TEXT_CHARS, maxSteps: Number.MAX_SAFE_INTEGER };

const read = (
  body: string,
  limits?: FoundLimits,
  language: FoundLanguage | null = "en",
  subject = "",
): FoundReading =>
  readFound(
    { subject, body, sentAt: { kind: "instant", epochMs: at(SENT) }, language, place: "ohbox" },
    { zone: "Europe/Zurich", now: { kind: "instant", epochMs: at(NOW) }, zones },
    limits,
  );

/** The steps a character may cost: the ceiling is twice the costliest text, subject and body at theirs. */
const PER_CHAR = Math.ceil(MAX_FOUND_STEPS / 2 / (MAX_FOUND_SUBJECT_CHARS + MAX_FOUND_TEXT_CHARS));

/** The costliest unit known: a number and a dash, which every day and clock form tries to read on. */
const COSTLIEST = "1-";

/** The costliest whole letter known: `COSTLIEST` at the ceilings, the language told from three stop words. */
const COSTLIEST_LETTER_STEPS = 325_861;

/** Units a hostile line repeats: pairs to match, dates to resolve, ranges to read, breaks to decide. */
const UNITS: readonly (readonly [string, FoundLanguage])[] = [
  [COSTLIEST, "en"],
  // one long line of plain words: a form that scanned ahead to the line's end would cost its square
  ["x ", "en"],
  ["Sunday at 10:00 ", "en"],
  ["Sat 21 Nov 2026, 19:30 ", "en"],
  ["7-9pm ", "en"],
  ["1-1-1 ", "en"],
  ["1.1.", "en"],
  ["Sunday\n", "en"],
  ["\n", "en"],
  ["Sa., 21.11.2026, 19:30 Uhr ", "de"],
  ["am 1. ", "de"],
  ["1.1. Das ", "de"],
  ["2026. A ", "en"],
  ["in two weeks on Sunday ", "en"],
  ["Saturday after next ", "en"],
  ["in zwei Wochen am Samstag ", "de"],
  ["1-1:11 in the evening (UTC+1) ", "en"],
  ["1 bis 1 Uhr am Abend ", "de"],
  ["\nTime: 19:30", "en"],
  ["\nZeit: 1", "de"],
  ["läuft ab ", "de"],
  // the forms of the look before landing: dotted ranges, zones in words, cancels, the past, hours, due
  ["9.00 – 16.00 Uhr ", "de"],
  ["x 1 bis 1 Uhr ", "de"],
  ["1.5 bis 1 Uhr ", "de"],
  ["1pm x time ", "en"],
  ["1 Uhr Xer Zeit ", "de"],
  ["fällt aus ", "de"],
  ["was Friday at 1pm ", "en"],
  ["Opening hours Saturday 1pm ", "en"],
  ["bis und mit 1. ", "de"],
  // the forms of its recheck: a number of its own, "to", "postponed to", hours words, "zwischen … und"
  ["Raum 1.11-", "de"],
  ["room 1-1pm ", "en"],
  ["Zimmer Nr. 1-1 Uhr ", "de"],
  ["x to 1pm ", "en"],
  ["postponed to 1 ", "en"],
  ["Ladenöffnungszeiten 1-", "de"],
  ["store times 1-", "en"],
  ["zwischen 1 und 1 Uhr ", "de"],
  ["between 1 and 1pm ", "en"],
  // the forms of its third recheck: a range behind a room's number, past twelve, "up to", a postponement
  ["Raum 1 – 1–1 Uhr ", "de"],
  ["room 1 - 1pm - 1pm ", "en"],
  ["13-1pm ", "en"],
  ["up to 1pm - 1pm ", "en"],
  ["up to noon-", "en"],
  ["postponed to a later 1 ", "en"],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what a letter costs to read", () => {
  it("stops a long line at its count of steps, offers nothing and says so", () => {
    const r = read("Sunday at 10:00, ".repeat(2_000), { maxTextChars: MAX_FOUND_TEXT_CHARS, maxSteps: 500 });
    expect(r.stoppedBy).toBe("steps");
    expect(r.spent).toBeLessThanOrEqual(501);
    expect(r.findings).toEqual([]);
    expect(r.notOffered).toEqual([]);
    expect(r.askable).toEqual([]);
  });

  for (const [unit, language] of UNITS) {
    it(`grows exactly with the text: ${JSON.stringify(unit)}`, () => {
      const spent = [100, 200, 300].map((n) => read(unit.repeat(n), UNBOUNDED, language).spent);
      expect(spent[1]! - spent[0]!).toBe(spent[2]! - spent[1]!);
      expect(spent[1]! - spent[0]!).toBeLessThanOrEqual(PER_CHAR * 100 * unit.length);
    });
  }

  it("reads a text at its ceiling within half the ceiling of steps", () => {
    for (const [unit, language] of UNITS) {
      const fill = (n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
      const r = read(fill(MAX_FOUND_TEXT_CHARS), undefined, language, fill(MAX_FOUND_SUBJECT_CHARS));
      expect(r.stoppedBy, unit).toBeNull();
      expect(r.spent, unit).toBeLessThanOrEqual(MAX_FOUND_STEPS / 2);
    }
  });

  it("pays for every look: the costliest text known is the ceiling's half", () => {
    const fill = (n: number) => COSTLIEST.repeat(n / COSTLIEST.length);
    const r = read(fill(MAX_FOUND_TEXT_CHARS), undefined, "en", fill(MAX_FOUND_SUBJECT_CHARS));
    expect(r.spent).toBe(MAX_FOUND_STEPS / 2);
  });

  it("reads the costliest letter known, its language left to its words, under the ceiling", () => {
    // Three stop words first, so the language is told from the words: the scan for it looks at every
    // token once more. The look before landing measured it, and again after each fix round (limits.ts);
    // it is the ceiling's 52.6 %.
    const fill = (n: number) => COSTLIEST.repeat(n / COSTLIEST.length);
    const subject = `we we we ${fill(MAX_FOUND_SUBJECT_CHARS)}`.slice(0, MAX_FOUND_SUBJECT_CHARS);
    const r = read(fill(MAX_FOUND_TEXT_CHARS), undefined, null, subject);
    expect(r.anchor?.language).toBe("en");
    expect(r.stoppedBy).toBeNull();
    expect(r.spent).toBe(COSTLIEST_LETTER_STEPS);
    expect(r.spent).toBeLessThan(MAX_FOUND_STEPS);
  });

  it("runs no pattern while it reads", () => {
    read("warm the zone source", undefined); // the zone source keeps its formatter; asking it again runs nothing
    const calls = [
      vi.spyOn(RegExp.prototype, "exec"),
      vi.spyOn(RegExp.prototype, "test"),
      vi.spyOn(RegExp.prototype, Symbol.match),
      vi.spyOn(RegExp.prototype, Symbol.matchAll),
      vi.spyOn(RegExp.prototype, Symbol.replace),
      vi.spyOn(RegExp.prototype, Symbol.search),
      vi.spyOn(RegExp.prototype, Symbol.split),
    ];
    const r = read("Lunch on Sunday? And the concert, Saturday, 21 November 2026 at 19:30.\n> quoted");
    const de = read("Ihre Karten für Samstag, 21. November 2026, Einlass 19:00 Uhr.", undefined, "de");
    const counted = calls.map((c) => c.mock.calls.length); // before any assertion, which may run patterns of its own
    vi.restoreAllMocks();
    expect(r.findings.map((f) => f.key)).toEqual(["2026-11-21T19:30"]);
    expect(de.findings).toHaveLength(1);
    expect(counted).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
