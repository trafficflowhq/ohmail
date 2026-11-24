/** The approval's states, one per address of the design's reference (`screen=approve&state=…`). */
import type { ApproveState } from "./door.js";

export const APPROVE_STATES = [
  "ask",
  "othernet",
  "factor",
  "busy",
  "stillbusy",
  "discarded",
  "done",
  "denied",
  "expired",
  "used",
  "none",
  "bare",
  "unchecked",
  "closed",
] as const;
export type ApproveStateId = (typeof APPROVE_STATES)[number];

/** The reference's state a door's state draws; the refusals the shell said are told apart by the reference's test. */
export function approveStateOf(state: ApproveState): ApproveStateId | "checking" | "refused" {
  switch (state.at) {
    case "ask":
      if (state.factor) return "factor";
      if (state.retryIn !== null) return "busy";
      if (state.refusal !== null) return "stillbusy";
      return state.asked.otherNetwork ? "othernet" : "ask";
    case "gone":
      return "expired";
    default:
      return state.at;
  }
}
