import { applyToRecords, flattenResponse, maxSeqOf, recordKey, type MirrorRecord } from "./apply.js";
import { isProtectedMessage } from "./types.js";
import type { Cursor, EngineMessage, SyncChange, SyncResponse } from "./types.js";

/**
 * Synchronous, read-only access to the mirror — what selectors and the search
 * index consume. Both the stores and the engine's optimistic overlay implement
 * it, so every view computes with zero network AND zero await in the hot path
 * (brief §6: instant navigation).
 */
export interface EntityReader {
  get<T = unknown>(type: string, id: string): T | undefined;
  list<T = unknown>(type: string): T[];
  /** Like list(), but with the record id (some DTOs — message_state — carry no `id`). */
  entries<T = unknown>(type: string): Array<{ id: string; entity: T }>;
  /** Monotonic change stamp — bump ⇒ any derived cache (search index…) is stale. */
  version(): number;
}

/**
 * The local mirror: entities by (type,id), the /sync cursor, and meta. Writes
 * are async (IndexedDB); reads are sync from the in-memory cache. The cursor is
 * persisted ONLY together with its fully-applied page (contract §3.3 step 3) —
 * a crash mid-page re-fetches, never skips.
 */
export interface MirrorStore extends EntityReader {
  /** Hydrate the in-memory cache from persistence. Must be called once before use. */
  load(): Promise<void>;
  getCursor(): Cursor;
  /** Highest seq ever applied (0 on a fresh mirror). */
  maxSeq(): number;
  /** Apply one /sync page AND advance the cursor, atomically. */
  applyResponse(resp: SyncResponse): Promise<void>;
  /** Apply changes without touching the cursor (optimistic echo, §3.4). */
  applyChanges(changes: SyncChange[]): Promise<void>;
  /**
   * Write — or, with `entity: null`, tombstone — ONE CLIENT-LOCAL record: a record whose
   * type `/sync` has no vocabulary for, so the server can neither send it nor contradict it.
   * `message_body` is the first.
   *
   * It bypasses `applyToRecords` on purpose. That function's job is the seq contract —
   * ordering, replay, "never let an older-or-equal seq overwrite" — and a client-local
   * record has no seq to order it by: it did not come from the log. Pushing one through
   * with a synthetic seq would either be refused by the guard on the second write (same id,
   * same seq) or move `maxSeq()` past deltas the mirror never applied. So these records sit
   * at `seq: 0` and are simply overwritten, which is what "local, latest wins" means.
   *
   * There is no risk of collision with the log: `applyToRecords` only ever writes types the
   * server sent, and the server has never heard of this one. If `/sync` ever DOES learn a
   * type written here, its `create` carries a real seq and wins over the 0 — which is the
   * right outcome and needs no special case.
   */
  putLocal(type: string, id: string, entity: unknown | null): Promise<void>;
  getMeta<T = unknown>(key: string): T | undefined;
  setMeta(key: string, value: unknown): Promise<void>;
  /**
   * HARD-DELETE records the client has chosen not to keep — the windowed-store eviction pass.
   *
   * ## HARD DELETE, NOT A TOMBSTONE, AND THAT IS THE WHOLE DESIGN
   *
   * Every other removal in this file writes `entity: null` at the deleting change's seq, because
   * the seq guard in `applyToRecords` is what makes a replayed page converge. A prune is the
   * opposite case: the row is being dropped for LOCAL storage reasons, the server still has it,
   * and the client wants it BACK the moment it becomes interesting again. A tombstone would carry
   * a seq, and the seq guard would then refuse every later delta at or below it — so an update to
   * a pruned message would be silently dropped and the row would stay invisible forever.
   *
   * Deleting the record outright leaves NO seq to guard against, so the next `/sync` change that
   * mentions the id re-materializes it. That is sound only because `/sync` changes carry FULL
   * DTOs (contract §3.1 — `entity` is the whole resource, not a patch), so a plain `update` is
   * enough to rebuild a row from nothing. `applyToRecords`'s `create|update` branch upserts the
   * carried entity without consulting what was there before, which is exactly what is needed.
   *
   * ## `message_body` CASCADES
   *
   * Raw body text must not sit at rest without the message it belongs to. A
   * `message_body` is client-local — `/sync` has no vocabulary for it, so nothing else will ever
   * remove one — and it is the single largest thing the mirror holds. Pruning a `message` without
   * its body would evict the row and keep the payload, which inverts the point of the pass. So
   * the cascade is structural here, exactly as it is in {@link cascadeLocalDeletes}, rather than
   * a rule each caller has to remember.
   *
   * `maxSeq()` and the cursor are NOT touched. Pruning is a statement about local storage, never
   * about how much of the log this client has seen; moving either backwards would re-request
   * deltas already applied to the rows that were kept.
   */
  prune(keys: ReadonlyArray<{ type: string; id: string }>): Promise<void>;
  /** Discard all local state and reset the cursor to "0" (410 re-bootstrap, §3.2). */
  resetForBootstrap(): Promise<void>;
  /** Overwrite the in-memory cursor (dev/test only — e.g. forcing a 410 path). */
  forceCursor(cursor: Cursor): void;
  /** Live entities keyed "type:id", tombstones dropped — the convergence oracle view. */
  snapshot(): Map<string, unknown>;
}

