"use client";

/**
 * A window over a long list — render the rows somebody can see, reserve the height of the rest.
 * History is the one pile with no upper bound, and a 5 000-row mirror window still holds far more
 * rows than a viewport: measured under jsdom at 20 000 rows, mount 4 050 ms → 44 ms, DOM nodes
 * 242 904 → 423, a click 1 409 ms → 6 ms (the derivation was measured separately at ~30 ms and is
 * not the problem).
 */

/**
 * It answers "which slice is on screen" from the scroller's own `scrollTop`/`clientHeight`, and
 * the caller renders that slice between two spacers, so scroll height, scrollbar and position are
 * what they would have been with every row mounted. A list whose items carry `data-index` windows
 * above {@link MEASURED_FULL_RANGE_MAX_ROWS}; one that stamps none renders whole up to
 * {@link FULL_RANGE_MAX_ROWS}. `clientHeight` of 0 reads as {@link FALLBACK_VIEWPORT_PX} —
 * over-render, never hide mail.
 */

/**
 * ROWS NEED NOT BE OF ONE HEIGHT. Every item the caller stamps with `data-index` is measured as
 * it renders, and the reserved height is the prefix sum of those measurements — the running mean
 * for indices nobody has drawn yet, never one row's height for all of them. No dependency, no
 * absolute rows: rows stay normal children in document order, so selection styling,
 * `useSeenOnScroll`'s `[data-id]` contract and focus order work as before.
 */

/**
 * AND THE CONTENT HOLDS STILL UNDER THE READER. An estimate is frozen once its row stands above
 * the rendered slice, so a later measurement cannot re-price the rows already scrolled past —
 * that moved the spacer under a fixed `scrollTop`, and the rows at the top edge left before they
 * reached it (reported live on 0.19.3, after any jump). When a measurement moves the offset of
 * the item under the top edge, `scrollTop` moves by exactly that delta in the same layout
 * effect, before paint: the scroller's `overflow-anchor` is off (app.css), so this is the anchor.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

/** The first frame's guess at a mail row's height. Replaced by a measurement immediately. */
export const ESTIMATED_ROW_PX = 80;

/** Read for a scroller that has not been laid out yet (and for jsdom, which never will be). */
export const FALLBACK_VIEWPORT_PX = 1200;

/** Rows rendered above and below the viewport, so a scroll reveals mail rather than a gap. */
const OVERSCAN_ROWS = 8;

/**
 * A list whose items carry no `data-index` renders whole up to this: the window could price its
 * rows only at one measured height, and rows of mixed height then drift past the reader — the
 * 0.19.2 defect. Above it such a list windows anyway; an unbounded render is worse.
 */
export const FULL_RANGE_MAX_ROWS = 500;

/**
 * A list whose items carry `data-index` is measured row by row and windows above this — a
 * switch into a pile of a few hundred rows then mounts a screenful. Which floor applies is read
 * in the first layout pass, before paint: the first render assumes the stamp, and a list that
 * turns out to stamp nothing re-renders whole before anything is drawn.
 */
export const MEASURED_FULL_RANGE_MAX_ROWS = 50;

export interface ListWindow {
  /** First index to render, inclusive. */
  start: number;
  /** Last index to render, exclusive. */
  end: number;
  /** Pixels to reserve above the rendered slice. */
  padTop: number;
  /** Pixels to reserve below it. */
  padBottom: number;
  /** The height in force for an unmeasured row — the mean of what has been measured. */
  rowHeight: number;
  /** Where index `i` starts, in scroller pixels: the prefix sum of the measured heights. */
  offsetOf: (index: number) => number;
  /**
   * The slots the viewport shows, plus the overscan — whether or not the list renders whole. A
   * list that fetches its rows asks for these, never for every slot a short list mounts.
   */
  visibleStart: number;
  visibleEnd: number;
}

export interface UseListWindowOptions {
  /** The element that scrolls — `ListPane`'s own, via its `scrollerRef` prop. */
  scrollerRef: RefObject<HTMLElement | null>;
  /** How many items the list holds in total — rows, and any group header given its own index. */
  count: number;
  /** First-frame row height, before one has been measured. */
  estimate?: number;
  overscan?: number;
}

