import type { EngineMutation } from "@ohmail/client-engine";

/**
 * `PATCH /messages` accepts at most 200 ids and 413s above that (`packages/api/src/routes/
 * messages.ts` — `MARK_SEEN_MAX_IDS`). Exported so the guard reads the REAL number rather than a
 * hand-copied duplicate that could drift green.
 */
export const MARK_SEEN_CHUNK = 200;

/**
 * Dispatch "mark all read" as CHUNKED bulk `mark_seen` mutations — at most {@link MARK_SEEN_CHUNK}
 * ids per mutation, so no single `PATCH /messages` can exceed the route's cap. Each `engine.mutate`
 * mints its OWN Idempotency-Key (`OhmailEngine.mutate`), so a chunk whose response is lost is
 * replayed under the same key and never double-applies. The read state reaches `\Seen` on the
 * user's IMAP via the worker's flag reconciler; the API never opens an IMAP connection itself.
 *
 * `unread: false` is the read direction. Ids are flipped optimistically by the folder-agnostic
 * `mark_seen` mutation (`client-engine/mutations.ts`), which flips exactly the ids it is given.
 *
 * Returns the number of chunks dispatched — the guard asserts `ceil(ids / 200)`.
 */
export function dispatchMarkAllRead(mutate: (m: EngineMutation) => unknown, ids: readonly string[]): number {
  return dispatchMarkAll(mutate, ids, false);
}

/**
 * The same chunked dispatch, direction as an argument — the UNREAD direction is the undo the
 * mark-all toast offers. One walk for both directions, so the undo can never diverge from the
 * write it reverses: same chunk size, same mutation kind, the exact ids that were flipped.
 */
export function dispatchMarkAll(
  mutate: (m: EngineMutation) => unknown,
  ids: readonly string[],
  unread: boolean,
): number {
  let chunks = 0;
  for (let i = 0; i < ids.length; i += MARK_SEEN_CHUNK) {
    void mutate({ kind: "mark_seen", messageIds: ids.slice(i, i + MARK_SEEN_CHUNK), unread });
    chunks++;
  }
  return chunks;
}
