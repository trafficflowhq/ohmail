/**
 * `gradient.scFade` — the single functional gradient in Blanc: a fade-out over clamped content, so
 * truncated text ends in light rather than a hard cut. Decorative gradients stay banned; every use
 * is a clamp indicator: the clamped stream card (`Reads`, `Receipts` — the prototype's `.sc-fade`),
 * the reader's top edge under its bar (`edge="top"`), and the floating tab dock (`solidFrom`) — a case
 * where a scroller runs under the dock into the home-indicator band, and a stranded half-row reads
 * as a clipping bug; the fade dissolves content into the canvas, which is the truth — there is
 * more, behind the dock. `solidFrom` holds the last stretch opaque. Drawn with `react-native-svg`
 * (already present) rather than a gradient package for one element.
 */
import { useId } from "react";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { View } from "react-native";

export function FadeOut({
  color,
  height = 44,
  /** Fraction of the height at which the fade has reached full opacity (0–1). */
  solidFrom = 1,
  /** Which edge the fade sits on; it is opaque at that edge. */
  edge = "bottom",
}: {
  color: string;
  height?: number;
  solidFrom?: number;
  edge?: "top" | "bottom";
}) {
  // `useId` per instance: two <LinearGradient> defs sharing one id can resolve
  // to whichever mounted last on Android.
  const id = `fade${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <View pointerEvents="none" style={[{ position: "absolute", left: 0, right: 0, height }, edge === "top" ? { top: 0 } : { bottom: 0 }]}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1={edge === "top" ? "1" : "0"} x2="0" y2={edge === "top" ? "0" : "1"}>
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
