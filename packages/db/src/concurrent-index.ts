import { sql, type SQL } from "drizzle-orm";
import { MIGRATION_LOCK_KEY, MIGRATION_LOCK_TIMEOUT_MS } from "./migrate.js";

/**
 * BUILDING AN INDEX `CONCURRENTLY` OUTSIDE THE MIGRATOR — the one implementation.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block (25001), and the shared
 * migrator wraps its journal pass in one, so an index over a large table is built here instead, on
 * the setup command's autocommit session. Three prebuilds grew their own copy of this shape;
 * everything the shape has to get right — the bounded lock acquisition, the reset before any DDL,
 * the invalid-leftover repair, the unlock in `finally` — now lives once.
 *
 * SERIALIZED UNDER THE MIGRATION'S ADVISORY LOCK. `CREATE INDEX CONCURRENTLY` publishes an
 * `indisvalid = false` row WHILE BUILDING, which from a second caller's seat is indistinguishable
 * from a failed leftover — and "cleaning that up" would race the first caller's live build. The
 * same key `runMigrations` takes, so a prebuild and the migration serialize as one ceremony.
 */
export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

export interface ConcurrentIndexSpec {
  /** Index name, unqualified; created and probed pinned to `public.<table>`. */
  readonly name: string;
  readonly table: string;
  /** The whole `create index concurrently if not exists …` statement. */
  readonly ddl: SQL;
  /**
   * A column on `table` the index NAMES and a later migration adds. Absent column ⇒ the build is
   * deferred to the journal rather than throwing: a prebuild that threw on a database sitting
   * below that migration would abort the setup before the migrator could ever reach it.
   */
  readonly requiresColumn?: string;
  /**
   * The row count below which this index is DECLINED — the deferral rule, executable. The
   * planner will not use an index on a table this small, so building one buys nothing and costs a
   * write path. Absent ⇒ build at any size.
   */
  readonly minRows?: number;
}

const rowsOf = <T,>(r: unknown): T[] =>
  Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);

/** Is the table at least `min` rows? Bounded by `min`, so it never counts a large table. */
async function atLeastRows(db: SqlExecutor, table: string, min: number): Promise<boolean> {
  const rows = rowsOf<{ n: number }>(await db.execute(sql`
    select count(*)::int as n
      from (select 1 from ${sql.raw(`public."${table}"`)} limit ${min}) s`));
  return Number(rows[0]?.n ?? 0) >= min;
}

/** Which specs this run should build, and the reason each skipped one skipped. */
async function admit(
  db: SqlExecutor, specs: readonly ConcurrentIndexSpec[], log?: (msg: string) => void,
): Promise<ConcurrentIndexSpec[]> {
  const out: ConcurrentIndexSpec[] = [];
  for (const spec of specs) {
    const present = rowsOf<{ present: boolean }>(await db.execute(sql`
      select count(*) > 0 as present from information_schema.tables
       where table_schema = 'public' and table_name = ${spec.table}`));
    if (present[0]?.present !== true) {
      log?.(`${spec.name}: ${spec.table} does not exist yet — deferred to the journal`);
      continue;
    }
    if (spec.requiresColumn !== undefined) {
      const col = rowsOf<{ present: boolean }>(await db.execute(sql`
        select count(*) > 0 as present from information_schema.columns
         where table_schema = 'public' and table_name = ${spec.table}
           and column_name = ${spec.requiresColumn}`));
      if (col[0]?.present !== true) {
        log?.(`${spec.name}: ${spec.table}.${spec.requiresColumn} does not exist yet — deferred to the journal`);
        continue;
      }
    }
    if (spec.minRows !== undefined && !(await atLeastRows(db, spec.table, spec.minRows))) {
      log?.(`${spec.name}: ${spec.table} is under ${spec.minRows} rows — declined at this size`);
      continue;
    }
    out.push(spec);
  }
  return out;
}

/**
 * Build every admitted spec, idempotently, and safe against a database at any migration position.
 *
 * Admission runs BEFORE the lock: a run with nothing to build takes no lock at all, and a table
 * that crosses its `minRows` between the probe and the lock is simply built by the next setup run.
 * `label` names the caller in the acquisition-failure message.
 */
export async function ensureConcurrentIndexes(
  db: SqlExecutor,
  specs: readonly ConcurrentIndexSpec[],
  opts: { label: string; log?: (msg: string) => void },
): Promise<void> {
  if (!Number.isInteger(MIGRATION_LOCK_TIMEOUT_MS) || MIGRATION_LOCK_TIMEOUT_MS < 0) {
    throw new Error("MIGRATION_LOCK_TIMEOUT_MS must be a non-negative integer");
  }
  const wanted = await admit(db, specs, opts.log);
  if (wanted.length === 0) return;

  // BOUNDED ACQUISITION, exactly as `runMigrations` bounds the same one: with the session default
  // `lock_timeout = 0` a sibling holding the key would park this setup for ever, silently. The
  // timeout is acquisition-only and reset before any DDL — a concurrent build must not be
  // abortable by it.
  const key = MIGRATION_LOCK_KEY as unknown as number;
  await db.execute(sql.raw(`set lock_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`));
  try {
    await db.execute(sql`select pg_advisory_lock(${key})`);
  } catch (err) {
    throw new Error(
      `could not take the migration advisory lock (${MIGRATION_LOCK_KEY}) within ` +
        `${MIGRATION_LOCK_TIMEOUT_MS}ms for ${opts.label} — another setup or migration is running ` +
        `against this database. Wait for it and re-run; this step is idempotent. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await db.execute(sql.raw("set lock_timeout = 0"));
  try {
    for (const spec of wanted) {
      const state = rowsOf<{ valid: boolean }>(await db.execute(sql`
        select i.indisvalid as valid
          from pg_index i join pg_class c on c.oid = i.indexrelid
         where i.indrelid = ${sql.raw(`'public.${spec.table}'::regclass`)}
           and c.relname = ${spec.name}`));
      const ix = state[0];
      if (ix !== undefined && ix.valid !== true) {
        // DROP CONCURRENTLY, for the same reason the build is: a plain DROP takes the exclusive
        // table lock this whole helper exists to avoid, on the retry path of all places. A failed
        // concurrent build really does leave an invalid index that `IF NOT EXISTS` then treats as
        // present, permanently.
        opts.log?.(`${spec.name}: an INVALID leftover from a failed concurrent build — dropped and rebuilt`);
        await db.execute(sql.raw(`drop index concurrently if exists public."${spec.name}"`));
      } else if (ix !== undefined) {
        continue;   // present and valid — the ordinary re-run
      }
      opts.log?.(`${spec.name}: building concurrently on ${spec.table}`);
      await db.execute(spec.ddl);
    }
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${key})`);
  }
}
