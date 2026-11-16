/**
 * The model's half: the one text that may leave, the input that exists only behind an admitted
 * screen, the closed answer schema, and the check that never lets an answer be more than a guess
 * whose words stand in the letter and whose day and time follow from them.
 */
import { describe, expect, it } from "vitest";
import {
  checkFoundAnswer,
  FOUND_EVENT_INSTRUCTION,
  FOUND_EVENT_RESULT_SCHEMA,
  foundModelInput,
  foundModelText,
  foundModelUserTurn,
} from "@ohmail/cal-core/found/model";
import { readFound } from "@ohmail/cal-core/found/rules";
import type { FoundContext, FoundLanguage, FoundModelPort, FoundReading } from "@ohmail/cal-core/found/types";
import { intlZones } from "@ohmail/cal-core/time/zones";
import { NOW, SENT } from "./corpus/letters.js";
import { at } from "./support.js";

const zones = intlZones();
const context: FoundContext = { zone: "Europe/Zurich", now: { kind: "instant", epochMs: at(NOW) }, zones };

const read = (body: string, language: FoundLanguage = "en", now = NOW): FoundReading =>
  readFound(
    { subject: "Lunch", body, sentAt: { kind: "instant", epochMs: at(SENT) }, language, place: "ohbox" },
    { ...context, now: { kind: "instant", epochMs: at(now) } },
  );

const LUNCH = "Sunday lunch at Mum's, at twelve, she says. Bring the salad.";
const answer = (o: Partial<Record<"found" | "words" | "day" | "start" | "end", unknown>> = {}) => ({
  found: true,
  words: "Sunday lunch at Mum's, at twelve",
  day: "2026-11-15",
  start: "12:00",
  end: "",
  ...o,
});
const ADMITTED = { admitted: true } as const;

/** Every object of a schema that is not closed, or whose `required` is not its every property. */
function openings(schema: unknown, path = "$"): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const n = schema as Record<string, unknown>;
  const out: string[] = [];
  if (n.type === "object" || "properties" in n) {
    if (n.additionalProperties !== false) out.push(`${path}: additionalProperties is not false`);
    const props = Object.keys((n.properties ?? {}) as object).sort();
    const req = Array.isArray(n.required) ? [...(n.required as string[])].sort() : [];
    if (JSON.stringify(req) !== JSON.stringify(props)) out.push(`${path}: required is not every property`);
    for (const [k, v] of Object.entries((n.properties ?? {}) as object))
      out.push(...openings(v, `${path}.${k}`));
  }
  if (Array.isArray(n.type)) out.push(`${path}: more than one type`);
  for (const bound of ["minimum", "maximum", "minLength", "maxLength", "pattern", "anyOf", "oneOf"])
    if (bound in n) out.push(`${path}: ${bound}`);
  return out;
}

describe("what may leave for a model", () => {
  it("is the askable sentences joined, or nothing when there is nothing to ask", () => {
    const r = read(`${LUNCH}\nOr next Sunday at 13:00?`);
    expect(foundModelText(r)).toBe("Sunday lunch at Mum's, at twelve, she says\nOr next Sunday at 13:00");
    expect(foundModelText(read("Party on Saturday, 21 November 2026 at 20:00."))).toBeNull();
    expect(foundModelText(read("See you on Sunday."))).toBeNull();
  });

  it("becomes an input only behind a screen that admitted it", () => {
    const r = read(LUNCH);
    for (const screen of [{ admitted: false }, { admitted: "true" }, {}, null, undefined])
      expect(foundModelInput(r, screen as unknown as typeof ADMITTED)).toBeNull();
    const input = foundModelInput(r, ADMITTED)!;
    expect(input).toEqual({
      text: "Sunday lunch at Mum's, at twelve, she says",
      letterDay: "2026-11-10",
      letterWeekday: "Tuesday",
      language: "en",
    });
    expect(input.text).toBe(foundModelText(r));
    expect(foundModelInput(read("Party on Saturday, 21 November 2026 at 20:00."), ADMITTED)).toBeNull();
  });

  it("is sent as one JSON user turn with its keys in one order", () => {
    const input = foundModelInput(read(LUNCH), ADMITTED)!;
    const turn = foundModelUserTurn(input);
    expect(Object.keys(JSON.parse(turn))).toEqual(["letterDay", "letterWeekday", "language", "text"]);
    expect(foundModelUserTurn({ ...input })).toBe(turn);
  });

  it("is asked through a port that is handed the input and the door's own call options", async () => {
    const seen: unknown[] = [];
    const port: FoundModelPort<{ readonly budget: number }> = {
      ask: async (input, call) => {
        seen.push([input.letterDay, call?.budget]);
        return answer();
      },
    };
    const r = read(LUNCH);
    const got = await port.ask(foundModelInput(r, ADMITTED)!, { budget: 1 });
    expect(seen).toEqual([["2026-11-10", 1]]);
    expect(checkFoundAnswer(got, r, context).ok).toBe(true);
  });

  it("has a closed answer schema with no level, kind or title, and a fixed instruction", () => {
    expect(openings(FOUND_EVENT_RESULT_SCHEMA)).toEqual([]);
    expect(Object.keys(FOUND_EVENT_RESULT_SCHEMA.properties)).toEqual([
      "found",
      "words",
      "day",
      "start",
      "end",
    ]);
    expect(openings({ ...FOUND_EVENT_RESULT_SCHEMA, additionalProperties: true })).toHaveLength(1);
    expect(openings({ ...FOUND_EVENT_RESULT_SCHEMA, required: ["found"] })).toHaveLength(1);
    expect(typeof FOUND_EVENT_INSTRUCTION).toBe("string");
    expect(FOUND_EVENT_INSTRUCTION.length).toBeGreaterThan(0);
  });
});

