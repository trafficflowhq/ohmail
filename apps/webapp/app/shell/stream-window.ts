"use client";

/**
 * A SLIDING WINDOW OVER A READING STREAM — only the cards near the viewport exist in the DOM.
 *
 * ── WHY THE GROWING PREFIX THIS REPLACES HAD TO GO ──────────────────────────────────────────
 *
 * The previous model mounted an opening run and only ever GREW it toward the reader; nothing
 * ever unmounted. That fixed the switch (a visit no longer mounted the pile before first
 * paint) and re-created the same cost one gesture later: scroll depth became a permanent tax.
 * Every mounted card is walked by the scroll-spy and the leave-range tracker once per animation
 * frame (`getBoundingClientRect` each), every growth commit re-rendered a larger run, and the
 * heap kept every card ever approached. Measured in real Chromium over a generated pile tens
 * of thousands deep: a deep scroll held thousands of mounted cards and hundreds of megabytes
 * of heap, with the main thread blocked for minutes — and a deep jump (`ensure`) mounted
 * everything above its target in ONE commit, which on throttled hardware never finished inside
 * the measurement's budget. Scrolled to the end, the whole pile was in the DOM; on a real
 * mailbox that is the freeze this file's history keeps re-measuring. (The harness and its
 * numbers live outside this file.)
 *
 * The window makes the mounted set a function of the VIEWPORT, not of where the reader has
 * been: cards within a lookahead below and a lookbehind above stay mounted, cards left behind
 * unmount, and two spacers reserve the height of everything else so the scrollbar still says
 * how much mail there is. Mounted count is bounded ({@link STREAM_WINDOW_MAX}) whatever the
 * pile holds and wherever the reader is in it.
 *
 * ── HEIGHTS ARE MEASURED PER CARD, NOT ASSUMED ──────────────────────────────────────────────
 *
 * Stream cards are variable-height (a clamped snippet, an expanded reading, a hydrated html
 * body), so unlike `list-window.ts` one measurement cannot stand for all of them. Every
 * mounted card's height is read after each render and cached BY MESSAGE ID; a card that has
 * never been laid out contributes {@link STREAM_CARD_ESTIMATE_PX} — the same guess
 * `contain-intrinsic-size: auto 200px` makes for a mounted card the browser has not rendered.
 * The spacers are sums over that cache, so they get truer the more of the pile the reader has
 * actually passed, and `StreamShell`'s anchoring loop (which corrects a landing against the
 * REAL geometry over several frames) absorbs the drift the estimates leave.
 *
 * ── `ensure` IS STILL THE JUMP SEAM — BUT A JUMP NOW COSTS A WINDOW, NOT A PREFIX ───────────
 *
 * A row click or a cross-view jump lands on an arbitrary card. `ensure(index)` REPOSITIONS the
 * window around that index in one bounded commit; the caller scrolls after the commit exactly
 * as before. The scroll that follows lands inside the repositioned window, so the sampler's
 * next pass derives the same neighbourhood and nothing thrashes. Until that scroll arrives the
 * window is PINNED — a wheel event delivered between the commit and the landing must not let
 * the sampler snap the window back to the old scroll position and unmount the target mid-jump.
 *
 * ── WHAT `\Seen` HONESTY MEANS UNDER A WINDOW ───────────────────────────────────────────────
 *
 * The scroll-coupled observers can only mark a card that is in the DOM, and the window keeps a
 * card mounted for as long as it is anywhere near the viewport — which is exactly the span in
 * which an honest scroll can have displayed it. A fling fast enough to hop the window past a
 * card without mounting it is the same fling that hops an IntersectionObserver's transition
 * (the growth model documented that miss too); the anchored leave-commit remains the
 * reliability floor under both. Nothing is newly markable and nothing displayed goes unmarked
 * that was marked before.
 *
 * ── jsdom ───────────────────────────────────────────────────────────────────────────────────
 *
 * No layout: `clientHeight` is 0 and no scroll events fire, so the sampler never derives and
 * the window rests at its opening slice `[0, STREAM_MOUNT_INITIAL)` — which is what the
 * mount-cost guards assert — and jumps are driven through `ensure` exactly as in a browser.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** The opening window: several viewports of collapsed cards, mounted before first paint. */
