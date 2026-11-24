import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The content gate was removed by decision of 24 Nov 2026.
it("the drafting service has no screenModelInput call", () => {
  expect(readFileSync(new URL("../packages/services/src/drafting-service.ts", import.meta.url), "utf8")).not.toContain("screenModelInput");
});
