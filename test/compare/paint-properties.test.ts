import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, PAINT } from "./render.mjs";
import { readScene } from "./scene.mjs";
import type { PaintLists, PaintRow, Scene, Variant } from "./scene.d.mts";

/**
 * The lists of what the drawn values say (`paint-properties.json`), held against the browser they were
 * written for: every property it computes stands in the file once, every listed row is said where that
 * property alone moves, and the reader says nothing the file does not name. A new browser that computes
 * a new property fails here until the property has its place.
 */

const VARIANT: Variant = { device: "desktop", face: "paper", scheme: "light", width: 400, height: 300, scale: 1 };
const LISTS: PaintLists = { words: PAINT.words, boxes: PAINT.boxes, shapes: PAINT.shapes };
const LIST_NAMES = ["words", "boxes", "shapes"] as const;
type ListName = (typeof LIST_NAMES)[number];
const keyOf = (p: string): string => p.replace(/^-/, "").replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

/** Where one row is tried: the page that holds `#t`, what stands on both sides (`base`), and the value that is set on one. */
type Example = [value: string, base?: string, page?: keyof typeof PAGES];

const PIC = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="4" height="4"/></svg>`)}`;
const GRADIENT = "linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))";
const ICON = (shape: string): string => `<button aria-label="Icon" style="all:unset;display:block;width:40px;height:40px"><svg viewBox="0 0 16 16" style="width:32px;height:32px"><defs><marker id="m"><circle r="1"/></marker></defs>${shape}</svg></button>`;
const PAGES = {
  words: `<p id="t">Some  words
    12:15</p>`,
  inline: `<p><span id="t">Some words</span></p>`,
  quote: `<q id="t">Some words</q>`,
  math: `<math><mi id="t">x</mi></math>`,
  box: `<div id="t" style="width:40px;height:20px"></div>`,
  blending: `<div id="t" style="width:40px;height:20px"><i style="mix-blend-mode:multiply">x</i></div>`,
  picture: `<img id="t" alt="" src="${PIC}" style="width:40px;height:20px">`,
  tick: `<input id="t" type="checkbox" aria-label="Tick" checked>`,
  item: `<ul><li id="t">Some words</li></ul>`,
  table: `<table id="t"><tr><td style="border:1px solid">a</td><td style="border:1px solid">b</td></tr></table>`,
  cell: `<table><tr><td id="t" style="border:1px solid;width:20px;height:20px"></td></tr></table>`,
  path: ICON(`<path id="t" class="line" d="M2 8h12v4"/>`),
  circle: ICON(`<circle id="t" class="line" cx="8" cy="8" r="4"/>`),
  rect: ICON(`<rect id="t" class="line" x="2" y="2" width="8" height="8"/>`),
  letter: ICON(`<text id="t" x="8" y="12" style="font:10px sans-serif">A</text>`),
};
const LINED = "text-decoration-line:underline", FILLED = "background-color:rgb(255, 0, 0)", BEHIND = `background-image:${GRADIENT}`, MASKED = `mask-image:${GRADIENT}`;
const FRAMED = `border:4px solid;border-image-source:${GRADIENT}`, BOXMASK = `-webkit-mask-box-image-source:${GRADIENT}`, COLS = "column-rule-style:solid", ROWS = "row-rule-style:solid";