export const STREAM_MOUNT_INITIAL = 60;

/** A never-measured card's height — `contain-intrinsic-size`'s own guess, kept in step. */
export const STREAM_CARD_ESTIMATE_PX = 200;

/** The mounted window may never exceed this many cards, wherever the reader scrolls. */
export const STREAM_WINDOW_MAX = 120;

/** Mounted run kept below the fold, as viewports. */
const LOOKAHEAD_VIEWPORTS = 2;

/** …and above the top of the scrollport, for a cheap return scroll. */
const LOOKBEHIND_VIEWPORTS = 1;

/** A derived edge may drift this many cards before the mounted range is re-committed. */
const SHED_SLACK_CARDS = 24;

/** How long a jump's pin outlives its commit when no landing scroll ever arrives. */
const PIN_MS = 1000;

export interface StreamWindow {
  /** First mounted index into the caller's card order, inclusive. */
  start: number;
  /** Last mounted index, exclusive. */
  end: number;
  /** Reserved height above the mounted slice. */
  padTopPx: number;
  /** Reserved height below it. 0 once the window reaches the end. */
  padBottomPx: number;
  /** Reposition the window around `index` — the jump seam. A no-op inside the window. */
  ensure: (index: number) => void;
}

interface Range {
  start: number;
  end: number;
}

