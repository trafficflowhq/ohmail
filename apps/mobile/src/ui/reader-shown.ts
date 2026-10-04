/**
 * WHICH MESSAGE THE READER PUTS ON TOP. An Ohbox row opens its conversation at the member it chose
 * (its latest unread, which the open reads); the reader showed that member first, so a conversation
 * whose newest reply carried the file opened at its first message and Forward took that one. Opened
 * from its Ohbox row, the reader shows the conversation's newest message, as the web's reader puts
 * the newest on top, and its verbs act on what it shows. A message opened on its own (search, a
 * folder, a link) shows itself. `newestInConversation` is `liveMessage`'s, from the engine's thread.
 */
export function readerShownId(
  opened: { id: string; newestInConversation?: string }, asConversation: boolean,
): string {
  return asConversation && opened.newestInConversation !== undefined ? opened.newestInConversation : opened.id;
}
