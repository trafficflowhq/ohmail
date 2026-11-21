/** Native scroll gestures, including keys and input from a letter's own document. */
import { cssPoint } from "../geometry/index.js";
import { isTypingTarget, KEY_WRITING } from "../keys/keymap.js";
import type { StreamHand, StreamReadRule } from "./read-rule.js";

/** The keys that are a hand on the stream. Arrows, `j` and `k` are not: they move the selection. */
const HAND_KEYS = new Set([" ", "PageDown", "PageUp"]);
/** A key that carries the scroller to an end: End, Home, Ctrl or Cmd with an arrow. */
function jumpsToAnEnd(e: KeyboardEvent): boolean {
  const arrow = e.key === "ArrowDown" || e.key === "ArrowUp";
  return e.key === "End" || e.key === "Home" || ((e.metaKey || e.ctrlKey) && arrow);
}
/** A finger drawn this far, and more up or down than sideways, is a hand on a stream that fits whole. */
const TOUCH_SLOP_PX = 10;

export function listenToTouch(
  el: HTMLElement,
  rule: StreamReadRule,
  now: () => number,
  still: (by: StreamHand) => void,
  countHand: () => void,
) {
  let touchFrom: { x: number; y: number } | null = null;
  const onTouchStart = (e: TouchEvent): void => {
    const t = e.touches[0];
    touchFrom = t ? cssPoint(t) : null;
    countHand();
    rule.touchDown(now());
  };
  const onTouchMove = (e: TouchEvent): void => {
    rule.hand("touch", now(), true);
    const t = e.touches[0];
    if (!t || !touchFrom) return;
    /* The finger's travel in CSS px, as the slop is: under the Text size a viewport read is off by its zoom. */
    const at = cssPoint(t);
    const dy = Math.abs(at.y - touchFrom.y);
    if (dy > TOUCH_SLOP_PX && dy > Math.abs(at.x - touchFrom.x)) still("touch");
  };
  const onTouchEnd = (): void => {
    touchFrom = null;
    rule.touchUp(now());
  };
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: true });
  el.addEventListener("touchend", onTouchEnd, { passive: true });
  el.addEventListener("touchcancel", onTouchEnd, { passive: true });
  return () => {
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    el.removeEventListener("touchcancel", onTouchEnd);
  };
}

export function listenToKeys(
  el: HTMLElement,
  rule: StreamReadRule,
  now: () => number,
  startFlight: (insideLetter: boolean) => void,
  still: (by: StreamHand) => void,
  onWheel: (event: WheelEvent) => void,
  onLetterEnter: () => void,
  countHand: () => void,
) {
  const onKey = (e: KeyboardEvent): void => {
    if (
      e.defaultPrevented ||
      isTypingTarget(e.target) ||
      (e.target as Element | null)?.closest?.(
        `[${KEY_WRITING}], input, textarea, select, [contenteditable]:not([contenteditable="false"])`,
      )
    )
      return;
    if (jumpsToAnEnd(e)) {
      /* A scroll key drives the leave, and its scroll is no hand's: nothing it carries past is read. */
      countHand();
      startFlight((e.target as Node | null)?.ownerDocument !== el.ownerDocument);
      rule.scrollKey(now());
      return;
    }
    if (!HAND_KEYS.has(e.key)) return;
    countHand();
    rule.hand("key", now());
    still("key");
  };
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  let pressedHere = false;
  const onPress = (e: PointerEvent): void => {
    pressedHere = e.target instanceof Node && el.contains(e.target);
  };
  const onFreeKey = (e: KeyboardEvent): void => {
    if (pressedHere && (e.target === doc.body || e.target === doc.documentElement)) onKey(e);
  };
  const letters = new Map<HTMLIFrameElement, () => void>();
  const listenLetter = (frame: HTMLIFrameElement): void => {
    letters.get(frame)?.();
    letters.delete(frame);
    const letter = frame.contentDocument;
    if (!letter) return;
    // Some WebKit sandboxes expose a document but never call a listener inside it.
    const probe = "stream-input-probe";
    let hears = false;
    const heard = (): void => {
      hears = true;
    };
    try {
      letter.addEventListener(probe, heard);
      letter.dispatchEvent(new Event(probe));
      letter.removeEventListener(probe, heard);
    } catch {
      return;
    }
    if (!hears) return;
    letter.addEventListener("keydown", onKey);
    letter.addEventListener("wheel", onWheel, { passive: true });
    letter.addEventListener("pointerdown", onLetterEnter, { passive: true });
    letters.set(frame, () => {
      letter.removeEventListener("keydown", onKey);
      letter.removeEventListener("wheel", onWheel);
      letter.removeEventListener("pointerdown", onLetterEnter);
    });
  };
  const onLetterLoad = (e: Event): void => {
    if (e.target instanceof HTMLIFrameElement) listenLetter(e.target);
  };
  const removal =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          for (const [frame, stop] of letters) {
            if (el.contains(frame)) continue;
            stop();
            letters.delete(frame);
          }
        })
      : null;
  removal?.observe(el, { subtree: true, childList: true });
  for (const frame of el.querySelectorAll("iframe")) listenLetter(frame);
  el.addEventListener("load", onLetterLoad, true);
  el.addEventListener("keydown", onKey);
  doc.addEventListener("pointerdown", onPress, true);
  win?.addEventListener("keydown", onFreeKey);
  return {
    isolatedLetterFocused(): boolean {
      const focused = doc.activeElement;
      return focused instanceof HTMLIFrameElement && el.contains(focused) && !letters.has(focused);
    },
    stop(): void {
      el.removeEventListener("load", onLetterLoad, true);
      el.removeEventListener("keydown", onKey);
      removal?.disconnect();
      for (const stop of letters.values()) stop();
      doc.removeEventListener("pointerdown", onPress, true);
      win?.removeEventListener("keydown", onFreeKey);
    },
  };
}
