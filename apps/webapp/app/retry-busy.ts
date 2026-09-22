/**
 * A BUSY SERVER IS A RETRY, for the pages that act on a press — the desktop link page, and the
 * approval page beside it. The API answers a starved pool with 503 `db_busy` and `Retry-After`;
 * this waits on the ladder the shell's confirm already uses (`confirm-schedule.ts`: four asks,
 * seeded by the header, jittered, capped) and tells the page each wait so it can say the server
 * is busy and keep its button. Anything that is not our coded `db_busy` rethrows at once, so a
 * refusal keeps its speed, and the last busy answer is rethrown for the page to word.
 */

import { ApiError } from "./api-client";
import { CONFIRM_ATTEMPTS, nextConfirmDelay } from "./shell/confirm-schedule";

/** Our envelope's busy answer — the status, the code, and the fact that it came from us. */
export function isBusy(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 503 && err.code === "db_busy" && err.wire.coded;
}

export interface RetryBusyOptions {
  /**
   * A write whose replay is harmless. The server marks a busy write `retryable: false` when the
   * write may already have landed; the caller is the one who knows whether a second one matters
   * (a second one-use link code does not — the first was never shown and expires unspent).
   */
  replaySafe?: boolean;
  /** Told before each wait, with its length and which retry follows it. */
  onWait?: (ms: number, retry: number) => void;
  /** The wait itself; a page passes one a press can end early. */
  sleep?: (ms: number) => Promise<void>;
  /** Aborted when the page is gone: no retry runs after that, and the busy answer is rethrown. */
  signal?: AbortSignal;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function retryBusy<T>(call: () => Promise<T>, opts: RetryBusyOptions = {}): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      if (!isBusy(err) || attempt >= CONFIRM_ATTEMPTS || opts.signal?.aborted) throw err;
      if (err.wire.retryable === false && opts.replaySafe !== true) throw err;
      const ms = nextConfirmDelay(attempt, err.wire.retryAfterMs ?? null);
      opts.onWait?.(ms, attempt);
      await (opts.sleep ?? pause)(ms);
      if (opts.signal?.aborted) throw err;
    }
  }
}