export abstract class BaseMirrorStore implements MirrorStore {
  protected readonly records = new Map<string, MirrorRecord>();
  protected readonly meta = new Map<string, unknown>();
  protected cursor: Cursor = "0";
  protected highSeq = 0;
  protected ver = 0;

  abstract load(): Promise<void>;
  /** Flush a dirty set + (optionally) the new cursor + meta entries atomically. */
  protected abstract persist(
    dirty: MirrorRecord[],
    cursor: Cursor | null,
    metaEntries: Array<[string, unknown]>,
  ): Promise<void>;
  /** Drop ALL persisted state. */
  protected abstract wipe(): Promise<void>;
  /**
   * HARD-DELETE persisted records by "type:id" key — the persistence half of {@link prune}.
   *
   * Separate from `persist` because it is the one write in this class that REMOVES rather than
   * upserts, and folding it into the dirty-set flush would mean encoding "gone" as a sentinel
   * record that every reader would then have to know about. It carries no cursor and no meta on
   * purpose: a prune must never be able to move the sync cursor.
   */
  protected abstract purge(keys: string[]): Promise<void>;

  getCursor(): Cursor {
    return this.cursor;
  }

  forceCursor(cursor: Cursor): void {
    this.cursor = cursor;
  }

  maxSeq(): number {
    return this.highSeq;
  }

  version(): number {
    return this.ver;
  }

  get<T = unknown>(type: string, id: string): T | undefined {
    const rec = this.records.get(recordKey(type, id));
    return rec && rec.entity !== null ? (rec.entity as T) : undefined;
  }

  list<T = unknown>(type: string): T[] {
    const out: T[] = [];
    for (const rec of this.records.values()) {
      if (rec.type === type && rec.entity !== null) out.push(rec.entity as T);
    }
    return out;
  }

  entries<T = unknown>(type: string): Array<{ id: string; entity: T }> {
    const out: Array<{ id: string; entity: T }> = [];
    for (const rec of this.records.values()) {
      if (rec.type === type && rec.entity !== null) out.push({ id: rec.id, entity: rec.entity as T });
    }
    return out;
  }

