import type { Diagnostic } from "./log.js";

/**
 * The engine's own memory. Why a module and not three lines in `log.ts`: `log.ts` is the ONE file
 * `log-census.test.ts` excludes from its scan — it is the funnel, forwarding whatever the caller
 * passed, so there is nothing to census there, and a call site emitting a literal event name from
 * inside it would have its field names checked against `ALLOWED_FIELDS` by nothing at all. The census
 * caught it: the roster said 146 events and the scanner found 145. So the emitter lives where every
 * other emitter lives, in a file the scanner reads.
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
 * THE KNOB'S BOUNDS. A run shorter than the shipped five minutes reads no figure of the app's
 * own at all, so the interval is settable — within a range, because the value outside it is the
 * failure this knob would otherwise introduce: below a second the sampler is a cost on the
 * process it measures, and above an hour a soak records nothing it could not have read from a
 * single sample. The shipped default is unchanged and absent means absent.
 */
export const VITALS_INTERVAL_MIN_MS = 1_000;
export const VITALS_INTERVAL_MAX_MS = 60 * 60_000;

/**
 * One environment value, ruled on BY NAME — the whole rule for every interval knob in this
 * process. A garbage or out-of-range value REFUSES the boot rather than degrading quietly: an
 * instrument silently left on its default is exactly the reading a short run would then report
 * as the app's own, which is the mistake this knob exists to remove.
 */
export function resolveVitalsIntervalMs(name: string, raw: string): number {
  const ms = Number(raw.trim());
  if (!Number.isInteger(ms) || ms < VITALS_INTERVAL_MIN_MS || ms > VITALS_INTERVAL_MAX_MS) {
    throw new Error(
      `${name} must be whole milliseconds between ${VITALS_INTERVAL_MIN_MS} and ` +
        `${VITALS_INTERVAL_MAX_MS}; unset it for the shipped interval`,
    );
  }
  return ms;
}

/**
 * The engine's memory, on a timer — the first half of a question nothing here can answer today.
 * There is no `memoryUsage()` call anywhere in this repository and no RSS figure in its documents;
 * the only number came from a throwaway build (~half a gigabyte with five thousand messages, plus a
 * drift of tens of megabytes over ten idle minutes), and whether that is a plateau or a climb cannot
 * be decided in a test (PGlite's WASM heap in vitest is not the shipped build's). So this ships the
 * INSTRUMENT and nothing else — no threshold, because a bar chosen before the first measurement is a
 * number somebody invented. Four numbers not one, because a WASM heap outside `heapUsed` (`external`,
 * `storeBytes`) is the only way to tell "holding more mail" from "not releasing". A separate `unref`'d timer keeps an idle install measured; @returns the stop function.
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
     * A runtime may not have a memory reading, and this is the one thing at boot that assumed one.
     * `createSidecar` starts this sampler every launch, and on a phone the engine runs inside the app
     * whose `process` stand-in defines only what it can answer — so this call was `undefined is not a
     * function` and took the whole launch down after a successful load, migration and credential seal.
     * An instrument must never stop the engine it measures. The stand-in is NOT given a fabricated
     * `memoryUsage`: a made-up point in a series whose job is to tell a plateau from a climb is worse
     * than a missing one, so the reading is absent and SAYS so — the numbers are null and
     * `memoryReading` names why, a state a reader can act on rather than three misleading zeroes.
     */
    const m = typeof process.memoryUsage === "function" ? process.memoryUsage() : null;
    log("engine_vitals", {
      // NULL-SAFE because `m` is null on a runtime with no `memoryUsage` — the line above makes
      // it so, and a non-optional read here would not compile.
      rss: m?.rss ?? null,
      heapUsed: m?.heapUsed ?? null,
      external: m?.external ?? null,
      /* THE TWO THAT MAKE A STEP READABLE FROM THE LINE ALONE. A measured idle install rose 95 MB
         in `rss` at about an hour of uptime while `heapUsed` FELL, and the three numbers above
         could only say what that was not. `heapTotal` is what the JavaScript engine has RESERVED
         rather than what it holds, which is where a heap expansion lands while `heapUsed` drops;
         `arrayBuffers` is the backing store of the WASM memory and every buffer beside it, which
         separates the store growing from a native allocation. Neither is derivable from the other
         three. */
      heapTotal: m?.heapTotal ?? null,
      arrayBuffers: m?.arrayBuffers ?? null,
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
