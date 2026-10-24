import { describe, it, expect } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * THE PASS LEAVES A FILING THE PERSON MADE, HERE OR IN ANOTHER MAIL APP: one made in ohmail carries
 * `folder_state.decided_at`, which the backlog pass leaves away from the gate (`rule-retro.ts`, 7;
 * `apps/worker/test/rule-retro-leaves-a-decided-place.test.ts`), and one made elsewhere is
 * `'external'`. Every sentence that names the leave-alone set says both, in both catalogues.
 */
const KEYS = [
  "footRuleRetro", "footRuleRetroDomain", "footWillRuleRetro", "footWillRuleRetroDomain",
  "footWillRuleRetroChip", "footWillRuleRetroDomainChip",
  "subjectConfirmFine", "bodyConfirmMore", "subjectConfirmMore",
  // A Change that takes a walk still owed to the new place whole: the ordinary walk's set.
  "rules.retargetExplainWalk",
] as const;

type Catalogue = Record<string, Record<string, string>>;
const screening = (m: unknown) => (k: string) => {
  const [ns, key] = k.includes(".") ? k.split(".") as [string, string] : ["screening", k];
  return (m as Catalogue)[ns]?.[key];
};

describe("the retro's leave-alone sentence names a filing in another mail app", () => {
  for (const [lang, cat, says, never] of [
    ["en", screening(en), /filed yourself,? here or in another mail app/, /filed by hand/],
    ["de", screening(de), /selbst hier oder in einer anderen Mail-App einsortiert/, /selbst einsortiert/],
  ] as const) {
    it(`${lang}: every key`, () => {
      for (const k of KEYS) {
        const s = cat(k);
        expect(s, `${lang}.${k} is missing`).toBeTypeOf("string");
        expect(s, `${lang}.${k}`).toMatch(says);
        expect(s, `${lang}.${k} claims a move inside ohmail stays`).not.toMatch(never);
      }
    });
  }
});

/* The Rules page's Change moves only the mail the rule filed in its place, so its sentence names that
   place and a filing in another mail app, and never claims the person's own filing here stays. */
describe("the Rules page's Change names the rule's place and another mail app", () => {
  for (const [lang, cat, says, never] of [
    ["en", screening(en), /filed in another mail app/, /filed yourself here/],
    ["de", screening(de), /in einer anderen Mail-App einsortiert/, /selbst hier/],
  ] as const) {
    it(lang, () => {
      const s = cat("rules.retargetExplainRetro");
      expect(s).toMatch(says);
      expect(s).toContain("{from}");
      expect(s).not.toMatch(never);
    });
  }
});