  getMeta<T = unknown>(key: string): T | undefined {
    return this.meta.get(key) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, value);
    this.ver++;
    await this.persist([], null, [[key, value]]);
  }

  /**
   * A DELETED — OR NEWLY PROTECTED — MESSAGE SHEDS ITS HYDRATED BODY.
   *
   * `message_body` is client-local, so `/sync` can never delete or overwrite one — the property
   * that makes a delta unable to wipe a body mid-read. The flip side is that nothing ELSE will
   * ever remove one either, so the two transitions that must not leave the raw text behind have
   * to be cascaded here or it sits in IndexedDB (and, through {@link SearchIndex}, the local
   * search index) unreferenced and unreachable:
   *
   *  · a `message` DELETE — the FULL TEXT of a deleted message would otherwise survive forever,
   *    un-evicted and undeletable through any path the product offers, against the promise that
   *    a person's mail is theirs to delete; and
   *  · a `message` that BECOMES PROTECTED — a body cached while the message was ordinary, then
   *    flipped sensitive by a server-side redaction pass or a late reclassification, is the raw
   *    secret sensitive mail is stored redacted to avoid, reproduced on the client.
   *    `hydrateBody` refuses to cache one going
   *    forward; this purges one already cached. The protected test reads the POST-APPLY mirror
   *    state — this method runs after `applyToRecords` has mutated the map — so a replayed or
   *    older-seq update that did NOT win cannot trigger a purge, and no false `message` delete is
   *    emitted (the message is not deleted; its DTO stays, only the local body goes).
   *
   * So the cascade is structural rather than a cleanup somebody runs: the tombstones join the
   * page's own dirty set and land in the SAME `persist` flush, which is the atomicity contract
   * §3.3 step 3 already gives the cursor. A crash between the two is not a state this can be in.
   *
   * It is one pass over the changes, and it touches the map only for ids that actually have a
   * live body — on the ordinary drain (nothing deleted, nothing newly protected, or such changes
   * for messages nobody opened) it allocates nothing.
   */
  private cascadeLocalDeletes(changes: SyncChange[]): MirrorRecord[] {
    const out: MirrorRecord[] = [];
    for (const ch of changes) {
      if (ch.type !== "message") continue;
      const key = recordKey("message_body", ch.id);
      const held = this.records.get(key);
      if (!held || held.entity === null) continue;
      // A delete always sheds the body. A non-delete sheds it in exactly two cases, both read
      // from the mirror rather than the raw delta, so a change `applyToRecords` refused
      // (older-or-equal seq) cannot purge a body it never applied:
      //  · the message is now PROTECTED — a cached body flipped sensitive must not survive;
      //  · the cached body is a WITHHELD husk (mail 0065) — a `junk_filed`/`expunged` record is
      //    terminal on the client ("ready", never re-asked), but the SERVER can refill it: a
      //    message restored from the provider's Junk/Trash gets its content back and announces
      //    itself with the very message change in hand. Shedding the husk here is the
      //    invalidation signal — the next open re-fetches and finds either the restored body or
      //    the same husk again (one cheap re-ask on the rare update of an unrestored husk).
      if (ch.op !== "delete") {
        const cached = held.entity as { state?: string; withheld?: string | null };
        const withheldHusk = cached.state === "ready" && cached.withheld != null;
        if (!withheldHusk && !isProtectedMessage(this.get<EngineMessage>("message", ch.id))) continue;
      }
      const tombstone: MirrorRecord = { type: "message_body", id: ch.id, seq: 0, entity: null };
      this.records.set(key, tombstone);
      out.push(tombstone);
    }
    return out;
  }

  async applyChanges(changes: SyncChange[]): Promise<void> {
    const dirty = [...applyToRecords(this.records, changes), ...this.cascadeLocalDeletes(changes)];
    this.highSeq = Math.max(this.highSeq, maxSeqOf(changes));
    if (dirty.length > 0) {
      this.ver++;
      await this.persist(dirty, null, []);
    }
  }

  /** See {@link MirrorStore.putLocal} — seq 0, latest wins, never through the seq guard. */
  async putLocal(type: string, id: string, entity: unknown | null): Promise<void> {
    const rec: MirrorRecord = { type, id, seq: 0, entity };
    this.records.set(recordKey(type, id), rec);
    this.ver++;
    await this.persist([rec], null, []);
  }

  async applyResponse(resp: SyncResponse): Promise<void> {
    const changes = flattenResponse(resp);
    // The body cascade rides in this page's dirty set — see `cascadeLocalDeletes`.
    const dirty = [...applyToRecords(this.records, changes), ...this.cascadeLocalDeletes(changes)];
    this.highSeq = Math.max(this.highSeq, maxSeqOf(changes));
    this.cursor = resp.cursor;
    this.ver++;
    // One atomic flush: page + cursor together (contract §3.3 step 3).
    await this.persist(dirty, resp.cursor, []);
  }

  /** See {@link MirrorStore.prune} — hard delete, body cascade, cursor and maxSeq untouched. */
  async prune(keys: ReadonlyArray<{ type: string; id: string }>): Promise<void> {
    const gone: string[] = [];
    for (const { type, id } of keys) {
      const key = recordKey(type, id);
      if (this.records.delete(key)) gone.push(key);
      if (type !== "message") continue;
      // The cascade. Note it runs whether or not the message record itself was present: a body
      // whose message is already gone is precisely the orphan this must not leave behind.
      const bodyKey = recordKey("message_body", id);
      if (this.records.delete(bodyKey)) gone.push(bodyKey);
    }
    if (gone.length === 0) return;
    this.ver++;
    await this.purge(gone);
  }

  async resetForBootstrap(): Promise<void> {
    this.records.clear();
    this.meta.clear();
    this.cursor = "0";
    this.highSeq = 0;
    this.ver++;
    await this.wipe();
  }

  snapshot(): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const [k, v] of this.records) {
      if (v.entity !== null) out.set(k, v.entity);
    }
    return out;
  }

  /** Raw record access (seq inspection in tests). */
  record(type: string, id: string): MirrorRecord | undefined {
    return this.records.get(recordKey(type, id));
  }
}

/**
 * The in-memory mirror — SSR, tests, and the fallback when IndexedDB is
 * unavailable. Identical semantics to the IndexedDB store minus persistence.
 */
export class MemoryMirrorStore extends BaseMirrorStore {
  async load(): Promise<void> {
    /* nothing to hydrate */
  }
  protected async persist(): Promise<void> {
    /* in-memory only */
  }
  protected async wipe(): Promise<void> {
    /* in-memory only */
  }
  protected async purge(): Promise<void> {
    /* in-memory only — the base class already dropped the records from the map */
  }
}
