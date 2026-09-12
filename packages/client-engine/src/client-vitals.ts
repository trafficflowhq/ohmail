/**
 * WHAT THE CLIENT ENGINE COSTS THE WINDOW — two counters, kept where the work happens.
 *
 * The incident that produced them: on a large mailbox every whole-mirror derivation ran
 * 180–236 ms, and a body is written twice — each write bumping the version and notifying — so the
 * eager pass's thousand bodies handed the shell two thousand of them. Nothing measured either
 * quantity, so the cost showed up only as a pinned core.
 *
 * A MODULE AND NOT A FIELD, because the two call sites are in different objects (the store's
 * bucket rebuild and the engine's subscriber notify) and the reader is in neither — the shell's
 * five-minute report. A per-engine field would have to be threaded through both and then out
 * again; one window runs one engine, and the numbers are counters rather than state anything
 * behaves on.
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
