/**
 * WHAT HISTORY ASKS THE STORE FOR, renderer-free so a node test drives the rule the screen runs.
 * The range is the rows on screen and a margin either side. It is asked on every scroll, around the
 * landing at a rail press, and AGAIN after every render: a landed page renders, so a walk's next
 * step never waits for the finger (the web asks the same way, `HistoryView.tsx`'s `want` effect).
 */
import type { SlotHeights } from "./history-slot";

/** Rows asked above the first on screen, and below the last. */
export const HISTORY_ASK_ABOVE = 8;
export const HISTORY_ASK_BELOW = 10;

export interface HistoryWalk {
  want(start: number, end: number): void;
  jump(start: number): void;
}

export class HistoryAsks {
  private range: [number, number] = [0, 0];

  constructor(private readonly heights: SlotHeights) {}

  /** The rows a viewport `viewport` tall shows from `y` below slot 0's top, and the margin. */
  rangeAt(y: number, viewport: number, length: number): [number, number] {
    const top = Math.max(0, y);
    return [
      Math.max(0, this.heights.indexAt(top, length) - HISTORY_ASK_ABOVE),
      this.heights.indexAt(top + Math.max(0, viewport), length) + HISTORY_ASK_BELOW,
    ];
  }

  scrolled(walk: HistoryWalk, y: number, viewport: number, length: number): void {
    this.range = this.rangeAt(y, viewport, length);
    walk.want(...this.range);
  }

  /**
   * A rail press: the walker asks the landing and the rows above it, and the range is the landing's
   * screen (where the list end stops it short, the scroll that follows asks its own). Returns the
   * offset below slot 0's top to scroll to.
   */
  jumped(walk: HistoryWalk, start: number, viewport: number, length: number): number {
    walk.jump(start);
    const y = this.heights.offsetOf(start);
    this.range = this.rangeAt(y, viewport, length);
    walk.want(...this.range);
    return y;
  }

  /** After a render: the last range again — a page landed, or a walk owes its next step. */
  again(walk: HistoryWalk): void {
    walk.want(...this.range);
  }
}
