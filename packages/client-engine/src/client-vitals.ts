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

/**
 * How many derivation timings a window keeps for its percentiles.
 *
 * A ring and not a growing array, for the reason the shell's own rings are one: a 74k mailbox
 * bumps its version thousands of times per drain, and an array that held every timing would be a
 * leak inside the instrument that exists to find leaks. A hundred is enough for a p95 to mean
 * something and small enough that the one sort it costs runs every five minutes, not per bump.
 */
export const DERIVE_RING = 100;

let notifies = 0;
let derives = 0;
let deriveMsMax = 0;
let deriveMsTotal = 0;
/* ALLOCATED ONCE, at module load. The derivation is the O(mailbox) pass itself, so the ring may
   not add an allocation per bump on top of it: a write is an index store into this array. */
const deriveRing = new Float64Array(DERIVE_RING);
/** How many slots of {@link deriveRing} this window has filled, capped at its length. */
let deriveRingLen = 0;
/** Where the next timing goes — the ring overwrites the oldest once the window is past 100. */
let deriveRingNext = 0;

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
    deriveRing[deriveRingNext] = ms;
    deriveRingNext = (deriveRingNext + 1) % DERIVE_RING;
    if (deriveRingLen < DERIVE_RING) deriveRingLen += 1;
  };
}

/**
 * A percentile of this window's derivations, nearest-rank, or `null` when it derived nothing.
 *
 * THE SAME RULE AS THE SHELL'S `percentile`, deliberately: one log line carrying two definitions of
 * p95 is a line nobody can compare across its own fields.
 */
function derivePercentile(p: number): number | null {
  if (deriveRingLen === 0) return null;
  // A COPY, and `slice` makes one where `subarray` would make a view: sorting the ring itself
  // would scramble which slot is the oldest, so the next overwrite would evict the wrong reading.
  const sorted = deriveRing.slice(0, deriveRingLen).sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return Math.round(sorted[index]!);
}

/**
 * The window's counters.
 *
 * `deriveMsMax` is the worst single derivation, which is the one felt, and it is taken over EVERY
 * derivation of the window. The percentiles are taken over the last {@link DERIVE_RING} of them,
 * so on a drain that bumps thousands of times the max can be worse than anything `deriveMsP95`
 * describes — the two answer "what was the worst" and "what is this window usually like", and
 * folding them into one number would lose both.
 */
export interface ClientEngineVitals {
  notifies: number;
  derives: number;
  deriveMsMax: number;
  deriveMsTotal: number;
  /** The median of the window's last hundred derivations, or `null` when it derived nothing. */
  deriveMsP50: number | null;
  /** The p95 of the same hundred, or `null` when it derived nothing. */
  deriveMsP95: number | null;
}

function snapshot(): ClientEngineVitals {
  return {
    notifies,
    derives,
    deriveMsMax: Math.round(deriveMsMax),
    deriveMsTotal: Math.round(deriveMsTotal),
    deriveMsP50: derivePercentile(50),
    deriveMsP95: derivePercentile(95),
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
  // The ring is emptied by its LENGTH, not by clearing its bytes: a stale slot past the length is
  // unreadable, and zeroing a hundred doubles would be work for nothing.
  deriveRingLen = 0;
  deriveRingNext = 0;
  return taken;
}

/** The same numbers without clearing them — for a test, and for anything that asks twice. */
export function peekClientEngineVitals(): ClientEngineVitals {
  return snapshot();
}
