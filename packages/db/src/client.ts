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
 * Deliberately NOT applied to `makePooledDb` — but NOT because the serverless path needs no
 * ceilings. It needs its OWN, sized differently: see {@link POOLED_TIMEOUTS}. A blanket reuse of
 * these numbers there would be inert, because a 60 s `statement_timeout` behind a 60 s platform
 * kill is a race the platform wins every time.
 *
 * Still not applied to the leader-lock session, whose only statement is a non-blocking
 * `pg_try_advisory_lock` and which must stay open and idle for the lock's whole lifetime.
 */
export const WORKER_TIMEOUTS = {
  lock_timeout: 30_000,
  statement_timeout: 60_000,
  idle_in_transaction_session_timeout: 60_000,
} as const;

/**
 * SERVER-SIDE DEADLINES FOR THE SERVERLESS REQUEST HANDLE, AGAINST A DIRECT POSTGRES —
 * AND WHY THAT QUALIFIER IS LOAD-BEARING, NOT DECORATION.
 *
 * ── THE CLAIM THIS COMMENT MADE UNTIL IT WAS MEASURED AGAINST THE REAL TRANSPORT ─────────────
 *
 * This block used to say these values fix the 504 family in a pooled deployment. **They do not
 * there, and the ledger row this closed has been reopened.** A hosted deployment's
 * `makePooledDb` dials a **transaction-mode** connection pooler in front of Postgres, and
 * `connection: POOLED_TIMEOUTS` sends these as PostgreSQL StartupMessage parameters, which only
 * apply to the ONE backend session a startup packet negotiates directly with. A transaction-mode
 * pooler multiplexes one client socket across many backend sessions, checking one out per
 * transaction, and there is no contract that it forwards a client's startup parameters onto
 * whichever backend it hands over.
 *
 * Measured directly against a real transaction-mode pooler, read-only, with a bare `postgres.js`
 * client (no drizzle in the path): `connection: { statement_timeout: "25000", … }` then
 * `select current_setting('statement_timeout')` returned the pooler's own baseline, not `25000`
 * — over four sequential round trips. The libpq-style `options: "-c statement_timeout=…"` startup
 * parameter was tried too and silently ignored the same way. **`sql.unsafe("set local
 * statement_timeout = '3000'; select …")` in one round trip DID take effect** — `SET LOCAL` is
 * transaction/statement-scoped Postgres behaviour, independent of pooler cooperation, because it
 * runs against whichever backend was already checked out for that unit of work. That is the only
 * mechanism proven to survive this transport, and it is not what `connection:` does.
 *
 * The correction — a role-scoped server default via `setupProdDatabase`, verified from
 * `pg_db_role_setting`, with `packages/db/src/migrate.ts` and `setup-prod.ts` hardened first
 * against inheriting a shorter baseline for their own long-running statements — is the reopened
 * ledger item, rather than built into this comment ahead of the code existing.
 *
 * ── WHAT THE VALUES BELOW STILL ARE ───────────────────────────────────────────────────────────
 *
 * NOT dead code. `makePooledDb` is also how a **self-hosted** deployment reaches its own,
 * un-pooled Postgres directly — no transaction-mode multiplexing in front of it — and there
 * `connection: POOLED_TIMEOUTS` is a real, working, session-startup mechanism: exactly what
 * `pooled-db.pg.test.ts` proves against the docker Postgres on :5433. Read every claim below as
 * "true for a direct connection", not as a description of what a pooled deployment does.
 *
 * ── THE COMMENT THAT USED TO STAND HERE, AND THE 103 TIMEOUTS IT COST ────────────────────────
 *
 * This factory carried no ceilings at all, under the reasoning *"serverless request paths have
 * the platform's own `maxDuration`"*. That sentence is true about the FUNCTION and false about
 * the DATABASE, and the gap between those two is the whole defect:
 *
 *  · `maxDuration` bounds how long the PROCESS lives. It does not tell Postgres anything. When
 *    it fires, the reader gets a 504 carrying no cause, and the backend on the other side keeps
 *    running the statement or keeps holding the lock.
 *  · Worse, a function killed mid-transaction leaves a backend `idle in transaction` holding row
 *    locks — which is what the NEXT request blocks on. The platform's ceiling therefore does not
 *    end the incident; it MANUFACTURES the next one. That is the self-amplifying half, and it is
 *    the same failure {@link WORKER_TIMEOUTS} was written for, one process type over.
 *
 * Measured, not argued. Seven days of this API's own request records held 103 gateway timeouts,
 * and every single one of them was
 * `FUNCTION_INVOCATION_TIMEOUT` at 60 009–60 517 ms — p50 60 017, **not one below 59 s**, none
 * flagged `hasFunctionCrashed`. A distribution with no variance is not a population of slow
 * queries; it is a population of waits that never ended, truncated by one external knife. They
 * spanned 15 route families and 29 distinct paths — the mailbox list, the session read, search,
 * drafts, consent, the scheduled-send cron — on hot instances (102 of 103) in one region, which
 * is the signature of a SHARED resource, not of any route's own query. The only resource all
 * fifteen share is the connection this factory hands out.
 *
 * ── WHY THE NUMBERS ARE SMALLER THAN THE WORKER'S ────────────────────────────────────────────
 *
 * Each is derived from the platform kill (`app/[[...path]]/route.ts` declares `maxDuration = 60`)
 * rather than chosen for feel. The rule is that the DATABASE must give up first, because a
 * statement that fails is an error a route can answer and log, while a function that is killed
 * is a 504 nobody can attribute afterwards.
 *
 *  • `statement_timeout` — 25 s, comfortably inside the 60 s kill, leaving 35 s for the route to
 *    still produce a response. Every ordinary API statement here is an indexed read in the
 *    millisecond range, so this is a runaway detector, not a budget anyone spends.
 *  • `lock_timeout` — 10 s. A lock wait on a per-request transaction is contention, never work.
 *    It must be ≤ `statement_timeout` or the statement ceiling masks it and the error names the
 *    wrong cause — the same relation `worker-timeouts.pg.test.ts` pins for the worker.
 *  • `idle_in_transaction_session_timeout` — 30 s, and this is the one that breaks the loop
 *    above: strictly under the 60 s kill, so a backend orphaned by a killed function is reaped
 *    by the database instead of outliving the process that opened it. It cannot reach a live
 *    request: the API's transactions are milliseconds, and the one place a network round trip
 *    could sit inside one is explicitly forbidden (`mailbox-service.ts` dials IMAP strictly
 *    BEFORE its transaction opens, for this exact reason).
 *
 * `/events` is unaffected despite its `maxDuration = 300`: an SSE stream parks on `await`
 * between short reads, and these bound STATEMENTS and idle TRANSACTIONS, never a connection's
 * lifetime.
 *
 * ── WHAT THIS DOES NOT FIX, STATED ───────────────────────────────────────────────────────────
 *
 * `max: 1` means postgres.js QUEUES rather than errors when the connection is busy (see
 * {@link WORKER_POOL_MAX}), and that client-side queue has no ceiling of its own. It is bounded
 * only transitively — once no statement can run longer than 25 s, the queue in front of it
 * drains. Raising `max` is a separate trade against the upstream pooler's connection budget and
 * is deliberately NOT taken here, because nothing measured says what the right number is.
 */
