/**
 * EXPO-SQLITE'S TRANSACTION SEMANTICS, ON REAL SQLITE — the platform double the node suite was
 * missing, and the reason a total defect could ship past 600 green tests.
 *
 * `sqlWorld` (pair-server.ts) drives `node:sqlite`'s `DatabaseSync` in memory, whose `batch` is
 * FULLY SYNCHRONOUS: no other JS can run between its `BEGIN` and its `COMMIT`, so two writes can
 * never overlap and every concurrency question answers itself. The device does not work that way,
 * and the difference is not a detail — it is the whole of the Android body defect.
 *
 * What expo-sqlite actually does (`SQLiteDatabase.js`, `withExclusiveTransactionAsync`):
 *
 *   const transaction = await Transaction.createAsync(this)   // ← useNewConnection: true
 *   await transaction.execAsync('BEGIN'); await task(transaction); await …('COMMIT')
 *
 * `Transaction.createAsync` opens a **second connection to the same file**, and every step is a
 * real `await`. So two overlapping `batch()` calls are two connections both trying to write, and
 * expo's own documentation states the outcome: *"As long as the transaction is converted into a
 * write transaction, the other async write queries will abort with `database is locked` error."*
 *
 * This double reproduces exactly that, and it is NOT a mock of the failure: the connections are
 * real, the file is real, and the `database is locked` comes from SQLite itself. A double that
 * merely threw a chosen string would be satisfied by a fix that handled that string.
 */
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SqlValue } from "@ohmail/client-engine";
import type { EngineStoreDatabase } from "../../src/engine/local-engine";
import type { ExclusiveTxnDatabase } from "../../src/engine/sql-queue";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/**
 * No busy timeout, deliberately. A timeout would turn the collision into a stall and hide it —
 * and it is not what the platform does: the device's `ready` write was lost outright, in the same
 * tick, not after a wait. `busy_timeout` defaults to 0 in SQLite; set explicitly so the property
 * this file rests on is stated rather than inherited.
 */
function connect(path: string): DatabaseSync {
  // FOREIGN KEYS OFF, which is SQLite's own default and the device's starting point. This host
  // turns them ON unless told otherwise, and that difference is not cosmetic: with the host's
  // default in place, a connection that never ran the migrator's `PRAGMA foreign_keys = ON` still
  // enforced references, so a batch running on an unconfigured connection looked correct here and
  // was not correct on a phone. The model has to start where the platform starts.
  const db = new sqlite.DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec("PRAGMA busy_timeout = 0");
  return db;
}

/**
 * A handle shaped like expo's, INCLUDING the exclusive-transaction call the batch runner no longer
 * uses. It stays on the model because a control needs to drive it: showing what the old
 * arrangement committed is what makes the guard against it mean something.
 */
export interface ShapedDatabase extends ExclusiveTxnDatabase {
  withExclusiveTransactionAsync(
    task: (txn: { runAsync(sql: string, params: readonly SqlValue[]): Promise<void> }) => Promise<void>,
  ): Promise<void>;
}

