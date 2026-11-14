/**
 * WHICH MAILBOX. A route's word is a claim, never an id: {@link subjectOf} answers the account's own row that holds
 * the word, and the id handed on is that row's. An id is minted in one place, where a shell's adapter reads a wire's
 * answer ({@link mailboxIdOfAnswer}, in `mailbox-id.ts`: a file that imports types only).
 */
import { firstRunSubject, type FirstRunSubject } from "../../doors/first-run-subject.js";
import type { MailboxId } from "./types.js";

export { mailboxIdOfAnswer } from "./mailbox-id.js";

/**
 * THE ROW A RUN OR AN OPENED ROW IS ABOUT, by the first run's rule: the word names it; with no word the one row
 * stands in and several ask. A word no row holds is `vanished`, or `pending` on an add run whose facts lag its
 * create: a sentence, no form and no verb. With no rows read, no subject resolves.
 */
export function subjectOf<T extends { readonly id: MailboxId }>(
  rows: readonly T[] | null,
  word: string | null,
  how: "run" | "add",
): FirstRunSubject<T> {
  return firstRunSubject(rows, word, how === "add");
}
