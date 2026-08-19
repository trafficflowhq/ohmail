import type { MirrorRecord } from "./apply.js";
import { mirrorDbName } from "./idb.js";
import { BaseMirrorStore } from "./store.js";
import type { Cursor } from "./types.js";

/**
 * The SQL-backed mirror — the React Native arm of {@link BaseMirrorStore}, beside the browser's
 * `IndexedDbMirrorStore` (idb.ts). Same layout, same discipline, different persistence engine:
 *
 *   - table `entities`: key "type:id" → the MirrorRecord as JSON (tombstones INCLUDED — they
 *     carry the seq guard that makes replays converge);
 *   - table `meta`: key → JSON value; the /sync cursor lives at "cursor", the ownership stamp
 *     at "__owner".
 *
 * The SQL engine itself is INJECTED, never imported: the app hands in expo-sqlite, tests hand in
 * `node:sqlite`. That keeps this module free of Node built-ins and browser globals — it runs on
 * Hermes, in node, and in a browser test unchanged — and it keeps the engine's published bundle
 * free of a native dependency it can never satisfy. The injection seam is {@link SqlExecutor},
 * kept to the two operations the store actually needs.
 *
 * JSON at rest is not a compromise over IndexedDB's structured clone: every record the mirror
 * holds was born as JSON off the /sync wire (or written by `putLocal` as a plain object), so the
 * round trip is exact.
 */

/** What a bound parameter may be. Everything this store writes is TEXT, but the seam allows
 * what SQLite itself allows so an executor does not need a translation layer. */
export type SqlValue = string | number | null;

/** One row, as the executor hands it back — column name → value. */
export type SqlRow = Record<string, SqlValue>;

/** One parameterized statement, for {@link SqlExecutor.batch}. */
export interface SqlStatement {
  sql: string;
  params?: ReadonlyArray<SqlValue>;
}

/**
 * THE INJECTED SQL ENGINE — the whole of what `SqlMirrorStore` asks of its host.
 *
 * Two operations, and the second one carries the store's central obligation:
 *
 *   - `all` reads rows;
 *   - `batch` executes a list of statements ATOMICALLY — every statement lands or none does.
 *
 * `batch`'s atomicity is not an optimization, it IS the delta-first contract's step 3: a /sync
 * page and its cursor advance in one `batch` call, so a crash between them is not a state the
 * mirror can be in (the twin of idb.ts's single readwrite transaction). An executor that runs
 * the statements outside a transaction has broken the store, whatever else works —
 * `sql-store.test.ts` sweeps every failure point to hold this.
 *
 * Implementations are one screen each: over expo-sqlite, `withTransactionAsync` around
 * `runAsync`; over `node:sqlite`, `BEGIN IMMEDIATE` / `COMMIT` with `ROLLBACK` on throw.
 * Both may be fully synchronous under the Promise types — the store never assumes latency.
 */
export interface SqlExecutor {
  all(sql: string, params?: ReadonlyArray<SqlValue>): Promise<ReadonlyArray<SqlRow>>;
  /** Execute the statements atomically: all land together or none at all. */
  batch(statements: ReadonlyArray<SqlStatement>): Promise<void>;
  /** Release the underlying handle, where the engine has one to release. */
  close?(): void | Promise<void>;
}

export interface SqlMirrorStoreOptions {
  /**
   * THE ACCOUNT THIS MIRROR BELONGS TO — a server-verified account id, never a client guess.
   * Required unless {@link SqlMirrorStoreOptions.dbName} is given. Exactly
   * `IndexedDbMirrorStoreOptions.owner`, and both of its jobs carry over verbatim:
   *
   *  1. it NAMES the database ({@link mirrorDbName} — the same derivation the browser arm
   *     uses), so two accounts on one device open two different databases and can never see
   *     each other's cursor or records;
   *  2. it is STAMPED inside the database and checked on every open, so a database whose name
   *     says one account and whose contents were written by another is wiped rather than read.
   *
   * On mobile one device holds mirrors for accounts on DIFFERENT servers, and two servers'
   * opaque account ids may collide — so the caller composes the owner string from
   * (origin, account id), not the account id alone. The stamp then does for a server switch
   * what it does for an account switch: a mismatch costs a re-bootstrap, never a bleed.
   */
  owner?: string;
  /**
   * Database name, overriding the owner derivation. FOR TESTS AND TOOLS — passing this without
   * an `owner` opts out of the ownership stamp entirely, which is correct for a fixture
   * database and wrong for anything a real account's mail lands in.
   */
  dbName?: string;
  /**
   * Open (creating if needed) the database with this name — the injection seam. The app maps
   * the name onto an expo-sqlite file; tests map it onto a `node:sqlite` handle. The store
   * derives the name and the opener decides what a "database" physically is, which is the same
   * split idb.ts has with its injectable `IDBFactory`.
   */
  open: (dbName: string) => SqlExecutor | Promise<SqlExecutor>;
}

