/**
 * The migrator for the store a device carries — small on purpose, and it reads no files. The
 * server's migrator replays a directory; that cannot work here: the bundler resolves imports, not
 * directory listings, so a journal read from disk is empty on a device and complete in every
 * test. The journal arrives as a MODULE, and a test holds that module to the directory it was
 * generated from. EVERYTHING A STORE OWES IS ONE TRANSACTION, with the row recording each entry
 * written in it: the entries are applied together or not at all. A store interrupted between two
 * entries of an upgrade would open on neither release (2.0's entries take columns the 1.0 engine
 * reads), and a schema change committed apart from its record is replayed, loud for a `CREATE
 * TABLE`, silent duplication for an `INSERT`.
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

/**
 * WHAT AN OPEN MAY BE TOLD WHILE IT UPGRADES — narration, never load-bearing. `onEntry` is called
 * BEFORE each owed entry with how many of THIS open's owed entries are done, of how many (never the
 * journal's length), and whether the store is `fresh` (no ledger table before this open: every
 * entry is owed and nobody is waiting on a number). `onApplied` follows the one commit, once per
 * entry, with the time that entry's own statements took.
 *
 * `beforeApply` is the one that IS load-bearing: called once, after the ledger was read and
 * before anything is written, with what this open owes. It is where a caller checks that the
 * upgrade may begin (room for it, a copy of the store). A throw refuses the open with the store
 * untouched. Not called when nothing is owed.
 */
export interface SqliteMigrationHooks {
  beforeApply?(owed: { readonly owed: readonly string[]; readonly fresh: boolean }): Promise<void>;
  onEntry?(applied: number, pending: number, name: string, fresh: boolean): void;
  onApplied?(name: string, ms: number): void;
  now?(): number;
}

/** Where applied entries are recorded. Named for the journal it tracks, not for a library. */
export const SQLITE_MIGRATIONS_TABLE = "ohmail_sqlite_migrations";

/**
 * Apply every journal entry this store has not seen, oldest first, in ONE transaction; returns the
 * ones applied. The
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
  hooks: SqliteMigrationHooks = {},
): Promise<string[]> {
  const version = await target.all<{ version: string }>("select sqlite_version() as version");
  const options = await target.all<{ compile_options: string }>("pragma compile_options");
  assertSqliteCapabilities({
    version: String(version[0]?.version ?? "0.0.0"),
    compileOptions: options.map((o) => String(o.compile_options)),
  });
  await target.run("PRAGMA foreign_keys=ON");
  const ledger = await target.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${SQLITE_MIGRATIONS_TABLE}'`,
  );
  const fresh = ledger.length === 0;
  // Read, not made: a store that owes nothing, or whose upgrade is refused, is not written to.
  const seen = new Set(fresh ? [] : (await target.all<{ name: string }>(`SELECT name FROM ${SQLITE_MIGRATIONS_TABLE}`))
    .map((r) => r.name));
  const owed = journal.filter((entry) => !seen.has(entry.name));
  if (owed.length === 0) {
    if (fresh) await target.run(`CREATE TABLE IF NOT EXISTS ${SQLITE_MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
    return [];
  }
  await hooks.beforeApply?.({ owed: owed.map((e) => e.name), fresh });
  const clock = hooks.now ?? Date.now;
  const took: [string, number][] = [];
  /* THE DOCUMENTED TABLE-ALTERING DANCE, once for the whole upgrade.
     This store cannot ALTER a constraint, so a constraint change is a table rebuild: create,
     copy, DROP, rename. With foreign keys ON, `DROP TABLE` performs an implicit DELETE FROM —
     so every ON DELETE CASCADE child of the table being rebuilt loses its rows, silently, to a
     migration. Measured on the shipped journal: a fingerprint row seeded before 0095 is gone
     after it. The pragma is a NO-OP inside a transaction, so it is issued here, outside it. */
  await target.run("PRAGMA foreign_keys=OFF");
  try {
    await target.run("BEGIN");
    let running = owed[0]!.name;
    try {
      await target.run(`CREATE TABLE IF NOT EXISTS ${SQLITE_MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
      for (const entry of owed) {
        running = entry.name;
        hooks.onEntry?.(took.length, owed.length, entry.name, fresh);
        const startedAt = clock();
        for (const statement of entry.statements) await target.run(statement);
        await target.run(
          `INSERT INTO ${SQLITE_MIGRATIONS_TABLE} (name, applied_at) ` +
            `VALUES ('${entry.name.replace(/'/g, "''")}', CAST(unixepoch('subsec') * 1000 AS INTEGER))`,
        );
        took.push([entry.name, clock() - startedAt]);
      }
      /* BEFORE the commit, not after: a check that runs afterwards can only report damage it
         can no longer undo. Once, over the whole database: an entry that left a reference
         dangling did not necessarily touch the table now holding it, and a later entry of the
         same upgrade may be the one that puts it back. */
      const dangling = await target.all<Record<string, unknown>>("PRAGMA foreign_key_check");
      if (dangling.length > 0) {
        const where = [...new Set(dangling.map((r) => String(r.table ?? "?")))].sort().join(", ");
        throw new Error(
          `left ${dangling.length} dangling reference(s) in ${where} — the entries ran with ` +
          "foreign keys off and did not put back what they took apart",
        );
      }
      await target.run("COMMIT");
    } catch (cause) {
      await target.run("ROLLBACK").catch(() => {});
      throw new Error(
        `the SQLite journal stopped at ${running} and none of the ${owed.length} entries this open owed was applied: ${String(cause)}`,
        { cause },
      );
    }
  } finally {
    /* Restored on EVERY exit. A throw that left them off would hand the caller a store whose
       keys are advisory, which is worse than the migration having failed. */
    await target.run("PRAGMA foreign_keys=ON").catch(() => {});
  }
  for (const [name, ms] of took) hooks.onApplied?.(name, ms);
  return took.map(([name]) => name);
}

/** The statement that names this store's version, for the capability check at open time. */
export const SQLITE_VERSION_QUERY = sql`select sqlite_version() as version`;
