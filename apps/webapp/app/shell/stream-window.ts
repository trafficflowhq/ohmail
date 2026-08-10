"use client";

/**
 * A MOUNTED OPENING RUN OVER A READING STREAM — the stream's half of what `list-window.ts` did
 * for the list columns.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 *
 * Reads and Receipts render a card per message beside their windowed list, and the stream
 * mounted ALL of them on every visit. `content-visibility` (app.css) makes the off-screen cards
 * cheap to lay out and paint, and `StreamCardMemo` makes them cheap to RE-render — but neither
 * touches the FIRST render: switching into the view still built one React subtree and one DOM
 * subtree per message in the pile, on the main thread, before anything painted. Measured in a
 * browser against this exact component with the pile two thousand deep: 1.6–1.8 s of blocked
 * main thread per switch, every visit — and that is a fast machine's number; a slower one pays
 * a multiple of it. The pile is the one term that grows with the mailbox, so this was the
 * dominant cost of clicking between rail views.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────────────────────
 *
 * The stream mounts an OPENING RUN of cards — enough to fill several viewports — and reserves
 * estimated height for the rest, so the scrollbar still says how much mail there is. The run
 * GROWS toward the reader: a sentinel sits under the last mounted card, and a scroll that
 * brings it within a few viewports — or leaves it behind entirely — mounts another batch.
 * Nothing ever unmounts; the run only extends.
 *
 * ── WHY A GROWING PREFIX AND NOT A SLIDING WINDOW ───────────────────────────────────────────
 *
 * The stream's cards are variable-height (a snippet clamps short, a hydrated body runs to
 * 348px), so the fixed-row-height arithmetic of `useListWindow` does not fit — that has been
 * true since the list columns were windowed, and it is why the stream was left whole. The other
 * half of that old argument was `\Seen`: the scroll-coupled observers cannot fire for a card
 * that is not in the DOM. A prefix that never unmounts keeps that property for every card it
 * matters for — a card that has ever been within the lookahead of the viewport stays mounted —
 * while a card the reader has never approached cannot be marked seen by an honest scroll in the
 * first place. Nothing observable is lost; only work for mail nobody reached is deferred.
 *
 * ── `ensure` IS THE JUMP SEAM ───────────────────────────────────────────────────────────────
 *
 * A list-row click and a cross-view jump land on an arbitrary card (`scrollTo(id)`), which may
 * be beyond the run. `ensure(index)` extends the run through that index in one commit, and the
 * caller scrolls AFTER the commit (an effect, not the click handler), so the target exists by
 * the time it is looked up. A deep jump therefore mounts everything above its target — the cost
 * the old whole-pile mount paid on every switch, paid here once, only on the visit that
 * actually jumps deep, and only up to the depth jumped to. The prefix stays a prefix, so the
 * scroll-spy's "walk the cards top to bottom" geometry never sees a hole.
 *
 * ── WHY GROWTH IS A SCROLL LISTENER AND NOT AN IntersectionObserver ─────────────────────────
 *
 * An observer was the first cut, and it failed live in both directions. It reports TRANSITIONS,
 * and a fast scroll — a wheel fling, a scrollbar drag — moves the sentinel from "below the
 * lookahead" to "above the scrollport" between two evaluation frames: no intersecting state was
 * ever observed, so no callback, and the reader parks over the reserved tail with growth
 * stalled. And once parked there, re-armed observations in a busy tab were delivered at whole-
 * second intervals, so even the recovery crawled (measured: the run stalled a few batches in
 * with the reader at the bottom of the pile). A scroll listener reads the same geometry
 * deterministically, is
 * rAF-coalesced exactly like `StreamShell`'s scroll-spy and `list-window`'s sampler, and the
 * effect re-runs after each growth commit so a reader parked deep keeps mounting batches until
 * the run reaches them — no event needed for the follow-up, the re-run IS the follow-up.
 *
 * jsdom has no layout (`getBoundingClientRect` is all zeros, `clientHeight` is 0), so under it
 * the distance check never trips and the run stays at its opening size — which is what the
 * mount-cost guards assert. The growth guards drive the same check through stubbed geometry,
 * and `ensure` is driven by the jump guards.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The opening run: several viewports of collapsed cards, mounted before first paint.
 *
 * Sized so the switch stays well under the paint budget (60 cards measured at ~30–90 ms against
 * the real component) while a reader who starts scrolling immediately still has screens of real
 * cards ahead of the first growth commit.
 */
