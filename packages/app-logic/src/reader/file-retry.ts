/**
 * WHETHER A FILE, OR A LETTER'S LIST OF FILES, THAT DID NOT ARRIVE MAY BE ASKED FOR AGAIN. One answer for the tile
 * that offers the press, the door that re-asks on a later open, and the look that offers Try again.
 */
import type { OhmailEngine } from "@ohmail/client-engine";

/** One file of a letter, as the engine lists it. */
type AttachmentItem = Extract<ReturnType<OhmailEngine["attachmentsOf"]>, { state: "ready" }>["items"][number];

/**
 * Is this list failure the SESSION's, not the content's? The engine carries the server's own `code` through
 * unmodified (`AttachmentsOutcome`), and these are the two the auth middleware mints: `unauthorized` for a session it
 * will not serve, `csrf_failed` for a live-looking session whose double-submit token lapsed with it. Both mean "the
 * mail is fine, the session is not" — a different sentence AND a different remedy from every other failure here.
 * Declared here, beside neither reader: the strip draws its sentence by it and the file door escalates the same
 * codes to the session probe, so the two cannot drift, and neither imports the other.
 */
export function isAuthListFailure(code: string | null): boolean {
  return code === "unauthorized" || code === "csrf_failed";
}

/**
 * DOES THIS FAILURE GET A "TRY AGAIN"? — and therefore: may anything ask again on its own?
 *
 * One predicate for two decisions that must never disagree. The strip's row offers the press when
 * this is true; the file door re-asks on a later open when it is true and keeps the
 * refusal standing when it is false. A failure with no press is one the server ANSWERED — not
 * this account's message, no such message — and re-asking it on every open polls a refusal that
 * cannot change. `retryable` is the server's flag; the auth arm overrides it for the reason the
 * row's own comment gives.
 */
export function listRetryIsOffered(code: string | null, retryable: boolean): boolean {
  return retryable || isAuthListFailure(code);
}

/**
 * MAY A FAILED FILE BE ASKED FOR AGAIN? The list's predicate, so the two never disagree: the
 * refusal's own `retryable` (absent reads as a throw nothing classified, which is retryable), and
 * the session arm, whose refusal expires with the session. The strip's tile, the shell's press
 * and the overlay's Try again all read this.
 */
export function fileRetryIsOffered(item: Pick<AttachmentItem, "code" | "retryable">): boolean {
  return listRetryIsOffered(item.code ?? null, item.retryable !== false);
}
