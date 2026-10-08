/**
 * WHEN A RECURRING PASS IS DUE, read on BOTH clocks. A stamp keeps the wall and the monotonic
 * reading of its run; the time since is the larger delta, because a wall clock stepped back
 * cannot shrink the monotonic one and a suspend, which the monotonic clock does not count, still
 * moves the wall one. A wall stamp in the future (the clock stepped back since) is due now: a
 * step costs at most one early run, never a skipped interval. `apps/worker/src/lease.ts`'s shape.
 */
export interface CadenceStamp { readonly wallMs: number; readonly monoMs: number }
export interface CadenceClocks { readonly wall: () => number; readonly mono: () => number }

export const SYSTEM_CLOCKS: CadenceClocks = { wall: () => Date.now(), mono: () => performance.now() };

export const stampNow = (clocks: CadenceClocks = SYSTEM_CLOCKS): CadenceStamp =>
  ({ wallMs: clocks.wall(), monoMs: clocks.mono() });

/** How long since `at`: the larger of the two deltas. */
export const sinceMs = (at: CadenceStamp, clocks: CadenceClocks = SYSTEM_CLOCKS): number =>
  Math.max(clocks.wall() - at.wallMs, clocks.mono() - at.monoMs);

/** Due when never run, when the wall stamp lies in the future, or once `everyMs` has passed. */
export const cadenceDue = (
  at: CadenceStamp | null, everyMs: number, clocks: CadenceClocks = SYSTEM_CLOCKS,
): boolean => at === null || at.wallMs > clocks.wall() || sinceMs(at, clocks) >= everyMs;
