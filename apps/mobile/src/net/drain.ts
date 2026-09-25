/**
 * The sync round, as an object the suite can hold — extracted from the connection provider so its two contracts are
 * testable without a renderer. Honest settle: the promise resolves when the engine's own `start()`/`syncOnce()`
 * settles — never on a timer, never early; pull-to-refresh renders its spinner on exactly this promise
 * (`drain.test.ts` holds it open against a deferred engine). A refusal settles quietly: the round never rejects — a
 * failure becomes the one `error` sentence the connection state carries, followed by a re-hydrate so the torn-flush
 * guard's refusal window closes before any retry. {@link SyncRunner.request} coalesces onto a round already in flight
 * rather than queueing another (the engine's own poll/wake doctrine), and the round it joins is the one whose
 * completion it reports. No network of its own, no React; one runner outlives every session.
 */

/** The three engine calls a round is made of — the seam the suite drives with a fake. */
export interface DrainEngine {
  start(): Promise<void>;
  syncOnce(): Promise<void>;
  hydrate(): Promise<void>;
}

import { faultDetail, type RefusalArg } from "../refusal";

/** How a round of record ended — what the drain line ({@link drainLine}) is written from. */
export type RoundOutcome =
  | { ok: true; first: boolean }
  | { ok: false; first: boolean; err: unknown; failures: number };

/**
 * THE DRAIN LINE — one per settled round, in the desktop's own words (`cloud_pull_applied`,
 * `cloud_pull_failed`), so a phone that stops draining reads as a gap in `logcat` rather than as
 * silence. Content-free by construction: a boolean, a closed door name and the engine's own
 * failure record (`classifyWindowSyncFailure`, handed in by the seam: a closed reason, a class
 * name, a status, a code — never a message).
 */
export function drainLine(
  outcome: RoundOutcome,
  door: "paired" | "standalone",
  classify: (err: unknown, attempt: number) => object,
): string {
  if (outcome.ok) {
    return JSON.stringify({ service: "sync", event: "cloud_pull_applied", door, first: outcome.first });
  }
  const failure = classify(outcome.err, outcome.failures);
  return JSON.stringify({ service: "sync", event: "cloud_pull_failed", door, first: outcome.first, ...failure });
}

export class SyncRunner {
  /** The round in the air, or null — teardown awaits it before closing the mirror. */
  private inflight: Promise<void> | null = null;
  /** Consecutive failed rounds of record; zero after any success. The cadence backs off on it. */
  private failed = 0;

  constructor(
    private readonly on: {
      /** Mirrors into the provider's `syncing` state — the UI's one busy flag. */
      syncing(on: boolean): void;
      /**
       * The failure (or its clearing) — the provider's `syncError`. A refusal ARGUMENT, not a
       * sentence: a round that fails is worded where it is shown, so a standing failure
       * follows a language change like everything else on the screen.
       */
      error(reason: RefusalArg | null): void;
      /** Every round of record as it settles — the drain line's writer. */
      settled?(outcome: RoundOutcome): void;
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
      // REGISTRATION BEFORE ANY ENGINE CODE: this yield lets the synchronous tail below fill
      // the box and take the record before the engine is invoked, so an engine that throws
      // SYNCHRONOUSLY is an ordinary failed round — its sentence reported, its busy flag
      // dropped — never an unregistered one the record gates would silence.
      await Promise.resolve();
      let outcome: RoundOutcome = { ok: true, first };
      try {
        await (first ? engine.start() : engine.syncOnce());
      } catch (err) {
        outcome = { ok: false, first, err, failures: this.failed + 1 };
        if (this.inflight === self.round) this.on.error(faultDetail(err));
        // Re-sync memory with disk so the torn-flush guard's refusal window closes and the
        // retry re-fetches the failed page instead of writing past it. Through a thenable so
        // even a synchronously-throwing hydrate stays inside this round.
        await Promise.resolve().then(() => engine.hydrate()).catch(() => undefined);
      } finally {
        if (this.inflight === self.round) {
          this.failed = outcome.ok ? 0 : this.failed + 1;
          this.on.syncing(false);
          this.inflight = null;
          try { this.on.settled?.(outcome); } catch { /* a log line is never worth a round */ }
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

  /** Consecutive failed rounds of record — 0 after a success. */
  failures(): number {
    return this.failed;
  }

  /**
   * THE OWNING SESSION IS LEAVING — the round in the air no longer speaks for the UI.
   *
   * Teardown calls this so a dead session's round cannot publish its landing into the NEXT
   * session's screens: the busy flag falls NOW (the newly adopted session starts clean, and
   * a disconnect does not strand `syncing` true), the standing failure sentence clears, and
   * the disowned round — no longer the round of record — reports nothing when it lands (the
   * `inflight === self.round` gates in {@link run}). Callers that must still WAIT for the
   * round (closing the mirror under it) capture {@link inFlight} BEFORE disowning.
   */
  disown(): void {
    if (this.inflight !== null) {
      this.inflight = null;
      this.on.syncing(false);
    }
    this.failed = 0;
    this.on.error(null);
  }
}
