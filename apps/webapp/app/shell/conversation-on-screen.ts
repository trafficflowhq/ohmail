import { threadOf, type EngineMessage, type EntityReader } from "@ohmail/client-engine";

/**
 * THE CONVERSATION A PANEL SHOWS — read off the PRESENTED mirror, the reader the Ohbox rows come
 * from, so a reply the presentation holds (an undecided sender's mail still physically in INBOX, a
 * screened-out rule not yet carried out) is in no panel and no attachment ask, as on the phone. A
 * message the presentation does not hold (a History row, one inside its undo window) reads the raw
 * mirror, the phone's own fallback (`live.ts`). Pins are `winningStates`' on either reader.
 */
export function conversationOnScreen(presented: EntityReader, raw: EntityReader, messageId: string): EngineMessage[] {
  return threadOf(presented.get<EngineMessage>("message", messageId) ? presented : raw, messageId);
}
