/**
 * WHETHER AN OPEN READER HOLDS A SHEET OR A COMPOSER. Folding or unfolding moves the reader
 * between the pushed route and the pane, which remounts it; while a sheet or a composer is open on
 * it the move waits and fires when the last one closes, so nothing typed is lost and no sheet
 * closes by itself. Renderer-free: a set of holder tokens and its listeners.
 */
const holders = new Set<symbol>();
const listeners = new Set<() => void>();
let held = false;

export function holdReader(token: symbol, on: boolean): void {
  if (on) holders.add(token);
  else holders.delete(token);
  const next = holders.size > 0;
  if (next === held) return;
  held = next;
  for (const fn of listeners) fn();
}

export function subscribeReaderHeld(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function readerHeldNow(): boolean {
  return held;
}

/**
 * A composer's hold for as long as it is open: taken now, given back by the returned function (an
 * effect's cleanup). The route composer and the reader's own composer both take it, so a fold or an
 * unfold never replaces or covers a letter being written (`compose-route-holds-the-reader.test.ts`).
 */
export function holdWhileOpen(token: symbol): () => void {
  holdReader(token, true);
  return () => holdReader(token, false);
}

/** Whether the pushed reader moves to the pair's pane now: a pane to move to, and nothing holding it. */
export const readerMoveDue = (targetPath: string | null, held: boolean): boolean => targetPath !== null && !held;
