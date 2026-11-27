import { design, motion } from "./design/tokens.js";

const paper = design.faces.paper.light;
const milliseconds = (value: string) => Number.parseFloat(value.replace("calc(", ""));
const curve = /^cubic-bezier\(([^)]+)\)$/.exec(motion.slick["e-move"]);
const [x1 = NaN, y1 = NaN, x2 = NaN, y2 = NaN, ...extra] = (curve?.[1] ?? "")
  .split(",")
  .map((component) => Number(component.trim() || "NaN"));
const settleEasing = [x1, y1, x2, y2] as const;
if (extra.length > 0 || !settleEasing.every(Number.isFinite)) {
  throw new Error("Pull settle easing must be a four-value cubic-bezier.");
}

/** The pull's full stop and the paper squares that lead into it while mail is checked. */
export const pullMark = {
  dragSize: Number.parseFloat(paper.s4),
  dragStroke: 2.5,
  minScale: 0.35,
  revealDistance: 20,
  fullDistance: Number.parseFloat(paper.s8),
  squareSize: Number.parseFloat(paper.sq),
  squareGap: Number.parseFloat(paper["sq-gap"]),
  squareRadius: Number.parseFloat(paper["r-sq"]),
  busyMs: milliseconds(motion.slick["d-pull"]),
  settleMs: milliseconds(motion.slick["d-move"]),
  settleEasing,
  restOpacity: 0.42,
  restScale: 0.8,
  beats: [0, 1, 2],
} as const;

/** Center and grow the full stop in the space revealed by the finger. */
export function pullMarkStyle(offset: number, fullAt = pullMark.fullDistance) {
  const open = Math.max(0, offset);
  const grown = Math.min(1, open / fullAt);
  return {
    center: open / 2,
    opacity: Math.min(1, open / pullMark.revealDistance),
    scale: pullMark.minScale + (1 - pullMark.minScale) * grown,
  };
}
