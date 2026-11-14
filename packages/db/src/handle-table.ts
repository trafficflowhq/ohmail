/**
 * THE HANDLE'S ONE TABLE: what each server handle's pool is, by the role it serves and the kind of
 * pool it dials. Every number a pool is built with is read from a cell here, and every cell is
 * written from the named constants below, so a number changes in one place and the reason for it
 * stays beside it. Today's numbers are the cells' stand-ins: the pooler's admission (its client
 * cap) and the server's room at the busy hour have not been read whole, so no cell is raised.
 *
 * Two kinds of pool. A SESSION pool dials a Postgres that keeps a connection's session (a
 * self-hosted server's own, or the managed host's session port): the deadlines asked at connect
 * reach the backend. A POOLER dials a transaction-mode pooler: no named prepared statements, every
 * statement in one flush, and deadlines that reach the backend only as the role's defaults. The
 * worker has no pooler cell: its leader lock and its long cycles need a session.
 */

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
 * How long a request may wait for a pooled connection to begin its statement before it is told
 * no. The only live statement ceiling in a pooled deployment is {@link ROLE_DEFAULT_TIMEOUTS}' 55 s,
 * and 55 s of holder plus any wait exceeds {@link API_MAX_DURATION_MS}. Measured: 47 504s in twenty
 * minutes; `HEAD /health` at 60 012 ms can only have WAITED. Once every connection is busy the
 * driver PIPELINES up to 100 queries onto a busy socket — everyone behind that head waits for it;
 * `connect_timeout` bounds only the dial. 15 s leaves time to RETURN the refusal; a fast 503 with
 * `Retry-After` beats an unattributable 504. Residual: per-QUERY, not a request budget.
 */
export const POOLED_ACQUIRE_TIMEOUT_MS = 15_000;

/**
 * The same wait, for the two SESSION doors — `GET /auth/session` and `POST /auth/refresh`, which
 * carry `withSessionAcquireCeiling` in `packages/api`. Every caller of those two gives up sooner
 * than 15 s (the edge gate's probe after 1.5 s; the resume splash and the desktop engine retry), so
 * a longer wait only turns a retry into a timeout. Busy answers 503 `db_busy` with `Retry-After`
 * in 5 s. It bounds the wait to BEGIN — a statement's, or a transaction's (`client.ts#beginWithin`)
 * — never the work: a rotation that began runs to its end, in one transaction.
 */
export const SESSION_ACQUIRE_TIMEOUT_MS = 5_000;

/**
 * Connections one warm serverless instance holds on the pooled URL. Fluid compute serves several
 * requests from one instance, and at `max: 1` every second request queued behind the first: the
 * `db_busy` the session doors answered. Four, bounded: the transaction-mode pooler multiplexes the
 * server side, and the client connections it admits are instances × 4. A fifth concurrent
 * statement still pipelines behind a busy connection and meets the acquire ceiling. The named
 * hole in `client.ts#PooledQuery` widens with it: up to four heads per instance can wait at the pooler.
 */
export const POOLED_MAX_CONNECTIONS = 4;

/**
 * How long, in seconds, a pooled connection may sit idle before the client closes it. Inside the
 * hosted API's quiet hold (`QUIET_HOLD_MS` in `apps/api-vercel/src/quiet-hold.ts`), so an instance's
 * idle connections close before the platform suspends it: a suspended instance holds its pooler
 * client slots until it wakes, and at 120 s ~160 cold instances filled the pooler's client cap
 * (2026-10-26). One second because the platform bills the instance's memory for the whole hold.
 * The cost: the first request after 1 s of quiet dials again, measured 134-178 ms against
 * 66-72 ms warm on a 10 ms round trip.
 */
export const POOLED_IDLE_TIMEOUT_S = 1;

/** Seconds a pooled dial may take before it is refused: the platform answers sooner than the driver's 30. */
export const POOLED_CONNECT_TIMEOUT_S = 10;

/**
 * The roster handle's connections (`roster-db.ts`): two, so a pass inside one bound transaction
 * can still send a statement on the outer handle. The only number of this table without a reading.
 */
export const ROSTER_POOL_MAX = 2;

/** One cell: how a pool for one role on one kind of pool is built. */
export interface HandleCell {
  /** Connections the pool may hold. */
  readonly max: number;
  /** False: no named prepared statements, every statement in one flush (`client.ts#withOneFlush`). */
  readonly prepare: boolean;
  /** Seconds an idle connection is kept, or null: never closed for idleness. */
  readonly idleTimeoutS: number | null;
  /** Seconds a dial may take, or null: the driver's own. */
  readonly connectTimeoutS: number | null;
  /** The server-side deadlines asked at connect (inert through a transaction pooler). */
  readonly connection: Readonly<Record<string, number>>;
  /** How long a statement or a transaction waits to begin, or null: no ceiling. */
  readonly waitMs: number | null;
}

/** The table. A role without a cell for a pool cannot be built on it: the worker has no pooler cell. */
export const HANDLE_TABLE = {
  api: {
    session: {
      max: WORKER_POOL_MAX, prepare: true, idleTimeoutS: null, connectTimeoutS: null,
      connection: WORKER_TIMEOUTS, waitMs: null,
    },
    pooler: {
      max: POOLED_MAX_CONNECTIONS, prepare: false, idleTimeoutS: POOLED_IDLE_TIMEOUT_S,
      connectTimeoutS: POOLED_CONNECT_TIMEOUT_S, connection: POOLED_TIMEOUTS, waitMs: POOLED_ACQUIRE_TIMEOUT_MS,
    },
  },
  worker: {
    session: {
      max: WORKER_POOL_MAX, prepare: true, idleTimeoutS: null, connectTimeoutS: null,
      connection: WORKER_TIMEOUTS, waitMs: null,
    },
  },
  // One connection: the console serializes every staff read per instance (`routes/admin.ts`).
  staff: {
    session: {
      max: 1, prepare: false, idleTimeoutS: POOLED_IDLE_TIMEOUT_S, connectTimeoutS: POOLED_CONNECT_TIMEOUT_S,
      connection: POOLED_TIMEOUTS, waitMs: POOLED_ACQUIRE_TIMEOUT_MS,
    },
    pooler: {
      max: 1, prepare: false, idleTimeoutS: POOLED_IDLE_TIMEOUT_S, connectTimeoutS: POOLED_CONNECT_TIMEOUT_S,
      connection: POOLED_TIMEOUTS, waitMs: POOLED_ACQUIRE_TIMEOUT_MS,
    },
  },
  roster: {
    session: {
      max: ROSTER_POOL_MAX, prepare: true, idleTimeoutS: null, connectTimeoutS: null,
      connection: WORKER_TIMEOUTS, waitMs: null,
    },
    pooler: {
      max: ROSTER_POOL_MAX, prepare: false, idleTimeoutS: POOLED_IDLE_TIMEOUT_S,
      connectTimeoutS: POOLED_CONNECT_TIMEOUT_S, connection: POOLED_TIMEOUTS, waitMs: POOLED_ACQUIRE_TIMEOUT_MS,
    },
  },
} as const satisfies Record<string, Partial<Record<"session" | "pooler", HandleCell>>>;

/** The roles a server handle is built for. */
export type HandleRole = keyof typeof HANDLE_TABLE;

/** The kinds of pool `role` has a cell for. */
export type PoolKindOf<R extends HandleRole> = keyof (typeof HANDLE_TABLE)[R];