const EXAMPLES: Record<ListName, Record<string, Example>> = {
  words: {
    "color": ["rgb(255, 0, 0)"], "font-family": ["monospace"], "font-size": ["20px"], "font-weight": ["700"], "font-style": ["italic"], "line-height": ["30px"],
    "letter-spacing": ["1px"], "font-variation-settings": ['"wght" 500'], "text-transform": ["uppercase"],
    "font-stretch": ["75%"], "font-kerning": ["none"], "font-optical-sizing": ["none"], "font-feature-settings": ['"smcp"'], "font-variant-alternates": ["historical-forms"],
    "font-variant-caps": ["small-caps"], "font-variant-east-asian": ["jis78"], "font-variant-emoji": ["text"], "font-variant-ligatures": ["none"], "font-variant-numeric": ["tabular-nums"],
    "font-variant-position": ["sub"], "font-size-adjust": ["0.5"], "font-palette": ["dark"], "font-language-override": ['"TRK"'], "font-synthesis-weight": ["none"],
    "font-synthesis-style": ["none"], "font-synthesis-small-caps": ["none"],
    "word-spacing": ["2px"], "text-indent": ["10px"], "hyphens": ["auto"], "hyphenate-character": ['"="'], "text-spacing-trim": ["space-all"], "text-autospace": ["normal"],
    "white-space-collapse": ["preserve"], "tab-size": ["2", "white-space-collapse:preserve"], "text-fit": ["grow"],
    "text-overflow": ["ellipsis", "overflow:hidden;width:60px"], "-webkit-line-clamp": ["2"],
    "text-decoration-line": ["line-through"], "text-decoration-style": ["dotted", LINED], "text-decoration-color": ["rgb(255, 0, 0)", LINED], "text-decoration-thickness": ["2px", LINED],
    "text-underline-offset": ["3px", LINED], "text-underline-position": ["under", LINED], "text-decoration-skip-ink": ["none", LINED],
    "text-shadow": ["rgb(255, 0, 0) 1px 1px 0px"], "text-emphasis-style": ["dot"], "text-emphasis-color": ["rgb(255, 0, 0)", "text-emphasis-style:dot"], "text-emphasis-position": ["under", "text-emphasis-style:dot"],
    "direction": ["rtl"], "unicode-bidi": ["bidi-override", "", "inline"], "writing-mode": ["vertical-rl"], "text-orientation": ["upright", "writing-mode:vertical-rl"], "text-combine-upright": ["all", "writing-mode:vertical-rl"],
    "-webkit-text-fill-color": ["rgb(255, 0, 0)"], "-webkit-text-stroke-width": ["1px"], "-webkit-text-stroke-color": ["rgb(255, 0, 0)", "-webkit-text-stroke-width:1px"],
    "-webkit-text-security": ["disc"], "-webkit-rtl-ordering": ["visual"], "-webkit-locale": ['"tr"'],
    "text-rendering": ["geometricprecision"], "initial-letter": ["2"], "quotes": ['"<" ">"', "", "quote"],
    "math-depth": ["2", "", "math"], "math-shift": ["compact", "", "math"], "math-style": ["normal", "", "math"],
  },
  boxes: {
    "background-color": ["rgb(255, 0, 0)"], "background-image": [GRADIENT], "background-position": ["4px 4px", BEHIND], "background-size": ["8px 8px", BEHIND], "background-repeat": ["no-repeat", BEHIND],
    "background-origin": ["content-box", BEHIND], "background-attachment": ["fixed", BEHIND], "background-blend-mode": ["multiply", BEHIND], "background-clip": ["content-box", FILLED],
    "border-top-width": ["1px", "border-top-style:solid"], "border-top-style": ["solid"], "border-top-color": ["rgb(255, 0, 0)", "border-top-style:solid"],
    "border-right-width": ["1px", "border-right-style:solid"], "border-right-style": ["solid"], "border-right-color": ["rgb(255, 0, 0)", "border-right-style:solid"],
    "border-bottom-width": ["1px", "border-bottom-style:solid"], "border-bottom-style": ["solid"], "border-bottom-color": ["rgb(255, 0, 0)", "border-bottom-style:solid"],
    "border-left-width": ["1px", "border-left-style:solid"], "border-left-style": ["solid"], "border-left-color": ["rgb(255, 0, 0)", "border-left-style:solid"],
    "border-top-left-radius": ["4px", FILLED], "border-top-right-radius": ["4px", FILLED], "border-bottom-right-radius": ["4px", FILLED], "border-bottom-left-radius": ["4px", FILLED],
    "corner-top-left-shape": ["bevel", `${FILLED};border-top-left-radius:8px`], "corner-top-right-shape": ["bevel", `${FILLED};border-top-right-radius:8px`],
    "corner-bottom-right-shape": ["bevel", `${FILLED};border-bottom-right-radius:8px`], "corner-bottom-left-shape": ["bevel", `${FILLED};border-bottom-left-radius:8px`],
    "border-shape": ["circle()"], "border-image-source": [GRADIENT, "border:4px solid"], "border-image-slice": ["30%", FRAMED], "border-image-width": ["2", FRAMED], "border-image-outset": ["1", FRAMED], "border-image-repeat": ["round", FRAMED],
    "box-shadow": ["rgb(255, 0, 0) 0px 0px 0px 1px"], "box-decoration-break": ["clone", FILLED],
    "outline-style": ["solid"], "outline-width": ["1px", "outline-style:solid"], "outline-color": ["rgb(255, 0, 0)", "outline-style:solid"], "outline-offset": ["2px", "outline-style:solid"],
    "opacity": ["0.5", FILLED], "filter": ["blur(1px)"], "backdrop-filter": ["blur(1px)"], "mix-blend-mode": ["multiply"], "isolation": ["isolate", "", "blending"],
    "clip-path": ["inset(1px)"], "clip": ["rect(0px, 1px, 1px, 0px)", "position:absolute"],
    "mask-image": [GRADIENT], "mask-mode": ["alpha", MASKED], "mask-repeat": ["no-repeat", MASKED], "mask-position": ["1px 1px", MASKED], "mask-clip": ["content-box", MASKED], "mask-origin": ["content-box", MASKED],
    "mask-size": ["4px 4px", MASKED], "mask-composite": ["intersect", MASKED],
    "-webkit-mask-box-image-source": [GRADIENT], "-webkit-mask-box-image-slice": ["10", BOXMASK], "-webkit-mask-box-image-width": ["2", BOXMASK], "-webkit-mask-box-image-outset": ["1", BOXMASK], "-webkit-mask-box-image-repeat": ["round", BOXMASK],
    "-webkit-box-reflect": ["below"],
    "object-fit": ["cover", "", "picture"], "object-position": ["0% 0%", "", "picture"], "object-view-box": ["inset(1px)", "", "picture"], "image-orientation": ["none", "", "picture"], "image-rendering": ["pixelated", "", "picture"],
    "appearance": ["none", "", "tick"], "accent-color": ["rgb(255, 0, 0)", "", "tick"], "color-scheme": ["dark", "", "tick"], "resize": ["both", "overflow:auto"],
    "list-style-type": ["square", "", "item"], "list-style-image": [GRADIENT, "", "item"], "list-style-position": ["inside", "", "item"],
    "counter-increment": ["x 2"], "counter-reset": ["x 3"], "counter-set": ["x 4"], "content": [`url("${PIC}")`],
    "column-rule-style": ["solid"], "column-rule-width": ["1px", COLS], "column-rule-color": ["rgb(255, 0, 0)", COLS], "column-rule-break": ["intersection", COLS],
    "column-rule-inset-cap-start": ["1px", COLS], "column-rule-inset-cap-end": ["1px", COLS], "column-rule-inset-junction-start": ["1px", COLS], "column-rule-inset-junction-end": ["1px", COLS],
    "column-rule-visibility-items": ["all", COLS],
    "row-rule-style": ["solid"], "row-rule-width": ["1px", ROWS], "row-rule-color": ["rgb(255, 0, 0)", ROWS], "row-rule-break": ["intersection", ROWS],
    "row-rule-inset-cap-start": ["1px", ROWS], "row-rule-inset-cap-end": ["1px", ROWS], "row-rule-inset-junction-start": ["1px", ROWS], "row-rule-inset-junction-end": ["1px", ROWS],
    "row-rule-visibility-items": ["all", ROWS], "rule-overlap": ["column-over-row", ROWS],
    "border-collapse": ["collapse", "", "table"], "empty-cells": ["hide", "", "cell"],
    "contain": ["paint"], "content-visibility": ["hidden"], "overflow-clip-margin": ["4px", "overflow:clip"],
    "perspective": ["100px"], "perspective-origin": ["0px 0px", "perspective:100px"], "transform-style": ["preserve-3d"], "backface-visibility": ["hidden", "transform:rotate(10deg)"],
    "offset-path": ['path("M 0 0 L 10 10")'], "offset-distance": ["5px", 'offset-path:path("M 0 0 L 10 10")'], "offset-rotate": ["30deg", 'offset-path:path("M 0 0 L 10 10")'],
    "offset-anchor": ["0% 0%", 'offset-path:path("M 0 0 L 10 10")'], "offset-position": ["0% 0%", 'offset-path:path("M 0 0 L 10 10")'],
  },
  shapes: {
    "fill": ["rgb(255, 0, 0)", "", "path"], "fill-opacity": ["0.5", "fill:rgb(255, 0, 0)", "path"], "fill-rule": ["evenodd", "fill:rgb(255, 0, 0)", "path"],
    "stroke": ["rgb(0, 0, 255)", "", "path"], "stroke-width": ["3px", "", "path"], "stroke-opacity": ["0.5", "", "path"], "stroke-linecap": ["round", "", "path"], "stroke-linejoin": ["round", "", "path"],
    "stroke-miterlimit": ["2", "", "path"], "stroke-dasharray": ["2px, 3px", "", "path"], "stroke-dashoffset": ["1px", "stroke-dasharray:2px, 3px", "path"], "paint-order": ["stroke", "fill:rgb(255, 0, 0)", "path"],
    "vector-effect": ["non-scaling-stroke", "", "path"], "d": ['path("M 2 8 H 10")', "", "path"], "cx": ["6px", "", "circle"], "cy": ["6px", "", "circle"], "r": ["3px", "", "circle"],
    "rx": ["2px", "", "rect"], "ry": ["2px", "", "rect"], "x": ["4px", "", "rect"], "y": ["4px", "", "rect"], "text-anchor": ["end", "", "letter"],
    "opacity": ["0.5", "", "path"], "clip-path": ["inset(1px)", "", "path"], "mask-image": [GRADIENT, "", "path"], "filter": ["blur(1px)", "", "path"],
    "marker-start": ['url("#m")', "", "path"], "marker-mid": ['url("#m")', "", "path"], "marker-end": ['url("#m")', "", "path"], "shape-rendering": ["crispedges", "", "path"],
    "mix-blend-mode": ["multiply", "", "path"], "image-rendering": ["pixelated", "", "path"], "dominant-baseline": ["middle", "", "letter"], "alignment-baseline": ["middle", "", "letter"], "baseline-shift": ["2px", "", "letter"],
  },
};

