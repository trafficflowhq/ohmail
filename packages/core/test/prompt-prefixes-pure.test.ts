import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as mail from "../src/mail.js";
import * as classify from "../src/ai/classify.js";
import * as draft from "../src/ai/draft.js";

/**
 * THE FOUR PROMPT CONSTANTS ARE PINNED WHERE THEY ARE USED. Each top-level call carries a pure
 * annotation so a bundle that never asks a model (the phone engine) drops the text; the digest pins the
 * exact prompt text and screening destinations used by the current model requests.
 */
const digest = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const EXPECTED = {
  TAXONOMY_PREFIX: "1578eddc020dada5496db04a51b9d37fa3fd2da75638cad25b5cd378bc548eb4",
  SCREENING_PREFIX: "322c58755839dfa037366e88684c6104df2bda2493006d36615aa95e5600c4ba",
  DRAFT_PREFIX: "c07cf98d8dbcc0c6ee8e06c7aec0a37666e6e22cd1e7a6423388006db17a675a",
  SCREEN_DESTINATIONS: "9bbccf79cc7347ffa9c68857318c3185180b3a9aa97ecfd7fcdf7924d89c6c20",
};

describe("the prompt constants read the same where a model is asked", () => {
  it("the classifier and the screener use the pinned prompts and destinations", () => {
    expect(digest(classify.TAXONOMY_PREFIX)).toBe(EXPECTED.TAXONOMY_PREFIX);
    expect(digest(classify.SCREENING_PREFIX)).toBe(EXPECTED.SCREENING_PREFIX);
    expect(digest(classify.SCREEN_DESTINATIONS)).toBe(EXPECTED.SCREEN_DESTINATIONS);
  });

  it("the drafter uses the pinned prompt", () => {
    expect(digest(draft.DRAFT_PREFIX)).toBe(EXPECTED.DRAFT_PREFIX);
  });

  it("the mail leaf hands out the same values the model calls read", () => {
    expect(mail.TAXONOMY_PREFIX).toBe(classify.TAXONOMY_PREFIX);
    expect(mail.SCREENING_PREFIX).toBe(classify.SCREENING_PREFIX);
    expect(mail.SCREEN_DESTINATIONS).toBe(classify.SCREEN_DESTINATIONS);
    expect(mail.DRAFT_PREFIX).toBe(draft.DRAFT_PREFIX);
  });
});
