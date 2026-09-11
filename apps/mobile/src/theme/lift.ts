/**
 * The Blanc lift ladder for React Native. Blanc reads its structure from layered, warm-tinted shadows instead of
 * borders; `shadow.lift0…lift3` are authored as multi-layer CSS `box-shadow` stacks with negative spread. RN since
 * 0.76 accepts the CSS model exactly (`boxShadow` as an array of `{offsetX, offsetY, blurRadius, spreadDistance,
 * color}`), so this file is a transcription, not a translation — every number is the token's own, and
 * `test/theme.test.ts` parses `@ohmail/tokens`' CSS strings and asserts a layer-for-layer match. Two RN constraints,
 * documented: a shadowed view must own its background and radius (`lift()` is applied to the View carrying both,
 * never a transparent wrapper); on Android below API 28 the outer shadow degrades — `elevation` is deliberately not
 * set alongside, because mixing the two double-draws, and every panel also carries its own background step.
 */
import type { ViewStyle } from "react-native";
import type { FaceName } from "./face";
import { DEFAULT_FACE } from "./face";
import { ohmarchyLift, type FaceShadowLayer } from "./ohmarchy";
import { css, oklch, type Oklch } from "./oklch";
import type { SchemeName } from "./palette";

export type LiftLevel = "l0" | "l1" | "l2" | "l3" | "barEdge" | "sheetEdge";

interface Layer {
  /** px */
  readonly x: number;
  readonly y: number;
  readonly blur: number;
  readonly spread: number;
  readonly color: Oklch;
}

const L = (y: number, blur: number, spread: number, color: Oklch, x = 0): Layer => ({
  x,
  y,
  blur,
  spread,
  color,
});

/**
 * Light: warm-tinted (hue 50–55) contact + ambient, verbatim from `shadow.light`.
 * The leading `0 0 0 1px …` layer is the contact ring that keeps a white panel
 * legible on the off-white canvas.
 */
const light: Record<LiftLevel, Layer[]> = {
  // 0 0 0 1px /.04 · 0 1px 2px /.05 · 0 4px 10px -2px /.08
  l0: [
    L(0, 0, 1, oklch(0.4, 0.05, 55, 0.04)),
    L(1, 2, 0, oklch(0.4, 0.05, 55, 0.05)),
    L(4, 10, -2, oklch(0.36, 0.05, 52, 0.08)),
  ],
  // 0 0 0 1px /.025 · 0 2px 4px /.03 · 0 14px 32px -10px /.07 · 0 40px 96px -28px /.10
  l1: [
    L(0, 0, 1, oklch(0.4, 0.05, 55, 0.025)),
    L(2, 4, 0, oklch(0.4, 0.05, 55, 0.03)),
    L(14, 32, -10, oklch(0.35, 0.05, 52, 0.07)),
    L(40, 96, -28, oklch(0.3, 0.05, 50, 0.1)),
  ],
  // 0 1px 2px /.05 · 0 6px 16px -4px /.09 · 0 24px 56px -16px /.14 · 0 60px 130px -32px /.15
  l2: [
    L(1, 2, 0, oklch(0.4, 0.05, 55, 0.05)),
    L(6, 16, -4, oklch(0.38, 0.05, 52, 0.09)),
    L(24, 56, -16, oklch(0.33, 0.05, 50, 0.14)),
    L(60, 130, -32, oklch(0.3, 0.05, 50, 0.15)),
  ],
  // 0 2px 5px /.06 · 0 16px 40px -12px /.13 · 0 48px 110px -24px /.20 · 0 96px 210px -40px /.22
  l3: [
    L(2, 5, 0, oklch(0.4, 0.05, 55, 0.06)),
    L(16, 40, -12, oklch(0.36, 0.05, 52, 0.13)),
    L(48, 110, -24, oklch(0.3, 0.05, 50, 0.2)),
    L(96, 210, -40, oklch(0.28, 0.05, 50, 0.22)),
  ],
  // The occlusion edge under the sticky decision bar.
  barEdge: [L(14, 22, -18, oklch(0.33, 0.05, 50, 0.4))],
  // `.pile-stack::before/::after` — the upward edge under a triage pile's sheets.
  sheetEdge: [L(-2, 8, -4, oklch(0.35, 0.05, 52, 0.1))],
};

