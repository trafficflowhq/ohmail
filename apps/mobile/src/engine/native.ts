/**
 * The REAL platform half of {@link MobileEngineDeps} — expo-sqlite behind the engine's
 * `SqlExecutor` seam, expo-crypto behind its `uuid` seam. The one module in this app that
 * imports a native storage or crypto API, and the one the node-side suite never loads (it
 * injects `node:sqlite` into `boot.ts` instead — same seam, same contract).
 */
import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";
import type { SqlExecutor, SqlRow, SqlValue } from "@ohmail/client-engine";
import { dbFileName, type MobileEngineDeps } from "./boot";

/**
 * expo-sqlite behind {@link SqlExecutor}. `batch` rides `withExclusiveTransactionAsync`, whose
 * dedicated transaction connection is what makes "all land or none" true even while another
 * query is in flight on the main connection — the atomicity the mirror's page+cursor contract
 * stands on (see `SqlExecutor`'s doc in the engine package).
 */
export function expoSqlExecutor(db: SQLite.SQLiteDatabase): SqlExecutor {
  return {
    async all(sql, params = []): Promise<SqlRow[]> {
      return db.getAllAsync<SqlRow>(sql, [...(params as SqlValue[])]);
    },
    async batch(statements): Promise<void> {
      await db.withExclusiveTransactionAsync(async (txn) => {
        for (const { sql, params = [] } of statements) {
          await txn.runAsync(sql, [...(params as SqlValue[])]);
        }
      });
    },
    close(): Promise<void> {
      return db.closeAsync();
    },
  };
}

/** What the connect screen hands to {@link bootEngine}. */
export function nativeEngineDeps(): MobileEngineDeps {
  return {
    openExecutor: async (dbName) => expoSqlExecutor(await SQLite.openDatabaseAsync(dbFileName(dbName))),
    uuid: () => Crypto.randomUUID(),
  };
}
