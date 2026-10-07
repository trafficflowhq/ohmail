import type { WorldMail } from "../state/live";

/**
 * WHAT THE READER'S MARK AS READ TAKES — the conversation on screen: the open message if it is
 * still unread, then every member below it not yet seen, in that order, less a resurfaced member
 * (a deliberate read would spend its pin; its row's Done releases it — the web's rule). Empty
 * means nothing is left to read and the slot offers Mark unread (this message alone). The compact
 * bar, the rail and the ⋯ sheet all read this one answer (`MessageActions`).
 */
export function conversationUnreadIds(m: Pick<WorldMail, "id" | "unread" | "earlier">): string[] {
  return [...(m.unread ? [m.id] : []), ...m.earlier.filter((h) => !h.seen && !h.resurfaced).map((h) => h.id)];
}
