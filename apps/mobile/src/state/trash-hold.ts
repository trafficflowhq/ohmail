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

/* LETTERS RESTORED, in order, from either host: the list under a pushed reader drops each one it has not seen yet. */
let restored: readonly string[] = [];
const restoreHearers = new Set<() => void>();

export function noteTrashRestored(id: string): void {
  restored = [...restored, id];
  for (const hear of [...restoreHearers]) hear();
}

export function trashRestored(): readonly string[] {
  return restored;
}

export function subscribeTrashRestored(hear: () => void): () => void {
  restoreHearers.add(hear);
  return () => { restoreHearers.delete(hear); };
}

/* DELETES THE SERVER TOOK, counted: an open Trash reads page one again on each, since the move of a letter deleted
   just before the open often lands after it. */
let landed = 0;
const hearers = new Set<() => void>();

export function noteTrashLanded(): void {
  landed += 1;
  for (const hear of [...hearers]) hear();
}

export function trashLanded(): number {
  return landed;
}

export function subscribeTrashLanded(hear: () => void): () => void {
  hearers.add(hear);
  return () => { hearers.delete(hear); };
}
