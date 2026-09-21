import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE WINDOW SMOKE'S NEEDLES ARE THE APP'S OWN WORDS, AND NOTHING LOCAL RAN THE SMOKE.
 * `scripts/smoke.mjs` asserts that the rail names each pile, against the text the built window
 * rendered. It runs only in the packaged build's workflow, so when a pile was renamed and one
 * needle kept the old name, 47 of its 48 checks passed and every installer job failed on the
 * forty-eighth — the app was right and the assertion was stale. This reads the needles out of the
 * script and asks the catalogue, so the mismatch is a test failure here instead.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SMOKE = join(ROOT, "apps/desktop/scripts/smoke.mjs");
const EN = join(ROOT, "apps/webapp/messages/en.json");
const DE = join(ROOT, "apps/webapp/messages/de.json");

/**
 * The needles the script asserts against rendered text, read from its source rather than copied:
 * a list of literals looped over a `text.includes(<the loop variable>)`, plus any literal handed
 * to `text.includes` directly. A copy would go stale the same way the needle did.
 */
export function renderedNeedles(src: string): { needles: string[]; loops: number } {
  const needles: string[] = [];
  let loops = 0;
  const loop = /for\s*\(\s*const\s+(\w+)\s+of\s+\[([^\]]*)\]\s*\)\s*\{([\s\S]{0,600}?)\n\}/g;
  for (let m = loop.exec(src); m; m = loop.exec(src)) {
    const [, variable, list, body] = m;
    if (!new RegExp(`text\\.includes\\(\\s*${variable}\\s*\\)`).test(body)) continue;
    loops += 1;
    for (const lit of list.matchAll(/"((?:[^"\\]|\\.)*)"/g)) needles.push(JSON.parse(`"${lit[1]}"`));
  }
  for (const lit of src.matchAll(/text\.includes\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) {
    needles.push(JSON.parse(`"${lit[1]}"`));
  }
  return { needles, loops };
}

/** `rail.<key>` → its value, the only section whose values the rail actually paints. */
export function railLabels(catalogue: string): Map<string, string> {
  const rail = (JSON.parse(catalogue) as { rail?: Record<string, unknown> }).rail ?? {};
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(rail)) if (typeof v === "string") out.set(k, v);
  return out;
}

/** Needles no `rail.*` value spells, each with the key it would have to be. */
export function staleNeedles(needles: string[], en: Map<string, string>): string[] {
  const values = new Set(en.values());
  return needles.filter((n) => !values.has(n));
}

const smoke = readFileSync(SMOKE, "utf8");
const read = renderedNeedles(smoke);
const enRail = railLabels(readFileSync(EN, "utf8"));
const deRail = railLabels(readFileSync(DE, "utf8"));

describe("the window smoke's rendered-text needles are words the app's catalogue holds", () => {
  it("the reader finds the needles in the script rather than reading nothing", () => {
    /* A census that cannot find its subject reads zero and says nothing. If the loop is renamed
       or moved, this refuses here rather than going quiet and letting the next rename through. */
    expect(read.loops, "no rendered-text loop found in apps/desktop/scripts/smoke.mjs").toBeGreaterThanOrEqual(1);
    expect(read.needles.length, "the smoke asserts fewer rail names than the rail has piles").toBeGreaterThanOrEqual(4);
  });

  it("every needle is a label the rail paints", () => {
    const stale = staleNeedles(read.needles, enRail);
    /* The rail's own short values, which is what a pile label is: the whole section is seventy
       strings and a refusal nobody can read is a refusal nobody acts on. */
    const piles = [...enRail.values()].filter((v) => v.length <= 20 && !v.includes("{"));
    expect(
      stale,
      `apps/desktop/scripts/smoke.mjs asserts ${JSON.stringify(stale)}, which no rail label spells. ` +
        `The rail's own labels are ${JSON.stringify(piles)}.`,
    ).toEqual([]);
  });

  it("every rail label the smoke asserts has a German twin", () => {
    const byValue = new Map([...enRail].map(([k, v]) => [v, k]));
    const orphans = read.needles
      .map((n) => byValue.get(n))
      .filter((k): k is string => k != null && !deRail.has(k));
    expect(orphans, "a rail label the smoke asserts has no entry in the German catalogue").toEqual([]);
  });

  it("a needle left behind by a rename is refused, and a loose reading would have passed it", () => {
    /* THE CONTROL, on the shape that shipped a red candidate: the pile was renamed in every
       catalogue and the smoke kept the old word, which survived elsewhere in the same file as an
       illustration label. So "is this string anywhere in the catalogue" answers yes and teaches
       nothing; only the rail's own values answer the question the needle asks. */
    const renamed = new Map(enRail);
    renamed.set("reads", "News");
    const plantedSource = 'for (const label of ["Ohbox", "Reads", "Settings"]) {\n  check(`rail names "${label}"`, text.includes(label));\n}\n';
    const planted = renderedNeedles(plantedSource);
    expect(planted.loops).toBe(1);
    expect(planted.needles).toEqual(["Ohbox", "Reads", "Settings"]);
    expect(staleNeedles(planted.needles, renamed)).toEqual(["Reads"]);
    const everyValueAnywhere = new Set(["News", "Reads", "Ohbox", "Settings"]);
    expect(everyValueAnywhere.has("Reads"), "the loose reading admits the stale needle").toBe(true);
  });

  it("a needle the rail does paint is admitted through the same reader", () => {
    /* The admitting arm: without it the rule above is true of everything for free. */
    const planted = renderedNeedles(
      'for (const label of ["Ohbox", "Settings"]) {\n  check(`rail names "${label}"`, text.includes(label));\n}\n',
    );
    expect(staleNeedles(planted.needles, enRail)).toEqual([]);
  });

  it("a list nothing asserts against rendered text is not a needle list", () => {
    /* A loop over literals that never reaches `text.includes` is data, not an assertion, and
       reading it would refuse the script for words the window never had to render. */
    const planted = renderedNeedles(
      'for (const code of ["ENOENT", "EPIPE"]) {\n  check(`knows ${code}`, KNOWN.has(code));\n}\n',
    );
    expect(planted.loops).toBe(0);
    expect(planted.needles).toEqual([]);
  });
});
