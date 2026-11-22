import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * The strip under the Suggest control, a waiting
 * row with no suggestion and the refusal toast all name the same fact, and they used to name it in
 * three sentences ("Suggestions need AI credits…", "AI suggestions need credits…", "No AI budget
 * left…"). Each now opens with the one sentence; the row adds its instruction and the Where forms
 * the pane that sells credits.
 */
describe("the AI-credit fact is said one way on the Screener", () => {
  for (const [locale, cat] of [["en", en], ["de", de]] as const) {
    it(`${locale}: strip, row and toast open with one sentence`, () => {
      const fact = cat.aiRefusal.insufficientCredits;
      expect(cat.screener.suggest.noCredits).toBe(fact);
      expect(cat.screener.noSuggestionNoBudget).toBe(fact);
      const where = cat.screener.suggest.noCreditsWhere;
      expect(where.startsWith(fact.slice(0, -1))).toBe(true);
      expect(cat.screener.noSuggestionNoBudgetWhere.startsWith(where.slice(0, -1))).toBe(true);
    });
  }
});
