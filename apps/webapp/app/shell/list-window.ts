"use client";

/**
 * A window over a long list — render the rows somebody can see, reserve the height of the rest.
 * History is the one pile with no upper bound, and a 5 000-row mirror window still holds far more
 * rows than a viewport: measured under jsdom at 20 000 rows, mount 4 050 ms → 44 ms, DOM nodes
 * 242 904 → 423, a click 1 409 ms → 6 ms (the derivation was measured separately at ~30 ms and is
 * not the problem).
 */

/**
 * Nothing but arithmetic: it answers "which slice is on screen" from the scroller's own
 * `scrollTop`/`clientHeight`, and the caller renders that slice between two spacers, so scroll
 * height, scrollbar and position are what they would have been with every row mounted. The row
 * height is measured, not assumed: `estimate` is only the first frame's guess, and every mail row
 * is a fixed three lines, so one measurement is the height of all of them. `clientHeight` of 0
 * (pre-layout, jsdom) reads as {@link FALLBACK_VIEWPORT_PX} — over-render, never hide mail. No
 * dependency, no absolute rows: rows stay normal children in document order, so selection styling,
 * `useSeenOnScroll`'s `[data-id]` contract and focus order work as before.
 */
import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

/** The first frame's guess at a mail row's height. Replaced by a measurement immediately. */
export const ESTIMATED_ROW_PX = 80;

/** Read for a scroller that has not been laid out yet (and for jsdom, which never will be). */
export const FALLBACK_VIEWPORT_PX = 1200;

/** Rows rendered above and below the viewport, so a scroll reveals mail rather than a gap. */
const OVERSCAN_ROWS = 8;

export interface ListWindow {
  /** First index to render, inclusive. */
  start: number;
  /** Last index to render, exclusive. */
  end: number;
  /** Pixels to reserve above the rendered slice. */
  padTop: number;
  /** Pixels to reserve below it. */
  padBottom: number;
  /** The row height in force — measured once a row has been laid out, else the estimate. */
  rowHeight: number;
}

export interface UseListWindowOptions {
  /** The element that scrolls — `ListPane`'s own, via its `scrollerRef` prop. */
  scrollerRef: RefObject<HTMLElement | null>;
  /** How many rows the list holds in total. */
  count: number;
  /** First-frame row height, before one has been measured. */
  estimate?: number;
  overscan?: number;
}

/**
 * The window for a scroller holding `count` equal-height rows.
 *
 * Recomputes on scroll (once per animation frame), on resize, and whenever `count` changes.
 */
export function useListWindow({
  scrollerRef,
  count,
  estimate = ESTIMATED_ROW_PX,
  overscan = OVERSCAN_ROWS,
}: UseListWindowOptions): ListWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [measured, setMeasured] = useState(0);

  const sample = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewport(el.clientHeight);
  }, [scrollerRef]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    sample();

    // One read per frame. A scroll fires far more often than it can be painted, and every one
    // of them would otherwise be a React render over the whole pane.
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sample();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [scrollerRef, sample]);

  const rowHeight = measured > 0 ? measured : estimate;
  const height = viewport > 0 ? viewport : FALLBACK_VIEWPORT_PX;
  const visible = Math.ceil(height / rowHeight);

  const start = Math.max(0, Math.min(count, Math.floor(scrollTop / rowHeight) - overscan));
  const end = Math.min(count, start + visible + overscan * 2);

  /**
   * The real row height, off the first rendered row; `useLayoutEffect` so corrected spacers are in
   * place before paint. Measure only a row whose identity does not depend on `rowHeight`: the
   * leading row is `all[start]` and `start` is `floor(scrollTop / rowHeight)`, so measuring a
   * scrolled window's leading row couples the measurement to its own output — two adjacent rows
   * differing by 1px make it oscillate, React throws "Maximum update depth exceeded", and Next
   * shows the "Application error" page (reported live from Receipts; jsdom never exercised it).
   */

  /**
   * The `start === 0` gate breaks the cycle — at the top the leading row is deterministic;
   * `measured === 0` lets a list that opens scrolled take exactly ONE measurement. Equal-height
   * rows are the module's stated premise, and the freeze errs toward reserving too much, never
   * toward hiding mail.
   */
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const row = el?.querySelector<HTMLElement>(".row");
    const h = row?.offsetHeight ?? 0;
    if (h > 0 && Math.abs(h - measured) >= 1 && (measured === 0 || start === 0)) setMeasured(h);
  });

  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (count - end) * rowHeight),
    rowHeight,
  };
}
