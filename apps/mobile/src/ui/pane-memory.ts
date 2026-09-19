/**
 * Continuity across posture changes, held OUTSIDE the tree: the reader's scroll position
 * survives a fold, a rotation and the remounts a pane swap forces, because it lives here and
 * not in any component a layout change recreates (Apple: "right where the user left off";
 * Android: preserve and restore). Posture is deliberately NOT an input to this module — a
 * fold cannot lose a reading position by construction, which is what the continuity test
 * pins. Bounded: a session that reads hundreds of messages keeps the newest CAP offsets and
 * forgets the oldest — a remembered offset is a courtesy, never state the product owes.
 */
const CAP = 64;

const offsets = new Map<string, number>();

export function recordPaneScroll(key: string, y: number): void {
  offsets.delete(key); // re-insert so Map order is recency, and the eviction below is LRU
  offsets.set(key, y);
  if (offsets.size > CAP) {
    const oldest = offsets.keys().next().value;
    if (oldest !== undefined) offsets.delete(oldest);
  }
}

export function paneScrollOf(key: string): number {
  return offsets.get(key) ?? 0;
}