/** A world of expo-shaped databases on a real temp directory. `close()` removes it. */
export function expoShapedWorld(): {
  open: (name: string) => ShapedDatabase;
  drop: (name: string) => Promise<void>;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-mobile-"));
  /**
   * Every handle ever opened, for the sweep at the end. NOT a cache keyed by name: `open` mints a
   * FRESH connection each time, exactly as `SQLite.openDatabaseAsync` does, so a store that has
   * closed its handle and a store opening the same file afterwards do not share one — which is
   * the shape `forgetMirror`'s read-back probe and every relaunch actually have.
   */
  const opened: DatabaseSync[] = [];
  const pathOf = (name: string) => join(dir, `${name.replace(/[^A-Za-z0-9.-]/gu, "_")}.sqlite`);

  const open = (name: string): ShapedDatabase => {
    const path = pathOf(name);
    const held = connect(path);
    // What `migrateSqlite` does to the connection it runs on, and to no other.
    held.exec("PRAGMA foreign_keys = ON");
    opened.push(held);
    return {
      databasePath: path,
      async runAsync(sql: string, params: readonly SqlValue[]): Promise<void> {
        await Promise.resolve(); // expo's write is a real async hop; so is this one
        held.prepare(sql).run(...(params as SqlValue[]));
      },
      async getAllAsync<T>(sql: string, params: readonly SqlValue[]): Promise<T[]> {
        await Promise.resolve(); // expo's read is a real async hop; so is this one
        return held.prepare(sql).all(...(params as SqlValue[])) as T[];
      },
      /**
       * THE SHAPE THE BATCH RUNNER NO LONGER USES, kept because a control needs it.
       *
       * Modelled exactly as expo does it, second connection and all — including the part that
       * matters: the new connection gets no `PRAGMA foreign_keys`, because nothing on the device
       * gives it one. A test drives this directly to show what the old arrangement committed.
       */
      async withExclusiveTransactionAsync(task): Promise<void> {
        // THE SECOND CONNECTION — `useNewConnection: true`, verbatim in effect.
        const txn = connect(path);
        try {
          await Promise.resolve();
          txn.exec("BEGIN IMMEDIATE"); // throws SQLITE_BUSY while another connection is writing
          await task({
            async runAsync(sql: string, params: readonly SqlValue[]): Promise<void> {
              await Promise.resolve();
              txn.prepare(sql).run(...(params as SqlValue[]));
            },
          });
          txn.exec("COMMIT");
        } catch (err) {
          try { txn.exec("ROLLBACK"); } catch { /* never began */ }
          throw err;
        } finally {
          txn.close();
        }
      },
      async closeAsync(): Promise<void> {
        try { held.close(); } catch { /* already closed — `close()` is idempotent to callers */ }
      },
    };
  };

  return {
    open,
    /** The device's delete: the file goes, so the next `open` of that name is a NEW, EMPTY one. */
    drop: async (name: string) => {
      rmSync(pathOf(name), { force: true });
    },
    cleanup: () => {
      for (const db of opened) { try { db.close(); } catch { /* already closed */ } }
      opened.length = 0;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * THE ENGINE STORE'S OWN WORLD — the same real files, in the shape `local-engine.ts` opens.
 *
 * The mirror world above answers `ExclusiveTxnDatabase`; the engine store is opened through
 * {@link import('../../src/engine/local-engine').EngineStoreDatabase}, which is a different
 * surface (`prepareAsync`/`closeAsync`) over the same expo-sqlite handle. On a REAL directory
 * rather than `:memory:`, because the property the removal cases rest on is that deleting the
 * store leaves the next open of that name a NEW, EMPTY database — which an in-memory map keyed
 * by name can fake and a file cannot.
 */
export function engineStoreWorld(): {
  open: (name: string) => Promise<EngineStoreDatabase>;
  drop: (name: string) => Promise<void>;
  /** Whether a file stands under that name, read without opening it. */
  exists: (name: string) => Promise<boolean>;
  /** What is on disk under that name right now, read WITHOUT creating it. */
  tables: (name: string) => string[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-engine-"));
  const opened: DatabaseSync[] = [];
  const pathOf = (name: string) => join(dir, `${name.replace(/[^A-Za-z0-9.-]/gu, "_")}.sqlite`);

  const open = async (name: string): Promise<EngineStoreDatabase> => {
    const held = connect(pathOf(name));
    opened.push(held);
    return {
      async prepareAsync(source: string) {
        const statement = held.prepare(source);
        return {
          async executeForRawResultAsync(params: readonly unknown[]) {
            const objects = statement.all(...(params as SqlValue[])) as Record<string, unknown>[];
            const columns = statement.columns().map((c) => c.name ?? c.column ?? "");
            /* Positional, as the platform answers — see the engine store's statement-runner contract. */
            const rows = objects.map((o) => columns.map((c) => o[c]));
            return { async getAllAsync() { return rows; } };
          },
          async executeAsync(params: readonly unknown[]) { return statement.run(...(params as SqlValue[])); },
          async getColumnNamesAsync() { return statement.columns().map((c) => c.name ?? c.column ?? ""); },
          async finalizeAsync() { /* node:sqlite finalizes with the statement object */ },
        };
      },
      async closeAsync(): Promise<void> {
        try { held.close(); } catch { /* already closed */ }
      },
    };
  };

  return {
    open,
    drop: async (name: string) => { rmSync(pathOf(name), { force: true }); },
    exists: async (name: string) => existsSync(pathOf(name)),
    tables: (name: string): string[] => {
      if (!existsSync(pathOf(name))) return [];
      const probe = connect(pathOf(name));
      try {
        return (probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
          .map((r) => String(r.name)).sort();
      } finally { probe.close(); }
    },
    cleanup: () => {
      for (const db of opened) { try { db.close(); } catch { /* already closed */ } }
      opened.length = 0;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
