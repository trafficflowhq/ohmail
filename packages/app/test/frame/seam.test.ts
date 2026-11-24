import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRAME_SHEET,
  ROOT,
  OLD_SHEETS,
  namesReading,
  rulesOf,
  seamSheets,
  // @ts-expect-error: a plain script of this package, without declarations.
} from "../../scripts/seam-tokens.mjs";

/** The seven names whose meaning differs between the old token sheets and the new one, as the seam was ruled. */
const SEVEN = ["--float", "--focus", "--ink", "--ink2", "--ink3", "--r-pill", "--scrim"];

describe("the seam between the two designs", () => {
  const sheets = seamSheets();
  const old = OLD_SHEETS.map((path: string) => readFileSync(join(ROOT, path), "utf8")).join("\n");

  it("covers exactly the names both designs define: a new shared name is a decision, not a drift", () => {
    expect(sheets.shared).toEqual(SEVEN);
    for (const name of SEVEN) {
      expect(sheets.frame).toContain(`${name}:`);
      expect(old).toContain(`${name}:`);
    }
  });

  it("is committed as the script writes it", () => {
    expect(readFileSync(join(ROOT, FRAME_SHEET), "utf8")).toBe(sheets.frame);
  });

  it("declares each name one level down, inside the media query it stood in, and drops the rest", () => {
    const rules = rulesOf(`@layer oh;
      /* a comment { with a brace } */
      @layer oh { :root { --ring: var(--ink); --gap: 4px } }
      :root, [data-theme="light"] { --ink: #111; --sheet: #fff }
      @media (prefers-color-scheme: dark) { :root:not([data-scheme]) { --ink: #eee } }
      .oh-rail { --oh-solid: var(--ink) }`);
    expect(namesReading(rules, ["--ink"])).toEqual(["--ink", "--oh-solid", "--ring"]);
    expect(rules.map((r: { media: string | null; selectors: string[] }) => [r.media, r.selectors])).toEqual([
      [null, [":root"]],
      [null, [":root", '[data-theme="light"]']],
      ["@media (prefers-color-scheme: dark)", [":root:not([data-scheme])"]],
      [null, [".oh-rail"]],
    ]);
  });

  it("re-declares under the frame the root measures that read a shared name", () => {
    expect(sheets.frame).toMatch(
      /:root \.oh-root \{\n(?: {2}--[^\n]+\n)* {2}--oh-ring-focus: inset 0 0 0 var\(--oh-focus\) var\(--focus\);/,
    );
    expect(sheets.frame).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-scheme\]\) \.oh-root \{/,
    );
    expect(old).toContain('[data-theme="dark"]');
  });
});
