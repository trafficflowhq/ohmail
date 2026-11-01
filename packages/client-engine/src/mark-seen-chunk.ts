import type { EngineMutation } from "./types.js";

/**
 * `PATCH /messages` takes at most 200 ids and answers 413 above that (the route's
 * `MARK_SEEN_MAX_IDS`). One number for every surface that presses a read over a set — the web
 * shell, its Undo and the phone's — so a press and the inverse it offers split alike.
 */
export const MARK_SEEN_CHUNK = 200;

/**
 * Every `mark_seen` wider than {@link MARK_SEEN_CHUNK} split into chunks, in order; every other
 * mutation passes through unchanged. An unsplit inverse would be one refused request taking
 * nothing back.
 */
export function chunkMarkSeen(ms: readonly EngineMutation[]): EngineMutation[] {
  return ms.flatMap((mu) => {
    if (mu.kind !== "mark_seen" || mu.messageIds.length <= MARK_SEEN_CHUNK) return [mu];
    const out: EngineMutation[] = [];
    for (let i = 0; i < mu.messageIds.length; i += MARK_SEEN_CHUNK) {
      out.push(narrowRead(mu, mu.messageIds.slice(i, i + MARK_SEEN_CHUNK)));
    }
    return out;
  });
}

/** A `mark_seen` over `ids` only; an Undo's restore stays present and keeps exactly those ids' entries. */
export function narrowRead<M extends Extract<EngineMutation, { kind: "mark_seen" }>>(mu: M, ids: string[]): M {
  const restore = mu.restoreOpenReadAt;
  if (restore === undefined) return { ...mu, messageIds: ids };
  return { ...mu, messageIds: ids, restoreOpenReadAt: Object.fromEntries(ids.filter((id) => Object.hasOwn(restore, id)).map((id) => [id, restore[id]!])) };
}
