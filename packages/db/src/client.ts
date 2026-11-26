import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { PostgresJsSession, PostgresJsTransaction } from "drizzle-orm/postgres-js/session";
import postgres from "postgres";
import { schema } from "./schema.js";
import { onNotice } from "./notices.js";
import { brandDialect } from "./dialect/index.js";
import { withPgSocket } from "./pg-socket.js";
import { pgTlsOptions } from "./pg-tls.js";
import { registerReadFlight } from "./read-flight.js";
import { HANDLE_TABLE, POOLED_WRITE_MAX_CONNECTIONS, type HandleCell, type HandleRole } from "./handle-table.js";
import {
  BINDER_SQL, BindingFailedError, bindingOf, refuseBinding, registerBindingDoor, registerTxDoor,
  type BindingValues,
} from "./bound.js";

// The handle's numbers live in its one table; their names are this module's exports as before.
export {
  WORKER_POOL_MAX, WORKER_TIMEOUTS, POOLED_TIMEOUTS, API_MAX_DURATION_MS, ROLE_DEFAULT_TIMEOUTS,
  POOLED_ACQUIRE_TIMEOUT_MS, SESSION_ACQUIRE_TIMEOUT_MS, POOLED_MAX_CONNECTIONS, POOLED_IDLE_TIMEOUT_S,
} from "./handle-table.js";

type Sql = ReturnType<typeof postgres>;

let sql: Sql | null = null;

/** The largest bind-parameter count postgres.js 3.4.9 sends: it refuses 65,534 or more. */
export const MAX_BIND_PARAMETERS = 65_533;

/**
 * A statement over {@link MAX_BIND_PARAMETERS}, refused by {@link withBindLimit} in the caller's own
 * call. The code is what the worker's classifier reads; it names no SQLSTATE because no server saw it.
 */
export class BindLimitError extends Error {
  readonly code = "OHMAIL_BIND_LIMIT";
  constructor(readonly count: number) {
    super(`a statement with ${count} bind parameters, over the ${MAX_BIND_PARAMETERS} this driver sends`);
    this.name = "BindLimitError";
  }
}

/** A postgres.js query (a Promise carrying its template), as opposed to a value that merely looks like one. */
const isQuery = (v: unknown): v is { args: unknown[] } =>
  v instanceof Promise && "strings" in v && Array.isArray((v as { args?: unknown }).args);
const keysOf = (x: unknown): string[] => x !== null && typeof x === "object" ? Object.keys(x) : [];

/**
 * What a tagged call binds, never under the driver's count: a fragment its own values, an array of
 * fragments each one's, and a helper (`sql(rows, ...columns)`) every cell under the widest of the
 * driver's builders (values reads one row's keys, insert the first row's), a cell counted the same way.
 */
export function boundCount(values: readonly unknown[]): number {
  let n = 0;
  for (const v of values) n += valueCount(v);
  return n;
}

function valueCount(v: unknown): number {
  if (isQuery(v)) return boundCount(v.args);
  if (Array.isArray(v) && isQuery(v[0])) return boundCount(v);
  const b = v as { first?: unknown; rest?: unknown; build?: unknown } | null;
  if (b === null || typeof b !== "object" || typeof b.build !== "function" || !("first" in b)) return 1;
  const first = b.first;
  const named = Array.isArray(b.rest) ? (b.rest as unknown[]).flat().map(String) : [];
  const cells = (row: unknown, columns: string[]) =>
    columns.reduce((sum, c) => sum + valueCount((row as Record<string, unknown> | null)?.[c]), 0);
  const multi = Array.isArray(first) && Array.isArray(first[0]);
  const values = (multi ? (first as unknown[]) : [first])
    .reduce((sum: number, row) => sum + cells(row, named.length ? named : keysOf(multi ? (first as unknown[])[0] : first)), 0);
  const insert = (Array.isArray(first) ? first : [first])
    .reduce((sum: number, row) => sum + cells(row, named.length ? named : keysOf(Array.isArray(first) ? first[0] : first)), 0);
  return Math.max(values, insert);
}

/**
 * THE BIND-COUNT GUARD, at every door into a postgres.js client: a statement over the driver's limit
 * is refused HERE, synchronously, before the driver sees it. The driver's own refusal comes after it
 * has queued the statement behind another caller's on a busy connection, rejects THAT caller's query,
 * and leaves every later reply one query out of step (connection.js:166-187). The doors are the
 * tagged call (also through `call`, `apply`, `bind`), `unsafe`, `file`, the tagged `savepoint`, and
 * the scoped handles `begin`, `savepoint` and `reserve` hand on; `bind-limit-doors.pg.test.ts` lists them.
 */
export function withBindLimit(client: ReturnType<typeof postgres>): ReturnType<typeof postgres> {
  type Sql = ReturnType<typeof postgres>;
  const refuse = (count: number): void => { if (count > MAX_BIND_PARAMETERS) throw new BindLimitError(count); };
  const tagged = (args: unknown[]): boolean => Array.isArray((args[0] as { raw?: unknown } | null)?.raw);
  const scoped = (args: unknown[]): unknown[] => {
    const fn = args[args.length - 1];
    return typeof fn === "function" ? [...args.slice(0, -1), (sql: Sql) => (fn as (s: Sql) => unknown)(door(sql))] : args;
  };
  const { apply, call, bind } = Function.prototype;
  const door = (sql: Sql): Sql => new Proxy(sql, {
    apply(target, self, args: unknown[]) {
      refuse(boundCount(args.slice(1)));
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, self, args);
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      // `call`, `apply` and `bind` invoke the guarded handle, never the raw one beneath it.
      if (value === apply || value === call || value === bind) return (value as (...a: unknown[]) => unknown).bind(receiver);
      const fn = value as (...a: unknown[]) => unknown;
      if (prop === "unsafe" || prop === "file") {
        return (text: unknown, params: unknown[] = [], ...rest: unknown[]) => {
          refuse(Array.isArray(params) ? params.length : 0);
          return fn.call(target, text, params, ...rest);
        };
      }
      if (prop === "begin" || prop === "savepoint") {
        return (...a: unknown[]) => {
          if (tagged(a)) refuse(boundCount(a.slice(1)));
          return fn.apply(target, scoped(a));
        };
      }
      if (prop === "reserve") return async (...a: unknown[]) => door(await (fn.apply(target, a) as Promise<Sql>));
      return fn.bind(target);
    },
  });
  return door(client);
}

/**
 * THE ONE BUILDER, half one: a postgres.js pool for a cell of the handle's table. Every server
 * handle's pool is opened here, so a pool's size, prepared statements, idle close, dial and
 * deadlines are the table's and nowhere else's.
 */
function openPool(url: string, cell: HandleCell, max: number = cell.max): Sql {
  const waiting = new Set<() => void>();
  const pool = postgres(url, withPgSocket({
    ...pgTlsOptions(url), max, prepare: cell.prepare,
    ...(cell.idleTimeoutS === null ? {} : { idle_timeout: cell.idleTimeoutS }),
    ...(cell.connectTimeoutS === null ? {} : { connect_timeout: cell.connectTimeoutS }),
    connection: cell.connection, onnotice: onNotice,
    // Once the driver has handed its first waiting statement to the connection it dials again.
    onclose: () => { if (waiting.size > 0) queueMicrotask(() => { for (const ask of [...waiting]) ask(); }); },
  }));
  reservations.set(pool, waiting);
  return pool;
}

