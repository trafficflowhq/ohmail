/**
 * HOW MANY FACES A KNOCK SHOWS — `packages/ui/src/composites/Doorbell.tsx`'s rule, and its own
 * reason: the count lives in the LABEL, the stack is a texture, not a census.
 *
 * The phone's doorbell drew one circle per waiting sender, so an account with 351 waiting drew
 * 351 letters and pushed the sentence and "Screener" off the right-hand edge. Four faces still
 * read as "some people are waiting" on the narrowest phone and leave room for the sentence that
 * says how many.
 *
 * Dependency-free so the suite can drive it without a renderer.
 */
export const DOORBELL_MAX = 4;

/** The faces the capsule draws, and how many senders they stand in for. */
export interface DoorbellStack {
  shown: readonly string[];
  /** 0 hides the counter; the aria label still names the full count. */
  overflow: number;
}

/**
 * `Math.max(0, …)` so `max={0}` — or a negative — degrades to "no faces, just the count" rather
 * than to `slice(0, -1)`, which would silently drop exactly one sender. The web's own note.
 */
export function doorbellFaces(initials: readonly string[], max: number = DOORBELL_MAX): DoorbellStack {
  const shown = initials.slice(0, Math.max(0, max));
  return { shown, overflow: initials.length - shown.length };
}
