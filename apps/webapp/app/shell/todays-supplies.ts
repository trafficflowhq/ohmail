/**
 * WHAT EVERY SHELL HANDS THE FRAME, the same on all three browsers: today's places, no stage of its own, the address
 * bar and the window as the browser has them, the look the old theme stands under, and the entry's way back.
 * Made once per mount: the address and the window read `window`, so never at module scope.
 */
import { useLayoutEffect, useMemo, useState } from "react";
import { createFeed, NONE, type FrameSupplies, type HostSession } from "@ohmail/app/host";
import type { FrameOvers, FrameStages } from "@ohmail/app/frame";
import { browserWindowFacts, fragmentAddress } from "@ohmail/app/host/browser";
import { useOptionalTheme } from "@ohmail/ui";
import { todaysPlaces } from "./todays-places";

/** Today's first run is the adapter's own, held with `commands.hold`: no stage is registered yet. */
const NO_STAGE: FrameStages = { firstRun: NONE };
/** The palette and the key sheet are today's shell's own until their entries are handed here. */
const NO_OVER: FrameOvers = { palette: NONE, keys: NONE };

export function useTodaysSupplies(recover: HostSession["recover"]): FrameSupplies {
  /* The look the old theme provider stands under; a mount with none stands in paper, light. */
  const theme = useOptionalTheme();
  const face = theme?.face ?? "paper";
  const scheme = theme?.resolved ?? "light";
  const look = { face, scheme } as const;
  const [made] = useState(() => ({
    places: todaysPlaces(),
    address: fragmentAddress(window),
    window: browserWindowFacts(window),
    appearance: createFeed(look, (a, b) => a.face === b.face && a.scheme === b.scheme),
  }));
  useLayoutEffect(() => made.appearance.set({ face, scheme }), [made, face, scheme]);
  /* No calendar is seated yet: its entry is handed in by the seating step. */
  return useMemo(() => ({ ...made, stages: NO_STAGE, overs: NO_OVER, calendar: NONE, recover }), [made, recover]);
}
