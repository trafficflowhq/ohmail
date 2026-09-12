import type { Diagnostic } from "./log.js";

/**
 * ═══ THE ENGINE'S OWN MEMORY ═══════════════════════════════════════════════════════════════
 *
 * ── WHY THIS IS A MODULE AND NOT THREE LINES IN `log.ts` ──────────────────────────────────
 *
 * It was three lines in `log.ts`, and that was wrong for a reason worth writing down: `log.ts`
 * is the ONE file `log-census.test.ts` excludes from its scan. It is the funnel — its two
 * `logger.info` / `logger.error` calls forward whatever the caller passed — so there is nothing
 * there to census, and a call site that emitted a literal event name from inside it would have
 * its field names checked against `ALLOWED_FIELDS` by nothing at all. The census caught it: the
 * roster said 146 events and the scanner found 145.
 *
 * So the emitter lives where every other emitter lives, in a file the scanner reads.
 */

/**
 * HOW OFTEN THE ENGINE WRITES ITS OWN MEMORY DOWN.
 *
 * Five minutes: twenty-four samples across a two-hour idle soak, which is enough to tell a
 * PLATEAU from a monotonic climb — the one distinction the measurement exists to make — and few
 * enough that a settled install adds a dozen lines to a working day.
 *
 * Not a second, not an hour. A per-cycle sample would report allocator noise as a trend; an
 * hourly one cannot see a drift measured in tens of megabytes over ten minutes.
 */
export const ENGINE_VITALS_INTERVAL_MS = 5 * 60_000;

/**
 * THE ENGINE'S MEMORY, ON A TIMER — the first half of a question nothing here can answer today.
 *
 * There is no `memoryUsage()` call anywhere in this repository and no RSS figure in any of its
 * documents. The only number that exists for this engine came from a throwaway build, and it was
 * large enough to matter: roughly half a gigabyte with a mailbox of five thousand messages, plus
 * a drift of tens of megabytes over ten idle minutes. Whether that drift is a plateau or a climb
 * decides whether this is a footnote or a lane, and it cannot be decided in a test — PGlite's
 * WASM heap in vitest is not the shipped build's, and a laptop is not a phone.
 *
 * So this ships the INSTRUMENT and nothing else. No threshold, no warning arm, no `_failed`
 * sibling: a bar chosen before the first measurement would be a number somebody invented, and
 * every later reading would be judged against it instead of against reality.
 *
 * ── WHY FOUR NUMBERS AND NOT ONE ──────────────────────────────────────────────────────────
 *
 * `heapUsed` is the JavaScript heap, and this process keeps a DATABASE outside it — a WASM
 * heap that `heapUsed` cannot see and `external` can. `rss` is what the operating system charges the
 * process and is what a person's activity monitor shows, but on its own it cannot say which half
 * grew. `storeBytes` names the database half exactly, read from the runtime rather than inferred,
 * so a rise in `rss` can be attributed instead of argued about. Together they are the only way a
 * reading distinguishes "the mirror is holding more mail" from "something is not being released".
 *
 * ── AND WHY IT IS A SEPARATE TIMER FROM EVERY OTHER ONE HERE ──────────────────────────────
 *
 * A sample folded into the poll would stop the moment the poll did, which is exactly the state
 * worth measuring: an idle install, or one whose connection has died. `unref` so it never keeps
 * the process alive on its own — a quit must not wait for a memory reading.
 *
 * @returns the stop function. It has to be called from the engine's own `stop()`: an interval
 *   that outlives its engine is a closure holding a logger, and two engines in one test process
 *   would interleave their readings under one event name.
 */
export function startEngineVitals(
  log: Diagnostic,
  opts: {
    /**
     * The store's own heap (`OpenLocalDb.storeBytes`) — REQUIRED, and not optional so that the
     * absent case cannot exist: without it the line carries a `heapUsed` that describes a
     * fraction of the process and no reading can say which half moved. Both doors open a store
     * before they start this, so an optional reader would only be a branch nobody can reach.
     */
    storeBytes: () => number;
    intervalMs?: number;
  },
): () => void {
  /* MONOTONIC, and the distinction is not pedantry here. `Date.now()` moves with the wall clock —
     an NTP step, a suspend, a user correcting the date — so a series built from it can decrease or
     go negative, and this number's ONE job is to be the x-axis of a drift measurement. A series
     whose axis can run backwards cannot answer "is memory climbing?", which is the only question
     the sampler exists for. `performance.now()` is monotonic from process start. */
  const bootedAt = performance.now();
  const emit = (): void => {
    /**
     * A RUNTIME MAY NOT HAVE A MEMORY READING, AND THIS IS THE ONE THING AT BOOT THAT ASSUMED ONE.
     *
     * `createSidecar` starts this sampler on every launch. On a phone the engine runs inside the
     * app rather than in a Node process, and its `process` stand-in deliberately defines only what
     * it can answer truthfully — so this call was `undefined is not a function`, and it took the
     * whole launch down after a successful load, a successful migration and a successful
     * credential seal. An instrument must never be the thing that stops the engine it measures.
     *
     * The stand-in is NOT given a `memoryUsage` instead: a fabricated number would enter a series
     * whose only job is to tell a plateau from a climb, and a made-up point in that series is
     * worse than a missing one. So the reading is absent and SAYS it is absent — the three numbers
     * are null and `memoryReading` names why, which is a state a reader can act on rather than
     * three zeroes that look like a very small process.
     */
    const m = typeof process.memoryUsage === "function" ? process.memoryUsage() : null;
    log("engine_vitals", {
      // NULL-SAFE because `m` is null on a runtime with no `memoryUsage` — the line above makes
      // it so, and a non-optional read here would not compile.
      rss: m?.rss ?? null,
      heapUsed: m?.heapUsed ?? null,
      external: m?.external ?? null,
      /* WHICH of the two this line is. Without it a run of nulls is indistinguishable from a
         sampler that is broken, and the difference decides whether anybody investigates. */
      memoryReading: m ? "process" : "unavailable_in_this_runtime",
      // Named, never spread: the field census reads this object's keys, and a conditional spread
      // makes the whole call site unreadable to it.
      storeBytes: opts.storeBytes(),
      // WHICH READING THIS IS, in the only unit that lets a log be read as a series. Without it a
      // sequence of memory readings has no x-axis and cannot answer the drift question at all.
      uptimeMs: Math.round(performance.now() - bootedAt),
      reason: "the engine's memory, sampled on a timer; no threshold is attached and none " +
        "should be until the shipped build has been measured against real mailboxes",
    });
  };
  // ONE AT BOOT, so a launch that is killed before the first interval still leaves a floor on the
  // record — and so the series has a zero point to measure the drift FROM.
  emit();
  const timer = setInterval(emit, opts.intervalMs ?? ENGINE_VITALS_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
