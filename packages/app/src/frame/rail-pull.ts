import { useContext, useSyncExternalStore } from "react";
import { FrameContext } from "./commands.js";
import type { RailModel } from "./contract.js";

const NO_RAIL = { read: (): RailModel | null => null, subscribe: (_told: () => void) => () => {} };

/** The frame's one pull, as the host's rail model holds it; null outside a frame or where the host has none. */
export function useFramePull(): RailModel["pull"] {
  const rail = useContext(FrameContext)?.rail ?? NO_RAIL;
  return useSyncExternalStore(rail.subscribe, rail.read, rail.read)?.pull ?? null;
}
