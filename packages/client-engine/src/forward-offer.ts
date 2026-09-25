/**
 * FORWARD IS ALWAYS OFFERED on a message a person can read — one predicate for every surface
 * (the stream card, the pane's bar and menu, the keyboard, the phone). Two facts change what a
 * PRESS does, never whether the verb is there: a `no_forward` message asks once, naming why it
 * was flagged, and a message the local mirror does not hold has its body fetched first. The send
 * carries `forwardConfirmed` after the ask; the server refuses a `no_forward` forward without it.
 */
import type { EngineMessage } from "./types.js";

/** Why the ask names the message: its sensitivity category, or the flag alone. */
export type ForwardAsk = "otp" | "verification" | "password_reset" | "security_alert" | "sensitive";

export interface ForwardPress {
  /** The one-sentence reason to confirm before the forward opens; `null` opens it at once. */
  ask: ForwardAsk | null;
  /** The mirror does not hold this row: fetch its body (the reader's door) before opening. */
  fetch: boolean;
}

/** Is Forward offered? For every message on screen — a `no_forward` or off-mirror row included. */
export function forwardOffered(message: Pick<EngineMessage, "id"> | null | undefined): boolean {
  return message != null;
}

/** What a Forward press does first. `held` is the mirror's answer; absent reads as held. */
export function forwardPress(
  message: Pick<EngineMessage, "sensitivity">,
  held?: boolean,
): ForwardPress {
  const s = message.sensitivity;
  return {
    ask: s?.no_forward === true ? (s.category ?? "sensitive") : null,
    fetch: held === false,
  };
}
