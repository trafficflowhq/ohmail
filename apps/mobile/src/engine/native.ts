/**
 * The REAL platform half of {@link MobileEngineDeps} — expo-sqlite behind the engine's
 * `SqlExecutor` seam, expo-crypto behind its `uuid` seam. The one module in this app that
 * imports a native storage or crypto API, and the one the node-side suite never loads (it
 * injects `node:sqlite` into `boot.ts` instead — same seam, same contract).
 */
import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";
import type { SqlExecutor, SqlValue } from "@ohmail/client-engine";
import { dbFileName, type MobileEngineDeps } from "./boot";
import { serialSqlExecutor, type ExclusiveTxnDatabase } from "./sql-queue";

/**
 * expo-sqlite behind {@link SqlExecutor}. `batch` rides `withExclusiveTransactionAsync`, whose
 * dedicated transaction connection is what makes "all land or none" true even while another
 * query is in flight on the main connection — the atomicity the mirror's page+cursor contract
 * stands on (see `SqlExecutor`'s doc in the engine package).
 *
 * THAT DEDICATED CONNECTION IS ALSO WHY THE OPERATIONS ARE QUEUED. It is a second connection to
 * the same file, so two overlapping `batch` calls are two writers and the loser aborts with
 * `database is locked` — which is what made every message on the phone open preview-only. The
 * serialisation, and the evidence, live in {@link serialSqlExecutor}; this function is the
 * binding to the real handle and nothing else.
 *
 * The adapter below is here rather than a cast: `getAllAsync` and `runAsync` are overloaded on
 * the expo side (variadic params as well as an array), and structural assignability across an
 * overload set is not something to leave to chance in a file the suite cannot load.
 */
export function expoSqlExecutor(db: SQLite.SQLiteDatabase): SqlExecutor {
  const shaped: ExclusiveTxnDatabase = {
    databasePath: db.databasePath,
    getAllAsync: <T>(sql: string, params: readonly SqlValue[]): Promise<T[]> =>
      db.getAllAsync<T>(sql, [...(params as SqlValue[])]),
    withExclusiveTransactionAsync: (task) =>
      db.withExclusiveTransactionAsync((txn) =>
        task({ runAsync: (sql, params) => txn.runAsync(sql, [...(params as SqlValue[])]) }),
      ),
    closeAsync: () => db.closeAsync(),
  };
  return serialSqlExecutor(shaped);
}

/** What the connect screen hands to {@link bootEngine}. */
export function nativeEngineDeps(): MobileEngineDeps {
  return {
    openExecutor: async (dbName) => expoSqlExecutor(await SQLite.openDatabaseAsync(dbFileName(dbName))),
    /**
     * The real deletion — the one call in this app that removes mail from the device.
     *
     * `deleteDatabaseAsync` REJECTS on a name that is not there ("Database ... not found"), and
     * the seam's contract is that deleting an absent name resolves: `forgetMirror` deletes
     * twice (the mail, then the empty file its read-back probe created) and a pending wipe is
     * replayed at every launch, so "already gone" is the ordinary case, not a failure. Swallowed
     * HERE rather than at the call site, so the caller's own read-back stays the only thing that
     * decides whether the take-back landed — a deleter that silently did nothing is caught by
     * the probe, not by this catch.
     */
    deleteDatabase: async (dbName) => {
      try {
        await SQLite.deleteDatabaseAsync(dbFileName(dbName));
      } catch {
        /* absent, or held: the caller's read-back is the judge */
      }
    },
    uuid: () => Crypto.randomUUID(),
  };
}
