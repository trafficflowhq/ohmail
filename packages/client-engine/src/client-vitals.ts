/**
 * WHAT THE CLIENT ENGINE COSTS THE WINDOW — two counters, kept where the work happens: the store's
 * whole-mirror derivation and the engine's subscriber notify. A large mailbox's derivation runs
 * hundreds of milliseconds and the eager body pass notifies twice per body; nothing measured
 * either, so the cost showed up only as a pinned core.
 *
 * A MODULE AND NOT A FIELD: the two call sites are in different objects and the reader — the
 * shell's five-minute report — is in neither. One window runs one engine, and these are counters
 * rather than state anything behaves on.
 */

/** A monotonic millisecond clock, or `null` where the runtime has none. */
function nowMs(): number | null {
  return typeof performance === "object" && typeof performance.now === "function"
    ? performance.now()
    : null;
}

let notifies = 0;
let derives = 0;
let deriveMsMax = 0;
let deriveMsTotal = 0;

/** One subscriber notification — every version bump the shell is told about. */
export function countNotify(): void {
  notifies += 1;
}

/**
 * Time one whole-mirror derivation. Answers the caller's own finish function, or `null` where the
 * runtime has no clock — in which case the derivation is not counted at all rather than counted as
 * zero, on the same rule the engine's memory sampler follows: a made-up point is worse than a
 * missing one.
 */
export function beginDerive(): (() => void) | null {
  const started = nowMs();
  if (started === null) return null;
  return () => {
    const ended = nowMs();
    if (ended === null) return;
    const ms = ended - started;
    derives += 1;
    deriveMsTotal += ms;
    if (ms > deriveMsMax) deriveMsMax = ms;
  };
}

/** The window's counters. `deriveMsMax` is the worst single derivation, which is the one felt. */
export interface ClientEngineVitals {
  notifies: number;
  derives: number;
  deriveMsMax: number;
  deriveMsTotal: number;
}

function snapshot(): ClientEngineVitals {
  return {
    notifies,
    derives,
    deriveMsMax: Math.round(deriveMsMax),
    deriveMsTotal: Math.round(deriveMsTotal),
  };
}

/**
 * Read the counters and start the next window. TAKE and not READ: the report says what happened in
 * the last five minutes, and a running total would make every reading after the first unreadable
 * without the one before it.
 */
export function takeClientEngineVitals(): ClientEngineVitals {
  const taken = snapshot();
  notifies = 0;
  derives = 0;
  deriveMsMax = 0;
  deriveMsTotal = 0;
  return taken;
}

/** The same numbers without clearing them — for a test, and for anything that asks twice. */
export function peekClientEngineVitals(): ClientEngineVitals {
  return snapshot();
}
