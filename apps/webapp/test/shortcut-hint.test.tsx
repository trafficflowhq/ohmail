/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const view = (name: string): string =>
  readFileSync(resolve(process.cwd(), `apps/webapp/app/views/${name}.tsx`), "utf8");

const VIEWS = {
  ReadsView: view("ReadsView"),
  ReceiptsView: view("ReceiptsView"),
  ScreenerView: view("ScreenerView"),
} as const;

describe("every pane-foot strip is the affordance, not a legend", () => {
  it("the four views that had strips now render <ShortcutHint />", () => {
    // Ohbox and Screener through ListPane's `hints` slot; Reads and Receipts additionally in
    // their `.stream-hints` foot. Count them so a dropped one is named.
    const uses = Object.entries(VIEWS).map(
      ([name, src]) => [name, (src.match(/<ShortcutHint \/>/g) ?? []).length] as const,
    );
    expect(Object.fromEntries(uses)).toEqual({
      ReadsView: 2,
      ReceiptsView: 2,
      ScreenerView: 1,
    });
  });

  /* "the keys the legend used to teach are still BOUND in the Ohbox" moved to `ohbox-keys-still-bound.test.ts`. */
});
