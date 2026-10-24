/**
 * THE WALK: which of a thread's squares is current while the reader scrolls, and where a press on a
 * square lands. One copy for the web reader, the desktop's and the phone's; each host measures its
 * panels' tops, the scroll's range and the reading height once per layout change and reads only the
 * scroll offset on a scroll. It sets the ring and the press's landing, never what is read
 * (`reader-seen-rules.ts` owns that).
 *
 * A reading line stands `WALK_LINE` (30 %) down the view. The current message is the LAST whose top
 * has crossed it. Two ends:
 * - the start: at scroll 0 only the first is current. When the first panel is shorter than the line's
 *   height the line starts just above the second top and rises to 30 % over the first screenful;
 * - the end: when the thread ends before the last tops can reach the line, the line slides down over
 *   the last screenful by exactly that deficit, so the remaining tops cross it in order and at the very
 *   bottom (within a pixel of it: zoomed text stops a scroll a fraction short) the last message is
 *   current, a one-line last message too.
 * The line moves down with the scroll and never up, so a crossed top stays crossed: the answer never
 * steps back on a one-way scroll, and every message is passed on the way. A thread that fits its view
 * has nothing to walk: the message the reader opened is current. A press pins its square (`WalkPin`)
 * until the host ends the pin on the person's next scroll.
 */

/** The reading line's height in the view, as a share of it. */
export const WALK_LINE = 0.3;

export interface WalkGeometry {
  /** Each panel's top in the scroller's content px, in panel order (oldest first). */
  tops: readonly number[];
  /** The scroll's range: content height less the scroll view's height (≥ 0). */
  max: number;
  /** The reading height: the scroll view less what floats over its foot. */
  view: number;
  /** The index of the message the reader opened. */
  opened: number;
}

/** A press or a landing; the host decides when it ends. */
export interface WalkPin {
  index: number;
}

export interface Walk {
  /** The current message's index for scroll `scroll`; −1 = no answer, keep the last ring. */
  current(scroll: number, pin?: WalkPin | null): number;
  /** The scroll that puts that message's top on the line, clamped to [0, max], ceiled. */
  scrollFor(index: number): number;
  /** The line for scroll `scroll`, in px below the view's top (tests and debugging). */
  lineAt(scroll: number): number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function threadWalk(g: WalkGeometry): Walk {
  const n = g.tops.length;
  const max = Math.max(0, Number.isFinite(g.max) ? g.max : 0);
  const view = Number.isFinite(g.view) ? g.view : 0;
  // a panel not laid out yet takes the previous top: the order never reverses
  const tops: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = Number.isFinite(g.tops[k]) ? g.tops[k] : 0;
    tops.push(k > 0 ? Math.max(t, tops[k - 1]) : t);
  }
  const last = n > 0 ? tops[n - 1] : 0;
  const line0 = WALK_LINE * view;
  // the start: at scroll 0 only the first top is on or above the line
  const lineStart = n > 1 ? Math.max(tops[0], Math.min(line0, tops[1] - 1)) : line0;
  const rise = Math.max(0, line0 - lineStart);
  const span0 = Math.min(max, Math.max(0, view));
  // the end: how far the line comes down so the last top is on it at the scroll's end
  const slide = Math.max(0, last - max - line0);
  const span1 = span0;
  const start1 = max - span1;
  const opened = n > 0 ? (g.opened >= 0 && g.opened < n ? g.opened : n - 1) : -1;

  const share = (s: number, start: number, span: number) => (span > 0 ? clamp((s - start) / span, 0, 1) : 0);
  const lineAt = (s: number) => {
    const c = clamp(s, 0, max);
    return lineStart + rise * share(c, 0, span0) + slide * share(c, start1, span1);
  };
  // the line in the content's coordinates: strictly increasing in the scroll
  const L = (s: number) => s + lineAt(s);

  function current(scroll: number, pin?: WalkPin | null): number {
    if (n === 0 || !(view > 0)) return -1;
    if (pin && pin.index >= 0 && pin.index < n) return pin.index;
    if (max === 0) return opened;
    // a scroll within a pixel of either end is that end: under CSS zoom a scroll to the end stops a
    // fraction short of max, and near the end the line runs faster than the scroll
    const c = max > 1 && scroll >= max - 1 ? max : scroll <= 0.5 ? 0 : clamp(scroll, 0, max);
    const line = L(c);
    let i = 0;
    for (let k = 1; k < n; k++) {
      if (tops[k] <= line + 0.5) i = k;
      else break;
    }
    return i;
  }

  // L is piecewise linear with its knees at the ramps' ends: find the segment holding the top and solve;
  // ceiled (past float noise) so an integer scroll keeps the top on or above the line
  function scrollFor(index: number): number {
    if (n === 0 || max === 0) return 0;
    const T = tops[clamp(Math.trunc(index), 0, n - 1)];
    if (T <= L(0)) return 0;
    if (T >= L(max)) return max;
    const knees = [...new Set([0, span0, start1, max])].sort((a, b) => a - b);
    for (let k = 1; k < knees.length; k++) {
      const a = knees[k - 1];
      const b = knees[k];
      const La = L(a);
      const Lb = L(b);
      if (T >= La && T <= Lb) return clamp(Math.ceil(a + ((T - La) * (b - a)) / (Lb - La) - 1e-6), 0, max);
    }
    return max;
  }

  return { current, scrollFor, lineAt };
}
