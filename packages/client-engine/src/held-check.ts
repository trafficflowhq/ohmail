import type { HeldCheck } from "@trafficflow/core/sender-headers";
import type { EngineMessage } from "./types.js";

/**
 * A HELD LETTER'S IDENTITY COLUMN AS A PRESS READS IT (`heldMovesOnPress`, pinned to the server's
 * `heldRowMovesOnPress`): `null` is checked clean, absent never checked, a claim a claim. An
 * `unverified` line is no claim: the column under it is checked clean, or never written
 * (`unchecked`). Any other reason reads as a claim, the reading that moves the fewest letters.
 */
export function heldCheckOf(c: EngineMessage["senderCheck"]): HeldCheck {
  if (c === null) return "none";
  if (c === undefined) return "unchecked";
  if (c.reason === "unverified") return c.unchecked === true ? "unchecked" : "none";
  return "claim";
}
