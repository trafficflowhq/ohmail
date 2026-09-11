/**
 * What a list screen may show while the mirror is still answering — the unknown≠empty rule as one
 * pure function every message-list surface renders through. content: rows exist and render, even
 * mid-bootstrap — real mail beats a silhouette. skeleton: zero rows AND the mirror has never
 * completed a drain — the list is unknown, not empty, so the screen shows the shape of what is
 * coming (`ui/Skeleton.tsx`), never "Nothing here", which would be a claim about mail the app has
 * not read yet (the webapp's `SyncState` line). empty: zero rows and the mirror has settled — now
 * emptiness is a fact and the honest empty state speaks. A meta line is held to the same rule
 * through {@link metaWhen}: "0 unread of 0" over a skeleton would be an invented count.
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
