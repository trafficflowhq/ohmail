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
  "packages/app-logic/src/ohbox/pointer.ts": { count: 4, why: "a press-and-hold slop: two pointer reads compared" },
  "packages/app-logic/src/lists/list-window.ts": {
    count: 2,
    why: "the page-scroll half: the ROOT scroller's scrollTop is viewport px under the zoom (measured)",
  },
  "packages/ui/src/composites/StreamCard.tsx": {
    count: 1,
    why: "mirrors a `max-width: 640px` media query, and media queries are viewport px",
  },
};

/**
 * OWED, NOT ADMITTED: the kit's parts place things by raw reads (a menu at its anchor or pointer, a
 * ring's glide, a width or a pull or a swipe from a pointer's travel, a drag's ghost and caret), the
 * very reads this census exists for, and may not import `ui-zoom.ts` yet (their border:
 * `packages/ui/test/old-new-apart.test.ts`). Exact counts, printed below; the list only shrinks, and
 * a new raw read in one of these files is red like any other.
 */
const OWED_WHY = "the kit's second step moves these reads through ui-zoom before the frame draws the part for a person";
const OWED: Record<string, number> = {
  "packages/ui/src/base/Overlays/Menu.tsx": 2,
  "packages/ui/src/base/Overlays/menu-place.ts": 2,
  "packages/ui/src/calendar/Event/EventCard.tsx": 2,
  "packages/ui/src/calendar/Grids/AgendaRow.tsx": 2,
  "packages/ui/src/mail/Editor/recipient-drag.ts": 17,
  "packages/ui/src/mail/Lists/ReadSquares.tsx": 1,
  "packages/ui/src/mail/Lists/Row.tsx": 2,
  "packages/ui/src/mail/Lists/row-swipe.tsx": 5,
  "packages/ui/src/mail/Shell/ColumnHandle.tsx": 2,
  "packages/ui/src/mail/Shell/Switcher.tsx": 1,
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
    const unadmitted = [...counts].filter(([f, n]) => ADMITTED[f]?.count !== n && OWED[f] !== n);
    expect(unadmitted, "a raw viewport read outside ui-zoom.ts — use cssRect / cssPoint / cssViewport").toEqual([]);
    const stale = Object.keys(ADMITTED).filter((f) => !counts.has(f));
    expect(stale, "an admission whose reads are gone").toEqual([]);
  });

  it("the reads the kit owes are printed, each exact: one that moved through ui-zoom edits its line down", () => {
    for (const [file, count] of Object.entries(OWED)) console.info(`OWED ${file} ${count}: ${OWED_WHY}`);
    expect(Object.keys(OWED).filter((f) => !/^packages\/ui\/src\/(base|mail|calendar)\//.test(f)), "only the kit's parts owe").toEqual([]);
    expect(Object.entries(OWED).filter(([f, n]) => counts.get(f) !== n), "an owed count that is no longer exact").toEqual([]);
  });
});