/** Each pool's waiting reservations, each asked again after a close (see {@link reserveWithin}). */
const reservations = new WeakMap<Sql, Set<() => void>>();

/** What a dressed handle was built from: its pool, its cell and its role. Read by `acquireCeilingHandle`. */
const dressed = new WeakMap<object, { pool: Sql; cell: HandleCell; role: HandleRole }>();

/** A drizzle handle's own session, which a bound session copies its dialect and schema from. */
const sessionOf = (handle: object): object => (handle as unknown as { session: object }).session;

/**
 * THE ONE BUILDER, half two: the drizzle handle over a pool, dressed as its cell says. Every pool
 * handle gets the bind limit, the wait ceiling where its cell (or the caller) names one, one flush
 * where its cell has no prepared statements, a one-flight read, and a binding door: a view bound
 * over it (`bound.ts`) runs its statements and transactions in flights that name the account. The
 * staff handle gets no door, and binding it is refused: its role is its whole binding.
 */
function dress(pool: Sql, cell: HandleCell, waitMs: number | null, role: HandleRole): PostgresJsDatabase<typeof schema> {
  let client: Sql = cell.prepare ? pool : withOneFlush(pool);
  if (waitMs !== null) client = withAcquireCeiling(client, waitMs);
  client = withBindLimit(client);
  const handle = brandDialect(drizzle(client, { schema }), "pg");
  const flightHandle = brandDialect(drizzle(withReadFlight(pool, client, waitMs), { schema }), "pg");
  registerReadFlight(handle, flightHandle);
  if (role === "staff") {
    refuseBinding(handle);
    refuseBinding(flightHandle);
  } else {
    registerBindingDoor(handle, { sessionFor: (values) => boundSession(sessionOf(handle), pool, waitMs, values, false) });
    registerBindingDoor(flightHandle, { sessionFor: (values) => boundSession(sessionOf(flightHandle), pool, waitMs, values, true) });
  }
  dressed.set(handle, { pool, cell, role });
  return handle;
}

/** The long-lived singleton connection — for the always-on worker (one process, one pool). */
export function makeDb(url: string): PostgresJsDatabase<typeof schema> {
  const cell = HANDLE_TABLE.worker.session;
  sql = openPool(url, cell);
  return dress(sql, cell, cell.waitMs, "worker");
}

export async function closeDb(): Promise<void> {
  if (sql) { await sql.end({ timeout: 5 }); sql = null; }
}

export interface OwnedDb {
  db: PostgresJsDatabase<typeof schema>;
  close(): Promise<void>;
}

/**
 * An INDEPENDENT pool + handle whose lifetime the CALLER owns, on a session pool: the worker's
 * cell unless a role is named (the self-hosted API's process names `api`).
 *
 * `makeDb`/`closeDb` share one module-global `sql`, so `closeDb()` closes whichever pool
 * was created LAST. That is fine for a single always-on process, but it silently breaks
 * as soon as two db-owning things live in one process — two shard workers side by side,
 * a standby taking over while the old leader tears down, or a worker started inside a
 * test that already called `makeDb`: one owner's teardown closes another owner's LIVE
 * pool. Every worker/cron entry uses this instead.
 */
export function makeOwnedDb(url: string, opts: { role?: "api" | "worker" | "roster" } = {}): OwnedDb {
  const role = opts.role ?? "worker";
  const cell = HANDLE_TABLE[role].session;
  const own = openPool(url, cell);
  return {
    db: dress(own, cell, cell.waitMs, role),
    close: async () => { await own.end({ timeout: 5 }); },
  };
}

/**
 * Thrown when a statement or a transaction spent its ceiling on the pooled handle without the
 * backend beginning it — the connection was occupied by whatever sat ahead. Not a database-down
 * signal: its own class, answered 503 with `Retry-After`. A refused STATEMENT may still reach the
 * server: it was pipelined, and {@link guardAcquire} does not cancel, so it normally executes and
 * its result is discarded. Retry safety for a mutation is therefore not asserted: the 503 marks
 * itself retryable only for a safe method or an `Idempotency-Key`. A refused TRANSACTION writes
 * nothing: {@link beginWithin} rolls it back before its callback runs. Also thrown when the pooler
 * refused a statement it never forwarded.
 */
export class DbAcquireTimeoutError extends Error {
  readonly code = "db_acquire_timeout";
  constructor(readonly waitedMs: number, what: "statement" | "transaction" = "statement") {
    super(`the database connection did not begin this ${what} within ${waitedMs}ms`);
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

const CONNECTION_CAP_CODE = "db_connection_cap";

/**
 * Thrown when the pooler (`EMAXCONN`) or the server (`53300`) refused a NEW connection
 * at its client cap, so the statement never began: busy, like {@link DbAcquireTimeoutError}, and
 * answered 503 the same way. 2026-10-26: cold instances' held connections filled the pooler's 200
 * and every route answered 500 for six minutes. Fixed text and no `cause`: a postgres.js error
 * carries the query and its parameters.
 */
export class DbConnectionCapError extends Error {
  readonly code = CONNECTION_CAP_CODE;
  constructor(readonly cap: "pooler" | "server") {
    super(cap === "pooler"
      ? "the connection pooler refused a new connection at its client limit"
      : "the database refused a new connection at its connection limit");
    this.name = "DbConnectionCapError";
  }
}

/** By name, for {@link isDbAcquireTimeout}'s reason. */
export function isDbConnectionCap(err: unknown): err is DbConnectionCapError {
  return typeof err === "object" && err !== null
    && (err as { name?: unknown }).name === "DbConnectionCapError";
}

/** The cap a driver refusal names, or null. The message is read to classify and is never kept. */
function connectionCapOf(err: unknown): "pooler" | "server" | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name !== "PostgresError") return null;
  if (e.code === "53300") return "server";
  if (e.code === "XX000" && typeof e.message === "string" && e.message.startsWith("(EMAXCONN)")) return "pooler";
  return null;
}

/**
 * The pooler's checkout refusal as it goes on the wire (its error code in front). Anchored: its other
 * XX000 FATALs, such as a DbHandler exit, come after the statement was forwarded.
 */
const POOLER_CHECKOUT_REFUSED = /^\(ECHECKOUTTIMEOUT\) unable to check out connection from the pool after \d+ms in (?:Transaction|Session) mode$/;

/** The pooler closed the connection saying it never handed the statement to a backend. */
function poolerRefused(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; serverError?: { code?: unknown; message?: unknown } } | null;
  // An open connection's head carries it on the close; a cold dial's statement gets it bare.
  const s = e?.code === "CONNECTION_CLOSED" ? e.serverError : e;
  if (!s || typeof s.message !== "string") return false;
  return (s.code === "XX000" && POOLER_CHECKOUT_REFUSED.test(s.message))
    || (s.code === "08P01" && s.message === "query_wait_timeout");
}

/** What a caller waited to begin, in its busy refusal's words: one statement, or a transaction. */
type Carried = "statement" | "transaction";

/**
 * `err`, or the busy refusal it is: a pooler or server cap on a new connection, or the pooler's refusal
 * of a statement it never forwarded (the acquire ceiling's class, `started` when the wait began).
 */
