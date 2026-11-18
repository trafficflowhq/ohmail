import type { SyncChange, SyncResponse } from "@ohmail/wire";

/**
 * A minimal reference implementation of the client apply algorithm (contract §3.3):
 * sort merged buckets by ascending seq, apply as an idempotent upsert keyed on
 * (type,id), seq-guard moves, tombstone deletes, resurrect on a later create.
 *
 * This is the correctness ORACLE for SyncService: re-applying a page, applying
 * out-of-order, or applying duplicate seqs must all converge to the same state.
 */
export interface LocalRecord {
  seq: number;
  entity: unknown | null; // null ⇒ tombstone
}

export class ClientMirror {
  readonly store = new Map<string, LocalRecord>();

  private key(c: Pick<SyncChange, "type" | "id">) {
    return `${c.type}:${c.id}`;
  }

  applyChanges(changes: SyncChange[]): void {
    // Step 1 — sort the merged stream by ascending seq (order of record).
    const sorted = [...changes].sort((a, b) => a.seq - b.seq);
    for (const ch of sorted) {
      const key = this.key(ch);
      const rec = this.store.get(key);

      // Idempotent / out-of-order guard: never let an older-or-equal seq overwrite.
      if (rec && rec.seq >= ch.seq) continue;

      if (ch.op === "delete") {
        this.store.set(key, { seq: ch.seq, entity: null });
      } else if (ch.op === "move") {
        const base = (rec?.entity ?? {}) as Record<string, unknown>;
        const entity = ch.entity ?? { ...base, folder: ch.move?.to };
        this.store.set(key, { seq: ch.seq, entity });
      } else {
        // create | update → upsert the DTO.
        this.store.set(key, { seq: ch.seq, entity: ch.entity ?? null });
      }
    }
  }

  applyResponse(resp: SyncResponse): void {
    this.applyChanges([
      ...resp.changes.creates,
      ...resp.changes.updates,
      ...resp.changes.moves,
      ...resp.changes.deletes,
    ]);
  }

  /** The converged live state: entity DTOs keyed by "type:id", tombstones dropped. */
  snapshot(): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const [k, v] of this.store) {
      if (v.entity !== null) out.set(k, v.entity);
    }
    return out;
  }
}

/** Flatten a SyncResponse into a single change array (for shuffling/duplicating in tests). */
export function flatten(resp: SyncResponse): SyncChange[] {
  return [
    ...resp.changes.creates,
    ...resp.changes.updates,
    ...resp.changes.moves,
    ...resp.changes.deletes,
  ];
}
