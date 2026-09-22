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

/**
 * The fuzzy arm's trigram GIN indexes (subject + sender), built CONCURRENTLY: setup runs on the
 * live database, where a plain build over `messages`, the schema's largest table, holds every
 * write for the whole scan. So it needs an autocommit session, like every other prebuild here.
 */
export const TRIGRAM_INDEX_SPECS: readonly ConcurrentIndexSpec[] = [
  {
    name: "messages_subject_trgm_idx",
    table: "messages",
    ddl: sql`create index concurrently if not exists "messages_subject_trgm_idx"
      on public.messages using gin ("subject" gin_trgm_ops)`,
  },
  {
    name: "messages_from_address_trgm_idx",
    table: "messages",
    ddl: sql`create index concurrently if not exists "messages_from_address_trgm_idx"
      on public.messages using gin ("from_address" gin_trgm_ops)`,
  },
];

export async function ensureSearchExtensions(
  db: SqlExecutor, opts: { log?: (msg: string) => void } = {},
): Promise<void> {
  // The fuzzy arm's word_similarity()/`<%` operator lives in pg_trgm.
  await db.execute(sql`create extension if not exists pg_trgm`);
  await ensureConcurrentIndexes(db, TRIGRAM_INDEX_SPECS, {
    label: "the trigram index build",
    ...(opts.log ? { log: opts.log } : {}),
  });
}

/**
 * The pre-migration build of mail 0071's partial index, CONCURRENTLY.
 *
 * Mail 0071 carries the same statement with `IF NOT EXISTS`, so this step — before the migrator,
 * on an autocommit connection — builds without blocking writes and the journal statement no-ops;
 * the two must stay byte-equivalent. THE PREREQUISITE IS THE COLUMN, NOT THE TABLE: `withheld_reason` arrives with mail 0062, so a
 * database in 0002–0061 has the table and not the column, and throwing there would abort the setup
 * before the migrator could reach 0062 — bricking the upgrade it runs ahead of.
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
