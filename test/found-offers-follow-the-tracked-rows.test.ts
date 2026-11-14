import { describe, expect, it } from "vitest";
import { FOUND_EVIDENCE } from "@ohmail/cal-core";
import { OFFERED_EVIDENCE, mayOffer } from "@ohmail/app-logic/calendar/found";
import { TRIED } from "../packages/cal-core/test/corpus/tried";

/**
 * WHAT FROM MAIL MAY OFFER FOLLOWS THE TRACKED WRONG READINGS. While any letter the found-events rules were tried on
 * still carries a reading they owe (a row marked `owed`), no reading of a letter's sentences is offered to a person:
 * a stored suggestion cannot tell a right reading of its sentences from one of those. Here and not under the app,
 * because the corpus is the calendar package's test data. Once the last mark is gone, this case says so, and the
 * gate may be widened by its own ruling.
 */
describe("the offers from mail and the tracked readings", () => {
  const owed = TRIED.filter((row) => row.owed !== undefined);

  it("offers no reading of a letter's sentences while a tracked reading is owed", () => {
    expect(owed.length).toBeGreaterThan(0);
    const sentences = FOUND_EVIDENCE.filter((e) => e === "sentence" || e === "sentence_model");
    expect(sentences).toEqual(["sentence", "sentence_model"]);
    for (const evidence of sentences) {
      expect(OFFERED_EVIDENCE as readonly string[]).not.toContain(evidence);
      expect(mayOffer({ evidence })).toBe(false);
    }
  });

  it("names in the gate only evidence the found-events module knows", () => {
    for (const evidence of OFFERED_EVIDENCE) expect(FOUND_EVIDENCE as readonly string[]).toContain(evidence);
  });
});
