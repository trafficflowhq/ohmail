/**
 * What a list screen may show while its rows are still unknown — the unknown≠empty rule as one
 * pure function every message-list surface renders through. content: rows exist and render, even
 * mid-bootstrap — real mail beats a silhouette. skeleton: zero rows and no drain has ever
 * completed, so the screen shows the shape of what is coming, never "Nothing here". pending: zero
 * rows over a SETTLED mirror this screen cannot speak for — the cutline answer is in flight and
 * the lists it decides were withheld rather than guessed wide — so the silhouette carries a
 * sentence naming what is missing. empty: zero rows and nothing outstanding, so emptiness is a
 * fact and the honest empty state speaks. The meta line follows, through {@link metaWhen}.
 */

export type ListSurface = "content" | "skeleton" | "empty" | "pending";

export function listSurface(input: {
  /** `mirrorSettled(session.store)` — has ANY drain ever completed over this mirror? */
  settled: boolean;
  /** The rows this screen is about to render (its own total, not the whole mirror's). */
  count: number;
  /**
   * Is THIS list withheld for want of the account's cutline answer
   * ({@link ListSurface} `pending`) — `WorldScreener.waitingPending`, `WorldHistory.pending`.
   * Absent ⇒ `false`, which is every list the answer does not decide.
   */
  pending?: boolean;
}): ListSurface {
  if (input.count > 0) return "content";
  if (!input.settled) return "skeleton";
  return input.pending === true ? "pending" : "empty";
}

/**
 * The screen's factual meta line, silenced while the surface is a skeleton — and while it is
 * pending, for the same reason one step further on: "0 first-time senders waiting" over a shelf
 * this phone withheld is not a small count, it is the wrong one. `undefined` rather than an
 * em-dash or a spinner-word: the silhouette already says "not yet", and a second voice saying it
 * again is the reassurance nobody asked for.
 */
export function metaWhen(surface: ListSurface, meta: string): string | undefined {
  return surface === "skeleton" || surface === "pending" ? undefined : meta;
}
