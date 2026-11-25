import { describe, expect, it, vi } from "vitest";
import {
  askScreeningQuestion, classifyUserPayload, screenerInputSize, SCREENER_INPUT_LIMIT,
} from "../src/classify-prompt.js";
import type { ClassifierInput, ClassifierPort } from "../src/classifier-port.js";

function fixture() {
  const screen = vi.fn<NonNullable<ClassifierPort["screen"]>>().mockResolvedValue({
    destination: "ohmail/News", confidence: 0.8, rationale: "A newsletter", spam: false,
  });
  const beforeDispatch = vi.fn(async () => {});
  return { classifier: { screen, classify: screen }, screen, beforeDispatch };
}

describe("Screener learning prompt", () => {
  it("passes the person's words, the note and only five generic corrections", async () => {
    const { classifier, screen, beforeDispatch } = fixture();
    const recentCorrections = Array.from({ length: 7 }, (_, i) => ({
      suggested: "INBOX", chosen: "ohmail/News", topic: `newsletter ${i}`,
    }));
    await askScreeningQuestion(classifier, {
      fromAddress: "sample@example.test", subject: "News", snippet: "Weekly newsletter",
      ohboxBar: "Keep messages I must answer in Ohbox", learnedWords: "Read newsletters later.",
      recentCorrections,
    }, { beforeDispatch });
    expect(classifyUserPayload(screen.mock.calls[0]![0])).toMatchObject({
      ohboxBar: "Keep messages I must answer in Ohbox", learnedWords: "Read newsletters later.",
      recentCorrections: recentCorrections.slice(-5),
    });
  });

  it("bounds the serialized request and preserves the complete words when it trims the preview", async () => {
    const { classifier, screen, beforeDispatch } = fixture();
    const learnedWords = "Kaufbelege in Belege. ".repeat(40);
    const ohboxBar = "Persönliche Antworten gehören in die Ohbox. ".repeat(36);
    await askScreeningQuestion(classifier, {
      fromAddress: "sample@example.test", subject: "Einladung", snippet: "Überraschung ".repeat(3000),
      ohboxBar, learnedWords,
    }, { beforeDispatch });
    const input: ClassifierInput = screen.mock.calls[0]![0];
    expect(input.ohboxBar).toEqual(ohboxBar);
    expect(input.learnedWords).toEqual(learnedWords);
    expect(screenerInputSize(input)).toBeLessThanOrEqual(SCREENER_INPUT_LIMIT);
    expect(SCREENER_INPUT_LIMIT).toBeLessThan(16_000);
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
  });

  it("refuses an oversized request before any provider call", async () => {
    const { classifier, screen, beforeDispatch } = fixture();
    await expect(askScreeningQuestion(classifier, {
      fromAddress: "sample@example.test", subject: "", snippet: "", ohboxBar: "a".repeat(30_000),
    }, { beforeDispatch })).rejects.toThrow(/budget/i);
    expect(screen).not.toHaveBeenCalled();
    expect(beforeDispatch).not.toHaveBeenCalled();
  });
});
