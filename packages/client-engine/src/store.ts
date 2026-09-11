import { applyToRecords, flattenResponse, maxSeqOf, recordKey, type MirrorRecord } from "./apply.js";
import { isCarriedLocalType, isProtectedMessage } from "./types.js";
import type { Cursor, EngineMessage, SyncChange, SyncResponse } from "./types.js";

/**
 * The durable baseline this store was writing against is gone. Thrown by a
 * `persist` that reads a generation stamp inside its own write transaction
 * and finds a different one — another tab wiped the shared database between
 * this store's last read and this write. Not a storage failure and not the
 * caller's: the baseline was superseded, and {@link BaseMirrorStore.flush}
 * turns it into a recovery rather than an error (see the persistence
 * contract). A store with no such stamp (memory, single-process) never throws.
 */
export class MirrorGenerationChanged extends Error {
  constructor(readonly expected: number, readonly found: number) {
    super(`mirror generation changed: this store was writing against ${expected}, the database holds ${found}`);
    this.name = "MirrorGenerationChanged";
  }
}

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
  /**
   * {@link prune}, taking its turn on the same durable-write lane as {@link commitLocal}.
   *
   * For a terminal delete that must not race a re-bootstrap: the reset decides which rows to
   * carry by reading memory, and an unsequenced purge can land between that read and the wipe,
   * so the wipe writes back a row the purge just removed.
   */
  pruneSerialized(keys: ReadonlyArray<{ type: string; id: string }>): Promise<void>;

  /**
   * ── THE OUTBOX'S OWN WRITE: ATOMIC ACROSS KEYS, AND WRITE-THEN-PUBLISH ───────────────────
   *
   * Every put and every delete lands, or none does — one storage transaction — and **memory
   * changes only once that transaction has completed**. On rejection nothing in memory moved and
   * nothing entered the unflushed set.
   *
   * That inversion is the whole point, and it is why this exists beside `putLocal` rather than
   * replacing it. `putLocal` is memory-FIRST: it sets the record, bumps the version and then
   * awaits the flush, so a rejected write leaves the row live in memory and in `unflushed`, where
   * the next unrelated flush persists it. For a /sync row that is correct — the row is
   * re-derivable from the server and the durable cursor must never run ahead of its rows, which is
   * what carry-forward guarantees. For the OUTBOX it is exactly wrong: a queued verb derives from
   * nothing, it IS the user's intent, and its Idempotency-Key is the only thing standing between
   * "retry" and "second delivery". A row that is live in memory but not on disk is a verb that
   * will be dispatched and then forgotten by the next boot — which is how a fresh key, and a
   * second delivery, happen.
   *
   * Atomic ACROSS KEYS because the outbox's transitions move a record between two collections.
   * Abandoning is "write the abandoned row, delete the live row"; as two calls it has a window in
   * which both exist or neither does, and no ordering of the two removes it. As one transaction
   * there is no window.
   *
   * Refuses any put with `seq !== 0`, and takes no cursor and no meta: it cannot move the sync
   * cursor even by mistake — the same statement `purge` already makes.
   */
  commitLocal(
    puts: ReadonlyArray<{ type: string; id: string; entity: unknown }>,
    deletes: ReadonlyArray<{ type: string; id: string }>,
  ): Promise<void>;
  /**
   * HARD-DELETE EVERY RECORD CARRYING EXACTLY `seq` — the abandoned-snapshot-prefix sweep.
   *
   * A snapshot stamps every row it emits with the SAME `seq` (its `asOfSeq`), so one seq value
   * names one snapshot's output exactly. That makes "drop the prefix a previous, abandoned
   * bootstrap left behind" expressible as a single predicate over the mirror rather than as a
   * list somebody has to have kept — which is the point, because the list would itself be
   * in-memory state that a crash destroys.
   *
   * `seq` must be greater than zero and this refuses otherwise: CLIENT-LOCAL records live at
   * seq 0 ({@link MirrorStore.putLocal}), and the durable outbox is one of them. A sweep that
   * accepted 0 would delete the user's queued intents to clean up after a failed bootstrap.
   *
   * Returns how many records went, INCLUDING the cascaded bodies, so a caller can assert the
   * sweep did something rather than assume it.
   */
  pruneBySeq(seq: number): Promise<number>;
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
  /** The seq-0 rows an owed wipe must carry back through — see {@link resetForBootstrap}. */
  private wipeKeep: MirrorRecord[] = [];

  /**
   * HYDRATE FROM STORAGE, AND DROP THE CARRY THE OLD MEMORY OWED.
   *
   * A TEMPLATE METHOD, and the clearing is the whole of it. The carry-forward contract above
   * keeps a failed page's rows in `unflushed` so the next flush takes them with the cursor —
   * correct while memory holds those rows. `readPersisted()` REPLACES memory from disk, so the
   * carried cursor now names a page this store no longer has: the identity sweep in `flush`
   * drops the rows (memory has disowned them) and would then write the cursor alone, past a page
   * disk never received. Unreachable today — the engine's single-flight hydrates once, before
   * its first drain — and the clearing is what keeps it so if that ever changes.
   */
  async load(): Promise<void> {
    await this.readPersisted();
    this.unflushed.clear();
    this.unflushedMeta.clear();
    this.unflushedCursor = null;
  }

  /** Read persisted state into `records`/`meta`/`cursor`. Reached only through {@link load}. */
  protected abstract readPersisted(): Promise<void>;
  /** Flush a dirty set + (optionally) the new cursor + meta entries atomically. */
  protected abstract persist(
    dirty: MirrorRecord[],
    cursor: Cursor | null,
    metaEntries: Array<[string, unknown]>,
  ): Promise<void>;
  /** Drop ALL persisted state. */
  /** `keep` are the seq-0 rows that must survive the clear, written inside the same transaction. */
  protected abstract wipe(keep?: MirrorRecord[]): Promise<void>;
  /**
   * HARD-DELETE persisted records by "type:id" key — the persistence half of {@link prune}.
   *
   * Separate from `persist` because it is the one write in this class that REMOVES rather than
   * upserts, and folding it into the dirty-set flush would mean encoding "gone" as a sentinel
   * record that every reader would then have to know about. It carries no cursor and no meta on
   * purpose: a prune must never be able to move the sync cursor.
   */
  protected abstract purge(keys: string[]): Promise<void>;

  /**
   * The persistence half of {@link BaseMirrorStore.commitLocal} — ONE transaction, all of it or
   * none. Mirrors the `persist`/`purge` split; unlike either, it must not publish anything to
   * memory (its caller does that, and only on success).
   */
  protected abstract transact(puts: MirrorRecord[], deletes: string[]): Promise<void>;

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
    try {
      await this.persist(batch.map(([, r]) => r), batchCursor, metaBatch);
    } catch (err) {
      if (!(err instanceof MirrorGenerationChanged)) throw err;
      await this.adoptWipedBaseline();
      return;
    }
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
    await this.wipe(this.wipeKeep);
    this.wipeOwed = false;
    this.wipeKeep = [];
  }

  /**
   * ANOTHER TAB WIPED THE DATABASE UNDER US. ADOPT ITS BASELINE INSTEAD OF WRITING OVER IT.
   *
   * ── THE DEFECT: ONE TAB'S WIPE, ANOTHER TAB'S CURSOR ─────────────────────────────────────
   *
   * The mirror is per ACCOUNT, not per tab: two tabs signed into one account open the same
   * IndexedDB database. A `410` in tab A calls {@link resetForBootstrap}, which empties that
   * shared database. Tab B knows nothing about it — its memory still holds the whole mirror and a
   * cursor at, say, seq 9 000 — so tab B's very next flush writes its dirty page AND that cursor
   * onto the wiped baseline. On disk: a handful of rows under a cursor that claims nine thousand
   * seqs' worth. Every one of those deltas has already been sent and `/sync` sends a delta once,
   * so the hole is permanent and the next boot renders a truncated mailbox that looks healthy.
   *
   * This is the SAME defect as arm 1 — the cursor advancing on an intent rather than on a fact —
   * with the fact falsified by a different process rather than by a failed write. So it needs the
   * same kind of answer, and a purely in-memory one cannot give it: nothing in tab B's memory is
   * wrong, and there is no moment at which tab B could have noticed. The fence therefore lives in
   * the WRITE TRANSACTION (a generation stamp read where the write happens, see
   * {@link MirrorGenerationChanged}), which is the only place the two tabs are serialized.
   *
   * ── WHAT RECOVERY MEANS, AND WHY IT IS NOT AN ERROR ──────────────────────────────────────
   *
   * The disk is now a fresh, empty mirror at cursor "0", and tab A is already re-bootstrapping it.
   * The honest thing for tab B is to BE that mirror: drop the state the wipe disowned, present
   * itself as cold, and let its own next drain re-bootstrap. Reporting a write failure instead
   * would be false — nothing failed — and rolling back only the cursor would leave memory holding
   * rows the disk does not have, which is arm 1 again from the other side.
   *
   * **The client-local records survive, and that is the one carve-out.** They live at seq 0
   * ({@link MirrorStore.putLocal}) and the DURABLE OUTBOX is one of them: a wipe is a statement
   * about the CURSOR, never about the user's queued intents — exactly the rule the engine's own
   * `410` branch already writes down when it carries the outbox rows through
   * `resetForBootstrap`. They are re-persisted here onto the new baseline, so a kill immediately
   * after the fence still finds them on the next boot. A re-persist that fails leaves them in the
   * unflushed set and the next flush carries them, which is the contract above doing its job.
   */
  private async adoptWipedBaseline(): Promise<void> {
    const kept: MirrorRecord[] = [];
    for (const [key, rec] of [...this.records]) {
      if (rec.seq === 0) kept.push(rec);
      else this.records.delete(key);
    }
    this.meta.clear();
    this.unflushedMeta.clear();
    this.unflushedCursor = null;
    for (const [key, rec] of [...this.unflushed]) {
      if (this.records.get(key) !== rec) this.unflushed.delete(key);
    }
    this.cursor = "0";
    this.highSeq = 0;
    this.ver++;
    if (kept.length === 0) return;
    // EVERY kept record goes back, not merely the ones whose flush had not resolved. That
    // distinction is the whole of the outbox case: a verb written before the wipe was flushed
    // successfully and retired from the unflushed set, so it exists ONLY in this process's
    // memory now that the database it was written to has been emptied. Re-marking them unflushed
    // is what makes a second failure here harmless — they ride the next flush like anything else.
    for (const rec of kept) this.unflushed.set(recordKey(rec.type, rec.id), rec);
    const batch = [...this.unflushed.entries()];
    try {
      await this.persist(batch.map(([, r]) => r), null, []);
    } catch {
      return; // still unflushed; the next flush carries them (the carry-forward contract)
    }
    for (const [key, rec] of batch) {
      if (this.unflushed.get(key) === rec) this.unflushed.delete(key);
    }
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

  /**
   * PER-TYPE BUCKETS, REBUILT LAZILY ONCE PER VERSION — `list`/`entries` used to walk EVERY
   * record for EVERY query, so on a mailbox tens of thousands deep a `list("tag")` over three
   * tags cost a whole-mirror pass, and one render's dozen small-type queries cost a dozen of
   * them. One walk per version builds every type's bucket; each call then copies its own
   * bucket only (a fresh array per call — callers sort the result in place, and that contract
   * predates this cache). Keyed on `ver`, which every write path that MOVES A RECORD bumps — a
   * record write between two reads of the same version cannot exist, so a bucket can never serve
   * stale rows.
   *
   * "Every write path already bumps" is what this used to say, and it is no longer true: `setMeta`
   * writes without bumping, and `applyResponse` bumps only when its dirty set is non-empty. Neither
   * weakens the invariant this cache needs, because the invariant is about RECORDS. Meta lives in
   * its own map and `bucketsOf` never reads it; a page that applied no changes left every record
   * exactly where it was. The distinction is worth keeping sharp: anything that adds, removes or
   * replaces a `MirrorRecord` must bump, and nothing else has to.
   */
  private typeBuckets: { v: number; byType: Map<string, MirrorRecord[]> } | null = null;

  private bucketsOf(type: string): MirrorRecord[] {
    if (this.typeBuckets === null || this.typeBuckets.v !== this.ver) {
      const byType = new Map<string, MirrorRecord[]>();
      for (const rec of this.records.values()) {
        if (rec.entity === null) continue;
        const arr = byType.get(rec.type);
        if (arr) arr.push(rec);
        else byType.set(rec.type, [rec]);
      }
      this.typeBuckets = { v: this.ver, byType };
    }
    return this.typeBuckets.byType.get(type) ?? [];
  }

  list<T = unknown>(type: string): T[] {
    return this.bucketsOf(type).map((rec) => rec.entity as T);
  }

  entries<T = unknown>(type: string): Array<{ id: string; entity: T }> {
    return this.bucketsOf(type).map((rec) => ({ id: rec.id, entity: rec.entity as T }));
  }

  getMeta<T = unknown>(key: string): T | undefined {
    return this.meta.get(key) as T | undefined;
  }

  /**
   * A META WRITE IS NOT AN ENTITY CHANGE, so it does not bump {@link version}.
   *
   * `version()` is documented one line up as the stamp that says a DERIVED CACHE is stale, and
   * every consumer of it derives over entities: the shell re-runs `consentPartition`, the
   * presentation projection and all four pile selectors whenever this number moves
   * (`useEngineVersion` → `useSyncExternalStore`), and `messagesByDateDesc` throws away its
   * shared order. The whole namespace is two keys — `LAST_DRAIN_AT_META` for
   * {@link OhmailEngine.freshness} and the stale-resume verdict, `SNAPSHOT_PREFIX_SEQ_META` for the
   * bootstrap's own bookkeeping — and `idb.ts`/`sql-store.ts` both keep their internal keys out of
   * it precisely so a selector can never reach one.
   *
   * **"Nothing reads meta" is what this said, and it is NOT true**, so the argument is stated the
   * way it actually holds. `apps/mobile/src/state/live.ts`'s `mirrorSettled` reads
   * `getMeta(LAST_DRAIN_AT_META)` directly, and the phone's world memo
   * (`apps/mobile/src/state/world.tsx`) calls it per derivation. What matters is that it does not
   * derive that value THROUGH `version()`: it re-reads the store on each pass, and the pass is
   * triggered by `conn.syncing`, which flips at the same settle. So the phone's settled state and
   * its staleness label still clear in the render they always did — but they now rest on one
   * trigger rather than two, and `world.tsx`'s comment beside that dependency array says so.
   *
   * The cost of bumping was not theoretical. `OhmailEngine.drain()` stamps the completion time
   * here at the end of EVERY drain, including the overwhelmingly common one that carried no
   * changes at all — so an idle desktop window over a large mailbox re-derived and
   * re-rendered the entire mirror once every eight seconds, for ever, to record a timestamp
   * nothing on screen reads through this stamp.
   *
   * The freshness label is unaffected and that is the point of separating the two: the drain
   * announces its settle with its own `notify()`, and `useFreshness` subscribes to notifies
   * rather than to this number, so "as of 14:32 · catching up" still clears at the settle.
   */
  async setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, value);
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
    // nothing, violating the idempotent-apply contract (rehydrate between the
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

  /**
   * See {@link MirrorStore.commitLocal}. Write, THEN publish.
   *
   * `settleWipe()` first, for the reason `flush` does it: nothing may be written while an owed
   * wipe stands, or the write lands on a baseline that is about to be cleared.
   */
  /**
   * ── THE DURABLE-WRITE LANE: `commitLocal` AND `resetForBootstrap` NEVER INTERLEAVE ───────────
   *
   * They are the store's two write-then-publish operations and they contradict each other. A
   * reset decides WHICH rows survive by reading `records`; a commit does not appear in `records`
   * until its transaction has already committed to disk. Run them concurrently and this happens:
   *
   *   1. a send's `commitLocal` opens its transaction — memory deliberately unchanged;
   *   2. a 410 arrives and `resetForBootstrap` snapshots `records`, which does not hold the send;
   *   3. the send's transaction commits and publishes to memory;
   *   4. the wipe runs with the SNAPSHOT and re-puts only what it saw — the send's row is gone
   *      from disk while sitting in memory, and `putOutbox` already answered success;
   *   5. the send reaches the server; a kill before the answer leaves a reboot with no key, and
   *      the next press mints a fresh one and can deliver the message twice.
   *
   * Sequencing is the fix rather than re-reading before the clear, because a re-read only narrows
   * the window: the commit can always land in whatever gap is left between the last read and the
   * clear. Ordering removes the gap instead of shrinking it. Whichever runs first, the other sees
   * a settled world — a commit that finished is IN the snapshot, and one that had not started
   * writes onto the new baseline afterwards, where the generation fence already expects it.
   *
   * The same promise-chain shape as the engine's outbox lane, and for the same reason: callers
   * queue rather than being refused.
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async commitLocal(
    puts: ReadonlyArray<{ type: string; id: string; entity: unknown }>,
    deletes: ReadonlyArray<{ type: string; id: string }>,
  ): Promise<void> {
    if (puts.length === 0 && deletes.length === 0) return;
    return this.serializeWrite(() => this.commitLocalInner(puts, deletes));
  }

  private async commitLocalInner(
    puts: ReadonlyArray<{ type: string; id: string; entity: unknown }>,
    deletes: ReadonlyArray<{ type: string; id: string }>,
  ): Promise<void> {
    const recs: MirrorRecord[] = puts.map((p) => {
      const rec: MirrorRecord = { type: p.type, id: p.id, seq: 0, entity: p.entity };
      return rec;
    });
    await this.settleWipe();
    // The persistence FIRST, and nothing touched until it resolves. A rejection therefore leaves
    // this store exactly as it was — no record, no version bump, nothing in `unflushed` for a
    // later flush to carry to disk behind the caller's back.
    await this.transact(recs, deletes.map((d) => recordKey(d.type, d.id)));
    for (const rec of recs) this.records.set(recordKey(rec.type, rec.id), rec);
    for (const d of deletes) this.records.delete(recordKey(d.type, d.id));
    this.ver++;
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
    /**
     * THE VERSION MOVES FOR ROWS, NOT FOR THE CURSOR — {@link applyChanges}'s guard, which this
     * method was missing.
     *
     * An idle poll is the common case, not the rare one: the drain loop asks every eight seconds
     * and almost every answer is an empty page. This bumped anyway, and `version()` is what the
     * shell's whole-mirror derivation keys on — so a mailbox that had not changed in hours still
     * paid `consentPartition` + the presentation projection + every pile selector, over every
     * message it holds, on every poll. At an eight-second cadence that is one pointless
     * whole-mirror pass per poll for as long as the window stays open, each one also
     * re-rendering the shell.
     *
     * An empty page still moves the CURSOR, and the cursor still has to become durable — hence
     * the flush below is unconditional. What the version promises is only that a derived cache
     * over ENTITIES is stale, and an empty page makes none of them stale. `dirty` covers the
     * body cascade as well as the page's own rows, so a page that changed nothing visible but
     * purged a body still counts as a change.
     */
    if (dirty.length > 0) this.ver++;
    // One atomic flush: page + cursor together (contract §3.3 step 3) — and, since the
    // persistence contract above, every page an earlier flush failed to write goes with it, so
    // the durable cursor can never run ahead of the rows it covers.
    await this.flush(dirty, resp.cursor, []);
  }

  /**
   * {@link prune}, ON THE DURABLE-WRITE LANE.
   *
   * `prune` is memory-first: it evicts, then purges. That direction is right for a terminal
   * delete — gone from memory, still on disk, replayed under the same key — but its persisted
   * half raced `resetForBootstrap` in the same way `commitLocal` did before the lane existed:
   * the reset snapshots which rows to carry, the purge lands, and the wipe writes back a row the
   * purge has just removed. The verb had reached its terminal outcome and comes back on the next
   * boot to be sent again.
   *
   * The memory eviction stays synchronous — three callers depend on it landing before their first
   * await — and only the durable half takes its turn.
   */
  async pruneSerialized(keys: ReadonlyArray<{ type: string; id: string }>): Promise<void> {
    // THE EVICTION HAPPENS HERE, synchronously, before any await — three callers are `void`
    // functions that read the store on the next line. Wrapping the whole of `prune` in the lane
    // pushed it a microtask later and those callers saw the row they had just removed; that is
    // the same defect, in the same three places, that kept this method off `commitLocal`.
    const gone = this.evictLocally(keys);
    if (gone.length === 0) return;
    this.ver++;
    // Only the DURABLE half takes its turn.
    return this.serializeWrite(() => this.purge(gone));
  }

  /** See {@link MirrorStore.prune} — hard delete, body cascade, cursor and maxSeq untouched. */
  async prune(keys: ReadonlyArray<{ type: string; id: string }>): Promise<void> {
    const gone = this.evictLocally(keys);
    if (gone.length === 0) return;
    this.ver++;
    await this.purge(gone);
  }

  /**
   * The MEMORY half of a prune: evict, evict the body cascade, drop them from the unflushed set.
   * Answers the storage keys that must now be purged.
   *
   * Split out because two callers need the eviction to happen at different moments relative to
   * the durable delete — {@link prune} purges immediately, {@link pruneSerialized} queues the
   * purge behind the write lane — and both need the eviction itself to be synchronous.
   */
  private evictLocally(keys: ReadonlyArray<{ type: string; id: string }>): string[] {
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
    return gone;
  }

  /**
   * See {@link MirrorStore.pruneBySeq} — one predicate over the mirror, then the ordinary prune.
   *
   * The scan is over the in-memory map rather than over storage because the map IS the mirror:
   * every record on disk is in it after `load()`, and {@link prune} is what keeps the two in
   * step. Delegating rather than reimplementing is deliberate — the body cascade and the
   * unflushed-set eviction are both properties of `prune`, and a second deletion path would have
   * to remember them.
   */
  async pruneBySeq(seq: number): Promise<number> {
    // seq 0 is where every CLIENT-LOCAL record lives, the durable outbox included. Refusing is
    // not defensiveness: the one caller computes this from a server-supplied `asOfSeq`, and an
    // account whose log is empty answers 0.
    if (!Number.isFinite(seq) || seq <= 0) return 0;
    const victims: Array<{ type: string; id: string }> = [];
    for (const rec of this.records.values()) {
      if (rec.seq === seq) victims.push({ type: rec.type, id: rec.id });
    }
    if (victims.length === 0) return 0;
    const before = this.records.size;
    await this.prune(victims);
    return before - this.records.size;
  }

  async resetForBootstrap(): Promise<void> {
    // THE SAME LANE the durable commits take — see `serializeWrite`. The snapshot below is only
    // trustworthy because no commit can be mid-transaction while this runs.
    return this.serializeWrite(() => this.resetForBootstrapInner());
  }

  private async resetForBootstrapInner(): Promise<void> {
    /**
     * ── THE SEQ-0 ROWS SURVIVE THE 410, AND THEY SURVIVE IT INSIDE THE WIPE ─────────────────
     *
     * A 410 is a statement about the CURSOR, never about the user's intents. Everything with a
     * seq came from the server and comes back from it, and so do most of the seq-0 rows — a
     * `message_body` is re-fetched, a `view_meta` waterline costs one re-mark. The OUTBOX rows
     * derive from nothing a re-bootstrap can return, and they are the whole carve-out: see
     * {@link isCarriedLocalType}. Keeping every seq-0 row instead would be the wider rule
     * `adoptWipedBaseline` uses for the cross-tab case, and it is wrong here — bodies are
     * discarded by a re-bootstrap by design, which `body-hydration.test.ts` pins.
     *
     * The engine used to do this by hand: snapshot the outbox rows, call the wipe, write them
     * back one at a time. That has a durable zero-row window — a kill after the clear, or one
     * refused re-put, and the verbs are gone — and it made the engine a second writer of a rule
     * the store already owns for the cross-tab case (`adoptWipedBaseline` partitions exactly this
     * way). The partition happens here now, and `wipe` puts them back inside its own transaction,
     * so there is no window at all.
     *
     * Computed at call time from `records`, so a `wipeOwed` retry carries them too.
     */
    const carried = (r: MirrorRecord): boolean =>
      r.seq === 0 && r.entity !== null && isCarriedLocalType(r.type);
    this.wipeKeep = [...this.records.values()].filter(carried);
    for (const [k, v] of [...this.records]) {
      if (!carried(v)) this.records.delete(k);
    }
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
  protected async readPersisted(): Promise<void> {
    /* nothing to hydrate */
  }
  protected async persist(): Promise<void> {
    /* in-memory only */
  }
  protected async wipe(): Promise<void> {
    /* in-memory only */
  }
  protected async transact(): Promise<void> {
    /* in-memory only — the base publishes to the map once this resolves, which it always does.
       NOTE for anyone reaching for this store in a durability test: it CANNOT refuse, so it
       cannot exercise `commitLocal`'s rejection path at all. That is the blindness that let the
       first cut of this work go green; use `IndexedDbMirrorStore` with a faulty factory. */
  }
  protected async purge(): Promise<void> {
    /* in-memory only — the base class already dropped the records from the map */
  }
}
