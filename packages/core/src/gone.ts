/**
 * A gone locator is one fact with three readings, and the default is not "failed".
 * `MessageGoneError` says one thing: the locator no longer names this message on this server. (1)
 * RE-RESOLVABLE — still there under a different UID; adoption keys on identity. (2) DEFERRABLE —
 * cannot yet tell; the ORDINARY case. (3) TERMINAL — requires POSITIVE evidence; never assumed.
 * Per seam: a READ may re-resolve and retry; a MUTATION may NOT — it persists the INTENT, and the
 * organizer re-adopts by identity; a refusal names the true state. Recognised by `code`, not
 * `instanceof`: services must not import the imap adapter; {@link MESSAGE_GONE_CODE} is the
 * single spelling. A LEAF: no imports.
 */

/**
 * `MessageGoneError.code`. Declared here rather than in the adapter so that the class and every
 * duck-typed consumer are built from one string — a second spelling is a predicate that silently
 * stops matching, which reads exactly like "this never happens".
 */
export const MESSAGE_GONE_CODE = "EMSGGONE";

/**
 * Is this the adapter's "not at that locator any more" refusal?
 *
 * True for `MessageGoneError` from any adapter — the real IMAP one, a fake, a GreenMail-backed
 * double — because the check is on the carried `code` and not on the class identity.
 */
export function isMessageGone(err: unknown): boolean {
  return typeof err === "object" && err !== null
    && (err as { code?: unknown }).code === MESSAGE_GONE_CODE;
}
