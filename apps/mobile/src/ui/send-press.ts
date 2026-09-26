/**
 * WHAT A PRESS ON SEND DOES, by the composer's state — one reader for Send and Send + Done.
 *
 * Over an unconfirmed send the press is neither a second copy nor a dead button: the server could
 * not say whether the first one left, so a fresh send could reach the recipient twice, and the
 * press answers with why nothing was sent again (`again`). Sending, and a queued send the engine
 * is still retrying under its own key, keep the press locked.
 */
export type SendPress = "send" | "needContent" | "again" | "none";

export function sendPressAct(s: {
  canSend: boolean;
  contentOnlyMissing: boolean;
  phase: "idle" | "sending" | "queued" | "unverified";
}): SendPress {
  if (s.canSend) return "send";
  if (s.contentOnlyMissing) return "needContent";
  if (s.phase === "unverified") return "again";
  return "none";
}
