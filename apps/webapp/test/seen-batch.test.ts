import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSeenBatcher,
  SEEN_MAX_IDS,
  SEEN_MAX_LATENCY_MS,
  SEEN_QUIET_MS,
} from "@ohmail/app-logic/reading/seen-batch";

/**
 * THE SEEN-SWEEP BATCHER'S CONTRACT (the Reads freeze).
 *
 * The per-card `\Seen` sweep used to be one engine mutation per scrolled-past unread card, and
 * every mutation re-derives the shell's whole selector chain over the whole mirror — measured
 * at 8× the blocked main-thread time of the identical scroll on an all-read pile. The batcher
 * turns a burst of marks into ONE mutation. These tests own its timing contract; the module
 * header carries the measurement.
 */
describe("seen-batch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a burst of marks flushes ONCE, after the quiet period, carrying every id", () => {
    const flushes: string[][] = [];
    const b = createSeenBatcher((ids) => flushes.push(ids));
    b.add("a");
    b.add("b");
    b.add("c");
    expect(flushes).toEqual([]); // nothing before the quiet period
    vi.advanceTimersByTime(SEEN_QUIET_MS - 1);
    expect(flushes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushes).toEqual([["a", "b", "c"]]);
    expect(b.pending()).toBe(0);
  });

  it("duplicates while pending are dropped", () => {
    const flushes: string[][] = [];
    const b = createSeenBatcher((ids) => flushes.push(ids));
    b.add("a");
    b.add("a");
    b.add("b");
    b.add("a");
    vi.advanceTimersByTime(SEEN_QUIET_MS);
    expect(flushes).toEqual([["a", "b"]]);
  });

  it("a steady scroll cannot slide the quiet timer forever — the deadline flushes", () => {
    const flushes: string[][] = [];
    const b = createSeenBatcher((ids) => flushes.push(ids));
    // A mark every quarter of the quiet period: the quiet timer never fires on its own.
    const step = Math.floor(SEEN_QUIET_MS / 4);
    let t = 0;
    let i = 0;
    while (t < SEEN_MAX_LATENCY_MS + step) {
      b.add(`m${i++}`);
      vi.advanceTimersByTime(step);
      t += step;
    }
    expect(flushes.length).toBeGreaterThan(0); // the deadline fired mid-scroll
    const flushed = flushes.flat();
    expect(new Set(flushed).size).toBe(flushed.length); // no id twice across flushes
  });

  it("the id cap flushes immediately, without waiting for any timer", () => {
    const flushes: string[][] = [];
    const b = createSeenBatcher((ids) => flushes.push(ids));
    for (let i = 0; i < SEEN_MAX_IDS; i++) b.add(`m${i}`);
    expect(flushes.length).toBe(1);
    expect(flushes[0]).toHaveLength(SEEN_MAX_IDS);
  });

  it("flushNow drains synchronously and is a no-op when empty", () => {
    const flushes: string[][] = [];
    const b = createSeenBatcher((ids) => flushes.push(ids));
    b.flushNow();
    expect(flushes).toEqual([]); // an empty drain must not emit an empty mutation
    b.add("a");
    b.flushNow();
    expect(flushes).toEqual([["a"]]);
    // …and the timers it cancelled must not fire a second, empty flush later.
    vi.advanceTimersByTime(SEEN_MAX_LATENCY_MS * 2);
    expect(flushes).toEqual([["a"]]);
  });

  it("marks after a flush start a fresh batch with fresh timers", () => {
    const flushes: string[][] = [];
    const b = createSeenBatcher((ids) => flushes.push(ids));
    b.add("a");
    vi.advanceTimersByTime(SEEN_QUIET_MS);
    b.add("b");
    vi.advanceTimersByTime(SEEN_QUIET_MS);
    expect(flushes).toEqual([["a"], ["b"]]);
  });
});
