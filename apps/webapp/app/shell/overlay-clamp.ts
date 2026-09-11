"use client";

/**
 * Viewport clamping for anchored overlays — the sender-sheet family's fix for the clipped bottom. Every popover
 * placed by `placePicker` opened downward with no knowledge of its own height: the flip guessed 190px, the sender
 * sheet is ~580px, and anchored to the last message of a thread everything below the fold was gone — no flip, no
 * internal scroll, and page scroll cannot reveal a `position: fixed` box.
 */

/**
 * At 1440×900 that made "Screened out" and "Spam" unreachable from the ⋯ path. The rule, in order: (1) below the
 * anchor when the whole sheet fits; (2) flipped above when below is too short; (3) WHOLE, wherever it fits, sliding
 * up by exactly the pixels it lacks and covering part of its anchor — a covered anchor is dismissable, a capped panel
 * is one you scroll to finish reading; (4) the whole viewport band, scrolling inside, only when the sheet is taller
 * than the viewport itself.
 */

/**
 * Unconditionally, the box never starts above the viewport's top or ends past its bottom.
 * `clampOverlay` is the pure geometry so a test holds it without a browser; `useOverlayClamp` wires
 * it to a live element — it measures the REAL height after render (`scrollHeight`, which a
 * `max-height` cap does not lie about) and re-clamps on resize and content changes (a confirm
 * opening, a scope switching), because the first render is not the tallest the sheet gets. The
 * anchor's own edges ride the placement state, because flipping pivots on the ANCHOR: a state built
 * without them degrades to "cap below the point", which still keeps everything reachable.
 */
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/** Distance from the anchor's edge, matching `placePicker`'s original `+ 8`. */
export const OVERLAY_GAP = 8;
/** Breathing room to the viewport edges, matching `placePicker`'s `pad`. */
export const OVERLAY_EDGE = 10;
/**
 * The cap never collapses the sheet below this. On a viewport too short to honour it beside the
 * anchor, on-screen wins over beside-the-anchor — the sheet may then cover its anchor, which is
 * the correct last resort: a covered anchor is dismissable, an off-screen destination is not.
 */
export const OVERLAY_MIN_HEIGHT = 120;

export interface OverlayPoint {
  x: number;
  y: number;
  /**
   * The pressed anchor's viewport edges — what flipping upward pivots on. Optional so every
   * hand-built state (tests, keyboard paths that predate this) still compiles and still gets
   * clamped; without them the point itself is treated as the anchor's bottom edge and the
   * overlay caps instead of flipping.
   */
  anchorTop?: number;
  anchorBottom?: number;
}

/**
 * The pure geometry: where an overlay of `naturalHeight` opens against this anchor, and the
 * tallest it may render. `maxHeight` is ALWAYS returned viewport-bound — even when the sheet
 * fits — so a later content change (the confirm, the disclosure) grows into a scroll, never
 * off-screen.
 */
export function clampOverlay(
  point: { y: number; anchorTop?: number; anchorBottom?: number },
  naturalHeight: number,
  viewportHeight: number,
): { top: number; maxHeight: number } {
  const anchorBottom = point.anchorBottom ?? point.y - OVERLAY_GAP;
  const anchorTop = point.anchorTop ?? point.y - OVERLAY_GAP;
  const below = viewportHeight - OVERLAY_EDGE - (anchorBottom + OVERLAY_GAP);
  const above = anchorTop - OVERLAY_GAP - OVERLAY_EDGE;

  let top: number;
  let maxHeight: number;
  if (naturalHeight <= below) {
    // 1. Below the anchor, whole — the placement every caller expects.
    top = anchorBottom + OVERLAY_GAP;
    maxHeight = below;
  } else if (naturalHeight <= above) {
    // 2. Flipped above the anchor, whole — the bottom edge rests on the anchor's top.
    top = anchorTop - OVERLAY_GAP - naturalHeight;
    maxHeight = above;
  } else {
    // 3./4. Neither side holds it whole: the viewport band is the cap. A sheet the band holds
    // keeps its height and slides up from the anchor by what it lacks (the final clamp below
    // does the sliding); a taller one starts at the top edge and scrolls inside.
    top = anchorBottom + OVERLAY_GAP;
    maxHeight = viewportHeight - 2 * OVERLAY_EDGE;
  }

  // The unconditional half: viewport-bound, floored at usability, on-screen at both edges.
  maxHeight = Math.min(
    Math.max(maxHeight, OVERLAY_MIN_HEIGHT),
    viewportHeight - 2 * OVERLAY_EDGE,
  );
  const height = Math.min(naturalHeight, maxHeight);
  top = Math.max(OVERLAY_EDGE, Math.min(top, viewportHeight - OVERLAY_EDGE - height));
  return { top, maxHeight };
}

/**
 * The horizontal half, against the MEASURED width. `placePicker` clamps x for its own 240px
 * guess; the sender sheet is 252px, so an anchor flush to the right edge clipped 12px of it.
 */
export function clampOverlayX(x: number, width: number, viewportWidth: number): number {
  return Math.max(OVERLAY_EDGE, Math.min(x, viewportWidth - width - OVERLAY_EDGE));
}

/**
 * `clampOverlay`, wired to the element it clamps. Returns the overlay root's `style` — position
 * plus the viewport-bound `maxHeight` and the `overflow-y` that makes a capped sheet scroll
 * instead of clipping. Inline on purpose: the shell's stylesheets are split between `app.css`
 * (not published to the desktop mirror) and the component-side files (published), and an inline
 * style is the one place both builds are guaranteed to read.
 */
export function useOverlayClamp(
  ref: RefObject<HTMLElement | null>,
  point: OverlayPoint,
): CSSProperties {
  const { x, y, anchorTop, anchorBottom } = point;
  const [fit, setFit] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el == null) return;
    const measure = () => {
      // `scrollHeight` is the NATURAL height — what the sheet wants, not what the cap left it —
      // so a capped sheet whose content shrinks back under the cap un-caps correctly too.
      const { top, maxHeight } = clampOverlay(
        { y, anchorTop, anchorBottom },
        el.scrollHeight,
        window.innerHeight,
      );
      const left = clampOverlayX(x, el.offsetWidth, window.innerWidth);
      setFit((prev) =>
        prev != null && prev.left === left && prev.top === top && prev.maxHeight === maxHeight
          ? prev
          : { left, top, maxHeight },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    // Content changes re-measure: the box's size moves whenever the natural height does on an
    // uncapped sheet, and a capped sheet re-fires the moment the cap itself changes it.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [ref, x, y, anchorTop, anchorBottom]);

  return {
    left: fit?.left ?? x,
    top: fit?.top ?? y,
    maxHeight: fit?.maxHeight,
    overflowY: "auto",
    // A capped sheet's inner scroll must not chain into the page — on the popover variant a
    // page scroll DISMISSES, so chaining would close the sheet mid-read at either scroll end.
    overscrollBehavior: "contain",
  };
}
