/**
 * THE OHMARCHY FACE FOR REACT NATIVE — GENERATED, never hand-edited.
 *
 * Written by `scripts/generate-ohmarchy.mjs` from the tokens package's generated ohmarchy set —
 * the same face the browser and the desktop wear, which `packages/tokens/omarchy/mapping.js`
 * derives from the tokyo-night (dark) and flexoki-light (light) palettes and which
 * ships to the web as `packages/tokens/src/ohmarchy.css`. `test/ohmarchy-face.test.ts` re-runs
 * that generation in-process and fails if this file differs, so a hand edit cannot survive a test
 * run, and the phone's face cannot drift from the desktop's.
 *
 * Read the generator's header for the four projections (colour · radius · lift · motion) and for
 * the four token groups deliberately NOT projected onto a phone, each with its reason.
 *
 * Paper is the ABSENT face: nothing here is consulted unless `Theme.face === "ohmarchy"`, which
 * is what keeps the paper look byte-identical by construction.
 */
import type { LiftLevel } from "./lift";
import type { Palette, SchemeName } from "./palette";
import type { radius as paperRadius } from "./tokens";

/** One React Native `boxShadow` layer — the CSS box-shadow model, which RN adopted verbatim. */
export interface FaceShadowLayer {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly blurRadius: number;
  readonly spreadDistance: number;
  /** Already an RN-parseable colour: the mapping emits `#rrggbb` and `rgba()` only. */
  readonly color: string;
}

/** The palette per scheme — the same 16 slots + 3 tag hues the paper palette carries. */
export const ohmarchyPalettes: Record<SchemeName, Palette> = {
  light: {
    scheme: "light",
    canvas: "#f2efe4",
    panel: "#FFFCF0",
    float: "#FFFCF0",
    ink: "#100F0F",
    ink2: "#383635",
    ink3: "#5f5e5a",
    hair: "rgba(16,15,15,0.25)",
    hairSoft: "rgba(16,15,15,0.12)",
    tint: "rgba(16,15,15,0.04)",
    tint2: "rgba(16,15,15,0.08)",
    accent: "#205EA6",
    accentInk: "#205EA6",
    accentSoft: "rgba(32,94,166,0.12)",
    accentHair: "rgba(32,94,166,0.42)",
    onAccent: "#FFFCF0",
    scrim: "rgba(255,252,240,0.5)",
    tag: {
      moss: { ink: "#2d7b74", bg: "rgba(58,169,159,0.14)" },
      ochre: { ink: "#69772f", bg: "rgba(135,154,57,0.14)" },
      rosewood: { ink: "#aa6225", bg: "rgba(208,119,43,0.14)" },
    },
  },
  dark: {
    scheme: "dark",
    canvas: "#13141c",
    panel: "#1a1b26",
    float: "#1a1b26",
    ink: "#a9b1d6",
    ink2: "#8d96bc",
    ink3: "#7a82ab",
    hair: "rgba(169,177,214,0.25)",
    hairSoft: "rgba(169,177,214,0.12)",
    tint: "rgba(169,177,214,0.04)",
    tint2: "rgba(169,177,214,0.08)",
    accent: "#7aa2f7",
    accentInk: "#7aa2f7",
    accentSoft: "rgba(122,162,247,0.12)",
    accentHair: "rgba(122,162,247,0.42)",
    onAccent: "#1a1b26",
    scrim: "rgba(26,27,38,0.5)",
    tag: {
      moss: { ink: "#449dab", bg: "rgba(68,157,171,0.14)" },
      ochre: { ink: "#9ece6a", bg: "rgba(158,206,106,0.14)" },
      rosewood: { ink: "#ff9e64", bg: "rgba(255,158,100,0.14)" },
    },
  },
};

/**
 * The radius ladder under ohmarchy, through faces.css's off-band ratio rule (generator
 * projection 2). Every value is 0 because ohmarchy's whole radius ladder is 0 — the ratio is
 * what makes that a DERIVATION of the face's own slots rather than a table of zeros somebody
 * typed, and it is why a face declaring `--r-card: 4px` would land `menuItem` at 11 × 4/14.
 */
