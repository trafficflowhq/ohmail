/**
 * WHAT THE NAVIGATION FOLDED, for the More screen to list. The dock and the rail each publish the
 * destinations their fold took out of the row; More renders exactly those as rows, so "into More"
 * is never "gone". Renderer-free: a tiny external store keyed by source, cleared when a source
 * unmounts, so a posture that swaps the dock for the rail cannot leave the other's set behind.
 */
type Source = "dock" | "rail";
const folded: Record<Source, readonly string[]> = { dock: [], rail: [] };
const listeners = new Set<() => void>();
let snapshot: readonly string[] = [];

function recompute(): void {
  const next = [...new Set([...folded.dock, ...folded.rail])];
  if (next.length === snapshot.length && next.every((id, i) => id === snapshot[i])) return;
  snapshot = next;
  for (const fn of listeners) fn();
}

export function publishFolded(source: Source, ids: readonly string[]): void {
  folded[source] = ids;
  recompute();
}

export function subscribeFolded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function foldedNow(): readonly string[] {
  return snapshot;
}
