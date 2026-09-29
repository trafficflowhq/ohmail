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
