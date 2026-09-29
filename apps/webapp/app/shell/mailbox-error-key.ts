/**
 * THE `mailboxes.err_*` KEY A FAILING MAILBOX IS SAID WITH. The code is the class; a detail token
 * outranks it where the sentence differs: a mailbox connected without TLS whose server's address
 * is no longer on the person's own network was never dialled, and neither was one whose stored
 * password this install cannot use — "not available" would be false about both.
 */
export const PLAINTEXT_REFUSED_DETAIL = "MAILBOX_PLAINTEXT_REFUSED";

/** The desktop's own door, derived at read time and never stored (`discloseLocalSyncFailures`). */
const CREDENTIAL_DETAIL_KEYS: ReadonlyMap<string, string> = new Map([
  ["MAILBOX_CREDENTIAL_UNREADABLE", "err_credential_unreadable"],
  ["MAILBOX_CREDENTIAL_FOREIGN_HOST", "err_credential_foreign_host"],
]);

export function mailboxErrorKey(errorCode: string | null, errorDetail?: string | null): string {
  if (errorDetail === PLAINTEXT_REFUSED_DETAIL) return "err_plaintext_refused";
  const credential = errorDetail ? CREDENTIAL_DETAIL_KEYS.get(errorDetail) : undefined;
  if (credential) return credential;
  return errorCode ? `err_${errorCode}` : "syncError";
}
