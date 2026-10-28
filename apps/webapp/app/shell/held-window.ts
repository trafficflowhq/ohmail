"use client";

/**
 * THE SELECTED SENDER'S HELD LETTERS ARE A WINDOW, beside `list-window.ts` and `stream-window.ts`.
 *
 * Entering Screened out or Spam selects the newest sender, often one with weeks of letters, and
 * the preview mounted every one of them in the click's own commit: a sanitize pass and a frame
 * per letter, an attachment list read per letter, every body asked for at once. The window mounts
 * the newest {@link HELD_OPENING} and adds {@link HELD_STEP} older ones as the reader scrolls up
 * toward them. No letter is ever replaced by a count: the older ones arrive above, in place, and
 * the counts and captions keep reading the whole bag.
 *
 * Three writers share the column's offset, and every one of them updates `anchoredAt` by what it
 * moved, so the column's own writes never read as the reader scrolling:
 *  · the anchor (`ScreenerView`) puts the newest letter at the top while the reader has not scrolled;
 *  · KEEP: a prepend moves the first previously mounted card down by what was inserted above it,
 *    and `scrollTop` follows by the same amount ({@link heldKeepTop});
 *  · HOLD: once the reader has scrolled, a card wholly above the port that changes height moves
 *    `scrollTop` by that change ({@link heldHoldShift}); before that, the anchor is re-run.
 * The browser's own scroll anchoring is off for the column (`app.css`), so it is not a fourth.
 */
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { cssRect } from "@ohmail/ui";

/** Letters mounted when a sender is opened: the newest ones. */
export const HELD_OPENING = 3;
/** Older letters added each time the reader nears the top of the mounted slice. */
export const HELD_STEP = 3;

/** Breathing room above the anchored message, so its own header is not flush with the column edge. */
export const HELD_ANCHOR_PAD_PX = 14;

/**
 * How far the read column may have drifted from where the column last put it and still count as
 * "the reader has not touched it". Two pixels, not zero: a browser reports a fractional, clamped
 * `scrollTop`, and an exact comparison would read the column's own write as the reader's scroll.
 */
export const ANCHOR_TOLERANCE_PX = 2;

/**
 * Where the read column must scroll to put the last held message at the top (held mail renders
 * oldest→newest; the decision is about the newest). All three terms are load-bearing: `lastTop -
 * readTop` is a viewport offset (alone it scrolls by a delta after the first selection); `+
 * scrollTop` converts it to a content offset — the term a plausible rewrite drops; `- pad`, clamped
 * at 0. Pure over numbers: jsdom reports every rect as zero. It re-anchors as bodies grow (a
 * derived row's body is a snippet on every selection; ~100px snippets hydrate to ~600px): the
 * caller remembers the position it last WROTE ({@link ANCHOR_TOLERANCE_PX}) and re-anchors only
 * while the scroller is still there (`test/screener-latest-anchor.test.tsx` models the growth).
 */
export function heldAnchorTop(
  readTop: number, lastTop: number, scrollTop: number, pad = HELD_ANCHOR_PAD_PX,
): number {
  return Math.max(0, lastTop - readTop + scrollTop - pad);
}

/** Whether the column still sits where it was last put: the reader has not scrolled it. */
export function heldAnchored(anchoredAt: number | null, scrollTop: number): boolean {
  return anchoredAt !== null && Math.abs(scrollTop - anchoredAt) <= ANCHOR_TOLERANCE_PX;
}

/**
 * KEEP: the offset that leaves the first previously mounted card where it was after older letters
 * were inserted above it. `before` and `after` are that card's offset from the port top.
 */
export function heldKeepTop(scrollTop: number, before: number, after: number): number {
  return Math.max(0, scrollTop + after - before);
}

/**
 * HOLD: how far the offset moves when mounted cards changed height after the reader scrolled. Only
 * a card that was wholly above the port counts: growth there pushes the letter being read down by
 * exactly that much. `bottom` is the card's bottom now; its bottom before is that less its own
 * change and every change above it in the same batch.
 */
