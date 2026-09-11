import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema.js";
import { onNotice } from "./notices.js";
import { brandDialect } from "./dialect/index.js";

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
  return brandDialect(drizzle(sql, { schema }), "pg");
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
    db: brandDialect(drizzle(own, { schema }), "pg"),
    close: async () => { await own.end({ timeout: 5 }); },
  };
}

/**
 * Server-side deadlines for every worker connection — without them one wedged transaction takes
 * the whole shard down. Observed: a crashed backend left `idle in transaction` holding row locks;
 * restarted workers blocked on it forever while holding the leader lock and writing no heartbeat.
 * Postgres has no default ceiling on a lock wait. `lock_timeout` 30 s (lands as an ordinary sync
 * failure, quarantined by `maxSyncFailures`); `statement_timeout` 60 s (runaway backstop);
 * `idle_in_transaction_session_timeout` 60 s (the fix for BEING the zombie — an OOM-killed
 * process leaves its backend holding locks). NOT applied to `makePooledDb` ({@link
 * POOLED_TIMEOUTS}) nor to the leader-lock session, which must stay open and idle.
 */
export const WORKER_TIMEOUTS = {
  lock_timeout: 30_000,
  statement_timeout: 60_000,
  idle_in_transaction_session_timeout: 60_000,
} as const;

/**
 * Server-side deadlines for the serverless request handle, against a DIRECT Postgres — the
 * qualifier matters. A hosted `makePooledDb` dials a transaction-mode pooler, and `connection:`
 * startup parameters were MEASURED inert through it; what reaches a pooled deployment is {@link
 * ROLE_DEFAULT_TIMEOUTS}. NOT dead code: a self-hosted deployment dials its own Postgres
 * directly, where these work (`pooled-db.pg.test.ts`). The database must give up before the
 * platform kill (`maxDuration = 60`): a failed statement is answerable, a killed function is a
 * 504 with no cause. 25 s statement, 10 s lock (≤ statement, or the ceiling masks it), 30 s
 * idle-in-transaction — the one that stops an orphaned backend blocking the next request.
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

/**
 * The mechanism that actually reaches a transaction-mode pooler: a Postgres ROLE-ONLY default,
 * applied by `setupProdDatabase` (`ALTER ROLE … SET …`, NOT `IN DATABASE`) and verified from
 * `pg_db_role_setting`. Client-side `connection:` parameters were measured inert through the
 * pooler on BOTH ports; a role default is read by Postgres itself at backend start. Role-ONLY
 * because the database-scoped ALTER was still inert. The cost is blast radius — every database
 * this role opens — so connections needing more (`migrate.ts`, `setup-prod.ts`, the provisioning
 * CLIs) neutralize it on connect. The values are `WORKER_TIMEOUTS`' with `statement_timeout` at
 * 55 s, strictly inside {@link API_MAX_DURATION_MS} — the measured 504s were waits, not runaways.
 */
export const ROLE_DEFAULT_TIMEOUTS = {
  lock_timeout: 30_000,
  statement_timeout: 55_000,
  idle_in_transaction_session_timeout: 60_000,
} as const;

/**
 * How long a request may wait for the pooled handle's ONE connection before it is told no. The
 * only live statement ceiling in a pooled deployment is {@link ROLE_DEFAULT_TIMEOUTS}' 55 s, and
 * 55 s of holder plus any wait exceeds {@link API_MAX_DURATION_MS}. Measured: 47 504s in twenty
 * minutes; `HEAD /health` at 60 012 ms can only have WAITED. The driver does not queue in the
 * pool: `max: 1` PIPELINES up to 100 queries onto the one socket — everyone behind the head waits
 * for the head; `connect_timeout` bounds only the dial. 15 s leaves time to RETURN the refusal; a
 * fast 503 with `Retry-After` beats an unattributable 504. Residual: per-QUERY, not a request
 * budget.
 */
export const POOLED_ACQUIRE_TIMEOUT_MS = 15_000;

