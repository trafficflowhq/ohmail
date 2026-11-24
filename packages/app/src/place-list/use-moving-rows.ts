import { useLayoutEffect, useRef, type RefObject } from "react";
import { animate, flipPlay, flipSnap, motionShape } from "@ohmail/ui/base";

/** Keep visible rows in place for the instant their neighbors are added or removed. */
export function useMovingRows(
  scroller: RefObject<HTMLElement | null> | undefined,
  version: string,
  arrival?: { scope: string | null; ids: readonly string[] },
): void {
  const previous = useRef<{
    version: string;
    positions: ReturnType<typeof flipSnap>;
    scroll: number;
    scope?: string | null;
    ids: ReadonlySet<string>;
    hadRows: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    const list = scroller?.current;
    if (!list) return;
    const before = previous.current;
    if (before?.version === version && before.scope === arrival?.scope) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[role="option"][data-id]'));
    const positions = flipSnap(rows);
    const ids = new Set(arrival?.ids);
    const sameScope = before?.scope === arrival?.scope;
    previous.current = {
      version,
      positions,
      scroll: list.scrollTop,
      scope: arrival?.scope,
      ids,
      hadRows: ids.size > 0 || (sameScope && before?.hadRows === true),
    };
    if (!before || before.scroll !== list.scrollTop) return;
    flipPlay(before.positions, rows);
    if (!arrival || !sameScope || !before.hadRows) return;
    for (const row of rows) {
      const id = row.dataset.id;
      if (id === undefined || before.ids.has(id) || !ids.has(id) || before.positions.has(row)) continue;
      animate(row, "in", {
        ease: "--e-arrive",
        keyframes: [
          { transform: motionShape(row, "--x-row"), opacity: motionShape(row, "--o-pop") },
          { transform: "none", opacity: "1" },
        ],
      });
    }
  }, [scroller, version, arrival]);
}
