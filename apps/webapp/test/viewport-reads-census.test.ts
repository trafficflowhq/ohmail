import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * A VIEWPORT READ IN THE SHELL GOES THROUGH `ui-zoom.ts`. Under the web door's Text size (a CSS
 * zoom on <html>), `getBoundingClientRect`, `clientX/Y` and `innerWidth/Height` answer in viewport
 * px while style lengths and `scrollTop` stay in CSS px — measured in Chromium and WebKit, where a
 * popover placed at its anchor's rect landed off it by the zoom factor. So every such read in these
 * roots is `cssRect` / `cssPoint` / `cssViewport`, or is admitted below by count with the reason it
 * belongs in viewport px. Comments are blanked first (`source-scan.mjs`); a planted raw read is the
 * positive control.
 */
/* @reads: apps/webapp/app/shell, apps/webapp/app/views, apps/webapp/app/components, apps/webapp/app/letter-body, packages/app-logic/src, packages/ui/src */
const REPO = join(__dirname, "..", "..", "..");
const ROOTS = ["apps/webapp/app/shell", "apps/webapp/app/views", "apps/webapp/app/components", "apps/webapp/app/letter-body", "apps/webapp/app/(product)", "packages/app-logic/src", "packages/ui/src"];
const RAW = /getBoundingClientRect\s*\(|\.clientX\b|\.clientY\b|\binnerWidth\b|\binnerHeight\b/g;

/** Reads that belong in viewport px, each with why. A new one is a reviewed diff. */
const ADMITTED: Record<string, { count: number; why: string }> = {
  "packages/ui/src/ui-zoom.ts": { count: 5, why: "the helper itself" },
  "packages/app-logic/src/geometry/ui-zoom.ts": { count: 5, why: "the helper's twin, for behaviour that may not import the kit" },
  "apps/webapp/app/shell/drag-file.ts": {
    count: 6,
    why: "the drag's slop compares two pointer reads, and the hit test `elementFromPoint` takes viewport px",
  },
  "apps/webapp/app/views/OhboxView.tsx": { count: 4, why: "a press-and-hold slop: two pointer reads compared" },
  "packages/app-logic/src/lists/list-window.ts": {
    count: 2,
    why: "the page-scroll half: the ROOT scroller's scrollTop is viewport px under the zoom (measured)",
  },
  "packages/ui/src/composites/StreamCard.tsx": {
    count: 1,
    why: "mirrors a `max-width: 640px` media query, and media queries are viewport px",
  },
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const rawCount = (src: string): number => (withoutComments(src).match(RAW) ?? []).length;

function walkCss(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walkCss(p);
    return name.endsWith(".css") ? [p] : [];
  });
}

describe("viewport reads in the shell go through ui-zoom", () => {
  const counts = new Map<string, number>();
  for (const root of ROOTS) {
    for (const file of walk(join(REPO, root))) {
      const n = rawCount(readFileSync(file, "utf8"));
      if (n > 0) counts.set(relative(REPO, file), n);
    }
  }

  it("the reader counts a planted raw read and ignores one in a comment", () => {
    expect(rawCount("const r = el.getBoundingClientRect(); // innerWidth")).toBe(1);
    expect(rawCount("/* e.clientX */ const x = e.clientX;")).toBe(1);
    expect(rawCount("const v = cssViewport().height;")).toBe(0);
  });

  it("the walk reaches the roots and finds the admitted reads", () => {
    /* The positive control on the real tree: a walk that found nothing passes every refusal. */
    expect(counts.get("packages/ui/src/ui-zoom.ts")).toBe(5);
    expect(counts.size).toBeGreaterThanOrEqual(Object.keys(ADMITTED).length);
  });

  it("every viewport unit in the shell's stylesheets is divided by --ui-zoom, as a well-formed calc", () => {
    /* `100dvh` under a CSS zoom renders zoom times the window. And a subtraction needs its spaces:
       `… / var(--ui-zoom, 1) -10px` is a negative NUMBER, not a minus, and voids the declaration. */
    const bare: string[] = [];
    const malformed: string[] = [];
    let divided = 0;
    const sheets = [
      ...ROOTS.flatMap((root) => walkCss(join(REPO, root))),
      join(REPO, "apps/webapp/app/app.css"),
      join(REPO, "apps/webapp/app/zero-layout.css"),
    ];
    {
      for (const file of sheets) {
        const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/@supports\s*\([^)]*\)/g, "");
        for (const m of css.matchAll(/100(?:d|s|l)?v[hw]\b([^;{}]{0,24})/g)) {
          const after = m[1] ?? "";
          if (!after.startsWith(" / var(--ui-zoom, 1)")) { bare.push(`${relative(REPO, file)}: ${m[0]}`); continue; }
          divided++;
          if (!/^ \/ var\(--ui-zoom, 1\)(\)| [-+] )/.test(after)) malformed.push(`${relative(REPO, file)}: ${m[0]}`);
        }
      }
    }
    expect(divided, "the walk read no stylesheet").toBeGreaterThan(10);
    expect(bare, "a viewport unit not divided by --ui-zoom").toEqual([]);
    expect(malformed, "a subtraction without its spaces").toEqual([]);
  });

  it("every raw read is admitted, by file and by count, and no admission is stale", () => {
    const unadmitted = [...counts].filter(([f, n]) => ADMITTED[f]?.count !== n);
    expect(unadmitted, "a raw viewport read outside ui-zoom.ts — use cssRect / cssPoint / cssViewport").toEqual([]);
    const stale = Object.keys(ADMITTED).filter((f) => !counts.has(f));
    expect(stale, "an admission whose reads are gone").toEqual([]);
  });
});
