"use client";

/**
 * The seen-sweep batcher — many per-card marks, one mutation. Each scroll-past mark was one engine
 * mutation, and every mutation bumps the mirror version, re-deriving the shell's whole selector
 * chain over the whole mirror — measured on a generated Reads pile tens of thousands deep in real
 * Chromium: a deep scroll cost roughly EIGHT TIMES the blocked main-thread time of the same scroll
 * on an all-read pile, nothing but this sweep. Both sweep mutations already take `messageIds[]`,
 * so the fix is arithmetic, not protocol: buffer the ids, flush ONE mutation — nothing about WHAT
 * gets marked changes.
 */

/**
 * A flush fires at the FIRST of: {@link SEEN_QUIET_MS} with no new mark (the reader paused);
 * {@link SEEN_MAX_LATENCY_MS} after the oldest pending mark (a steady scroll must not defer the
 * write for ever); {@link SEEN_MAX_IDS} pending (far under the route's 200-id cap); or
 * `flushNow()` — the caller's leave seam (`pagehide`), because a batch that dies with the tab was
 * mail somebody really read, and the engine's durable outbox persists the verb before the wire, so
 * the pagehide flush is deliverable on the next boot. Latency is invisible by construction: the
 * quiet-ink flip is optimistic per flush and the WATERLINE never rode the per-card sweep at all.
 * Framework-free core (`createSeenBatcher`); ids deduplicated, flushed in first-marked order.
 */

/** Flush after this much quiet — no new mark arriving. */
export const SEEN_QUIET_MS = 400;

/** …but never later than this after the oldest pending mark. */
export const SEEN_MAX_LATENCY_MS = 1500;

/** …and never holding more than this many ids. */
export const SEEN_MAX_IDS = 100;

export interface SeenBatcher {
  /** Buffer one id. Duplicates while pending are dropped. */
  add: (id: string) => void;
  /** Drain synchronously — the leave/pagehide seam. No-op when nothing is pending. */
  flushNow: () => void;
  /** Pending count — for tests and for callers that want to know if a flush is owed. */
  pending: () => number;
}

export function createSeenBatcher(
  flush: (ids: string[]) => void,
  timing: { quietMs?: number; maxLatencyMs?: number; maxIds?: number } = {},
): SeenBatcher {
  const quietMs = timing.quietMs ?? SEEN_QUIET_MS;
  const maxLatencyMs = timing.maxLatencyMs ?? SEEN_MAX_LATENCY_MS;
  const maxIds = timing.maxIds ?? SEEN_MAX_IDS;

  const pending = new Set<string>();
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = (): void => {
    if (quietTimer !== null) clearTimeout(quietTimer);
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    quietTimer = null;
    deadlineTimer = null;
  };

  const flushNow = (): void => {
    clearTimers();
    if (pending.size === 0) return;
    const ids = [...pending];
    pending.clear();
    flush(ids);
  };

  const add = (id: string): void => {
    pending.add(id);
    if (pending.size >= maxIds) {
      flushNow();
      return;
    }
    // The quiet timer slides with every mark; the deadline is armed once per batch and is
    // what bounds a steady scroll's sliding quiet.
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(flushNow, quietMs);
    if (deadlineTimer === null) deadlineTimer = setTimeout(flushNow, maxLatencyMs);
  };

  return { add, flushNow, pending: () => pending.size };
}
