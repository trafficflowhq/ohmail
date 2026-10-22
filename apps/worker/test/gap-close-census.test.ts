import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * EVERY CLOSE OF THE GAP OFFER CLEARS BOTH COUNTS (mail 0158). A site that writes `gapLetters: null`
 * and leaves `gapStrangers` standing would carry an old stranger count into the next window, where
 * a press for it could screen letters the person was never shown. Source census over every writer.
 */

const ROOT = join(__dirname, "..", "..", "..");
const TREES = ["apps/worker/src", "apps/sidecar/src", "packages/services/src", "packages/core/src"];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The object literal around `at`: from the nearest unmatched `{` before it to its `}`. */
function literalAround(src: string, at: number): string {
  let depth = 0;
  let start = at;
  for (; start > 0; start--) {
    const c = src[start];
    if (c === "}") depth++;
    else if (c === "{") { if (depth === 0) break; depth--; }
  }
  depth = 0;
  let end = at;
  for (; end < src.length; end++) {
    const c = src[end];
    if (c === "{") depth++;
    else if (c === "}") { if (depth === 0) break; depth--; }
  }
  return src.slice(start, end + 1);
}

describe("the gap offer's close sites", () => {
  it("every literal that clears gapLetters clears gapStrangers with it", () => {
    const sites: string[] = [];
    const bare: string[] = [];
    for (const tree of TREES) {
      for (const f of files(join(ROOT, tree))) {
        const src = readFileSync(f, "utf8");
        for (const m of src.matchAll(/gapLetters: null/g)) {
          const where = `${relative(ROOT, f)}:${src.slice(0, m.index).split("\n").length}`;
          sites.push(where);
          if (!/gapStrangers: null/.test(literalAround(src, m.index!))) bare.push(where);
        }
      }
    }
    // The pass, the two stand-down writers, the sidecar's two and the door's Leave.
    expect(sites.length, `the census found too few close sites: ${sites.join(", ")}`).toBeGreaterThanOrEqual(6);
    expect(bare, "a close site leaves the stranger count standing").toEqual([]);
  });
});
