/**
 * The law's output, in the design's slots.
 *
 * `mapping.js` maps a theme's palette to the slot names of the old stylesheets. The design names
 * its slots differently and takes plain colours where the law writes a wash or a ring, so a live
 * theme reaches `src/design/tokens.css` through this table and nothing else. The law, its floors
 * and its fixtures are untouched.
 *
 * A wash becomes the colour it paints on its ground, mixed by the law's own `mix`; a ring
 * (`0 0 0 2px <colour>`) becomes its colour, because the face states the ring's width itself
 * (`ringw`). Slots the design draws from the face alone are not emitted: the tags and avatars
 * (hues at a fixed tone), radii, gaps, fonts and the motion curves.
 *
 * Every colour the face writes out is meant to follow the theme. The ones that do not yet are
 * named in test/design-omarchy-slots.test.ts; they keep the face's own colour.
 */
import { omarchyMap } from "./map.js";
import type { OhmarchyMap } from "./mapping.js";

type Ground = "sheet" | "ground";
type Scheme = "light" | "dark";
/** A law slot, the design slots it fills, and the ground a wash or a ring's colour is mixed on. */
const SLOTS: readonly (readonly [law: string, design: readonly string[], on?: Ground])[] = [
  ["--canvas", ["ground"]],
  ["--panel", ["sheet", "soft", "on-solid"]],
  ["--ink", ["ink"]],
  ["--ink2", ["ink2", "ink-read"]],
  ["--ink3", ["ink3"]],
  ["--accent", ["hot"]],
  ["--accent-ink", ["hot-ink"]],
  ["--on-accent", ["on-hot"]],
  ["--accent-soft", ["wash"], "sheet"],
  ["--unread-wash", ["sheet-new"]],
  ["--focus", ["focus"]],
  ["--hair", ["line"], "sheet"],
  ["--hair-soft", ["line-soft"], "sheet"],
  ["--tint", ["hover", "soft-sheet"], "sheet"],
  ["--tint2", ["off"], "sheet"],
  ["--lift-1", ["ring"], "ground"],
  ["--lift-2", ["ring-up"], "ground"],
  ["--lift-3", ["panel-ring", "row-ring"], "ground"],
  ["--lift-0", ["btn-ring", "ctl-ring"], "sheet"],
  ["--scrim", ["scrim"]],
];
const GROUND: Record<Ground, string> = { sheet: "--panel", ground: "--canvas" };
/** The floor of text, and the ink a label on a filled control starts from in each scheme. */
const TEXT_FLOOR = 4.5;
const ON_OFF: Record<Scheme, string> = { light: "--ink3", dark: "--ink2" };

const RING = /^(0 0 0 \d+px )(.+)$/;
const RGBA = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/;
const hex2 = (n: string) => Number(n).toString(16).padStart(2, "0");

/** The one colour a wash or a ring paints on `ground`. A plain colour is returned as it is. */
function paintedOn(map: OhmarchyMap, value: string, ground: string): string {
  const colour = RING.exec(value)?.[2] ?? value;
  const wash = RGBA.exec(colour);
  if (!wash) return colour;
  return map.mix(ground, `#${hex2(wash[1])}${hex2(wash[2])}${hex2(wash[3])}`, Number(wash[4]));
}

const schemeOf = (slots: Record<string, string>): Scheme => (slots["color-scheme"] === "light" ? "light" : "dark");

/** The design's slots for one mapped theme: `--ground`, `--sheet`, … and `color-scheme`. */
export function toDesignSlots(law: Record<string, string>): Record<string, string> {
  const map = omarchyMap();
  const scheme = schemeOf(law);
  const out: Record<string, string> = {};
  for (const [from, to, on] of SLOTS) {
    const value = law[from];
    if (value === undefined) continue;
    const painted = on ? paintedOn(map, value, law[GROUND[on]]) : value;
    for (const name of to) out[`--${name}`] = painted;
  }
  /* What the table cannot say. A raised thing's ring is written whole: the law's own, in its painted colour. */
  const raised = RING.exec(law["--lift-2"] ?? "");
  if (raised) out["--lift"] = `${raised[1]}${out["--ring-up"]}`;
  /* By day a filled button is the ink itself. By night the design takes a brighter one the law does not carry. */
  if (scheme === "light" && law["--ink"] !== undefined) out["--solid"] = law["--ink"];
  /* A label on a filled control: the law floors its inks on the sheet, and the fill is darker than the sheet. */
  const label = law[ON_OFF[scheme]];
  if (label !== undefined && out["--off"] !== undefined && law["--ink"] !== undefined) {
    out["--on-off"] = map.ensure(label, out["--off"], TEXT_FLOOR, law["--ink"]).value;
  }
  if (law["color-scheme"] !== undefined) out["color-scheme"] = law["color-scheme"];
  return out;
}

/** Text and marks on what they stand on, asked of the design's own pairs. The read squares are not asked: pale on purpose. */
const FLOORS: readonly (readonly [slot: string, on: string, floor: number])[] = [
  ["--ink", "--sheet", TEXT_FLOOR],
  ["--ink2", "--sheet", TEXT_FLOOR],
  ["--ink3", "--sheet", TEXT_FLOOR],
  ["--hot", "--sheet", 3],
  ["--hot-ink", "--sheet", TEXT_FLOOR],
  ["--on-hot", "--hot", TEXT_FLOOR],
  ["--on-off", "--off", TEXT_FLOOR],
  ["--on-solid", "--solid", TEXT_FLOOR],
];

/** The face's own colours in each scheme, resolved: `design.faces.ohmarchy` of `@ohmail/tokens/design`. */
export type FaceColours = Readonly<Record<Scheme, Readonly<Record<string, string>>>>;

/**
 * True when every pair clears its floor on `face` painted with `slots`. A slot the theme does not reach
 * is asked as the face's own colour, which is what the page shows; one the contrast math cannot read has
 * not cleared it.
 */
export function clearsDesignFloors(slots: Record<string, string>, face: FaceColours): boolean {
  const map = omarchyMap();
  const own = face[schemeOf(slots)];
  const shown = (slot: string) => slots[slot] ?? own[slot.slice(2)];
  try {
    return FLOORS.every(([slot, on, floor]) => map.contrast(shown(slot), shown(on)) >= floor);
  } catch {
    return false;
  }
}
