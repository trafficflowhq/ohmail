/** The delete page's states, one per address of the design's reference (`screen=deleteaccount&state=…`). */
import type { DeleteAccountDoor } from "./door.js";

export const DELETE_ACCOUNT_STATES = [
  "facts",
  "typed",
  "factor",
  "erasing",
  "done",
  "donepay",
  "donetab",
  "refused",
  "refusedsub",
  "unconfirmed",
  "cancelled",
  "window",
  "own",
  "signedout",
] as const;
export type DeleteAccountStateId = (typeof DELETE_ACCOUNT_STATES)[number];

/** The reference's state a door draws; the refusals the shell said are told apart by the reference's test. */
export function deleteAccountStateOf(
  door: DeleteAccountDoor,
): DeleteAccountStateId | "checking" | "unchecked" | "settle" {
  const { state } = door;
  switch (state.at) {
    case "form":
      if (state.factor) return "factor";
      if (state.busy) return "erasing";
      if (state.cancelled) return "cancelled";
      if (state.refusal !== null) return "refused";
      if (state.typed.trim().toLowerCase() === state.email.toLowerCase()) return "typed";
      return door.service === "self" ? "own" : "facts";
    case "done":
      if (state.subscription === "cancel_failed") return "donepay";
      return state.unclean ? "donetab" : "done";
    case "refused":
      return "settle";
    default:
      return state.at;
  }
}
