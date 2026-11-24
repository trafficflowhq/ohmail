import type { StreamHand, StreamReadRule } from "./read-rule.js";
import type { JudgedReadPhase } from "./stream-read-types.js";
import type { StreamReadRefs } from "./stream-read-dom.js";
import { listenToKeys, listenToTouch } from "./stream-input.js";

/** A jump to an end has rested once the scroller has been quiet this long. */
export const STREAM_LANDING_QUIET_MS = 150;

/** Judge keyboard scrolling only after app moves and ordinary hand gestures have gone quiet. */
export function streamScrollJudgement(
  el: HTMLElement,
  rule: StreamReadRule,
  now: () => number,
  { opts, judgingRef, appMovedAt, handCount }: StreamReadRefs,
  onRest: () => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastHand = Number.NEGATIVE_INFINITY;
  let phase: JudgedReadPhase | null = null;
  let top = el.scrollTop;
  const cancel = (): void => {
    clearTimeout(timer);
    judgingRef.current = false;
    phase = null;
  };
  const suspend = (): void => {
    if (phase === null) return;
    cancel();
    phase = "settled";
  };
  const finish = (): void => {
    judgingRef.current = false;
    phase = "landing";
    opts.current.onJudged?.();
    onRest();
  };
  return {
    scroll(at: number, offset: number, own: boolean, blocked: boolean, focused: () => boolean) {
      const moved = offset !== top;
      top = offset;
      if (!moved || own) return;
      if (
        blocked ||
        !(at - appMovedAt.current > STREAM_LANDING_QUIET_MS) ||
        !(at - lastHand >= STREAM_LANDING_QUIET_MS) ||
        !el.ownerDocument.hasFocus() ||
        !(judgingRef.current || focused())
      ) {
        if (phase === null) return;
        suspend();
        return "interrupted";
      }
      if (!judgingRef.current) {
        phase = "moving";
        judgingRef.current = true;
        rule.scrollKey(at);
        handCount.current += 1;
      }
      clearTimeout(timer);
      timer = setTimeout(finish, STREAM_LANDING_QUIET_MS);
      return "judged";
    },
    phase: () => phase,
    settle() {
      if (phase === "landing") phase = "settled";
    },
    suspend,
    hand() {
      const wasJudging = judgingRef.current;
      cancel();
      handCount.current += 1;
      lastHand = now();
      if (wasJudging) opts.current.onJudged?.();
    },
    cancel,
  };
}

export function listenStreamControls(
  el: HTMLElement,
  rule: StreamReadRule,
  now: () => number,
  controls: {
    onScroll: () => void;
    onWheel: (event: WheelEvent) => void;
    still: (hand: StreamHand) => void;
    hand: () => void;
    onEnd: (insideLetter: boolean) => void;
    onEnter: () => void;
  },
) {
  const { onScroll, onWheel, still, hand, onEnd, onEnter } = controls;
  el.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("wheel", onWheel, { passive: true });
  const stopTouch = listenToTouch(el, rule, now, still, hand);
  const keys = listenToKeys(el, rule, now, onEnd, still, onWheel, onEnter, hand);
  return {
    isolatedLetterFocused: keys.isolatedLetterFocused,
    stop() {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      stopTouch();
      keys.stop();
    },
  };
}

export function ownStreamScroll(el: HTMLElement) {
  let owning = false;
  let ownHeard = false;
  let ownTop = Number.NaN;
  return {
    run(scroll: () => void) {
      const before = el.scrollTop;
      owning = true;
      ownHeard = false;
      try {
        scroll();
        ownTop = !ownHeard && el.scrollTop !== before ? el.scrollTop : Number.NaN;
      } finally {
        owning = false;
      }
    },
    heard(): boolean {
      const own = owning || ownTop === el.scrollTop;
      ownHeard = owning;
      ownTop = Number.NaN;
      return own;
    },
  };
}

export function watchStreamContent(
  el: HTMLElement,
  rule: StreamReadRule,
  measureAgain: () => void,
): () => void {
  let previewFrame = 0;
  const onContentChange = (): void => {
    if (!rule.driven || previewFrame) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = 0;
      measureAgain();
    });
  };
  const previewChanges =
    typeof MutationObserver === "undefined" ? null : new MutationObserver(onContentChange);
  previewChanges?.observe(el, { subtree: true, childList: true, characterData: true });
  return () => {
    previewChanges?.disconnect();
    if (previewFrame) cancelAnimationFrame(previewFrame);
  };
}

/** A report wakes a fresh read of the band. Its sampled rectangles can predate re-anchoring. */
export function watchStreamBand(
  el: HTMLElement,
  unstable: () => boolean,
  suspended: () => boolean,
  mark: () => void,
) {
  let frame = 0;
  const read = (): void => {
    if (suspended()) return;
    if (!unstable()) {
      mark();
    } else if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        read();
      });
    }
  };
  const Observer = el.ownerDocument.defaultView?.IntersectionObserver;
  const observer = Observer
    ? new Observer(read, {
        root: el,
        rootMargin: "0px 0px -62% 0px",
        threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99],
      })
    : null;
  let observed = new Set<Element>();
  const sync = (): void => {
    const cards = new Set<Element>(el.querySelectorAll("[data-stream-item]"));
    for (const card of observed) if (!cards.has(card)) observer?.unobserve(card);
    for (const card of cards) if (!observed.has(card)) observer?.observe(card);
    observed = cards;
  };
  const changes = !observer || typeof MutationObserver === "undefined" ? null : new MutationObserver(sync);
  changes?.observe(el, { childList: true, subtree: true });
  if (observer) sync();
  return {
    read,
    stop(): void {
      if (frame) cancelAnimationFrame(frame);
      changes?.disconnect();
      observer?.disconnect();
    },
  };
}

/** Focus into a letter is a press in the stream, including frames whose events cannot be heard. */
export function watchStreamFocus(el: HTMLElement, enter: () => void, leave: () => void): () => void {
  const doc = el.ownerDocument;
  const onBlur = (): void => {
    const focused = doc.activeElement;
    if (focused?.tagName === "IFRAME" && el.contains(focused)) enter();
    else leave();
  };
  doc.defaultView?.addEventListener("blur", onBlur);
  return () => doc.defaultView?.removeEventListener("blur", onBlur);
}
