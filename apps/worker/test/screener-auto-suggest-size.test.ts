import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTO_SUGGEST_BATCH } from "@ohmail/organizer/screener-auto-suggest";

// The service and the interactive spender must share a cap across the package boundary.
describe("the automatic batch size is ONE number on both sides of the boundary", () => {
  it("matches `AUTO_BATCH_SIZE` in the webapp's Screener spender", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../../packages/app-logic/src/screener/screener-suggest.ts", import.meta.url)), "utf8",
    );
    const m = /export const AUTO_BATCH_SIZE = (\d+);/.exec(src);
    expect(m, "AUTO_BATCH_SIZE was not found — the probe is stale, not the claim").not.toBeNull();
    expect(Number(m![1])).toBe(AUTO_SUGGEST_BATCH);
  });
});
