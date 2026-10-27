/**
 * Marks an element carrying `data-unseen` as seen once it has fully risen
 * into the top third of its scroller — never before the user has driven the
 * scroller. The guard arms on input events, not `scroll`, which also fires
 * for scrollIntoView/scrollTo: a cross-view jump once marked eleven unread
 * messages read, and read state reconciles onto `\Seen` on the user's own
 * IMAP server. A programmatic scroll produces no input event, so it cannot
 * reach the commit path. Ambiguous events (pointerdown, the app's j/k) stay
 * out of `arm`: a false mark writes to the server; a missed one leaves bold.
 * A judged scroll (the reader's own keys, unheard in a letter) arms too; an
 * `own()` scroll is never judged.
 */
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { cssRect, type CssRect } from "../ui-zoom.js";

/**
 * The keys with which the browser itself scrolls a focused scroller.
 *
 * Deliberately NOT the app's navigation letters. `j`/`k` in Reads and
 * Receipts move the cursor and then call `scrollTo` on the stream, so
 * treating a keypress as scroll intent would let a j-sweep mark every card
 * it flew past — the same defect through a different door.
 */
export const SCROLL_KEYS: ReadonlySet<string> = new Set([
  "PageDown",
  "PageUp",
  "Home",
  "End",
  "ArrowDown",
  "ArrowUp",
  " ",
  "Spacebar",
]);

/**
 * A key that carries the scroller to an end (End, Home, ⌘/Ctrl ↓, ⌘/Ctrl ↑). Every engine animates it
 * over frames, so the rows it passes cross the band on the way without ever being on screen at rest.
 */
function jumpsToAnEnd(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? ""))) return false;
  const arrow = e.key === "ArrowDown" || e.key === "ArrowUp";
  return e.key === "End" || e.key === "Home" || ((e.metaKey || e.ctrlKey) && arrow);
}

/** A jump to an end has rested once its scroller has not moved for this long. */
export const LANDING_QUIET_MS = 150;

/**
 * The read rule (0.30.7): a letter whose first lines stay on screen this long is read. A copy of
 * `THREAD_READ_HOLD_MS` in `@ohmail/client-engine`'s reader-seen-rules (#345), which this package cannot import.
 */
export const READ_HOLD_MS = 700;

/** A card's first lines: its sender line and about three lines of its text, or the whole card when shorter. */
const FIRST_LINES_PX = 140;

/** Are `el`'s first lines wholly inside `view`, half a pixel either way? */
function firstLinesIn(el: Element, view: Pick<CssRect, "top" | "bottom">): boolean {
  const r = cssRect(el);
  return r.height > 0 && r.top >= view.top - 0.5 && r.top + Math.min(r.height, FIRST_LINES_PX) <= view.bottom + 0.5;
}

/** Asks a letter's document whether a listener of ours runs there at all. */
const HEAR_PROBE = "ohmail-hear-probe";

export interface UseSeenOnScrollOptions {
  /** The scrolling container. */
  root: RefObject<HTMLElement | null>;
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
  /** A jump to an end of THIS scroller has rested, and the screen it rests on was re-scanned. */
  onLanded?: () => void;
  /** A scroll this hook judged (see `judging`) has ended: it rested, or a hand joined it. */
  onJudged?: () => void;
  /**
   * For a scroller that holds its anchor by hand (a stream): the px it is about to scroll by to put back content
   * that moved under it, 0 when none waits. The read rule judges a letter where that scroll will show it, and an
   * observer report handed over meanwhile shows a frame nobody reads: it is neither read nor taken as shown, and
   * the next frame reports its target again.
   */
  pendingShift?: () => number;
  /** Was an observer report recorded at `time` (its entry's) on a frame the scroller has put back since? Such a
   *  report is asked for again the same way. */
  putBack?: (time: number) => boolean;
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
  /** Forget what this observer has seen and start a new run from the cards on screen now. */
  restart: () => void;
  /** Is a jump to an end in flight? Until it rests nothing is marked. */
  landing: () => boolean;
  /**
   * Is a scroll from a letter whose keys this pane cannot hear (WebKit) in flight? End cannot be told from
   * PageDown there, so it is judged by the read rule: a letter turns read once its first lines have stayed
   * on screen for READ_HOLD_MS, from then or later, and nothing it carries past sooner does.
   */
  judging: () => boolean;
  /**
   * Run the app's own scroll of this pane (an anchoring correction, a landing, a reset): the scroll
   * event it causes neither starts nor extends a landing.
   */
  own: (scroll: () => void) => void;
}

