import { monitorEventLoopDelay } from "node:perf_hooks";

/** How long the engine's turns held the loop since the last read, in whole milliseconds. */
export interface LoopDelaySample {
  p99Ms: number;
  maxMs: number;
}

/** One running loop monitor: `read` answers since the last read (or the start) and starts over. */
export interface LoopDelayReader {
  read(): LoopDelaySample;
  stop(): void;
}

/**
 * Node's event-loop delay histogram, one per drain: its 10 ms timer wakes the loop, so it is never
 * left running. Supplied by the desktop entry (`main.ts`), never imported by the engine: the phone
 * bundles the engine, and its `perf_hooks` is a stand-in that refuses.
 */
export function nodeLoopDelay(): LoopDelayReader {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const ms = (ns: number): number => (Number.isFinite(ns) ? Math.round(ns / 1e6) : 0);
  return {
    read() {
      const out = { p99Ms: h.count > 0 ? ms(h.percentile(99)) : 0, maxMs: h.count > 0 ? ms(h.max) : 0 };
      h.reset();
      return out;
    },
    stop() { h.disable(); },
  };
}
