/**
 * A FOLD THE LAYOUT ANSWERS TO: a book's fold, upright, across the middle of the window. Pure: the window's width
 * and the folds the platform reports. Where it answers, two columns stand and the list ends at the fold, so nothing
 * lies on the crease. Tabletop (a fold lying across), a hardware hinge between two screens and the Duo's rail are
 * laid flat by width (they are not drawn yet).
 */

/** One fold as the host reports it, in the window's px. Only its x matters here. */
export interface FoldShape {
  readonly bounds: { readonly x: number; readonly w: number };
  readonly state: "flat" | "half";
  readonly orientation: "horizontal" | "vertical";
  readonly occlusion: "none" | "full";
}

/** Where the fold stands (its middle), the band it keeps clear, and the list's least width. */
export interface FoldLine {
  readonly at: number;
  readonly band: number;
  readonly floor: number;
}

/** Each side of a book holds at least this much, or it is no book (1.0.11's rule). */
export const BOOK_SIDE_MIN = 300;
/** What a half-open fold keeps clear on each side of its hinge. */
export const FOLD_KEEP = 8;
/** The list's least width beside a fold, once the window is two columns' wide. */
export const FOLD_LIST_MIN = 260;
/** The design's floor for two columns side by side. */
const TWO_COLUMNS = 700;

export function foldLineOf(window: { readonly width: number }, folds: readonly FoldShape[]): FoldLine | null {
  for (const fold of folds) {
    if (fold.orientation !== "vertical" || fold.occlusion !== "none") continue;
    const left = fold.bounds.x;
    const right = window.width - (fold.bounds.x + fold.bounds.w);
    if (left < BOOK_SIDE_MIN || right < BOOK_SIDE_MIN) continue;
    const half = fold.state === "half";
    const wide = window.width >= TWO_COLUMNS;
    /* Under two columns' width a flat book is a phone; half open it is two columns, so the crease stays clear. */
    if (!wide && !half) continue;
    return {
      at: fold.bounds.x + fold.bounds.w / 2,
      band: half ? fold.bounds.w + 2 * FOLD_KEEP : 0,
      floor: wide ? FOLD_LIST_MIN : 0,
    };
  }
  return null;
}
