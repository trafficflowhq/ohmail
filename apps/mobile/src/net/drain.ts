/**
 * THE SYNC ROUND, AS AN OBJECT THE SUITE CAN HOLD — extracted from the connection provider so
 * its two contracts are testable without a renderer:
 *
 *  · **HONEST SETTLE.** The promise a round hands back resolves when the engine's own
 *    `start()`/`syncOnce()` settles — never on a timer, never early. Pull-to-refresh renders
 *    its spinner on exactly this promise, so the spinner ends when the sync round actually
 *    completed (`drain.test.ts` holds the promise open against a deferred engine; a mutant
 *    that resolves early goes red there).
 *
 *  · **A REFUSAL SETTLES QUIETLY.** The round never rejects: a failure becomes the one
 *    `error` sentence the connection state already carries (the Servers screen's existing
 *    vocabulary — no toast spam), followed by a re-hydrate so the torn-flush guard's refusal
 *    window closes before any retry (the store's own rule, carried verbatim from the
 *    provider this was lifted out of).
 *
 * {@link SyncRunner.request} is the doorbell every "sync now" gesture rings — pull-to-refresh
 * here, exactly as the wake channel and the Servers screen ring the provider's `syncNow`. It
 * COALESCES onto a round already in flight rather than queueing another, which is the
 * engine's own doctrine for poll/wake-shaped asks (`syncOnce()` — "they only ever want
 * 'catch up', and one drain does"); the round it joins is the one whose completion it
 * reports, so the settle stays honest.
 *
 * No network of its own, no React: the engine is handed in per call, the two callbacks are
 * the only outputs, and one runner outlives every session (the provider guards WHICH session
 * may ring it, this class only guards HOW MANY rounds fly — one).
 */

/** The three engine calls a round is made of — the seam the suite drives with a fake. */
export interface DrainEngine {
  start(): Promise<void>;
  syncOnce(): Promise<void>;
  hydrate(): Promise<void>;
}

export class SyncRunner {
  /** The round in the air, or null — teardown awaits it before closing the mirror. */
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly on: {
      /** Mirrors into the provider's `syncing` state — the UI's one busy flag. */
      syncing(on: boolean): void;
      /** The failure sentence (or its clearing) — the provider's `syncError`. */
      error(reason: string | null): void;
    },
  ) {}

  /**
   * One full round: `start()` for a session's first (hydrate + bootstrap/catch-up),
   * `syncOnce()` after. Resolves when the engine settles, success or failure.
   */
  run(engine: DrainEngine, first: boolean): Promise<void> {
    // The busy flag rises with the round; the previous failure sentence clears, because this
    // round IS the retry it was asking for.
    this.on.syncing(true);
    this.on.error(null);
    // A box rather than a bare self-reference: a session switch can start a new round while
    // an old one is still landing, and everything the OLD round would report is gated on it
    // still being the round of record (`this.inflight === self.round`). The busy flag falling
    // is the signal the world layer re-derives on (the settled stamp, the retry flush, the
    // folders re-read) — a SUPERSEDED round's landing must not spend it: with two rounds
    // overlapped, the stale one's `syncing(false)` would fire while the live one still flies,
    // and the live one's own completion would then be a no-op state write that re-derives
    // nothing — a just-synced empty mailbox left rendering its skeleton. The same gate keeps
    // a dead session's failure sentence from standing over the live session's state.
    const self: { round: Promise<void> | null } = { round: null };
    const round = (async (): Promise<void> => {
      try {
        await (first ? engine.start() : engine.syncOnce());
      } catch (err) {
        if (this.inflight === self.round) this.on.error(String(err));
        // Re-sync memory with disk so the torn-flush guard's refusal window closes and the
        // retry re-fetches the failed page instead of writing past it.
        await engine.hydrate().catch(() => undefined);
      } finally {
        if (this.inflight === self.round) {
          this.on.syncing(false);
          this.inflight = null;
        }
      }
    })();
    self.round = round;
    this.inflight = round;
    return round;
  }

  /** The sync-now doorbell: join the round in flight, or start one. Never rejects. */
  request(engine: DrainEngine): Promise<void> {
    return this.inflight ?? this.run(engine, false);
  }

  /** The round in the air (teardown's await), or null. */
  inFlight(): Promise<void> | null {
    return this.inflight;
  }
}
