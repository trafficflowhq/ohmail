/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  COLUMNS_KEY,
  COLUMNS_VERSION,
  LIST,
  RAIL,
  RAIL_TRACK,
  RAIL_VAR,
  SPLIT_SK_VAR,
  SPLIT_VAR,
  applyColumnVars,
  columnsBootScript,
  normalizeColumns,
  readColumns,
  splitSkeletonValue,
  splitUserValue,
  writeColumns,
} from "../app/shell/column-store";

/**
 * THE THREE COLUMNS' GEOMETRY — pinned where it actually lives, which is three files and a
 * string of JavaScript that never meets a bundler.
 *
 * Two things can rot here and neither is visible in a render:
 *
 *  1. THE NUMBERS DRIFT. The bounds are written twice on purpose — a `clamp()` in the
 *     stylesheet, so a shrinking window re-clamps with no JavaScript, and a clamp in
 *     `column-store.ts`, so the STORE never keeps a value outside them. Two copies of a number
 *     is exactly the shape that goes quietly wrong, so every literal in the CSS is asserted
 *     against the constant it restates.
 *  2. THE PRE-PAINT STAMP AND THE LIVE WRITER DISAGREE. The web door paints from
 *     server-rendered HTML, so its stamp has to be a hand-written string of JavaScript
 *     (`columnsBootScript`); the shell writes the same properties through `applyColumnVars`.
 *     If the two ever produce different text, the first frame is one geometry and the second
 *     is another — a layout jump that looks like a rendering bug and is a copy-paste. So the
 *     string is EXECUTED here against a table of stored values, hostile ones included, and
 *     required to leave `<html>` in exactly the state the function leaves it in.
 *
 * jsdom computes no `calc()` against face tokens, so nothing here claims anything about what
 * the geometry LOOKS like — `scripts/columns-render.mjs` is the rendered assertion, in real
 * Chromium at three widths and both faces. This is the text and the arithmetic.
 *
 * Mutations watched: `--rail-track` inlined back into `.deck` as three literals → the
 * "the handle reads the deck's own track" case red; `column-gap` back to `16px` → red;
 * the boot script's `Math.min` ceiling changed to 400 → the agreement table red at 720;
 * `.list-col{position:relative}` deleted → red.
 */

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const APP = read("apps/webapp/app/app.css");
const HANDLES = read("apps/webapp/app/shell/column-handles.css");
const ZERO = read("apps/webapp/app/zero-layout.css");

