/**
 * THE WINDOW'S EDGE: where a view reaches days before the first one this device holds, it offers Load
 * earlier. The edge is the held window's own, never today: a view of days the device holds says nothing.
 * Where the host cannot read a span (`load: "none"`), it says so and offers no press.
 */
import { useCallback, useState } from "react";
import { addDays, type DayId } from "./days.js";
import type { HeldEdge } from "./view.js";

/** How far back one press reads, at the least: four weeks before the edge. */
export const EARLIER_DAYS = 28;

export type Earlier =
  | { readonly kind: "none" }
  | {
      readonly kind: "edge";
      /** The first day held. */
      readonly from: DayId;
      /** Null where this host cannot read earlier days. */
      readonly press: (() => void) | null;
      readonly busy: boolean;
      readonly failed: boolean;
    };

/** The span one press reads: from the view's first day (or four weeks back, whichever is earlier) to the day before the edge. */
export const earlierSpan = (edge: DayId, viewFirst: DayId): { from: DayId; to: DayId } => {
  const back = addDays(edge, -EARLIER_DAYS);
  return { from: viewFirst < back ? viewFirst : back, to: addDays(edge, -1) };
};

export function useEarlier(edge: HeldEdge, viewFirst: DayId): Earlier {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const { earlier, load } = edge;
  const press = useCallback(() => {
    if (earlier === null || load === "none") return;
    setBusy(true);
    setFailed(false);
    load(earlierSpan(earlier, viewFirst)).then(
      (ok) => {
        setBusy(false);
        setFailed(!ok);
      },
      () => {
        setBusy(false);
        setFailed(true);
      },
    );
  }, [earlier, load, viewFirst]);
  if (earlier === null || viewFirst >= earlier) return { kind: "none" };
  return { kind: "edge", from: earlier, press: load === "none" ? null : press, busy, failed };
}