export const ohmarchyRadius: Record<keyof typeof paperRadius, number> = {
  /** paper 3 · ctl band 8 → 0 */
  dot: 0,
  /** paper 6 · ctl band 8 → 0 */
  keycap: 0,
  /** paper 8 · ctl band 8 → 0 */
  focus: 0,
  /** paper 10 · ctl band 8 → 0 */
  item: 0,
  /** paper 11 · card band 14 → 0 */
  menuItem: 0,
  /** paper 13 · card band 14 → 0 */
  paletteItem: 0,
  /** paper 14 · card band 14 → 0 */
  rowDense: 0,
  /** paper 16 · card band 14 → 0 */
  row: 0,
  /** paper 18 · overlay band 20 → 0 */
  input: 0,
  /** paper 20 · overlay band 20 → 0 */
  panel: 0,
  /** paper 22 · overlay band 20 → 0 */
  card: 0,
  /** paper 24 · overlay band 20 → 0 */
  overlay: 0,
  /** paper 28 · overlay band 20 → 0 */
  reader: 0,
  /** paper 999 · pill band 99 → 0 */
  pill: 0,
};

/**
 * The lift ladder per scheme. ohmarchy reads its structure from flat hairline RINGS, which is
 * why these are single-layer where paper stacks four warm shadows. `sheetEdge` is `--bar-edge`
 * with its offset flipped — the mirror `liftUp()` performs on that same token.
 */
export const ohmarchyLift: Record<SchemeName, Record<LiftLevel, readonly FaceShadowLayer[]>> = {
  light: {
    l0: [
      { offsetX: 0, offsetY: 0, blurRadius: 0, spreadDistance: 1, color: "rgba(16,15,15,0.4)" },
    ],
    l1: [
      { offsetX: 0, offsetY: 0, blurRadius: 0, spreadDistance: 2, color: "rgba(89,89,89,0.67)" },
    ],
    l2: [
      { offsetX: 0, offsetY: 0, blurRadius: 0, spreadDistance: 2, color: "#B7B5AC" },
    ],
    l3: [
      { offsetX: 0, offsetY: 0, blurRadius: 0, spreadDistance: 2, color: "#205EA6" },
    ],
    barEdge: [
      { offsetX: 0, offsetY: 1, blurRadius: 0, spreadDistance: 0, color: "rgba(16,15,15,0.25)" },
    ],
    sheetEdge: [
      { offsetX: 0, offsetY: -1, blurRadius: 0, spreadDistance: 0, color: "rgba(16,15,15,0.25)" },
    ],
  },
  dark: {
    l0: [
      { offsetX: 0, offsetY: 0, blurRadius: 0, spreadDistance: 1, color: "rgba(169,177,214,0.4)" },
    ],
    l1: [
      { offsetX: 0, offsetY: 0, blurRadius: 0, spreadDistance: 2, color: "rgba(89,89,89,0.67)" },
    ],
    l2: [
      { offsetX: 0, offsetY: 0, blurRadius: 0, spreadDistance: 2, color: "#414868" },
    ],
    l3: [
      { offsetX: 0, offsetY: 0, blurRadius: 0, spreadDistance: 2, color: "#7aa2f7" },
    ],
    barEdge: [
      { offsetX: 0, offsetY: 1, blurRadius: 0, spreadDistance: 0, color: "rgba(169,177,214,0.25)" },
    ],
    sheetEdge: [
      { offsetX: 0, offsetY: -1, blurRadius: 0, spreadDistance: 0, color: "rgba(169,177,214,0.25)" },
    ],
  },
};

/** The easing pair ohmarchy really does move, as `Easing.bezier` control points. */
export const ohmarchyEasing = {
  spring: [0.23, 1, 0.32, 1] as const,
  swift: [0.33, 1, 0.68, 1] as const,
} as const;
