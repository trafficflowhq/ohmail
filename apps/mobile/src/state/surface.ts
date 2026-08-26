/**
 * WHAT A LIST SCREEN MAY SHOW WHILE THE MIRROR IS STILL ANSWERING — the unknown≠empty rule,
 * as one pure function every message-list surface renders through.
 *
 * The app boots from its own local mirror (`engine/boot.ts`), so the first frame is content
 * whenever the phone has ever synced. The rule below exists for the frames where it has not:
 *
 *  · **content** — rows exist. They render, even mid-bootstrap: real mail beats a silhouette,
 *    and the engine's rules-first ordering already bounds what a partial replay can misfile.
 *  · **skeleton** — zero rows AND the mirror has never completed a drain. The list is not
 *    empty, it is UNKNOWN, and the screen shows the shape of what is coming
 *    (`ui/Skeleton.tsx`) — never the empty state's "Nothing here", which would be a claim
 *    about mail the app has simply not read yet. This is the same line the webapp's
 *    `SyncState` draws, and the same one the sync interim-state fix established: unknown is
 *    not empty, and unknown is not undecided.
 *  · **empty** — zero rows and the mirror has settled. Now, and only now, emptiness is a
 *    fact and the honest empty state speaks.
 *
 * A meta line is held to the same rule through {@link metaWhen}: "0 unread of 0" over a
 * skeleton would be an invented count — the exact thing the skeleton exists not to be.
 */

export type ListSurface = "content" | "skeleton" | "empty";

export function listSurface(input: {
  /** `mirrorSettled(session.store)` — has ANY drain ever completed over this mirror? */
  settled: boolean;
  /** The rows this screen is about to render (its own total, not the whole mirror's). */
  count: number;
}): ListSurface {
  if (input.count > 0) return "content";
  return input.settled ? "empty" : "skeleton";
}

/**
 * The screen's factual meta line, silenced while the surface is a skeleton. `undefined`
 * rather than an em-dash or a spinner-word: the silhouette already says "not yet", and a
 * second voice saying it again is the reassurance nobody asked for.
 */
export function metaWhen(surface: ListSurface, meta: string): string | undefined {
  return surface === "skeleton" ? undefined : meta;
}
