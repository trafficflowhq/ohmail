/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  COLUMNS_KEY,
  COLUMNS_VERSION,
  LIST,
  RAIL,
  RAIL_VAR,
  SPLIT_VAR,
  applyColumnVars,
  columnsBootScript,
  normalizeColumns,
  readColumns,
  splitUserValue,
  writeColumns,
} from "@ohmail/app-logic/lists/column-store";

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
 * The startup frame shares the live frame's columns, measured in `boot-sync-line-frames.test.ts`.
 * Mutations watched: the boot script's `Math.min` ceiling changed to 400 → the agreement table
 * red at 720.
 */

describe("app.css — the two properties the columns hang on, and the numbers they clamp to", () => {
  it("the boot silhouette stands in the SAME two properties, so nothing jumps when it fills in", () => {
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
    const opening = read("packages/app/src/frame/OpeningFrame.tsx");
    const live = read("packages/app/src/frame/FrameParts.tsx");
    const placement = read("packages/app/src/frame/placement.css");
    for (const frame of [opening, live]) {
      expect(frame).toContain('from "./Columns.js"');
      expect(frame).toContain("<Columns");
    }
    expect(placement).toContain(`clamp(${RAIL.min}px, var(${RAIL_VAR}, var(--rail)), ${RAIL.max}px)`);
    expect(placement).toContain(`grid-template-columns: var(${SPLIT_VAR}, var(--fr-listw) minmax(0, 1fr))`);
  });

  it("the desktop's boot line takes its box from the same rail track, so it stays inside the rail", () => {
    const opening = readFileSync(resolve(process.cwd(), "packages/app/src/frame/OpeningFrame.tsx"), "utf8");
    const placement = readFileSync(resolve(process.cwd(), "packages/app/src/frame/placement.css"), "utf8");
    expect(opening).toMatch(/rail=\{[\s\S]*?className="fr-opening-rail"[\s\S]*?<Rail[\s\S]*?foot=\{status\}/);
    expect(placement).toMatch(/\.fr-columns\s*\{[^}]*grid-template-columns: var\(--fr-rail\) minmax\(0, 1fr\)/);
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
      };

      run();
      applyColumnVars(document.documentElement, readColumns());
      const live = {
        rail: document.documentElement.style.getPropertyValue(RAIL_VAR),
        split: document.documentElement.style.getPropertyValue(SPLIT_VAR),
      };

      expect(stamped).toEqual(live);
    });
  }

  it("and the text it writes is the split's real track list, not something that merely parses", () => {
    window.localStorage.setItem(COLUMNS_KEY, JSON.stringify({ v: 1, list: 560 }));
    (0, eval)(columnsBootScript());
    expect(document.documentElement.style.getPropertyValue(SPLIT_VAR)).toBe(splitUserValue(560));
    // The viewer's floor is handed to the browser as an expression rather than measured,
    // because the stamp runs before the tile-gap token is guaranteed to be resolvable.
    expect(splitUserValue(560)).toContain(`calc(100% - ${LIST.viewerMin}px - var(--gap-tile))`);
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
