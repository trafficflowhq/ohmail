/** The desktop link's states, one per address of the design's reference (`screen=linkdesktop&state=…`). */
import type { LinkDesktopState } from "./door.js";

export const LINK_DESKTOP_STATES = [
  "start",
  "code",
  "factor",
  "cancelled",
  "busy",
  "stillbusy",
  "signin",
] as const;
export type LinkDesktopStateId = (typeof LINK_DESKTOP_STATES)[number];

export function linkDesktopStateOf(
  state: LinkDesktopState,
): LinkDesktopStateId | "checking" | "unchecked" | "refused" {
  if (state.at !== "start" && state.at !== "code") return state.at;
  if (state.factor) return "factor";
  if (state.retryIn !== null) return "busy";
  if (state.discarded) return "cancelled";
  if (state.signIn) return "signin";
  if (state.refusal !== null) return "stillbusy";
  return state.at;
}
