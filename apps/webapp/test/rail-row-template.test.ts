import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ═══ ONE FOLDER-ROW TEMPLATE, AND A DRAWER WITH A WIDTH OF ITS OWN ═════════════════════
 *
 * DESIGN-FOLD-WIDTHS §4. At the 1024 rail (a 200px track, touch) every folder read "F…", "I…",
 * "K…": the row spent its width on the twisty column, the glyph, a 14px-per-level indent and an
 * always-present ⋯ column. In the phone drawer (76vw: 273px at 360, 624px at an unfolded 821)
 * the rail content kept its desktop width inside a wider drawer. The rule is one row template
 * at every width (`rail.css`), the ⋯ taking no column where hover exists, the indent stopping at
 * the studio's fifth level (`FolderFold`), and a drawer of `min(320px, 100vw − 48px)` (`app.css`).
 *
 * Mutation: put `inset: 0 24% 0 0` back on the drawer, or `r.depth * 14` on the row — red.
 */

const read = (rel: string): string =>
  readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("rail.css — the folder row template", () => {
  const css = read("packages/ui/src/composites/rail.css");
  it("the row box is 5px 6px with a 4px lead and a 7px glyph gap, 28 tall on a fine pointer", () => {
    expect(css).toMatch(/\.frow\s*\{[^}]*min-height:\s*28px/);
    expect(css).toMatch(/\.frow \.ritem\s*\{[^}]*padding:\s*5px 6px 5px 4px[^}]*gap:\s*7px/);
    expect(css).toMatch(/\.fglyph\s*\{[^}]*width:\s*12px[^}]*height:\s*12px/);
  });
  it("the ⋯ takes no column on a pointer device: absolute at the row's edge, the tail reserving room only while shown", () => {
    expect(css).toMatch(/\.fmore\s*\{[^}]*position:\s*absolute[^}]*right:\s*4px/);
    expect(css).toMatch(/\.frow:hover \.ritem,\s*\.frow:focus-within \.ritem,\s*\.frow\.menu-on \.ritem\s*\{\s*padding-right:\s*30px/);
  });
  it("where hover does not exist the ⋯ is a standing 24px column, and a coarse pointer's row is 44 tall", () => {
    const at = css.indexOf("@media (hover:none)");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("}", css.indexOf("{", css.indexOf("{", at) + 1)) + 1);
    expect(block).toMatch(/\.fmore\s*\{[^}]*position:\s*static[^}]*flex:\s*0 0 24px/);
    expect(css).toMatch(/@media \(pointer:coarse\)\s*\{\s*\.frow\s*\{\s*min-height:\s*44px/);
  });
  it("below 1366 the rail's right padding gives 4px to the label; wider windows keep 12", () => {
    expect(css).toMatch(/@media \(max-width: 1365\.98px\)\s*\{\s*\.rail\s*\{\s*padding-right:\s*8px/);
    expect(css).toMatch(/^\.rail\s*\{\s*padding:\s*18px 12px 18px 16px/m);
  });
});

describe("app.css — the drawer's width", () => {
  const css = read("apps/webapp/app/app.css");
  const at = css.indexOf("@media (max-width: 1023.98px)");
  const band = css.slice(at, css.indexOf("@media (max-width: 699.98px)", at));
  it("is min(320px, 100vw − 48px), never a share of the viewport", () => {
    /* The window's width in the page's own px: divided by the web door's Text size zoom (1 unset). */
    expect(band).toMatch(/\.deck > \.rail\s*\{[^}]*width:\s*min\(320px, calc\(100vw \/ var\(--ui-zoom, 1\) - 48px\)\)/);
    expect(band).not.toMatch(/\.deck > \.rail\s*\{[^}]*inset:\s*0 24%/);
  });
});

describe("the folder rail stops indenting after the studio's fifth level", () => {
  const fold = read("packages/ui/src/mail/Lists/FolderFold.tsx");
  const css = read("packages/ui/src/mail/Lists/folder-fold.css");
  const rail = read("packages/app/src/folder/FolderRail.tsx");

  it("the full and narrow rails share the capped tree and use their own spacing tokens", () => {
    const seat = read("packages/app/src/folder/RailSeat.tsx");
    expect(seat).toMatch(/<FolderRail\s+[^>]*narrow=\{plan\.rail === "dock"\}/);
    expect(rail).toMatch(/<FolderFold\s+[^>]*narrow=\{props\.narrow\}/);
    expect(rail).toContain("depth: row.depth");
    expect(fold).toMatch(/"--oh-folderfold-depth": Math\.min\(folder\.depth, 5\)/);
    expect(css).toMatch(/\.oh-folderfold\s*\{[^}]*--oh-folderfold-step: var\(--s3\)/);
    expect(css).toMatch(/\.oh-folderfold\[data-narrow\]\s*\{[^}]*--oh-folderfold-step: var\(--s4\)/);
    expect(css).toMatch(/--oh-folderfold-in: calc\(var\(--oh-folderfold-depth, 0\) \* var\(--oh-folderfold-step\)\)/);
    expect(css).toContain("padding-left: var(--oh-folderfold-in)");
  });
});
