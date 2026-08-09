"use client";

/**
 * A WINDOW OVER A LONG LIST — render the rows somebody can see, reserve the height of the rest.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 *
 * Every list in the product renders `messages.map(row)` in full, which is correct and cheap for
 * a pile of a few hundred. History is the one pile with no upper bound: it holds every message
 * from every sender nobody ever screened, and on a standalone desktop client — whose mirror is
 * the whole mailbox rather than a 5 000-row window — that is tens of thousands of rows.
 *
 * Measured under jsdom at 20 000 rows, before and after — a headless DOM, so read these as the
 * shape of the change rather than as a browser's own timings:
 *
 *   mount        4 050 ms → 44 ms
 *   DOM nodes  242 904    → 423
 *   a click      1 409 ms →  6 ms   (picking a row re-renders the list to move the selection)
 *
 * The DERIVATION of those rows was measured separately and is not the problem: over the same
 * 20 000-row mirror, `consentPartition` costs 21 ms, `presentationReader`'s projection 3 ms and
 * all four pile selectors together 6 ms — 30 ms of engine work against 4 050 ms of rendering.
 * That is why nothing in the engine or in the shell's memoisation was touched.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────────────────────
 *
 * Nothing but arithmetic. It answers "which slice of the list is on screen" from the scroller's
 * own `scrollTop` and `clientHeight`, and the caller renders that slice between two empty spacer
 * elements whose heights stand in for the rows above and below. The scroller's scroll height,
 * the scrollbar and the scroll position are therefore what they would have been with every row
 * mounted — the list is not shortened, only unrendered.
 *
 * ── THE ROW HEIGHT IS MEASURED, NOT ASSUMED ─────────────────────────────────────────────────
 *
 * `estimate` is only the first frame's guess. After every render the first rendered row is
 * measured and the real height replaces it, which is what keeps the spacers honest: a spacer
 * built from a wrong estimate makes the scrollbar lie and the list drift under the thumb. Every
 * mail row is a fixed three lines — the name, the subject and the preview are each `nowrap`
 * with an ellipsis, and the tag chips sit INSIDE the subject line — so one measurement is the
 * height of all of them. A list whose rows genuinely varied would need per-row offsets and is
 * not what this is for.
 *
 * ── AND WHY THERE IS A FALLBACK VIEWPORT ────────────────────────────────────────────────────
 *
 * `clientHeight` is 0 before layout and 0 for ever under jsdom, which has no layout at all. Read
 * literally that means "no rows are visible", and a window that renders nothing is indis-
 * tinguishable from a broken list — including in the tests, where it would make the guard below
 * vacuous. So a viewport of 0 is read as {@link FALLBACK_VIEWPORT_PX}, which over-renders on a
 * short pane and is never wrong in the direction that hides mail.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────────
 *
 * No dependency, no absolutely-positioned rows, no measured-offset cache. A row stays a normal
 * child of `.rows` in document order, so the selection styling, `useSeenOnScroll`'s `[data-id]`
 * contract, focus order and `scrollIntoView` on a rendered row all work exactly as before.
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
   * The real row height, off the first rendered row. `useLayoutEffect` so the corrected spacers
   * are in place before the browser paints — a frame of the estimate's geometry followed by a
   * frame of the measured one is a visible jump of the whole list.
   *
   * ── MEASURE ONLY A ROW WHOSE IDENTITY DOES NOT DEPEND ON `rowHeight` ─────────────────────────
   *
   * The leading rendered row is `all[start]`, and `start` is `floor(scrollTop / rowHeight)`. So
   * measuring whichever row happens to lead a SCROLLED window couples the measurement to its own
   * output: two adjacent leading rows differing by even 1px make `rowHeight → start → leading row
   * → rowHeight` bounce between two values and never settle. React counts that as a runaway and
   * throws "Maximum update depth exceeded", which Next renders as the client-side "Application
   * error" page — reported live from the Receipts view, whose rows carry an amount and so are the
   * likeliest to differ by a pixel from their neighbours. The old guard rejected a no-op set but
   * not this two-value oscillation, and jsdom (offsetHeight always 0) never exercised it.
   *
   * The `start === 0` gate breaks the cycle: at the top the leading row is deterministically the
   * list's first row, whose height is fixed, so a measurement there converges in one step and
   * cannot slide the window off itself. `measured === 0` additionally lets a list that opens
   * already scrolled take exactly ONE first measurement — it cannot loop, because on the very
   * next render `measured` is non-zero and `start` is non-zero, so the guard is false. Equal-
   * height rows are this module's stated premise (see the header), so freezing the height taken
   * at the top while scrolled is that premise made explicit, not a new limitation — and it errs
   * toward reserving slightly too much height, never toward hiding mail.
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
