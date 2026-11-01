/**
 * THE PHONE SAYS WHERE A PART INSIDE A WORD IS LOOKED FOR, by the browser's rule
 * (`apps/webapp/test/search-part-reach.test.tsx`): on the store's empty and closest-words answers,
 * for a query that opens the stores' substring arm, never on an exact answer, never for exactness
 * asked, never while the store still indexes. No React Native renderer exists here, so the decision
 * is one function the screen calls, and the screen is read for its two uses.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Copy } from "../src/copy";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { partReachSaid } from "../src/state/search-count";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const webOf = (l: "en" | "de") => (JSON.parse(read(`../../webapp/messages/${l}.json`)) as { search: { partReach: string } }).search.partReach;
const EMPTY = { ready: true, indexedPercent: null, tier: "exact" as const, length: 0 };

describe("the phone's reach sentence for a part inside a word", () => {
  it("on the store's empty and closest-words answers for a part", () => {
    expect(partReachSaid("levation", EMPTY)).toBe(true);
    expect(partReachSaid(" levation ", { ...EMPTY, tier: "similar", length: 3 })).toBe(true);
    // Beside an excluded word, the words asked are looked for as they are alone.
    expect(partReachSaid("mail -thanks", EMPTY)).toBe(true);
  });

  it.each([
    ["a quoted part", '"levation"', EMPTY],
    ["an excluded part", "-levation", EMPTY],
    ["an exact answer with rows", "levation", { ...EMPTY, length: 2 }],
    ["an answer while the store still indexes", "levation", { ...EMPTY, indexedPercent: 40 }],
    ["before the store answered", "levation", { ...EMPTY, ready: false }],
    ["a query under a trigram's width", "le", EMPTY],
  ] as const)("not for %s", (_arm, q, s) => {
    expect(partReachSaid(q, s)).toBe(false);
  });

  it("the box promises no typo tolerance the phone's store does not have, as the browser's", () => {
    expect(EN.searchPlaceholder).toBe("Search everything");
    expect(DE.searchPlaceholder).toBe("Alles durchsuchen");
    const box = (l: "en" | "de") => (JSON.parse(read(`../../webapp/messages/${l}.json`)) as { search: { placeholder: string } }).search.placeholder;
    expect([box("en"), box("de")]).toEqual([EN.searchPlaceholder, DE.searchPlaceholder]);
  });

  it("the sentence is the browser's, word for word, in both languages", () => {
    expect(EN.searchPartReach).toBe(webOf("en"));
    expect(DE.searchPartReach).toBe(webOf("de"));
    expect(typeof Copy.searchPartReach).toBe("string");
  });

  it("the screen takes the decision from that function, in the empty state and the closest-words note", () => {
    const screen = read("../app/search.tsx");
    expect(screen).toContain("const partsSaid = partReachSaid(trimmed, store);");
    expect(screen.match(/Copy\.searchPartReach/g)?.length).toBe(2);
  });
});
