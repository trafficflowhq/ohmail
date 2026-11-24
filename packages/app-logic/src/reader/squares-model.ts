/** THE SQUARES OF A CONVERSATION: one a letter, oldest first. */
import type { EngineMessage } from "@ohmail/wire";
import { isOwnOutbound, isResurfaced, threadMarkOf } from "@ohmail/client-engine";

export type SquareKindOf = "seen" | "unseen" | "own";

/** Mark unread is offered on a letter that is read and is somebody else's: the account's own is never unread. */
export const mayMarkUnread = (m: EngineMessage): boolean => !m.unread && !isOwnOutbound(m);

/** A letter that came back to the top: its read is its release, which its list's row offers as Done. */
export const readIsItsRelease = (m: EngineMessage): boolean => isResurfaced(m);

const SQUARE: Record<ReturnType<typeof threadMarkOf>, SquareKindOf> = {
  read: "seen",
  unread: "unseen",
  mine: "own",
};

export function squareKindsOf(messages: readonly EngineMessage[]): SquareKindOf[] {
  return messages.map((m) => SQUARE[threadMarkOf(m)]);
}
