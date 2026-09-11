/**
 * The transition gate — connection transitions run one at a time, and the last request wins. Two profile taps
 * overlapping, or a switch racing the launch connect, would run two `connectProfile` flows at once; each builds a
 * BearerManager, two managers on one profile present the family's one refresh token twice, and strict reuse
 * (correctly) revokes the family. The single-flight inside one manager cannot help across managers, so serialization
 * lives where managers are born. Two guarantees: one at a time (a transition starts only after the previous settled),
 * and last-wins — a superseded transition still runs to completion (its manager may already have rotated; abandoning
 * it mid-flight loses the fresh token), but the caller checks `stillCurrent()` before adopting: a stale outcome is
 * torn down, never rendered. React-free on purpose, so the node suite drives it directly.
 */
export class TransitionGate {
  private epoch = 0;
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * Queue `op` behind every earlier transition. `stillCurrent()` answers whether a newer
   * transition has been REQUESTED since this one — checked by the op before any adoption.
   * A rejection propagates to this op's caller and does not block the queue.
   */
  run<T>(op: (stillCurrent: () => boolean) => Promise<T>): Promise<T> {
    const mine = ++this.epoch;
    const current = () => this.epoch === mine;
    const run = this.chain.then(
      () => op(current),
      () => op(current),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }
}
