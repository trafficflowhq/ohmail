import type { EngineMessage } from "@ohmail/client-engine";

/**
 * WHICH MESSAGE THE BAR'S FORWARD TAKES. A conversation opened from its Ohbox row is focused on the
 * member the row chose (its latest unread, which the open reads), while the reader puts the NEWEST
 * message on top (`MessagePane`'s anchor: the last panel of `threadOf`, oldest first); the bar and
 * `⇧F` forward that newest one. A message opened on its own (search, a folder, a link) stays the
 * target, and each panel's own Forward names its panel, so the bar and that panel always agree.
 */
export function barForwardTarget(
  opened: EngineMessage, conversation: readonly EngineMessage[], asConversation: boolean,
): EngineMessage {
  return asConversation && conversation.length > 1 ? conversation[conversation.length - 1]! : opened;
}
