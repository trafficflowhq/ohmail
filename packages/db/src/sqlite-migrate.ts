/**
 * THE MIGRATOR FOR THE STORE A DEVICE CARRIES — small on purpose, and it reads no files.
 *
 * The server's migrator opens a directory and replays what it finds. That cannot work where this
 * one runs: the bundler that builds the application resolves imports and not directory listings,
 * so a journal read from disk is empty on a device and complete in every test — a difference that
 * only appears on the one machine nobody can attach a debugger to. The journal arrives here as a
 * MODULE instead, and a test holds that module to the directory it was generated from.
 *
 * Each entry is applied inside one transaction, and the row recording it is written in the SAME
 * transaction. A migrator that commits the schema change and then records it can be interrupted
 * between the two, and what it leaves behind is a store that will replay a migration it has
 * already applied — which for a `CREATE TABLE` is a loud failure and for an `INSERT` is silent
 * duplication.
 */
import { sql } from "drizzle-orm";
import { SQLITE_JOURNAL, type SqliteJournalEntry } from "@ohmail/db-mail";

/** What this migrator needs of a handle: statements in, rows out, and a transaction. */
export interface SqliteMigrationTarget {
  run(statement: string): Promise<void>;
  all<T = Record<string, unknown>>(statement: string): Promise<T[]>;
}

/** Where applied entries are recorded. Named for the journal it tracks, not for a library. */
export const SQLITE_MIGRATIONS_TABLE = "ohmail_sqlite_migrations";

/** Apply every journal entry this store has not seen, oldest first. Returns the ones applied. */
export async function migrateSqlite(
  target: SqliteMigrationTarget,
  journal: readonly SqliteJournalEntry[] = SQLITE_JOURNAL,
): Promise<string[]> {
  await target.run(
    `CREATE TABLE IF NOT EXISTS ${SQLITE_MIGRATIONS_TABLE} (` +
      "name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const seen = new Set(
    (await target.all<{ name: string }>(`SELECT name FROM ${SQLITE_MIGRATIONS_TABLE}`))
      .map((r) => r.name),
  );
  const applied: string[] = [];
  for (const entry of journal) {
    if (seen.has(entry.name)) continue;
    await target.run("BEGIN");
    try {
      for (const statement of entry.statements) await target.run(statement);
      await target.run(
        `INSERT INTO ${SQLITE_MIGRATIONS_TABLE} (name, applied_at) ` +
          `VALUES ('${entry.name.replace(/'/g, "''")}', CAST(unixepoch('subsec') * 1000 AS INTEGER))`,
      );
      await target.run("COMMIT");
    } catch (cause) {
      await target.run("ROLLBACK").catch(() => {});
      throw new Error(`the SQLite journal stopped at ${entry.name}: ${String(cause)}`, { cause });
    }
    applied.push(entry.name);
  }
  return applied;
}

/** The statement that names this store's version, for the capability check at open time. */
export const SQLITE_VERSION_QUERY = sql`select sqlite_version() as version`;
