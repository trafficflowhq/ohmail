import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comparePictures, compareScenes, compareState, describeVerdict } from "./compare.js";
import { decode, encode } from "./png.mjs";
import type { Picture } from "./png.d.mts";
import { deriveRegistry, fileOf, keyOf, stateHash } from "./registry.mjs";
import { launch, shoot, TOLERANCE } from "./render.mjs";
import type { Scene, SceneNode, Surface, Variant } from "./scene.d.mts";
import { serveLoopback } from "./studio.mjs";

/**
 * The comparison tool, held against planted differences: the same thing twice is green, and one changed
 * pixel, one moved box and one changed drawn value are each red on the question that asks for them.
 * The last block does it in a real browser: one page, then the same page with one token changed.
 */

const VARIANT: Variant = { device: "desktop", face: "paper", scheme: "light", width: 200, height: 100, scale: 1 };
const DRAWN = {
  color: "rgb(18, 16, 14)", backgroundColor: "rgb(248, 67, 26)", fontFamily: "sans-serif", fontSize: "16px", fontWeight: "600",
  lineHeight: "22.4px", letterSpacing: "normal", borderRadius: "12px", paddingTop: "12px", paddingRight: "12px",
  paddingBottom: "12px", paddingLeft: "12px", borderColor: "rgb(18, 16, 14)",
};
const node = (role: string, name: string, box: SceneNode["box"], drawn: Partial<typeof DRAWN> = {}): SceneNode => ({ role, name, box, drawn: { ...DRAWN, ...drawn } });
const scene = (nodes: SceneNode[], more: Partial<Scene> = {}): Scene => ({
  reader: 5, variant: VARIANT, page: { scrollWidth: 200, clientWidth: 200, scrollHeight: 100 }, fonts: [], types: [], paints: [], nodes, loose: { text: [], surfaces: [] }, ...more,
});
const NODES = (): SceneNode[] => [node("main", "", [0, 0, 200, 100]), node("button", "Reply", [20, 20, 12, 12]), node("button", "Later", [60, 20, 80, 32])];

/** A flat picture; `dots` are single pixels of another colour. */
function picture(dots: [number, number][] = [], width = 200, height = 100): Picture {
  const data = new Uint8Array(width * height * 4).fill(255);
  for (const [x, y] of dots) data.set([0, 0, 0, 255], (y * width + x) * 4);
  return { width, height, data };
}
const state = (nodes: SceneNode[], pic: Picture, more: Partial<Scene> = {}) => ({ scene: scene(nodes, more), png: encode(pic) });

describe("the four questions", () => {
  it("is green on a state against itself", () => {
    const v = compareState({ key: "k", reference: state(NODES(), picture()), actual: state(NODES(), picture()), tolerance: TOLERANCE, accepted: true });
    expect([v.green, v.names.verdict, v.boxes.verdict, v.drawn.verdict, v.picture.verdict, v.picture.ratio]).toEqual([true, "green", "green", "green", "green", 0]);
  });

  it("is red on one changed pixel inside a control, far under the whole picture's line", () => {
    const v = compareState({ key: "k", reference: state(NODES(), picture()), actual: state(NODES(), picture([[25, 25]])), tolerance: TOLERANCE, accepted: true });
    expect(v.picture.ratio).toBeLessThan(TOLERANCE.pictureRatio);
    expect([v.green, v.picture.verdict, v.names.verdict, v.boxes.verdict, v.drawn.verdict]).toEqual([false, "red", "green", "green", "green"]);
    expect(v.picture.findings.join("\n")).toContain('button "Reply"');
    expect(v.picture.findings.join("\n")).not.toContain('button "Later"');
    const diff = decode(v.picture.diff!);
    expect(diff.data[(25 * 200 + 25) * 4 + 3]).toBe(255);
  });

  it("reports a different picture and does not fail, until the state's own picture is accepted", () => {
    const v = compareState({ key: "k", reference: state(NODES(), picture()), actual: state(NODES(), picture([[25, 25]])), tolerance: TOLERANCE, accepted: false });
    expect([v.green, v.picture.verdict]).toEqual([true, "reported"]);
    expect(describeVerdict(v)).toContain("picture=reported");
  });

  it("is red on a picture of another size, accepted or not, and never scales one to fit", () => {
    const v = compareState({ key: "k", reference: state(NODES(), picture()), actual: state(NODES(), picture([], 400, 200)), tolerance: TOLERANCE, accepted: false });
    expect([v.green, v.picture.verdict, v.picture.sized]).toEqual([false, "red", false]);
  });

  it("is red on a box moved further than the tolerance, and green inside it", () => {
    const moved = NODES(); moved[2] = node("button", "Later", [64, 20, 80, 32]);
    const near = NODES(); near[2] = node("button", "Later", [60.9, 20, 80, 32]);
    const ask = (nodes: SceneNode[]) => compareScenes(scene(NODES()), scene(nodes), TOLERANCE);
    expect([ask(moved).boxes.verdict, ask(moved).names.verdict, ask(moved).drawn.verdict]).toEqual(["red", "green", "green"]);
    expect(ask(moved).boxes.findings).toEqual(['button "Later": box [60, 20, 80, 32] is [64, 20, 80, 32]']);
    expect(ask(near).boxes.verdict).toBe("green");
  });

  it("is red on one drawn value that differs by the smallest step a picture would not show", () => {
    const changed = NODES(); changed[1] = node("button", "Reply", [20, 20, 12, 12], { backgroundColor: "rgb(248, 67, 27)" });
    const v = compareScenes(scene(NODES()), scene(changed), TOLERANCE);
    expect([v.drawn.verdict, v.names.verdict, v.boxes.verdict]).toEqual(["red", "green", "green"]);
    expect(v.drawn.findings).toEqual(['button "Reply": backgroundColor rgb(248, 67, 26) is rgb(248, 67, 27)']);
  });

  it("names a missing and an added control, and still reads the others in their pairs", () => {
    const other = [NODES()[0]!, node("button", "Forward", [20, 20, 12, 12]), node("button", "Later", [90, 20, 80, 32])];
    const v = compareScenes(scene(NODES()), scene(other), TOLERANCE);
    expect(v.names.findings).toEqual(['missing: button "Reply"', 'not in the reference: button "Forward"']);
    expect(v.boxes.findings).toEqual(['button "Later": box [60, 20, 80, 32] is [90, 20, 80, 32]']);
  });

  it("takes a declared node out of both sides, and a state declared whole reports without failing", () => {
    const other = [NODES()[0]!, NODES()[2]!];
    const one = { key: "k", reason: "the product has no Reply here yet", since: "2026-11-14", nodes: [{ role: "button", name: "Reply" }] };
    expect(compareScenes(scene(NODES()), scene(other), TOLERANCE, one).names.verdict).toBe("green");
    expect(compareScenes(scene(NODES()), scene([NODES()[0]!]), TOLERANCE, one).names.findings).toEqual(['missing: button "Later"']);
    const renamed = [NODES()[0]!, NODES()[1]!, node("button", "Snooze", [60, 20, 80, 32])];
    const whole = compareState({ key: "k", reference: state(NODES(), picture()), actual: state(renamed, picture([[25, 25]])), tolerance: TOLERANCE, accepted: true, declared: { key: "k", reason: "r", since: "2026-11-14" } });
    expect([whole.green, whole.names.verdict, whole.picture.verdict]).toEqual([true, "reported", "reported"]);
  });

  it("reads a region no smaller than the floor, at the picture's scale", () => {
    const tiny = [{ node: "dot", box: [50, 50, 2, 2] as SceneNode["box"] }];
    const at2 = comparePictures(picture([], 400, 200), picture([[109, 109]], 400, 200), tiny, 2, TOLERANCE);
    expect(at2.worst).toEqual({ ratio: 1 / (24 * 24), node: "dot" });
    expect(comparePictures(picture([], 400, 200), picture([[130, 130]], 400, 200), tiny, 2, TOLERANCE).worst?.ratio).toBe(0);
  });
});

