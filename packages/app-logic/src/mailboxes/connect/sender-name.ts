/**
 * THE NAME A MAILBOX'S LETTERS CARRY. Moved here as it stood from the phone's own form, which still names it by its
 * old path: the one connect form asks for the name where a phone organizes its own mailbox, and a rule has one home.
 */

/** The longest sender name a letter carries — the server's own bound. */
export const SENDER_NAME_MAX = 100;

/**
 * A typed sender name as it is stored: whitespace collapsed and trimmed, or `null` when blank. A
 * control character or a name past {@link SENDER_NAME_MAX} is refused (`undefined`), never cut.
 */
export function senderNameOf(text: string): string | null | undefined {
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)) return undefined;
  const name = text.replace(/\s+/g, " ").trim();
  if (name === "") return null;
  return Array.from(name).length > SENDER_NAME_MAX ? undefined : name;
}