// idb.ts's private twins — same keys, same rules. `load()` strips both out of the application
// meta namespace so neither can reach `getMeta` and from there a selector.
const CURSOR_KEY = "cursor";
const OWNER_KEY = "__owner";

const CREATE_TABLES: SqlStatement[] = [
  { sql: "CREATE TABLE IF NOT EXISTS entities (key TEXT PRIMARY KEY, record TEXT NOT NULL)" },
  { sql: "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)" },
];

const UPSERT_ENTITY =
  "INSERT INTO entities (key, record) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET record = excluded.record";
const UPSERT_META =
  "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

/** Meta values are JSON at rest; `undefined` has no JSON spelling and becomes `null`. */
const encodeMeta = (value: unknown): string => JSON.stringify(value ?? null);

export class SqlMirrorStore extends BaseMirrorStore {
  private readonly dbName: string;
  private readonly owner: string | null;
  private readonly opener: (dbName: string) => SqlExecutor | Promise<SqlExecutor>;
  private db: SqlExecutor | null = null;
  private opening: Promise<SqlExecutor> | null = null;
  /**
   * TRUE from the moment a flush FAILED until the next successful rehydration — the guard that
   * keeps a later cursor from committing over a hole.
   *
   * `BaseMirrorStore.applyResponse` advances the in-memory records and cursor BEFORE the flush,
   * so a persist that dies leaves memory one page ahead of disk. The page's own failure is
   * surfaced and harmless — a reload replays it. What is NOT harmless is the write after it: a
   * RETRY drains from the in-memory cursor, fetches the NEXT page, and flushes that page's rows
   * with that page's cursor — past rows that never reached sqlite. The seq guard cannot help
   * (the rows are absent, not stale), so the mirror settles into a permanently truncated state
   * that looks healthy. Poisoning every subsequent write until `load()` has re-read the disk
   * (re-syncing memory with persisted truth, so the hole is re-fetched) makes that state
   * unreachable. Found by review, held by the "poisons the store" case in `sql-store.test.ts`.
   */
  private torn = false;

