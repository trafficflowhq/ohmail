import { sql } from "drizzle-orm";
import {
  ensureConcurrentIndexes, type ConcurrentIndexSpec, type SqlExecutor,
} from "./concurrent-index.js";

/**
 * The hot-path indexes, built CONCURRENTLY outside the migrator — `concurrent-index.ts` owns the
 * how, this file owns the WHICH. Two are built at any size: the profile-import "already
 * resolved?" probe on `audit_log` (runs on every candidate, and an audit log only grows) and the
 * storage-eviction victim read on `messages` (a Sort — no index offers `coalesce(date,
 * created_at), id` order). Both scan today, measured with `EXPLAIN`.
 */

/**
 * THE DEFERRAL RULE, AS A NUMBER: an index lands only where the planner would actually use one,
 * and it will not use one on a table this small. Measured on this tip against the stuck-send
 * read's own predicate: the planner DECLINED the partial index at 50, 100 and 200 rows and chose
 * an Index Only Scan from 400 up, so a thousand is past the crossover with room and below any
 * size that would surprise somebody. Deferral used to be a sentence in a commit body, which is
 * why the two indexes it deferred were still deferred when the tables had moved on.
 */
export const DEFERRED_INDEX_MIN_ROWS = 1000;

export const HOT_PATH_INDEX_SPECS: readonly ConcurrentIndexSpec[] = [
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
  {
    // THE DEFERRED ONE, and the deferral is now a condition rather than a note: it builds itself
    // the first time setup runs against a deployment whose table has crossed
    // {@link DEFERRED_INDEX_MIN_ROWS}. PARTIAL on the alert's own predicate — `status = 'pending'`
    // holds only in-flight sends, so the index stays small however large the table grows.
    // Its twin from the same measurement, `billing_events(status)`, is gone: cloud 0032 dropped
    // the table with the billing plane.
    name: "outbound_sends_pending_created_idx",
    table: "outbound_sends",
    minRows: DEFERRED_INDEX_MIN_ROWS,
    ddl: sql`create index concurrently if not exists "outbound_sends_pending_created_idx"
      on public.outbound_sends using btree ("created_at") where "status" = 'pending'`,
  },
];

/**
 * The names, DERIVED from the specs so the two lists cannot drift — the setup command verifies
 * these, and a name added to the spec table but not to a verify list is the shape that made an
 * unverified index possible. Unconditional ones are verified fail-closed; a DEFERRED one is
 * verified only against its own reason (present, or its table still under the ceiling).
 */
export const HOT_PATH_INDEXES: readonly string[] =
  HOT_PATH_INDEX_SPECS.filter((s) => s.minRows === undefined).map((s) => s.name);

export const DEFERRED_HOT_PATH_INDEXES: readonly { name: string; table: string; minRows: number }[] =
  HOT_PATH_INDEX_SPECS.filter((s) => s.minRows !== undefined)
    .map((s) => ({ name: s.name, table: s.table, minRows: s.minRows! }));

/** Idempotent, and safe to run against a database at any migration position. */
export async function ensureHotPathIndexes(
  db: SqlExecutor, opts: { log?: (msg: string) => void } = {},
): Promise<void> {
  await ensureConcurrentIndexes(db, HOT_PATH_INDEX_SPECS, {
    label: "the hot-path index build",
    ...(opts.log ? { log: opts.log } : {}),
  });
}
