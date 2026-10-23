"use client";

/**
 * NEWS AND RECEIPTS STAY MOUNTED WHILE THE READER MOVES AMONG THE PILES. A press of 2 or 3 used to
 * mount the whole view again — its list, its stream, every card's viewer and framed document —
 * and a press away threw all of it out. Under React's `<Activity>` a pile the reader left is
 * hidden instead: its DOM, its state and its documents stay, its effects are destroyed (a visit's
 * end, `visit.ts`), and a revisit shows what is already built. A hidden pile keeps receiving its
 * props, at the lowest priority, so it is current when shown.
 *
 * Kept only while the route stays among the piles: the shell keys this component on the pile group
 * and the engine, so leaving for any other view, or a different mailbox, unmounts every kept pile.
 * Each pile has its own boundary — a pile that throws while hidden must not take the visible one
 * down — and a pile that failed is dropped once the reader is elsewhere, so the next visit mounts
 * it fresh, as a boundary keyed on the view always did.
 *
 * `data-pile` marks each pile's DOM and `data-pile-active` the one on screen: a document-wide query
 * in the shell asks `queryVisible` (`visible-dom.ts`), never the raw document, so a hidden pile's
 * row, strip or button is never the one a key presses.
 */
import { Activity, useState, type ReactNode } from "react";
import { ViewBoundary } from "./ViewBoundary";

export type KeptPileName = "reads" | "receipts";
export const KEPT_PILES: readonly KeptPileName[] = ["reads", "receipts"];

const NONE: ReadonlySet<KeptPileName> = new Set();

export function isKeptPile(view: string | null): view is KeptPileName {
  return view === "reads" || view === "receipts";
}

export function KeptPiles({
  active,
  piles,
  onError,
  fallback,
}: {
  /** The pile on screen, or `null` when the route is on another pile of the group (the Ohbox). */
  active: KeptPileName | null;
  /** Each pile's view, built by the shell; mounted only once visited. */
  piles: Record<KeptPileName, ReactNode>;
  onError: (pile: KeptPileName, error: unknown) => void;
  fallback: (pile: KeptPileName, error: unknown) => ReactNode;
}) {
  const [kept, setKept] = useState<ReadonlySet<KeptPileName>>(NONE);
  const [failed, setFailed] = useState<ReadonlySet<KeptPileName>>(NONE);
  /* The visited set follows the route, adjusted in this component's own render. */
  let next = kept;
  if (active !== null && !next.has(active)) next = new Set(next).add(active);
  for (const f of failed) {
    if (f === active || !next.has(f)) continue;
    const less = new Set(next);
    less.delete(f);
    next = less;
  }
  if (next !== kept) setKept(next);
  const gone = [...failed].filter((f) => f !== active && !next.has(f));
  if (gone.length > 0) {
    const left = new Set(failed);
    for (const f of gone) left.delete(f);
    setFailed(left);
  }

  return (
    <>
      {KEPT_PILES.map((p) =>
        next.has(p) ? (
          <div key={p} data-pile={p} data-pile-active={p === active ? "" : undefined} style={{ display: "contents" }}>
            <Activity mode={p === active ? "visible" : "hidden"}>
              <ViewBoundary
                onError={(error) => {
                  onError(p, error);
                  setFailed((s) => (s.has(p) ? s : new Set(s).add(p)));
                }}
                fallback={(error) => fallback(p, error)}
              >
                {piles[p]}
              </ViewBoundary>
            </Activity>
          </div>
        ) : null,
      )}
    </>
  );
}