export function useStreamWindow({
  ids,
  getRoot,
}: {
  /** The stream's card order, top to bottom — message ids, the height cache's key. */
  ids: readonly string[];
  /** The stream's own scroll container — `StreamHandle.element()`. Read lazily: the handle is
   *  bound during the same commit that mounts the cards, before any effect here runs. */
  getRoot: () => HTMLElement | null;
}): StreamWindow {
  const total = ids.length;
  const [range, setRange] = useState<Range>({ start: 0, end: Math.min(total, STREAM_MOUNT_INITIAL) });
  const heights = useRef<Map<string, number>>(new Map());
  /** A jump's protection — see the header. Cleared by the sampler once scroll reaches it. */
  const pin = useRef<{ index: number; until: number } | null>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  /** Kept in step with the RENDERED (clamped) range at the bottom of every render. */
  const rangeRef = useRef(range);

  const heightOf = (id: string): number => heights.current.get(id) ?? STREAM_CARD_ESTIMATE_PX;

  /** Clamp a desired range into the pile and the mounted-count cap. */
  const clamp = (start: number, end: number): Range => {
    const s = Math.max(0, Math.min(start, Math.max(0, total - 1)));
    const e = Math.max(s + 1, Math.min(end, total));
    return e - s > STREAM_WINDOW_MAX ? { start: s, end: s + STREAM_WINDOW_MAX } : { start: s, end: e };
  };

  /**
   * MEASURE THE MOUNTED CARDS after every render — the cache the spacers are built from.
   * Bounded by the window size; `offsetHeight` is layout the browser has already done. A card
   * whose height changed (expanded, hydrated) simply overwrites its entry while mounted.
   */
  useEffect(() => {
    const el = getRoot();
    if (!el) return;
    for (const c of el.querySelectorAll<HTMLElement>(".scast[data-sid]")) {
      const h = c.offsetHeight;
      if (h > 0) heights.current.set(c.dataset.sid!, h);
    }
    // A render-scope closure; the element is stable for the mounted stream's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  /**
   * THE SAMPLER — one rAF-coalesced scroll/resize listener deriving the window from geometry.
   *
   * The derived range is committed only when it ESCAPES the mounted one (cards needed that are
   * not mounted) or leaves more than {@link SHED_SLACK_CARDS} behind an edge — so an ordinary
   * scroll inside the window costs no React commit at all, and the mounted set changes a few
   * times per viewport, not per frame.
   */
  useEffect(() => {
    const el = getRoot();
    if (!el) return;
    const sample = () => {
      const order = idsRef.current;
      const n = order.length;
      if (n === 0) return;
      const viewport = el.clientHeight;
      if (viewport <= 0) return; // not laid out (and jsdom): rest at the opening window
      const scrollTop = el.scrollTop;
      /** The non-card head above the first card (title row, hints): first card's offset minus
       *  the top spacer standing over it. Zero when nothing is mounted or laid out. */
      const first = el.querySelector<HTMLElement>(".scast[data-sid]");
      let headPx = 0;
      if (first) {
        const cur = rangeRef.current;
        let padTop = 0;
        for (let i = 0; i < cur.start && i < n; i++) padTop += heightOf(order[i]!);
        const rel = first.getBoundingClientRect().top - el.getBoundingClientRect().top + scrollTop;
        headPx = Math.max(0, rel - padTop);
      }
      const above = scrollTop - headPx - viewport * LOOKBEHIND_VIEWPORTS;
      const below = scrollTop - headPx + viewport * (1 + LOOKAHEAD_VIEWPORTS);
      let y = 0;
      let start = 0;
      let end = n;
      let startFound = false;
      for (let i = 0; i < n; i++) {
        const h = heightOf(order[i]!);
        if (!startFound && y + h > above) {
          start = i;
          startFound = true;
        }
        if (y > below) {
          end = i;
          break;
        }
        y += h;
      }
      if (!startFound) start = Math.max(0, n - 1);
      const desired = clamp(start, Math.max(end, start + 1));
      const cur = rangeRef.current;
      const p = pin.current;
      if (p) {
        // The jump's window holds until the landing scroll reaches it (the derived window
        // contains the pinned index) or the pin expires — see the header.
        if (desired.start <= p.index && p.index < desired.end) pin.current = null;
        else if (Date.now() > p.until) pin.current = null;
        else return;
      }
      const needs =
        desired.start < cur.start ||
        desired.end > cur.end ||
        cur.start + SHED_SLACK_CARDS < desired.start ||
        cur.end - SHED_SLACK_CARDS > desired.end;
      if (needs) {
        // Slack on both edges so the very next scroll pixel does not re-commit.
        setRange(clamp(desired.start - Math.floor(SHED_SLACK_CARDS / 2), desired.end + Math.floor(SHED_SLACK_CARDS / 2)));
      }
    };
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
    // `getRoot` is a render-scope closure; the element it returns is stable for the life of
    // the mounted stream, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  /** A pile that shrank under the window (deltas, a filter) must not leave indices dangling:
   *  the RENDERED range is the stored one re-clamped against today's pile, every render. */
  let eff = total === 0 ? { start: 0, end: 0 } : clamp(range.start, range.end);
  /**
   * THE OPENING WINDOW FOLLOWS A GROWING PILE. A view mounted MID-DRAIN sees a pile of a few
   * rows and stores a window to match; the rows that land afterwards must widen the resting
   * slice back to the opening size WITHOUT waiting for a scroll — there may never be one, and
   * a window pinned at those first rows is a mailbox that looks two messages long. Applied
   * only while the window rests at the top: after the first slide the sampler owns the range,
   * and re-widening a deliberately-moved window would fight it.
   */
  if (total > 0 && eff.start === 0 && eff.end < Math.min(total, STREAM_MOUNT_INITIAL)) {
    eff = { start: 0, end: Math.min(total, STREAM_MOUNT_INITIAL) };
  }
  rangeRef.current = eff;

  const ensure = useCallback((index: number) => {
    if (index < 0) return;
    const n = idsRef.current.length;
    const cur = rangeRef.current;
    // Comfortably inside the mounted window (with landing headroom below): nothing to do —
    // the j/k step and the click on a neighbouring row stay commit-free.
    if (index >= cur.start + 2 && index < cur.end - 8) return;
    const start = Math.max(0, index - 8);
    const next = {
      start,
      end: Math.min(n, Math.max(start + STREAM_MOUNT_INITIAL, index + 9)),
    };
    pin.current = { index, until: Date.now() + PIN_MS };
    setRange(next);
  }, []);

  let padTopPx = 0;
  for (let i = 0; i < eff.start; i++) padTopPx += heightOf(ids[i]!);
  let padBottomPx = 0;
  for (let i = eff.end; i < total; i++) padBottomPx += heightOf(ids[i]!);

  return { start: eff.start, end: eff.end, padTopPx, padBottomPx, ensure };
}
