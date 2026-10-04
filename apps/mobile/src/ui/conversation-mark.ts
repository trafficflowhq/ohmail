/**
 * THE MARK A ROW PRESS PUTS ON AN OPEN, and nothing else does. A conversation opened from its Ohbox
 * row is acted on at the row's own target (`reader-shown.ts`); a search hit, a link, a draft's
 * parent or a pane migration of any of them carries no mark, so it is acted on at itself. The mark
 * rides the pushed route's `as` param and the Ohbox pane's, and each migration between the two
 * passes it on as it found it.
 */
export const CONVERSATION = "conversation";

export function isConversationOpen(as: unknown): boolean {
  return as === CONVERSATION;
}

/** The pushed reader's route. */
export function messageRoute(id: string, conversation: boolean): string {
  return conversation ? `/message/${id}?as=${CONVERSATION}` : `/message/${id}`;
}

/** The Ohbox pane's params for an open: always both, so a migration never inherits a stale mark. */
export function paneParams(id: string, conversation: boolean): { open: string; as: string } {
  return { open: id, as: conversation ? CONVERSATION : "" };
}
