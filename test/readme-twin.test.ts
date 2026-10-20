import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { publicPath } from "./support/public-root.mjs";

/**
 * ══ THE README'S TWIN SAYS WHAT THE README SAYS ══════════════════════════════════════════════
 *
 * `README.ohmarchy.md` is the same page wearing the ohmarchy face, kept by hand. Nothing generates
 * it, so it drifted: an old download badge, a missing provider line, a missing condition on the
 * unsubscribe sentence. The twin may differ in its pictures and in its face switch, and in nothing
 * else. So both files are compared with exactly those lines and frames taken out, and every
 * picture the twin names must exist.
 */
const paper = readFileSync(publicPath("README.md"), "utf8");
const twin = readFileSync(publicPath("README.ohmarchy.md"), "utf8");

/** The page with its face-specific parts replaced by placeholders. */
function text(page: string): string {
  return page
    // A gallery frame: the paper GIF, or the twin's light/dark picture of the same recording.
    .replace(/<picture><source [^>]*feature-wall-ohmarchy\/(\d\d)-[a-z-]+?-dark\.webp"><img [^>]*><\/picture>/g, "[frame $1]")
    .replace(/<img src="docs\/assets\/feature-wall\/(\d\d)-[a-z-]+\.gif"[^>]*>/g, "[frame $1]")
    .split("\n")
    // The face switch (its link and its two images) and the hero picture.
    .filter((l) => !/^<a href="(README\.ohmarchy\.md|https:\/\/github\.com\/trafficflowhq\/ohmail\/)"><picture>$/.test(l))
    .filter((l) => !/docs\/readme\/toggle-|docs\/assets\/faces\//.test(l))
    .join("\n");
}

describe("README.ohmarchy.md", () => {
  it("is README.md apart from its pictures and its face switch", () => {
    // Anti-vacuity: the comparison runs over the whole page, badge and providers included.
    expect(text(twin)).toContain("img.shields.io/badge/download-v");
    expect(text(twin)).toContain("### Model providers and keys");
    expect(text(twin)).toBe(text(paper));
  });

  it("wears the ohmarchy face, and links back to the paper one", () => {
    expect(twin).toContain('<a href="https://github.com/trafficflowhq/ohmail/"><picture>');
    expect(twin).toContain("docs/readme/toggle-ohmarchy-light.svg");
    expect(paper).toContain('<a href="README.ohmarchy.md"><picture>');
    expect(twin).toMatch(/docs\/assets\/faces\/hero-ohmarchy\.webp/);
  });

  it("names only pictures that exist", () => {
    const named = [...twin.matchAll(/(?:src|srcset)="(docs\/[^"]+)"/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(8);
    for (const rel of named) expect(existsSync(publicPath(rel)), rel).toBe(true);
  });
});
