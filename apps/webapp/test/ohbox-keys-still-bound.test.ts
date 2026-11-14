import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE KEYS TODAY'S PANE-FOOT LEGEND TAUGHT ARE STILL BOUND IN THE OHBOX: the legend was display only, and j/k/↵/t/x/u
 * remain declared bindings (the dispatcher and the generated `?` sheet both read them from `useKeyBindings`). Read from
 * the seated Ohbox's behaviour hook, which binds them. Moved from `shortcut-hint.test.tsx`, whose other cases read
 * today's strip and views, as it was.
 */

/* The Ohbox's keys are bound by its behaviour hook; its list draws no strip (the new list's keys are on the `?` sheet). */
const OHBOX_KEYS = readFileSync(resolve(process.cwd(), "packages/app-logic/src/ohbox/keys.ts"), "utf8");

describe("every pane-foot strip is the affordance, not a legend", () => {
  it("the keys the legend used to teach are still BOUND in the Ohbox", () => {
    // The fix is display-only. j/k/↵/t/x/u remain declared bindings (the dispatcher and the
    // generated sheet both read them from `useKeyBindings`).
    for (const chord of ['"j"', '"k"', '"Enter"', '"t"', '"x"', '"u"']) {
      expect(
        OHBOX_KEYS.includes(`chord: ${chord}`),
        `OhboxView no longer binds ${chord}`,
      ).toBe(true);
    }
  });
});
