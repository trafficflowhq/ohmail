/**
 * The Ohbox's list window: one index space for both groups and the label between them, and the reveal that brings a
 * selection the window has not mounted on screen.
 */
import { useEffect, useRef, type RefObject } from "react";
import type { OhboxRow as OhboxRowGroup } from "@ohmail/client-engine";
import { revealInScroller, useListWindow, type ListWindow } from "../lists/list-window.js";
import type { OhboxListInput, OhboxListModel } from "./types.js";

/** The model's fields the window answers. */
export type OhboxWindowModel = Pick<
  OhboxListModel,
  | "listScrollerRef"
  | "win"
  | "newBase"
  | "newCount"
  | "prevCount"
  | "prevLabelAt"
  | "prevBase"
  | "newFrom"
  | "newTo"
  | "prevFrom"
  | "prevTo"
  | "showNewLabel"
  | "showPrevLabel"
>;

/** The window, and a row's place in its index space. */
export interface OhboxWindow {
  model: OhboxWindowModel;
  windowIndexOf: (rowIdx: number) => number;
}

export function useOhboxWindow(groupedNew: OhboxRowGroup[], groupedPrev: OhboxRowGroup[]): OhboxWindow {
  /**
   * The list is a window over `[New for you, Earlier]`: a mirror window still holds thousands
   * of rows, and grouped `.map(row)` mounted every accepted row — the unbounded cost
   * History was windowed for. The two groups keep their own `role="listbox"` containers, each
   * rendering its share of the window with reserved height above and below. The Ohbox writes no `\Seen` on scroll (read-state is the
   * dwell), so no observer re-scan is needed; the split reader reads `selected` from `all` by
   * id, so a pick survives its row scrolling out. Resurfaced rows are not windowed — a small
   * pinned set rendered whole at the top.
   */
  const listScrollerRef = useRef<HTMLDivElement>(null);
  /**
   * ONE INDEX SPACE FOR BOTH GROUPS AND THE LABEL BETWEEN THEM: "New", its rows, "Earlier", its
   * rows. The label is an item with its own measured height, so it is reserved where it stands
   * instead of appearing and vanishing with the slice — which shifted everything below it by a
   * label each time the window crossed the boundary. `useListWindow` measures whatever carries
   * `data-index`, so both labels and every mounted row are in the sums.
   */
  const newCount = groupedNew.length;
  const prevCount = groupedPrev.length;
  const newBase = newCount > 0 ? 1 : 0;
  const prevLabelAt = newBase + newCount;
  const prevBase = prevLabelAt + (prevCount > 0 ? 1 : 0);
  const win = useListWindow({ scrollerRef: listScrollerRef, count: prevBase + prevCount });
  const clamp = (i: number, hi: number): number => Math.min(Math.max(i, 0), hi);
  const newFrom = clamp(win.start - newBase, newCount);
  const newTo = clamp(win.end - newBase, newCount);
  const prevFrom = clamp(win.start - prevBase, prevCount);
  const prevTo = clamp(win.end - prevBase, prevCount);
  const showNewLabel = newCount > 0 && win.start === 0;
  const showPrevLabel = prevCount > 0 && win.start <= prevLabelAt && win.end > prevLabelAt;
  /** A row's place among `[...groupedNew, ...groupedPrev]`, in the window's own index space. */
  const windowIndexOf = (rowIdx: number): number =>
    rowIdx < newCount ? newBase + rowIdx : prevBase + (rowIdx - newCount);
  return {
    model: {
      listScrollerRef,
      win,
      newBase,
      newCount,
      prevCount,
      prevLabelAt,
      prevBase,
      newFrom,
      newTo,
      prevFrom,
      prevTo,
      showNewLabel,
      showPrevLabel,
    },
    windowIndexOf,
  };
}

/** What the reveal reads: the selection, how a row is found, and where it stands in the window. */
export interface RevealParts {
  input: OhboxListInput;
  listScrollerRef: RefObject<HTMLDivElement | null>;
  win: ListWindow;
  rowIndexOf: (id: string | null) => number;
  groupedResurfaced: OhboxRowGroup[];
  windowIndexOf: (rowIdx: number) => number;
}

export function useRevealSelection(parts: RevealParts): void {
  const { input, listScrollerRef } = parts;
  const { selectedId } = input;
  /* Deliberately only the selection: the window's own fields are read at fire time, and re-running on every
     scroll-driven window change would re-scroll the list under the user. A ref carries them to the fire. */
  const atFire = useRef(parts);
  atFire.current = parts;
  /**
   * Reveal a selection the window has not mounted — the search jump's landing. `openMessage`
   * sets the cursor and navigates, but the row only EXISTS if the window mounted it, and the
   * window mounts the top: a hit on anything deeper arrived at a resting list — no row, no
   * flash, nothing connecting click to arrival. Scrolling the scroller is the fix the window is
   * built for: the slice derives from `scrollTop`, so putting the row's offset in view mounts
   * it and the locate pass flashes it. Keyed on the selection, never run on scroll; a mounted
   * row (resurfaced rows always are) is only brought wholly on screen.
   */
  useEffect(() => {
    const { input, win, rowIndexOf, groupedResurfaced, windowIndexOf } = atFire.current;
    if (!selectedId) return;
    /* A MOUNTED ROW IS KEPT ON SCREEN. Nothing scrolled for one: every row the window mounts
       past the fold took `j` off screen while the reader opened it, six presses at a time. */
    const scroller = listScrollerRef.current;
    const rows = scroller ? [...scroller.querySelectorAll<HTMLElement>(input.rowSelector)] : [];
    const mounted =
      rows.find((r) => r.dataset.id === selectedId) ??
      rows.find((r) => (r.dataset.ids ?? "").split(" ").includes(selectedId));
    if (scroller && mounted) {
      revealInScroller(scroller, mounted);
      return;
    }
    const idx = rowIndexOf(selectedId);
    const rowIdx = idx - groupedResurfaced.length;
    if (idx < 0 || rowIdx < 0) return;
    const winIdx = windowIndexOf(rowIdx);
    if (winIdx >= win.start && winIdx < win.end) return;
    const el = listScrollerRef.current;
    if (el) el.scrollTop = Math.max(0, win.offsetOf(winIdx) - el.clientHeight / 2);
  }, [selectedId, listScrollerRef]);
}
