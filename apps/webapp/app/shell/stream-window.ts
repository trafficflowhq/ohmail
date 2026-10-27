"use client";

/**
 * A sliding window over a reading stream — only the cards near the viewport exist in the DOM. The
 * growing prefix it replaces never unmounted: every mounted card was walked per animation frame,
 * every growth commit re-rendered a larger run, and the heap kept every card ever approached —
 * measured in real Chromium over a pile tens of thousands deep: thousands of mounted cards,
 * hundreds of megabytes, the main thread blocked for minutes, and a deep `ensure` jump mounted
 * everything above its target in one commit. The window makes the mounted set a function of the
 * VIEWPORT: a lookahead below, a lookbehind above, two spacers reserving the rest, mounted count
 * bounded ({@link STREAM_WINDOW_MAX}) wherever the reader is.
 */

/**
 * Heights are measured per card, not assumed: stream cards are variable-height, so every mounted
 * card's height is cached BY MESSAGE ID after each render; an unmeasured card contributes
 * {@link STREAM_CARD_ESTIMATE_PX} — the outer-height twin of the `contain-intrinsic-size` fallback
 * (`StreamCard` writes `--sc-est` per card, so a laid-out card reserves its own estimate; this
 * constant twins what a card reserves when nothing wrote the property). The spacers are sums over
 * that cache, truer the more of the pile the reader has passed; `StreamShell`'s anchoring loop
 * absorbs the drift.
 */

/**
 * `ensure` is still the jump seam — but a jump now costs a window, not a prefix: it repositions the
 * window around the target in one bounded commit, and until the caller's scroll lands the window is
 * PINNED, so a wheel event between commit and landing cannot snap it back and unmount the target
 * mid-jump. `\Seen` honesty under a window: the observers can only mark a mounted card, and the
 * window keeps a card mounted for exactly the span an honest scroll can have displayed it — a fling
 * fast enough to hop the window also hops an IntersectionObserver, and the anchored leave-commit
 * remains the reliability floor. jsdom: no layout, so the window rests at its opening slice and
 * jumps drive through `ensure` exactly as in a browser.
 */
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { cssRect, cssViewport } from "@ohmail/ui";
import { afterPaint } from "./visit";

/** A never-measured card's OUTER height — `contain-intrinsic-size`'s 200px box guess plus the
 *  card's standing 20px bottom margin, matching what the measured cache stores. */
export const STREAM_CARD_ESTIMATE_PX = 220;

/** The opening window where no height is known at all (a server render). */
export const STREAM_MOUNT_FALLBACK = 8;

/**
 * THE OPENING WINDOW IS ONE SCREEN, sized by the column it fills: the cards a column this tall can
 * show at the never-measured estimate, plus two. It was sixty cards — several viewports, every one
 * mounted (and its viewer built) in the commit that answered the press, most of a second on a large
 * mirror. The lookahead below the fold is grown AFTER the first paint (see `useStreamWindow`).
 */
export function openingCount(columnPx: number): number {
  return columnPx > 0 ? Math.ceil(columnPx / STREAM_CARD_ESTIMATE_PX) + 2 : STREAM_MOUNT_FALLBACK;
}

/** Before the stream has layout, the window's own height stands in for the column: no layout read.
 *  In CSS px, as the column's `clientHeight` is, so a Text size zoom does not over-count. */
function windowColumnPx(): number {
  return typeof window === "undefined" ? 0 : cssViewport(window).height || 0;
}

/** The mounted window may never exceed this many cards, wherever the reader scrolls. */
export const STREAM_WINDOW_MAX = 120;

/** Mounted run kept below the fold, as viewports. */
const LOOKAHEAD_VIEWPORTS = 2;

/** …and above the top of the scrollport, for a cheap return scroll. */
const LOOKBEHIND_VIEWPORTS = 1;

/** A derived edge may drift this many cards before the mounted range is re-committed. */
const SHED_SLACK_CARDS = 24;

/** Cards one step of the post-paint growth adds: a commit of the whole lookahead held a frame. */
const GROW_STEP_CARDS = 6;

/** How long a jump's pin outlives its commit when no landing scroll ever arrives. */
const PIN_MS = 1000;

/**
 * A move of more than this many viewports between two samples is a FLIGHT — End, Home, a fast
 * drag of the scrollbar — and the window holds still until it lands. Committing on every frame of
 * WebKit's own End animation (10–14 frames) unmounted and mounted the cards and their framed
 * letters a dozen times while that animation ran, and the desktop's web process crashed there.
 */
const FLIGHT_VIEWPORTS = 1;

/** Painted frames with no scroll event that end a flight. */
const FLIGHT_REST_FRAMES = 2;

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
  /** Back to the opening slice at the top — a visit's end (`visit.ts`). */
  reset: () => void;
  /** How many cards the opening slice holds. */
  opening: number;
  /** Is the stream in a flight (see {@link FLIGHT_VIEWPORTS})? Stable; reads a ref. */
  inFlight: () => boolean;
}