describe("what carries a token and is no control", () => {
  // A row of mail: the sender in the read ink, the time in the second ink, on a white sheet with round corners.
  const READ = { color: "rgb(64, 58, 52)", fontFamily: '"Hanken Grotesk", sans-serif', fontSize: "16px", fontWeight: "400", fontStyle: "normal", lineHeight: "22px", letterSpacing: "normal", fontVariationSettings: "normal", textTransform: "none" };
  const META = { ...READ, color: "rgb(90, 83, 75)", fontSize: "13px" };
  const SHEET = { backgroundColor: "rgb(255, 255, 255)", borderRadius: "20px" };
  const row = (text: SceneNode["text"]): SceneNode => ({ ...node("button", "Nadja Lehner 07:58", [20, 20, 160, 40]), text });
  const page = (over: { types?: Scene["types"]; paints?: Scene["paints"]; text?: SceneNode["text"]; sheet?: SceneNode["box"] | null; parts?: Surface["parts"] } = {}): Scene => scene(
    [{ ...node("main", "", [0, 0, 200, 100]), surfaces: over.sheet === null ? [] : [{ box: over.sheet ?? [12, 12, 176, 76], paint: 0, ...(over.parts ? { parts: over.parts } : {}) }] }, row(over.text ?? [{ said: "Nadja Lehner", type: 0 }, { said: "07:58", type: 1 }])],
    { types: over.types ?? [READ, META], paints: over.paints ?? [SHEET] },
  );
  const ask = (other: Scene) => compareScenes(page(), other, TOLERANCE);
  const verdicts = (v: ReturnType<typeof ask>) => [v.names.verdict, v.boxes.verdict, v.drawn.verdict];

  it("is red on the colour of the text inside a control, which the control's own values do not carry", () => {
    const v = ask(page({ types: [{ ...READ, color: "rgb(31, 75, 255)" }, META] }));
    expect(verdicts(v)).toEqual(["green", "green", "red"]);
    expect(v.drawn.findings).toEqual(['button "Nadja Lehner 07:58": text "NadjaLehner" color rgb(64, 58, 52) is rgb(31, 75, 255)']);
  });

  it("is red on a text size and on a font's axis, each by its own name", () => {
    const v = ask(page({ types: [READ, { ...META, fontSize: "14px", fontVariationSettings: '"opsz" 14' }] }));
    expect(v.drawn.findings).toEqual([
      'button "Nadja Lehner 07:58": text "07:58" fontSize 13px is 14px',
      'button "Nadja Lehner 07:58": text "07:58" fontVariationSettings normal is "opsz" 14',
    ]);
  });

  it("reads the same words in the same style alike, however a page cuts them into pieces", () => {
    const cut = page({ text: [{ said: "Nadja", type: 0 }, { said: "Lehner", type: 0 }, { said: "07", type: 1 }, { said: ":58", type: 1 }] });
    expect(verdicts(ask(cut))).toEqual(["green", "green", "green"]);
  });

  it("says so when a node reads other words", () => {
    const v = ask(page({ text: [{ said: "Nadja Lehner", type: 0 }, { said: "08:02", type: 1 }] }));
    expect(verdicts(v)).toEqual(["red", "green", "green"]);
    expect(v.names.findings).toEqual(['button "Nadja Lehner 07:58": reads "NadjaLehner08:02", the reference "NadjaLehner07:58"']);
  });

  it("is red on a sheet's colour and on its radius, though a sheet is neither landmark nor control", () => {
    const v = ask(page({ paints: [{ backgroundColor: "rgb(240, 235, 227)", borderRadius: "0px" }] }));
    expect(verdicts(v)).toEqual(["green", "green", "red"]);
    expect(v.drawn.findings).toEqual([
      'main "": at [12, 12, 176, 76] backgroundColor rgb(255, 255, 255) is rgb(240, 235, 227)',
      'main "": at [12, 12, 176, 76] borderRadius 20px is 0px',
    ]);
  });

  it("is red on a sheet that moved or is gone, on where things sit; a pixel's move is inside the tolerance", () => {
    expect(verdicts(ask(page({ sheet: [12, 13, 176, 76] })))).toEqual(["green", "green", "green"]);
    // A step of exactly one pixel is inside it, also where tenths do not add up in binary: 2.2 - 1.2 is a hair over 1.
    const at = (y: number): Scene => scene([{ ...node("main", "", [0, 0, 200, 90]), surfaces: [{ box: [12, y, 176, 60], paint: 0 }] }, node("button", "Later", [60, y, 80, 32])], { paints: [SHEET] });
    expect(compareScenes(at(1.2), at(2.2), TOLERANCE).boxes.findings).toEqual([]);
    // A tenth more is outside it: the button's box, and the surface on either side.
    expect(compareScenes(at(1.2), at(2.3), TOLERANCE).boxes.findings.length).toBe(3);
    const moved = ask(page({ sheet: [12, 20, 176, 68] }));
    expect(verdicts(moved)).toEqual(["green", "red", "green"]);
    expect(moved.boxes.findings).toEqual([
      'main "": nothing is drawn at [12, 12, 176, 76], where the reference draws backgroundColor rgb(255, 255, 255)',
      'main "": draws backgroundColor rgb(255, 255, 255) at [12, 20, 176, 68], which the reference does not',
    ]);
    expect(verdicts(ask(page({ sheet: null })))).toEqual(["green", "red", "green"]);
  });

  it("is red on a turn: of a control, of the words in it, of a sheet and of what is drawn before or after one", () => {
    const turned = page(); turned.nodes[1] = { ...turned.nodes[1]!, turn: "mirrored" };
    expect(verdicts(ask(turned))).toEqual(["green", "green", "red"]);
    expect(ask(turned).drawn.findings).toEqual(['button "Nadja Lehner 07:58": turn none is mirrored']);
    expect(ask(page({ types: [{ ...READ, turn: "90deg" }, META] })).drawn.findings).toEqual(['button "Nadja Lehner 07:58": text "NadjaLehner" turn none is 90deg']);
    expect(ask(page({ paints: [{ ...SHEET, turn: "45deg" }] })).drawn.findings).toEqual(['main "": at [12, 12, 176, 76] turn none is 45deg']);
    // One turn for another, and a turn the product leaves out.
    const caret = (turn?: string): Scene => page({ paints: [{ ...SHEET, "after.backgroundColor": "rgb(18, 16, 14)", ...(turn ? { "after.turn": turn } : {}) }] });
    expect(compareScenes(caret("45deg"), caret("-135deg"), TOLERANCE).drawn.findings).toEqual(['main "": at [12, 12, 176, 76] after.turn 45deg is -135deg']);
    expect(compareScenes(caret("-38deg"), caret(), TOLERANCE).drawn.findings).toEqual(['main "": at [12, 12, 176, 76] after.turn -38deg is none']);
    expect(verdicts(compareScenes(caret("45deg"), caret("45deg"), TOLERANCE))).toEqual(["green", "green", "green"]);
  });

  it("holds the box drawn before or after an element within the tolerance: its size, and its place where both say one", () => {
    const strike = (after: number[]): Scene => page({ parts: { after } });
    const ask2 = (a: number[], b: number[]) => compareScenes(strike(a), strike(b), TOLERANCE);
    expect(verdicts(ask2([-1, 7.3, 18, 1.5], [-1, 7.3, 18, 1.5]))).toEqual(["green", "green", "green"]);
    expect(verdicts(ask2([-1, 7.3, 18, 1.5], [-1, 7, 18.4, 2.5]))).toEqual(["green", "green", "green"]);
    const thick = ask2([-1, 7.3, 18, 1.5], [-1, 6, 18, 4]);
    expect(verdicts(thick)).toEqual(["green", "red", "green"]);
    expect(thick.boxes.findings).toEqual([`main "": at [12, 12, 176, 76] the box drawn after it is [-1, 6, 18, 4], the reference's [-1, 7.3, 18, 1.5]`]);
    expect(verdicts(ask2([-1, 7.3, 18, 1.5], [-1, 3, 18, 1.5]))).toEqual(["green", "red", "green"]);
    // A box that stands in the line says its size alone, and only the sizes are held together.
    expect(verdicts(ask2([-1, 3, 18, 1.5], [18, 1.5]))).toEqual(["green", "green", "green"]);
    expect(verdicts(ask2([18, 1.5], [18, 4]))).toEqual(["green", "red", "green"]);
  });

  it("is red when a face the reference's words are set in is not loaded, whatever the font-family string says", () => {
    const text = { family: "Hanken Grotesk", weight: "100 900", style: "normal" }, unused = { family: "JetBrains Mono", weight: "100 800", style: "normal" };
    const had = { ...page(), fonts: [text, unused] };
    const v = compareScenes(had, page(), TOLERANCE);
    expect(verdicts(v)).toEqual(["green", "green", "red"]);
    // The words are set in the first; nothing is set in the second, and a page that never loads it is not held to it.
    expect(v.drawn.findings).toEqual(['the face "Hanken Grotesk" (normal) is not loaded; the reference had it']);
    expect(compareScenes(had, { ...page(), fonts: [{ ...text, weight: "400" }, { family: "Inter", weight: "400", style: "normal" }] }, TOLERANCE).drawn.verdict).toBe("green");
  });

  it("refuses a data file another reader wrote", () => {
    expect(() => compareScenes({ ...page(), reader: 1 } as unknown as Scene, page(), TOLERANCE)).toThrow(/read by reader 1/);
    // The readers before this one read no shape of an icon, or read a turned icon or a turned box as the one it was turned from: their files only look alike.
    for (const old of [2, 3, 4]) {
      expect(() => compareScenes({ ...page(), reader: old } as unknown as Scene, page(), TOLERANCE)).toThrow(new RegExp(`the reference's data file was read by reader ${old}`));
      expect(() => compareScenes(page(), { ...page(), reader: old } as unknown as Scene, TOLERANCE)).toThrow(new RegExp(`the product's data file was read by reader ${old}`));
    }
  });
});

describe("the picture's lines", () => {
  const flat = (rgb: number[], width = 200, height = 100): Picture => {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set([rgb[0]!, rgb[1]!, rgb[2]!, 255], i);
    return { width, height, data };
  };
  /** A flat picture with a block of another colour, `share` of its pixels. */
  const blocked = (share: number): Picture => {
    const p = flat([255, 255, 255]);
    const rows = Math.round(100 * share);
    for (let y = 100 - rows; y < 100; y++) for (let x = 0; x < 200; x++) p.data.set([31, 75, 255, 255], (y * 200 + x) * 4);
    return p;
  };
  const MAIN = (): SceneNode[] => [node("main", "", [0, 0, 200, 50])];

  it("counts a sheet that took the ground's colour: the palette's own steps are differences", () => {
    const v = comparePictures(flat([255, 255, 255]), flat([240, 235, 227]), [], 1, TOLERANCE);
    expect([v.verdict, v.ratio]).toEqual(["red", 1]);
    const tint = comparePictures(flat([255, 255, 255]), flat([255, 240, 233]), [], 1, TOLERANCE);
    expect([tint.verdict, tint.ratio]).toEqual(["red", 1]);
  });

  it("does not count one step of every channel, which two machines may round apart, and counts two", () => {
    const v = comparePictures(flat([221, 213, 201]), flat([220, 212, 200]), [], 1, TOLERANCE);
    expect([v.verdict, v.ratio]).toEqual(["green", 0]);
    expect(comparePictures(flat([221, 213, 201]), flat([219, 211, 199]), [], 1, TOLERANCE).ratio).toBe(1);
  });

  it("fails a state whose picture differs grossly whether or not it was accepted, and only reports a fine difference", () => {
    // The block is under the landmark's box, so no region carries it: only the whole picture's share speaks.
    const ask = (share: number) => compareState({ key: "k", reference: state(MAIN(), flat([255, 255, 255])), actual: state(MAIN(), blocked(share)), tolerance: TOLERANCE, accepted: false });
    const gross = ask(0.05);
    expect([gross.green, gross.picture.verdict, gross.picture.ratio]).toEqual([false, "red", 0.05]);
    expect(gross.picture.findings[0]).toContain("for any state");
    const fine = ask(0.01);
    expect([fine.green, fine.picture.verdict, fine.picture.ratio]).toEqual([true, "reported", 0.01]);
    expect(TOLERANCE.grossRatio).toBeGreaterThan(0.01);
    expect(TOLERANCE.grossRatio).toBeLessThanOrEqual(0.05);
  });

  it("reads a region against the region's own line, not the whole picture's", () => {
    // One pixel in a region of 24 by 24 device pixels is under the region's line and far over the whole picture's.
    const tiny = [{ node: "dot", box: [50, 50, 2, 2] as SceneNode["box"] }];
    const one = comparePictures(picture([], 400, 200), picture([[109, 109]], 400, 200), tiny, 2, TOLERANCE);
    expect(one.worst!.ratio).toBeGreaterThan(TOLERANCE.pictureRatio);
    expect(one.worst!.ratio).toBeLessThan(TOLERANCE.regionRatio);
    expect(one.verdict).toBe("green");
    const four = comparePictures(picture([], 400, 200), picture([[109, 109], [110, 109], [109, 110], [110, 110]], 400, 200), tiny, 2, TOLERANCE);
    expect([four.verdict, four.findings.length]).toEqual(["red", 1]);
    expect(four.findings[0]).toContain(`> ${TOLERANCE.regionRatio}`);
  });
});

