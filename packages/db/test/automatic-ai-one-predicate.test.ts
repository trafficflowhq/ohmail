import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The content gate was removed by decision of 24 Nov 2026.
it("the suggestion query has no automaticAiAdmits predicate", () => {
  expect(readFileSync(new URL("../src/screener-suggestion.ts", import.meta.url), "utf8")).not.toContain("automaticAiAdmits");
});
