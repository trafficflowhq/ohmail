import { useLayoutEffect, useRef } from "react";
import { useListWindow } from "@ohmail/app-logic/lists";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";

/** Follow a new selection when its row is outside the mounted slice. */
export function useCursorWindow(count: number, cursorIndex: number, cursor: string | null) {
  const scroller = useRef<HTMLDivElement>(null);
  const window = useListWindow({ scrollerRef: scroller, count });
  const reveal = useStableCallback((index: number) => {
    const node = scroller.current;
    if (!node || index < 0 || (index >= window.start && index < window.end)) return;
    node.scrollTop = Math.max(0, window.offsetOf(index) - window.rowHeight);
    node.dispatchEvent(new Event("scroll"));
  });
  useLayoutEffect(() => reveal(cursorIndex), [cursor, cursorIndex, reveal]);
  return { scroller, window };
}
