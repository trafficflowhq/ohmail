import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema.js";
import { onNotice } from "./notices.js";

let sql: ReturnType<typeof postgres> | null = null;

/**
 * HOW MANY POSTGRES CONNECTIONS ONE ALWAYS-ON PROCESS MAY HOLD.
 *
 * A number that used to be a literal in two places and is now the input to a third, which is why
 * it is exported: `apps/worker` runs several sync cycles at a time (its lanes) and the number of them
 * is CLAMPED against this value rather than chosen beside it. postgres.js does not error when a
 * pool is exhausted — it QUEUES — so an over-wide scheduler does not fail, it silently converts
 * concurrency back into latency while still paying the memory and IMAP cost of running wide. A
 * derived clamp cannot drift from the pool the day somebody tunes this.
 */
export const WORKER_POOL_MAX = 5;

/** The long-lived singleton connection — for the always-on worker (one process, one pool). */
export function makeDb(url: string): PostgresJsDatabase<typeof schema> {
  sql = postgres(url, { max: WORKER_POOL_MAX, onnotice: onNotice });
  return drizzle(sql, { schema });
}

export async function closeDb(): Promise<void> {
  if (sql) { await sql.end({ timeout: 5 }); sql = null; }
}

export interface OwnedDb {
  db: PostgresJsDatabase<typeof schema>;
  close(): Promise<void>;
}

/**
 * An INDEPENDENT pool + handle whose lifetime the CALLER owns.
 *
 * `makeDb`/`closeDb` share one module-global `sql`, so `closeDb()` closes whichever pool
 * was created LAST. That is fine for a single always-on process, but it silently breaks
 * as soon as two db-owning things live in one process — two shard workers side by side,
 * a standby taking over while the old leader tears down, or a worker started inside a
 * test that already called `makeDb`: one owner's teardown closes another owner's LIVE
 * pool. Every worker/cron entry uses this instead.
 */
export function makeOwnedDb(url: string): OwnedDb {
  const own = postgres(url, { max: WORKER_POOL_MAX, connection: WORKER_TIMEOUTS, onnotice: onNotice });
  return {
    db: drizzle(own, { schema }),
    close: async () => { await own.end({ timeout: 5 }); },
  };
}

/**
 * SERVER-SIDE DEADLINES FOR EVERY WORKER CONNECTION. Without these one wedged transaction
 * takes the whole shard down, silently and indefinitely.
 *
 * The failure this prevents, observed in production: a backend left `idle in transaction`
 * by an earlier crash kept row locks on `messages`. Every worker that restarted took the
 * leader advisory lock, began ingesting, and then blocked on `transactionid` — forever,
 * because nothing here bounded the wait. It held the advisory lock while wedged, so no
 * standby could take over either, and it never reached the end of a cycle, so it never wrote
 * a heartbeat. The shard was dark and the only evidence was an absence.
 *
 * Postgres will not resolve that for us: a lock wait has no default ceiling. Three ceilings,
 * each aimed at a different half of the deadlock:
 *
 *  • `lock_timeout` — do not wait more than 30 s for a row lock. The per-message ingest
 *    transactions are milliseconds; 30 s means a real contender, and failing is strictly
 *    better than waiting out the heat death of the universe. The error surfaces as a normal
 *    per-mailbox sync failure, which the existing `maxSyncFailures` path already quarantines.
 *  • `statement_timeout` — 60 s, a backstop for a single runaway query (a seq scan on a
 *    mailbox that outgrew its index) rather than for lock waits.
 *  • `idle_in_transaction_session_timeout` — 60 s, the fix for BEING the zombie. A process
 *    SIGKILLed mid-transaction (which is exactly what an OOM does) leaves its backend holding
 *    locks until the TCP connection is reaped, which can take far longer than the outage
 *    budget. This makes the database clean up after us.
 *
 * Deliberately NOT applied to `makePooledDb` (serverless request paths have the platform's
 * own `maxDuration`) nor to the leader-lock session, whose only statement is a non-blocking
 * `pg_try_advisory_lock` and which must stay open and idle for the lock's whole lifetime.
 */
export const WORKER_TIMEOUTS = {
  lock_timeout: 30_000,
  statement_timeout: 60_000,
  idle_in_transaction_session_timeout: 60_000,
} as const;

// Serverless (Vercel) request-scoped Db. One pool per connection
// string, module-cached so a WARM function instance reuses it across requests instead of
// opening a new connection per invocation (which storms/exhausts the upstream pooler under
// concurrency).
//   • `prepare: false` is REQUIRED behind a transaction-mode pooler (see `session-url.ts`):
//     cached prepared statements collide across pooled backends ("prepared statement …
//     already exists"). Pass the POOLED (…-pooler) connection string here, not the direct one.
//   • small `max` + short `idle_timeout` keep each instance's footprint tiny so many
//     concurrent instances don't exhaust the upstream pooler's connection budget.
const pools = new Map<string, ReturnType<typeof postgres>>();

export function makePooledDb(url: string): PostgresJsDatabase<typeof schema> {
  let pooled = pools.get(url);
  if (!pooled) {
    pooled = postgres(url, {
      prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10, onnotice: onNotice,
    });
    pools.set(url, pooled);
  }
  return drizzle(pooled, { schema });
}

export async function closePooledDbs(): Promise<void> {
  for (const p of pools.values()) await p.end({ timeout: 5 });
  pools.clear();
}