export const POOLED_TIMEOUTS = {
  lock_timeout: 10_000,
  statement_timeout: 25_000,
  idle_in_transaction_session_timeout: 30_000,
} as const;

/**
 * The platform ceiling every value in {@link POOLED_TIMEOUTS} is derived from — the
 * `maxDuration` of `apps/api-vercel/app/[[...path]]/route.ts`, in milliseconds.
 *
 * Named so the derivation is a checkable relation rather than a story about three literals:
 * `pooled-db.pg.test.ts` asserts every ceiling is strictly under it, and `host-wiring.test.ts`
 * pins it against the route's own export, so raising the route's `maxDuration` without revisiting
 * these numbers is a red test rather than a silent regression back to "the platform will handle
 * it".
 */
export const API_MAX_DURATION_MS = 60_000;

// Serverless (Vercel) request-scoped Db. One pool per connection
// string, module-cached so a WARM function instance reuses it across requests instead of
// opening a new connection per invocation (which storms/exhausts the upstream pooler under
// concurrency).
//   • `prepare: false` is REQUIRED behind a transaction-mode pooler (see `session-url.ts`):
//     cached prepared statements collide across pooled backends ("prepared statement …
//     already exists"). Pass the POOLED (…-pooler) connection string here, not the direct one.
//   • small `max` + short `idle_timeout` keep each instance's footprint tiny so many
//     concurrent instances don't exhaust the upstream pooler's connection budget.
//   • `connection: POOLED_TIMEOUTS` are SERVER-side deadlines that reach the backend ONLY on a
//     direct connection (self-host). Measured to be INERT through a transaction-mode pooler in
//     front of production — see POOLED_TIMEOUTS' own docblock. `connect_timeout` bounds only the
//     dial in either case; a fix that actually reaches a pooled deployment is still open.
const pools = new Map<string, ReturnType<typeof postgres>>();

export function makePooledDb(url: string): PostgresJsDatabase<typeof schema> {
  let pooled = pools.get(url);
  if (!pooled) {
    pooled = postgres(url, {
      prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10,
      connection: POOLED_TIMEOUTS, onnotice: onNotice,
    });
    pools.set(url, pooled);
  }
  return drizzle(pooled, { schema });
}

export async function closePooledDbs(): Promise<void> {
  for (const p of pools.values()) await p.end({ timeout: 5 });
  pools.clear();
}
