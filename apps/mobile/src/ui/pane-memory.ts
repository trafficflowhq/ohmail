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

/**
 * A place in the conversation, kept beside the offset: the panel under the view's top line (a
 * member, or the opened message) and how far into it the view stands. A new width reflows every
 * panel, so the offset alone points into another message; the place does not.
 */
export interface PanePlace {
  id: string;
  /** The view's top, less the panel's top; within the panel it scales with the panel's height. */
  dy: number;
  /** The panel's height when the place was taken. */
  h: number;
}

const offsets = new Map<string, { y: number; place: PanePlace | null }>();

const keep = (key: string, y: number, place: PanePlace | null): void => {
  offsets.delete(key); // re-insert so Map order is recency, and the eviction below is LRU
  offsets.set(key, { y, place });
  if (offsets.size > CAP) {
    const oldest = offsets.keys().next().value;
    if (oldest !== undefined) offsets.delete(oldest);
  }
};

export function recordPaneScroll(key: string, y: number): void {
  keep(key, y, offsets.get(key)?.place ?? null);
}

export function recordPanePlace(key: string, place: PanePlace): void {
  keep(key, offsets.get(key)?.y ?? 0, place);
}

export function paneScrollOf(key: string): number {
  return offsets.get(key)?.y ?? 0;
}

export function panePlaceOf(key: string): PanePlace | null {
  return offsets.get(key)?.place ?? null;
}

/** Was an offset kept for `key` — a remount that has a place to resume, not a first open. */
export function hasPaneScroll(key: string): boolean {
  return offsets.has(key);
}

/** The visit that kept `key` ended: the next open starts at its own anchor. */
export function forgetPaneScroll(key: string): void {
  offsets.delete(key);
}
