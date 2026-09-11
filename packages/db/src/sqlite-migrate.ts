/**
 * The migrator for the store a device carries — small on purpose, and it reads no files. The
 * server's migrator replays a directory; that cannot work here: the bundler resolves imports, not
 * directory listings, so a journal read from disk is empty on a device and complete in every
 * test. The journal arrives as a MODULE, and a test holds that module to the directory it was
 * generated from. Each entry is applied inside one transaction, with the row recording it written
 * in the SAME transaction: committing the schema change and then recording it can be interrupted
 * between the two, leaving a store that will replay a migration it already applied — loud for a
 * `CREATE TABLE`, silent duplication for an `INSERT`.
 */
import { sql } from "drizzle-orm";
/* THE JOURNAL'S OWN ENTRANCE, not the package barrel. The barrel computes two migration
   directories at module scope from `fileURLToPath(import.meta.url)`; this module is bundled into
   the phone's engine, where `url` is a substitute that refuses by name, so importing it through
   the barrel threw while the artifact was still initialising. The journal is a data module and
   reaches nothing. */
import { SQLITE_JOURNAL, type SqliteJournalEntry } from "@ohmail/db-mail/sqlite-journal";
import { assertSqliteCapabilities } from "./dialect/index.js";

/**
 * What this migrator needs of a handle: statements in, rows out, and ONE CONNECTION.
 *
 * The transaction below is `BEGIN` and `COMMIT` as separate calls, which only groups anything if
 * every call reaches the same connection. That is a requirement on the caller, not a property this
 * interface can express — a target backed by a pool would run each statement somewhere else, the
 * `BEGIN` would apply to a connection that then went back to the pool, and the migration would be
 * applied unwrapped while reporting success. Both current callers serialize onto one handle; a
 * third that does not is the failure to look for.
 */
export interface SqliteMigrationTarget {
  run(statement: string): Promise<void>;
  all<T = Record<string, unknown>>(statement: string): Promise<T[]>;
}

/** Where applied entries are recorded. Named for the journal it tracks, not for a library. */
export const SQLITE_MIGRATIONS_TABLE = "ohmail_sqlite_migrations";

/**
 * Apply every journal entry this store has not seen, oldest first; returns the ones applied. The
 * capability check lives HERE, not beside each opener: this is the one function every opener must
 * call, so a build of SQLite that cannot run this schema is refused before a single statement —
 * rather than at the first search, where a missing full-text index otherwise surfaces. Foreign
 * keys are enforced from here for the same reason: the schema declares them and this store
 * ignores them unless the connection asks. The pragma is PER-CONNECTION, a requirement on the
 * target: a target whose `batch` opens a second connection gets foreign keys OFF there, and this
 * function cannot reach that connection — {@link SqliteMigrationTarget} states the requirement.
 */
export async function migrateSqlite(
  target: SqliteMigrationTarget,
  journal: readonly SqliteJournalEntry[] = SQLITE_JOURNAL,
): Promise<string[]> {
  const version = await target.all<{ version: string }>("select sqlite_version() as version");
  const options = await target.all<{ compile_options: string }>("pragma compile_options");
  assertSqliteCapabilities({
    version: String(version[0]?.version ?? "0.0.0"),
    compileOptions: options.map((o) => String(o.compile_options)),
  });
  await target.run("PRAGMA foreign_keys=ON");
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
