/** THE SQUARES OF A CONVERSATION: one a letter, oldest first. */
import type { EngineMessage } from "@ohmail/wire";
import { isOwnOutbound, isResurfaced } from "@ohmail/client-engine";

export type SquareKindOf = "seen" | "unseen" | "own";

/** Mark unread is offered on a letter that is read and is somebody else's: the account's own is never unread. */
export const mayMarkUnread = (m: EngineMessage): boolean => !m.unread && !isOwnOutbound(m);

/** A letter that came back to the top: its read is its release, which its list's row offers as Done. */
export const readIsItsRelease = (m: EngineMessage): boolean => isResurfaced(m);

/** Your own letter is hollow whatever its flag; another's is unseen while unread. */
export function squareKindsOf(messages: readonly EngineMessage[]): SquareKindOf[] {
  return messages.map((m) => (isOwnOutbound(m) ? "own" : m.unread ? "unseen" : "seen"));
}
