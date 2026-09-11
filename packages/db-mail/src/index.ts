import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `@ohmail/db-mail` — the shared mail-domain half of the database: the mail
 * migration journal (`drizzle/`) and the path constant that addresses it.
 * The 37-table schema move has not happened: the account-side schema module
 * still declares all 57 tables and stays the single import site (a guard pins
 * both counts). This package is dependency-free — nothing here imports
 * drizzle or `postgres`; `@trafficflow/db` reads the journal path from here.
 * The `@ohmail/*` scope means "may not import a private package"; what ships
 * is decided file by file by the publish tooling.
 */

/**
 * The shared mail-domain migration journal's directory. Composed with
 * `node:path`, never `new URL("../drizzle", import.meta.url)`: webpack treats
 * the URL form as a static asset reference and `next build` fails to resolve
 * it, while `join` is opaque to the bundler and identical at runtime. This
 * file sits one level under the package root in both src (vitest) and dist
 * (`tsc -b`), so `..` resolves to the same directory either way.
 */
export const MAIL_MIGRATIONS_DIR: string = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

/**
 * The directory holding the same schema for the store a device carries.
 *
 * A SECOND journal rather than a dialect switch inside the first: the two stores do not accept
 * the same statements, and a file that tried to be both would be a file neither store's reader
 * could check. They are kept in step by number instead — every entry in the shared journal after
 * the fork has a same-numbered sibling here, or a `.noop` file saying why it needs none, and a
 * test fails on a missing one.
 */
export const SQLITE_MIGRATIONS_DIR: string = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle-sqlite");

export { SQLITE_JOURNAL, type SqliteJournalEntry } from "./sqlite-journal.js";