/**
 * Thrown when a query spent {@link POOLED_ACQUIRE_TIMEOUT_MS} on the pooled handle without the
 * backend ever beginning to execute it. It means THIS statement had not started — the connection
 * was occupied by whatever sat ahead. Not a database-down signal — its own class, answered 503
 * with `Retry-After`. It deliberately does not claim nothing reached the server: the bytes were
 * pipelined, and {@link guardAcquire} does not cancel (see there), so the refused statement is
 * normally still executed and its result discarded — the same residue a platform kill leaves, but
 * at ~15 s with a named cause instead of 60 s with none. Retry safety for a MUTATION is therefore
 * not asserted: the 503 marks itself retryable only for a safe method or an `Idempotency-Key`.
 */
export class DbAcquireTimeoutError extends Error {
  readonly code = "db_acquire_timeout";
  constructor(readonly waitedMs: number) {
    super(`the database connection did not begin this statement within ${waitedMs}ms`);
    this.name = "DbAcquireTimeoutError";
  }
}

/**
 * STRUCTURAL, not `instanceof`, and that is the point.
 *
 * `packages/api` maps this to a 503. An `instanceof` there is a claim about MODULE IDENTITY —
 * that the API and the driver resolved the same copy of this file — which a bundler, a duplicated
 * workspace link or a `dist` build can each falsify silently, and the failure mode is the 60 s
 * 504 coming back with nobody noticing. The `name` is pinned by a test that imports the real
 * class, so a rename breaks the guard instead of quietly widening the hole.
 */
export function isDbAcquireTimeout(err: unknown): err is DbAcquireTimeoutError {
  if (err instanceof DbAcquireTimeoutError) return true;
  return typeof err === "object" && err !== null
    && (err as { name?: unknown }).name === "DbAcquireTimeoutError";
}

/** The half of postgres.js' `Query` this ceiling reads. See {@link guardAcquire}. */
interface PooledQuery {
  /**
   * TRUE for exactly one query per connection: the head, which the backend is actually running
   * (set in `execute` and in the drain loop). So `active === false` is the driver-level spelling
   * of "this statement has not begun". `active`, NOT `state`: `state` is set the instant a query
   * hits the socket — measured, not read. The hole, named: `active` is set on the head BEFORE the
   * write, so behind a transaction-mode pooler still waiting for a backend, the head is `active`
   * with no statement running and this ceiling is disabled. Deliberate: bounding an EXECUTING
   * query would make a second statement timeout; the pooler's wait ceiling is its configuration.
   * Every follower behind the head — the measured population — is covered.
   */
  active: boolean;
  then(onOk: (value: unknown) => void, onErr: (err: unknown) => void): unknown;
}

/**
 * Put a ceiling on the WAIT TO BEGIN EXECUTING — never on the statement itself. The timer fires
 * once and asks: is the backend running THIS query? If `active`, it does nothing — the server's
 * ceilings own it; only a statement that has not started is refused — refused, not cancelled (the
 * block at the timer says why). A statement allowed 55 s by {@link ROLE_DEFAULT_TIMEOUTS} keeps
 * all 55 s; what stops is other requests inheriting that 55 s and dying on the platform's knife.
 * Transactions are not reached: `sql.begin` opens through the driver's own internal handle, and
 * racing the whole promise risks a 503 to a caller whose write then commits anyway — strictly
 * worse than the 504 being fixed.
 */
function guardAcquire<Q extends object>(query: Q, ms: number): Q {
  const q = query as unknown as PooledQuery;
  let raced: Promise<unknown> | null = null;
  const arm = (): Promise<unknown> => (raced ??= new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // The backend is running THIS statement: the server-side ceilings own it from here, and
      // killing work that is legitimately in progress is not this ceiling's job.
      if (q.active === true) return;

      // The caller's answer is decided FIRST, so the driver's own 57014 rejection — which the
      // dequeue below raises synchronously — can never win the race and surface as a bare
      // `query_canceled` instead of a nameable `db_busy`.
      reject(new DbAcquireTimeoutError(ms));

      /**
       * And that is all: the caller is refused; the statement is never cancelled. Cancel-always:
       * a wire-written query is cancelled LATER, by a CancelRequest naming the backend in `state`
       * — behind a transaction-mode pooler that can abort ANOTHER TENANT'S statement.
       * Cancel-when-`state === null` is also wrong: a cold pool hands the query to the connection
       * as its `initial` (`state` null through the dial), and cancelling leaves the ready path
       * returning without `onopen` — later queries queue behind a connection never announced
       * open: a wedged instance. Not cancelling costs wasted work; cancelling risks a wedged
       * connection. A ceiling must not do worse than what it bounds.
       */
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    // Awaiting the driver's own Query is what DISPATCHES it (`Query#then` calls `handle()`), so
    // this must stay the only place the underlying promise is consumed.
    q.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  }));

  return new Proxy(query, {
    get(target, prop, receiver) {
      if (prop === "then") {
        return (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => arm().then(ok, bad);
      }
      if (prop === "catch") return (bad?: (e: unknown) => unknown) => arm().catch(bad);
      if (prop === "finally") return (fn?: () => void) => arm().finally(fn);
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      // `values()`, `raw()`, `execute()` and friends return `this` to chain. Hand back the PROXY
      // so `client.unsafe(q, p).values()` — which is how drizzle reads every row set
      // (`drizzle-orm/postgres-js/session.js`) — stays guarded instead of unwrapping itself.
      return (...args: unknown[]) => {
        const out = Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
        return out === target ? receiver : out;
      };
    },
  });
}

