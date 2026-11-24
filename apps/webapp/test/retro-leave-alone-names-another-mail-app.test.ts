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

/* Change uses the current place and asks whether already-filed mail moves along with the rule. */
describe("the Rules page's Change names the destination and offers to move mail already here", () => {
  for (const [lang, cat, place, moveAlreadyHere] of [
    ["en", screening(en), "Files into {place}", "Move mail already here"],
    ["de", screening(de), "Sortiert in {place}", "Vorhandene Nachrichten verschieben"],
  ] as const) {
    it(lang, () => {
      expect(cat("rules.filesInto")).toBe(place);
      expect(cat("rules.moveAlreadyHere")).toBe(moveAlreadyHere);
    });
  }
});
