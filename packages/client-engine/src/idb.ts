import type { MirrorRecord } from "./apply.js";
import { BaseMirrorStore, MirrorGenerationChanged } from "./store.js";
import type { Cursor } from "./types.js";

const ENTITIES = "entities";
const META = "meta";
const CURSOR_KEY = "cursor";

/**
 * Where the mirror records WHOSE mail it is holding. Read before anything is hydrated.
 *
 * The `__` prefix keeps it out of the application's own meta namespace, and `load()`
 * strips it the same way it strips the cursor, so `getMeta` can never hand that value back
 * to a selector as though it were product state.
 */
const OWNER_KEY = "__owner";

/**
 * THE CROSS-TAB WIPE FENCE — *no store may write against a baseline another tab has emptied.*
 *
 * A counter bumped by every write that EMPTIES this database — {@link IndexedDbMirrorStore.wipe}
 * and the foreign-owner clear in `bindOwner` — inside the same transaction that does the
 * emptying. Each store instance remembers the value it last saw, and {@link
 * IndexedDbMirrorStore.persist} re-reads it INSIDE its own write transaction and refuses to write
 * against a stale one.
 *
 * ── WHY IT HAS TO BE READ INSIDE THE WRITE TRANSACTION ──────────────────────────────────────
 *
 * The database is shared by every tab on this origin holding this account, and a `410` in one tab
 * wipes it under all the others. A check before the transaction opens is a check against a value
 * that can change before the write lands, which is the shape of the defect rather than a fix for
 * it. IndexedDB serializes readwrite transactions over the same object stores, so a read of this
 * key inside the transaction is the only observation of the baseline that the write is guaranteed
 * to be consistent with.
 *
 * Like {@link OWNER_KEY} it is this store's own bookkeeping: `load()` strips it, so it can never
 * reach `getMeta` and from there a selector.
 */
const GEN_KEY = "__gen";

/** The prefix every account-scoped mirror database name starts with. */
export const MIRROR_DB_PREFIX = "ohmail-mirror";

/**
 * THE DATABASE NAME THAT MUST NEVER BE USED AGAIN.
 *
 * Every build before this repair opened exactly this name, for every account, on every
 * browser. {@link purgeLegacyMirror} deletes it; it is never opened.
 */
export const LEGACY_MIRROR_DB = "ohmail-mirror";

/**
 * The database that holds `owner`'s mirror and no one else's.
 *
 * The account id is a server-issued opaque identifier and is not a secret from the origin
 * that is already holding the account's mail — it is in memory in this tab either way. It
 * is used verbatim rather than hashed so that a human looking at the browser's storage
 * inspector during a support call can tell whose mirror is whose.
 */
export function mirrorDbName(owner: string): string {
  return `${MIRROR_DB_PREFIX}:${owner}`;
}

/** A stored {@link GEN_KEY} as a number; anything unreadable reads as 0, the never-stamped state. */
function generationOf(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function requestDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

export interface IndexedDbMirrorStoreOptions {
  /**
   * THE ACCOUNT THIS MIRROR BELONGS TO — a server-verified account id, never a client
   * guess. Required unless {@link IndexedDbMirrorStoreOptions.dbName} is given.
   *
   * It does two separate jobs and both are load-bearing:
   *
   *  1. it NAMES the database ({@link mirrorDbName}), so two accounts on one browser open
   *     two different databases and can never see each other's cursor or records;
   *  2. it is STAMPED inside the database and checked on every open, so a database whose
   *     name says one account and whose contents were written by another is wiped rather
   *     than read.
   *
   * (2) is not redundant with (1). A name is a convention; the stamp is what makes the
   * guarantee survive a future change to the naming scheme, a restored profile, or a
   * database somebody opened by hand.
   */
  owner?: string;
  /**
   * Database name, overriding {@link IndexedDbMirrorStoreOptions.owner}'s derivation.
   *
   * FOR TESTS AND TOOLS. Passing this without an `owner` opts out of the ownership stamp
   * entirely, which is correct for a fixture database in `fake-indexeddb` and wrong for
   * anything a real account's mail lands in — `apps/webapp` never passes it.
   */
  dbName?: string;
  /** Injectable factory — `fake-indexeddb`'s IDBFactory in tests, else global. */
  factory?: IDBFactory;
}

/**
 * Delete a mirror database. Resolves even when the delete is BLOCKED by another tab that
 * still holds the database open — the caller is doing hygiene, not enforcing an invariant,
 * and a hung promise would be worse than an un-deleted database.
 */
function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.deleteDatabase(name);
    } catch {
      resolve();
      return;
    }
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/**
 * Delete the pre-repair, un-owned mirror.
 *
 * Every account that signed in on a given browser before this change wrote into ONE
 * database called {@link LEGACY_MIRROR_DB}. Renaming forward is not enough on its own:
 * whatever the last account left there is still on disk, still readable by anything on
 * this origin, and still exactly the cross-account material the rename exists to prevent.
 * So it is deleted, once, the first time an owned mirror is constructed.
 */