/** Every `key=value` a scene's types and paints say, a generated box's under the key alone. */
function saidBy(scene: Scene): Set<string> {
  const out = new Set<string>();
  for (const row of [...scene.types, ...scene.paints]) for (const [k, v] of Object.entries(row)) out.add(`${k.replace(/^(before|after)\./, "")}=${v}`);
  return out;
}

describe("the lists of what the drawn values say", () => {
  const require_ = createRequire(resolve(process.cwd(), "package.json"));
  const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  let page: import("@playwright/test").Page | null = null;
  beforeAll(async () => { browser = await launch(chromium); page = await browser.newPage({ viewport: { width: VARIANT.width, height: VARIANT.height } }); }, 120_000);
  afterAll(async () => { await browser?.close(); });

  const doc = (body: string, css = ""): string => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff;font:16px/22px sans-serif}.line{fill:none;stroke:rgb(0, 0, 0);stroke-width:2px}${css}</style><main>${body}</main>`;
  const read = async (html: string, lists: PaintLists = LISTS): Promise<Scene> => { await page!.setContent(html); return page!.evaluate(readScene, { variant: VARIANT, lists }); };
  /** What the browser computes for some properties on an element nothing styled, and every property it computes at all. */
  const plain = async (names: string[]): Promise<{ all: string[]; values: Record<string, string>; color: string }> => {
    await page!.setContent(`<!doctype html><x-plain></x-plain>`);
    return page!.evaluate((asked) => { const cs = getComputedStyle(document.querySelector("x-plain")!); return { all: [...cs], values: Object.fromEntries(asked.map((n) => [n, cs.getPropertyValue(n)])), color: cs.color }; }, names);
  };
  const rowsOf = (list: ListName): PaintRow[] => PAINT[list];

  it("gives every property the pinned browser computes one place: a list, another reading, or a reason", async () => {
    const { all } = await plain([]);
    const places = new Map<string, string[]>();
    const put = (p: string, where: string): void => { places.set(p, [...(places.get(p) ?? []), where]); };
    for (const list of LIST_NAMES) for (const r of rowsOf(list)) put(r.property, list);
    for (const g of PAINT.elsewhere) for (const p of g.properties) put(p, "elsewhere");
    for (const g of PAINT.notListed) for (const p of g.properties) put(p, "notListed");
    expect(all.filter((p) => !places.has(p)), "computed by the browser and nowhere in paint-properties.json").toEqual([]);
    expect([...places.keys()].filter((p) => !all.includes(p)), "in paint-properties.json and not computed by the browser").toEqual([]);
    // One place each: a property may stand on more than one list (a box's and a shape's opacity), and on a list or outside them, never both.
    const twice = [...places].filter(([, w]) => new Set(w).size !== w.length || (w.length > 1 && w.some((x) => !(LIST_NAMES as readonly string[]).includes(x))));
    expect(twice).toEqual([]);
    expect(all.length).toBeGreaterThan(400);
    // What the file names as not computed stands there once and in no other part, and the browser neither computes nor parses it: a name it learns moves to a list.
    const unknown = PAINT.notComputed.map((r) => r.property);
    expect(unknown.filter((p, i) => unknown.indexOf(p) !== i || places.has(p)), "named as not computed and placed again").toEqual([]);
    const gone = await plain(unknown);
    expect(Object.entries(gone.values).filter(([, v]) => v !== "").map(([p]) => p)).toEqual([]);
    const parsed = await page!.evaluate((names) => names.filter((n) => { const el = document.createElement("i"); el.style.setProperty(n, "inherit"); return el.style.length > 0; }), unknown);
    expect(parsed, "named as not known to the browser, and parsed by it").toEqual([]);
    for (const g of [...PAINT.notListed, ...PAINT.notComputed]) expect((g as { why: string }).why.length, JSON.stringify(g).slice(0, 80)).toBeGreaterThan(20);
    for (const list of LIST_NAMES) for (const r of rowsOf(list)) expect(PAINT.sources[r.source], `${list} ${r.property}: its source`).toBeTruthy();
  }, 60_000);

  it("names as a row's initial value what the browser computes on an element nothing styled", async () => {
    const rows = LIST_NAMES.flatMap((list) => rowsOf(list).filter((r) => typeof r.initial === "string").map((r) => ({ list, ...r })));
    const { values, color } = await plain(rows.map((r) => r.property));
    expect(rows.filter((r) => values[r.property] !== (r.initial === "currentcolor" ? color : r.initial)).map((r) => `${r.list} ${r.property}: the file says ${r.initial}, the browser ${values[r.property]}`)).toEqual([]);
    // Every row is said only off its initial value, but the few that are a type's own.
    expect(LIST_NAMES.flatMap((list) => rowsOf(list).filter((r) => typeof r.initial !== "string" && r.said !== "always").map((r) => r.property))).toEqual([]);
    expect(PAINT.words.filter((r) => r.said === "always").map((r) => r.property)).toEqual(["color", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "font-variation-settings", "text-transform"]);
  }, 60_000);

  it("says every listed property where it alone moves, and names every key it says", async () => {
    const named = new Set([...Object.keys(PAINT.keys), ...(["words", "boxes"] as const).flatMap((list) => rowsOf(list).map((r) => r.as ?? keyOf(r.property)))]);
    const unsaid: string[] = [], unnamed = new Set<string>();
    for (const list of LIST_NAMES) {
      expect(Object.keys(EXAMPLES[list]).filter((p) => !rowsOf(list).some((r) => r.property === p)), `${list}: an example for a property that is not listed`).toEqual([]);
      for (const row of rowsOf(list)) {
        const example = EXAMPLES[list][row.property];
        if (!example) { unsaid.push(`${list} ${row.property}: no example`); continue; }
        const [value, base = "", where = list === "words" ? "words" : "box"] = example;
        const at = (style: string): string => doc(PAGES[where], `#t{${style}}`);
        const [a, b] = [await read(at(base)), await read(at(`${base};${row.property}:${value}`))];
        const [was, is] = [saidBy(a), saidBy(b)];
        // A shape says everything through its icon's ink.
        const key = list === "shapes" ? "ink" : row.as ?? keyOf(row.property);
        const moved = [...was, ...is].filter((s) => was.has(s) !== is.has(s));
        if (!moved.some((s) => s.startsWith(`${key}=`) || (row.as === "border" && /^border(Top|Right|Bottom|Left)?=/.test(s)))) unsaid.push(`${list} ${row.property}: ${value} moves ${JSON.stringify(moved)}`);
        for (const s of [...was, ...is]) { const k = s.slice(0, s.indexOf("=")); if (!named.has(k)) unnamed.add(k); }
      }
    }
    expect(unsaid).toEqual([]);
    expect([...unnamed]).toEqual([]);
  }, 240_000);

  it("says nothing of a plain thing beyond its type: no listed property at its initial value", async () => {
    const s = await read(doc(`<button style="all:unset;display:block;padding:4px;background:rgb(240, 235, 227)">Reply</button><p>Some words</p>`));
    expect(s.types.map((t) => Object.keys(t))).toEqual([["color", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "fontVariationSettings", "textTransform"]]);
    expect(s.paints).toEqual([{ backgroundColor: "rgb(255, 255, 255)" }]);
  }, 60_000);

  it("reads a property that paints only with another where that other is set, and one with a condition where it holds", async () => {
    const paints = async (body: string, css: string): Promise<Record<string, string>[]> => (await read(doc(body, css))).paints.filter((p) => p.backgroundColor !== "rgb(255, 255, 255)");
    // Where a picture lies behind a box is nothing without a picture; where a mask lies, nothing without a mask.
    expect(await paints(PAGES.box, "#t{background-position:4px 4px;background-size:8px 8px;mask-size:4px 4px;border-image-slice:30%}")).toEqual([]);
    expect(await paints(PAGES.box, `#t{background:${GRADIENT} 4px 4px}`)).toEqual([{ backgroundImage: GRADIENT, backgroundPosition: "4px 4px" }]);
    // An address is cut to its file's name, and a picture written into the page to a digest of itself.
    expect(await paints(PAGES.box, `#t{background-image:url("https://reference.invalid/pictures/grain.png?v=3")}`)).toEqual([{ backgroundImage: "url(grain.png)" }]);
    expect(await paints(PAGES.box, `#t{background-image:url("${PIC}")}`)).toEqual([{ backgroundImage: expect.stringMatching(/^url\(data [0-9a-f]{12}\)$/) }]);
    // A list's marker is a list item's: a list that only passes it on says nothing, and neither does a plain box.
    const listed = await read(doc(`<ul style="list-style:square"><li>one</li></ul><div style="list-style:square;width:20px;height:20px"></div>`));
    expect(listed.paints.filter((p) => p.listStyleType)).toEqual([{ listStyleType: "square" }]);
    // Three dots stand in for words only in a box that cuts them.
    const cut = async (css: string): Promise<(string | undefined)[]> => (await read(doc(PAGES.words, `#t{${css}}`))).types.map((t) => t.textOverflow);
    expect(await cut("text-overflow:ellipsis")).toEqual([undefined]);
    expect(await cut("text-overflow:ellipsis;overflow:hidden")).toEqual(["ellipsis"]);
    // It is the line's box that cuts: words in a part of that line say it too.
    expect((await read(doc(`<p style="text-overflow:ellipsis;overflow:hidden;white-space:nowrap"><b>Some</b> words</p>`))).types.map((t) => t.textOverflow)).toEqual(["ellipsis", "ellipsis"]);
    // Kept white space is said where the words hold some.
    const kept = async (words: string): Promise<(string | undefined)[]> => (await read(doc(`<p style="white-space:pre-wrap">${words}</p>`))).types.map((t) => t.whiteSpaceCollapse);
    expect(await kept("Some words")).toEqual([undefined]);
    expect(await kept("Some  words")).toEqual(["preserve"]);
  }, 60_000);

  it("refuses lists it cannot read whole: a condition or a place it does not know, a row with no initial value", async () => {
    await page!.setContent(doc(PAGES.words));
    const withRow = (row: Record<string, unknown>): PaintLists => ({ ...LISTS, words: [...LISTS.words, row as unknown as PaintRow] });
    const ask = (lists: unknown): Promise<Scene> => page!.evaluate(readScene, { variant: VARIANT, lists: lists as PaintLists });
    await expect(ask(withRow({ property: "text-align", source: "text", initial: "start", when: "the moon is full" }))).rejects.toThrow(/knows no condition "the moon is full"/);
    await expect(ask(withRow({ property: "text-align", source: "text", initial: "start", from: "the parent" }))).rejects.toThrow(/knows no place "the parent"/);
    await expect(ask(withRow({ property: "text-align", source: "text" }))).rejects.toThrow(/no initial value/);
    await expect(ask(withRow({ property: "text-align", source: "text", initial: "start", with: "text-justify" }))).rejects.toThrow(/"text-justify" is not on the list/);
    await expect(ask(undefined)).rejects.toThrow(/no lists of what to say/);
    // A row added to the list is said from then on: the list is the reader's, not a copy of it.
    const more = await ask(withRow({ property: "text-align", source: "text", initial: "start" }));
    await page!.setContent(doc(PAGES.words, "#t{text-align:right}"));
    expect((await ask(withRow({ property: "text-align", source: "text", initial: "start" }))).types.map((t) => t.textAlign)).toEqual(["right"]);
    expect(more.types.map((t) => t.textAlign)).toEqual([undefined]);
    expect((await ask(LISTS)).types.map((t) => t.textAlign)).toEqual([undefined]);
  }, 60_000);
});
