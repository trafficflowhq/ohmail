/**
 * What runs inside the two pages, the product's and the reference's: the finders a subject's table names an element
 * with, and the reading of one element. Plain JavaScript in a file of its own, because a function is handed to the
 * page as its source text, and a TypeScript file run through tsx gains helpers in that text the page does not have.
 */

/**
 * Finds one element by a finder of the subjects' table: an expression over these helpers, evaluated in the page.
 * Marks it with `data-real-measure="<mark>"` and says whether it found one, or `"threw"`: a broken finder is a
 * fault of the table, never an element that is absent.
 * @param {[string | null, string]} args the expression (null: this side has no such element) and the mark
 * @returns {boolean | "threw"}
 */
export function markElement([expr, mark]) {
  for (const el of document.querySelectorAll(`[data-real-measure="${mark}"]`)) el.removeAttribute("data-real-measure");
  if (expr === null) return false;
  const words = (/** @type {Element | null} */ el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const q = (/** @type {string} */ s) => document.querySelector(s);
  const qa = (/** @type {string} */ s) => [...document.querySelectorAll(s)];
  const helpers = {
    q,
    qa,
    within: (/** @type {Element | null} */ el, /** @type {string} */ s) => (el ? el.querySelector(s) : null),
    byText: (/** @type {string} */ s, /** @type {string} */ t) => qa(s).find((el) => words(el) === t) ?? null,
    /* The product's rail entry by the words of its name. */
    railEntry: (/** @type {string} */ name) =>
      qa("nav.oh-rail button.oh-railentry").find((b) => words(b.querySelector(".oh-railentry-name")) === name) ?? null,
    /* The reference's rail entry by the words of its name. */
    refEntry: (/** @type {string} */ name) =>
      qa("#rail .rscroll button.nav").find((b) => words(b.querySelector(".w")) === name) ?? null,
    /* A dock's entry, either side, by the first part of its accessible name. */
    dockEntry: (/** @type {string} */ name) =>
      qa("nav.oh-dock button, #rail button.nav").find((b) => (b.getAttribute("aria-label") ?? "").split(",")[0].trim() === name) ?? null,
    footPull: () => qa("nav.oh-rail .oh-railfoot button").find((b) => /Pull new mail/.test(words(b))) ?? null,
    headBell: () => q(".oh-listhead-aside")?.querySelector("button, a, span") ?? null,
    groupHead: (/** @type {string} */ name) =>
      qa("h2, [role=heading], .oh-group, .oh-listgroup-head").find((el) => words(el).replace(/\s*\d+$/, "") === name) ?? null,
  };
  let el = null;
  try {
    el = new Function(...Object.keys(helpers), `return (${expr});`)(...Object.values(helpers));
  } catch {
    return "threw";
  }
  if (!(el instanceof Element)) return false;
  el.setAttribute("data-real-measure", mark);
  return true;
}

/**
 * Every value of the marked element a person sees, as the browser computed it. Boxes in CSS pixels to a tenth; every
 * other value is the computed string itself.
 * @param {[string, "box" | "text" | "icon"]} args the mark and what kind of element it is
 */
export function readElement([mark, kind]) {
  const el = document.querySelector(`[data-real-measure="${mark}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const tenth = (/** @type {number} */ n) => Math.round(n * 10) / 10;
  const sides = ["Top", "Right", "Bottom", "Left"];
  const none = sides.every((s) => cs.getPropertyValue(`border-${s.toLowerCase()}-style`) === "none" || parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) === 0);
  /** @type {Record<string, string | number | boolean | null>} */
  const out = {
    text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
    x: tenth(r.x), y: tenth(r.y), w: tenth(r.width), h: tenth(r.height),
    visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0,
    color: cs.color, background: cs.backgroundColor, opacity: cs.opacity,
    radius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].join(" "),
    border: none ? "none" : sides.map((s) => {
      const side = s.toLowerCase();
      return `${cs.getPropertyValue(`border-${side}-width`)} ${cs.getPropertyValue(`border-${side}-style`)} ${cs.getPropertyValue(`border-${side}-color`)}`;
    }).join(" | "),
    shadow: cs.boxShadow,
    padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" "),
    gap: cs.columnGap === "normal" ? cs.rowGap : cs.columnGap,
    fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontSize: cs.fontSize, lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing, fontVariation: cs.fontVariationSettings,
  };
  if (kind === "icon") {
    const shape = el.querySelector("path, circle, rect, line, polyline") ?? el;
    const ps = getComputedStyle(shape);
    Object.assign(out, { stroke: ps.stroke, strokeWidth: ps.strokeWidth, fill: ps.fill, viewBox: el.getAttribute("viewBox"), iconColor: cs.color });
  }
  return out;
}

/** The face families the page declared, as `document.fonts` holds them, with their state. */
export function facesDeclared() {
  return [...document.fonts].map((f) => `${f.family.replace(/"/g, "")} ${f.weight} ${f.status}`);
}