export function purgeLegacyMirror(factory?: IDBFactory): Promise<void> {
  const f = factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  if (!f) return Promise.resolve();
  return deleteDatabase(f, LEGACY_MIRROR_DB);
}

/**
 * Delete EVERY mirror on this origin — the sign-out / "this is not my computer" path.
 *
 * `IDBFactory.databases()` is the only way to enumerate, and it does not exist on every
 * engine (Firefox shipped it late; some privacy modes stub it). Where it is missing this
 * still deletes the legacy name and the caller's own mirror, which is the case that
 * matters: a sign-out knows who is signing out.
 */
export async function clearAllMirrors(owner?: string, factory?: IDBFactory): Promise<void> {
  const f = factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  if (!f) return;
  const names = new Set<string>([LEGACY_MIRROR_DB]);
  if (owner) names.add(mirrorDbName(owner));
  if (typeof f.databases === "function") {
    try {
      for (const info of await f.databases()) {
        if (info.name && info.name.startsWith(MIRROR_DB_PREFIX)) names.add(info.name);
      }
    } catch {
      /* enumeration refused — the two names above are still deleted */
    }
  }
  await Promise.all([...names].map((n) => deleteDatabase(f, n)));
}

/**
 * The IndexedDB-backed mirror (brief §2: "apply them into a local store —
 * IndexedDB for web"). Layout:
 *
 *   - object store `entities`: key "type:id" → MirrorRecord (tombstones INCLUDED —
 *     they carry the seq guard that makes replays converge);
 *   - object store `meta`: key string → value; the /sync cursor lives at "cursor".
 *
 * Every page is flushed in ONE readwrite transaction across both stores, so the
 * cursor never persists ahead of its page (contract §3.3 step 3).
 */
export class IndexedDbMirrorStore extends BaseMirrorStore {
  private readonly dbName: string;
  private readonly owner: string | null;
  private readonly factory: IDBFactory;
  private db: IDBDatabase | null = null;
  /**
   * The {@link GEN_KEY} value this store last observed on disk — the baseline every write is
   * fenced against. Refreshed by `open()`, by `load()`, and by this store's own `wipe()`.
   */
  private generation = 0;

