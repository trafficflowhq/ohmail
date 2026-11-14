/**
 * `hour12` APPEARS NOWHERE IN THE TREE — a source census, on the pattern that keeps drizzle-kit out.
 *
 * ── WHAT THIS IS ACTUALLY DEFENDING ─────────────────────────────────────────────────────────
 *
 * `hour12: false` is NOT a synonym for a 24-hour clock. It resolves to h24 on some ICU builds,
 * which renders midnight as "24:10" — an hour of every day printed as an hour that does not exist,
 * and, in any caller that then bands on the hour, filed against the wrong day. Two of the seven
 * places that used to compose a clock asked for it that way and patched the result afterwards;
 * five did not have to, because they read `zonedFields`, which pins `hourCycle: "h23"` and folds a
 * 24 back to 0.
 *
 * ── AND WHY A SOURCE CENSUS RATHER THAN ONLY BEHAVIOUR ──────────────────────────────────────
 *
 * Because the hazard cannot be watched fail on a machine whose ICU does not have it. Measured on
 * this one: `hour12: false` and `hourCycle: "h23"` return "00:10" for the same midnight instant,
 * so removing BOTH the cycle and the fold from `zone.ts` left every behavioural case green. A
 * guard that stays green through the mutation it exists to catch is not evidence. What is
 * load-bearing is therefore asserted directly — the spelling is absent from the source, and the
 * one place asks by name and keeps its fold. Those fail on any machine, including every one where
 * the defect would never show.
 *
 * The prose is stripped before scanning, deliberately. Each of these files explains this trap in a
 * comment, by name, because that is where the reasoning belongs; a census that read those would
 * fail on the documentation of the defect it exists to prevent, and the only way to pass would be
 * to delete the explanation.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "..", "..", "..");

/** Every tree that renders a time of day. */
const TREES = ["packages/client-engine/src", "apps/webapp/app", "packages/app-logic/src", "apps/mobile/src"];
const ONE_PLACE = "packages/client-engine/src/zone.ts";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...sources(p)); continue; }
    if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * The file with its comments removed. `//` counts as a line comment only where it follows
 * whitespace or a line start, so a `https://` inside a string survives.
 */
const stripped = (p: string): string =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");

describe("the hour cycle has one spelling and one home", () => {
  it("no source under the three trees asks for `hour12`", () => {
    const files = TREES.flatMap((t) => sources(resolve(ROOT, t)));
    // Anti-vacuity: a tree that moved would read as "no occurrences" and pass over nothing.
    expect(files.length, "the census found no sources to read").toBeGreaterThan(200);
    const offenders = files.filter((p) => /hour12/.test(stripped(p)))
      .map((p) => p.slice(ROOT.length + 1));
    expect(
      offenders,
      `${offenders.join(", ")}: \`hour12: false\` resolves to h24 on some ICU builds and renders `
        + 'midnight as "24:10". Ask for `hourCycle: "h23"`, or take the clock from `stamp.ts`.',
    ).toEqual([]);
  });

  it("THE ONE PLACE ASKS BY NAME AND KEEPS ITS FOLD — the case that fails where the defect cannot", () => {
    const src = stripped(resolve(ROOT, ONE_PLACE));
    expect(src, "zone.ts no longer asks for an hour cycle by name").toMatch(/hourCycle:\s*"h23"/);
    expect(src, "the midnight fold is gone from the one place")
      .toMatch(/hour\s*===\s*24\s*\?\s*0\s*:\s*hour/);
  });
});
