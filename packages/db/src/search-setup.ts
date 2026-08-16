import { sql, type SQL } from "drizzle-orm";

/**
 * Phase 2c-1 (RC8) — search EXTENSION setup, kept DELIBERATELY OUT of the shared
 * Drizzle migrator. `makeTestDb()` replays `packages/db/drizzle/*` into PGlite for
 * every unit test, and PGlite has no `pg_trgm`, so a `CREATE EXTENSION` there would
 * throw and take the whole suite red. This runs ONLY against a real Postgres
 * (Neon in prod; the docker `:5433` in `*.pg.test.ts`): the search `*.pg.test.ts`
 * calls it in `beforeAll`, and prod Neon setup calls it once after migrating.
 *
 * Idempotent: `IF NOT EXISTS` throughout — safe to re-run. The tsvector columns +
 * their GIN indexes are NOT here; they are core-Postgres generated columns that
 * live in migration 0008 (RC9) and replay fine into PGlite. This file adds ONLY
 * the pg_trgm extension + the fuzzy (trigram) GIN indexes on subject/from_address.
 */

/** Minimal structural type so this file need not depend on the schema/Db types. */
interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

export async function ensureSearchExtensions(db: SqlExecutor): Promise<void> {
  // The fuzzy arm's word_similarity()/`<%` operator lives in pg_trgm.
  await db.execute(sql`create extension if not exists pg_trgm`);
  // Trigram GIN indexes backing the fuzzy arm (subject + sender). gin_trgm_ops
  // accelerates the trigram similarity operators at scale.
  await db.execute(sql`create index if not exists messages_subject_trgm_idx on messages using gin (subject gin_trgm_ops)`);
  await db.execute(sql`create index if not exists messages_from_address_trgm_idx on messages using gin (from_address gin_trgm_ops)`);
}
