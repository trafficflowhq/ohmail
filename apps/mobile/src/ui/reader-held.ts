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
