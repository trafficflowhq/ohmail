import { describe, expect, it } from "vitest";
import { REFUSAL_KEYS, type ListedRefusalKey } from "../src/refusal-keys";
import { EN } from "../src/copy.en";
import en from "../../../packages/app/messages/phone.en.json";
import de from "../../../packages/app/messages/phone.de.json";

/*
 * EVERY REFUSAL THE PHONE CAN SAY HAS ITS SENTENCE IN THE PHONE'S CATALOGUE, in English and German: the words the
 * shell's page draws for a refusal its native side hands it as a code and values. The deck says the same refusal
 * today; each sentence takes the values the deck's takes, and none more. (That each sentence is said whole in both
 * languages, by the page's own reader: `packages/app/test/text/phone-refusal.test.tsx`.)
 */

type Lang = "en" | "de";
const CATALOGUE = { en, de } as const;
const sentences = (lang: Lang) => CATALOGUE[lang].phoneRefusal as Record<string, string>;

/**
 * The refusals whose deck sentence quotes a server's address or an account's id. Their sentence in the catalogue
 * says what happened without it: a page never repeats an address it was handed in a refusal.
 */
const WITHHELD: Partial<Record<ListedRefusalKey, readonly number[]>> = {
  bootAccountMismatch: [0, 1],
  bootApiBaseOffOrigin: [0, 1],
  bootBadApiBase: [0],
  bootBadOrigin: [0],
  bootLocalEngineOffOrigin: [0, 1],
  pairBadAddress: [0],
};

const marker = (i: number) => `«value-${i}»`;

/** How many values the deck's sentence takes. */
function arity(key: ListedRefusalKey): number {
  const member = (EN as unknown as Record<string, unknown>)[key];
  return typeof member === "function" ? member.length : 0;
}

/** The values the deck's own English sentence quotes, each handed as a marker. */
function deckQuotes(key: ListedRefusalKey): number[] {
  const member = (EN as unknown as Record<string, unknown>)[key];
  if (typeof member !== "function") return [];
  const words = (member as (...a: string[]) => string)(...Array.from({ length: member.length }, (_, i) => marker(i)));
  return Array.from({ length: member.length }, (_, i) => i).filter((i) => words.includes(marker(i)));
}

/** The places a catalogue sentence fills, a choice's own value among them. */
function places(sentence: string): number[] {
  return [...new Set([...sentence.matchAll(/\{(\d+)[},]/g)].map((m) => Number(m[1])))].sort();
}

describe("the phone's refusals, in its catalogue", () => {
  it("names each key once, and every key is the deck's", () => {
    expect(new Set(REFUSAL_KEYS).size).toBe(REFUSAL_KEYS.length);
    expect(REFUSAL_KEYS.length).toBeGreaterThan(250);
    for (const key of REFUSAL_KEYS) expect(EN, key).toHaveProperty(key);
  });

  it("has a sentence for every key, in both languages, and an unknown one", () => {
    for (const lang of ["en", "de"] as const) {
      const missing = REFUSAL_KEYS.filter((key) => typeof sentences(lang)[key] !== "string");
      expect(missing, `phone.${lang}.json lacks`).toEqual([]);
      expect(typeof sentences(lang).unknown).toBe("string");
    }
    expect(Object.keys(sentences("de")).sort()).toEqual(Object.keys(sentences("en")).sort());
    /* And nothing else: a key that left the list takes its sentences with it. */
    expect(Object.keys(sentences("en")).sort()).toEqual([...REFUSAL_KEYS, "unknown"].sort());
  });

  it("fills only places the deck's sentence has, the same ones in both languages", () => {
    for (const key of REFUSAL_KEYS) {
      const en = places(sentences("en")[key]!);
      expect(places(sentences("de")[key]!), key).toEqual(en);
      for (const place of en) expect(place, `${key} fills {${place}}`).toBeLessThan(arity(key));
    }
  });

  it("says every value the deck's sentence says, in both languages", () => {
    for (const key of REFUSAL_KEYS) {
      for (const i of deckQuotes(key).filter((i) => !(WITHHELD[key] ?? []).includes(i))) {
        for (const lang of ["en", "de"] as const) {
          expect(sentences(lang)[key], `${lang} ${key} drops {${i}}`).toContain(`{${i}}`);
        }
      }
    }
  });

  it("never quotes a server's address or an account id it was handed", () => {
    for (const [key, withheld] of Object.entries(WITHHELD)) {
      for (const lang of ["en", "de"] as const) {
        for (const i of withheld) expect(places(sentences(lang)[key]!), `${lang} ${key}`).not.toContain(i);
      }
    }
  });

  it("says why a sync stopped at a certificate this phone would not accept, in both languages", () => {
    /* The servers' list says it after `servers.syncStopped`, where a handshake failed and no key was pinned. */
    for (const lang of ["en", "de"] as const) {
      const servers = CATALOGUE[lang].servers as Record<string, unknown>;
      expect(typeof servers.certificateRefused, `phone.${lang}.json servers.certificateRefused`).toBe("string");
    }
  });

  it("begins every sentence with a capital or with ohmail's own name, in both languages", () => {
    /* One rule for the first letter. A sentence begins with a capital letter, or with ohmail or ohcal, which are lower
       case also at the start of a sentence. A sentence that begins with its value (`{0}`, or a choice over it) is
       that value: `storeFault` and `verbatimDetail` are said inside another sentence's place. */
    for (const lang of ["en", "de"] as const) {
      const clauses = Object.entries(sentences(lang)).filter(([, s]) => !/^(\p{Lu}|ohmail|ohcal|\{)/u.test(s));
      expect(clauses.map(([key]) => key), `phone.${lang}.json`).toEqual([]);
    }
  });

  it("is German in German, and calls out to no one", () => {
    const same = REFUSAL_KEYS.filter((key) => sentences("de")[key] === sentences("en")[key]);
    expect(same.length / REFUSAL_KEYS.length).toBeLessThan(0.05);
    for (const lang of ["en", "de"] as const) {
      expect(Object.values(sentences(lang)).filter((s) => s.includes("!"))).toEqual([]);
    }
  });
});