describe("the picture's mark line", () => {
  const WIDE = (): SceneNode[] => [node("main", "", [0, 0, 200, 100]), node("button", "Best match", [10, 10, 180, 80])];
  /** `n` pixels in a row from (x, y), each `step` from the last: touching at a step of one, apart at two. */
  const row = (n: number, x: number, y: number, step = 1): [number, number][] => Array.from({ length: n }, (_, i) => [x + (i % 40) * step, y + Math.floor(i / 40) * step] as [number, number]);
  const ask = (dots: [number, number][], accepted = true) => compareState({ key: "k", reference: state(WIDE(), picture()), actual: state(WIDE(), picture(dots)), tolerance: TOLERANCE, accepted });

  it("fails an accepted state on differing pixels that touch, though they are a small share of their region", () => {
    const v = ask(row(TOLERANCE.mark + 1, 60, 40));
    // The region's own line lets them through: the button is 14,400 pixels.
    expect(v.picture.worst!.ratio).toBeLessThan(TOLERANCE.regionRatio);
    expect(v.picture.ratio).toBeLessThan(TOLERANCE.pictureRatio);
    expect([v.green, v.picture.verdict, v.names.verdict, v.boxes.verdict, v.drawn.verdict]).toEqual([false, "red", "green", "green", "green"]);
    expect(v.picture.mark).toEqual({ pixels: TOLERANCE.mark + 1, box: [60, 40, TOLERANCE.mark + 1, 1], more: 0 });
    expect(v.picture.findings).toEqual([`button "Best match": a mark of ${TOLERANCE.mark + 1} pixels that touch differs at [60, 40, ${TOLERANCE.mark + 1}, 1] (> ${TOLERANCE.mark})`]);
    expect(describeVerdict(v)).toContain(`mark=${TOLERANCE.mark + 1}`);
  });

  it("lets a mark at the line through, and as many pixels that do not touch", () => {
    const at = ask(row(TOLERANCE.mark, 60, 40));
    expect([at.green, at.picture.verdict, at.picture.mark?.pixels]).toEqual([true, "green", TOLERANCE.mark]);
    const apart = ask(row(TOLERANCE.mark + 1, 20, 20, 2));
    expect([apart.green, apart.picture.verdict, apart.picture.mark?.pixels]).toEqual([true, "green", 1]);
    expect(ask([]).picture.mark).toBeNull();
  });

  it("counts pixels that touch by a corner as one mark, and says how many marks are over the line", () => {
    const stair = Array.from({ length: TOLERANCE.mark + 1 }, (_, i) => [60 + i, 20 + i] as [number, number]);
    expect(ask(stair).picture.mark).toEqual({ pixels: TOLERANCE.mark + 1, box: [60, 20, TOLERANCE.mark + 1, TOLERANCE.mark + 1], more: 0 });
    // Two marks in a picture large enough that their share of it says nothing.
    const two = comparePictures(picture([], 400, 200), picture([...row(TOLERANCE.mark + 3, 20, 20), ...row(TOLERANCE.mark + 1, 20, 60)], 400, 200), [{ node: 'button "Best match"', box: [10, 10, 380, 180] }], 1, TOLERANCE);
    expect(two.mark).toEqual({ pixels: TOLERANCE.mark + 3, box: [20, 20, TOLERANCE.mark + 3, 1], more: 1 });
    expect(two.findings).toEqual([`button "Best match": a mark of ${TOLERANCE.mark + 3} pixels that touch differs at [20, 20, ${TOLERANCE.mark + 3}, 1] (> ${TOLERANCE.mark}), and 1 more mark over the line`]);
  });

  it("only reports the mark for a state whose picture nobody accepted, and says where it is in the picture's own pixels", () => {
    const v = ask(row(TOLERANCE.mark + 1, 60, 40), false);
    expect([v.green, v.picture.verdict]).toEqual([true, "reported"]);
    // At a scale of two the same mark is twice as far in, and its place is said in CSS pixels as every box is; outside every node it says so.
    const out = comparePictures(picture([], 400, 200), picture(row(TOLERANCE.mark + 1, 300, 150), 400, 200), [{ node: "dot", box: [0, 0, 20, 20] }], 2, TOLERANCE);
    expect(out.findings).toEqual([`outside every node: a mark of ${TOLERANCE.mark + 1} pixels that touch differs at [150, 75, ${(TOLERANCE.mark + 1) / 2}, 0.5] (> ${TOLERANCE.mark})`]);
  });
});

