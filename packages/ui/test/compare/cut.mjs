/**
 * The part, not the page: how the reference (`capture-sheet.mjs`) and the product (`harness.ts`) read
 * one part of a page, so the two data files are cut the same way.
 *
 * The scene reader reads the whole page. Words that no node holds have no box, so they cannot be cut
 * to the part afterwards: the part is read alone instead (`readAlone`), with everything that is neither
 * the part nor around it hidden for the reading. Hidden boxes keep their place, so nothing moves; the
 * picture is taken after the reading, with the page as it was. Then `cutScene` keeps what lies in the
 * part's box, measures it from the part's corner, and keeps only the text styles and paints it uses.
 */
import { PAINT } from "../../../../test/compare/render.mjs";
import { readScene } from "../../../../test/compare/scene.mjs";

/**
 * In the page: hides everything but the part's nodes. What stands around them is hidden too (a caption's
 * words can sit in the cell itself), and each node the part starts at is shown again when it was shown.
 */
function hideAround(/** @type {{ root: string, selector: string | null }} */ { root, selector }) {
  const host = document.querySelector(root);
  if (!host) return 0;
  const tops = /** @type {HTMLElement[]} */ (
    selector ? [...host.querySelectorAll(selector)] : [...host.children]
  );
  const shown = tops.filter((top) => getComputedStyle(top).visibility === "visible");
  /** @type {[HTMLElement, [string, string, string][]][]} */
  const was = [];
  /* Without a transition: one on `visibility` would hold the old value on a page whose clock stands still. */
  const set = (/** @type {HTMLElement} */ el, /** @type {string} */ value) => {
    const props = ["transition", "visibility"];
    was.push([el, props.map((p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)])]);
    el.style.setProperty("transition", "none", "important");
    el.style.setProperty("visibility", value, "important");
  };
  for (const el of [document.documentElement, document.body, ...document.body.querySelectorAll("*")]) {
    if (!(el instanceof HTMLElement || el instanceof SVGElement) || tops.some((top) => top.contains(el)))
      continue;
    set(/** @type {HTMLElement} */ (el), "hidden");
  }
  for (const top of shown) set(top, "visible");
  for (const [el] of was) void getComputedStyle(el).visibility;
  /** @type {any} */ (window).__kitAlone = was;
  return was.length;
}

/** In the page: gives back what `hideAround` hid. */
function showAgain() {
  const was = /** @type {any} */ (window).__kitAlone ?? [];
  const put = (/** @type {HTMLElement} */ el, /** @type {string[]} */ [p, value, priority]) => {
    if (value) el.style.setProperty(p, value, priority);
    else el.style.removeProperty(p);
  };
  /*
   * Visibility back first, while no transition can start; the styles are worked out before the
   * transition comes back, or the browser would see both changes at once and start one.
   */
  for (const [el, [, visibility]] of was) put(el, visibility);
  for (const [el] of was) void getComputedStyle(el).visibility;
  for (const [el, [transition]] of was) put(el, transition);
  delete (/** @type {any} */ (window).__kitAlone);
}

/**
 * Reads the scene of the part alone: the nodes `selector` names under `root` (or the root's children),
 * with what stands around them, and nothing beside them.
 * @param {import("@playwright/test").Page} page
 * @param {import("../../../../test/compare/scene.d.mts").Variant} variant
 * @param {{ root: string, selector: string | null }} where
 * @returns {Promise<import("../../../../test/compare/scene.d.mts").Scene>}
 */
export async function readAlone(page, variant, where) {
  await page.evaluate(hideAround, where);
  try {
    return await page.evaluate(readScene, {
      variant,
      lists: { words: PAINT.words, boxes: PAINT.boxes, shapes: PAINT.shapes },
    });
  } finally {
    await page.evaluate(showAgain);
  }
}

/**
 * The scene's nodes and loose surfaces that lie in `target` (and that `mine` keeps, where given), their
 * boxes from its corner unless the part stands in the window; the text styles and paints renumbered to
 * those the cut keeps.
 * @param {import("../../../../test/compare/scene.d.mts").Scene} scene
 * @param {number[]} target
 * @param {"cell" | "block" | "window"} place
 * @param {(box: number[]) => boolean} [mine]
 * @returns {import("../../../../test/compare/scene.d.mts").Scene}
 */
export function cutScene(scene, target, place, mine) {
  const [x, y, w, h] = target,
    slack = 0.5;
  const round = (/** @type {number} */ n) => Math.round(n * 10) / 10;
  const kept = (/** @type {number[]} */ box) =>
    (!mine || mine(box)) &&
    box[0] >= x - slack &&
    box[1] >= y - slack &&
    box[0] + box[2] <= x + w + slack &&
    box[1] + box[3] <= y + h + slack;
  /** @type {(box: any) => any} */
  const move = (box) => (place === "window" ? box : [round(box[0] - x), round(box[1] - y), box[2], box[3]]);
  /** @type {Map<number, number>} */
  const types = new Map(),
    paints = new Map();
  const typeOf = (/** @type {number} */ i) => {
    if (!types.has(i)) types.set(i, types.size);
    return /** @type {number} */ (types.get(i));
  };
  const paintOf = (/** @type {number} */ i) => {
    if (!paints.has(i)) paints.set(i, paints.size);
    return /** @type {number} */ (paints.get(i));
  };
  const runs = (/** @type {any[] | undefined} */ list) => list?.map((r) => ({ ...r, type: typeOf(r.type) }));
  const surfaces = (/** @type {any[] | undefined} */ list) =>
    list?.map((s) => ({ ...s, box: move(s.box), paint: paintOf(s.paint) }));
  const nodes = scene.nodes
    .filter((n) => kept(n.box))
    .map((n) => {
      const out = { ...n, box: move(n.box) };
      if (n.text) out.text = runs(n.text);
      if (n.surfaces) out.surfaces = surfaces(n.surfaces);
      return out;
    });
  const loose = {
    text: runs(scene.loose.text) ?? [],
    surfaces: surfaces(scene.loose.surfaces.filter((s) => kept(s.box))) ?? [],
  };
  const pick = (/** @type {any[]} */ table, /** @type {Map<number, number>} */ used) =>
    [...used.entries()].sort((a, b) => a[1] - b[1]).map(([from]) => table[from]);
  return {
    ...scene,
    types: pick(scene.types, types),
    paints: pick(scene.paints, paints),
    nodes: /** @type {any} */ (nodes),
    loose,
  };
}
