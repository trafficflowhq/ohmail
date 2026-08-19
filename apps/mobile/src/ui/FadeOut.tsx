/**
 * `gradient.scFade` — the single functional gradient in Blanc: a fade-out over
 * clamped content, so truncated text ends in light rather than in a hard cut.
 * Decorative gradients stay banned; both uses below are clamp indicators.
 *
 * TWO CALLERS, ONE GRADIENT.
 *
 *  1. The clamped stream card (`Reads`, `Receipts`) — the prototype's own
 *     `.sc-fade`, transparent → `--float` over 88px.
 *  2. The floating tab dock (`solidFrom`) — a phone-only case the deck never
 *     had. Blanc's dock floats *above* the canvas rather than sitting welded to
 *     an edge, so a scroller runs underneath it and, on a phone, keeps running
 *     into the home-indicator band below it. Left alone, a legible half-row
 *     strands itself under the capsule and reads as a clipping bug. The same
 *     fade resolves it: content dissolves into the canvas as it reaches the
 *     dock, which is the truth — there is more, and it is behind the dock.
 *     `solidFrom` holds the last stretch fully opaque so the band under the
 *     capsule is canvas, not a half-transparent smear of a row.
 *
 * Drawn with `react-native-svg` (already present for the icon set) rather than
 * pulling in a gradient package for one element.
 */
import { useId } from "react";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { View } from "react-native";

export function FadeOut({
  color,
  height = 44,
  /** Fraction of the height at which the fade has reached full opacity (0–1). */
  solidFrom = 1,
}: {
  color: string;
  height?: number;
  solidFrom?: number;
}) {
  // `useId` per instance: two <LinearGradient> defs sharing one id can resolve
  // to whichever mounted last on Android.
  const id = `fade${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height }}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity="0" />
            <Stop offset={String(solidFrom)} stopColor={color} stopOpacity="1" />
            <Stop offset="1" stopColor={color} stopOpacity="1" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}
