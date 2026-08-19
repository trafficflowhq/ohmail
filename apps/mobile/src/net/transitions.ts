/**
 * THE TRANSITION GATE — connection transitions run one at a time, and the last request wins.
 *
 * Two profile taps overlapping, or a switch racing the launch connect, would run
 * two `connectProfile` flows at once. Each flow builds a BearerManager, and two managers on one
 * profile both hold the family's ONE refresh token — the first 401 on each side presents it
 * twice, and strict reuse (correctly) revokes the whole family. The single-flight inside one
 * manager cannot help across managers, so the serialization has to live where managers are
 * BORN: here.
 *
 * Two guarantees, both load-bearing:
 *
 *  · **one at a time** — a transition starts only after the previous one settled, so two
 *    boots' probes can never present the same token concurrently;
 *  · **last-wins** — a transition requested while an earlier one is queued or running marks
 *    the earlier one stale through its `stillCurrent()` callback. The stale transition still
 *    runs to completion (its manager may already have rotated — abandoning it mid-flight would
 *    lose the fresh token), but the caller checks `stillCurrent()` before ADOPTING: a stale
 *    outcome is torn down, never rendered.
 *
 * React-free on purpose (a ref-shaped object, not a hook) so the node suite drives it directly.
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