  constructor(opts: SqlMirrorStoreOptions) {
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
      // No default for "whose mail is this" — the browser arm learned this the expensive way
      // (idb.ts: one shared database, two accounts, the first one's mail rendering to the
      // second). A refusal here is what keeps the lesson from being re-learned on sqlite.
      throw new Error(
        "SqlMirrorStore requires `owner` (a server-verified account id) — an unowned mirror is shared between accounts on the same device",
      );
    }
    this.opener = opts.open;
  }

  /**
   * Open lazily, once: create the schema, then bind ownership — BEFORE the handle is published,
   * and therefore before `load()` can read a record out of it. An ownership check that ran
   * after hydration would be a check on data already in memory and already renderable.
   *
   * A FAILED open does not latch: the promise is cleared so the next call retries against a
   * host whose storage may have recovered. It also never falls back to anything — a store that
   * cannot open REJECTS, and the composition above decides what a user sees. Quietly handing
   * back an empty in-memory mirror here would be the cold-mirror trap the mobile ruling names
   * (risk 1): an app that looks freshly installed over a mailbox that is actually on the device.
   */
  private open(): Promise<SqlExecutor> {
    if (this.db) return Promise.resolve(this.db);
    if (!this.opening) {
      this.opening = (async () => {
        const db = await this.opener(this.dbName);
        try {
          await db.batch(CREATE_TABLES);
          await this.bindOwner(db);
        } catch (err) {
          // The opener succeeded and THEN the ceremony failed: the executor was never
          // published to `this.db`, so nothing else will ever close it. Release it here or
          // every retry after a disk-full/corruption leaks one native handle and its locks.
          try {
            await db.close?.();
          } catch {
            /* closing a broken handle may itself refuse — the leak is what mattered */
          }
          throw err;
        }
        this.db = db;
        return db;
      })();
      this.opening.catch(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  /**
   * Claim this database for {@link owner}, or empty it first — idb.ts's `bindOwner`, verbatim
   * in behaviour. Three cases, and the middle one is the whole point:
   *
   *  - **unstamped** — a database this build has never opened. Claim it.
   *  - **stamped with somebody else** — should be unreachable, because the account is part of
   *    the name. Unreachable states are exactly the ones worth handling: WIPE, then claim, in
   *    ONE atomic batch — a wipe that landed without its claim would leave the database empty
   *    and claimable, which is the state this mechanism exists to make impossible.
   *  - **stamped with us** — the ordinary path, one extra indexed read per open.
   */
  private async bindOwner(db: SqlExecutor): Promise<void> {
    if (this.owner === null) return;
    const rows = await db.all("SELECT value FROM meta WHERE key = ?", [OWNER_KEY]);
    const stamped = rows.length > 0 ? (JSON.parse(String(rows[0]!.value)) as unknown) : undefined;
    if (stamped === this.owner) return;

    const statements: SqlStatement[] = [];
    if (stamped !== undefined) {
      statements.push({ sql: "DELETE FROM entities" }, { sql: "DELETE FROM meta" });
    }
    statements.push({ sql: UPSERT_META, params: [OWNER_KEY, encodeMeta(this.owner)] });
    await db.batch(statements);
  }

  async load(): Promise<void> {
    const db = await this.open();
    // ONE statement, so both tables are read at ONE point — the sqlite twin of idb.ts reading
    // its two object stores in a single readonly transaction. Two separate SELECTs are two
    // read transactions, and another handle on the same database (the disconnect-while-drain
    // shape) could commit a page between them: this load would then hydrate the OLD rows with
    // the NEW cursor, and the session would resume past mail it never read.
    const rows = await db.all(
      "SELECT 'entity' AS kind, key, record AS value FROM entities " +
        "UNION ALL SELECT 'meta' AS kind, key, value AS value FROM meta",
    );

    this.records.clear();
    this.meta.clear();
    this.highSeq = 0;
    for (const row of rows) {
      if (row.kind === "entity") {
        const rec = JSON.parse(String(row.value)) as MirrorRecord;
        this.records.set(String(row.key), rec);
        if (rec.seq > this.highSeq) this.highSeq = rec.seq;
      } else {
        this.meta.set(String(row.key), JSON.parse(String(row.value)));
      }
    }
    this.cursor = (this.meta.get(CURSOR_KEY) as Cursor | undefined) ?? "0";
    this.meta.delete(CURSOR_KEY);
    // The ownership stamp is this store's bookkeeping, not the application's meta — it must
    // not reach `getMeta` and from there a selector.
    this.meta.delete(OWNER_KEY);
    // Memory now equals persisted truth, so a torn flush (see {@link torn}) is healed: the
    // rows the failed page put in memory are gone and the cursor is disk's, so the next drain
    // re-fetches the hole instead of writing past it.
    this.torn = false;
    this.ver++;
  }

  /** ONE atomic batch per flush: page + cursor + meta land together (contract §3.3 step 3). */
  protected async persist(
    dirty: MirrorRecord[],
    cursor: Cursor | null,
    metaEntries: Array<[string, unknown]>,
  ): Promise<void> {
    if (dirty.length === 0 && cursor === null && metaEntries.length === 0) return;
    if (this.torn) {
      throw new Error(
        "the mirror's memory is ahead of its storage (a flush failed) — reload() before writing, or the cursor would commit past a page sqlite never received",
      );
    }
    const db = await this.open();
    const statements: SqlStatement[] = dirty.map((rec) => ({
      sql: UPSERT_ENTITY,
      params: [`${rec.type}:${rec.id}`, JSON.stringify(rec)],
    }));
    if (cursor !== null) statements.push({ sql: UPSERT_META, params: [CURSOR_KEY, encodeMeta(cursor)] });
    for (const [k, v] of metaEntries) statements.push({ sql: UPSERT_META, params: [k, encodeMeta(v)] });
    try {
      await db.batch(statements);
    } catch (err) {
      // Memory advanced before this flush; disk did not. See {@link torn} — every later write
      // refuses until `load()` re-reads the disk, so the hole gets re-fetched, never sealed over.
      this.torn = true;
      throw err;
    }
  }

  /**
   * The persisted half of {@link BaseMirrorStore.prune}: `DELETE`, not a tombstone upsert, and
   * it deliberately never touches `meta` — the cursor lives there, and a prune that could not
   * move the cursor even by mistake is a stronger statement than one that merely does not.
   */
  protected async purge(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const db = await this.open();
    await db.batch(keys.map((key) => ({ sql: "DELETE FROM entities WHERE key = ?", params: [key] })));
  }

  protected async wipe(): Promise<void> {
    const db = await this.open();
    const statements: SqlStatement[] = [{ sql: "DELETE FROM entities" }, { sql: "DELETE FROM meta" }];
    // Clearing meta drops the stamp too. Re-write it in the SAME batch: a database that is
    // empty and unowned would be silently claimable by the next account to open it.
    if (this.owner !== null) statements.push({ sql: UPSERT_META, params: [OWNER_KEY, encodeMeta(this.owner)] });
    await db.batch(statements);
    // A successful wipe puts disk exactly where `resetForBootstrap` just put memory (empty,
    // cursor "0"), so a standing torn flag is healed — the re-bootstrap IS the recovery.
    this.torn = false;
  }

  close(): void {
    void this.db?.close?.();
    this.db = null;
    this.opening = null;
  }
}