export const STREAM_MOUNT_INITIAL = 60;

/** Cards mounted per growth step once the reader nears the end of the run. */
export const STREAM_MOUNT_BATCH = 120;

/**
 * The reserved height standing in for one unmounted card, for the tail spacer.
 *
 * The same kind of guess `contain-intrinsic-size: auto 200px` makes for a mounted card that has
 * not been laid out yet, erring low rather than high: a collapsed snippet card is the common
 * case. The spacer only has to keep the scrollbar saying "there is more" — the estimate is
 * replaced by real cards a batch at a time as the reader approaches.
 */
export const STREAM_TAIL_ESTIMATE_PX = 140;

/** Grow while the sentinel is within this many viewports below the fold (or anywhere above). */
const LOOKAHEAD_VIEWPORTS = 3;

export interface StreamWindow {
  /** How many cards to mount, from the top. Never shrinks while the view is mounted. */
  count: number;
  /** Reserved height (px) standing in for the unmounted tail. 0 once everything is mounted. */
  tailPx: number;
  /** Extend the run through `index` (plus headroom), for a jump to an arbitrary card. */
  ensure: (index: number) => void;
  /** Ref for the growth sentinel the caller renders just after the last mounted card. */
  sentinelRef: (el: HTMLElement | null) => void;
}

export function useStreamWindow({
  total,
  getRoot,
}: {
  /** How many cards the stream holds in all. */
  total: number;
  /** The stream's own scroll container — `StreamHandle.element()`. Read lazily: the handle is
   *  bound during the same commit that mounts the cards, before any effect here runs. */
  getRoot: () => HTMLElement | null;
}): StreamWindow {
  const [cap, setCap] = useState(STREAM_MOUNT_INITIAL);
  const count = Math.min(total, cap);
  const sentinelEl = useRef<HTMLElement | null>(null);

  const ensure = useCallback((index: number) => {
    if (index < 0) return;
    // Headroom past the target so the landing card has neighbours below it, not a spacer edge.
    setCap((c) => Math.max(c, index + 1 + 12));
  }, []);

  const sentinelRef = useCallback((el: HTMLElement | null) => {
    sentinelEl.current = el;
  }, []);

  /**
   * Growth. One rAF-coalesced scroll listener plus one check per growth commit — the effect is
   * keyed on the run length, so each batch that mounts re-runs it, re-checks, and mounts the
   * next batch if the reader is still at or past the lookahead. Keyed on `count` rather than
   * `cap` so a pile shorter than the run does not re-arm on `ensure` calls that changed nothing.
   */
  useEffect(() => {
    if (count >= total) return;
    const el = getRoot();
    if (!el) return;
    const check = () => {
      const s = sentinelEl.current;
      if (!s) return;
      const viewport = el.clientHeight;
      if (viewport <= 0) return; // not laid out (and jsdom, which never is)
      // The sentinel's offset below the top of the scrollport — layout the browser has already
      // done; reading it here forces nothing.
      const below = s.getBoundingClientRect().top - el.getBoundingClientRect().top;
      // Within the lookahead below the fold — or already scrolled past (above the scrollport,
      // i.e. the reader is parked over the reserved tail). Both mean "mount more".
      if (below < viewport * LOOKAHEAD_VIEWPORTS) {
        setCap((c) => Math.min(total, c + STREAM_MOUNT_BATCH));
      }
    };
    // The post-commit check: catches a reader already past the run with no further scroll event
    // coming — this is what keeps batches flowing while they are parked deep in the tail.
    // `frame` must go back to 0 when it fires, or the spent id would make every later scroll
    // return early and growth would never fire again.
    let frame = requestAnimationFrame(() => {
      frame = 0;
      check();
    });
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        check();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
    };
    // `getRoot` is a render-scope closure; the element it returns is stable for the life of the
    // mounted stream, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, total]);

  return {
    count,
    tailPx: Math.max(0, total - count) * STREAM_TAIL_ESTIMATE_PX,
    ensure,
    sentinelRef,
  };
}
