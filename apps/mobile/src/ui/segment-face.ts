/**
 * Which face a segmented control takes at its measured width, from its labels' measured widths.
 * EQUAL while the widest segment fits an equal share; PROPORTIONAL while every segment fits at its
 * own width; STACKED — the count under the label — once only the labels fit. A segment's padding
 * is 16, the track's 6 and the gap between segments 2. An unmeasured control (0) keeps EQUAL.
 */
export type SegmentFace = "equal" | "proportional" | "stacked";

export const SEGMENT_PAD = 16;
const TRACK = 6;
const GAP = 2;

/** `content` is each segment's label and count on one line, as measured. */
export function segmentFace(width: number, content: readonly number[]): SegmentFace {
  const n = content.length;
  if (width <= 0 || n === 0 || content.some((w) => !(w > 0))) return "equal";
  const room = width - TRACK - GAP * (n - 1);
  if (Math.max(...content) + SEGMENT_PAD <= room / n) return "equal";
  if (content.reduce((s, w) => s + w + SEGMENT_PAD, 0) <= room) return "proportional";
  return "stacked";
}

/**
 * THE SELECTED SEGMENT'S PAINT, per scheme. Light: the `float` ground lifted (l1) with a 1 dp `hair`
 * ring over the `tint2` track — the fill alone read 1.13:1 against the track. Dark: a `float` pill
 * over a translucent light track cannot stand out (ΔL from -4 to +0.6 on the canvas, panel and
 * float grounds), so the track is `tint` and the selected segment a `hair` wash over it, lighter
 * than the track by ΔL ≥ 6 on every ground (`test/segment-contrast.test.ts` computes it).
 */
export interface SegmentPaint {
  track: "tint" | "tint2";
  selected: "float" | "hair";
  ring: boolean;
}

export function segmentPaint(scheme: "light" | "dark"): SegmentPaint {
  return scheme === "dark"
    ? { track: "tint", selected: "hair", ring: false }
    : { track: "tint2", selected: "float", ring: true };
}
