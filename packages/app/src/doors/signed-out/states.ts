/** The signed-out page's states, one per address of the design's reference (`screen=signedout&state=…`). */
import type { SignedOutState } from "./door.js";

export const SIGNED_OUT_STATES = [
  "out",
  "unchecked",
  "checking",
  "revoked",
  "pending",
  "expired",
  "absent",
  "reused",
  "busy",
] as const;
export type SignedOutStateId = (typeof SIGNED_OUT_STATES)[number];

export function signedOutStateOf(state: SignedOutState): SignedOutStateId {
  return state.at === "signedOut" ? state.reason : state.at;
}
