/**
 * The migration journals as DATA — their folders and pinned migrations tables, and nothing that
 * runs one. A journal spec is three strings; running a journal opens a `postgres` connection,
 * takes an advisory lock and replays SQL. The two used to live in one module, so every consumer
 * that only needed the folder path dragged the server driver in. Expensive in a shipped program:
 * the desktop engine migrates with PGlite's own migrator, needs `MAIL_JOURNAL` — a name and a
 * directory — and never opens a `postgres` connection. This file imports nothing but `node:path`
 * and the spec's type. `HERE` is `src` under the test runner and `dist` after a build, both one
 * level under `packages/db`, so relative folders resolve the same.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAIL_MIGRATIONS_DIR } from "@ohmail/db-mail";
import type { JournalSpec } from "./baseline.js";

/**
 * The shared mail-domain journal folder, re-exported from the package that owns the SQL.
 *
 * The half that HOLDS the journal is the half that names its location; this re-export keeps every
 * importer of `MAIL_MIGRATIONS_DIR` pointed here regardless.
 */
export { MAIL_MIGRATIONS_DIR } from "@ohmail/db-mail";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The PRE-SPLIT single journal — 24 entries, kept as the adoption oracle.
 *
 * No code migrates from it any more. It is read by the split and baseline-adoption tests and by
 * nothing else, and is kept forever for the same reason a database keeps its old migrations table:
 * it is the only record that the single-journal era happened.
 */
export const LEGACY_MIGRATIONS_DIR = join(HERE, "..", "drizzle");

/** The private Cloud journal folder — the identity ceremony, billing, the ledger, ops, the funnel. */
export const CLOUD_MIGRATIONS_DIR = join(HERE, "..", "drizzle-cloud");

/**
 * The mail journal, with its migrations table PINNED to `drizzle_mail`.
 *
 * The schema is never discovered by name: pinning it keeps the mail pass reading its own table
 * rather than a legacy table whose 24 rows are a superset of both new journals' entries.
 */
export const MAIL_JOURNAL: JournalSpec = {
  name: "mail",
  dir: MAIL_MIGRATIONS_DIR,
  migrationsSchema: "drizzle_mail",
};

/** The cloud journal, with its migrations table pinned to `drizzle_cloud`. */
export const CLOUD_JOURNAL: JournalSpec = {
  name: "cloud",
  dir: CLOUD_MIGRATIONS_DIR,
  migrationsSchema: "drizzle_cloud",
};

/**
 * The two live journals, IN APPLICATION ORDER. Mail first, and that order is load-bearing —
 * see `runMigrations` in `migrate.ts`.
 */
export const JOURNALS: readonly JournalSpec[] = [MAIL_JOURNAL, CLOUD_JOURNAL] as const;
