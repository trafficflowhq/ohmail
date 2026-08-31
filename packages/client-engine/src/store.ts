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

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     THE PERSISTENCE CONTRACT — *the durable cursor moves only after the page it covers is
     durably committed.*

     ── WHAT WAS WRONG, AND WHY EVERY TEST WAS GREEN OVER IT ────────────────────────────────

     `applyResponse` advanced the in-memory cursor and the in-memory records and THEN awaited a
     persist that can fail. IndexedDB gives the write itself atomicity — page and cursor land in
     one transaction or neither does — so the single failed flush was harmless. The next one was
     not: on the retry `applyToRecords` REFUSES the same-seq changes (that is the seq guard doing
     its job), so the dirty set is empty, and the flush writes the NEWER cursor over a disk that
     never received the earlier page's rows. Reload, and the mirror asks `/sync` for changes after
     a cursor whose rows it does not hold. The gap is permanent: deltas are only ever sent once.

     Nothing in memory is wrong at any point, which is exactly why no assertion about the reader
     could see it — the defect is a claim about DISK, and it only becomes visible after a restart.

     ── THE CONTRACT ────────────────────────────────────────────────────────────────────────

     A record applied in memory is UNFLUSHED until a `persist` that carried it has resolved. The
     unflushed set survives a failed flush and rides the next one, so a cursor is never written
     without every row it covers going with it, in the same transaction. Two consequences worth
     stating because they are the ones a reader will want:

      · The in-memory cursor is deliberately NOT rolled back on a failed flush. It is what the
        next `/sync` asks from, and memory genuinely holds the page; rolling it back would
        re-request a page the seq guard would then refuse, which is how the hole was reachable in
        the first place. What must not run ahead is the DURABLE cursor, and it now cannot.
      · A flush that fails repeatedly accumulates. That is bounded by the mirror itself — the
        records are already in memory — and the alternative is dropping a row on the floor.

     ── AND THE WIPE OWES THE SAME PROMISE ──────────────────────────────────────────────────

     `resetForBootstrap` cleared memory and then awaited a wipe that can fail. On failure the disk
     kept the OLD rows while memory was empty, the 410 re-bootstrap then wrote a fresh cursor over
     them, and mail the server had deleted came back on the next restart and stayed. So a failed
     wipe is REMEMBERED (`wipeOwed`) and retried ahead of the next flush; until it succeeds nothing
     is written at all, which is the safe direction — a mirror that cannot clear itself must not
     advance past the state it failed to clear.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  /** Records applied in memory whose flush has not yet resolved, newest per key. */
  private readonly unflushed = new Map<string, MirrorRecord>();
  /** Meta entries in the same state. */
  private readonly unflushedMeta = new Map<string, unknown>();
  /** The cursor waiting to become durable, or `null` when the durable one is current. */
  private unflushedCursor: Cursor | null = null;
  /** A `wipe()` that was asked for and did not complete. Nothing may be written while it stands. */
  private wipeOwed = false;

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

  /**
   * THE ONE WRITE PATH — see the persistence contract above.
   *
   * Everything that persists goes through here rather than calling `persist` directly, because the
   * carry-forward is only a contract if there is no second door. On success only the entries THIS
   * flush actually wrote are retired, matched by IDENTITY rather than by key.
   *
   * **That last part is defence in depth and is labelled as such rather than counted as
   * coverage.** Every flush adds its records and captures its batch with only `settleWipe`
   * between them, so a concurrent apply is captured by its own flush and a key-wise delete would
   * lose nothing today — mutating it reddens nothing, which is written here rather than left for
   * somebody to find and read as a tested guard. It stays because it makes "a flush retires
   * exactly what it wrote" true LOCALLY, without a reader having to trace which awaits sit
   * between the add and the capture. That trace is what a future edit will get wrong.
   */
  private async flush(
    dirty: MirrorRecord[],
    cursor: Cursor | null,
    metaEntries: Array<[string, unknown]>,
  ): Promise<void> {
    for (const rec of dirty) this.unflushed.set(recordKey(rec.type, rec.id), rec);
    for (const [k, v] of metaEntries) this.unflushedMeta.set(k, v);
    if (cursor !== null) this.unflushedCursor = cursor;
    if (this.unflushed.size === 0 && this.unflushedMeta.size === 0 && this.unflushedCursor === null) {
      // Still settle an owed wipe: a reset with nothing to write afterwards must not leave the
      // old database standing because the next caller happened to have no rows.
      await this.settleWipe();
      return;
    }
    await this.settleWipe();
    /**
     * AN UNFLUSHED RECORD IS WRITTEN ONLY WHILE IT IS STILL *THE* RECORD IN MEMORY.
     *
     * The carry-forward's own failure mode, and it is not hypothetical: `load()` REPLACES
     * `this.records` from disk, and `resetForBootstrap` empties it. A carried record from before
     * either one is a row memory has since disowned, and writing it back would resurrect it on
     * disk while the reader shows it gone — the exact inversion of the defect this contract
     * closes. Identity is the right test rather than presence: every writer here (`applyToRecords`,
     * the body cascade, `putLocal`) leaves the object it produced AS the map's value, so a key
     * whose value is no longer this object has been superseded by a newer apply — which flushed
     * itself — or dropped.
     */
    for (const [key, rec] of [...this.unflushed]) {
      if (this.records.get(key) !== rec) this.unflushed.delete(key);
    }
    const batch = [...this.unflushed.entries()];
    const metaBatch = [...this.unflushedMeta.entries()];
    const batchCursor = this.unflushedCursor;
    await this.persist(batch.map(([, r]) => r), batchCursor, metaBatch);
    for (const [key, rec] of batch) {
      if (this.unflushed.get(key) === rec) this.unflushed.delete(key);
    }
    for (const [key, val] of metaBatch) {
      if (this.unflushedMeta.get(key) === val) this.unflushedMeta.delete(key);
    }
    if (this.unflushedCursor === batchCursor) this.unflushedCursor = null;
  }

  /**
   * A WIPE THAT DID NOT HAPPEN IS OWED, NOT FORGOTTEN.
   *
   * Retried ahead of every flush and re-thrown on failure, so a store that cannot clear itself
   * writes nothing at all rather than writing a fresh cursor over rows it meant to delete.
   */
  private async settleWipe(): Promise<void> {
    if (!this.wipeOwed) return;
    await this.wipe();
    this.wipeOwed = false;
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
    await this.flush([], null, [[key, value]]);
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
  private cascadeLocalDeletes(changes: SyncChange[], applied: MirrorRecord[]): MirrorRecord[] {
    // ONLY CHANGES THAT WON THE SEQ GUARD MAY CASCADE. `applied` is `applyToRecords`' own dirty
    // set, and the accepted change for a key is exactly the one whose seq the applied record now
    // carries — an equal-seq mutation echo or an out-of-order replay was REFUSED there, and a
    // cascade that read the raw page anyway would purge a body for a change that changed
    // nothing, violating the idempotent-apply contract (review round 3: rehydrate between the
    // optimistic echo and the sync replay, and the replay deleted the fresh body again).
    const acceptedSeq = new Map<string, number>();
    for (const r of applied) acceptedSeq.set(recordKey(r.type, r.id), r.seq);
    const out: MirrorRecord[] = [];
    for (const ch of changes) {
      if (ch.type !== "message") continue;
      if (acceptedSeq.get(recordKey("message", ch.id)) !== ch.seq) continue;
      const key = recordKey("message_body", ch.id);
      const held = this.records.get(key);
      if (!held || held.entity === null) continue;
      // A delete always sheds the body. A non-delete sheds it in exactly two cases, both read
      // from the mirror rather than the raw delta:
      //  · the message is now PROTECTED — a cached body flipped sensitive must not survive;
      //  · the cached body is a RESTORABLE husk (mail 0065) — `junk_filed`/`expunged` records
      //    are terminal on the client ("ready", never re-asked), but the SERVER can refill
      //    those two: a message restored from the provider's Junk/Trash gets its content back
      //    and announces itself with the very message change in hand. Shedding the husk here is
      //    the invalidation signal — the next open re-fetches and finds either the restored
      //    body or the same husk again. `storage_cap` is deliberately NOT in the set: nothing
      //    restores the cap's husk through an arrival, so shedding it would buy a request that
      //    can only return the same husk, on every later update, for ever.
      if (ch.op !== "delete") {
        const cached = held.entity as { state?: string; withheld?: string | null };
        const withheldHusk = cached.state === "ready"
          && (cached.withheld === "junk_filed" || cached.withheld === "expunged");
        if (!withheldHusk && !isProtectedMessage(this.get<EngineMessage>("message", ch.id))) continue;
      }
      const tombstone: MirrorRecord = { type: "message_body", id: ch.id, seq: 0, entity: null };
      this.records.set(key, tombstone);
      out.push(tombstone);
    }
    return out;
  }

  async applyChanges(changes: SyncChange[]): Promise<void> {
    const applied = applyToRecords(this.records, changes);
    const dirty = [...applied, ...this.cascadeLocalDeletes(changes, applied)];
    this.highSeq = Math.max(this.highSeq, maxSeqOf(changes));
    if (dirty.length > 0) {
      this.ver++;
      await this.flush(dirty, null, []);
    }
  }

  /** See {@link MirrorStore.putLocal} — seq 0, latest wins, never through the seq guard. */
  async putLocal(type: string, id: string, entity: unknown | null): Promise<void> {
    const rec: MirrorRecord = { type, id, seq: 0, entity };
    this.records.set(recordKey(type, id), rec);
    this.ver++;
    await this.flush([rec], null, []);
  }

  async applyResponse(resp: SyncResponse): Promise<void> {
    const changes = flattenResponse(resp);
    // The body cascade rides in this page's dirty set — see `cascadeLocalDeletes`.
    const applied = applyToRecords(this.records, changes);
    const dirty = [...applied, ...this.cascadeLocalDeletes(changes, applied)];
    this.highSeq = Math.max(this.highSeq, maxSeqOf(changes));
    this.cursor = resp.cursor;
    this.ver++;
    // One atomic flush: page + cursor together (contract §3.3 step 3) — and, since the
    // persistence contract above, every page an earlier flush failed to write goes with it, so
    // the durable cursor can never run ahead of the rows it covers.
    await this.flush(dirty, resp.cursor, []);
  }

  /** See {@link MirrorStore.prune} — hard delete, body cascade, cursor and maxSeq untouched. */
  async prune(keys: ReadonlyArray<{ type: string; id: string }>): Promise<void> {
    const gone: string[] = [];
    for (const { type, id } of keys) {
      const key = recordKey(type, id);
      if (this.records.delete(key)) gone.push(key);
      // A pruned row must leave the UNFLUSHED set too, or the next carry-forward would write back
      // a record the pass has just decided this device does not keep — the eviction undone by the
      // very mechanism that exists to stop writes going missing.
      this.unflushed.delete(key);
      if (type !== "message") continue;
      this.unflushed.delete(recordKey("message_body", id));
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
    // Nothing carried forward may survive a reset: an unflushed record from before the 410 would
    // be written back into the database the reset exists to empty.
    this.unflushed.clear();
    this.unflushedMeta.clear();
    this.unflushedCursor = null;
    this.wipeOwed = true;
    await this.settleWipe();
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
