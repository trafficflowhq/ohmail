import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * ONE COMPARATOR PER PILE, SHARED BY EVERY SURFACE. `triagePiles` sorts each pile
 * through `PILE_ORDER` and the web, both desktops and the phone render the result as returned.
 * This census refuses a second sort over a pile anywhere a surface lives; it reads a sort whose
 * STATEMENT names a pile, so a sort of a copy under another name in a later statement is outside
 * its reach and the behaviour tests beside it (`triage-pile-order.test.ts`) are the other half.
 */

const REPO = new URL("../../../", import.meta.url);
/** Every root a pile is rendered from: the one shell (web + desktops), the phone, the components. */
const ROOTS = [
  "apps/webapp/app", "packages/app-logic/src", "apps/desktop/src", "apps/mobile/src", "apps/mobile/app",
  "packages/ui/src", "packages/client-engine/src",
];
const SELECTORS = "packages/client-engine/src/selectors.ts";
const PILE_NAME = /\b(?:replyLater|setAside|resurface|piles|triagePiles|PILE_ENTRIES)\b/;
const SORT = /\.(?:sort|toSorted|reverse|toReversed)\s*\(/g;

/** Offsets of every sort whose statement names a pile, comments and literals blanked. */
function pileSorts(src: string): number[] {
  const code = withoutCommentsAndLiterals(src);
  const hits: number[] = [];
  for (const m of code.matchAll(SORT)) {
    const at = m.index!;
    const from = Math.max(code.lastIndexOf(";", at), code.lastIndexOf("{", at), code.lastIndexOf("}", at)) + 1;
    if (PILE_NAME.test(code.slice(from, at))) hits.push(at);
  }
  return hits;
}

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(new URL(dir, REPO))) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const rel = `${dir}/${name}`;
    if (statSync(new URL(rel, REPO)).isDirectory()) yield* sources(rel);
    else if (/\.(?:ts|tsx|mts)$/.test(name) && !/\.d\.ts$/.test(name)) yield rel;
  }
}

/** The body of `triagePiles`, blanked the same way — the one place a pile is sorted. */
function triagePilesBody(): string {
  const code = withoutCommentsAndLiterals(readFileSync(new URL(SELECTORS, REPO), "utf8"));
  const at = code.indexOf("export function triagePiles(");
  expect(at, "triagePiles moved — this census reads it by name").toBeGreaterThan(0);
  return code.slice(at, code.indexOf("\n}\n", at));
}

describe("the triage piles have one order", () => {
  it("the scanner reads a pile sort in every shape a surface would write one (positive control)", () => {
    expect(pileSorts("const run = [...piles.replyLater].sort(byWhen);")).toHaveLength(1);
    expect(pileSorts("return { items: piles[kind].map(toItem).toSorted(cmp) };")).toHaveLength(1);
    expect(pileSorts("const a = p.setAside\n  .slice()\n  .reverse();")).toHaveLength(1);
    // …and admits what is not one: a sort of messages, and a pile NAMED only in a comment.
    expect(pileSorts("rows.sort((a, b) => byDateDesc(a.rep, b.rep));")).toEqual([]);
    expect(pileSorts("// piles.replyLater.sort(x)\nmessages.sort(byDateDesc);")).toEqual([]);
  });

  it("triagePiles sorts once, through PILE_ORDER", () => {
    const body = triagePilesBody();
    const sorts = [...body.matchAll(SORT)];
    expect(sorts, "the one pile sort is gone, or a second one joined it").toHaveLength(1);
    expect(body.slice(sorts[0]!.index!, sorts[0]!.index! + 40)).toMatch(/^\.sort\(PILE_ORDER\[/);
  });

  it("no surface sorts a pile a second time", () => {
    const found: string[] = [];
    let files = 0;
    for (const root of ROOTS) {
      for (const rel of sources(root)) {
        files++;
        if (rel === SELECTORS) continue; // its one sort is read above, inside triagePiles
        const src = readFileSync(new URL(rel, REPO), "utf8");
        for (const at of pileSorts(src)) found.push(`${rel}:${src.slice(0, at).split("\n").length}`);
      }
    }
    expect(files, "the walk read no sources — a zero here would be blindness").toBeGreaterThan(200);
    expect(found).toEqual([]);
  });
});
