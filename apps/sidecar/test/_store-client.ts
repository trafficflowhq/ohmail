import type { PGlite } from "@electric-sql/pglite";
import type { SQL } from "drizzle-orm";
import type { LocalDb } from "../src/db.js";

/**
 * THE ONE DOOR A TEST TAKES INTO THE LOCAL STORE'S DRIVER. `$client` is the drizzle driver's own
 * public property, the PGlite the handle runs on (the session's client is the same object). `LocalDb`
 * does not name it, and is not widened to: the phone's store has no such client.
 */
export function pgliteOf(db: LocalDb): PGlite {
  return (db as unknown as { $client: PGlite }).$client;
}

/** The text the store's dialect writes for one statement, as the driver would send it. */
export function sqlTextOf(db: LocalDb, statement: SQL): string {
  return (db as unknown as { dialect: { sqlToQuery(s: SQL): { sql: string } } }).dialect.sqlToQuery(statement).sql;
}
