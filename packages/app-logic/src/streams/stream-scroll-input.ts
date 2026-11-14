import type { StreamHand, StreamReadRule } from "./read-rule.js";
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
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastHand = Number.NEGATIVE_INFINITY;
  const finish = () => {
    clearTimeout(timer);
    if (!judgingRef.current) return;
    judgingRef.current = false;
    opts.current.onJudged?.();
  };
  return {
    scroll(at: number, focused: () => boolean) {
      if (
        !(at - appMovedAt.current > STREAM_LANDING_QUIET_MS) ||
        !(at - lastHand >= STREAM_LANDING_QUIET_MS) ||
        !el.ownerDocument.hasFocus() ||
        !(judgingRef.current || focused())
      )
        return;
      if (!judgingRef.current) {
        judgingRef.current = true;
        rule.scrollKey(at);
        handCount.current += 1;
      }
      clearTimeout(timer);
      timer = setTimeout(finish, STREAM_LANDING_QUIET_MS);
    },
    hand() {
      handCount.current += 1;
      lastHand = now();
      finish();
    },
    cancel() {
      clearTimeout(timer);
      judgingRef.current = false;
    },
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
    onEnd: () => void;
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
