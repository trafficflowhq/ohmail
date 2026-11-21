import { useLayoutEffect, useRef, type RefObject } from "react";
import { flipPlay, flipSnap } from "@ohmail/ui/base";

/** Keep visible rows in place for the instant their neighbors are added or removed. */
export function useMovingRows(scroller: RefObject<HTMLElement | null>, version: string): void {
  const previous = useRef<{ positions: ReturnType<typeof flipSnap>; scroll: number } | null>(null);
  useLayoutEffect(() => {
    const list = scroller.current;
    if (!list) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[role="option"][data-id]'));
    const positions = flipSnap(rows);
    const before = previous.current;
    previous.current = { positions, scroll: list.scrollTop };
    if (before && before.scroll === list.scrollTop) flipPlay(before.positions, rows);
  }, [scroller, version]);
}
