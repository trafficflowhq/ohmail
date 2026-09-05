import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `@ohmail/db-mail` — the SHARED mail-domain half of the database.
 *
 * The database is partitioned into a shared mail-domain schema and journal on one side and a
 * private Cloud journal on the other. The billing migration is what forced it: Cloud logic
 * expressed *in SQL* cannot sit in a journal that a single-user desktop install has to run end
 * to end, so the journal could not stay one thing.
 *
 * ── WHAT THIS PACKAGE OWNS TODAY, AND WHAT IT DOES NOT ────────────────────────────────────
 *
 * It owns the mail journal: `drizzle/`, 29 hand-written entries, and the path constant that
 * addresses it. That is the whole of it. **The 37-table schema move has NOT happened** — the
 * account-side schema module still declares all 57 tables and stays the single import site
 * for every consumer. (The counts move with the schema: mail 0024 and 0028 each added a table,
 * and a guard pins both numbers as literals so this sentence cannot drift without a test going
 * red.) So this package is deliberately dependency-free: nothing here imports drizzle, and
 * nothing here can import `postgres`, which the engine tier is banned from outright.
 *
 * The ownership matters even at this size. Before it, the migrator addressed this directory by
 * walking two levels up and guessing a sibling name — a path that a package on the other side
 * of the split had no way to keep true. Now the journal's location is a fact the journal's own
 * package states, and `@trafficflow/db` reads it.
 *
 * ── `@ohmail/*` IS THE TIER, NOT PUBLICATION ──────────────────────────────────────────────
 *
 * The scope means "may not import a private package". It does **not** by itself mean a file
 * ships: what is published is decided file by file by the publish tooling, and the two
 * questions are separate. Both halves have to be said or the naming convention reads as already
 * broken on day one.
 */

/**
 * The directory holding the shared mail-domain migration journal.
 *
 * **Composed with `node:path`, never `new URL("../drizzle", import.meta.url)`.** Webpack treats
 * the URL form as a static ASSET reference and tries to resolve it at build time, which broke the
 * serverless API host's `next build` with `Module not found: Can't resolve '../drizzle'` — the
 * API bundle pulls a module graph that reaches the migrator even though a serverless host never
 * migrates anything. `join` is opaque to the bundler and identical at runtime.
 *
 * `HERE` is `packages/db-mail/src` under vitest and `packages/db-mail/dist` after `tsc -b` —
 * both one level under the package root, so `..` resolves to the same directory either way.
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
