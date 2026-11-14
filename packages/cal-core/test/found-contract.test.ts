/**
 * The found-events contract: the closed word lists the store and the ingest share, and the levels
 * and kinds a letter's words can never give.
 */
import { describe, expect, it } from "vitest";
import * as whole from "@ohmail/cal-core";
import * as found from "@ohmail/cal-core/found/types";
import type { FoundKind, FoundLevel, WordsKind, WordsLevel } from "@ohmail/cal-core/found/types";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const holds = <T extends true>(): T => true as T;

describe("the found-events contract", () => {
  it("pins the word lists the store and the ingest read", () => {
    expect(found.FOUND_LEVELS).toEqual(["exact", "dated", "guess"]);
    expect(found.FOUND_KINDS).toEqual(["ticket", "booking", "delivery", "appointment", "proposal"]);
    expect(found.FOUND_EVIDENCE).toEqual(["calendar", "data", "sentence", "sentence_model"]);
    expect(found.FOUND_LANGUAGES).toEqual(["en", "de"]);
    expect(found.FOUND_PLACES).toEqual(["ohbox", "receipts", "news"]);
    expect(found.NOT_OFFERED).toEqual([
      "place",
      "in_news",
      "language",
      "zone_unknown",
      "letter_date",
      "passed",
      "far_ahead",
      "due",
      "two_dates",
      "weekday_no_time",
      "bare_date",
      "weekday_disagrees",
      "ambiguous_date",
      "ambiguous_day",
      "other_zone",
    ]);
    expect(found.FOUND_DROPS).toEqual([
      "malformed",
      "none_found",
      "not_asked",
      "words_not_in_letter",
      "day_not_in_words",
      "no_time",
      "time_not_in_words",
      "passed",
      "far_ahead",
    ]);
    expect(found.FOUND_DEFAULT_LENGTH_MINUTES).toBe(60);
    expect(found.DEFAULT_FOUND_LIMITS).toEqual({
      maxTextChars: whole.MAX_FOUND_TEXT_CHARS,
      maxSteps: whole.MAX_FOUND_STEPS,
    });
  });

  it("gives words no exact level and no booking", () => {
    expect(holds<Same<WordsLevel, "dated" | "guess">>()).toBe(true);
    expect(holds<Same<WordsKind, "ticket" | "delivery" | "appointment" | "proposal">>()).toBe(true);
    expect(holds<Same<Exclude<FoundLevel, WordsLevel>, "exact">>()).toBe(true);
    expect(holds<Same<Exclude<FoundKind, WordsKind>, "booking">>()).toBe(true);
  });

  it("opens by its own door and by the package's name, as one module", () => {
    expect(found.FOUND_LEVELS).toBe(whole.FOUND_LEVELS);
    expect(found.NOT_OFFERED).toBe(whole.NOT_OFFERED);
    expect(found.DEFAULT_FOUND_LIMITS).toBe(whole.DEFAULT_FOUND_LIMITS);
  });
});
