import type { MirrorRecord } from "./apply.js";
import { mirrorDbName } from "./idb.js";
import { BaseMirrorStore } from "./store.js";
import type { Cursor } from "./types.js";

/**
 * The SQL-backed mirror — the React Native arm of {@link BaseMirrorStore},
 * beside the browser's `IndexedDbMirrorStore` (idb.ts). Table `entities`
 * keys "type:id" → MirrorRecord JSON (tombstones included — they carry the
 * seq guard); table `meta` holds the /sync cursor at "cursor" and the
 * ownership stamp at "__owner". The SQL engine is injected, never imported
 * (app: expo-sqlite; tests: `node:sqlite`) — the seam is
 * {@link SqlExecutor}, two operations, no Node built-ins. JSON at rest is
 * exact: every record was born as JSON off the /sync wire.
 */

/** What a bound parameter may be. Everything this store writes is TEXT, but the seam allows
 * what SQLite itself allows so an executor does not need a translation layer. */
/** What a closed {@link SqlMirrorStore} rejects with. A sentence a bug report can carry. */
export const SQL_MIRROR_CLOSED =
  "this mirror was closed — a new session builds a new store rather than reopening this one";

export type SqlValue = string | number | null;

/** One row, as the executor hands it back — column name → value. */
export type SqlRow = Record<string, SqlValue>;

/** One parameterized statement, for {@link SqlExecutor.batch}. */
export interface SqlStatement {
  sql: string;
  params?: ReadonlyArray<SqlValue>;
}

/**
 * The injected SQL engine — all `SqlMirrorStore` asks of its host: `all`
 * reads rows; `batch` executes a list of statements atomically. That
 * atomicity IS the delta-first contract's step 3: a /sync page and its
 * cursor advance in one `batch`, so a crash between them is not a state the
 * mirror can be in (the twin of idb.ts's single readwrite transaction). An
 * executor that runs statements outside a transaction has broken the store
 * — `sql-store.test.ts` sweeps every failure point. Implementations are one
 * screen each and may be fully synchronous under the Promise types.
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
   * The account this mirror belongs to — a server-verified account id,
   * never a client guess; required unless
   * {@link SqlMirrorStoreOptions.dbName} is given. Exactly
   * `IndexedDbMirrorStoreOptions.owner`: it names the database
   * ({@link mirrorDbName}) so two accounts open two databases, and it is
   * stamped inside and checked on every open. On mobile two servers' ids
   * may collide, so the caller composes the owner from (origin, account
   * id); a server switch costs a re-bootstrap, never a bleed.
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
   * True from a failed flush until the next successful rehydration — keeps
   * a later cursor from committing over a hole. `applyResponse` advances
   * memory before the flush, so a dead persist leaves memory a page ahead
   * of disk; a retry would flush the NEXT page past rows that never reached
   * sqlite, and the seq guard cannot help (rows absent, not stale) — a
   * truncated mirror that looks healthy. Poisoning every write until
   * `load()` re-reads the disk makes that unreachable. Held by the "poisons
   * the store" case in `sql-store.test.ts`.
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

  /** See {@link close}: once closed, this instance may never open — or create — its database. */
  private closed = false;

  /**
   * Open lazily, once: create the schema, then bind ownership — before the
   * handle is published, so before `load()` can read a record out of it.
   * A failed open does not latch: the promise clears so the next call
   * retries against storage that may have recovered. It never falls back:
   * a store that cannot open rejects, and the composition above decides
   * what a user sees — quietly handing back an empty in-memory mirror is
   * the cold-mirror trap the mobile ruling names (risk 1).
   */
  private open(): Promise<SqlExecutor> {
    // A closed store is closed for good. `close()` once only nulled the
    // handle, so any later call reopened — on this arm, CREATED — the
    // database: a forget became a race where an in-flight mutation settled
    // after the wipe and recreated the database, outbox and pages included,
    // with no debt left to delete it. The latch is permanent for this
    // instance; a new session builds a new store (which every caller here
    // already does), and this one never speaks to sqlite again.
    if (this.closed) return Promise.reject(new Error(SQL_MIRROR_CLOSED));
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
   * Claim this database for {@link owner}, or empty it first — idb.ts's
   * `bindOwner`, verbatim in behaviour. Three cases: unstamped — claim it;
   * stamped with somebody else — should be unreachable since the account is
   * part of the name, and unreachable states are the ones worth handling:
   * wipe then claim in ONE atomic batch (a wipe landing without its claim
   * would leave the database empty and claimable); stamped with us — the
   * ordinary path, one extra indexed read per open.
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

  protected async readPersisted(): Promise<void> {
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
    this.ver++; // hydration replaced the records wholesale — see the base store's type buckets
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

  /**
   * ONE `batch` for the outbox's puts and deletes together — see `MirrorStore.commitLocal`.
   *
   * `SqlExecutor.batch` already promises atomicity, which is the whole requirement. It ignores
   * `torn` and never sets it, and that is correct here rather than an omission: `torn` exists for
   * the memory-first path, where memory has already run ahead of disk and a failure has to be
   * remembered. This method publishes nothing until the batch resolves, so there is no ahead-ness
   * to record.
   */
  protected async transact(puts: MirrorRecord[], deletes: string[]): Promise<void> {
    if (puts.length === 0 && deletes.length === 0) return;
    const db = await this.open();
    const statements: SqlStatement[] = [
      ...puts.map((rec) => ({
        sql: UPSERT_ENTITY,
        params: [`${rec.type}:${rec.id}`, JSON.stringify(rec)],
      })),
      ...deletes.map((key) => ({ sql: "DELETE FROM entities WHERE key = ?", params: [key] })),
    ];
    await db.batch(statements);
  }

  /**
   * `keep` rides through the clear, in the SAME batch — see the IndexedDB twin for the argument.
   */
  protected async wipe(keep: MirrorRecord[] = []): Promise<void> {
    const db = await this.open();
    const statements: SqlStatement[] = [
      { sql: "DELETE FROM entities" },
      // Straight back in, before this batch commits.
      ...keep.map((rec) => ({
        sql: UPSERT_ENTITY,
        params: [`${rec.type}:${rec.id}`, JSON.stringify(rec)],
      })),
      { sql: "DELETE FROM meta" },
    ];
    // Clearing meta drops the stamp too. Re-write it in the SAME batch: a database that is
    // empty and unowned would be silently claimable by the next account to open it.
    if (this.owner !== null) statements.push({ sql: UPSERT_META, params: [OWNER_KEY, encodeMeta(this.owner)] });
    await db.batch(statements);
    // A successful wipe puts disk exactly where `resetForBootstrap` just put memory (empty,
    // cursor "0"), so a standing torn flag is healed — the re-bootstrap IS the recovery.
    this.torn = false;
  }

  close(): void {
    this.closed = true;
    void this.db?.close?.();
    this.db = null;
    this.opening = null;
  }
}
