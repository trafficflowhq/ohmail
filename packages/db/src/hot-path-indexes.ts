import { sql, type SQL } from "drizzle-orm";
import { MIGRATION_LOCK_KEY, MIGRATION_LOCK_TIMEOUT_MS } from "./migrate.js";

/**
 * Two hot-path indexes, built CONCURRENTLY outside the migrator.
 *
 * They are not journal statements, and cannot be: the shared migrator wraps the whole journal
 * pass in ONE transaction (`drizzle-orm` `PgDialect.migrate`), and `CREATE INDEX CONCURRENTLY`
 * refuses inside a transaction block — `25001`, measured through the real migrator. The same
 * argument, and the same remedy, that `ensureWithheldProvenanceIndex` already carries; the
 * difference is that this one races no journal statement, so it runs AFTER the migrator on the
 * setup command's own autocommit session, where the tables it indexes certainly exist.
 *
 * Both reads scan today, measured read-only on the deployed database with `EXPLAIN`:
 *
 *  · `audit_log` — the profile-import "already resolved?" probe filters `(account_id, action)`
 *    plus two JSONB keys, and the table's only index is its primary key: Seq Scan, cost 4615,
 *    at 59 772 rows. It runs on every import candidate and every dismissal, and an audit log
 *    only grows.
 *  · `messages` — the storage-eviction victim read orders by `coalesce(date, created_at), id`
 *    within one account and no index offers that order: a Sort, at 93 276 rows. The planner
 *    reaches the account rows through an unrelated expression index for the `account_id`
 *    prefix alone.
 *
 * Three other reads the same review named do NOT get an index: `billing_events` (13 rows),
 * `outbound_sends` (120) and `webauthn_challenges` (2) all show a Seq Scan because they are
 * tiny, and an index there would be a plan the planner declines to use. `webauthn_challenges`
 * has a real defect — nothing prunes it — which is a retention fix, not an index.
 */
interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

interface IndexSpec {
  /** Index name, unqualified; created and probed pinned to `public.<table>`. */
  readonly name: string;
  readonly table: string;
  /** The `create index concurrently if not exists …` body, without the leading verb. */
  readonly ddl: SQL;
}

/** The indexes this module owns — exported so the setup command can verify them by name. */
export const HOT_PATH_INDEXES = [
  "audit_log_account_action_idx",
  "messages_account_date_order_idx",
] as const;

const SPECS: readonly IndexSpec[] = [
  {
    name: "audit_log_account_action_idx",
    table: "audit_log",
    ddl: sql`create index concurrently if not exists "audit_log_account_action_idx"
      on public.audit_log using btree ("account_id","action")`,
  },
  {
    // `coalesce(date, created_at)` is the eviction order's own expression, so the index carries
    // the expression rather than the columns — a btree on `(date, id)` cannot serve a sort whose
    // key is the coalesce.
    name: "messages_account_date_order_idx",
    table: "messages",
    ddl: sql`create index concurrently if not exists "messages_account_date_order_idx"
      on public.messages using btree ("account_id",(coalesce("date","created_at")),"id")`,
  },
];

const rowsOf = <T,>(r: unknown): T[] =>
  Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);

/**
 * Idempotent, and safe to run against a database at any migration position.
 *
 * Serialized under the MIGRATION advisory lock, for the reason the provenance prebuild states:
 * `CREATE INDEX CONCURRENTLY` publishes an `indisvalid = false` row WHILE BUILDING, which from a
 * second caller's seat is indistinguishable from a failed leftover — and "cleaning up" that would
 * race the first caller's live build. A failed concurrent build really does leave an invalid index
 * that `IF NOT EXISTS` then treats as present, permanently, so an invalid leftover is dropped
 * concurrently and rebuilt.
 */
export async function ensureHotPathIndexes(
  db: SqlExecutor, opts: { log?: (msg: string) => void } = {},
): Promise<void> {
  if (!Number.isInteger(MIGRATION_LOCK_TIMEOUT_MS) || MIGRATION_LOCK_TIMEOUT_MS < 0) {
    throw new Error("MIGRATION_LOCK_TIMEOUT_MS must be a non-negative integer");
  }
  const key = MIGRATION_LOCK_KEY as unknown as number;
  await db.execute(sql.raw(`set lock_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`));
  try {
    await db.execute(sql`select pg_advisory_lock(${key})`);
  } catch (err) {
    throw new Error(
      `could not take the migration advisory lock (${MIGRATION_LOCK_KEY}) within ` +
        `${MIGRATION_LOCK_TIMEOUT_MS}ms for the hot-path index build — another setup or migration ` +
        `is running against this database. Wait for it and re-run; this step is idempotent. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Reset before any DDL: a concurrent build must not be abortable by the acquisition timeout.
  await db.execute(sql.raw("set lock_timeout = 0"));
  try {
    for (const spec of SPECS) {
      const present = rowsOf<{ present: boolean }>(await db.execute(sql`
        select count(*) > 0 as present from information_schema.tables
         where table_schema = 'public' and table_name = ${spec.table}`));
      if (present[0]?.present !== true) {
        // A database this early has no such table, so there is nothing to index and nothing to
        // repair. Named rather than silent: the next setup run, after the migrator, builds it.
        opts.log?.(`hot-path index ${spec.name}: ${spec.table} does not exist yet — skipped`);
        continue;
      }
      const state = rowsOf<{ valid: boolean }>(await db.execute(sql`
        select i.indisvalid as valid
          from pg_index i join pg_class c on c.oid = i.indexrelid
         where i.indrelid = ${sql.raw(`'public.${spec.table}'::regclass`)}
           and c.relname = ${spec.name}`));
      const ix = state[0];
      if (ix !== undefined && ix.valid !== true) {
        opts.log?.(`hot-path index ${spec.name}: an INVALID leftover from a failed concurrent build — dropped and rebuilt`);
        await db.execute(sql.raw(`drop index concurrently if exists public."${spec.name}"`));
      } else if (ix !== undefined) {
        continue;   // present and valid — the ordinary re-run
      }
      opts.log?.(`hot-path index ${spec.name}: building concurrently on ${spec.table}`);
      await db.execute(spec.ddl);
    }
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${key})`);
  }
}