export function heldHoldShift(
  portTop: number, changes: ReadonlyArray<{ bottom: number; delta: number }>,
): number {
  let above = 0;
  let shift = 0;
  for (const c of [...changes].sort((a, b) => a.bottom - b.bottom)) {
    above += c.delta;
    if (c.bottom - above <= portTop) shift += c.delta;
  }
  return shift;
}

/**
 * Whether to mount older letters: the top of the mounted slice (`sliceTop`, its offset from the
 * port top) is within one column height of the port, and the reader is scrolling toward it or the
 * column cannot scroll any higher. Before the reader scrolls, the anchor holds the newest letter
 * and nothing older is mounted unless the column has room for it.
 */
export function heldWantsMore(
  { sliceTop, port, scrollTop, scrolled }: { sliceTop: number; port: number; scrollTop: number; scrolled: boolean },
): boolean {
  if (!(port > 0)) return false;
  return sliceTop >= -port && (scrolled || scrollTop <= ANCHOR_TOLERANCE_PX);
}

/** Move the remembered anchor by what the column itself moved, so its write never reads as a scroll. */
function followAnchor(anchoredAt: MutableRefObject<number | null>, before: number, after: number): void {
  if (anchoredAt.current !== null) anchoredAt.current += after - before;
}

interface HeldWindowState {
  key: string;
  from: number;
  count: number;
  busy: boolean;
}

