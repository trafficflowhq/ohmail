import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useSeenOnScroll, type SeenObserver } from "../hooks/useSeenOnScroll.js";
import "./list-pane.css";

export interface ListPaneProps {
  title: string;
  /** Right of the title — "4 unread of 9". */
  meta?: string;
  /** Between header and scroller (doorbell, segmented control, bulk bar). */
  header?: ReactNode;
  /** Scroller content: rows, group labels, waterline, footers. */
  children: ReactNode;
  /** Keyboard hints strip pinned under the scroller. */
  hints?: ReactNode;
  /** Centered standalone column (Tag view). */
  solo?: boolean;
  /**
   * Wire the seen-on-scroll machinery: children carrying [data-unseen]
   * are marked seen (via their data-id) once they fully rise into the
   * top third — but only after the user actually scrolls.
   */
  onSeen?: (id: string) => void;
  /** External scroller ref, if the app drives scrolling itself. */
  scrollerRef?: RefObject<HTMLDivElement>;
  /**
   * RE-SCAN THE SEEN-ON-SCROLL OBSERVER when this value changes.
   *
   * `useSeenOnScroll` observes the rows present when it first runs and never again on its own.
   * That is correct for a list that mounts all its rows at once, and WRONG for a windowed list,
   * whose rows come and go as the window slides: a row that mounts on scroll would never be
   * observed, so it could never mark itself `\Seen` however far the user read past it. A view
   * that windows AND wires `onSeen` passes its window bounds here so the observer re-attaches to
   * the rows actually on screen — the same thing `StreamShell` does for the reading stream via
   * its `contentKey`. Absent ⇒ scan once, the unwindowed behaviour every existing caller had.
   */
  rescanKey?: unknown;
  className?: string;
}

/**
 * The list column shared by Ohbox · Reads · Receipts · Screener · Tag:
 * lift-1 panel, view header, scroller with shadow-falloff clearance.
 * Returns the pane; re-scan for new unseen rows via the returned
 * observer of `useSeenOnScroll` when composing manually.
 */
export function ListPane({
  title,
  meta,
  header,
  children,
  hints,
  solo,
  onSeen,
  scrollerRef,
  rescanKey,
  className,
}: ListPaneProps) {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = scrollerRef ?? internalRef;
  const seen = useSeenOnScroll({
    root: ref,
    onSeen: onSeen ?? (() => {}),
  });
  // Re-attach the observer to the rows a windowed list has just mounted. No-op when `rescanKey`
  // is undefined and constant, so a non-windowed pane observes once exactly as before.
  useEffect(() => {
    if (rescanKey !== undefined) seen.observe();
  }, [seen, rescanKey]);

  const cls = ["list-col", solo ? "solo" : null, className].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <div className="vhead">
        <h1>{title}</h1>
        {meta ? <span className="meta num">{meta}</span> : null}
      </div>
      {header}
      <div className="scroller" ref={ref}>
        {children}
      </div>
      {hints ? <div className="list-hints">{hints}</div> : null}
    </div>
  );
}

/** Group label inside a list scroller ("New", "Earlier", "Today"). */
export function ListGroupLabel({ children }: { children: ReactNode }) {
  return <div className="grouplabel">{children}</div>;
}

/**
 * Row container with the shadow-safe gutter.
 *
 * `multiSelectable` turns it into the listbox that `MessageRow`'s `role="option"` rows need
 * — `aria-selected` on an orphaned option means nothing. Opt-in, and only the Ohbox opts
 * in: a list with no multi-select must not announce itself as one. Give it a label, because
 * a view is normally several of these ("New", "Earlier") and an unlabelled pair of listboxes
 * is worse than none.
 */
export function ListRows({
  children,
  multiSelectable,
  ariaLabel,
}: {
  children: ReactNode;
  multiSelectable?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div
      className="rows"
      {...(multiSelectable ? ({ role: "listbox", "aria-multiselectable": "true" } as const) : {})}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
    >
      {children}
    </div>
  );
}

export type { SeenObserver };