/**
 * The window for a scroller holding `count` items of any heights.
 *
 * Recomputes on scroll (once per animation frame), on resize, whenever `count` changes, and
 * whenever a measured height moves — a preview line arriving grows its row and the sums follow.
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
  /** index → the height that index was last drawn at. Never cleared: a row keeps its size. */
  const heights = useRef<Map<number, number>>(new Map());
  /**
   * index → the estimate an undrawn index was reserved at once it stood above the slice. Read
   * before the mean and replaced only by a measurement, so the rows the reader scrolled past keep
   * the price the spacer already paid for them.
   */
  const frozen = useRef<Map<number, number>>(new Map());
  /** Every unmeasured index below this has a frozen estimate; the freezing pass resumes here. */
  const frozenUpTo = useRef(0);
  /** The item under the top edge at the last commit, where the DOM had it, and at which count. */
  const anchor = useRef<{ index: number; offset: number; count: number } | null>(null);
  /** Bumped when a measurement moves, which is what makes the sums below recompute. */
  const [samples, setSamples] = useState(0);
  /** Did the first layout pass find `data-index` items? `null` until a pass has drawn some. */
  const [stamped, setStamped] = useState<boolean | null>(null);

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

  /**
   * THE HEIGHT OF A ROW NOBODY HAS DRAWN AND NOBODY HAS SCROLLED PAST. The mean of the
   * measurements, so a list of two- and three-line rows reserves the average of the two rather
   * than the first one's height for all of them; an index above the slice keeps its `frozen`
   * price instead. A caller that stamps no `data-index` measures nothing and falls back to the
   * one row this hook reads itself, which is what every equal-height list did before the cache.
   */
  const mean = useMemo(() => {
    let sum = 0;
    let n = 0;
    for (const h of heights.current.values()) {
      sum += h;
      n += 1;
    }
    if (n > 0) return sum / n;
    return measured > 0 ? measured : estimate;
    // `samples` is the signal that the map behind this changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, measured, estimate]);

  /** `prefix[i]` = where item `i` starts. `prefix[count]` is the list's whole height. */
  const prefix = useMemo(() => {
    const p = new Float64Array(count + 1);
    for (let i = 0; i < count; i += 1) {
      p[i + 1] = p[i]! + (heights.current.get(i) ?? frozen.current.get(i) ?? mean);
    }
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, mean, samples]);

  const offsetOf = useCallback(
    (index: number): number => prefix[Math.max(0, Math.min(count, index))] ?? 0,
    [prefix, count],
  );

  const height = viewport > 0 ? viewport : FALLBACK_VIEWPORT_PX;
  /** The last index that starts at or before `px` — the row under that line of the scroller. */
  const indexAt = (px: number): number => {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (prefix[mid]! <= px) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const windowed = count > (stamped === false ? FULL_RANGE_MAX_ROWS : MEASURED_FULL_RANGE_MAX_ROWS);
  const visibleStart = Math.max(0, Math.min(count, indexAt(scrollTop) - overscan));
  const visibleEnd = Math.min(count, indexAt(scrollTop + height) + 1 + overscan);
  const start = windowed ? Math.max(0, Math.min(count, indexAt(scrollTop) - overscan)) : 0;
  const end = windowed ? Math.min(count, indexAt(scrollTop + height) + 1 + overscan) : count;
  const padTop = windowed ? (prefix[start] ?? 0) : 0;

  /**
   * MEASURE WHAT IS ON SCREEN, BY INDEX. `useLayoutEffect` so corrected spacers are in place
   * before paint. Keying on the item's own `data-index` is what breaks the cycle the single
   * measurement had: a height read here can never depend on the `start` it feeds, so two rows
   * differing by a pixel cannot make it oscillate (that was "Maximum update depth exceeded" and
   * Next's error page, reported live from Receipts). A row that grows later is re-measured on
   * the next pass and the sums follow it.
   */
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let moved = false;
    let found = false;
    for (const node of el.querySelectorAll<HTMLElement>("[data-index]")) {
      const i = Number(node.dataset.index);
      if (!Number.isInteger(i) || i < 0 || i >= count) continue;
      found = true;
      const h = node.offsetHeight;
      if (h <= 0) continue;
      const was = heights.current.get(i);
      if (was === undefined || Math.abs(was - h) >= 1) {
        heights.current.set(i, h);
        frozen.current.delete(i);
        moved = true;
      }
    }
    if (moved) setSamples((n) => n + 1);
    /* THE FLOOR, decided once and before paint: a list that drew items and stamped none is priced
       at one height, so it goes back to rendering whole below FULL_RANGE_MAX_ROWS. */
    if (stamped === null && count > 0) setStamped(found);
    /* ONE ANCHOR. A measured list is anchored below (`scrollTop` follows the item under the top
       edge); the browser's own scroll anchoring on top of it corrects the same move twice — a
       row growing above the viewport moved the rows on screen by its growth, the other way. */
    if (found && el.style.overflowAnchor !== "none") el.style.overflowAnchor = "none";

    if (heights.current.size === 0) {
      /* The pre-cache fallback, for a list that stamps no index: one row's height, taken only at
         the top where the leading row's identity does not depend on the height it produces. */
      const row = el.querySelector<HTMLElement>(".row");
      const rh = row?.offsetHeight ?? 0;
      if (rh > 0 && Math.abs(rh - measured) >= 1 && (measured === 0 || start === 0)) setMeasured(rh);
      return;
    }

    /* FREEZE what this commit reserved above the slice: the same `mean` the prefix priced it at,
       so the sums do not move, and the next mean cannot reach these indices. */
    for (let i = frozenUpTo.current; i < start; i += 1) {
      if (!heights.current.has(i) && !frozen.current.has(i)) frozen.current.set(i, mean);
    }
    if (start > frozenUpTo.current) frozenUpTo.current = start;

    /* COMPENSATE. Where the DOM has item `i` of the slice: the spacer, then the drawn heights
       before it — measured this commit, so this is the true position, not the render's prefix.
       If the item that was under the top edge moved, `scrollTop` follows it by the same delta,
       and the slice is re-derived from the moved position in the same synchronous re-render. */
    const priced = (i: number): number => heights.current.get(i) ?? frozen.current.get(i) ?? mean;
    const drawnOffset = (i: number): number => {
      let y = padTop;
      for (let j = start; j < i; j += 1) y += priced(j);
      return y;
    };
    const a = anchor.current;
    if (a && a.count === count && a.index >= start && a.index < end) {
      const delta = drawnOffset(a.index) - a.offset;
      if (Math.abs(delta) >= 0.5) {
        el.scrollTop += delta;
        setScrollTop(el.scrollTop);
      }
    }
    let idx = start;
    let off = padTop;
    while (idx + 1 < end && off + priced(idx) <= el.scrollTop) {
      off += priced(idx);
      idx += 1;
    }
    anchor.current = { index: idx, offset: off, count };
  });

  if (!windowed) {
    return { start: 0, end: count, padTop: 0, padBottom: 0, rowHeight: mean, offsetOf, visibleStart, visibleEnd };
  }

  return {
    start,
    end,
    padTop,
    padBottom: Math.max(0, (prefix[count] ?? 0) - (prefix[end] ?? 0)),
    rowHeight: mean,
    offsetOf,
    visibleStart,
    visibleEnd,
  };
}
