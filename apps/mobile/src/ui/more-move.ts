/**
 * A MORE DESTINATION SHOWN FULL-SCREEN ON TWO PANES (an unfold over Settings, a deep link) moves into
 * More's pane (`app/(tabs)/more.tsx`), the inverse of the reader's move (`pane-move.ts`). `paneKey`
 * null stays: a screen already in a pane, or one that never moves (Search, the rail's own door;
 * Servers, the gate's; the list routes, which are a pair themselves).
 */
import { createElement, Fragment, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { Platform } from "react-native";
import { usePaneMove } from "./pane-move";
import { morePaneRouteFor } from "./pane-routes";
import { usePosture } from "./posture";
import { readerHeldNow, subscribeReaderHeld } from "./reader-held";
import { scaffoldPlan } from "./scaffold/plan";

export function YieldToMore({ paneKey, children }: { paneKey: string | null; children: ReactNode }): ReactElement {
  const plan = scaffoldPlan(usePosture(), Platform.OS === "ios" ? "ios" : "android");
  const held = useSyncExternalStore(subscribeReaderHeld, readerHeldNow);
  const leaving = usePaneMove(paneKey !== null && plan.panes === 2 ? morePaneRouteFor(paneKey) : null, held);
  return leaving ?? createElement(Fragment, null, children);
}
