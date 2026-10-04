/**
 * WHICH MESSAGE THE READER SHOWS AND ACTS ON. Opened from its Ohbox row (the conversation mark,
 * `conversation-mark.ts`), the row's own target as the engine answers it (`rowOpenTarget`, attached
 * by the world projection): the message the row opened, never our own automatic answer, a calendar
 * acknowledgement or mail held or filed elsewhere. Any other open — a search hit, a link, a draft's
 * parent — shows the message it opened. The reader takes this once per open.
 */
export function readerShownId(
  opened: { id: string; rowOpenTarget?: string }, asConversation: boolean,
): string {
  return asConversation && opened.rowOpenTarget !== undefined ? opened.rowOpenTarget : opened.id;
}