export function useSeenOnScroll({
  root,
  onSeen,
  selector = "[data-unseen]",
  rootMargin = "0px 0px -67% 0px",
  onLanded,
  onJudged,
  pendingShift,
  putBack,
}: UseSeenOnScrollOptions): SeenObserver {
  const ioRef = useRef<IntersectionObserver | null>(null);
  const shownRef = useRef<WeakSet<Element>>(new WeakSet());
  const userDrove = useRef(false);
  const landingRef = useRef(false);
  const judgingRef = useRef(false);
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  const onLandedRef = useRef(onLanded);
  onLandedRef.current = onLanded;
  const onJudgedRef = useRef(onJudged);
  onJudgedRef.current = onJudged;
  const pendingShiftRef = useRef(pendingShift);
  pendingShiftRef.current = pendingShift;
  const putBackRef = useRef(putBack);
  putBackRef.current = putBack;
  /** The app's own scroll (`own`): running now, its scroll event heard while it ran, the offset it left. */
  const owningRef = useRef(false);
  const ownSeenRef = useRef(false);
  const ownTopRef = useRef(NaN);
  /** The read rule's look while the scroller's effect is mounted (see `observe`). */
  const lookRef = useRef<(start: boolean) => void>(() => {});

  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    // The user-intent guard: nothing is marked until a human moves this scroller.
    userDrove.current = false;
    /** A wheel or touch on the pane owns its scrolls until the pane has been quiet for LANDING_QUIET_MS. */
    let handUntil = 0;
    const arm = () => {
      userDrove.current = true;
      handUntil = Date.now() + LANDING_QUIET_MS;
      // A judged scroll (below) that a hand joins was the hand's own scroll, its event late: a read.
      if (judgingRef.current) {
        const marks = held ?? [];
        held = null;
        judgingRef.current = false;
        window.clearTimeout(quiet);
        clocks = new Map();
        window.clearTimeout(tick);
        for (const id of marks) onSeenRef.current(id);
        onJudgedRef.current?.();
      }
    };
    // Only a key the pane itself scrolls with: never one typed into an editor inside it (a reply
    // answered in place), nor one a handler already took.
    const armOnScrollKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !SCROLL_KEYS.has(e.key)) return;
      // Duck-typed: a letter's nodes belong to its own realm, where `instanceof Element` is false.
      const t = e.target as (Element & { isContentEditable?: boolean }) | null;
      if (typeof t?.closest === "function" && t.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
      if (t?.isContentEditable) return;
      userDrove.current = true;
    };
    // Both listeners sit on the scroller, so they only ever see input aimed at
    // THIS pane — the list and the stream each keep their own guard, and a wheel
    // over one cannot commit rows in the other.
    el.addEventListener("wheel", arm, { passive: true });
    el.addEventListener("touchmove", arm, { passive: true });
    el.addEventListener("keydown", armOnScrollKey);
    /* With nothing focused a key targets the body, and the browser scrolls the pane last pressed. */
    const doc0 = el.ownerDocument;
    let pressedHere = false;
    const onPress = (e: Event) => {
      pressedHere = e.target instanceof Node && el.contains(e.target);
    };
    // On the window, after the app's own key map (the document's): a key it took is not a scroll.
    const armOnFreeKey = (e: KeyboardEvent) => {
      if (pressedHere && (e.target === doc0.body || e.target === doc0.documentElement)) armOnScrollKey(e);
    };
    doc0.addEventListener("pointerdown", onPress, true);
    window.addEventListener("keydown", armOnFreeKey);

    // What this observer has seen in its band since it mounted (= this visit) or last restarted.
    shownRef.current = new WeakSet();
    landingRef.current = false;
    judgingRef.current = false;
    /** What the band marks while a scroll is judged, kept until it ends: read if a hand joins it, dropped at rest. */
    let held: Set<string> | null = null;
    /** Targets reported on a frame the scroller puts back (`pendingShift`, `putBack`), observed afresh on the next frame. */
    let again = new Set<Element>();
    let againFrame = 0;
    /** The reports recorded on frames the reader saw; the others are asked for again. */
    const settledOf = (entries: IntersectionObserverEntry[]): IntersectionObserverEntry[] => {
      const moving = (pendingShiftRef.current?.() ?? 0) !== 0;
      const back = putBackRef.current;
      if (!moving && !back) return entries;
      const now = performance.now();
      const kept = entries.filter((en) => {
        if (!moving && !back?.(Number.isFinite(en.time) ? en.time : now)) return true;
        again.add(en.target);
        return false;
      });
      if (again.size > 0 && !againFrame) {
        againFrame = requestAnimationFrame(() => {
          againFrame = 0;
          const targets = again;
          again = new Set();
          for (const t of targets) {
            if (!t.isConnected || !el.contains(t) || !t.matches(selector)) continue;
            io.unobserve(t);
            io.observe(t);
          }
        });
      }
      return kept;
    };
    const io = new IntersectionObserver(
      (reported) => {
        if (landingRef.current) return;
        const entries = settledOf(reported);
        const shown = shownRef.current;
        for (const en of entries) if (en.isIntersecting) shown.add(en.target);
        if (!userDrove.current) return;
        for (const en of entries) {
          const t = en.target as HTMLElement;
          if (!shown.has(t) || !t.hasAttribute("data-unseen") || !en.rootBounds) continue;
          if (en.boundingClientRect.bottom <= en.rootBounds.bottom + 2) {
            const id = t.dataset.id ?? t.dataset.sid;
            if (id && held) held.add(id);
            else if (id) onSeenRef.current(id);
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

    /* A jump to an end rests LANDING_QUIET_MS after this scroller's last scroll; the observer then
       starts over from the screen it rests on. Heard on the document: with focus outside a pane the
       browser still scrolls the one last clicked, so every pane holds its marks until it rests. */
    let quiet = 0;
    let moved = false;
    const rest = () => {
      quiet = 0;
      held = null;
      shownRef.current = new WeakSet();
      // A judged scroll is no landing: what it carried through the band is not read, and the clocks
      // (below) read the screen it rests on.
      if (judgingRef.current) {
        judgingRef.current = false;
        onJudgedRef.current?.();
        return;
      }
      landingRef.current = false;
      io.disconnect();
      for (const n of el.querySelectorAll(selector)) io.observe(n);
      const landed = moved;
      moved = false;
      if (landed) onLandedRef.current?.();
    };
    const hold = () => {
      window.clearTimeout(quiet);
      quiet = window.setTimeout(rest, LANDING_QUIET_MS);
    };
    const land = (e: KeyboardEvent) => {
      if (!jumpsToAnEnd(e)) return;
      landingRef.current = true;
      judgingRef.current = false;
      held = null;
      hold();
    };

    /* The read rule's clocks: since when each unseen letter's first lines have been on screen, unbroken.
       A judged scroll starts them; any scroll and their due time look again. */
    let clocks = new Map<HTMLElement, number>();
    let tick = 0;
    const look = (start: boolean) => {
      window.clearTimeout(tick);
      const now = Date.now();
      // Where the scroller's waiting correction will show each letter, not where a moved frame does.
      const shift = pendingShiftRef.current?.() ?? 0;
      const r = cssRect(el);
      const view = { top: r.top + shift, bottom: r.bottom + shift };
      const next = new Map<HTMLElement, number>();
      let due = Infinity;
      for (const n of el.querySelectorAll<HTMLElement>(selector)) {
        const at = clocks.get(n) ?? (start ? now : undefined);
        if (at === undefined || !n.hasAttribute("data-unseen") || !firstLinesIn(n, view)) continue;
        if (now - at < READ_HOLD_MS) {
          next.set(n, at);
          due = Math.min(due, at + READ_HOLD_MS);
          continue;
        }
        const id = n.dataset.id ?? n.dataset.sid;
        if (id && userDrove.current) onSeenRef.current(id);
      }
      clocks = next;
      if (due < Infinity) tick = window.setTimeout(() => look(false), due - now);
    };
    lookRef.current = look;

    /* A key typed in a letter reaches the letter's own document, never this one, so the jump keys are
       heard on each letter's document too, from its load. WebKit runs no listener in a letter
       sandboxed without scripts, ours included: a probe asks once per kind of sandbox. */
    const letters = new WeakMap<HTMLIFrameElement, Document>();
    const hears = new Map<string | null, boolean>();
    /** Listen for this letter's keys; were they already heard before this call? */
    const listen = (f: HTMLIFrameElement): boolean => {
      const doc = f.contentDocument;
      const was = letters.get(f);
      if (doc && was === doc) return true;
      was?.removeEventListener("keydown", land, true);
      was?.removeEventListener("keydown", armOnScrollKey);
      was?.removeEventListener("wheel", arm);
      was?.removeEventListener("touchmove", arm);
      letters.delete(f);
      if (!doc) return false; // another origin: its keys never reach us
      const kind = f.getAttribute("sandbox");
      let ok = hears.get(kind);
      if (ok === undefined) {
        let ran = false;
        const probe = () => {
          ran = true;
        };
        try {
          doc.addEventListener(HEAR_PROBE, probe);
          doc.dispatchEvent(new Event(HEAR_PROBE));
          doc.removeEventListener(HEAR_PROBE, probe);
        } catch {
          ran = false;
        }
        hears.set(kind, (ok = ran));
      }
      if (ok) {
        doc.addEventListener("keydown", land, true);
        // A letter scrolls nothing of its own: its keys, wheel and touch scroll this pane.
        doc.addEventListener("keydown", armOnScrollKey);
        doc.addEventListener("wheel", arm, { passive: true });
        doc.addEventListener("touchmove", arm, { passive: true });
        letters.set(f, doc);
      }
      return false;
    };
    const onLoad = (e: Event) => {
      const t = e.target as Element | null;
      if (t?.tagName === "IFRAME") listen(t as HTMLIFrameElement);
    };
    el.addEventListener("load", onLoad, true);
    for (const f of el.querySelectorAll("iframe")) listen(f);
    /* Focus in a letter of this pane whose keys never reach us: End cannot be told from PageDown
       there, so a scroll no wheel or touch owns is judged by the read rule, neither a landing nor a read. */
    const unheard = (): boolean => {
      const a = el.ownerDocument.activeElement;
      if (a?.tagName !== "IFRAME" || !el.contains(a)) return false;
      return !listen(a as HTMLIFrameElement);
    };
    // Extends a landing or a judged scroll, or starts one from an unheard letter; never arms (a scroll is not input).
    const onScroll = () => {
      if (owningRef.current) ownSeenRef.current = true;
      else if (el.scrollTop === ownTopRef.current) ownTopRef.current = NaN;
      else {
        ownTopRef.current = NaN;
        const byHand = Date.now() < handUntil;
        if (byHand) handUntil = Date.now() + LANDING_QUIET_MS;
        if (landingRef.current) {
          moved = true;
          hold();
        } else if (judgingRef.current || (!byHand && unheard())) {
          if (!judgingRef.current) held = new Set();
          judgingRef.current = true;
          // The reader's own keys in their letter moved it: the visit is driven, and the read rule judges it.
          userDrove.current = true;
          hold();
          look(true);
          return;
        }
      }
      if (clocks.size) look(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const doc = el.ownerDocument;
    doc.addEventListener("keydown", land, true);

    return () => {
      el.removeEventListener("wheel", arm);
      el.removeEventListener("touchmove", arm);
      el.removeEventListener("keydown", armOnScrollKey);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("load", onLoad, true);
      doc.removeEventListener("keydown", land, true);
      doc0.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("keydown", armOnFreeKey);
      // A letter that left the pane took its listener with its document; these are still here.
      for (const f of el.querySelectorAll("iframe")) {
        const d = letters.get(f);
        d?.removeEventListener("keydown", land, true);
        d?.removeEventListener("keydown", armOnScrollKey);
        d?.removeEventListener("wheel", arm);
        d?.removeEventListener("touchmove", arm);
      }
      window.clearTimeout(quiet);
      window.clearTimeout(tick);
      if (againFrame) cancelAnimationFrame(againFrame);
      landingRef.current = false;
      judgingRef.current = false;
      io.disconnect();
      ioRef.current = null;
      lookRef.current = () => {};
    };
  }, [root, selector, rootMargin]);

  const observe = useCallback(() => {
    const el = root.current;
    const io = ioRef.current;
    if (!el || !io) return;
    io.disconnect();
    for (const n of el.querySelectorAll(selector)) io.observe(n);
    // Cards a window mounted under a judged scroll (one that held still while it flew) start their clocks here.
    if (judgingRef.current) lookRef.current(true);
  }, [root, selector]);

  const userHasDriven = useCallback(() => userDrove.current, []);
  const restart = useCallback(() => {
    shownRef.current = new WeakSet();
    observe();
  }, [observe]);
  const landing = useCallback(() => landingRef.current, []);
  const judging = useCallback(() => judgingRef.current, []);
  const own = useCallback(
    (scroll: () => void) => {
      const el = root.current;
      const before = el ? el.scrollTop : NaN;
      ownSeenRef.current = false;
      owningRef.current = true;
      try {
        scroll();
      } finally {
        owningRef.current = false;
      }
      // A browser fires the scroll event on the next frame: it is known there by the offset left.
      ownTopRef.current = el && !ownSeenRef.current && el.scrollTop !== before ? el.scrollTop : NaN;
    },
    [root],
  );

  return { observe, userHasDriven, restart, landing, judging, own };
}