/** The declarations of the rule whose selector list starts a line with exactly `selector`. */
function blockOf(css: string, selector: string): string {
  const at = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`).exec(css);
  expect(at, `no rule for ${selector}`).toBeTruthy();
  const open = css.indexOf("{", at!.index + at![0].length - 1);
  return css.slice(open + 1, css.indexOf("}", open)).replace(/\s+/g, " ").trim();
}

describe("app.css — the two properties the columns hang on, and the numbers they clamp to", () => {
  it("the deck's rail track IS the clamp, written once and named so the handle can reuse it", () => {
    const deck = blockOf(APP, ".deck");
    // Asserted against the constant the STAMP composes its own room from, so the stylesheet and
    // the two writers cannot drift on what the rail's track is.
    expect(deck).toContain(`--rail-track: ${RAIL_TRACK};`);
    expect(deck).toContain("grid-template-columns: var(--rail-track) 1fr;");
    // The rail's separator stands in the deck's gap; without this it has no containing block.
    expect(deck).toContain("position: relative;");
  });

  it("the split falls through to the token when nobody has dragged, and its gap IS the tile gap", () => {
    const split = blockOf(APP, ".view.split");
    expect(split).toContain(`grid-template-columns: var(${SPLIT_VAR}, var(--split));`);
    // Was a literal 16px, which under the ohmarchy face was the one 16px seam in a 10px
    // system — and is now also the width of the strip standing in it.
    expect(split).toContain("column-gap: var(--gap-tile);");
    expect(split).not.toContain("16px");
  });

  it("the list column is a positioning context, because its separator is portalled into it", () => {
    expect(blockOf(APP, ".list-col")).toContain("position: relative;");
  });

  it("the boot silhouette stands in the SAME two properties, so nothing jumps when it fills in", () => {
    const sk = blockOf(APP, ".boot-sk-window");
    expect(sk).toContain(RAIL_TRACK);
    // …and its OWN track list, not the shell's: a percentage inside these means the element the
    // property is used on, and this box still contains the rail.
    expect(sk).toContain(`var(${SPLIT_SK_VAR}, minmax(${LIST.min}px, ${LIST.dflt}px) 1fr)`);
    expect(sk).not.toContain(`var(${SPLIT_VAR},`);
  });

  it("the desktop's boot line takes its box from the same rail track, so it stays inside the rail", () => {
    const foot = blockOf(APP, ".gate-boot > .boot-foot");
    expect(foot).toContain(`width: ${RAIL_TRACK};`);
    expect(foot).toContain("left: var(--gap-edge);");
  });
});

describe("column-handles.css — appearance only, tokens only, and no width of its own", () => {
  it("the visible line is the ring product, floored at a hairline", () => {
    // The SAME product `zone-cursor.css` builds the focused tile's ring from: 0 × the face's
    // width under paper (so the floor gives a hairline), 1 × 2px under ohmarchy.
    expect(blockOf(HANDLES, ".col-handle::before")).toContain(
      "width: max(1px, calc(var(--focus-w) * var(--teach)));",
    );
  });

  it("the strip is exactly one tile gap wide, and the rail's sits where the deck's track ends", () => {
    expect(blockOf(HANDLES, ".col-handle")).toContain("width: var(--gap-tile);");
    // `--rail-track` and NOT a second copy of clamp(200,224,360): a handle that drifted from
    // the track it marks would sit in the mail rather than in the seam.
    const railHandle = blockOf(HANDLES, ".col-handle-rail");
    expect(railHandle).toContain("left: calc(var(--gap-edge) + var(--rail-track));");
    // The deck's containing block is its PADDING box, so an uninset strip runs past the tiles
    // into the window frame — a resize cursor and a line over nothing.
    expect(railHandle).toContain("top: var(--gap-edge);");
    expect(railHandle).toContain("bottom: var(--gap-edge);");
    expect(blockOf(HANDLES, ".col-handle-list")).toBe("right: calc(-1 * var(--gap-tile));");
  });

  it("names no face and no layout — paper is quieter because --teach is 0, not by a second rule", () => {
    expect(HANDLES).not.toMatch(/data-face|data-layout/);
  });

  it("below the wide breakpoint there is no seam, so there is no handle and no tab stop", () => {
    expect(HANDLES).toMatch(
      /@media \(max-width: 1023\.98px\) \{\s*\.col-handle-rail,\s*\.col-handle-list \{\s*display: none;/,
    );
  });
});

describe("zero-layout.css — the ladder's own answer to a split that survives below 1024", () => {
  it("the ribbon tier keeps the dragged width and re-shows the list's separator", () => {
    const band = ZERO.slice(ZERO.indexOf("@media (min-width: 722px) and (max-width: 1023.98px)"));
    expect(band).toContain(`grid-template-columns: var(${SPLIT_VAR}, var(--split));`);
    expect(band).toMatch(/:root\[data-layout="zero"\] \.col-handle-list \{\s*display: block;/);
    // The rail is a docked 52px ribbon at this tier — a width the ladder chooses, not the
    // reader — so its handle stays hidden.
    expect(band).not.toContain("col-handle-rail");
  });
});

describe("the store's contract", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("style");
  });

  it("writes `{v:1, rail, list}` and removes the key when neither is set", () => {
    writeColumns({ rail: 300, list: 500 });
    expect(JSON.parse(window.localStorage.getItem(COLUMNS_KEY)!)).toEqual({
      v: COLUMNS_VERSION, rail: 300, list: 500,
    });
    writeColumns({ list: 500 });
    expect(JSON.parse(window.localStorage.getItem(COLUMNS_KEY)!)).toEqual({ v: 1, list: 500 });
    writeColumns({});
    expect(window.localStorage.getItem(COLUMNS_KEY)).toBeNull();
  });

  it("an unknown version is NO PREFERENCE, not a value to repair", () => {
    // A build that means something else by `rail` must not have its numbers adopted here; the
    // defaults stand and the next write replaces the record with a v1 one.
    expect(normalizeColumns({ v: 2, rail: 300, list: 500 })).toEqual({});
    expect(normalizeColumns({ rail: 300 })).toEqual({});
    expect(normalizeColumns({ v: 1, rail: 300 })).toEqual({ rail: 300 });
  });

  it("refuses anything that is not a finite number, per field", () => {
    expect(normalizeColumns({ v: 1, rail: "300", list: 500 })).toEqual({ list: 500 });
    expect(normalizeColumns({ v: 1, rail: Number.NaN, list: Number.POSITIVE_INFINITY })).toEqual({});
    expect(normalizeColumns(null)).toEqual({});
    expect(normalizeColumns("nonsense")).toEqual({});
  });

  it("a malformed jar reads as no preference rather than throwing into the shell", () => {
    window.localStorage.setItem(COLUMNS_KEY, "{not json");
    expect(readColumns()).toEqual({});
  });
});

/**
 * THE AGREEMENT TABLE — the pre-paint string against the live writer.
 *
 * `(0, eval)` rather than a bundler, deliberately: this is exactly how the browser executes it,
 * as a standalone program with no module scope to borrow from. A reference this string acquired
 * to something outside itself would throw here, which is the failure the inline form has in
 * production and the reason the string is hand-written rather than serialized from a function.
 */
describe("the pre-paint stamp writes what the shell writes", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("style");
  });

  const CASES: Array<[string, unknown]> = [
    ["nothing stored", undefined],
    ["both, in range", { v: 1, rail: 304, list: 560 }],
    ["rail only", { v: 1, rail: 200 }],
    ["list only", { v: 1, list: 720 }],
    ["past both ceilings", { v: 1, rail: 99999, list: 99999 }],
    ["under both floors", { v: 1, rail: -40, list: 0 }],
    ["fractional", { v: 1, rail: 224.6, list: 400.4 }],
    ["an unknown version", { v: 2, rail: 300, list: 500 }],
    ["a version that is a string", { v: "1", rail: 300 }],
    ["fields of the wrong type", { v: 1, rail: "300", list: null }],
    ["not an object", 42],
  ];

  for (const [name, value] of CASES) {
    it(`agrees on: ${name}`, () => {
      const raw = value === undefined ? null : JSON.stringify(value);
      /** Reset `<html>` and the jar, then seed this case's stored value. Side effects only. */
      const run = (): void => {
        document.documentElement.removeAttribute("style");
        window.localStorage.clear();
        if (raw !== null) window.localStorage.setItem(COLUMNS_KEY, raw);
      };

      run();
      (0, eval)(columnsBootScript());
      const stamped = {
        rail: document.documentElement.style.getPropertyValue(RAIL_VAR),
        split: document.documentElement.style.getPropertyValue(SPLIT_VAR),
        skeleton: document.documentElement.style.getPropertyValue(SPLIT_SK_VAR),
      };

      run();
      applyColumnVars(document.documentElement, readColumns());
      const live = {
        rail: document.documentElement.style.getPropertyValue(RAIL_VAR),
        split: document.documentElement.style.getPropertyValue(SPLIT_VAR),
        skeleton: document.documentElement.style.getPropertyValue(SPLIT_SK_VAR),
      };

      expect(stamped).toEqual(live);
    });
  }

  it("and the text it writes is the split's real track list, not something that merely parses", () => {
    window.localStorage.setItem(COLUMNS_KEY, JSON.stringify({ v: 1, list: 560 }));
    (0, eval)(columnsBootScript());
    expect(document.documentElement.style.getPropertyValue(SPLIT_VAR)).toBe(splitUserValue(560));
    expect(document.documentElement.style.getPropertyValue(SPLIT_SK_VAR)).toBe(splitSkeletonValue(560));
    // The viewer's floor is handed to the browser as an expression rather than measured,
    // because the stamp runs before the tile-gap token is guaranteed to be resolvable.
    expect(splitUserValue(560)).toContain(`calc(100% - ${LIST.viewerMin}px - var(--gap-tile))`);
    // …and the silhouette's subtracts the rail as well, because its full-width percentage still contains one.
    expect(splitSkeletonValue(560)).toContain(RAIL_TRACK);
    expect(splitSkeletonValue(560)).not.toBe(splitUserValue(560));
  });

  it("a jar that throws on read leaves the defaults standing, in BOTH writers", () => {
    const real = window.localStorage.getItem;
    Object.defineProperty(window.localStorage, "getItem", {
      value: () => { throw new Error("blocked"); },
      configurable: true,
    });
    try {
      expect(() => (0, eval)(columnsBootScript())).not.toThrow();
      expect(document.documentElement.style.getPropertyValue(RAIL_VAR)).toBe("");
      expect(readColumns()).toEqual({});
    } finally {
      Object.defineProperty(window.localStorage, "getItem", { value: real, configurable: true });
    }
  });
});