export function useHeldWindow({
  count,
  resetKey,
  read,
  anchoredAt,
  reanchor,
  ready = true,
}: {
  /** The selected sender's whole bag, oldest to newest. */
  count: number;
  /** `${segment}::${activeId}`: a new key opens on the newest letters. */
  resetKey: string;
  /** The read column — the scroller. */
  read: () => HTMLElement | null;
  /** Where the column was last put; shared with the anchor. */
  anchoredAt: MutableRefObject<number | null>;
  /** Put the newest letter at the top again (the anchor's own pass). */
  reanchor: () => void;
  /** False while the letters are drawn without their bodies: their heights say nothing yet. */
  ready?: boolean;
}): { from: number; busy: boolean } {
  const opening = Math.max(0, count - HELD_OPENING);
  const [win, setWin] = useState<HeldWindowState>({ key: resetKey, from: opening, count, busy: false });
  let cur = win;
  if (win.key !== resetKey || (win.count === 0 && count > 0)) {
    cur = { key: resetKey, from: opening, count, busy: false };
    setWin(cur);
  }
  // An appended letter stays mounted (it is past `from`); a bag that shrank keeps the opening slice.
  const from = Math.min(cur.from, opening);

  const live = useRef({ from, resetKey });
  live.current = { from, resetKey };
  // Committed, not rendered: the bodies arrive in a transition, whose render may yield before it commits.
  const drawn = useRef(ready);
  useLayoutEffect(() => { drawn.current = ready; }, [ready]);
  const readRef = useRef(read);
  readRef.current = read;
  const reanchorRef = useRef(reanchor);
  reanchorRef.current = reanchor;
  /** The first mounted card and its offset from the port top, taken before a step's commit. */
  const keep = useRef<{ card: Element; top: number } | null>(null);
  const sampleRef = useRef<() => void>(() => {});

  sampleRef.current = () => {
    const el = readRef.current();
    const { from: at, resetKey: key } = live.current;
    if (!el || at <= 0 || !drawn.current || keep.current !== null) return;
    const first = el.querySelector(".scn-mails .hmail");
    if (!first) return;
    const sliceTop = cssRect(first).top - cssRect(el).top;
    const scrollTop = el.scrollTop;
    const scrolled = !heldAnchored(anchoredAt.current, scrollTop);
    if (!heldWantsMore({ sliceTop, port: el.clientHeight, scrollTop, scrolled })) return;
    keep.current = { card: first, top: sliceTop };
    const next = Math.max(0, at - HELD_STEP);
    setWin((w) => (w.key === key ? { ...w, from: next, busy: true } : w));
  };

  /* One rAF-coalesced sampler, on the column's scroll (its own writes included) and the window's resize. */
  const frame = useRef(0);
  const schedule = useRef(() => {});
  schedule.current = () => {
    if (typeof requestAnimationFrame !== "function") { sampleRef.current(); return; }
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      sampleRef.current();
    });
  };
  useEffect(() => {
    const el = readRef.current();
    const onScroll = () => schedule.current();
    el?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      el?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, []);

  /* KEEP, in the step's own commit; then look again, for a column that still has room. */
  useLayoutEffect(() => {
    const k = keep.current;
    keep.current = null;
    const el = readRef.current();
    if (k && el && k.card.isConnected) {
      const before = el.scrollTop;
      el.scrollTop = heldKeepTop(before, k.top, cssRect(k.card).top - cssRect(el).top);
      followAnchor(anchoredAt, before, el.scrollTop);
    }
    schedule.current();
  }, [from, resetKey, count, anchoredAt]);

  /* The step is over once its commit has painted. */
  useEffect(() => {
    if (!cur.busy) return;
    const done = () => setWin((w) => (w.busy ? { ...w, busy: false } : w));
    if (typeof requestAnimationFrame !== "function") { done(); return; }
    const f = requestAnimationFrame(done);
    return () => cancelAnimationFrame(f);
  }, [cur.busy]);

  /*
   * HOLD: one observer over the mounted cards and the column itself. A card's first height is taken
   * in the commit that mounts it, so a frame that sizes before the observer's first report still
   * counts as growth. A hidden column (a phone's closed sheet) reads all zeros, so nothing is held
   * or remembered while it is hidden.
   */
  const ro = useRef<ResizeObserver | null>(null);
  const sizes = useRef(new WeakMap<Element, number>());
  const observed = useRef<Set<Element>>(new Set());
  useLayoutEffect(() => {
    if (typeof ResizeObserver !== "function") return;
    const col = readRef.current();
    const observer = new ResizeObserver((entries) => {
      // Any size change can leave the column room to spare: a sheet opening, a letter shrinking.
      schedule.current();
      const el = readRef.current();
      if (!el || !(cssRect(el).height > 0)) return;
      const changes: Array<{ bottom: number; delta: number }> = [];
      for (const en of entries) {
        if (en.target === el) continue;
        const r = cssRect(en.target);
        const was = sizes.current.get(en.target);
        sizes.current.set(en.target, r.height);
        if (was !== undefined && r.height !== was) changes.push({ bottom: r.bottom, delta: r.height - was });
      }
      if (changes.length === 0) return;
      if (heldAnchored(anchoredAt.current, el.scrollTop)) {
        reanchorRef.current();
        return;
      }
      const shift = heldHoldShift(cssRect(el).top, changes);
      if (shift === 0) return;
      const before = el.scrollTop;
      el.scrollTop = before + shift;
      followAnchor(anchoredAt, before, el.scrollTop);
    });
    if (col) observer.observe(col);
    ro.current = observer;
    return () => {
      observer.disconnect();
      ro.current = null;
      observed.current = new Set();
    };
  }, [anchoredAt]);
  useLayoutEffect(() => {
    const el = readRef.current();
    const observer = ro.current;
    if (!el || !observer) return;
    const drawn = cssRect(el).height > 0;
    const now = new Set<Element>(el.querySelectorAll(".scn-mails .hmail"));
    for (const c of observed.current) if (!now.has(c)) observer.unobserve(c);
    for (const c of now) {
      if (observed.current.has(c)) continue;
      if (drawn) sizes.current.set(c, cssRect(c).height);
      observer.observe(c);
    }
    observed.current = now;
  }, [from, resetKey, count]);

  return { from, busy: cur.busy };
}
