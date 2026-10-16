import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * THE SELF-HOST DOOR NAMES NO VENDOR. A server's operator picks one of four providers and `/hello`
 * says only that a model is configured, so a sentence naming one is a claim about somebody else's
 * server that is false three times in four. The Cloud sentence is the other case and stays as it
 * is (`cloud-draft-disclosure.test.ts`): there the model is ohmail's choice and the person is owed it.
 */
type Catalog = Record<string, Record<string, string>>;
const VENDOR = /anthropic|claude|openai|gpt|ollama|opencode|llama/i;
const SELFHOST: Array<[string, string]> = [
  ["onboarding", "aiYesSelfhostWhy"], ["onboarding", "providerSelfhostOn"], ["onboarding", "providerSelfhostOff"],
  ["data", "selfAi"], ["pricing", "selfStatusNote"],
];

describe("the self-host AI sentences", () => {
  for (const [lang, cat] of [["en", en], ["de", de]] as const) {
    const c = cat as unknown as Catalog;
    it(`${lang}: none names a vendor`, () => {
      for (const [ns, key] of SELFHOST) {
        const s = c[ns]?.[key];
        expect(s, `${lang} ${ns}.${key} is missing`).toBeTypeOf("string");
        expect(s, `${lang} ${ns}.${key} names a vendor`).not.toMatch(VENDOR);
      }
    });

    it(`${lang}: the FAQ no longer says a server cannot run a model of its own`, () => {
      const a3 = c.faq!.a3!;
      expect(a3).not.toMatch(/not built yet|noch nicht/);
      const [cloud, ...rest] = a3.split(/(?<=\.)\s+/);
      expect(cloud, "the Cloud half of the answer keeps naming its model").toMatch(/Anthropic/);
      const own = rest.find((s) => /server you run|Server, den du betreibst/.test(s));
      expect(own, "the answer has its self-host sentence").toBeTypeOf("string");
      expect(own, "the self-host sentence names a vendor").not.toMatch(VENDOR);
    });
  }
});
