import { useCallback, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { scrollerOf } from "./read-dom.js";

/**
 * THE KEYBOARD STAYS IN THE COLUMN FROM LETTER TO LETTER. Each letter draws a column of its own; where the keyboard
 * stood on the one that leaves (the arrows scroll it there), the next one's scroller takes it in the commit that
 * draws it, so the arrows go on scrolling what is read and never fall back to walking the list.
 */
export function useKeyboardStays(
  onRoot: (el: HTMLDivElement | null) => void,
  keyboard: MutableRefObject<boolean>,
): readonly [(el: HTMLDivElement | null) => void, RefObject<HTMLDivElement | null>] {
  const root = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const here = scrollerOf(root.current);
    if (!keyboard.current || here === null) return;
    keyboard.current = false;
    const at = here.ownerDocument.activeElement;
    if (at === null || at === here.ownerDocument.body) here.focus({ preventScroll: true });
  });
  useLayoutEffect(
    () => () => {
      const mine = scrollerOf(root.current);
      keyboard.current = mine !== null && mine.ownerDocument.activeElement === mine;
    },
    [root, keyboard],
  );
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el;
      onRoot(el);
    },
    [onRoot],
  );
  /* The root as the commit sets it, for what reads it in an effect of the render that drew it. */
  return [ref, root] as const;
}
