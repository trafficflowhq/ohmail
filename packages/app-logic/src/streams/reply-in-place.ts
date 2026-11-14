import type { EngineMessage } from "@ohmail/wire";
import { isOwnOutbound } from "@ohmail/client-engine";
import type { SendPhase } from "../writing/mail-send.js";

/**
 * WHICH PILE LETTER HOSTS THE OPEN EDITOR: the reply's target when the pile holds it, else the pile
 * letter in the target's conversation (a panel's own Reply, on the reader's reply). `prefer` picks
 * among several (a letter already in place); `null` when the pile holds none of it. The shell asks
 * the same function whether a press may skip the reader sheet.
 */
export function streamHostOf(
  replyTo: string | null,
  pileHas: (id: string) => boolean,
  conversationOf: (id: string) => readonly EngineMessage[],
  prefer?: (id: string) => boolean,
): string | null {
  if (replyTo === null) return null;
  if (pileHas(replyTo)) return replyTo;
  const held = conversationOf(replyTo)
    .filter((m) => pileHas(m.id))
    .map((m) => m.id);
  return (prefer ? held.find(prefer) : undefined) ?? held[0] ?? null;
}

/**
 * Does a letter that is no longer the host stay in place: an own reply joined its conversation
 * since it entered (`members`), or one of its sends is neither idle nor failed.
 */
export function keepInPlace(
  conversation: readonly EngineMessage[],
  members: readonly string[],
  phases: readonly SendPhase[],
): boolean {
  if (conversation.some((m) => isOwnOutbound(m) && !members.includes(m.id))) return true;
  return phases.some((p) => p !== "idle" && p !== "failed");
}
