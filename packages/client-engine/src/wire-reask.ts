/**
 * THE WIRE RE-ASK POLICY, one definition for every read that heals after a drop: the store reads
 * (`session-reask.ts`), the reader's file list (the shell's attachments seam) and the letter's
 * embedded pictures (`OhmailEngine.loadInlineImages`). A leaf, so the engine can import it
 * without the cycle `session-reask` -> `store-timeline` -> `engine` would make.
 */

/** Re-asks per episode of a wire failure: the drain that completed says the server answers, not that this read will. */
export const REASK_MAX = 3;

/**
 * DID THE WIRE FAIL — no answer reached us — rather than the server answer? `network` and `timeout`
 * (the HTTP adapter's codes; `timeout` is also a walker's own ceiling), a bare `TypeError` or
 * `AbortError` from a raw fetch, and `offline_read_only` (the paired desktop's refusal while the
 * account is out of reach). Never a 401 (the session's door) or any other status: those are answers.
 */
export function wireFailed(cause: string | null): boolean {
  if (cause === null) return false;
  const words = cause.split(" ");
  if (words.includes("offline_read_only")) return true;
  if (words.some((w) => /^\d{3}$/.test(w))) return false;
  return words.includes("network") || words.includes("timeout")
    || (words.length === 1 && (words[0] === "TypeError" || words[0] === "AbortError"));
}
