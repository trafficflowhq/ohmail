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

/**
 * THE HELD SHEET'S FOOTER. Over a send the server could not confirm, with the row that holds it
 * known, the sheet offers Send again on that row (the server looks in Sent first) and Close, which
 * leaves the message in Drafts. Send again is locked while its press runs. Without a known row the
 * sheet keeps Send, whose press says why nothing went again.
 */
export function heldSheetFooter(s: {
  phase: "idle" | "sending" | "queued" | "unverified";
  heldId: string | null;
  busy: boolean;
}): { close: "close" | "cancel"; sendAgain: { draftId: string; locked: boolean } | null } {
  if (s.phase !== "unverified") return { close: "cancel", sendAgain: null };
  return { close: "close", sendAgain: s.heldId === null ? null : { draftId: s.heldId, locked: s.busy } };
}
