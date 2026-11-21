import type { MessageDTO } from "@ohmail/wire";

type InvitationLetter = Pick<MessageDTO, "id" | "subject" | "folder" | "date" | "sortAt" | "invitation">;

/** Invitation letters already held in this account's presented mirror, newest first. */
export function eventLetters<T extends InvitationLetter>(uid: string, messages: readonly T[]): T[] {
  if (!uid) return [];
  const stamp = (message: InvitationLetter) => Date.parse(message.sortAt ?? message.date ?? "") || 0;
  return messages
    .filter((message) => message.invitation?.uid === uid)
    .sort((a, b) => stamp(b) - stamp(a) || a.id.localeCompare(b.id));
}
