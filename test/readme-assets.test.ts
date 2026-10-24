import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { publicPath, ROOT } from "./support/public-root.mjs";

/**
 * ══ THE TWO README FACES SHOW FILES THAT EXIST, AND ONLY THOSE ═══════════════════════════════════
 *
 * README.md (paper) and README.ohmarchy.md (its twin in the ohmarchy face) show screenshots and
 * recordings from `docs/assets/readme/`. A `<picture>` whose file is missing fails nothing: GitHub
 * draws the alt text, and a stranger finds the hole on the project's front page.
 *
 * So: every path either page names exists, is a real file of its kind and not a stub; every file in
 * the directory is named by one of the pages (no orphans); the twin is README.md with the face
 * swapped and nothing else, so the two pages cannot drift apart; and the ohmarchy light captures
 * show the unread wash the apps ship.
 */
const at = (rel: string): string => publicPath(rel);
const DIR = "docs/assets/readme";

const paper = readFileSync(at("README.md"), "utf8");
const twin = readFileSync(at("README.ohmarchy.md"), "utf8");

const named = (md: string): string[] =>
  [...md.matchAll(/(?:src|srcset|href)="(docs\/assets\/readme\/[^"]+)"/g)].map((m) => m[1]!);

/** README.ohmarchy.md back into README.md: the switch, the twin link, the tile paths. */
function toPaper(md: string): string {
  return md
    .replace('<a href="README.md"><picture>', '<a href="README.ohmarchy.md"><picture>')
    .replace('srcset="docs/assets/readme/toggle-ohmarchy-dark.svg"', 'srcset="docs/assets/readme/toggle-paper-dark.svg"')
    .replace(
      'src="docs/assets/readme/toggle-ohmarchy-light.svg" alt="paper / ohmarchy face switch — ohmarchy is active; opens this README in the paper face"',
      'src="docs/assets/readme/toggle-paper-light.svg" alt="paper / ohmarchy face switch — paper is active; opens this README in the ohmarchy face"',
    )
    .replace("[twin in the other face](README.md)", "[twin in the other face](README.ohmarchy.md)")
    .replace(/(docs\/assets\/readme\/)ohmarchy-([a-z0-9-]+\.(?:gif|webp))/g, "$1$2");
}

const headings = (md: string): string[] => md.split("\n").filter((l) => /^#{2,3} /.test(l));

describe("the README's two faces", () => {
  const all = [...new Set([...named(paper), ...named(twin)])];

  it("name their pictures — and the list is not empty", () => {
    // Anti-vacuity: a regex that stopped matching would make every assertion below pass.
    expect(named(paper).length).toBeGreaterThanOrEqual(30);
    expect(named(twin).length).toBe(named(paper).length);
    expect(named(twin).some((p) => p.includes("/ohmarchy-")), "the twin shows no ohmarchy tile").toBe(true);
  });

  it("every named file exists, is the kind its name says, and is not a stub", () => {
    for (const rel of all) {
      const file = at(rel);
      expect(existsSync(file), `${rel} is missing`).toBe(true);
      const size = statSync(file).size;
      expect(size, `${rel} is over 5 MB`).toBeLessThan(5 * 1024 * 1024);
      const head = readFileSync(file).subarray(0, 12).toString("latin1");
      if (rel.endsWith(".svg")) {
        expect(head, `${rel} is not an SVG`).toMatch(/^(<svg|<\?xml)/);
        continue;
      }
      expect(size, `${rel} is a stub`).toBeGreaterThan(10_000);
      if (rel.endsWith(".gif")) expect(head, `${rel} is not a GIF`).toMatch(/^GIF8[79]a/);
      else if (rel.endsWith(".webp")) expect(head, `${rel} is not a WebP`).toMatch(/^RIFF.{4}WEBP$/s);
      else throw new Error(`${rel}: an image kind this test does not know`);
    }
  });

  it("every file in the directory is named by one of the pages — no orphans", () => {
    for (const f of readdirSync(at(DIR))) {
      expect(all, `${DIR}/${f} is in the tree but neither page shows it`).toContain(`${DIR}/${f}`);
    }
  });

  it("the twin is README.md in the other face, and nothing else", () => {
    expect(twin).not.toBe(paper);
    expect(toPaper(twin)).toBe(paper);
    expect(headings(twin)).toEqual(headings(paper));
    expect(headings(paper).length).toBeGreaterThanOrEqual(10);
  });

  it("the ohmarchy light captures show the unread wash the apps ship", () => {
    // The ohmarchy light pictures were taken with the unread panel at #ece9de. Should the token move
    // again, the pictures are re-shot with it; until then this says they are stale.
    const css = readFileSync(join(ROOT, "packages/tokens/src/ohmarchy.css"), "utf8");
    const phone = readFileSync(join(ROOT, "apps/mobile/src/theme/ohmarchy.ts"), "utf8");
    expect(css).toMatch(/--unread-wash:\s*#ece9de;/i);
    expect(phone).toMatch(/unreadWash:\s*"#ece9de"/i);
    expect(css).not.toMatch(/#e7f1ff/i);
    expect(phone).not.toMatch(/#e7f1ff/i);
  });
});
