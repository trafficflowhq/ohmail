/**
 * The transition gate — connection transitions run one at a time, and the last request wins. The bearer manager is
 * no longer born here: `bearer-registry.ts` holds one per pairing slot for the process, so two overlapping connects of
 * one profile share one manager and one single-flight rotation. What the gate still orders is the connection state.
 * Two guarantees: one at a time (a transition starts only after the previous settled), and last-wins — a superseded
 * transition still runs to completion, but the caller checks `stillCurrent()` before adopting: a stale outcome is
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
