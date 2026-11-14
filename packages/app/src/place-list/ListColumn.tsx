/**
 * A list place's column: its head, then its own scroller; on a phone's width the rows lie on one sheet. Every list
 * beside the reading column stands in it (the list places, the streams, the piles, Drafts).
 */
import { useCallback, useEffect, useRef, type ReactNode, type Ref } from "react";
import { Sheet } from "@ohmail/ui/mail";
import type { LayoutPlan } from "../frame/contract.js";
import "./place-list.css";

/** A letter's row under the column's scroller, by the id it carries (never an id spelled into a selector). */
function rowOf(scroller: HTMLElement, id: string): HTMLElement | null {
  for (const row of scroller.querySelectorAll<HTMLElement>("[role=option][data-id]"))
    if (row.dataset.id === id) return row;
  return null;
}

/**
 * THE CURSOR's ROW STAYS IN VIEW, AND THE KEYBOARD GOES WITH IT: a step by key scrolls nothing by itself, so the row
 * the cursor went to is brought to the nearest edge; a keyboard that stood on a row of this list, or on the list
 * itself, moves to that row. Focus anywhere else (a field, the reading column, the page) is never taken.
 */
function useCursorRowInView(
  cursor: string | null,
  scroller: { readonly current: HTMLDivElement | null },
): void {
  useEffect(() => {
    const el = scroller.current;
    if (cursor === null || el === null) return;
    const row = rowOf(el, cursor);
    if (row === null) return;
    if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    const held = el.ownerDocument.activeElement;
    if (!(held instanceof HTMLElement) || held === row) return;
    if (held === el || (el.contains(held) && held.matches("[role=option][data-id]")))
      row.focus({ preventScroll: true });
  }, [cursor, scroller]);
}

export function ListColumn({
  head,
  plan,
  label,
  cursor = null,
  rootRef,
  scrollerRef,
  children,
}: {
  head: ReactNode;
  plan: LayoutPlan;
  /** Names the column as a region, where the place has no other name for it. */
  label?: string;
  /** The cursor's row among the column's rows, where the list walks by key: kept in view, the keyboard with it. */
  cursor?: string | null;
  rootRef?: Ref<HTMLDivElement>;
  scrollerRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  /* The column's own hold of its scroller, beside the one a place asks for. */
  const setScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el;
      if (typeof scrollerRef === "function") scrollerRef(el);
      else if (scrollerRef) scrollerRef.current = el;
    },
    [scrollerRef],
  );
  useCursorRowInView(cursor, scroller);
  return (
    <div
      className="pl-list"
      ref={rootRef}
      role={label === undefined ? undefined : "region"}
      aria-label={label}
    >
      {head}
      <div className="pl-scroll" ref={setScroller} tabIndex={-1}>
        {plan.device === "phone" ? (
          <div className="pl-page">
            <Sheet kind="plain">{children}</Sheet>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
