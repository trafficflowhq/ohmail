/**
 * ONE FAKE FOR THE PERMIT'S TWO CLOCKS. `acquireLeasePermit` takes `now` and `monotonic` as a
 * pair, so a test that drives one drives both from here: `advance` moves both (time passing),
 * `stepWall` moves the wall alone (a clock set back or forward, or a suspend the monotonic clock
 * does not count). `pair` is what a permit call spreads.
 */
export class PermitClock {
  private wall: number;
  private mono: number;

  constructor(startMs: number) {
    this.wall = startMs;
    this.mono = 0;
  }

  /** The wall clock, in epoch milliseconds — what the old single-clock tests called `t`. */
  get ms(): number { return this.wall; }

  readonly now = (): Date => new Date(this.wall);
  readonly monotonic = (): number => this.mono;

  get pair(): { now: () => Date; monotonic: () => number } {
    return { now: this.now, monotonic: this.monotonic };
  }

  advance(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }

  stepWall(ms: number): void {
    this.wall += ms;
  }
}

/**
 * The same pair over the REAL clocks, for the real-server cases: the wall is `Date.now()` and the
 * monotonic one `performance.now()`, each plus its own offset, so `stepWall` models a clock set
 * back or forward (or a closed lid) while time goes on passing for real.
 */
export class LivePermitClock {
  private wallOffset = 0;
  private monoOffset = 0;

  get ms(): number { return Date.now() + this.wallOffset; }

  readonly now = (): Date => new Date(Date.now() + this.wallOffset);
  readonly monotonic = (): number => performance.now() + this.monoOffset;

  get pair(): { now: () => Date; monotonic: () => number } {
    return { now: this.now, monotonic: this.monotonic };
  }

  advance(ms: number): void {
    this.wallOffset += ms;
    this.monoOffset += ms;
  }

  stepWall(ms: number): void {
    this.wallOffset += ms;
  }
}
