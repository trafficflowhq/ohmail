import { sql } from "drizzle-orm";
import {
  ensureConcurrentIndexes, type ConcurrentIndexSpec, type SqlExecutor,
} from "./concurrent-index.js";

/**
 * Search EXTENSION setup, kept deliberately OUT of the shared migrator. `makeTestDb()` replays
 * the journal into PGlite for every unit test, and PGlite has no `pg_trgm`, so a `CREATE
 * EXTENSION` there would take the whole suite red. This runs ONLY against a real Postgres: the
 * search pg tests call it in `beforeAll`, and production setup calls it once after migrating.
 * Idempotent — `IF NOT EXISTS` throughout. The tsvector columns and their GIN indexes are NOT
 * here: they are core-Postgres generated columns in migration 0008 and replay fine into PGlite.
 * This file adds only the `pg_trgm` extension plus the fuzzy trigram GIN indexes on
 * subject/from_address.
 */

export async function ensureSearchExtensions(db: SqlExecutor): Promise<void> {
  // The fuzzy arm's word_similarity()/`<%` operator lives in pg_trgm.
  await db.execute(sql`create extension if not exists pg_trgm`);
  // Trigram GIN indexes backing the fuzzy arm (subject + sender). gin_trgm_ops
  // accelerates the trigram similarity operators at scale.
  await db.execute(sql`create index if not exists messages_subject_trgm_idx on messages using gin (subject gin_trgm_ops)`);
  await db.execute(sql`create index if not exists messages_from_address_trgm_idx on messages using gin (from_address gin_trgm_ops)`);
}

/**
 * The pre-migration build of mail 0071's partial index, CONCURRENTLY.
 *
 * A plain `CREATE INDEX` over the schema's largest table must never run as a journal statement —
 * it holds a write-conflicting lock inside the migrator's transaction, where CONCURRENTLY cannot
 * run. Mail 0071 carries the same statement with `IF NOT EXISTS`, so THIS step, run BEFORE the
 * migrator on an autocommit connection, builds without blocking writes and the journal statement
 * no-ops; the two must stay byte-equivalent.
 *
 * THE PREREQUISITE IS THE COLUMN, NOT THE TABLE: `withheld_reason` arrives with mail 0062, so an
 * existing database anywhere in 0002–0061 has the table and not the column, and a prebuild that
 * threw there would abort the setup BEFORE the migrator could reach 0062 — bricking exactly the
 * upgrade it runs ahead of. Absent ⇒ deferred to the journal, where the blocking build is bounded
 * by arithmetic rather than hope: no database can carry a LARGE `message_bodies` at 0071's replay
 * position without having crossed 0062 while small.
 */
const WITHHELD_PROVENANCE_SPEC: ConcurrentIndexSpec = {
  name: "message_bodies_withheld_idx",
  table: "message_bodies",
  requiresColumn: "withheld_reason",
  // `ON public.message_bodies`, so a like-named index in some OTHER schema can neither satisfy
  // this build nor be touched by it.
  ddl: sql`create index concurrently if not exists "message_bodies_withheld_idx"
    on public.message_bodies using btree ("withheld_reason","message_id")
    where "withheld_reason" is not null`,
};

export async function ensureWithheldProvenanceIndex(
  db: SqlExecutor, opts: { log?: (msg: string) => void } = {},
): Promise<void> {
  await ensureConcurrentIndexes(db, [WITHHELD_PROVENANCE_SPEC], {
    label: "the withheld-provenance prebuild",
    ...(opts.log ? { log: opts.log } : {}),
  });
}