function asBusyRefusal(err: unknown, started: number, what?: Carried): unknown {
  const cap = connectionCapOf(err);
  if (cap !== null) return new DbConnectionCapError(cap);
  return poolerRefused(err) ? new DbAcquireTimeoutError(Date.now() - started, what) : err;
}

/** What one fresh connection said: it opened and answered in `ms`, or the code it was refused with. */
export interface FreshConnectReading { ok: boolean; ms: number; code: string | null }

interface ApiAccessFixture { readonly account: string; readonly message: string }

/**
 * CAN THIS INSTANCE OPEN A NEW CONNECTION? `/health`'s probe rides one the pool already holds, so on
 * 2026-10-26 it read healthy on warm instances while the pooler refused every new client. One
 * unpooled client, `select 1`, ended at once. Single-flight and kept `memoMs`, so an instance dials
 * at most once a window; never throws. A cap reads `db_connection_cap`, the deadline
 * `CONNECT_TIMEOUT`, anything else the driver's code.
 */
export function freshConnectProbe(
  url: string, opts: { timeoutMs?: number; memoMs?: number; apiAccess?: ApiAccessFixture } = {},
): () => Promise<FreshConnectReading> {
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const memoMs = opts.memoMs ?? 10_000;
  let kept: { at: number; settled: boolean; reading: Promise<FreshConnectReading> } | null = null;
  return () => {
    if (kept && (!kept.settled || Date.now() - kept.at < memoMs)) return kept.reading;
    const next = { at: Date.now(), settled: false, reading: freshConnect(url, timeoutMs, opts.apiAccess) };
    void next.reading.then(() => { next.settled = true; });
    kept = next;
    return next.reading;
  };
}

