/**
 * THE ID A WIRE'S ANSWER NAMED. Moved here as it stood from `subject.ts`, which still names it: this file imports
 * types only, so a page that holds no engine (the phone's door) can read a wire's answer.
 */
import type { MailboxId } from "./types.js";

/** An id as a path holds it: letters, digits and the four marks percent-encoding leaves as they are. */
const PLAIN_ID = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,127}$/;

/**
 * FOR A SHELL'S WIRE ADAPTER: the id a wire's answer named, or `null`. An id that percent-encoding would change, a
 * name of dots, or anything that is no string is no id, so none can reach a path.
 */
export function mailboxIdOfAnswer(raw: unknown): MailboxId | null {
  if (typeof raw !== "string" || !PLAIN_ID.test(raw) || /^\.+$/.test(raw)) return null;
  return encodeURIComponent(raw) === raw ? (raw as MailboxId) : null;
}
