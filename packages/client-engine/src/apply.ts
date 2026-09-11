import type { SyncChange, SyncResponse } from "./types.js";

/**
 * The idempotent apply core (contract §3.3), a port of the Cloud service's
 * proven convergence semantics. The whole contract:
 *   1. sort merged buckets by ascending `seq`;
 *   2. apply keyed on (type,id) as an idempotent upsert;
 *   3. never let an older-or-equal seq overwrite;
 *   4. delete ⇒ tombstone (entity:null); a later create resurrects;
 *   5. move ⇒ upsert the carried entity, or patch `folder` onto the base.
 * The same page twice, pages out of order, or a shuffled stream all converge.
 */

export interface MirrorRecord {
  type: string;
  id: string;
  /** Last applied seq for this row — the replay/out-of-order guard. */
  seq: number;
  /** The live DTO, or null ⇒ tombstone. */
  entity: unknown | null;
}

export function recordKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * Apply a merged change stream into `records` in place. Returns the records
 * actually written (the dirty set a persistent store must flush atomically).
 */
export function applyToRecords(records: Map<string, MirrorRecord>, changes: SyncChange[]): MirrorRecord[] {
  const sorted = [...changes].sort((a, b) => a.seq - b.seq);
  const dirty = new Map<string, MirrorRecord>();

  for (const ch of sorted) {
    const key = recordKey(ch.type, ch.id);
    const rec = records.get(key);

    // Idempotent / out-of-order guard: never let an older-or-equal seq overwrite.
    if (rec && rec.seq >= ch.seq) continue;

    let next: MirrorRecord;
    if (ch.op === "delete") {
      next = { type: ch.type, id: ch.id, seq: ch.seq, entity: null };
    } else if (ch.op === "move") {
      const base = (rec?.entity ?? {}) as Record<string, unknown>;
      const entity = ch.entity ?? { ...base, folder: ch.move?.to };
      next = { type: ch.type, id: ch.id, seq: ch.seq, entity };
    } else {
      // create | update → upsert the DTO.
      next = { type: ch.type, id: ch.id, seq: ch.seq, entity: ch.entity ?? null };
    }
    records.set(key, next);
    dirty.set(key, next);
  }
  return [...dirty.values()];
}

/** Flatten a SyncResponse's four buckets into one change array. */
export function flattenResponse(resp: SyncResponse): SyncChange[] {
  return [
    ...resp.changes.creates,
    ...resp.changes.updates,
    ...resp.changes.moves,
    ...resp.changes.deletes,
  ];
}

/** The max seq present in a change list (0 when empty). */
export function maxSeqOf(changes: SyncChange[]): number {
  let max = 0;
  for (const ch of changes) if (ch.seq > max) max = ch.seq;
  return max;
}
