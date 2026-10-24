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
import * as React from "react";
import { useState, type ComponentType, type ReactNode } from "react";
import { ViewBoundary } from "./ViewBoundary";

/* NEVER A NAMED IMPORT OF `Activity`. Next 15.5's App Router renders the web app with its own vendored
   React (19.2.0-canary), which exports no `Activity`: the named import was undefined in the web bundle
   and the first press of News or Receipts threw React #130 (0.30.2). Its react-dom does render Activity
   (the element type is `Symbol.for("react.activity")`, the value the export is), so where the export is
   missing the type is taken by that name, and the piles stay mounted on the web as on the desktop. A
   React before 19.2 has no such renderer: there only the pile on screen is mounted.
   `kept-piles-next-react.test.tsx` renders this file under the vendored React. */
const Activity = (Reflect.get(React, "Activity") ??
  (/^(19\.([2-9]|\d{2,})|[2-9]\d)\./.test(React.version) ? Symbol.for("react.activity") : undefined)) as
  | ComponentType<{ mode: "visible" | "hidden"; children?: ReactNode }>
  | undefined;

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
        next.has(p) && (Activity !== undefined || p === active) ? (
          <div
            key={p}
            data-pile={p}
            data-pile-active={p === active ? "" : undefined}
            inert={p !== active}
            style={{ display: "contents" }}
          >
            <Keep visible={p === active}>
              <ViewBoundary
                onError={(error) => {
                  onError(p, error);
                  setFailed((s) => (s.has(p) ? s : new Set(s).add(p)));
                }}
                fallback={(error) => fallback(p, error)}
              >
                {piles[p]}
              </ViewBoundary>
            </Keep>
          </div>
        ) : null,
      )}
    </>
  );
}

function Keep({ visible, children }: { visible: boolean; children: ReactNode }) {
  return Activity ? <Activity mode={visible ? "visible" : "hidden"}>{children}</Activity> : <>{children}</>;
}
