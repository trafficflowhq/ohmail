/**
 * One deferral for work the first paint does not need — the Screener queue's cold derivation
 * (132 ms at 10k held, measured 2026-09-19) was the one long task left on the /mailbox paint.
 * `requestIdleCallback` where the host has one, bounded so load cannot starve the queue for
 * ever; a plain macrotask elsewhere (jsdom serves no idle callback, so tests settle it with
 * one timer tick — see `test/_first-paint.ts`). Returns a canceller for the unmount race.
 */

/** The ceiling on "idle": the queue derives within this bound even under continuous load. */
export const FIRST_DERIVATION_TIMEOUT_MS = 500;

type IdleHost = {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function scheduleFirstDerivation(run: () => void): () => void {
  const host = globalThis as IdleHost;
  if (typeof host.requestIdleCallback === "function") {
    const handle = host.requestIdleCallback(run, { timeout: FIRST_DERIVATION_TIMEOUT_MS });
    return () => host.cancelIdleCallback?.(handle);
  }
  const timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
}
