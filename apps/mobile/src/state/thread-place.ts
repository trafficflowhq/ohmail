/**
 * WHERE THE PERSON STOPPED IN A CONVERSATION — the Ohbox reader's squares and its ringed one, for the
 * list row that carries the same squares (the strip). One entry: the conversation the last Ohbox
 * reader showed. The reader writes it on each ring change and the next open replaces it; it outlives
 * the reader, so the row the person comes back to is ringed where they stopped. A press on the strip
 * jumps the reader that is mounted (`bindThreadJump`, two panes); with none it leaves `pending` for the
 * reader the row's own open mounts, which lands there.
 */
import { useSyncExternalStore } from "react";
import type { RailItem } from "../ui/reader-marks";

export interface ThreadPlace {
  /**
   * The conversation's squares, oldest first, as the reader's rail drew them last: they say WHICH
   * conversation's row carries the strip (`threadPlaceOf`). The strip draws the conversation as it
   * stands (`stripOf`), never these.
   */
  items: readonly RailItem[];
  /** The ringed square: the reader's current message. */
  here: string | null;
  /** A strip press waiting for the reader the row's open mounts. */
  pending: string | null;
}

let place: ThreadPlace | null = null;
let jump: ((id: string) => void) | null = null;
const listeners = new Set<() => void>();
const emit = (): void => { for (const l of listeners) l(); };

const sameItems = (a: readonly RailItem[], b: readonly RailItem[]): boolean =>
  a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.kind === b[i]!.kind && x.sender === b[i]!.sender);

export function threadPlace(): ThreadPlace | null {
  return place;
}

export function subscribeThreadPlace(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The reader's squares and its ring; a pending press for this conversation stays. */
export function publishThreadPlace(items: readonly RailItem[], here: string | null): void {
  const was = place;
  const pending = was !== null && was.pending !== null && items.some((it) => it.id === was.pending) ? was.pending : null;
  if (was !== null && was.here === here && was.pending === pending && sameItems(was.items, items)) return;
  place = { items: was !== null && sameItems(was.items, items) ? was.items : items, here, pending };
  emit();
}

/** Another conversation opened without squares: no row carries the strip. */
export function clearThreadPlace(): void {
  if (place === null) return;
  place = null;
  emit();
}

/** The mounted reader's jump; the returned function unbinds it, only while it is still this one. */
export function bindThreadJump(fn: (id: string) => void): () => void {
  jump = fn;
  return () => { if (jump === fn) jump = null; };
}

/**
 * A press on a strip square: the mounted reader jumps there (`true`). With no reader mounted it is
 * left pending (`false`), and the caller opens the row; that reader lands on it.
 */
export function pressThreadPlace(id: string): boolean {
  if (jump !== null) { jump(id); return true; }
  if (place !== null && place.pending !== id) { place = { ...place, pending: id }; emit(); }
  return false;
}

/** The press waiting for the next reader, if any. */
export function threadPending(): string | null {
  return place?.pending ?? null;
}

/** The reader took the pending press. */
export function takeThreadPending(id: string): void {
  if (place === null || place.pending !== id) return;
  place = { ...place, pending: null };
  emit();
}

/** The entry when this row is its conversation: the row's id or one of its members is among the squares. */
export function threadPlaceOf(
  p: ThreadPlace | null,
  row: { id: string; memberIds?: readonly string[] },
): ThreadPlace | null {
  if (p === null || p.items.length === 0) return null;
  const ids = new Set(p.items.map((it) => it.id));
  return ids.has(row.id) || (row.memberIds ?? []).some((id) => ids.has(id)) ? p : null;
}

/**
 * THE STRIP A ROW DRAWS: the conversation AS IT STANDS (`live`, the reader rail's own squares for the
 * row's message), never the reader's last picture, so a reply or a Mark unread after Back shows on it
 * as on the row's own marks, which the strip hides. Only the ring is the place's, and a ring whose
 * message left the conversation rings nothing. `live` unknown (the row's message not held) draws the
 * place's own squares; a conversation down to one message draws no strip, and the row's marks stand.
 */
export function stripOf(
  p: ThreadPlace,
  live: readonly RailItem[] | undefined,
): { items: readonly RailItem[]; here: string | null } | null {
  const items = live ?? p.items;
  if (items.length === 0) return null;
  return { items, here: p.here !== null && items.some((it) => it.id === p.here) ? p.here : null };
}

export function useThreadPlace(): ThreadPlace | null {
  return useSyncExternalStore(subscribeThreadPlace, threadPlace, threadPlace);
}

export function resetThreadPlaceForTests(): void {
  place = null;
  jump = null;
}
