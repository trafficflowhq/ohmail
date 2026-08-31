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
 * Delete a mirror database, and SAY WHICH OF THE THREE THINGS HAPPENED.
 *
 * This used to answer `Promise<void>` for all three, with the reasoning that "the caller is
 * doing hygiene, not enforcing an invariant". One of its two callers is `signOut`, and there
 * hygiene is exactly the invariant: `onblocked` fires when ANOTHER TAB still holds the mirror
 * open, the delete then does not happen, and resolving quietly turned "your mail is off this
 * browser" into a sentence nobody had checked. The promise still never hangs — a blocked
 * delete settles immediately, it just settles as `blocked`.
 */
type DeleteOutcome = "deleted" | "blocked" | "error";

function deleteDatabase(factory: IDBFactory, name: string): Promise<DeleteOutcome> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.deleteDatabase(name);
    } catch {
      resolve("error");
      return;
    }
    req.onsuccess = () => resolve("deleted");
    req.onerror = () => resolve("error");
    // NOT a rejection and NOT a hang: another tab is holding the database open, the browser
    // will complete the delete when it closes, and the caller has to be able to say so NOW.
    req.onblocked = () => resolve("blocked");
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
  // Hygiene here really IS hygiene — a once-per-install cleanup with no promise attached to
  // it — so the outcome is discarded on purpose. `clearAllMirrors` is the one that reports.
  return deleteDatabase(f, LEGACY_MIRROR_DB).then(() => undefined);
}

/**
 * EVERY MIRROR NAME THIS ORIGIN HAS EVER OPENED — the answer for a browser that will not
 * enumerate its own databases.
 *
 * `IDBFactory.databases()` is the only way to ask the browser what it holds, and it does not
 * exist everywhere (Firefox shipped it late; some privacy modes stub it away). Without it,
 * `clearAllMirrors` could only delete the legacy name and the caller's OWN mirror — and then
 * reported an empty survivor list, i.e. "this browser holds no mail", over an EARLIER account's
 * database that it had never even named. The header of `sign-out.ts` promises that this browser
 * forgets "including whatever an earlier account left behind"; on those engines it did not, and
 * said it had.
 *
 * So the store writes its own name down when it opens one. `localStorage` and not IndexedDB,
 * deliberately: the registry has to be readable when the databases cannot be listed, and a
 * synchronous read is what a sign-out's last act can rely on. It holds NAMES ONLY — an account
 * id is already in the mirror's name and in the `tf_owner` cookie beside it, so this discloses
 * nothing new — and it is swept by the same sign-out that empties it.
 *
 * Failure here is silent by design: a private mode that refuses writes leaves the registry
 * empty, which is exactly the state this function had before it existed.
 */
export const MIRROR_REGISTRY_PREFIX = "ohmail.mirror.";

/**
 * What a fenced store throws from every write path. Not a sentinel anyone branches on today —
 * it is a sentence a bug report can carry, and the reason a write does not vanish quietly.
 */
/**
 * What a wipe can honestly say. `remaining` is the mirror names still on this origin; `inventory`
 * is whether the question could be answered COMPLETELY at all — a browser with neither
 * `databases()` nor a usable registry can only report on the two names it already knew, and an
 * empty list from it is not a clean browser.
 */
export interface WipeVerdict {
  remaining: string[];
  inventory: "complete" | "partial";
}

export const MIRROR_FENCED =
  "this browser's copy of the mailbox was removed by a sign-out; reload the page";

/**
 * CAN THIS BROWSER'S INVENTORY BE TRUSTED TO BE COMPLETE?
 *
 * Two independent sources answer "what mirrors are on this origin": `IDBFactory.databases()`,
 * and the registry the store writes as it opens one. Where NEITHER is available the delete set
 * is just the legacy name plus the caller's own mirror — and an empty survivor list then means
 * "the two names I know about are gone", not "this browser holds no mail". Reporting that as a
 * clean wipe is the precise shape this whole function was changed to stop.
 *
 * A registry write is best-effort by design (a private mode refuses storage), so an EMPTY
 * registry cannot be told apart from a registry that was never writable. This probes the store
 * instead: if a round trip works, an empty registry is evidence; if it does not, the inventory
 * is admitted as partial and the caller must not claim a clean browser.
 */
function registryReadable(): boolean {
  try {
    const probe = `${MIRROR_REGISTRY_PREFIX}__probe`;
    globalThis.localStorage?.setItem(probe, "1");
    const ok = globalThis.localStorage?.getItem(probe) === "1";
    globalThis.localStorage?.removeItem(probe);
    return ok;
  } catch {
    return false;
  }
}