  constructor(opts: IndexedDbMirrorStoreOptions = {}) {
    super();
    const owner = opts.owner?.trim();
    if (owner) {
      this.owner = owner;
      this.dbName = opts.dbName ?? mirrorDbName(owner);
    } else if (opts.dbName) {
      // The explicit-name escape hatch: fixtures and tooling, never an account's mail.
      this.owner = null;
      this.dbName = opts.dbName;
    } else {
      // THE DEFAULT THAT WAS THE BUG. `dbName ?? "ohmail-mirror"` meant every account on a
      // browser opened the same database and inherited the previous one's cursor and
      // records — /sync is account-filtered but it only MERGES, so nothing ever removed
      // the other account's mail from the mirror and it rendered. There is no safe default
      // for "whose mail is this", so there is no default.
      throw new Error(
        "IndexedDbMirrorStore requires `owner` (a server-verified account id) — an unowned mirror is shared between accounts on the same browser",
      );
    }
    const factory = opts.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
    if (!factory) {
      throw new Error("IndexedDB is unavailable in this environment — use MemoryMirrorStore instead");
    }
    this.factory = factory;
  }

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    const req = this.factory.open(this.dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ENTITIES)) db.createObjectStore(ENTITIES);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    const db = await requestDone(req as IDBRequest<IDBDatabase>);
    // BEFORE the handle is published, and therefore before `load()` can read a record out
    // of it. An ownership check that ran after hydration would be a check on data already
    // in memory and already renderable.
    await this.bindOwner(db);
    // AFTER `bindOwner`, because its foreign-stamp branch is itself a wipe and bumps the counter.
    // This is the baseline every write from this instance is fenced against until `load()` or a
    // `wipe()` moves it.
    this.generation = await this.readGeneration(db);
    /**
     * YIELD TO A DELETE. Measured, not theorised.
     *
     * `deleteDatabase` fires `versionchange` on every OPEN connection and is BLOCKED until
     * they all close. `deleteDatabase` here resolves on `onblocked` deliberately — hygiene
     * must not hang — so a connection that ignores `versionchange` turns "the local copy is
     * wiped" into a silent no-op. And the connection that blocks it is normally OUR OWN: the
     * sign-out and account-erasure paths both run in the page whose engine holds the mirror.
     *
     * Found by deleting a live account through the product's own screen and then asking the
     * browser what databases it still had: `ohmail-mirror:<account>` was still there, and a
     * subsequent `open()` hung behind the pending delete. Every existing test in
     * `idb-owner.test.ts` called `close()` first, so none of them could see it.
     */
    db.onversionchange = () => {
      db.close();
      if (this.db === db) this.db = null;
    };
    this.db = db;
    return db;
  }

  /**
   * Claim this database for {@link owner}, or empty it first.
   *
   * Three cases, and the middle one is the whole point:
   *
   *  - **unstamped** — a database this build has never opened. Claim it. (A mirror written
   *    by a pre-repair build cannot appear here: that one is called
   *    {@link LEGACY_MIRROR_DB} and {@link purgeLegacyMirror} deletes it.)
   *  - **stamped with somebody else** — should be unreachable, because the account is part
   *    of the name. Unreachable states are exactly the ones worth handling: WIPE, then claim.
   *    Refusing to open instead would leave a user staring at a broken client with no way
   *    out; wiping costs a re-bootstrap from `/sync` and is invisible.
   *  - **stamped with us** — the ordinary path, one extra indexed read per session.
   */
  private async bindOwner(db: IDBDatabase): Promise<void> {
    if (this.owner === null) return;
    const read = db.transaction([META], "readonly");
    const stamped = await requestDone(read.objectStore(META).get(OWNER_KEY));
    await txDone(read);
    if (stamped === this.owner) return;

    const tx = db.transaction([ENTITIES, META], "readwrite");
    const meta = tx.objectStore(META);
    // Read the counter BEFORE the clear, in the same transaction: the clear takes it with
    // everything else, and a generation that reset to 0 on every foreign claim would let a stale
    // store's baseline match again by coincidence.
    const gen = generationOf(await requestDone(meta.get(GEN_KEY)));
    if (stamped !== undefined) {
      tx.objectStore(ENTITIES).clear();
      meta.clear();
      // A FOREIGN CLAIM EMPTIES THIS DATABASE, so it is a wipe and owes the bump. Any other
      // connection still open on it must be fenced exactly as it is after a `410`.
      meta.put(gen + 1, GEN_KEY);
    } else {
      meta.put(gen, GEN_KEY);
    }
    meta.put(this.owner, OWNER_KEY);
    await txDone(tx);
  }

  /** The database's current generation, 0 when it has never been stamped. */
  private async readGeneration(db: IDBDatabase): Promise<number> {
    const tx = db.transaction([META], "readonly");
    const raw = await requestDone(tx.objectStore(META).get(GEN_KEY));
    await txDone(tx);
    return generationOf(raw);
  }

  async load(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([ENTITIES, META], "readonly");

    const entityKeys = await requestDone(tx.objectStore(ENTITIES).getAllKeys());
    const entityVals = await requestDone(tx.objectStore(ENTITIES).getAll());
    const metaKeys = await requestDone(tx.objectStore(META).getAllKeys());
    const metaVals = await requestDone(tx.objectStore(META).getAll());
    await txDone(tx);

    this.records.clear();
    this.meta.clear();
    this.highSeq = 0;
    for (let i = 0; i < entityKeys.length; i++) {
      const rec = entityVals[i] as MirrorRecord;
      this.records.set(String(entityKeys[i]), rec);
      if (rec.seq > this.highSeq) this.highSeq = rec.seq;
    }
    for (let i = 0; i < metaKeys.length; i++) {
      this.meta.set(String(metaKeys[i]), metaVals[i]);
    }
    this.cursor = (this.meta.get(CURSOR_KEY) as Cursor | undefined) ?? "0";
    this.meta.delete(CURSOR_KEY);
    // The ownership stamp is this store's bookkeeping, not the application's meta — it
    // must not reach `getMeta` and from there a selector. The generation counter is the same
    // kind of thing, and `load()` is also where this instance's write baseline is re-read: a
    // hydration is by definition a fresh observation of the disk.
    this.meta.delete(OWNER_KEY);
    this.generation = generationOf(this.meta.get(GEN_KEY));
    this.meta.delete(GEN_KEY);
    this.ver++;
  }

  protected async persist(
    dirty: MirrorRecord[],
    cursor: Cursor | null,
    metaEntries: Array<[string, unknown]>,
  ): Promise<void> {
    if (dirty.length === 0 && cursor === null && metaEntries.length === 0) return;
    const db = await this.open();
    const tx = db.transaction([ENTITIES, META], "readwrite");
    const entities = tx.objectStore(ENTITIES);
    const meta = tx.objectStore(META);
    // ── THE FENCE. See {@link GEN_KEY} for why this read is HERE and not before the transaction.
    //
    // Awaiting a request inside an open IndexedDB transaction is sound and is what `load()`
    // already does: the transaction stays alive while a request is pending and commits only when
    // control returns to the event loop with none outstanding, so the puts below are still in
    // this transaction. `tx.abort()` on a mismatch is what makes the refusal atomic — nothing
    // this call was asked to write reaches disk, which is the same all-or-nothing shape the
    // persistence contract already assumes of a failure.
    const found = generationOf(await requestDone(meta.get(GEN_KEY)));
    if (found !== this.generation) {
      const expected = this.generation;
      // Adopt the new baseline BEFORE throwing: the recovery in `BaseMirrorStore` re-persists the
      // client-local records onto it immediately, and a store still holding the superseded number
      // would fence its own recovery for ever.
      this.generation = found;
      // Not awaited, deliberately. The abort's outcome is already decided and the only thing an
      // await could add is a hang if the event never arrives; IndexedDB serializes the next
      // transaction on these stores behind this one either way.
      try { tx.abort(); } catch { /* already settled */ }
      throw new MirrorGenerationChanged(expected, found);
    }
    for (const rec of dirty) {
      entities.put(rec, `${rec.type}:${rec.id}`);
    }
    if (cursor !== null) meta.put(cursor, CURSOR_KEY);
    for (const [k, v] of metaEntries) meta.put(v, k);
    await txDone(tx);
  }

  /**
   * The persisted half of {@link BaseMirrorStore.prune}: `delete`, not a tombstone `put`.
   *
   * ONE transaction over `entities` alone. It deliberately does not open `meta`: the cursor lives
   * there, and a prune that could not touch it even by mistake is a stronger statement than one
   * that merely does not. If this transaction aborts the rows come back on the next `load()`,
   * which is the harmless direction — the pass simply runs again after the next drain.
   */
  protected async purge(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const db = await this.open();
    const tx = db.transaction([ENTITIES], "readwrite");
    const entities = tx.objectStore(ENTITIES);
    for (const key of keys) entities.delete(key);
    await txDone(tx);
  }

  protected async wipe(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([ENTITIES, META], "readwrite");
    const meta = tx.objectStore(META);
    // Read before the clear takes it — see `bindOwner` for why the counter must not reset.
    const gen = generationOf(await requestDone(meta.get(GEN_KEY)));
    tx.objectStore(ENTITIES).clear();
    meta.clear();
    // Clearing META drops the stamp too. Re-write it in the SAME transaction: a database
    // that is empty and unowned would be silently claimable by the next account to open
    // it, which is the state this whole mechanism exists to make impossible.
    if (this.owner !== null) meta.put(this.owner, OWNER_KEY);
    // THE BUMP, in the transaction that does the emptying. Every OTHER connection open on this
    // database is now writing against a baseline that no longer exists and will be refused by
    // the fence in `persist`; this instance moves its own baseline forward so its own next write
    // is not refused for the wipe it just performed.
    const next = gen + 1;
    meta.put(next, GEN_KEY);
    await txDone(tx);
    this.generation = next;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
