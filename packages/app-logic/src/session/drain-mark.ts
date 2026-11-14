"use client";

/**
 * IS A DRAIN IN FLIGHT RIGHT NOW — the one fact the strip's moving marks are allowed to mean.
 *
 * A travelling bar over a sync that is making no progress states something the client cannot
 * see; the only work this tab knows is happening is its own drain. The scheduler marks the
 * drain it runs and the strip mounts its marks for exactly that window. A store rather than
 * context or `SyncStatus`: a drain mark twice a cycle through either of those re-renders every
 * shell consumer, which is a larger cost than the animation it removes.
 */
import { useSyncExternalStore } from "react";

/**
 * How long the mark outlives a settled drain. A drain is often a few hundred milliseconds, and a
 * mark that appeared and vanished inside one would read as a flicker rather than as work. One
 * second, the same quiet window the stream's hold loop uses.
 */
export const DRAIN_MARK_HOLD_MS = 1_000;

let inFlight = false;
let hold: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish(next: boolean): void {
  if (next === inFlight) return;
  inFlight = next;
  for (const notify of listeners) notify();
}

/** The scheduler's call: `true` as a drain starts, `false` as it settles, one pair per tick. */
export function markDrain(running: boolean): void {
  if (hold !== null) {
    clearTimeout(hold);
    hold = null;
  }
  if (running) {
    publish(true);
    return;
  }
  hold = setTimeout(() => {
    hold = null;
    publish(false);
  }, DRAIN_MARK_HOLD_MS);
}

export function drainInFlight(): boolean {
  return inFlight;
}

export function subscribeDrain(notify: () => void): () => void {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

/**
 * The hook. The server snapshot is `false` — nothing drains during a server render, so the
 * hydration markup carries no moving mark and the first client render agrees with it.
 */
export function useDrainInFlight(): boolean {
  return useSyncExternalStore(subscribeDrain, drainInFlight, () => false);
}
