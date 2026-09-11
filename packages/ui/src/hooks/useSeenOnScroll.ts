/**
 * Marks an element carrying `data-unseen` as seen once it has fully risen
 * into the top third of its scroller — never before the user has driven the
 * scroller. The guard arms on input events, not `scroll`, which also fires
 * for scrollIntoView/scrollTo: a cross-view jump once marked eleven unread
 * messages read, and read state reconciles onto `\Seen` on the user's own
 * IMAP server. A programmatic scroll produces no input event, so it cannot
 * reach the commit path. Ambiguous events (pointerdown, the app's j/k) stay
 * out of `arm`: a false mark writes to the server; a missed one leaves bold.
 */
import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * The keys with which the browser itself scrolls a focused scroller.
 *
 * Deliberately NOT the app's navigation letters. `j`/`k` in Reads and
 * Receipts move the cursor and then call `scrollTo` on the stream, so
 * treating a keypress as scroll intent would let a j-sweep mark every card
 * it flew past — the same defect through a different door.
 */
const SCROLL_KEYS = new Set([
  "PageDown",
  "PageUp",
  "Home",
  "End",
  "ArrowDown",
  "ArrowUp",
  " ",
  "Spacebar",
]);

export interface UseSeenOnScrollOptions {
  /** The scrolling container. */
  root: RefObject<HTMLElement>;
  /** Called once per element, with its data-id / data-sid. */
  onSeen: (id: string) => void;
  /** Which elements count; default: anything with [data-unseen]. */
  selector?: string;
  /**
   * IntersectionObserver rootMargin. The prototype uses
   * "0px 0px -67% 0px" for list panes and "0px 0px -62% 0px" for
   * reading streams.
   */
  rootMargin?: string;
}

export interface SeenObserver {
  /** Re-scan the scroller for [data-unseen] elements (call after re-render). */
  observe: () => void;
  /**
   * Has a HUMAN driven this scroller since it mounted (wheel, touch, or a scroll key)?
   *
   * The same authority the IntersectionObserver commit sits behind, exposed so a second
   * seen-marking path — `StreamShell`'s dwell timer — can share it rather than reinvent it.
   * A programmatic `scrollTo`/`scrollIntoView` produces none of those inputs, so it never
   * flips this true, which is what keeps a jump from writing `\Seen` to the user's own IMAP.
   */
  userHasDriven: () => boolean;
}

export function useSeenOnScroll({
  root,
  onSeen,
  selector = "[data-unseen]",
  rootMargin = "0px 0px -67% 0px",
}: UseSeenOnScrollOptions): SeenObserver {
  const ioRef = useRef<IntersectionObserver | null>(null);
  const userDrove = useRef(false);
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;

  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    // The user-intent guard: nothing is marked until a human moves this scroller.
    userDrove.current = false;
    const arm = () => {
      userDrove.current = true;
    };
    const armOnScrollKey = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) userDrove.current = true;
    };
    // Both listeners sit on the scroller, so they only ever see input aimed at
    // THIS pane — the list and the stream each keep their own guard, and a wheel
    // over one cannot commit rows in the other.
    el.addEventListener("wheel", arm, { passive: true });
    el.addEventListener("touchmove", arm, { passive: true });
    el.addEventListener("keydown", armOnScrollKey);

    const io = new IntersectionObserver(
      (entries) => {
        if (!userDrove.current) return;
        for (const en of entries) {
          const t = en.target as HTMLElement;
          if (!t.hasAttribute("data-unseen") || !en.rootBounds) continue;
          if (en.boundingClientRect.bottom <= en.rootBounds.bottom + 2) {
            const id = t.dataset.id ?? t.dataset.sid;
            if (id) onSeenRef.current(id);
          }
        }
      },
      // A LADDER OF THRESHOLDS, not just [0, 0.99]. The commit condition (bottom above the
      // shrunk root's bottom) is only ever CHECKED when the observer fires, and it fires on a
      // ratio CROSSING. A tall card (450–500px) in a root shrunk to its top third (~340px) can
      // never reach ratio 0.99, so with only [0, 0.99] it fired solely at ratio→0 as it left
      // the TOP fully off-screen — the last screenful, which never exits the top, never marked.
      // The intermediate rungs give it a crossing to fire on while its bottom is still on screen.
      { root: el, rootMargin, threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99] },
    );
    ioRef.current = io;
    for (const n of el.querySelectorAll(selector)) io.observe(n);

    return () => {
      el.removeEventListener("wheel", arm);
      el.removeEventListener("touchmove", arm);
      el.removeEventListener("keydown", armOnScrollKey);
      io.disconnect();
      ioRef.current = null;
    };
  }, [root, selector, rootMargin]);

  const observe = useCallback(() => {
    const el = root.current;
    const io = ioRef.current;
    if (!el || !io) return;
    io.disconnect();
    for (const n of el.querySelectorAll(selector)) io.observe(n);
  }, [root, selector]);

  const userHasDriven = useCallback(() => userDrove.current, []);

  return { observe, userHasDriven };
}
