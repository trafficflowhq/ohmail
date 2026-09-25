import { useEffect, useRef, type RefObject } from "react";

/**
 * A REFUSAL IS TOLD WHERE THE PRESS WAS. Each time a sentence appears, the element holding it is
 * scrolled into view and given focus, so a press at the bottom of a form that scrolls is answered
 * on screen and read out by a screen reader. A sentence drawn above the fold with focus left on
 * nothing makes the press look dead, and a second press looks the same. The element carries
 * `tabIndex={-1}`: focusable, and not a stop in the tab order.
 */
export function useRefusalAtThePress<T extends HTMLElement>(sentence: string | null): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!sentence || !el) return;
    el.scrollIntoView?.({ block: "nearest" });
    el.focus({ preventScroll: true });
  }, [sentence]);
  return ref;
}
