"use client";

/**
 * A VISIT TO A PILE IS THE LIFE OF ITS EFFECTS. A pile the shell keeps mounted while the reader is
 * elsewhere (`AppShell`'s kept piles, under React's `<Activity>`) keeps its state, its refs and its
 * DOM, and has every effect destroyed when it is hidden and created again when it is shown. So the
 * effect lifetime is the visit, and what a visit owns — the leave range, the scroll position, a pick,
 * a lingering bar — is reset where a visit starts and let go where it ends, exactly as an unmount
 * and a fresh mount did it before.
 *
 * `start` runs in a layout effect, before the paint of the commit that shows the pile, and before
 * any passive effect of the same commit; `end` runs as that effect is destroyed (the pile hidden or
 * unmounted). Both are read through a ref, so callers pass plain closures.
 */
import { useEffect, useLayoutEffect, useRef } from "react";

export function useVisit(start: () => void, end: () => void): void {
  const ref = useRef({ start, end });
  ref.current = { start, end };
  useLayoutEffect(() => {
    ref.current.start();
    return () => ref.current.end();
  }, []);
}

/**
 * A VISIT OPENS THE STREAM AT ITS TOP, so a cursor the last visit left behind moves to the letter shown
 * there and the first j steps from it, not from a letter far below the screen. A visit that arrives on a
 * jump keeps it: the jump places the cursor. Passive, after the paint of the press that shows the pile.
 */
export function useCursorFollowsTop(cur: string | null, jumpTo: string | null, top: string | null, onCur: (id: string) => void): void {
  const ref = useRef({ cur, jumpTo, top, onCur });
  ref.current = { cur, jumpTo, top, onCur };
  useEffect(() => {
    const { cur: held, jumpTo: asked, top: shown, onCur: move } = ref.current;
    if (held && !asked && shown && held !== shown) move(shown);
  }, []);
}

/** The input that counts as somebody using the page, for {@link whenQuiet}. */
const BUSY_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

/**
 * RUN `cb` ONCE THE PAGE HAS GONE `ms` WITHOUT A PRESS, A KEY OR A WHEEL, for work nobody waits on
 * that would cost a frame somebody could feel. Answers the cancel.
 */
export function whenQuiet(ms: number, cb: () => void): () => void {
  let timer = setTimeout(fire, ms);
  function poke(): void {
    clearTimeout(timer);
    timer = setTimeout(fire, ms);
  }
  function stop(): void {
    clearTimeout(timer);
    for (const e of BUSY_EVENTS) removeEventListener(e, poke, true);
  }
  function fire(): void {
    stop();
    cb();
  }
  for (const e of BUSY_EVENTS) addEventListener(e, poke, { capture: true, passive: true });
  return stop;
}

/**
 * RUN `cb` ONCE THE NEXT FRAME HAS BEEN PAINTED — a timer queued from that frame's own callback,
 * so it runs after the paint. Answers the cancel. Where nothing lays out (no animation frames, or
 * `el` with no box), `cb` runs at once: there is no frame to paint first.
 */
export function afterPaint(el: HTMLElement | null, cb: () => void): () => void {
  if (typeof requestAnimationFrame !== "function" || !el || el.getClientRects().length === 0) {
    cb();
    return () => {};
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(cb, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
  };
}