/**
 * ONE KEY PER MIRROR, NOT ONE ARRAY OF THEM — and the difference is a lost database.
 *
 * The registry was a single JSON array, read-modify-written on first open. `localStorage` is
 * shared across every tab of the origin and offers no atomic update, so two tabs first-opening
 * different mirrors at once both read the same list and the second write erases the first's
 * name. That is ordinary multi-tab use, and it defeated the registry's ONE purpose: on a browser
 * without `databases()` the lost name is a database nothing can enumerate and nothing can name,
 * so a later sign-out deletes what it knows about and reports a clean browser over it.
 *
 * One key per name has no read-modify-write at all: two tabs writing different names touch
 * different keys, and two tabs writing the SAME name write the same bytes.
 */
function registry(): string[] {
  const out: string[] = [];
  try {
    const ls = globalThis.localStorage;
    if (!ls) return out;
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      if (key !== null && key.startsWith(MIRROR_REGISTRY_PREFIX)) {
        const name = key.slice(MIRROR_REGISTRY_PREFIX.length);
        if (name !== "") out.push(name);
      }
    }
  } catch {
    /* storage blocked — `registryReadable()` is what turns that into an honest verdict */
  }
  return out;
}

/** Record a mirror name so a browser without `databases()` can still be told to forget it. */
export function rememberMirror(name: string): void {
  try {
    globalThis.localStorage?.setItem(`${MIRROR_REGISTRY_PREFIX}${name}`, "1");
  } catch {
    /* storage blocked — the registry is a best-effort widening of the delete set, never a lock */
  }
}

function forgetMirrorNames(gone: readonly string[]): void {
  for (const name of gone) {
    try {
      globalThis.localStorage?.removeItem(`${MIRROR_REGISTRY_PREFIX}${name}`);
    } catch {
      /* see `rememberMirror` */
    }
  }
}

/**
 * Delete EVERY mirror on this origin — the sign-out / "this is not my computer" path — and
 * ANSWER WITH THE NAMES THAT ARE STILL THERE.
 *
 * The delete set is the union of three sources: the legacy name, the caller's own mirror, and
 * — for the browsers that will not enumerate — every name this origin has opened
 * ({@link rememberMirror}). `databases()` is still used where it exists, because it is the only
 * source that can see a mirror written before the registry existed or by another tab.
 *
 * ── THE RETURN VALUE IS THE POINT, AND IT USED TO BE `void` ─────────────────────────────
 *
 * An IndexedDB delete is BLOCKED — not failed, not queued: blocked — while any other
 * connection holds the database open, and `deleteDatabase` resolved on `onblocked` as though
 * it had worked. Our OWN page yields (the store's `onversionchange` closes its handle), but a
 * SECOND TAB of this origin does not: sign out in tab A with tab B open on the mailbox, and
 * the browser reported a clean sign-out while every message, thread and screener decision
 * stayed on disk. On the shared or borrowed computer this whole path exists for, that is the
 * one promise it must not break silently.
 *
 * An empty `remaining` is the only thing that means "this browser holds no mirror" — and only
 * when `inventory` is `complete`. Anything else is the caller's to say out loud.
 */
