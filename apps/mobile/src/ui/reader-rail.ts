/**
 * The reader's claim on the right-edge rail (the unfolded-landscape Duo). While a message is
 * open there, the ONE rail carries the reader's verbs instead of the destinations — no
 * control renders twice — so the tab bar's nav yields and the list-detail
 * surface renders these groups in its place. A module store rather than context because the
 * two sides live in different trees (the navigator's tab-bar slot, the screen), and a
 * posture change must never remount either to move the claim.
 */
import { useSyncExternalStore } from "react";
import type { RailAction } from "./glass/GlassRail";

let claim: { groups: RailAction[][] } | null = null;
const listeners = new Set<() => void>();

/** The reader publishes on mount/update in rail mode and MUST publish null on unmount. */
export function publishReaderRail(groups: RailAction[][] | null): void {
  claim = groups === null ? null : { groups };
  for (const l of listeners) l();
}

export function readerRailClaim(): { groups: RailAction[][] } | null {
  return claim;
}

export function useReaderRail(): { groups: RailAction[][] } | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    readerRailClaim,
    readerRailClaim,
  );
}
