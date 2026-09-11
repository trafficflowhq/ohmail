/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT THE CONNECTION LAYER HAS DECIDED — written before the paint, never by it
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every late answer in `net/connection.tsx` asks the same question before it acts: *is this still
 * the session I was working on?* The provider answered it from a ref assigned during RENDER
 * (`live.current = state`), and that is the defect this module exists to end.
 *
 * ── MEASURED ON A DEVICE, AND IT IS NOT A RACE ─────────────────────────────────────────────
 *
 * `setState` from an async body is scheduled by React — a task, not a microtask. On the STANDALONE
 * door the work that follows it settles in microtasks: `verifyIdentity()` returns
 * `{ kind: "unverified" }` immediately (there is no `/auth/session` on an engine in this process),
 * and the roster read is a call into `handle`. So the verdict callback and the consent press BOTH
 * ran before the render that would have set the ref, read `k: "connecting"`, and returned — the
 * verdict as `false`, which skips the first drain for ever, and the press with no sentence
 * anywhere. On a device: `entities 0` in the mirror beside two messages in the engine's own store,
 * and `organize_consented_at` NULL with the whole `ohmail/*` tree never created.
 *
 * It cannot happen on a PAIRED door, which is why every existing arm works: there the identity
 * probe is a real request, so the paint always lands first. And it cannot happen under the node
 * suite either — this workspace has no React Native renderer at all, so the one place React's
 * scheduling decides whether a mailbox syncs was reachable by nothing.
 *
 * ── SO THE DECIDED STATE IS A VALUE THIS LAYER OWNS ────────────────────────────────────────
 *
 * {@link decidedState} holds it and paints second. `now()` is what the layer has decided, which is
 * what a staleness check wants; what is on screen is React's business and no late answer needs it.
 * The order inside `enter` is the whole of the fix and the case that drives it asserts exactly
 * that: the value has moved before `paint` is called, not after.
 */

/** The layer's own record of its state, and the one writer of it. */
export interface DecidedState<S> {
  /** Decide, then paint. A reader between the two sees the DECIDED value. */
  enter(next: S): void;
  /** What this layer has decided. Never "what has been rendered". */
  now(): S;
}

/**
 * Create one. `paint` is the React setter in the app and a recorder in the suite.
 *
 * `paint` may throw without losing the decision: the value is already recorded, so a render that
 * failed leaves the layer knowing what it decided rather than acting on a state it abandoned. The
 * throw is re-raised — a failing renderer is not this module's to swallow.
 */
export function decidedState<S>(initial: S, paint: (next: S) => void): DecidedState<S> {
  let current = initial;
  return {
    enter: (next) => {
      current = next;
      paint(next);
    },
    now: () => current,
  };
}