export async function clearAllMirrors(owner?: string, factory?: IDBFactory): Promise<WipeVerdict> {
  const f = factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  // No IndexedDB at all: nothing was ever written, so there is nothing to be unsure about.
  if (!f) return { remaining: [], inventory: "complete" };
  const names = new Set<string>([LEGACY_MIRROR_DB, ...registry()]);
  if (owner) names.add(mirrorDbName(owner));
  const enumerable = typeof f.databases === "function";
  if (enumerable) {
    try {
      for (const info of await f.databases()) {
        if (info.name && info.name.startsWith(MIRROR_DB_PREFIX)) names.add(info.name);
      }
    } catch {
      /* enumeration refused — the two names above are still deleted */
    }
  }
  const outcomes = await Promise.all(
    [...names].map(async (n) => [n, await deleteDatabase(f, n)] as const),
  );

  /**
   * ── AND THEN READ BACK, because the delete's own answer is not the whole story ──────────
   *
   * `blocked` is the one this exists for: another tab of this origin still holds the mirror
   * open, so the database is still on disk with the mail in it. But a `deleted` is worth
   * re-checking too where the browser can be asked, because between the delete and this read
   * the same other tab may have re-OPENED (and so recreated) the name. Where `databases()`
   * does not exist (older Firefox, some privacy modes) the delete's own outcome is the best
   * evidence available and is used as such — an unavailable enumeration must not be reported
   * as a survival.
   */
  const stillHere = new Set(outcomes.filter(([, o]) => o !== "deleted").map(([n]) => n));
  let inventory: WipeVerdict["inventory"] = enumerable || registryReadable() ? "complete" : "partial";
  if (enumerable) {
    try {
      const present = new Set((await f.databases()).map((i) => i.name).filter((n): n is string => !!n));
      // ── ENUMERATION MAY ONLY ADD, NEVER CLEAR ────────────────────────────────────────────
      //
      // This used to `delete` a name the second read did not list, which quietly made
      // enumeration OUTRANK a direct `onblocked` — and `databases()` is the weaker witness of
      // the two. It is specified to answer databases "in this origin", implementations have
      // shipped it stale or partial, and a name omitted from it is not evidence that the
      // database is gone; `onblocked` IS evidence that the delete did not happen. Trusting the
      // weaker one erased a known survivor from the verdict and handed `signOut` a clean
      // `cleared: true` over a mirror another tab was still holding — the defect this whole
      // function was changed to close, reintroduced by its own read-back.
      //
      // So the read-back is one-directional: it can only find a name the delete's own outcome
      // missed (a tab that re-opened the database between the delete and this read). The cost
      // is over-reporting a `blocked` that completed a moment later, which is the safe
      // direction — the remedy the copy names is "close the other tab and press again", and
      // pressing again on an already-clean browser answers empty.
      // EVERY MIRROR THE BROWSER STILL ADMITS TO, not only the ones this call attempted.
      //
      // Scoping the read-back to `outcomes` assumed the delete set was the whole inventory,
      // which is the assumption the first enumeration may have already broken: a listing that
      // is partial on the first call and complete on the second surfaces a mirror this call
      // never tried to delete — an earlier account's, older than the registry — and it would
      // have been reported as absent because it was never attempted. A name the browser says is
      // there is there, whoever asked for it.
      for (const n of present) if (n === LEGACY_MIRROR_DB || n.startsWith(MIRROR_DB_PREFIX)) stillHere.add(n);
    } catch {
      // The read-back is unavailable. The delete outcomes stand, and the inventory is no longer
      // provably complete: an enumeration that refused cannot rule out a database it did not
      // list, which is exactly the claim `cleared` rests on.
      inventory = registryReadable() ? "complete" : "partial";
    }
  }
  const remaining = [...stillHere].sort();
  // The registry keeps only what is still there, so it cannot grow without bound and cannot
  // make a later sign-out re-delete names that are already gone.
  forgetMirrorNames([...names].filter((n) => !stillHere.has(n)));
  return { remaining, inventory };
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

  /**
   * This database was DELETED under us — see the `onversionchange` handler. Once set, this
   * instance never opens again: reopening would recreate the mail a sign-out just removed.
   */
  private fenced = false;

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
    if (this.fenced) throw new Error(MIRROR_FENCED);
    if (this.db) return this.db;
    // WRITTEN DOWN BEFORE THE DATABASE EXISTS, not after. `open` with a version CREATES the
    // database, so a name recorded on success would be missing for exactly the failure that
    // leaves one behind — and the registry's whole job is to name mirrors a later sign-out
    // could otherwise not see (see `rememberMirror`). A name for a database that was never
    // created costs one delete of nothing.
    rememberMirror(this.dbName);
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
    db.onversionchange = (ev) => {
      db.close();
      if (this.db === db) this.db = null;
      /**
       * ── AND A DELETE FENCES THIS STORE FOR GOOD ──────────────────────────────────────────
       *
       * Yielding is only half of cooperating. `newVersion === null` means the connection was
       * closed for a DELETE, and every modern tab of this app runs this same handler — so the
       * usual two-tab sign-out does not even produce a `blocked`: both stores close, the delete
       * succeeds, the verdict is clean, and then the OTHER tab's next drain, flush or tap calls
       * `open()`, recreates the database at generation 0 and writes mail back into it. The
       * person was told this browser holds nothing while a live tab was re-filling it.
       *
       * So a delete is permanent for this instance. `open()` refuses afterwards; `load()` reads
       * that refusal as "empty", which is the truth and keeps a lingering page from throwing;
       * every WRITE path lets it through, because a write that silently vanished would be the
       * same lie one layer down. The tab recovers by reloading, which is what a signed-out tab
       * has to do anyway.
       */
      if ((ev as IDBVersionChangeEvent).newVersion === null) this.fenced = true;
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
    // A FENCED STORE READS AS EMPTY, and does not throw. A page that lingers after a wipe (ours
    // shows a confirmation before navigating) must not die on an `InvalidStateError`, and the
    // honest answer to "what does this browser hold" is: nothing.
    if (this.fenced) {
      this.records.clear();
      this.meta.clear();
      this.highSeq = 0;
      return;
    }
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