async function freshConnect(url: string, timeoutMs: number, apiAccess?: ApiAccessFixture): Promise<FreshConnectReading> {
  const started = Date.now();
  let client: ReturnType<typeof postgres> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    client = postgres(url, withPgSocket({
      ...pgTlsOptions(url), max: 1, prepare: false, fetch_types: false,
      connect_timeout: timeoutMs / 1000, onnotice: onNotice,
    }));
    const deadline = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("CONNECT_TIMEOUT"), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    const read = apiAccess
      ? client.begin("read only", async (tx) => {
          const { account, message } = apiAccess;
          await tx.unsafe(BINDER_SQL, [account, ""]);
          const [result] = await tx<{ visible: boolean }[]>`select
            exists (select 1 from public.accounts where id = ${account})
            and exists (select 1 from public.messages where id = ${message} and account_id = ${account})
            and exists (select 1 from ohmail.messages where id = ${message} and account_id = ${account}) as visible`;
          return result?.visible === true ? null : "API_ACCESS_UNPROVED";
        })
      : client`select 1`.then(() => null);
    const code = await Promise.race([read, deadline]);
    return { ok: code === null, ms: Date.now() - started, code };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return {
      ok: false, ms: Date.now() - started,
      code: connectionCapOf(err) !== null ? CONNECTION_CAP_CODE : typeof code === "string" ? code : null,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await client?.end({ timeout: 0 }).catch(() => undefined);
  }
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
   * query would make a second statement timeout. A one-flush head's first reply byte comes with
   * its completion, so silence cannot tell waiting from running: the bound is the pooler's refusal.
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
 * A transaction's BEGIN never reaches this function — `sql.begin` opens through the driver's own
 * internal handle — and racing the whole promise would answer 503 to a caller whose write then
 * commits anyway. {@link beginWithin} bounds that wait instead, and rolls a refused one back.
 */
function guardAcquire<Q extends object>(query: Q, ms: number): Q {
  const q = query as unknown as PooledQuery;
  let raced: Promise<unknown> | null = null;
  const arm = (): Promise<unknown> => (raced ??= new Promise((resolve, reject) => {
    const started = Date.now();
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
      (err) => { clearTimeout(timer); reject(asBusyRefusal(err, started)); },
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
 * The pooled client with {@link guardAcquire} on every query it issues and {@link beginWithin} on
 * every transaction it opens.
 *
 * Two methods overridden, and that is sufficient rather than lucky: drizzle's postgres-js session
 * reaches the driver through exactly `client.unsafe(sql, params)`, `client.unsafe(sql,
 * params).values()` and `client.begin(fn)`. Everything else — `options` (which drizzle MUTATES at
 * construction to install its type parsers), `end`, `listen` — passes through untouched to the
 * client beneath (the one-flush door), so this cannot drift.
 */
function withAcquireCeiling(
  client: ReturnType<typeof postgres>, ms: number,
): ReturnType<typeof postgres> {
  const guarded = (...args: unknown[]) => guardAcquire(
    (client as unknown as { unsafe: (...a: unknown[]) => object }).unsafe(...args), ms,
  );
  const begin = (...args: unknown[]) => beginWithin(client, args, ms);
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "unsafe") return guarded;
      if (prop === "begin") return begin;
      const value = Reflect.get(target, prop);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as ReturnType<typeof postgres>;
}

/** The callback of a transaction its caller was already refused: thrown so the driver rolls back. */
class AbandonedBegin extends Error {
  constructor() {
    super("this transaction's caller was refused before it began");
    this.name = "AbandonedBegin";
  }
}

/**
 * Put a ceiling on the WAIT TO BEGIN A TRANSACTION, and on nothing after it. The driver calls the
 * callback only once BEGIN has run on a reserved connection, so the callback's first act is the
 * line between the two: it disarms the timer, or — when the timer has already refused the caller
 * with {@link DbAcquireTimeoutError} — throws, and the driver answers ROLLBACK. A refused caller's
 * transaction therefore writes nothing, ever; the abandoned promise's own rejection is swallowed.
 * Whichever of the timer and the callback runs first decides; they cannot interleave. Every
 * transaction on a pooled handle carries it: 15 s on the managed API's default handle, 5 s on the
 * session doors — one that cannot begin in that time answers 503 `db_busy` instead of waiting.
 */
function beginWithin(client: ReturnType<typeof postgres>, args: unknown[], ms: number): Promise<unknown> {
  const open = (client as unknown as { begin: (...a: unknown[]) => Promise<unknown> }).begin;
  const fn = args[args.length - 1];
  if (typeof fn !== "function") return Reflect.apply(open, client, args) as Promise<unknown>;
  let refused = false;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      refused = true;
      reject(new DbAcquireTimeoutError(ms, "transaction"));
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    const begun = (sql: unknown): unknown => {
      clearTimeout(timer);
      if (refused) throw new AbandonedBegin();
      return (fn as (s: unknown) => unknown)(sql);
    };
    Promise.resolve(Reflect.apply(open, client, [...args.slice(0, -1), begun])).then(
      (value) => { clearTimeout(timer); if (!refused) resolve(value); },
      (err: unknown) => { clearTimeout(timer); if (!refused) reject(asBusyRefusal(err, started, "transaction")); },
    );
  });
}

/**
 * Thrown when a statement sent in one flush met a parameter the describe would have bound
 * differently: text or a number where the server's type has its own serializer (boolean, bytea),
 * or a flat array where it wanted something else. Pass the value as its own type. The statement
 * HAS run, and cannot be checked first: the server's types arrive with its result, after the Sync.
 * `committed` says which case this is — outside a transaction the Sync committed it and a retry
 * repeats the write; inside one it stands only if the transaction commits.
 */
export class DbParameterTypeError extends Error {
  readonly code = "db_parameter_type";
  constructor(readonly position: number, readonly oid: number, readonly committed: boolean) {
    super(`parameter $${position} met server type ${oid}, which binds it differently from its text; the statement ran `
      + (committed ? "outside a transaction and is committed — do not retry it" : "inside a transaction and stands only if it commits"));
    this.name = "DbParameterTypeError";
  }
}

/** The half of postgres.js' `Query` the one-flush door writes. See {@link sendInOneFlush}. */
interface FlushQuery {
  onlyDescribe?: boolean;
  statement: { types: number[] } | null;
  parameters: unknown[];
  resolve: (rows: unknown) => void;
  reject: (err: unknown) => void;
}
type Serializers = Record<number, (x: unknown) => unknown>;

/** A flat text/number array, written as the driver's own array serializer writes one. */
function arrayLiteral(xs: readonly unknown[]): string {
  return `{${xs.map((x) => (x === null ? "null"
    : `"${String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)).join(",")}}`;
}

/**
 * The arguments for a one-flush send and the positions whose type the server decides, or `null`
 * when a parameter needs the driver's describe (an object, a date, a nested or mixed array, a
 * typed `Parameter`): that statement keeps its two round trips. Null, a boolean, a bigint and
 * bytes carry their type from the client, which a describe never overwrites.
 */
function flatArgs(params: readonly unknown[]): { args: unknown[]; untyped: number[] } | null {
  const args: unknown[] = [];
  const untyped: number[] = [];
  for (const [i, v] of params.entries()) {
    if (v === null || typeof v === "boolean" || typeof v === "bigint" || v instanceof Uint8Array) args.push(v);
    else if (typeof v === "string" || typeof v === "number") { args.push(v); untyped.push(i); }
    else if (Array.isArray(v) && v.every((x) => x === null || typeof x === "string" || typeof x === "number")) {
      args.push(arrayLiteral(v));
      untyped.push(i);
    } else return null;
  }
  return { args, untyped };
}

/** The first server-typed position whose sent text is not what the describe would have bound. */
function divergent(q: FlushQuery, params: readonly unknown[], untyped: readonly number[], s: Serializers): number | null {
  for (const i of untyped) {
    const oid = q.statement?.types[i];
    if (!oid) return i;
    let bound: unknown;
    try { bound = oid in s ? s[oid]!(params[i]) : `${params[i] as string}`; } catch { return i; }
    if (bound !== q.parameters[i]) return i;
  }
  return null;
}

/**
 * ONE FLUSH, NOT TWO. Under `prepare: false` postgres.js 3.4.9 sends every parameterized statement
 * as Parse+Describe+Flush, waits, then Bind+Execute+Sync — two round trips to the pooler whatever
 * the types — only so Bind can serialize by the server's type. Here `describeFirst` reads false,
 * so the driver takes its own unnamed path (Parse, Describe, Bind, Execute, Sync in one write); the
 * reply still describes, and at resolution the statement is refused if a position was bound other
 * than the describe would have. `onexecute` false keeps each statement alone on its connection,
 * as the describe did: the pool's pipelining is unchanged.
 */
function sendInOneFlush(
  query: object, params: readonly unknown[], untyped: readonly number[], s: () => Serializers, lone: boolean,
): void {
  const q = query as FlushQuery;
  Object.defineProperty(q, "describeFirst", {
    configurable: true,
    get(this: FlushQuery) { return this.onlyDescribe === true; },
    set() { /* the driver's verdict is replaced, not stored */ },
  });
  const settle = q.resolve;
  q.resolve = (rows) => {
    const at = divergent(q, params, untyped, s());
    if (at === null) settle(rows);
    else q.reject(new DbParameterTypeError(at + 1, q.statement?.types[at] ?? 0, lone));
  };
}

const holdConnection = (): boolean => false;

/**
 * The pooled client with {@link sendInOneFlush} at every door drizzle uses: `unsafe`, and the
 * scoped clients `begin` and `savepoint` hand their callbacks, which are new driver handles the
 * outer proxy never sees. A caller passing its own `onexecute` keeps the driver's path.
 */
function withOneFlush(
  client: ReturnType<typeof postgres>, lone = true, pool: ReturnType<typeof postgres> = client, pipelined = false,
): ReturnType<typeof postgres> {
  type Sql = ReturnType<typeof postgres>;
  // The pool's: a reserved connection's handle carries no options of its own.
  const serializers = (): Serializers => (pool.options as unknown as { serializers: Serializers }).serializers;
  const unsafeOf = (t: Sql, lone: boolean) => (text: string, params: unknown[] = [], options: Record<string, unknown> = {}) => {
    const flat = params.length > 0 && !("onexecute" in options) ? flatArgs(params) : null;
    if (flat === null) return t.unsafe(text, params as never[], options);
    // `onexecute` is the driver's own query option; its types do not list it. A reserved connection
    // (`pipelined`) is this caller's alone: what follows is written behind it without a wait.
    const query = t.unsafe(text, flat.args as never[], (pipelined ? options : { ...options, onexecute: holdConnection }) as never);
    sendInOneFlush(query, params, flat.untyped, serializers, lone);
    return query;
  };
  const within = (args: unknown[]): unknown[] => {
    const fn = args[args.length - 1];
    return typeof fn === "function" ? [...args.slice(0, -1), (sql: Sql) => (fn as (s: Sql) => unknown)(door(sql, false))] : args;
  };
  // `lone`: the pool's own handle, where each statement is its own transaction; `begin` and
  // `savepoint` hand their callbacks a scoped handle inside one.
  const door = (sql: Sql, lone: boolean): Sql => new Proxy(sql, {
    get(target, prop) {
      if (prop === "unsafe") return unsafeOf(target, lone);
      if (prop === "begin" || prop === "savepoint") {
        const open = Reflect.get(target, prop) as ((...a: unknown[]) => unknown) | undefined;
        return open === undefined ? undefined : (...a: unknown[]) => open(...within(a));
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return door(client, lone);
}

type Reserved = Sql & { release: () => void };

/** A promise's outcome, read without throwing: a flight reads every answer before it decides. */
type Settled<T> = { ok: true; value: T } | { ok: false; err: unknown };
const settle = <T>(p: PromiseLike<T>): Promise<Settled<T>> =>
  Promise.resolve(p).then((value) => ({ ok: true as const, value }), (err: unknown) => ({ ok: false as const, err }));

/** The command tag a statement's result carries (`BEGIN`, `COMMIT`, `ROLLBACK`), or null. */
function commandOf(result: unknown): string | null {
  const c = (result as { command?: unknown } | null)?.command;
  return typeof c === "string" ? c : null;
}

/** The SQLSTATE a server's answer carries, or null (a connection's own error has none). */
function sqlstateOf(err: unknown): string | null {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" && c.length === 5 ? c : null;
}

/**
 * The connection lives after this answer: the server answered, at most with an error that ended no
 * session. A connection the server closed is never handed back to the pool.
 */
function alive(closed: Settled<unknown>): boolean {
  if (closed.ok) return true;
  const e = closed.err as { name?: unknown; severity?: unknown } | null;
  return e?.name === "PostgresError" && e.severity !== "FATAL" && e.severity !== "PANIC";
}

/**
 * A statement sent on a flight that has written its close. The flight's handle is dead from then
 * on: the driver's would still write on its old connection, which another flight may hold by then.
 */
export class FlightClosedError extends Error {
  constructor() {
    super("a statement was sent on a transaction that has already closed");
    this.name = "FlightClosedError";
  }
}

/**
 * The refusal postgres.js 3.4.9 makes while building a statement with a parameter left undefined
 * (`handleValue`), worded and coded as the driver words it, or null. A flight's doors make it first,
 * in the caller's own call: the driver throws it inside its write and hands it to the connection's
 * head, which in a flight is BEGIN.
 */
function undefinedValueIn(params: unknown): Error | null {
  return Array.isArray(params) && params.some((p) => p === undefined)
    ? Object.assign(new Error("UNDEFINED_VALUE: Undefined values are not allowed"), { code: "UNDEFINED_VALUE" })
    : null;
}

/** The driver's connection, as its query option `onexecute` hands it: what the guard compares and what ending a line needs. */
interface DriverConnection { readonly reserved: unknown; terminate(): void }

/** A postgres.js 3.4.9 query as a line holds it: the driver calls `handler` once, right before it writes it, and refuses it through `reject`. */
interface DriverQuery {
  handler: ((q: DriverQuery) => void) & { debug?: unknown };
  reject: (err: unknown) => void;
}

/**
 * A FLIGHT'S LINE: the connection reserved for it, and the only way the flight writes on it.
 * postgres.js 3.4.9 hands an error it raised itself while writing one statement to whichever
 * statement heads the connection (from there each answer belongs to another statement), and dials a
 * closed connection again for the next caller as the same object a reservation writes through.
 *
 * THE GUARD stands where the driver writes each statement of the flight, BEGIN, the binder, the
 * body, savepoints and the close alike: it writes only while the line is whole and the driver's
 * connection is still this flight's reservation (not closed, not dialed again for another caller).
 * Else nothing is written, the line is lost, and the statement answers the flight's failure. Once
 * the flight's close is written, only a close follows it; any other statement is refused unwritten.
 *
 * The first refusal of the driver's own that any statement of the flight meets (one it could not
 * write, a dead connection) loses the line in that same call: every statement of the flight not
 * answered yet is refused at once, before the driver's refusal, which carries the parameters of the
 * statement heading the connection (possibly the binder's), reaches it. A statement parked in the
 * reservation's own queue, which ending the connection never reaches, is among them. Then, once the
 * driver's call has returned, the connection is ended while it is still this flight's; it is never
 * handed back, and the pool dials a new one. The server's own errors leave the line whole.
 */
interface Line {
  readonly pool: Sql;
  /** The flight's client: its `unsafe` is the one way a flight builds a statement, each one under the guard. */
  readonly client: Sql;
  /** The refusal that lost the line, or null while it holds. */
  readonly lost: { readonly err: unknown } | null;
  /** Write `text` now and read its answer later; `closes` marks the flight's commit or rollback. */
  send(text: string, closes?: boolean): Promise<unknown>;
  /** Watch a statement of this flight until it is answered; `also` sees its error first. */
  watch<Q>(q: Q, also?: (err: unknown) => void): Q;
  /**
   * What a lost line answers, a new error each time: the busy refusal where the pooler refused a
   * statement it never handed on, else the error that lost it, bare.
   */
  failure(): unknown;
  /** Back to the pool once the flight's close was answered: only on a whole line, and only if the connection lives. */
  release(closed: Settled<unknown>): void;
}

/** A statement of a flight as the driver holds it: its refusal settles it, once. */
interface Watched {
  reject(err: unknown): void;
  catch(bad: (err: unknown) => void): Promise<unknown>;
  finally(fn: () => void): Promise<unknown>;
}

/** Neither the server's answer nor this module's check of a parameter's type: the driver's own refusal. */
const driversOwn = (err: unknown): boolean => {
  const name = (err as { name?: unknown } | null)?.name;
  return name !== "PostgresError" && name !== "DbParameterTypeError";
};

/**
 * The driver's error as a plain handle's caller reads it (name, message, code), less what the driver
 * hangs on it: the text and parameters of the statement heading the connection, which on a flight's
 * line may be the binder's.
 */
function bare(err: unknown): Error {
  const e = (typeof err === "object" && err !== null ? err : {}) as { name?: unknown; message?: unknown; code?: unknown };
  const out = new Error(typeof e.message === "string" ? e.message : "the database connection was lost");
  if (typeof e.name === "string") out.name = e.name;
  if (typeof e.code === "string") Object.assign(out, { code: e.code });
  return out;
}

/**
 * The guard's finding: the connection this flight reserved closed, or was dialed again for another
 * caller, before all of the flight was written. Coded as the driver codes a closed connection; it
 * names no host.
 */
const notOurs = (what: Carried): Error => Object.assign(
  new Error(`the database connection reserved for this ${what} closed before all of it was written`),
  { code: "CONNECTION_CLOSED" },
);

/** `started`: when the flight began to wait for its connection; `what`: what it carries, for a busy refusal's words. */
function lineOf(conn: Reserved, pool: Sql, started: number, what: Carried): Line {
  let driver: DriverConnection | null = null;
  let ours: unknown = null;
  let wrote = false;
  let closing = false;
  let lost: { err: unknown } | null = null;
  const unanswered = new Set<Watched>();
  // `onexecute` is the driver's own query option; answering true keeps its pipelining as it was.
  const named = (c: DriverConnection): boolean => {
    if (driver === null) { driver = c; ours = c.reserved; }
    return true;
  };
  /** The driver's connection is still this flight's reservation: not closed, released, nor dialed again for another caller. */
  const owned = (): boolean => driver !== null && typeof ours === "function" && driver.reserved === ours;
  const failure = (): unknown => {
    const err = lost === null ? undefined : lost.err;
    const busy = asBusyRefusal(err, started, what);
    return busy !== err ? busy : bare(err);
  };
  const lose = (err: unknown): void => {
    if (lost !== null) return;
    lost = { err };
    // The flight's refusals first: what the driver refuses as it ends the connection is answered already.
    for (const q of unanswered) q.reject(failure());
    unanswered.clear();
    // Ended once the driver's call that lost it has returned, and only while it is still this flight's.
    queueMicrotask(() => { if (owned()) driver!.terminate(); });
  };
  /**
   * THE GUARD, where the driver writes a statement of this flight. The first one (BEGIN) is written on
   * the reservation just made, with no read of the network between, and names the driver's connection.
   */
  const handOff = (q: DriverQuery, write: DriverQuery["handler"], refuse: (err: unknown) => void, closes: boolean): void => {
    if (lost === null && wrote && !owned()) lose(notOurs(what));
    if (lost !== null) return refuse(failure());
    if (closing && !closes) return refuse(new FlightClosedError());
    wrote = true;
    if (closes) closing = true;
    write(q);
  };
  const query = (text: string, params: unknown[], options: Record<string, unknown>, closes: boolean): unknown => {
    const q = conn.unsafe(text, params as never[], options as never) as unknown as DriverQuery;
    const write = q.handler;
    const refuse = q.reject;
    q.handler = Object.assign((self: DriverQuery) => handOff(self, write, refuse, closes), { debug: write.debug });
    // The driver's own refusal loses the line before it settles this statement, which then reads the flight's failure.
    q.reject = (err: unknown) => {
      if (driversOwn(err)) lose(err);
      refuse(err);
    };
    return q;
  };
  const client = {
    unsafe: (text: string, params: unknown[] = [], options: Record<string, unknown> = {}) => query(text, params, options, false),
  } as unknown as Sql;
  const line: Line = {
    pool,
    client,
    get lost() { return lost; },
    send(text, closes = false) {
      const q = query(text, [], driver === null ? { onexecute: named } : {}, closes) as { execute: () => unknown };
      q.execute();
      return line.watch(q) as unknown as Promise<unknown>;
    },
    watch(q, also) {
      const s = q as unknown as Watched;
      unanswered.add(s);
      // `catch` and `finally`, never `then`: the answer itself is read once, by the caller.
      void s.catch((err: unknown) => { also?.(err); });
      void s.finally(() => { unanswered.delete(s); }).catch(() => undefined);
      return q;
    },
    failure,
    release(closed) {
      if (lost === null && alive(closed)) conn.release();
    },
  };
  return line;
}

/**
 * THE BINDER ON THE WIRE: its one statement on the flight's line, through the one-flush send on
 * every pool (never a named prepared statement, never a drizzle session: drizzle hands every
 * statement's parameters to its logger), dispatched at once. Its answer must echo both values; its
 * failure is a {@link BindingFailedError}, which carries no parameter.
 */
function sendBinder(line: Line, values: BindingValues): Promise<void> {
  const q = withOneFlush(line.client, false, line.pool, true).unsafe(BINDER_SQL, [values.account, values.key]);
  (q as unknown as { execute: () => unknown }).execute();
  return (line.watch(q) as unknown as Promise<Array<{ account?: unknown; key?: unknown }>>).then(
    (rows) => {
      const row = rows[0];
      if (row?.account !== values.account || row.key !== values.key) throw new BindingFailedError(null, false);
    },
    (err: unknown) => { throw new BindingFailedError(sqlstateOf(err), false); },
  );
}

/** A transaction's configuration, as drizzle hands it to `transaction`. */
interface TxConfig { isolationLevel?: string; accessMode?: string; deferrable?: boolean }

/** BEGIN's modes, a closed table: a caller's value is a key here and never text on the wire. */
const ISOLATION: Readonly<Record<string, string>> = {
  "read uncommitted": "isolation level read uncommitted",
  "read committed": "isolation level read committed",
  "repeatable read": "isolation level repeatable read",
  serializable: "isolation level serializable",
};
const ACCESS: Readonly<Record<string, string>> = { "read only": "read only", "read write": "read write" };

/**
 * The BEGIN a transaction's configuration names. Its modes ride in BEGIN: drizzle would send `set
 * transaction` after the binder's statement, and Postgres refuses an isolation level after a query.
 */
function beginText(config: TxConfig | undefined): string {
  const own = (table: Readonly<Record<string, string>>, key: string): string => {
    if (!Object.prototype.hasOwnProperty.call(table, key)) throw new TypeError("a transaction mode outside the closed list");
    return table[key]!;
  };
  const modes: string[] = [];
  if (config?.isolationLevel !== undefined) modes.push(own(ISOLATION, config.isolationLevel));
  if (config?.accessMode !== undefined) modes.push(own(ACCESS, config.accessMode));
  if (config?.deferrable !== undefined) modes.push(config.deferrable ? "deferrable" : "not deferrable");
  return modes.length === 0 ? "begin" : `begin ${modes.join(", ")}`;
}

/** What a flight hands its callback: the scoped client, and how to name the transaction again. */
type FlightBody<T> = (client: Sql, rename: (values: BindingValues) => Promise<void>) => Promise<T>;

/** The driver's answer inside a transaction a statement already aborted. */
const abortedBy = (err: unknown): boolean =>
  (err as { name?: unknown; code?: unknown } | null)?.name === "PostgresError" && (err as { code?: unknown }).code === "25P02";

/**
 * THE SCOPE OF A FLIGHT, ported from the driver's own (`postgres/src/index.js`, `begin`'s scope):
 * its statements on the reserved connection in one flush, pipelined; savepoints named by a counter,
 * written without a wait, `rollback to` on failure. A statement error the callback swallowed fails
 * the scope. Once the flight has written its close, or lost its line, the scope is dead: a statement
 * throws {@link FlightClosedError} before anything is written.
 */
function scopeOf(line: Line): { client: Sql; check(): void; rename(v: BindingValues): Promise<void>; close(): void } {
  let closed = false;
  let savepoints = 0;
  const shut = (): boolean => closed || line.lost !== null;
  const level = (): { client: Sql; uncaught: () => unknown } => {
    let uncaught: unknown;
    const send = withOneFlush(line.client, false, line.pool, true);
    const client = {
      unsafe(text: string, params: unknown[] = [], options: Record<string, unknown> = {}) {
        if (shut()) throw new FlightClosedError();
        if (Array.isArray(params) && params.length > MAX_BIND_PARAMETERS) throw new BindLimitError(params.length);
        // Swallowed, it still fails the transaction, as the driver's own refusal would.
        const undefinedValue = undefinedValueIn(params);
        if (undefinedValue !== null) { uncaught ??= undefinedValue; throw undefinedValue; }
        const q = send.unsafe(text, params as never[], options as never);
        // After the caller's chain (`values()`) is set: the error is noted, and the caller still reads it.
        queueMicrotask(() => { line.watch(q, (e: unknown) => { uncaught ??= e; }); });
        return q;
      },
      async savepoint(fn: (inner: Sql) => unknown): Promise<unknown> {
        if (shut()) throw new FlightClosedError();
        const name = `s${savepoints++}`;
        const opened = settle(line.send(`savepoint ${name}`));
        const inner = level();
        try {
          const out = await fn(inner.client);
          const begun = await opened;
          if (!begun.ok) throw begun.err;
          const late = inner.uncaught();
          if (late !== undefined) throw late;
          return out;
        } catch (err) {
          if (!shut()) await settle(line.send(`rollback to ${name}`));
          const first = inner.uncaught();
          throw abortedBy(err) && first !== undefined ? first : err;
        }
      },
    };
    return { client: client as unknown as Sql, uncaught: () => uncaught };
  };
  const top = level();
  return {
    client: top.client,
    check() {
      const e = top.uncaught();
      if (e !== undefined) throw e;
    },
    async rename(values) {
      if (shut()) throw new FlightClosedError();
      await sendBinder(line, values);
    },
    close() { closed = true; },
  };
}

/**
 * DOOR ONE, A READ-ONLY FLIGHT. `begin` through the driver waits for BEGIN's answer before the
 * first read is written, and the caller waits for COMMIT's before it has its rows: three waits for
 * one read. Here a connection is reserved (within the wait ceiling where the handle has one),
 * `begin read only` and the binder's statement are written and not awaited, so the callback's
 * first read follows them in the same write. It answers once the body, BEGIN and the binder have
 * answered; COMMIT (ROLLBACK on any error) follows unawaited, and the connection goes back to the
 * pool once that reply is in: never inside a transaction. A BEGIN the server refused means the
 * reads ran alone, bound to nothing: the caller gets {@link BindingFailedError}, never their rows.
 * A lost line answers {@link Line.failure}. Its statements go in one flush on every pool: on a
 * session pool a describe would be a wait of its own.
 */
async function readFlight<T>(pool: Sql, waitMs: number | null, values: BindingValues | null, fn: FlightBody<T>): Promise<T> {
  const started = Date.now();
  const line = lineOf((await reserveWithin(pool, waitMs, "transaction")) as Reserved, pool, started, "transaction");
  const scope = scopeOf(line);
  const opened = settle(line.send("begin read only"));
  const bound = values === null ? null : settle(sendBinder(line, values));
  const close = (text: string): void => {
    scope.close();
    if (line.lost !== null) return;
    void settle(line.send(text, true)).then((closed) => line.release(closed));
  };
  let out: T;
  try {
    out = await fn(scope.client, (v) => scope.rename(v));
    scope.check();
    const begun = await opened;
    if (!begun.ok) throw values === null ? begun.err : new BindingFailedError(sqlstateOf(begun.err), true);
    if (bound !== null) {
      const named = await bound;
      if (!named.ok) throw named.err;
    }
    if (line.lost !== null) throw line.failure();
  } catch (err) {
    close("rollback");
    throw line.lost !== null ? line.failure() : err;
  }
  close("commit");
  return out;
}

/**
 * DOOR TWO, A READ-WRITE FLIGHT: `begin` with its modes and the binder's statement written
 * together, and the body only after both answered (BEGIN's tag, the binder's echo) — a body sent
 * behind a refused start would commit statement by statement, outside its transaction. This is the
 * driver's own wait for BEGIN, and no more. Then the body; COMMIT is awaited and must answer
 * `COMMIT`. On any failure ROLLBACK is written and answered before the connection goes back. A lost
 * line writes nothing more and answers {@link Line.failure}.
 */
async function writeFlight<T>(pool: Sql, waitMs: number | null, values: BindingValues, modes: string, fn: FlightBody<T>): Promise<T> {
  const started = Date.now();
  const line = lineOf((await reserveWithin(pool, waitMs, "transaction")) as Reserved, pool, started, "transaction");
  const rollback = async (): Promise<void> => {
    if (line.lost !== null) return;
    line.release(await settle(line.send("rollback", true)));
  };
  const opened = settle(line.send(modes));
  const bound = settle(sendBinder(line, values));
  const begun = await opened;
  if (line.lost !== null) throw line.failure();
  const named = await bound;
  if (line.lost !== null) throw line.failure();
  if (!begun.ok || commandOf(begun.value) !== "BEGIN" || !named.ok) {
    await rollback();
    if (begun.ok && !named.ok) throw named.err;
    throw new BindingFailedError(begun.ok ? null : sqlstateOf(begun.err), false);
  }
  const scope = scopeOf(line);
  let out: T;
  try {
    out = await fn(scope.client, (v) => scope.rename(v));
    scope.check();
  } catch (err) {
    scope.close();
    await rollback();
    throw line.lost !== null ? line.failure() : err;
  }
  scope.close();
  const closed = await settle(line.send("commit", true));
  if (line.lost !== null) throw line.failure();
  if (!closed.ok) {
    if (alive(closed)) await rollback();
    throw closed.err;
  }
  line.release(closed);
  if (commandOf(closed.value) !== "COMMIT") throw new Error("the database rolled this transaction back at its commit");
  return out;
}

/**
 * A LONE STATEMENT ON A BOUND HANDLE IS ONE FLIGHT: begin, the binder's statement, the statement and
 * commit written before any answer is read, on a connection reserved for it. It answers when commit
 * has answered: one wait, as a statement alone had. The statement's own error reaches the caller
 * (the pipelined commit answers ROLLBACK); a commit-time error rejects the statement; a BEGIN the
 * server refused is {@link BindingFailedError} with `mayHaveRun`, never the statement's value. The
 * answers are read in the order written, and none after a lost line (it may never come): a lost
 * line answers {@link Line.failure}.
 */
async function loneFlight(pool: Sql, waitMs: number | null, values: BindingValues, issue: (scoped: Sql) => Promise<unknown>): Promise<unknown> {
  const started = Date.now();
  const line = lineOf((await reserveWithin(pool, waitMs, "statement")) as Reserved, pool, started, "statement");
  const opened = settle(line.send("begin"));
  const bound = settle(sendBinder(line, values));
  let statement: Promise<Settled<unknown>>;
  try {
    statement = settle(line.watch(issue(withOneFlush(line.client, true, pool, true))));
  } catch (err) {
    // Not swallowed: the statement could not be written, and this error is its answer, thrown
    // below once the flight's close has been read and the connection handed back.
    statement = Promise.resolve({ ok: false as const, err });
  }
  const closing = settle(line.send("commit", true));
  const begun = await opened;
  if (line.lost !== null) throw line.failure();
  const named = await bound;
  if (line.lost !== null) throw line.failure();
  const result = await statement;
  if (line.lost !== null) throw line.failure();
  const closed = await closing;
  if (line.lost !== null) throw line.failure();
  line.release(closed);
  if (!begun.ok) throw new BindingFailedError(sqlstateOf(begun.err), true);
  if (!named.ok) throw named.err;
  if (!result.ok) throw result.err;
  if (!closed.ok) throw closed.err;
  if (commandOf(closed.value) !== "COMMIT") throw new Error("the database rolled this statement back at its commit");
  return result.value;
}

/**
 * The client a bound view's statements are sent through: each one a lone flight, read as drizzle
 * reads a driver query (awaited, or through `values()` for row arrays). The binding lives in this
 * closure, never in a field a log or a walk of the handle could reach.
 */
function loneClient(pool: Sql, waitMs: number | null, values: BindingValues): object {
  return {
    unsafe(text: string, params: unknown[] = [], options: Record<string, unknown> = {}) {
      if (Array.isArray(params) && params.length > MAX_BIND_PARAMETERS) throw new BindLimitError(params.length);
      const undefinedValue = undefinedValueIn(params);
      if (undefinedValue !== null) throw undefinedValue;
      let raw = false;
      let run: Promise<unknown> | null = null;
      const go = (): Promise<unknown> => (run ??= loneFlight(pool, waitMs, values, (scoped) => {
        const q = scoped.unsafe(text, params as never[], options as never) as unknown as { values(): unknown; execute(): unknown };
        if (raw) q.values();
        q.execute();
        return q as unknown as Promise<unknown>;
      }));
      const answer = {
        values() { raw = true; return answer; },
        then<A = unknown, B = never>(ok?: ((v: unknown) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
          return go().then(ok, bad);
        },
        catch<B = never>(bad?: ((e: unknown) => B | PromiseLike<B>) | null) { return go().catch(bad); },
        finally(fn?: (() => void) | null) { return go().finally(fn); },
      };
      return answer;
    },
  };
}

/**
 * THE BOUND SESSION a view of a dressed handle runs through: drizzle's own session over a client
 * whose every statement is a lone flight, and whose `transaction` opens a flight itself (door two,
 * or door one for the read-flight handle) and builds drizzle's transaction over the flight's scope.
 */
function boundSession(base: object, pool: Sql, waitMs: number | null, values: BindingValues, readOnly: boolean): object {
  const { dialect, schema, options } = base as unknown as { dialect: never; schema: never; options: never };
  const session = new PostgresJsSession(loneClient(pool, waitMs, values) as never, dialect, schema, options);
  const open = <T>(fn: (tx: object) => Promise<T>): FlightBody<T> => (client, rename) => {
    const tx = new PostgresJsTransaction(dialect, new PostgresJsSession(client as never, dialect, schema, options), schema);
    registerTxDoor(tx, rename);
    return fn(tx);
  };
  Object.defineProperty(session, "transaction", {
    value: async <T>(fn: (tx: object) => Promise<T>, config?: TxConfig): Promise<T> => (readOnly
      ? readFlight(pool, waitMs, values, open(fn))
      : writeFlight(pool, waitMs, values, beginText(config), open(fn))),
    enumerable: false, configurable: false, writable: false,
  });
  return session;
}

/** The client a read-flight handle is built on: `begin` opens a read-only flight, the rest is `client`'s. */
function withReadFlight(pool: Sql, client: Sql, waitMs: number | null): Sql {
  const begin = (...args: unknown[]): Promise<unknown> => {
    const fn = args[args.length - 1] as (s: Sql) => Promise<unknown>;
    return readFlight(pool, waitMs, null, (scoped) => fn(scoped));
  };
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "begin") return begin;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Sql;
}

/**
 * A reserved connection, within `ms` when the handle has a ceiling, or {@link DbAcquireTimeoutError}
 * naming `what` the caller waited to begin; one reserved too late goes straight back. A reservation
 * that waits is asked again after each close of one of its pool's connections: postgres.js 3.4.9
 * hands the first statement waiting for a connection to the one it dials again, and drops it there
 * when it is a reservation, which then never answers. The first answer is kept; any later one goes
 * straight back.
 */
function reserveWithin(pool: Sql, ms: number | null, what: Carried): Promise<Reserved> {
  const started = Date.now();
  const waiting = reservations.get(pool);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settles = (): boolean => {
      if (settled) return false;
      settled = true;
      waiting?.delete(ask);
      if (timer !== undefined) clearTimeout(timer);
      return true;
    };
    const ask = (): void => {
      (pool.reserve() as Promise<Reserved>).then(
        (conn) => { if (settles()) resolve(conn); else conn.release(); },
        (err: unknown) => { if (settles()) reject(asBusyRefusal(err, started, what)); },
      );
    };
    if (ms !== null) {
      timer = setTimeout(() => { if (settles()) reject(new DbAcquireTimeoutError(ms, what)); }, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    waiting?.add(ask);
    ask();
  });
}

// Serverless request-scoped Db. One pool per connection string, module-cached so a warm instance
// reuses it across requests instead of opening a connection per invocation (which exhausts the
// upstream pooler under concurrency). `prepare: false` is REQUIRED behind a transaction-mode
// pooler (see `session-url.ts`): cached prepared statements collide across pooled backends — pass
// the POOLED connection string here, not the direct one. A small `max` keeps each instance's
// footprint tiny; `POOLED_IDLE_TIMEOUT_S` closes an idle one before its instance is suspended. `connection: POOLED_TIMEOUTS` reaches the backend ONLY on a
// direct connection (self-host) — measured inert through a transaction-mode pooler; the mechanism
// for a pooled deployment is ROLE_DEFAULT_TIMEOUTS. The wait for a connection is bounded
// client-side by POOLED_ACQUIRE_TIMEOUT_MS, because every server ceiling bounds a statement that
// already HAS a connection.
const pools = new Map<string, Sql>();
/**
 * ONE HANDLE PER POOL, CEILING AND ROLE, not one per call. Callers memoise facts per pool (the
 * search's pg_trgm probe and backfill marker, the knowledge base's probe), and the host asks for a
 * handle on every request: a fresh one each time re-ran every such probe on every request, a round
 * trip each through the pooler. A handle carries no request state — the drizzle session over the
 * shared pool.
 */
const handles = new Map<string, PostgresJsDatabase<typeof schema>>();

export function makePooledDb(
  url: string,
  /**
   * `role` picks the cell of the handle's table (`api` unless named); `acquireTimeoutMs`
   * overrides its wait to begin ({@link POOLED_ACQUIRE_TIMEOUT_MS}) for this handle.
   *
   * A PARAMETER rather than a `process.env` read, for the reason `AdminConfig.readTimeoutMs`
   * already gives one package over: a guard for this ceiling has to watch a caller actually be
   * refused, and it cannot spend the production duration doing it.
   * The ceiling is a property of the HANDLE, not of the pool, so two callers may hold different
   * ones over the same module-cached connection. `max` narrows the pool for a guard that needs
   * one connection. Managed write requests use their own pool on the same URL and role.
   */
  opts: { role?: Exclude<HandleRole, "worker">; acquireTimeoutMs?: number; max?: number; purpose?: "write" } = {},
): PostgresJsDatabase<typeof schema> {
  const role = opts.role ?? "api";
  const cell = HANDLE_TABLE[role].pooler;
  const ceiling = opts.acquireTimeoutMs ?? cell.waitMs;
  const poolKey = JSON.stringify([url, opts.purpose]);
  const key = JSON.stringify([poolKey, ceiling, role]);
  const known = handles.get(key);
  if (known) return known;
  let pooled = pools.get(poolKey);
  if (!pooled) {
    const max = opts.purpose === "write" ? POOLED_WRITE_MAX_CONNECTIONS : opts.max ?? cell.max;
    pooled = openPool(url, cell, max);
    pools.set(poolKey, pooled);
  }
  const handle = dress(pooled, cell, ceiling, role);
  handles.set(key, handle);
  return handle;
}

/**
 * A handle over the SAME postgres.js pool as `db` whose statements wait at most `ms` to begin: the
 * {@link makePooledDb} ceiling for a pool another factory built — the self-hosted server's
 * {@link makeOwnedDb}. A property of the handle: no connection, and the pool keeps its own
 * timeouts. Refuses a handle with no postgres.js client behind it (PGlite, `drizzle.mock()`), and a
 * bound handle: a binding is made over the pool's handle, never under it.
 */
export function acquireCeilingHandle(
  db: PostgresJsDatabase<typeof schema>, ms: number,
): PostgresJsDatabase<typeof schema> {
  if (bindingOf(db) !== undefined) throw new TypeError("acquireCeilingHandle: a bound handle is not a pool's handle");
  const built = dressed.get(db);
  if (built !== undefined) return dress(built.pool, built.cell, ms, built.role);
  const client = (db as { $client?: unknown }).$client;
  if (typeof client !== "function" || typeof (client as { unsafe?: unknown }).unsafe !== "function") {
    throw new TypeError("acquireCeilingHandle: this handle has no postgres.js pool behind it");
  }
  return brandDialect(
    drizzle(withAcquireCeiling(client as ReturnType<typeof postgres>, ms), { schema }), "pg",
  );
}

export async function closePooledDbs(): Promise<void> {
  handles.clear();
  for (const p of pools.values()) await p.end({ timeout: 5 });
  pools.clear();
}
