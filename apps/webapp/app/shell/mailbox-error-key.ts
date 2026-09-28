/**
 * THE `mailboxes.err_*` KEY A FAILING MAILBOX IS SAID WITH. The code is the class; one detail token
 * outranks it because the sentence differs: a mailbox connected without TLS whose server's address
 * is no longer on the person's own network was never dialled, so "not available" would be false.
 */
export const PLAINTEXT_REFUSED_DETAIL = "MAILBOX_PLAINTEXT_REFUSED";

export function mailboxErrorKey(errorCode: string | null, errorDetail?: string | null): string {
  if (errorDetail === PLAINTEXT_REFUSED_DETAIL) return "err_plaintext_refused";
  return errorCode ? `err_${errorCode}` : "syncError";
}
