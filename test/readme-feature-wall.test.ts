import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { publicPath } from "./support/public-root.mjs";

/**
 * ══ THE PUBLIC README'S RECORDINGS EXIST, AND THEY ARE THE ONES IT NAMES ══════════════════════
 *
 * The README is published to the open repository verbatim (at the root; `public/ohmail/` where it was authored); its
 * feature wall is a column of `<img>` tags pointing at GIFs under `docs/assets/feature-wall/`.
 *
 * AN `<img>` WHOSE FILE IS MISSING FAILS NOTHING. GitHub renders the alt text, the publish gate
 * copies whatever the template directory contains, and nobody local runs a link checker — so a
 * section added with its recording still to come, or a file renamed on one side of the pair, ships
 * a broken frame to the front page of the project and is discovered by a stranger.
 *
 * So: every path the README names resolves, is big enough to be a real recording rather than a
 * stub, and begins with the GIF magic. The reverse direction is checked too — a recording nothing
 * references is dead weight in a repository people clone, and is far more likely to be a renamed
 * reference than a deliberate spare.
 */
/** A path in the published tree: the README and the recordings it names. */
const at = (rel: string): string => publicPath(rel);

describe("the public README's feature wall", () => {
  const readme = readFileSync(at("README.md"), "utf8");
  const referenced = [...readme.matchAll(/src="(docs\/assets\/feature-wall\/[^"]+)"/g)]
    .map((m) => m[1]!);

  it("names a recording for every section of the wall — and this list is not empty", () => {
    // Anti-vacuity: a regex that stopped matching would make every assertion below pass.
    expect(referenced.length).toBeGreaterThanOrEqual(8);
    expect(new Set(referenced).size, "the same recording is used twice").toBe(referenced.length);
  });

  it("every referenced recording exists, is a real GIF, and is not a stub", () => {
    for (const rel of referenced) {
      const file = at(rel);
      const size = statSync(file).size;
      expect(size, `${rel} is a stub`).toBeGreaterThan(50_000);
      // …and is not so large that the README becomes a download. The shipped set targets 5 MB.
      expect(size, `${rel} is over the 6 MB the wall budgets`).toBeLessThan(6 * 1024 * 1024);
      const head = readFileSync(file).subarray(0, 6).toString("latin1");
      expect(head, `${rel} is not a GIF`).toMatch(/^GIF8[79]a$/);
    }
  });

  it("every recording in the directory is referenced — no orphans", () => {
    const dir = at("docs/assets/feature-wall");
    const files = readdirSync(dir).filter((f) => f.endsWith(".gif"));
    expect(files.length).toBe(referenced.length);
    for (const f of files) {
      expect(referenced, `${f} is in the tree but nothing links it`)
        .toContain(`docs/assets/feature-wall/${f}`);
    }
  });

  it("the picture-quality recording is the one this section added", () => {
    expect(referenced).toContain("docs/assets/feature-wall/08-picture-quality.gif");
    expect(readme).toMatch(/## Photos are compressed before they are sent/);
  });
});
