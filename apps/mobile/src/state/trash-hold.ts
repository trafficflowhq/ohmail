/**
 * The Trash rows the list screen fetched, held for the PUSHED detail route — `pane-memory`'s
 * idiom: the rows are off-mirror (a delete tombstones them everywhere), so a route that only
 * carries an id has no reader to re-ask. Page one REPLACES the hold (the fetch is the reset,
 * the webapp `trash-page.ts`'s leave-reset one gesture earlier), later pages append, a restore
 * drops its row — so the hold is bounded by what one visit listed and cannot grow stale
 * across visits.
 */
import type { WorldTrashRow } from "./live";

const held = new Map<string, WorldTrashRow>();

export function holdTrashRows(items: readonly WorldTrashRow[], reset: boolean): void {
  if (reset) held.clear();
  for (const r of items) held.set(r.mail.id, r);
}

export function heldTrashRow(id: string): WorldTrashRow | undefined {
  return held.get(id);
}

export function dropTrashRow(id: string): void {
  held.delete(id);
}
