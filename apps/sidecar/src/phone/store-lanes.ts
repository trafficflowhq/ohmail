import type { StoreLane } from "../store-lanes.js";

/**
 * The store's lane scheduler, absent — substituted for `../store-lanes.js` in the phone bundle.
 *
 * The desktop names its two store lanes with `AsyncLocalStorage` — `node:async_hooks`, which a
 * phone does not have: the import alone is a crash at load. It would also be useless, which is the
 * honest half: this store is the platform's SQLite behind a worker with its own transaction gate
 * (`mobile.ts`), not one in-process connection every statement queues on, so there is nothing for a
 * second queue to schedule and `laneCensus()` answers `null`. The lane NAME passes through.
 */
export type { StoreLane } from "../store-lanes.js";

export function inStoreLane<T>(_lane: StoreLane, fn: () => Promise<T>): Promise<T> {
  return fn();
}

export function currentStoreLane(): StoreLane {
  return "interactive";
}

/**
 * Whether a drain is taking mail in — the desktop scheduler's own count, which a phone has no
 * scheduler to keep. The one reader is the desktop's search backfill, which the phone does not
 * schedule (`composition-passes.ts`); the answer is here so the shared engine resolves.
 */
export function ingestIsRunning(): boolean {
  return false;
}
