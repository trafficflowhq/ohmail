/** THE SQUARES OF A CONVERSATION: one a letter, oldest first. */
import { isOwnOutbound, type EngineMessage } from "@ohmail/client-engine";

export type SquareKindOf = "seen" | "unseen" | "own";

/** Your own letter is hollow whatever its flag; another's is unseen while unread. */
export function squareKindsOf(messages: readonly EngineMessage[]): SquareKindOf[] {
  return messages.map((m) => (isOwnOutbound(m) ? "own" : m.unread ? "unseen" : "seen"));
}