describe("the check of a model's answer", () => {
  const r = read(LUNCH);

  it("makes a guess and a proposal of a sound answer, with the quote's own place in the letter", () => {
    const check = checkFoundAnswer(answer(), r, context);
    if (!check.ok) throw new Error(check.dropped);
    const f = check.finding;
    expect([f.key, f.level, f.kind, f.evidence, f.free]).toEqual([
      "2026-11-15T12:00",
      "guess",
      "proposal",
      "sentence_model",
      false,
    ]);
    expect(f.words.map((w) => r.text.slice(w.start, w.end))).toEqual(["Sunday lunch at Mum's, at twelve"]);
    expect(f.event.endGiven).toBe(false);
    expect(f.event.end).toMatchObject({
      kind: "zoned",
      wall: { day: 15, hour: 13, minute: 0 },
      tzid: "Europe/Zurich",
    });
  });

  it("drops an answer of any other shape, a level above a guess included", () => {
    for (const bad of [
      null,
      "yes",
      [],
      { ...answer(), level: "dated" },
      { ...answer(), found: "true" },
      { found: true, words: "Sunday", day: "2026-11-15", start: "12:00" },
      answer({ start: 12 }),
    ])
      expect(checkFoundAnswer(bad, r, context)).toEqual({ ok: false, dropped: "malformed" });
    expect(checkFoundAnswer(answer({ found: false, words: "", day: "", start: "" }), r, context)).toEqual({
      ok: false,
      dropped: "none_found",
    });
  });

  it("drops words that do not stand in the letter character for character", () => {
    for (const words of [
      "sunday lunch at mum's, at twelve",
      "Sunday lunch at Mum's, at twelve ",
      "Sunday lunch at Mum’s, at twelve",
      "Sunday  lunch at Mum's",
      "Saturday lunch at Mum's",
      "",
      "x".repeat(241),
    ])
      expect(checkFoundAnswer(answer({ words }), r, context)).toEqual({
        ok: false,
        dropped: "words_not_in_letter",
      });
  });

  it("drops words that stand in the letter outside what was asked", () => {
    expect(r.askable).toHaveLength(1);
    expect(checkFoundAnswer(answer({ words: "Bring the salad" }), r, context)).toEqual({
      ok: false,
      dropped: "not_asked",
    });
  });

  it("drops a day the words do not give", () => {
    for (const day of ["2026-11-16", "2026-11-22", "2026-02-30", "15.11.2026", ""])
      expect(checkFoundAnswer(answer({ day }), r, context)).toEqual({
        ok: false,
        dropped: "day_not_in_words",
      });
    expect(checkFoundAnswer(answer({ words: "at twelve" }), r, context)).toEqual({
      ok: false,
      dropped: "day_not_in_words",
    });
  });

  it("admits both days of next Sunday", () => {
    const r2 = read("Lunch next Sunday at 13:00?");
    for (const day of ["2026-11-15", "2026-11-22"]) {
      const check = checkFoundAnswer(
        answer({ words: "next Sunday at 13:00", day, start: "13:00" }),
        r2,
        context,
      );
      expect(check.ok).toBe(true);
    }
  });

  it("drops a start that is missing, or that the words do not give", () => {
    expect(checkFoundAnswer(answer({ start: "" }), r, context)).toEqual({ ok: false, dropped: "no_time" });
    expect(checkFoundAnswer(answer({ start: "25:00" }), r, context)).toEqual({
      ok: false,
      dropped: "time_not_in_words",
    });
    expect(checkFoundAnswer(answer({ words: "Sunday lunch" }), r, context)).toEqual({
      ok: false,
      dropped: "time_not_in_words",
    });
    const r2 = read("Lunch next Sunday at 1:00?");
    const words = "next Sunday at 1:00";
    expect(checkFoundAnswer(answer({ words, start: "13:00" }), r2, context).ok).toBe(true);
    expect(checkFoundAnswer(answer({ words, start: "01:00" }), r2, context).ok).toBe(true);
    expect(checkFoundAnswer(answer({ words, start: "14:00" }), r2, context)).toEqual({
      ok: false,
      dropped: "time_not_in_words",
    });
  });

  it("drops a clock in another zone, and never asks about one", () => {
    const zoned = read("Shall we call next Monday at 15:00 UTC?");
    expect(zoned.notOffered.map((n) => n.why)).toEqual(["ambiguous_day"]);
    expect(zoned.askable).toEqual([]);
    const text = "Lunch\nShall we call next Monday at 15:00 UTC";
    const asked: FoundReading = { ...r, text, askable: [{ start: 6, end: text.length }] };
    const words = "next Monday at 15:00 UTC";
    expect(checkFoundAnswer(answer({ words, day: "2026-11-16", start: "15:00" }), asked, context)).toEqual({
      ok: false,
      dropped: "time_not_in_words",
    });
  });

  it("reads the half of the day a word beside the clock names", () => {
    const evening = read("Drinks next Friday evening at 8:30?");
    const words = "next Friday evening at 8:30";
    expect(checkFoundAnswer(answer({ words, day: "2026-11-13", start: "20:30" }), evening, context).ok).toBe(
      true,
    );
    expect(checkFoundAnswer(answer({ words, day: "2026-11-13", start: "08:30" }), evening, context)).toEqual({
      ok: false,
      dropped: "time_not_in_words",
    });
  });

  it("keeps an end the words give, and takes the default length for one they do not", () => {
    const r2 = read("Lunch next Sunday from 12:00 to 14:30?");
    const words = "next Sunday from 12:00 to 14:30";
    const given = checkFoundAnswer(answer({ words, start: "12:00", end: "14:30" }), r2, context);
    expect(given.ok && [given.finding.event.endGiven, given.finding.event.end]).toEqual([
      true,
      expect.objectContaining({ wall: expect.objectContaining({ hour: 14, minute: 30 }) }),
    ]);
    const invented = checkFoundAnswer(answer({ words, start: "12:00", end: "18:00" }), r2, context);
    expect(invented.ok && [invented.finding.event.endGiven, invented.finding.event.end]).toEqual([
      false,
      expect.objectContaining({ wall: expect.objectContaining({ hour: 13, minute: 0 }) }),
    ]);
  });

  it("drops a day that has passed by the reading time, or lies too far ahead", () => {
    const later = read(LUNCH, "en", "2026-11-16T09:00:00Z");
    expect(
      checkFoundAnswer(answer(), later, {
        ...context,
        now: { kind: "instant", epochMs: at("2026-11-16T09:00:00Z") },
      }),
    ).toEqual({
      ok: false,
      dropped: "passed",
    });
    const text = "Lunch\nthe reunion on 20.11.2032 at twelve";
    const far: FoundReading = { ...r, text, askable: [{ start: 6, end: text.length }] };
    expect(
      checkFoundAnswer(answer({ words: "on 20.11.2032 at twelve", day: "2032-11-20" }), far, context),
    ).toEqual({
      ok: false,
      dropped: "far_ahead",
    });
  });

  it("reads German quotes in German", () => {
    const de = read("Sonntag Mittagessen bei Mama, um zwölf.", "de");
    const check = checkFoundAnswer(answer({ words: "Sonntag Mittagessen bei Mama, um zwölf" }), de, context);
    expect(check.ok && check.finding.key).toBe("2026-11-15T12:00");
  });
});