describe("the registry of states", () => {
  const source = {
    url: "https://reference.invalid/x/", points: ["a note"],
    screens: [{ id: "ohbox", group: "Ohbox", title: "Ohbox", thumbs: { desktop: "https://reference.invalid/t.webp" },
      links: { desktop: "https://reference.invalid/x/simulator/?screen=ohbox&open=a", dark: "https://reference.invalid/x/simulator/?screen=ohbox&open=a&scheme=dark" },
      states: [{ label: "A letter open (the default, FB-94)", url: "https://reference.invalid/x/simulator/?screen=ohbox&open=a", parity: "apps/x.tsx" }, { label: "On a phone", url: "https://reference.invalid/x/simulator/?screen=ohbox&device=phone&bare=1&fast=1" }] }],
    also: [{ group: "Less common", title: "Menus", states: [{ label: "Open", url: "https://reference.invalid/x/simulator/?screen=ohbox&menu=1&device=phone" }, { label: "Again", url: "https://reference.invalid/x/simulator/?open=a&screen=ohbox" }] }],
  };
  const at = { studioTag: "t", studioCommit: "c" };

  it("keeps a key, a screen, a label and a variant for each state, and nothing that says where the reference lives", () => {
    const r = deriveRegistry(source, at);
    expect(r.states).toEqual([
      { key: "open=a&screen=ohbox", screen: "ohbox", group: "Ohbox", label: "A letter open (the default)", kind: "state", link: "desktop", variant: { device: "desktop", face: "paper", scheme: "light" } },
      { key: "device=phone&screen=ohbox", screen: "ohbox", group: "Ohbox", label: "On a phone", kind: "state", variant: { device: "phone", face: "paper", scheme: "light" } },
      { key: "open=a&scheme=dark&screen=ohbox", screen: "ohbox", group: "Ohbox", label: "Ohbox, dark", kind: "variant", link: "dark", variant: { device: "desktop", face: "paper", scheme: "dark" } },
      // A state from a list beside the screens keeps its key and its group; the list's words are the reference's notes and stay there.
      { key: "device=phone&menu=1&screen=ohbox", screen: "ohbox", group: "Less common", label: "", kind: "also", variant: { device: "phone", face: "paper", scheme: "light" } },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/reference\.invalid|https?:|thumbs|points|parity|Menus/);
  });

  it("refuses an address whose screen is not registered", () => {
    const stray = { ...source, also: [{ group: "g", title: "t", states: [{ label: "l", url: "https://reference.invalid/x/simulator/?screen=console" }] }] };
    expect(() => deriveRegistry(stray, at)).toThrow(/not a registered screen/);
  });

  it("gives one key to one state however its address is ordered, and a file name with no slug in it", () => {
    expect(keyOf("https://reference.invalid/x/?screen=a&open=b&bare=1&keys=1")).toBe(keyOf("open=b&screen=a&fast=1"));
    expect(fileOf("open=b&screen=a")).toMatch(/^[0-9a-f]{16}$/);
    const [first] = deriveRegistry(source, at).states;
    expect(stateHash({ ...first!, label: "Another" })).not.toBe(stateHash(first!));
  });
});

describe("in a real browser", () => {
  const require_ = createRequire(resolve(process.cwd(), "package.json"));
  const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  beforeAll(async () => { browser = await launch(chromium); }, 120_000);
  afterAll(async () => { await browser?.close(); });

  const window: Variant = { device: "desktop", face: "paper", scheme: "light", width: 480, height: 240, scale: 1 };
  const PAGE = (tokens: string): string => `<!doctype html><meta charset="utf-8"><style>
    :root{--hot:#F8431A;--s3:12px;${tokens}} html,body{margin:0;background:#fff}
    main{padding:24px;display:flex;gap:var(--s3)} button{border:0;border-radius:12px;padding:var(--s3);font:600 16px sans-serif}
    .hot{background:var(--hot);color:#12100E} [hidden]{display:none}
    </style><main><h1 hidden>Not shown</h1><button class="hot" aria-label="Reply">Reply</button><button>Later</button>
    <div style="overflow:hidden;height:0"><a href="#x">Clipped away</a></div></main>`;
  const draw = (tokens = "") => shoot(browser!, window, async (page) => { await page.setContent(PAGE(tokens)); });
  const ask = async (tokens: string) => compareState({ key: "page", reference: await draw(), actual: await draw(tokens), tolerance: TOLERANCE, accepted: true });

  it("reads what the picture shows: the landmark and the two controls, and not what is hidden or clipped away", async () => {
    const { scene: s } = await draw();
    expect(s.nodes.map((n) => [n.role, n.name])).toEqual([["main", ""], ["button", "Reply"], ["button", "Later"]]);
    expect(s.nodes[1]!.drawn.backgroundColor).toBe("rgb(248, 67, 26)");
    expect(s.variant).toEqual(window);
  });

  it("leaves out what an opaque pane covers whole, and keeps what a see-through one only dims", async () => {
    const under = (pane: string): string => `${PAGE("")}<div role="dialog" aria-label="A letter" style="position:fixed;${pane}"><button>Close</button></div>`;
    const read = async (pane: string) => (await shoot(browser!, window, async (page) => { await page.setContent(under(pane)); })).scene.nodes.map((n) => `${n.role} ${n.name}`);
    expect(await read("inset:0;background:#fff")).toEqual(["dialog A letter", "button Close"]);
    expect(await read("inset:0;background:rgba(18,16,14,.6)")).toEqual(["main ", "button Reply", "button Later", "dialog A letter", "button Close"]);
    // A pane over half of a control leaves the control in the picture.
    expect(await read("left:0;top:0;bottom:0;width:60px;background:#fff")).toEqual(["main ", "button Reply", "button Later", "dialog A letter", "button Close"]);
  }, 30_000);

  it("is green on a page against itself, drawn twice", async () => {
    const v = await ask("");
    expect([v.green, v.names.verdict, v.boxes.verdict, v.drawn.verdict, v.picture.verdict, v.picture.ratio]).toEqual([true, "green", "green", "green", "green", 0]);
  }, 30_000);

  it("is red on one changed colour token: on how it is drawn, and on the picture in that control's region alone", async () => {
    const v = await ask("--hot:#1F4BFF;");
    expect([v.names.verdict, v.boxes.verdict, v.drawn.verdict, v.picture.verdict]).toEqual(["green", "green", "red", "red"]);
    expect(v.drawn.findings).toEqual(['button "Reply": backgroundColor rgb(248, 67, 26) is rgb(31, 75, 255)']);
    expect(v.picture.findings.some((f) => f.startsWith('button "Reply"'))).toBe(true);
    expect(v.picture.findings.some((f) => f.startsWith('button "Later"'))).toBe(false);
  }, 30_000);

  it("is red on a colour token changed by one step, which no picture shows", async () => {
    const v = await ask("--hot:#F8431B;");
    expect([v.drawn.verdict, v.picture.verdict, v.picture.ratio]).toEqual(["red", "green", 0]);
  }, 30_000);

  it("is red on one changed spacing token: on where things sit and on how they are drawn", async () => {
    const v = await ask("--s3:16px;");
    expect([v.names.verdict, v.boxes.verdict, v.drawn.verdict]).toEqual(["green", "red", "red"]);
    expect(v.drawn.findings).toContain('button "Reply": paddingLeft 12px is 16px');
  }, 30_000);

  // A row of mail on a sheet: none of the sheet, the words and the icon is a landmark, a heading or a control.
  const MAIL = (tokens: string): string => `<!doctype html><meta charset="utf-8"><style>
    :root{--ground:#F0EBE3;--sheet:#FFFFFF;--ink:#12100E;--ink-read:#403A34;--ink2:#5A534B;--r-sheet:20px;--t-meta:13px;--ico-w:1.8;--ico-cap:round;--ico-join:round;${tokens}}
    html,body{margin:0;background:var(--ground);color:var(--ink);font:16px/22px sans-serif}
    main{padding:12px} .sheet{background:var(--sheet);border-radius:var(--r-sheet);padding:12px;box-shadow:0 0 0 0 var(--ground),0 1px 0 rgba(0,0,0,0)}
    button{all:unset;display:flex;gap:8px;align-items:center;box-shadow:inset 0 0 0 1px var(--ink2)} .who{color:var(--ink-read)} .when{color:var(--ink2);font-size:var(--t-meta)}
    svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:var(--ico-w);stroke-linecap:var(--ico-cap);stroke-linejoin:var(--ico-join)}
    </style><main><div class="sheet"><button><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h12"/></svg><span class="who">Nadja Lehner</span><span class="when">07:58</span></button></div></main>`;
  const mail = (tokens = "") => shoot(browser!, window, async (page) => { await page.setContent(MAIL(tokens)); });

  it("reads the words inside a control in their own colours, a sheet with its paint and an icon with its stroke and its shape", async () => {
    const { scene: s } = await mail();
    const row = s.nodes.find((n) => n.role === "button")!, main = s.nodes.find((n) => n.role === "main")!;
    expect(row.text!.map((r) => [r.said, s.types[r.type]!.color, s.types[r.type]!.fontSize])).toEqual([["Nadja Lehner", "rgb(64, 58, 52)", "16px"], ["07:58", "rgb(90, 83, 75)", "13px"]]);
    expect(main.surfaces!.map((f) => s.paints[f.paint])).toEqual([{ backgroundColor: "rgb(255, 255, 255)", borderRadius: "20px" }]);
    // A shadow that paints is read; the sheet's two, one of no size and one of no colour, paint nothing and are not.
    // An icon says its stroke with its cap and its join, and how many shapes it draws with a digest of their geometry.
    expect(row.surfaces!.map((f) => s.paints[f.paint])).toEqual([{ boxShadow: "rgb(90, 83, 75) 0px 0px 0px 1px inset" }, { ink: expect.stringMatching(/^stroke rgb\(18, 16, 14\) 1\.8px round round; shapes 1 [0-9a-f]{12}$/) }]);
    // The page's ground is painted once: the body's fill of the same colour on it shows nothing.
    expect(s.loose.surfaces.map((f) => s.paints[f.paint])).toEqual([{ backgroundColor: "rgb(240, 235, 227)" }]);
  }, 30_000);

  it("is red on a token that only a sheet, a row's words or an icon carries, for a state whose picture nobody accepted", async () => {
    const reference = await mail();
    const ask2 = async (tokens: string) => compareState({ key: "mail", reference, actual: await mail(tokens), tolerance: TOLERANCE, accepted: false });
    for (const [tokens, line] of [
      ["--sheet:#FFF0E9;", /^main "": at \[[\d., ]+\] backgroundColor rgb\(255, 255, 255\) is rgb\(255, 240, 233\)$/],
      ["--r-sheet:0px;", /^main "": at \[[\d., ]+\] borderRadius 20px is none$/],
      ["--ink-read:#3F3A34;", /^button "Nadja Lehner 07:58": text "NadjaLehner" color rgb\(64, 58, 52\) is rgb\(63, 58, 52\)$/],
      ["--t-meta:14px;", /^button "Nadja Lehner 07:58": text "07:58" fontSize 13px is 14px$/],
      ["--ico-w:2.4;", /^button "Nadja Lehner 07:58": at \[[\d., ]+\] ink stroke rgb\(18, 16, 14\) 1\.8px round round; shapes 1 ([0-9a-f]{12}) is stroke rgb\(18, 16, 14\) 2\.4px round round; shapes 1 \1$/],
      // A line's end and its corner move a few hundred pixels of a screen and no box, colour or width.
      ["--ico-cap:butt;", /^button "Nadja Lehner 07:58": at \[[\d., ]+\] ink stroke rgb\(18, 16, 14\) 1\.8px round round; shapes 1 ([0-9a-f]{12}) is stroke rgb\(18, 16, 14\) 1\.8px butt round; shapes 1 \1$/],
      ["--ico-join:miter;", /^button "Nadja Lehner 07:58": at \[[\d., ]+\] ink stroke rgb\(18, 16, 14\) 1\.8px round round; shapes 1 ([0-9a-f]{12}) is stroke rgb\(18, 16, 14\) 1\.8px round miter 4; shapes 1 \1$/],
    ] as const) {
      const v = await ask2(tokens);
      expect([v.green, v.names.verdict, v.drawn.verdict], tokens).toEqual([false, "green", "red"]);
      expect(v.drawn.findings.some((f) => line.test(f)), `${tokens} ${v.drawn.findings.join(" | ")}`).toBe(true);
    }
  }, 90_000);

  // A wide row of mail with one small icon: two icons the same row shows in the same place, with the same box and stroke.
  const ROW = (shapes: string, css = "", around = (icon: string): string => icon): string => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#F0EBE3;font:16px/22px sans-serif}
    main{padding:12px} .row{all:unset;display:flex;gap:8px;align-items:center;width:420px;height:72px;background:#fff;border-radius:12px;padding:0 12px;box-sizing:border-box}
    svg{width:16px;height:16px;fill:none;stroke:#12100E;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round} .w{display:inline-flex}${css}</style>
    <main><button class="row" aria-label="Nadja Lehner">${around(`<svg viewBox="0 0 16 16" aria-hidden="true">${shapes}</svg>`)}</button></main>`;
  const CLIP = `<path d="M13 7.5 8 12.5a3 3 0 0 1-4.2-4.2l5-5a2 2 0 0 1 2.8 2.8l-5 5a1 1 0 0 1-1.4-1.4L9.5 5.5"/>`;
  const STAR = `<path d="M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3 4.3 13.3l.8-4.1L2 6.3l4.2-.5z"/>`;

  it("is red on another icon in a wide row, whose picture stays inside the region's line: accepted or not, at either scale", async () => {
    for (const scale of [1, 2]) {
      const at = { ...window, scale };
      const clip = await shoot(browser!, at, async (page) => { await page.setContent(ROW(CLIP)); });
      const star = await shoot(browser!, at, async (page) => { await page.setContent(ROW(STAR)); });
      for (const accepted of [true, false]) {
        const v = compareState({ key: "row", reference: clip, actual: star, tolerance: TOLERANCE, accepted });
        const where = `scale ${scale}, ${accepted ? "accepted" : "not accepted"}`;
        expect([v.green, v.names.verdict, v.boxes.verdict, v.drawn.verdict], where).toEqual([false, "green", "green", "red"]);
        expect(v.drawn.findings, where).toEqual([expect.stringMatching(/^button "Nadja Lehner": at \[[\d., ]+\] ink stroke rgb\(18, 16, 14\) 1\.8px round round; shapes 1 [0-9a-f]{12} is stroke rgb\(18, 16, 14\) 1\.8px round round; shapes 1 [0-9a-f]{12}$/)]);
        // The picture alone lets it through: the icon is a four-hundredth of its row.
        expect(v.picture.ratio, where).toBeGreaterThan(0);
        expect(v.picture.worst!.ratio, where).toBeLessThan(TOLERANCE.regionRatio);
      }
    }
  }, 60_000);

  it("reads one shape alike however its path is written, and another number, place or kind of shape apart", async () => {
    const ink = async (shapes: string): Promise<string> => {
      const { scene: s } = await shoot(browser!, window, async (page) => { await page.setContent(ROW(shapes)); });
      return s.paints[s.nodes.find((n) => n.role === "button")!.surfaces!.find((f) => s.paints[f.paint]!.ink)!.paint]!.ink!;
    };
    const plus = await ink(`<path d="M2 8h12M8 2v12"/>`);
    expect(await ink(`<path d="M 2,8 H 14 M 8,2 V 14"/>`)).toBe(plus);
    const others = [
      await ink(`<path d="M2 8h12"/><path d="M8 2v12"/>`),
      await ink(`<g transform="translate(1 0)"><path d="M2 8h12M8 2v12"/></g>`),
      await ink(`<path d="M2 8h12M8 2v12"/><path d="M0 0h16" style="display:none"/><circle cx="8" cy="8" r="3"/>`),
      await ink(`<path d="M2 8h12M8 2v12"/><circle cx="8" cy="8" r="4"/>`),
      await ink(`<path d="M2 8h12M8 2v12"/><rect x="5" y="5" width="6" height="6" rx="1"/>`),
      await ink(`<line x1="2" y1="8" x2="14" y2="8"/><polyline points="8,2 8,14"/>`),
    ];
    expect(new Set([plus, ...others]).size).toBe(others.length + 1);
    // A shape that is not displayed is none of the icon's.
    expect(others[2]).toMatch(/; shapes 2 [0-9a-f]{12}$/);
  }, 60_000);

  const SPAN = (icon: string): string => `<span class="w">${icon}</span>`;
  const RIGHT = `<path d="M6 3l5 5-5 5"/>`, DOWN = `<path d="M3 6l5 5 5-5"/>`, CHECK = `<path d="M3 8.5l3.2 3.2L13 4.8"/>`, BOX = `<rect x="2" y="2" width="12" height="12" rx="2"/>`;
  const inkIn = async (html: string, at: Variant = window): Promise<string> => {
    const { scene: s } = await shoot(browser!, at, async (page) => { await page.setContent(html); });
    return s.paints[s.nodes.find((n) => n.role === "button")!.surfaces!.find((f) => s.paints[f.paint]!.ink)!.paint]!.ink!;
  };
  /** Red on how it is drawn and on nothing before it, with the picture accepted or not, at either scale. */
  const redOnDrawn = async (what: string, reference: string, product: string): Promise<void> => {
    for (const scale of [1, 2]) {
      const at = { ...window, scale };
      const a = await shoot(browser!, at, async (page) => { await page.setContent(reference); });
      const b = await shoot(browser!, at, async (page) => { await page.setContent(product); });
      for (const accepted of [true, false]) {
        const v = compareState({ key: "row", reference: a, actual: b, tolerance: TOLERANCE, accepted });
        expect([v.green, v.names.verdict, v.boxes.verdict, v.drawn.verdict], `${what}, scale ${scale}, ${accepted ? "accepted" : "not accepted"}`).toEqual([false, "green", "green", "red"]);
      }
    }
  };

  it("is red on an icon turned or mirrored, wherever the turn is written: accepted or not, at either scale", async () => {
    await redOnDrawn("mirrored on the svg", ROW(RIGHT), ROW(RIGHT, "svg{transform:scaleX(-1)}"));
    await redOnDrawn("a quarter turn on the svg", ROW(DOWN), ROW(DOWN, "svg{transform:rotate(-90deg)}"));
    await redOnDrawn("a half turn on the svg", ROW(DOWN), ROW(DOWN, "svg{transform:rotate(180deg)}"));
    await redOnDrawn("a half turn by the property of that name", ROW(DOWN), ROW(DOWN, "svg{rotate:180deg}"));
    await redOnDrawn("mirrored on an element around it", ROW(RIGHT, "", SPAN), ROW(RIGHT, ".w{transform:scaleX(-1)}", SPAN));
    // Mirrored with its whole row, the icon also stands at the row's other end: its ink says the mirror, its box the place.
    expect(await inkIn(ROW(RIGHT, ".row{transform:scaleX(-1)}"))).toBe(await inkIn(ROW(RIGHT, "svg{transform:scaleX(-1)}")));
    // The picture alone lets a turn through, as it does another icon: the chevron is a four-hundredth of its row.
    const down = await shoot(browser!, window, async (page) => { await page.setContent(ROW(DOWN)); });
    const up = await shoot(browser!, window, async (page) => { await page.setContent(ROW(DOWN, "svg{transform:rotate(180deg)}")); });
    const picture = comparePictures(decode(down.png), decode(up.png), [{ node: "row", box: [12, 12, 420, 72] }], 1, TOLERANCE);
    expect(picture.ratio).toBeGreaterThan(0);
    expect(picture.worst!.ratio).toBeLessThan(TOLERANCE.regionRatio);
  }, 120_000);

  it("reads an icon alike when it only moved, at another zoom or scale, and however one turn is written", async () => {
    const plain = await inkIn(ROW(DOWN));
    expect(await inkIn(ROW(DOWN, "svg{transform:translate(3px,2px)}"))).toBe(plain);
    expect(await inkIn(ROW(DOWN, ".w{transform:translate(-5px,1px)}", SPAN))).toBe(plain);
    expect(await inkIn(ROW(DOWN, "main{zoom:2}"))).toBe(plain);
    expect(await inkIn(ROW(DOWN, "svg{zoom:.72}"))).toBe(plain);
    expect(await inkIn(ROW(DOWN, ".w{transform:scale(.8)}", SPAN))).toBe(plain);
    expect(await inkIn(ROW(DOWN), { ...window, scale: 2 })).toBe(plain);
    const half = await inkIn(ROW(DOWN, "svg{transform:rotate(180deg)}"));
    expect(half).not.toBe(plain);
    for (const [css, shapes, around] of [
      ["svg{rotate:180deg}", DOWN], ["svg{transform:rotate(.5turn)}", DOWN], ["svg{transform:scale(-1,-1)}", DOWN], ["svg{transform:matrix(-1,0,0,-1,0,0)}", DOWN],
      ["svg{transform:rotate(90deg) rotate(90deg)}", DOWN], [".w{transform:rotate(180deg)}", DOWN, SPAN], [".w{transform:rotate(90deg)}", DOWN, (icon: string) => SPAN(SPAN(icon))],
      ["svg{transform:rotate(180deg) translate(4px,0)}", DOWN],
      ["", `<path transform="rotate(180 8 8)" d="M3 6l5 5 5-5"/>`], ["", `<g transform="translate(16 16) scale(-1)">${DOWN}</g>`], ["path{rotate:180deg;transform-origin:8px 8px}", DOWN],
    ] as [string, string, ((icon: string) => string)?][]) {
      expect(await inkIn(ROW(shapes, css, around)), `${css} ${shapes}`).toBe(half);
      expect(await inkIn(ROW(shapes, css, around), { ...window, scale: 2 }), `${css} ${shapes}, scale 2`).toBe(half);
    }
    // A mirror is no turn, and a shape moved inside its icon is another drawing.
    const mirrored = await inkIn(ROW(DOWN, "svg{transform:scaleY(-1)}"));
    expect(new Set([plain, half, mirrored, await inkIn(ROW(`<g transform="translate(1 0)">${DOWN}</g>`))]).size).toBe(4);
  }, 120_000);

  it("does not count a shape nobody sees, and reads a dashed stroke apart from a whole one", async () => {
    const box = await inkIn(ROW(BOX));
    expect(box).toMatch(/; shapes 1 [0-9a-f]{12}$/);
    const checked = await inkIn(ROW(BOX + CHECK));
    expect(checked).toMatch(/; shapes 2 [0-9a-f]{12}$/);
    for (const unseen of [
      `<g style="display:none">${CHECK}</g>`, `<g style="opacity:0">${CHECK}</g>`, `<g style="opacity:0"><g>${CHECK}</g></g>`, `<g style="visibility:hidden">${CHECK}</g>`,
      `<path style="stroke-opacity:0" d="M3 8.5l3.2 3.2L13 4.8"/>`,
      // Kept for something else to draw, and drawn by nothing.
      `<defs>${CHECK}</defs>`, `<symbol id="mark">${CHECK}</symbol>`, `<clipPath id="cut">${CHECK}</clipPath>`,
    ]) expect(await inkIn(ROW(BOX + unseen)), unseen).toBe(box);
    // What a definition holds is drawn where something uses it, and is then the icon's.
    const used = await inkIn(ROW(`${BOX}<defs><path id="mark" d="M3 8.5l3.2 3.2L13 4.8"/></defs><use href="#mark"/>`));
    expect(used).toMatch(/; shapes 2 [0-9a-f]{12}$/);
    expect(used).not.toBe(checked);
    expect(await inkIn(ROW(`${BOX}<defs><path id="mark" d="M3 6l5 5 5-5"/></defs><use href="#mark"/>`))).not.toBe(used);
    const group = (more: string): string => `${BOX}<defs><g id="mark">${CHECK}${more}</g></defs><use href="#mark"/>`;
    expect(await inkIn(ROW(group(`<path d="M0 0h16" style="display:none"/>`)))).toBe(await inkIn(ROW(group(""))));
    expect(await inkIn(ROW(group(`<path d="M0 0h16"/>`)))).not.toBe(await inkIn(ROW(group(""))));
    // Cut by a clip, on a group or on the icon itself, it is not the icon it was.
    expect(new Set([checked, await inkIn(ROW(`${BOX}<g clip-path="inset(0 50% 0 0)">${CHECK}</g>`)), await inkIn(ROW(BOX + CHECK, "svg{clip-path:inset(0 50% 0 0)}"))]).size).toBe(3);
    // Half see-through by its group is neither there whole nor gone.
    const half = await inkIn(ROW(`${BOX}<g style="opacity:.5">${CHECK}</g>`));
    expect(half).toContain("opacity 0.5");
    expect(new Set([box, checked, half]).size).toBe(3);
    await redOnDrawn("a check mark hidden by its group", ROW(`${BOX}<g>${CHECK}</g>`), ROW(`${BOX}<g style="display:none">${CHECK}</g>`));
    await redOnDrawn("a check mark see-through by its group", ROW(`${BOX}<g>${CHECK}</g>`), ROW(`${BOX}<g style="opacity:0">${CHECK}</g>`));

    const ring = `<circle cx="8" cy="8" r="5"/>`;
    const whole = await inkIn(ROW(ring));
    const dashed = await inkIn(ROW(`<circle cx="8" cy="8" r="5" stroke-dasharray="2 3"/>`));
    expect(dashed).toMatch(/^stroke rgb\(18, 16, 14\) 1\.8px round round dash 2px, 3px; shapes 1 [0-9a-f]{12}$/);
    expect(whole).toMatch(/^stroke rgb\(18, 16, 14\) 1\.8px round round; shapes 1 [0-9a-f]{12}$/);
    // The same dashes read the same however they are written and on every draw; dashes of no length are a whole line.
    expect(await inkIn(ROW(ring, "circle{stroke-dasharray:2px 3px}"))).toBe(dashed);
    expect(await inkIn(ROW(ring, "circle{stroke-dasharray:2 3}"), { ...window, scale: 2 })).toBe(dashed);
    expect(await inkIn(ROW(ring, "circle{stroke-dasharray:0}"))).toBe(whole);
    expect(await inkIn(ROW(ring, "circle{stroke-dasharray:2 3;stroke-dashoffset:1}"))).toMatch(/ dash 2px, 3px from 1px; /);
    expect(await inkIn(ROW(ring, "circle{stroke-dasharray:3 3.2}"))).not.toBe(dashed);
    await redOnDrawn("a dashed ring for a whole one", ROW(ring), ROW(ring, "circle{stroke-dasharray:2 3}"));
  }, 120_000);

  // The same row with a mark that is no icon: a bordered box used as a caret, a line a stylesheet draws through a sign, a letter used as an arrow.
  const LINE = (inner: string, css = ""): string => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#F0EBE3;font:16px/22px sans-serif}
    main{padding:12px} .row{all:unset;display:flex;gap:8px;align-items:center;width:420px;height:72px;background:#fff;border-radius:12px;padding:0 12px;box-sizing:border-box} .w{display:inline-flex}
    .sc{display:inline-block;width:6.4px;height:6.4px;border:solid #12100E;border-width:0 1.6px 1.6px 0;opacity:.6;box-sizing:border-box;flex:none;transform:translateY(-3.2px) rotate(45deg)}
    .rs{position:relative;display:inline-block;width:16px;height:16px;flex:none} .rs::after{content:"";position:absolute;left:-1px;right:-1px;top:50%;height:1.5px;margin-top:-.75px;background:#12100E;transform:rotate(-38deg)}
    .gl{display:inline-grid;place-items:center;width:16px;height:16px;flex:none}${css}</style>
    <main><button class="row" aria-label="Nadja Lehner">${inner}</button></main>`;
  const CARET = `<span class="sc"></span>`, STRIKE = `<span class="rs"></span>`, LETTER = `<span class="gl">›</span>`, WORDS = `<span>Nadja Lehner</span>`;
  /** Every turn a scene says: of a node, of words, of a surface and of what is drawn before or after one. */
  const turnsOf = (s: Scene): string[] => [...new Set([...s.nodes.map((n) => n.turn), ...s.types.map((t) => t.turn), ...s.paints.flatMap((p) => [p.turn, p["before.turn"], p["after.turn"]])].filter((t): t is string => !!t))].sort();
  const turnsIn = async (html: string, at: Variant = window): Promise<string[]> => turnsOf((await shoot(browser!, at, async (page) => { await page.setContent(html); })).scene);

  it("is red on a mark turned by a rule, whatever draws the mark: accepted or not, at either scale", async () => {
    await redOnDrawn("a bordered box used as a caret, pointing up for down", LINE(CARET), LINE(CARET, ".sc{transform:translateY(-3.2px) rotate(225deg)}"));
    await redOnDrawn("the caret pointing left", LINE(CARET), LINE(CARET, ".sc{transform:translateY(-3.2px) rotate(135deg)}"));
    await redOnDrawn("a line drawn through a sign, turned the other way", LINE(STRIKE), LINE(STRIKE, ".rs::after{transform:rotate(38deg)}"));
    await redOnDrawn("the line through a sign laid flat", LINE(STRIKE), LINE(STRIKE, ".rs::after{transform:none}"));
    await redOnDrawn("a letter used as an arrow, turned a quarter", LINE(LETTER), LINE(LETTER, ".gl{transform:rotate(90deg)}"));
    await redOnDrawn("the letter turned by the way its line is written", LINE(LETTER), LINE(LETTER, ".gl{writing-mode:vertical-rl}"));
    const drawn = `<span class="gl ar"></span>`;
    await redOnDrawn("a letter a stylesheet draws, turned a quarter", LINE(drawn, ".ar::before{content:'›';display:inline-block}"), LINE(drawn, ".ar::before{content:'›';display:inline-block;rotate:90deg}"));
    await redOnDrawn("the row's words mirrored", LINE(WORDS), LINE(WORDS, ".row{transform:scaleX(-1)}"));
    const wrapped = `<span class="w">${CARET}</span>`;
    await redOnDrawn("a turn on an element around the mark", LINE(wrapped, ".sc{transform:rotate(45deg)}"), LINE(wrapped, ".sc{transform:rotate(45deg)}.w{rotate:180deg}"));
    // What a finding says, in words a person reads.
    const said = async (reference: string, product: string): Promise<string[]> => {
      const [a, b] = [await shoot(browser!, window, async (page) => { await page.setContent(reference); }), await shoot(browser!, window, async (page) => { await page.setContent(product); })];
      return compareScenes(a.scene, b.scene, TOLERANCE).drawn.findings;
    };
    expect(await said(LINE(CARET), LINE(CARET, ".sc{transform:translateY(-3.2px) rotate(225deg)}"))).toEqual([expect.stringMatching(/^button "Nadja Lehner": at \[[\d., ]+\] turn 45deg is -135deg$/)]);
    expect(await said(LINE(STRIKE), LINE(STRIKE, ".rs::after{transform:none}"))).toEqual([expect.stringMatching(/^button "Nadja Lehner": at \[[\d., ]+\] after\.turn -38deg is none$/)]);
    expect(await said(LINE(WORDS), LINE(WORDS, ".row{transform:scaleX(-1)}"))).toEqual(['button "Nadja Lehner": turn none is mirrored', 'button "Nadja Lehner": text "NadjaLehner" turn none is mirrored']);
  }, 240_000);

  it("says one turn alike however and wherever it is written, and nothing of what stands upright, moved, zoomed or scaled", async () => {
    // Upright says nothing more than its paint: no page of this file's says a turn, and neither does a mark that only moved or changed its size.
    for (const html of [
      PAGE(""), MAIL(""), ROW(DOWN), LINE(WORDS), LINE(STRIKE, ".rs::after{transform:none}"), LINE(CARET, ".sc{transform:translate(3px,2px)}"), LINE(CARET, ".sc{transform:scale(.8)}"),
      LINE(CARET, ".sc{transform:none}main{zoom:2}"), LINE(CARET, ".sc{transform:none}main{transform:scale(.7342);transform-origin:0 0}"), LINE(CARET, ".sc{transform:rotate(90deg) rotate(-90deg)}"),
      // A plain span is a part of its line and takes no turn, whatever its rule says.
      LINE(`<span>Nadja <i style="transform:rotate(90deg);font-style:normal">Lehner</i></span>`),
      // An icon says how each of its shapes is turned in its ink, by the same reading, and not a second time.
      ROW(DOWN, "svg{transform:rotate(180deg)}"),
    ]) expect(await turnsIn(html), html).toEqual([]);
    expect(await turnsIn(LINE(CARET, ".sc{transform:none}"), { ...window, scale: 2 })).toEqual([]);

    const caret = await turnsIn(LINE(CARET));
    expect(caret).toEqual(["45deg"]);
    const wrapped = `<span class="w">${CARET}</span>`;
    for (const [inner, css] of [
      [CARET, ".sc{transform:rotate(45deg) translate(1px,-2px)}"], [CARET, ".sc{transform:none;rotate:45deg}"], [CARET, ".sc{transform:rotate(405deg)}"], [CARET, ".sc{transform:rotate(20deg) rotate(25deg)}"],
      [CARET, ".sc{transform:rotate3d(0,0,1,45deg)}"], [CARET, ".sc{transform:matrix(.70711,.70711,-.70711,.70711,0,-3.2)}"], [CARET, ".sc{rotate:20deg;transform:rotate(25deg)}"],
      [wrapped, ".sc{transform:none}.w{transform:rotate(45deg)}"], [wrapped, ".sc{transform:rotate(25deg)}.w{rotate:20deg}"], [`<span class="w">${wrapped}</span>`, ".sc{transform:none}.w{transform:rotate(22.5deg)}"],
      [CARET, "main{zoom:1.25}"], [CARET, "html{zoom:2}"], [CARET, "main{transform:scale(.7342);transform-origin:0 0}"], [CARET, "main{padding-top:120px}"],
    ] as const) {
      expect(await turnsIn(LINE(inner, css)), css).toEqual(caret);
      expect(await turnsIn(LINE(inner, css), { ...window, scale: 2 }), `${css}, scale 2`).toEqual(caret);
    }
    // The line through a sign: its own turn, and the same on an element around the sign.
    expect(await turnsIn(LINE(STRIKE))).toEqual(["-38deg"]);
    expect(await turnsIn(LINE(`<span class="w">${STRIKE}</span>`, ".rs::after{transform:none}.w{transform:rotate(-38deg)}"))).toEqual(["-38deg"]);
    // A mirror is no turn, and reads alike from each way of writing it; the control says it and so do its words.
    const mirrored = await turnsIn(LINE(WORDS, ".row{transform:scaleX(-1)}"));
    expect(mirrored).toEqual(["mirrored"]);
    for (const css of [".row{scale:-1 1}", ".row{transform:rotateY(180deg)}", ".row{transform:matrix(-1,0,0,1,0,0)}", ".row{transform:rotate(180deg) scaleY(-1)}", "main{transform:scaleX(-1)}"]) expect(await turnsIn(LINE(WORDS, css)), css).toEqual(mirrored);
    expect(await turnsIn(LINE(WORDS, ".row{transform:scaleY(-1)}"))).toEqual(["mirrored 180deg"]);
    // Neither a turn nor a mirror: a slant says its matrix.
    expect(await turnsIn(LINE(CARET, ".sc{transform:skewX(45deg)}"))).toEqual(["matrix 1 0 1 1"]);
    expect(await turnsIn(LINE(LETTER, ".gl{writing-mode:vertical-rl}"))).toEqual(["vertical-rl"]);
  }, 240_000);

  it("reads the box a stylesheet draws before or after an element: its size, and its place in an element that holds it", async () => {
    const read = async (css = "", at: Variant = window) => {
      const { scene: s } = await shoot(browser!, at, async (page) => { await page.setContent(LINE(STRIKE, css)); });
      return s.nodes.find((n) => n.role === "button")!.surfaces!.find((f) => s.paints[f.paint]!["after.backgroundColor"])!;
    };
    // Where it lies from its element's corner, then how large it is, before any turn: in the picture's own pixels.
    expect((await read()).parts).toEqual({ after: [-1, 7.3, 18, 1.5] });
    expect((await read("", { ...window, scale: 2 })).parts).toEqual({ after: [-1, 7.3, 18, 1.5] });
    expect((await read("main{zoom:2}")).parts).toEqual({ after: [-2, 14.5, 36, 3] });
    // In an element that does not hold it, it says its size.
    expect((await read(".rs{position:static}.rs::after{position:static;display:block;width:18px}")).parts).toEqual({ after: [18, 1.5] });
    const ask3 = async (css: string) => {
      const [a, b] = [await shoot(browser!, window, async (page) => { await page.setContent(LINE(STRIKE)); }), await shoot(browser!, window, async (page) => { await page.setContent(LINE(STRIKE, css)); })];
      const v = compareScenes(a.scene, b.scene, TOLERANCE);
      return [v.names.verdict, v.boxes.verdict, v.drawn.verdict];
    };
    expect(await ask3(".rs::after{height:4px;margin-top:-2px}"), "a line of another weight").toEqual(["green", "red", "green"]);
    expect(await ask3(".rs::after{top:15%}"), "the line moved up").toEqual(["green", "red", "green"]);
    expect(await ask3(".rs::after{height:2px;margin-top:-1px}"), "half a pixel").toEqual(["green", "green", "green"]);
    // The letter a stylesheet draws says the type it is set in, as the page's words do.
    const letter = async (css: string) => { const { scene: s } = await shoot(browser!, window, async (page) => { await page.setContent(LINE(`<span class="gl ar"></span>`, `.ar::before{content:'›';${css}}`)); }); return s.paints.find((p) => p["before.content"])!; };
    expect(await letter("")).toEqual({ "before.content": '"›"', "before.color": "rgb(0, 0, 0)", "before.font": "normal 400 16px / 22px sans-serif" });
    expect((await letter("font-size:22px"))["before.font"]).toBe("normal 400 22px / 22px sans-serif");
  }, 120_000);

  it("reads apart what else makes two icons differ: a stroke under its fill, a stroke that keeps its width, a picture inside, where its words are anchored", async () => {
    const filled = (more = ""): string => `<rect x="3" y="3" width="10" height="10" style="fill:#d9a;stroke-width:4${more}"/>`;
    await redOnDrawn("the stroke painted under the fill", ROW(filled()), ROW(filled(";paint-order:stroke")));
    expect(await inkIn(ROW(filled(";paint-order:stroke")))).toContain("stroke under fill");
    // The usual order reads the same however it is written, and so does an order that only moves the markers.
    expect(await inkIn(ROW(filled(";paint-order:fill stroke")))).toBe(await inkIn(ROW(filled())));
    expect(await inkIn(ROW(filled(";paint-order:markers")))).toBe(await inkIn(ROW(filled())));
    const large = "svg{width:24px;height:24px}";
    await redOnDrawn("a stroke that keeps its width in an icon drawn larger", ROW(DOWN, large), ROW(`<path d="M3 6l5 5 5-5" vector-effect="non-scaling-stroke"/>`, large));
    const inside = (shapes: string): string => `<image width="16" height="16" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#12100E" stroke-width="1.8">${shapes}</svg>`)}"/>`;
    await redOnDrawn("another picture inside the icon", ROW(inside(CLIP)), ROW(inside(STAR)));
    expect(await inkIn(ROW(inside(CLIP)))).toMatch(/^image; shapes 1 [0-9a-f]{12}$/);
    const word = (more = ""): string => `<text x="8" y="12" ${more} style="font:10px serif;stroke:none;fill:#000">A</text>`;
    await redOnDrawn("a word in an icon anchored at its end", ROW(word()), ROW(word('text-anchor="end"')));
    // The face of a word inside an icon is read with the page's words.
    const [a, b] = [await shoot(browser!, window, async (page) => { await page.setContent(ROW(word())); }), await shoot(browser!, window, async (page) => { await page.setContent(ROW(word().replace("10px serif", "bold 15px sans-serif"))); })];
    expect(compareScenes(a.scene, b.scene, TOLERANCE).drawn.findings.some((f) => /text "A" fontSize 10px is 15px/.test(f))).toBe(true);
  }, 240_000);

  it("fails an accepted state on a small mark that changed, by the pixels that touch; for a state nobody accepted it reports", async () => {
    // What the first three questions do not say, each one small thing in a wide row: only the picture can tell, and a share of the row cannot.
    const picture = (inner: string): string => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#12100E" stroke-width="1.8">${inner}</svg>`)}`;
    const img = (inner: string): string => `<img alt="" style="width:16px;height:16px;flex:none" src="${picture(inner)}">`;
    const cut = `<span style="display:block;width:16px;height:16px;flex:none;background:#12100E"></span>`;
    const fade = (a: string, b: string): string => `<linearGradient id="g"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><rect x="2" y="2" width="12" height="12" style="fill:url(#g);stroke:none"/>`;
    for (const [what, reference, product] of [
      ["a picture that is no inline svg, changed for another", LINE(img(CLIP)), LINE(img(STAR))],
      ["such a picture turned over", LINE(img(DOWN)), LINE(img(DOWN), "img{transform:rotate(180deg)}")],
      ["a box cut to an arrow by a clip, pointing down for up", LINE(cut, ".row span{clip-path:polygon(50% 0,100% 100%,0 100%)}"), LINE(cut, ".row span{clip-path:polygon(0 0,100% 0,50% 100%)}")],
      ["a clip on an element around an icon", ROW(STAR, "", SPAN), ROW(STAR, ".w{clip-path:inset(0 50% 0 0)}", SPAN)],
      ["what a gradient holds", ROW(fade("#d00", "#00d")), ROW(fade("#00d", "#d00"))],
      ["a line under a row's words", LINE(WORDS), LINE(WORDS, ".row span{text-decoration:underline}")],
    ] as const) {
      for (const scale of [1, 2]) {
        const at = { ...window, scale }, where = `${what}, scale ${scale}`;
        const a = await shoot(browser!, at, async (page) => { await page.setContent(reference); });
        const b = await shoot(browser!, at, async (page) => { await page.setContent(product); });
        const yes = compareState({ key: "row", reference: a, actual: b, tolerance: TOLERANCE, accepted: true });
        expect([yes.names.verdict, yes.boxes.verdict, yes.drawn.verdict], where).toEqual(["green", "green", "green"]);
        expect([yes.green, yes.picture.verdict], where).toEqual([false, "red"]);
        expect(yes.picture.mark!.pixels, where).toBeGreaterThan(TOLERANCE.mark);
        expect(yes.picture.findings.some((f) => /^button "Nadja Lehner": a mark of \d+ pixels that touch differs at \[[\d., ]+\] \(> \d+\)/.test(f)), `${where}: ${yes.picture.findings.join(" | ")}`).toBe(true);
        const no = compareState({ key: "row", reference: a, actual: b, tolerance: TOLERANCE, accepted: false });
        expect([no.green, no.picture.verdict], where).toEqual([true, "reported"]);
      }
    }
    // The caret turned over is under every share: the mark line alone makes its picture red.
    const down = await shoot(browser!, window, async (page) => { await page.setContent(LINE(CARET)); });
    const up = await shoot(browser!, window, async (page) => { await page.setContent(LINE(CARET, ".sc{transform:translateY(-3.2px) rotate(225deg)}")); });
    const v = compareState({ key: "row", reference: down, actual: up, tolerance: TOLERANCE, accepted: true });
    expect(v.picture.findings).toEqual([expect.stringMatching(/^button "Nadja Lehner": a mark of \d+ pixels that touch differs/)]);
    expect(v.picture.worst!.ratio).toBeLessThan(TOLERANCE.regionRatio / 10);
    // Two draws of one page show no mark at all.
    expect(compareState({ key: "row", reference: down, actual: await shoot(browser!, window, async (page) => { await page.setContent(LINE(CARET)); }), tolerance: TOLERANCE, accepted: true }).picture.mark).toBeNull();
  }, 240_000);

  it("reads the words of a wrapper that makes no box of its own", async () => {
    const html = `${PAGE("")}<p><span style="display:contents;color:#1F4BFF">Kept</span> and plain <span style="display:contents;visibility:hidden">, not shown</span></p>
      <div style="overflow:hidden;height:0"><span style="display:contents">Clipped away too</span></div>`;
    const { scene: s } = await shoot(browser!, window, async (page) => { await page.setContent(html); });
    expect(s.loose.text.map((r) => [r.said, s.types[r.type]!.color])).toEqual([["Kept", "rgb(31, 75, 255)"], ["and plain", "rgb(0, 0, 0)"]]);
  }, 30_000);

  it("is red on a sheet that takes the ground's colour and is gone: on where things sit, and on the picture", async () => {
    const reference = await mail();
    const gone = await mail("--sheet:#F0EBE3;");
    const v = compareState({ key: "mail", reference, actual: gone, tolerance: TOLERANCE, accepted: false });
    expect([v.green, v.names.verdict, v.boxes.verdict, v.picture.verdict]).toEqual([false, "green", "red", "red"]);
    expect(v.boxes.findings[0]).toMatch(/^main "": nothing is drawn at .* where the reference draws backgroundColor rgb\(255, 255, 255\)$/);
    expect(v.picture.ratio).toBeGreaterThan(TOLERANCE.grossRatio);
  }, 30_000);

  it("tells every two surfaces of the design apart, in every theme: by the picture, and by how they are drawn", async () => {
    const SURFACES = ["ground", "sheet", "sheet-new", "soft-sheet", "wash", "hover", "hover-ground", "soft"];
    const sheet = readFileSync(resolve(process.cwd(), "packages/tokens/src/design/tokens.css"), "utf8");
    const flat = (rgb: number[]): Picture => { const data = new Uint8Array(24 * 24 * 4); for (let i = 0; i < data.length; i += 4) data.set([rgb[0]!, rgb[1]!, rgb[2]!, 255], i); return { width: 24, height: 24, data }; };
    let pairs = 0, closest = { far: Infinity, pair: "" };
    // pixelmatch's own measure of how far two colours are apart.
    const far = (x: number[], y: number[]): number => {
      const [r, g, b] = [x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!];
      const l = r * 0.29889531 + g * 0.58662247 + b * 0.11448223, i = r * 0.59597799 - g * 0.2741761 - b * 0.32180189, q = r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
      return 0.5053 * l * l + 0.299 * i * i + 0.1957 * q * q;
    };
    for (const [face, scheme] of [["paper", "light"], ["paper", "dark"], ["ohmarchy", "light"], ["ohmarchy", "dark"]] as const) {
      const html = `<!doctype html><html data-face="${face}" data-scheme="${scheme}"><meta charset="utf-8"><style>${sheet}</style>
        <style>html,body{margin:0;background:#808080} i{display:block;float:left;width:48px;height:48px}</style>${SURFACES.map((t) => `<i style="background:var(--${t})"></i>`).join("")}</html>`;
      const drew = await shoot(browser!, { ...window, scheme }, async (page) => { await page.setContent(html); });
      const px = decode(drew.png);
      // What the browser drew for each token, read from the middle of its square.
      const shown = SURFACES.map((_, n) => [...px.data.slice((24 * px.width + n * 48 + 24) * 4, (24 * px.width + n * 48 + 24) * 4 + 3)]);
      const painted = drew.scene.loose.surfaces.filter((f) => f.box[2] === 48).map((f) => drew.scene.paints[f.paint]!);
      expect(painted.length, `${face} ${scheme}`).toBe(SURFACES.length);
      for (let a = 0; a < SURFACES.length; a++) {
        for (let b = a + 1; b < SURFACES.length; b++) {
          if (shown[a]!.join() === shown[b]!.join()) continue;
          const pair = `${face} ${scheme}: ${SURFACES[a]} (${shown[a]!.join(" ")}) and ${SURFACES[b]} (${shown[b]!.join(" ")})`;
          pairs++;
          if (far(shown[a]!, shown[b]!) < closest.far) closest = { far: far(shown[a]!, shown[b]!), pair };
          expect(painted[a]!.backgroundColor, pair).not.toBe(painted[b]!.backgroundColor);
          expect(comparePictures(flat(shown[a]!), flat(shown[b]!), [], 1, TOLERANCE).ratio, pair).toBe(1);
        }
      }
    }
    console.log(`SURFACES pairs=${pairs} closest=${closest.far.toFixed(2)} ${closest.pair}`);
    expect(pairs).toBeGreaterThan(90);
    expect(closest.far).toBeGreaterThan(35215 * TOLERANCE.pixel ** 2);
  }, 60_000);

  it("takes the picture of the state a page arrives at, not of the moment before it", async () => {
    // A sheet that opens a quarter of a second after the page loaded, over a page that stood still until then.
    const late = (ms: number): string => `${PAGE("")}<script>setTimeout(() => { const d = document.createElement("div");
      d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Discard the draft");
      d.style.cssText = "position:fixed;inset:0;background:rgba(18,16,14,.6)"; document.body.append(d); }, ${ms})</script>`;
    for (const ms of [120, 250, 400]) {
      const drew = await shoot(browser!, window, async (page) => { await page.setContent(late(ms)); });
      expect(drew.scene.nodes.map((n) => n.role), `a sheet that opens after ${ms} ms`).toContain("dialog");
      const corner = decode(drew.png).data.slice(0, 3);
      expect([...corner], `the picture, with a sheet that opens after ${ms} ms`).not.toEqual([255, 255, 255]);
    }
  }, 60_000);

  it("draws an endless animation at its rest, and a long one at its end", async () => {
    const page = `${PAGE("")}<style>@keyframes turn{to{transform:rotate(360deg)}} @keyframes arrive{from{opacity:0}to{opacity:1}}
      i{position:fixed;left:0;top:0;width:8px;height:8px;background:#12100E;animation:turn 1s linear infinite}
      b{position:fixed;right:0;top:0;width:8px;height:8px;background:#12100E;animation:arrive 30s both}</style><i></i><b></b>`;
    const drew = await shoot(browser!, window, async (p) => { await p.setContent(page); });
    const again = await shoot(browser!, window, async (p) => { await p.setContent(page); });
    const px = decode(drew.png);
    expect([[...px.data.slice(0, 3)], [...px.data.slice((window.width - 1) * 4, (window.width - 1) * 4 + 3)]]).toEqual([[18, 16, 14], [18, 16, 14]]);
    expect(again.png.equals(drew.png)).toBe(true);
  }, 30_000);

  it("holds a page's scripts until the fonts its stylesheets declare have arrived", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-fonts-"));
    writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="a.css"><h1 id="h">waiting</h1><script src="app.js"></script>`);
    writeFileSync(join(dir, "a.css"), `@font-face{font-family:"Late";src:url(late.woff2) format("woff2");font-display:swap} h1{font-family:"Late",sans-serif}`);
    writeFileSync(join(dir, "late.woff2"), "not a font; only its arrival is read");
    // What the page's own code sees when it starts: had the font's file arrived?
    writeFileSync(join(dir, "app.js"), `document.getElementById("h").textContent = performance.getEntriesByName(new URL("late.woff2", location.href).href).length ? "fonts in" : "fonts not in";`);
    const site = await serveLoopback(dir);
    try {
      const drew = await shoot(browser!, window, async (p) => { await p.goto(site.base, { waitUntil: "load" }); }, {
        prepare: (context) => context.route("**/late.woff2", async (route) => { await new Promise((done) => setTimeout(done, 300)); await route.continue(); }),
      });
      expect(drew.scene.nodes.filter((n) => n.role === "heading").map((n) => n.name)).toEqual(["fonts in"]);
      // The file was no font: the face never arrived, the heading's font-family still names it, and the scene does not list it.
      expect(drew.scene.nodes.find((n) => n.role === "heading")!.drawn.fontFamily).toContain("Late");
      expect(drew.scene.fonts).toEqual([]);
      const had = { png: drew.png, scene: { ...drew.scene, fonts: [{ family: "Late", weight: "400", style: "normal" }] } };
      const v = compareState({ key: "page", reference: had, actual: drew, tolerance: TOLERANCE, accepted: false });
      expect([v.green, v.drawn.verdict, v.picture.ratio]).toEqual([false, "red", 0]);
      expect(v.drawn.findings).toEqual(['the face "Late" (normal) is not loaded; the reference had it']);
    } finally {
      await site.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("draws a page that prints how long its own script took the same on every machine", async () => {
    // A search that says "found in 11 ms" says how fast the machine is. Read twice in one run of script, the clock reads the same.
    const timed = `${PAGE("")}<h2 id="took"></h2><script>const t0 = performance.now(); let n = 0; for (let i = 0; i < 3e7; i++) n += i % 7;
      document.getElementById("took").textContent = "found in " + Math.max(1, Math.round(performance.now() - t0)) + " ms";
      setTimeout(() => { document.getElementById("took").textContent += performance.now() > t0 ? ", and the clock runs on" : ", and the clock stands"; }, 30);</script>`;
    const drew = await shoot(browser!, window, async (page) => { await page.setContent(timed); });
    expect(drew.scene.nodes.filter((n) => n.role === "heading").map((n) => n.name)).toEqual(["found in 1 ms, and the clock runs on"]);
  }, 30_000);

  it("refuses a page that never stands still", async () => {
    const moving = `${PAGE("")}<script>setInterval(() => { document.querySelector("button").textContent = String(Date.now()); }, 50)</script>`;
    await expect(shoot(browser!, window, async (page) => { await page.setContent(moving); })).rejects.toThrow(/did not stand still/);
  }, 60_000);

  it("refuses to draw at a size nobody named", async () => {
    await expect(shoot(browser!, { ...window, scale: Number.NaN }, async () => {})).rejects.toThrow(/never taken at a default size/);
  });
});
