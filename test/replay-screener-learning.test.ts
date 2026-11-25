import { expect, it } from "vitest";
import { replayScreenerLearning } from "../scripts/replay-screener-learning.js";
import type { ClassifierPort } from "../packages/core/src/classifier-port.js";

it("uses only earlier choices in the same mailbox and reports paired agreement", async () => {
  const seen: string[] = [];
  const classify: ClassifierPort["classify"] = async input => {
    seen.push(input.learnedWords ?? "");
    const keep = !!input.learnedWords;
    return {
      destination: keep ? "ohmail/Screened" : "ohmail/News",
      confidence: 0.8, spam: false, rationale: "An invitation",
    };
  };
  const model: ClassifierPort = {
    classify,
    screen: classify,
    async rewriteScreener(request) {
      return { text: request.input.choices.at(-1)?.topic === "webinar" ? "Screen out webinar invitations." : "" };
    },
  };
  const make = (mailbox: string, day: number) => ({
    mailbox, at: new Date(Date.UTC(2026, 10, day, 12)).toISOString(), language: "en" as const,
    ask: { fromAddress: "sample@example.test", subject: "Webinar invitation", snippet: "An upcoming webinar" },
    kind: "confirmation", topic: "receipt", suggested: "ohmail/News", previous: null, chosen: "ohmail/Screened",
  });
  const report = await replayScreenerLearning([make("a", 3), make("b", 2), { invalid: true }, make("a", 1)], model);
  expect(seen).toEqual(["", "", "", "", "", "Screen out webinar invitations."]);
  expect(report).toMatchObject({ rows: 4, invalid: 1, eligible: 3 });
  expect(report.groups.correction?.eligible).toBe(3);
  expect(report.withoutNote).toMatchObject({ matches: 0, agreement: 0 });
  expect(report.withNote).toMatchObject({ matches: 1, agreement: 1 / 3 });
  expect(report.inputSizes.suggestion).toBeLessThan(12_288);
  expect(report.inputSizes.rewrite).toBeLessThan(12_288);
});
