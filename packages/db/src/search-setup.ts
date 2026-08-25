import { sql, type SQL } from "drizzle-orm";
import { MIGRATION_LOCK_KEY, MIGRATION_LOCK_TIMEOUT_MS } from "./migrate.js";

/**
 * Search EXTENSION setup, kept DELIBERATELY OUT of the shared
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

/**
 * THE PRE-MIGRATION BUILD OF MAIL 0071's PARTIAL INDEX, CONCURRENTLY — the standing rule
 * (`0047_read_order`'s, restated when the away responder's candidate index was deferred for
 * exactly this reason) is that a plain `CREATE INDEX`
 * over the schema's largest table must never run as a journal statement: it scans every row to
 * evaluate the predicate and holds a write-conflicting lock for the length of the build, inside
 * the migrator's transaction, where CONCURRENTLY cannot run at all. Mail 0071 carries the same
 * statement with `IF NOT EXISTS` — so THIS step, run BEFORE the migrator on the setup CLI's own
 * autocommit connection, builds the index without blocking writes, and the journal statement
 * then no-ops. The two must stay byte-equivalent; each names the other.
 *
 * The populations, spelled out:
 *  · a FRESH database: `message_bodies` does not exist yet — skip; the journal builds the index
 *    on the then-empty table instantly.
 *  · the database that applied 0071 before this step existed (the managed production db, at
 *    85k body rows — measured in seconds): the index exists — `IF NOT EXISTS` no-ops.
 *  · an EXISTING install upgrading past 0071 with years of mail — the population the rule is
 *    for: built here, concurrently, before the migrator reaches 0071.
 *
 * A failed CONCURRENTLY build leaves an INVALID index behind (Postgres documents this), which
 * `IF NOT EXISTS` would then treat as present — permanently broken. So an invalid leftover is
 * dropped and rebuilt first.
 */
export async function ensureWithheldProvenanceIndex(
  db: SqlExecutor, opts: { log?: (msg: string) => void } = {},
): Promise<void> {
  const rowsOf = <T,>(r: unknown): T[] =>
    Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);

  // THE PREREQUISITE IS THE COLUMN, NOT THE TABLE: `withheld_reason` arrives with mail 0062, so
  // an existing database anywhere in 0002–0061 has the table and not the column — and a prebuild
  // that threw there would abort the setup BEFORE the migrator could ever reach 0062, bricking
  // exactly the upgrade it runs ahead of (a review round caught the table-only probe). Absent ⇒
  // defer to the journal: by 0071's position the column exists, and on any database that OLD the
  // table is small enough for the in-transaction build (the marker itself is 0062-new).
  const col = rowsOf<{ present: boolean }>(await db.execute(sql`
    select count(*) > 0 as present from information_schema.columns
     where table_schema = 'public' and table_name = 'message_bodies'
       and column_name = 'withheld_reason'`));
  if (col[0]?.present !== true) {
    // DEFERRED TO THE JOURNAL, and the blocking build that implies is bounded by ARITHMETIC,
    // not hope (a review round asked for a staged migrate-to-0062-then-prebuild dance here; the
    // narrowing argument is this paragraph): mail 0062 predates 0071 by days on a product whose
    // whole schema is months old, so no database can carry a LARGE `message_bodies` at 0071's
    // replay position without having crossed 0062 while small — a pre-0062 install is beta-era
    // by definition (the managed production table, the largest in existence, builds this index
    // in seconds). The residual case — an install parked pre-0062 for long enough to grow big,
    // then upgrading — runs 0071 inside its OWN setup ceremony, where the deploy order already
    // has the worker down around the migration; a brief write lock during scheduled maintenance
    // is ordinary, and slicing the migrator to avoid it would put a second journal-ordering
    // authority beside the one 0066/0069 proved is hard enough to keep singular.
    opts.log?.("withheld-provenance index: message_bodies.withheld_reason does not exist yet — deferred to the journal");
    return;
  }

  // SERIALIZED UNDER THE MIGRATION'S OWN ADVISORY LOCK: two replicas provisioning concurrently
  // would otherwise both reach this prebuild, and `CREATE INDEX CONCURRENTLY` publishes an
  // `indisvalid = false` row WHILE BUILDING — indistinguishable, from the second caller's seat,
  // from a failed leftover, whose "cleanup" would then race the first caller's live build. The
  // same key `runMigrations` takes, so the prebuild and the migration serialize as one ceremony.
  // Session-level and paired with the unlock in `finally`; the connection is the setup CLI's own.
  const key = MIGRATION_LOCK_KEY as unknown as number;
  // BOUNDED, exactly as `runMigrations` bounds the same acquisition: with the session default
  // `lock_timeout = 0` a sibling holding the key would park this setup for ever, silently. The
  // timeout is acquisition-only and reset before any DDL — the concurrent build itself must not
  // be abortable by it.
  if (!Number.isInteger(MIGRATION_LOCK_TIMEOUT_MS) || MIGRATION_LOCK_TIMEOUT_MS < 0) {
    throw new Error("MIGRATION_LOCK_TIMEOUT_MS must be a non-negative integer");
  }
  await db.execute(sql.raw(`set lock_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`));
  try {
    await db.execute(sql`select pg_advisory_lock(${key})`);
  } catch (err) {
    throw new Error(
      `could not take the migration advisory lock (${MIGRATION_LOCK_KEY}) within ` +
        `${MIGRATION_LOCK_TIMEOUT_MS}ms for the withheld-provenance prebuild — another setup or ` +
        `migration is running against this database. Wait for it and re-run; the prebuild is ` +
        `idempotent. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await db.execute(sql.raw("set lock_timeout = 0"));
  try {
    const state = rowsOf<{ valid: boolean }>(await db.execute(sql`
      select i.indisvalid as valid
        from pg_index i join pg_class c on c.oid = i.indexrelid
       where i.indrelid = 'public.message_bodies'::regclass
         and c.relname = 'message_bodies_withheld_idx'`));
    const ix = state[0];
    if (ix !== undefined && ix.valid !== true) {
      // DROP CONCURRENTLY, for the same reason the build is concurrent: a plain DROP takes the
      // exclusive table lock this whole helper exists to avoid, on the retry path of all places.
      opts.log?.("withheld-provenance index: an INVALID leftover from a failed concurrent build — dropped and rebuilt");
      await db.execute(sql`drop index concurrently if exists public.message_bodies_withheld_idx`);
    } else if (ix !== undefined) {
      return;   // present and valid — the ordinary re-run
    }
    // `ON public.message_bodies`, so a like-named index in some OTHER schema can neither satisfy
    // this build nor be touched by it (the catalog lookup above is pinned to the table for the
    // same reason — an unqualified name match would read a stranger's index as ours).
    await db.execute(sql`
      create index concurrently if not exists "message_bodies_withheld_idx"
        on public.message_bodies using btree ("withheld_reason","message_id")
        where "withheld_reason" is not null`);
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${key})`);
  }
}
