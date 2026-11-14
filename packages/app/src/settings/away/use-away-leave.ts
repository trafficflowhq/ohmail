import type { HostAddress } from "../../host/device.js";
import { useDraftLeave } from "../use-draft-leave.js";
import { awayUnsaved, type AwayRules, type AwayState } from "./model.js";

/** The route part of the Away model. The save only releases it when the stored responder confirms the draft. */
export function useAwayLeave(address: HostAddress, state: AwayState, rules: AwayRules, drop: () => void) {
  const dirty = state.draft !== null && state.saved !== null && awayUnsaved(state.draft, state.saved, rules);
  const guard = useDraftLeave(dirty, (ask) => address.holdLeave(ask, "#/settings/away"));
  return {
    ...guard,
    discard: () => {
      drop();
      guard.discard();
    },
  };
}
