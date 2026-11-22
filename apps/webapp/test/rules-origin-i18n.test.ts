import { describe, expect, it } from "vitest";
import messages from "../messages/en.json";

/**
 * SETTINGS-RULES-I18N — every rule provenance must have a sentence in `rules.origin`.
 *
 * The rule description renders a rule's origin with `t(`origin.${rule.provenance}`)`
 * (`packages/app-logic/src/press/rule-descriptions.ts`). A provenance value with no key renders the raw key path —
 * "rules.origin.seeded-from-sent" — straight into the rule's meta line. That is visible to any
 * user whose Ohbox was seeded from their Sent mail, which is the DEFAULT onboarding path, so the
 * gap was on the most-travelled surface rather than an edge one.
 *
 * The provenance union is `manual | migrated | promoted | seeded-from-sent`
 * (`packages/client-engine/src/types.ts`, `packages/core/src/rules.ts`). It is restated as a
 * literal here on purpose: importing the type gives no runtime set to check, and this guard's job
 * is precisely to go red when a value is added there and its sentence is not added here.
 */
const PROVENANCE = ["manual", "migrated", "promoted", "seeded-from-sent"] as const;

const origin = (messages as unknown as { rules: { origin: Record<string, string> } }).rules.origin;

describe("rules.origin covers every rule provenance", () => {
  for (const p of PROVENANCE) {
    it(`carries a real sentence for "${p}", not the key path`, () => {
      const value = origin[p];
      expect(typeof value).toBe("string");
      expect((value ?? "").length).toBeGreaterThan(0);
      // A missing key renders as the dotted path; a present-but-wrong value must not be one.
      expect(value).not.toContain("origin.");
    });
  }
});
