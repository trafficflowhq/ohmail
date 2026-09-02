"use client";

/**
 * THE SEEN-SWEEP BATCHER — many per-card marks, one mutation.
 *
 * ── WHY THIS EXISTS, WITH THE NUMBER THAT FORCED IT ─────────────────────────────────────────
 *
 * The reading streams mark `\Seen` per card as the reader scrolls past (`useSeenOnScroll` +
 * the dwell in `StreamShell`), and each mark was ONE engine mutation. A mutation is cheap on
 * the wire — the outbox coalesces its dispatch — but every mutation bumps the mirror version,
 * and a version bump re-derives the shell's whole selector chain over the whole mirror:
 * `ohboxView`, both `feedPartition`s, `receiptsByDay`, `triagePiles`, `tagsCrossView`,
 * `consentPartition`, … — every pile, for every view, per message scrolled past. Measured on a
 * generated Reads pile tens of thousands deep in real Chromium: the identical deep scroll cost
 * roughly EIGHT TIMES the blocked main-thread time of the same scroll on an all-read pile — a
 * difference that is nothing but this sweep. On slower hardware that is the CPU pinned while
 * nothing but a scrollbar moves. (The harness and its numbers live outside this file.)
 *
 * Both sweep mutations already take `messageIds[]` on the wire and in the optimistic overlay,
 * so the fix is arithmetic, not protocol: buffer the ids, flush ONE mutation. Nothing about
 * WHAT gets marked changes — only how many times the mirror is asked to notify.
 *
 * ── THE TIMING CONTRACT ─────────────────────────────────────────────────────────────────────
 *
 * A flush fires at the FIRST of:
 *   · {@link SEEN_QUIET_MS} with no new mark — the reader paused;
 *   · {@link SEEN_MAX_LATENCY_MS} after the oldest pending mark — a steady scroll must not
 *     defer the write forever (the quiet timer alone would slide indefinitely);
 *   · {@link SEEN_MAX_IDS} pending — stay far under the route's 200-id cap;
 *   · `flushNow()` — the caller's leave seam (`pagehide`, and beside the anchored
 *     leave-commit), because a batch that dies with the tab was mail somebody really read.
 *     The engine's durable outbox persists the dispatched verb before the wire, which is what
 *     makes the `pagehide` flush deliverable on the next boot even when its fetch never
 *     leaves the machine (the same argument `StreamShell`'s pagehide commit states).
 *
 * Latency is invisible here by construction: the row's quiet-ink flip is optimistic per flush,
 * within ~a second of the glance, and the WATERLINE — the "new since last visit" statement —
 * never rode the per-card sweep at all (it moves once, on leave). What a reader could ever
 * observe is a bold row staying bold for up to 1.5 s longer than before.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────────────────────
 *
 * Framework-free core (`createSeenBatcher`) so the contract is testable without a DOM, plus
 * the `pagehide` wiring left to the caller (the shell mounts once and owns window listeners).
 * Ids are deduplicated; the flush callback receives them in first-marked order.
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
