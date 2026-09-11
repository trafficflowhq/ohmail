/**
 * What the connection layer has decided — written before the paint, never by it. Every late answer
 * in `net/connection.tsx` asks "is this still the session I was working on?", and a ref assigned
 * during render answered it a paint too late. Measured on a device, and not a race: `setState` from
 * an async body is a task, while the standalone door's follow-up settles in microtasks, so the
 * identity verdict and the consent press both read `connecting` and returned — no first drain ever,
 * no consent recorded (a paired door's probe is a real request, so its paint lands first). {@link
 * decidedState} holds the value and paints second; `enter`'s internal order is the whole fix, and
 * the driving test asserts the value has moved before `paint` is called.
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