/** Dark: pure black at rising opacity — depth reads through darkness, not tint. */
const dark: Record<LiftLevel, Layer[]> = {
  l0: [
    L(0, 0, 1, oklch(0, 0, 0, 0.22)),
    L(1, 2, 0, oklch(0, 0, 0, 0.32)),
    L(4, 10, -2, oklch(0, 0, 0, 0.3)),
  ],
  l1: [
    L(1, 2, 0, oklch(0, 0, 0, 0.3)),
    L(8, 20, -8, oklch(0, 0, 0, 0.38)),
    L(24, 56, -20, oklch(0, 0, 0, 0.36)),
  ],
  l2: [
    L(2, 4, 0, oklch(0, 0, 0, 0.38)),
    L(14, 34, -12, oklch(0, 0, 0, 0.5)),
    L(40, 84, -28, oklch(0, 0, 0, 0.46)),
  ],
  l3: [
    L(3, 8, 0, oklch(0, 0, 0, 0.44)),
    L(28, 66, -18, oklch(0, 0, 0, 0.58)),
    L(80, 170, -34, oklch(0, 0, 0, 0.5)),
  ],
  barEdge: [L(14, 22, -18, oklch(0, 0, 0, 0.7))],
  // The prototype does not override the sheet edge in dark — same value, so
  // fidelity is exact rather than "improved".
  sheetEdge: [L(-2, 8, -4, oklch(0.35, 0.05, 52, 0.1))],
};

const ladders: Record<SchemeName, Record<LiftLevel, Layer[]>> = { light, dark };

/** The raw layers — exported so the fidelity test can compare against tokens.ts. */
export function liftLayers(scheme: SchemeName, level: LiftLevel): Layer[] {
  return ladders[scheme][level];
}

/**
 * THE FACE'S OWN LADDER, and why this is a lookup rather than a translation.
 *
 * Paper's ladder is authored above as OKLCH layers because the CSS it transcribes is authored
 * that way. ohmarchy's is GENERATED (`./ohmarchy.ts`) already in React Native's own layer shape,
 * because the palette mapping emits `#rrggbb` / `rgba()` and flat rings — there is nothing left
 * to convert. So the two faces meet at this one function, which every caller below goes through,
 * and no component learns that a second ladder exists (the one-UI law: a component reads tokens,
 * never the face).
 */
function faceLayers(
  scheme: SchemeName,
  level: LiftLevel,
  face: FaceName,
  ySign: 1 | -1,
): readonly FaceShadowLayer[] {
  if (face === "ohmarchy") {
    const layers = ohmarchyLift[scheme][level];
    return ySign === 1 ? layers : layers.map((l) => ({ ...l, offsetY: l.offsetY * ySign }));
  }
  return shadowLayers(scheme, level, ySign);
}

/**
 * A ready style fragment. Apply to the same View that paints the background and
 * the radius — see caveat (1) above.
 */
export function lift(scheme: SchemeName, level: LiftLevel, face: FaceName = DEFAULT_FACE): ViewStyle {
  return { boxShadow: faceLayers(scheme, level, face, 1) };
}

/**
 * The same ladder mirrored: every layer's vertical offset flips sign.
 *
 * Needed exactly once, for the decision bar. `shadow.barEdge` is authored for a
 * bar that sticks to the *top* of the mail it occludes; on a phone the decision
 * bar sits at the bottom, under the thumb, so the occlusion has to fall upward.
 * Flipping the offset keeps the token's own colour, blur and spread rather than
 * inventing a second shadow that only looks similar.
 */
export function liftUp(scheme: SchemeName, level: LiftLevel, face: FaceName = DEFAULT_FACE): ViewStyle {
  return { boxShadow: faceLayers(scheme, level, face, -1) };
}

function shadowLayers(scheme: SchemeName, level: LiftLevel, ySign: 1 | -1): FaceShadowLayer[] {
  return ladders[scheme][level].map((layer) => ({
    offsetX: layer.x,
    offsetY: layer.y * ySign,
    blurRadius: layer.blur,
    spreadDistance: layer.spread,
    color: css(layer.color),
  }));
}