interface Range {
  start: number;
  end: number;
}

export function useStreamWindow({
  ids,
  getRoot,
  armed = true,
}: {
  /** The stream's card order, top to bottom — message ids, the height cache's key. */
  ids: readonly string[];
  /** The stream's own scroll container — `StreamHandle.element()`. Read lazily: the handle is
   *  bound during the same commit that mounts the cards, before any effect here runs. */
  getRoot: () => HTMLElement | null;
  /** Are the cards drawn yet? The lookahead grows only after the opening slice has painted. */
  armed?: boolean;
}): StreamWindow {
  const total = ids.length;
  const [opening, setOpening] = useState(() => openingCount(windowColumnPx()));
  const openingRef = useRef(opening);
  openingRef.current = opening;
  const [range, setRange] = useState<Range>(() => ({ start: 0, end: Math.min(total, opening) }));
  const heights = useRef<Map<string, number>>(new Map());
  /** A jump's protection — see the header. Cleared by the sampler once scroll reaches it. */
  const pin = useRef<{ index: number; until: number } | null>(null);
  /** The flight in progress, if any: the last sampled offset, whether a scroll event came since
   *  the watcher's last frame, how many frames went without one, and the watcher's frame. */
  const flight = useRef({ on: false, lastTop: null as number | null, heard: false, still: 0, raf: 0 });
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
   * MEASURE THE MOUNTED CARDS — the cache the spacers are built from — with ONE ResizeObserver.
   * It was an effect with no dependency list that read every mounted card's `offsetHeight` and
   * computed style after every render: a forced layout per render of the view, the switch's own
   * commit included. The observer reports what layout already decided, after layout, and only for
   * a card whose size changed (expanded, hydrated). jsdom has none: the estimates stand.
   *
   * The OUTER height — box plus vertical margins. `.scast` carries a 20px bottom margin
   * (stream.css), and the box alone understated every unmounted card by it, so a window commit
   * that shed two dozen cards into the top spacer shrank the content above the viewport by ~480px
   * in one commit. Chromium's scroll anchoring papered over that; WebKit (the desktop's webview)
   * has none, and the stream visibly jumped under the reader on every shed. The margins are the
   * stylesheet's, one value for the stream, read once. Layout is judged on the BOX alone: a card
   * with no box (detached, `display: none`) is not cached, or the spacers would collapse by the
   * difference — the very jump this outer-height cache exists to remove. A card `content-visibility`
   * skips reports the size `contain-intrinsic-size: auto` remembers for it, which is what a cached
   * height is for.
   */
  const roRef = useRef<ResizeObserver | null>(null);
  const observed = useRef<Set<Element>>(new Set());
  const marginPx = useRef<number | null>(null);
  useEffect(() => {
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver((entries) => {
      for (const en of entries) {
        const c = en.target as HTMLElement;
        const sid = c.dataset.sid;
        const box = en.borderBoxSize?.[0]?.blockSize ?? c.offsetHeight;
        if (!sid || !(box > 0)) continue;
        if (marginPx.current === null) {
          const cs = getComputedStyle(c);
          marginPx.current = (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
        }
        heights.current.set(sid, box + marginPx.current);
      }
    });
    roRef.current = ro;
    return () => {
      ro.disconnect();
      roRef.current = null;
      observed.current = new Set();
    };
  }, []);
  /* Which cards the observer watches follows the mounted set: a walk of the DOM, no layout read. */
  useEffect(() => {
    const el = getRoot();
    const ro = roRef.current;
    if (!el || !ro) return;
    const now = new Set<Element>(el.querySelectorAll(".scast[data-sid]"));
    for (const c of observed.current) if (!now.has(c)) ro.unobserve(c);
    for (const c of now) if (!observed.current.has(c)) ro.observe(c);
    observed.current = now;
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
    const fl = flight.current;
    /* The flight ends after FLIGHT_REST_FRAMES painted frames without a scroll event, and the
       window is committed once, where the scroll stopped. */
    const watch = () => {
      fl.raf = requestAnimationFrame(() => {
        fl.raf = 0;
        if (!fl.on) return;
        if (fl.heard) {
          fl.heard = false;
          fl.still = 0;
        } else fl.still += 1;
        if (fl.still < FLIGHT_REST_FRAMES) return watch();
        fl.on = false;
        sample();
      });
    };
    /** Answers whether a stepped growth (`later`) has more to add. */
    const sample = (later = false): boolean => {
      const order = idsRef.current;
      const n = order.length;
      if (n === 0) return false;
      const viewport = el.clientHeight;
      if (viewport <= 0) return false; // not laid out (and jsdom): rest at the opening window
      const scrollTop = el.scrollTop;
      const moved = fl.lastTop === null ? 0 : Math.abs(scrollTop - fl.lastTop);
      fl.lastTop = scrollTop;
      // A pinned jump's landing is the app's own scroll, never a flight.
      if (!fl.on && !pin.current && moved > viewport * FLIGHT_VIEWPORTS && typeof requestAnimationFrame === "function") {
        fl.on = true;
        fl.heard = false;
        fl.still = 0;
        if (!fl.raf) watch();
      }
      if (fl.on) return false;
      /** The non-card head above the first card (title row, hints): first card's offset minus
       *  the top spacer standing over it. Zero when nothing is mounted or laid out. */
      const first = el.querySelector<HTMLElement>(".scast[data-sid]");
      let headPx = 0;
      if (first) {
        const cur = rangeRef.current;
        let padTop = 0;
        for (let i = 0; i < cur.start && i < n; i++) padTop += heightOf(order[i]!);
        // CSS px, the units of `scrollTop` (`ui-zoom.ts` in @ohmail/ui).
        const rel = cssRect(first).top - cssRect(el).top + scrollTop;
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
        else return false;
      }
      const needs =
        desired.start < cur.start ||
        desired.end > cur.end ||
        cur.start + SHED_SLACK_CARDS < desired.start ||
        cur.end - SHED_SLACK_CARDS > desired.end;
      if (needs) {
        // Slack on both edges so the very next scroll pixel does not re-commit.
        let next = clamp(desired.start - Math.floor(SHED_SLACK_CARDS / 2), desired.end + Math.floor(SHED_SLACK_CARDS / 2));
        if (!later) {
          setRange(next);
          return false;
        }
        // The growth after a paint lands a few cards per commit, never the whole lookahead.
        const more = next.end > cur.end + GROW_STEP_CARDS && next.start <= cur.end;
        if (more) next = clamp(next.start, cur.end + GROW_STEP_CARDS);
        startTransition(() => setRange(next));
        return more;
      }
      return false;
    };
    growRef.current = () => {
      const column = el.clientHeight;
      if (column > 0 && openingCount(column) !== openingRef.current) setOpening(openingCount(column));
      growMore.current = sample(true);
    };
    let frame = 0;
    const onScroll = () => {
      fl.heard = true;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sample();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    if (fl.on && !fl.raf) watch();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (fl.raf) cancelAnimationFrame(fl.raf);
      fl.raf = 0;
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      growRef.current = null;
    };
    // `getRoot` is a render-scope closure; the element it returns is stable for the life of
    // the mounted stream, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  /**
   * THE LOOKAHEAD ARRIVES AFTER THE FIRST PAINT. The entry commit mounts the opening slice only;
   * once it is on screen, the sampler derives the full window (two viewports below, one above)
   * and commits it as a TRANSITION — a render React may interrupt, and that a press elsewhere
   * abandons. The column's real height replaces the window's stand-in on the same step. A pile
   * shown again runs this again (its effects are the visit's), from the slice its last visit left.
   * A view that draws its cards a frame late (`armed`) grows after the frame that drew them, so the
   * opening slice and the lookahead never land in one commit.
   */
  const growRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (total === 0 || !armed || typeof requestAnimationFrame !== "function") return;
    // A timer from the frame's own callback runs after that frame's paint.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => growRef.current?.(), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
    };
  }, [total, armed]);

  /* The next step of a stepped growth, once the frame that drew the last one has painted. */
  const growMore = useRef(false);
  const growNext = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!growMore.current || growNext.current) return;
    let ran = false;
    const cancel = afterPaint(getRoot(), () => {
      ran = true;
      growNext.current = null;
      growRef.current?.();
    });
    if (!ran) growNext.current = cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);
  useEffect(
    () => () => {
      growNext.current?.();
      growNext.current = null;
      growMore.current = false;
    },
    [],
  );

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
  if (total > 0 && eff.start === 0 && eff.end < Math.min(total, opening)) {
    eff = { start: 0, end: Math.min(total, opening) };
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
      end: Math.min(n, Math.max(start + openingRef.current, index + 9)),
    };
    pin.current = { index, until: Date.now() + PIN_MS };
    setRange(next);
  }, []);

  const reset = useCallback(() => {
    pin.current = null;
    const fl = flight.current;
    fl.on = false;
    fl.lastTop = null;
    if (fl.raf) cancelAnimationFrame(fl.raf);
    fl.raf = 0;
    setRange({ start: 0, end: Math.min(idsRef.current.length, openingRef.current) });
  }, []);

  const inFlight = useCallback(() => flight.current.on, []);

  let padTopPx = 0;
  for (let i = 0; i < eff.start; i++) padTopPx += heightOf(ids[i]!);
  let padBottomPx = 0;
  for (let i = eff.end; i < total; i++) padBottomPx += heightOf(ids[i]!);

  return { start: eff.start, end: eff.end, padTopPx, padBottomPx, ensure, reset, opening, inFlight };
}
