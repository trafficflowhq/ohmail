/**
 * THE GLOBAL MAINTENANCE GATE: due once every `everyMs` of the clock, and due at once on a new
 * leader so its first cycle sweeps. A closure over the clock, so the cadence is driven as
 * behaviour rather than read as text.
 */
export function maintenanceGate(everyMs: number, clock: () => number = Date.now): () => boolean {
  let lastAt: number | null = null;
  return () => {
    const at = clock();
    if (lastAt !== null && at - lastAt < everyMs) return false;
    lastAt = at;
    return true;
  };
}