/**
 * The pooled client with {@link guardAcquire} on every query it issues.
 *
 * `unsafe` is the ONLY method overridden, and that is sufficient rather than lucky: drizzle's
 * postgres-js session reaches the driver through exactly `client.unsafe(sql, params)`,
 * `client.unsafe(sql, params).values()` and `client.begin(fn)`. Everything else — `options`
 * (which drizzle MUTATES at construction to install its type parsers), `begin`, `end`, `listen` —
 * passes through to the real client untouched, so this cannot drift as the driver grows methods.
 */
function withAcquireCeiling(
  client: ReturnType<typeof postgres>, ms: number,
): ReturnType<typeof postgres> {
  const guarded = (...args: unknown[]) => guardAcquire(
    (client as unknown as { unsafe: (...a: unknown[]) => object }).unsafe(...args), ms,
  );
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "unsafe") return guarded;
      const value = Reflect.get(target, prop);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as ReturnType<typeof postgres>;
}

// Serverless request-scoped Db. One pool per connection string, module-cached so a warm instance
// reuses it across requests instead of opening a connection per invocation (which exhausts the
// upstream pooler under concurrency). `prepare: false` is REQUIRED behind a transaction-mode
// pooler (see `session-url.ts`): cached prepared statements collide across pooled backends — pass
// the POOLED connection string here, not the direct one. Small `max` + short `idle_timeout` keep
// each instance's footprint tiny. `connection: POOLED_TIMEOUTS` reaches the backend ONLY on a
// direct connection (self-host) — measured inert through a transaction-mode pooler; the mechanism
// for a pooled deployment is ROLE_DEFAULT_TIMEOUTS. The wait for this one connection is bounded
// client-side by POOLED_ACQUIRE_TIMEOUT_MS, because every server ceiling bounds a statement that
// already HAS a connection.
const pools = new Map<string, ReturnType<typeof postgres>>();

export function makePooledDb(
  url: string,
  /**
   * `acquireTimeoutMs` overrides {@link POOLED_ACQUIRE_TIMEOUT_MS} for this handle.
   *
   * A PARAMETER rather than a `process.env` read, for the reason `AdminConfig.readTimeoutMs`
   * already gives one package over: a guard for this ceiling has to watch a caller actually be
   * refused, and it cannot spend the production duration doing it. Production passes nothing.
   * The ceiling is a property of the HANDLE, not of the pool, so two callers may hold different
   * ones over the same module-cached connection.
   */
  opts: { acquireTimeoutMs?: number } = {},
): PostgresJsDatabase<typeof schema> {
  let pooled = pools.get(url);
  if (!pooled) {
    pooled = postgres(url, {
      prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10,
      connection: POOLED_TIMEOUTS, onnotice: onNotice,
    });
    pools.set(url, pooled);
  }
  return brandDialect(
    drizzle(withAcquireCeiling(pooled, opts.acquireTimeoutMs ?? POOLED_ACQUIRE_TIMEOUT_MS), { schema }),
    "pg",
  );
}

export async function closePooledDbs(): Promise<void> {
  for (const p of pools.values()) await p.end({ timeout: 5 });
  pools.clear();
}
