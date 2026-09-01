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
 * The correction is {@link ROLE_DEFAULT_TIMEOUTS}, below — a role-scoped Postgres server default
 * rather than a client-side option, applied by `setupProdDatabase` and verified from
 * `pg_db_role_setting`, with `packages/db/src/migrate.ts` and `setup-prod.ts` hardened first
 * against inheriting it as a ceiling on their own long-running statements.
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

/**
 * THE MECHANISM THAT ACTUALLY REACHES A TRANSACTION-MODE POOLER — a Postgres ROLE-ONLY default,
 * applied by `setupProdDatabase` (`ALTER ROLE … SET …`, deliberately NOT `IN DATABASE …`) and
 * verified from `pg_db_role_setting`, not a client-side connection option.
 *
 * ── WHY A ROLE DEFAULT, AFTER TWO OTHER MECHANISMS FAILED ─────────────────────────────────────
 *
 * `POOLED_TIMEOUTS` and `WORKER_TIMEOUTS` are both `connection: {…}` startup parameters, and
 * both are measured INERT through this deployment's connection pooler — on BOTH the
 * transaction-mode port and the port `apps/worker` calls "session", identically: a bare
 * `postgres.js` client sending `connection: { statement_timeout: "25000", … }` and then reading
 * `current_setting('statement_timeout')` back gets the pooler's own baseline, not the requested
 * value, on either port, in every round trip tried. The libpq-style `options: "-c
 * statement_timeout=…"` startup parameter was tried too and silently ignored the same way. A
 * ROLE default is different in kind: `pg_db_role_setting` is read by POSTGRES ITSELF at backend
 * session start, with zero pooler cooperation required.
 *
 * **AND IT HAD TO BE ROLE-ONLY, NOT `IN DATABASE …` — a second measured failure, not a design
 * choice made up front.** The first version scoped the ALTER to the connecting database, proved
 * the catalog row was correct, and it was STILL inert through the transaction-mode pooler: a
 * bare probe with no client options came back at the pooler's own baseline. The catalog itself
 * gave the answer — every one of the platform's own pre-existing hardened role defaults
 * (three roles, unrelated to this codebase) is `setdatabase = 0`, role-only, and not one is
 * database-scoped. Matching that exact shape reached the backend on the first try. The cost is a wider blast radius than
 * originally intended — the default now applies to every database this role ever opens, not only
 * the one production database — which is why every connection that legitimately needs more than
 * these ceilings (`migrate.ts`, `setup-prod.ts`'s own provisioning connections,
 * `provision-staff-role.ts`, `mailbox-dedup-cli.ts`) neutralizes it immediately on connect rather
 * than relying on scope to exclude it.
 *
 * ── WHY ONE SHARED VALUE AND NOT THE API'S OWN TIGHTER ONE ────────────────────────────────────
 *
 * A role default is necessarily shared: it is a fact about the ROLE, not about which factory
 * opened the connection, so `makePooledDb`'s request-scoped needs and `makeOwnedDb`'s long-lived
 * worker needs land on ONE set of numbers. These are `WORKER_TIMEOUTS`' values, not
 * `POOLED_TIMEOUTS`' tighter ones — `lock_timeout` and `idle_in_transaction_session_timeout`
 * carried over verbatim, `statement_timeout` at 55 s rather than 60 s so the database still gives
 * up strictly before {@link API_MAX_DURATION_MS} rather than racing it. The measured 504 family
 * was **waits, not runaways** — every one of the 103 timeouts sat at the platform's own ceiling
 * with no variance, which `lock_timeout`/`idle_in_transaction_session_timeout` address directly.
 * The API's original, tighter 25 s/10 s intent is an explicitly open residual: revisit it only if
 * live evidence ever shows a genuine runaway-STATEMENT family, which the measured population did
 * not contain.
 *
 * ── WHAT THIS DOES NOT TOUCH ───────────────────────────────────────────────────────────────────
 *
 * `POOLED_TIMEOUTS` and `WORKER_TIMEOUTS` stay exactly as they are: they are the working
 * mechanism for a self-hosted deployment dialling its own Postgres directly, with no pooler
 * multiplexing in front of it, which is precisely what `pooled-db.pg.test.ts` and
 * `worker-timeouts.pg.test.ts` prove and all they ever proved.
 */
export const ROLE_DEFAULT_TIMEOUTS = {
  lock_timeout: 30_000,
  statement_timeout: 55_000,
  idle_in_transaction_session_timeout: 60_000,
} as const;

/**
 * HOW LONG A REQUEST MAY WAIT FOR THE POOLED HANDLE'S ONE CONNECTION BEFORE IT IS TOLD NO.
 *
 * ── THE HOLE THIS FILLS, WHICH THIS FILE ALREADY NAMED AND DID NOT CLOSE ──────────────────────
 *
 * {@link POOLED_TIMEOUTS}' last paragraph has said, in these words, that `max: 1` means
 * postgres.js QUEUES rather than errors when the connection is busy and that *"that client-side
 * queue has no ceiling of its own. It is bounded only transitively — once no statement can run
 * longer than 25 s, the queue in front of it drains."*
 *
 * **The transitive bound does not exist in a pooled deployment.** `POOLED_TIMEOUTS` is measured
 * INERT through a transaction-mode pooler (the docblock above records the experiment), so the
 * only statement ceiling production actually has is {@link ROLE_DEFAULT_TIMEOUTS}, whose
 * `statement_timeout` is **55 s** — deliberately, because a role default is shared with the
 * worker. 55 s of holder plus any wait at all is more than {@link API_MAX_DURATION_MS}. The
 * queue is therefore bounded by a number LARGER than the platform's knife, which is the same as
 * not being bounded.
 *
 * ── WHAT THAT COSTS, MEASURED ─────────────────────────────────────────────────────────────────
 *
 * 47 × `504 FUNCTION_INVOCATION_TIMEOUT` in twenty minutes on one production build, every one at
 * the 60 s ceiling, across twelve unrelated routes at once, all on hot instances with
 * `crashed=false`. The diagnostic row was `HEAD /health` at **60 012 ms** — a route whose whole
 * database cost is one trivial `select`. A trivial read cannot take 60 s; it can only WAIT 60 s,
 * and what it waited for is the single connection this factory hands out, shared by every
 * concurrent invocation on that instance (`apps/api-vercel/src/deps.ts` builds one handle per
 * warm instance, and the platform runs many invocations on one instance).
 *
 * ── WHY THE EXISTING CEILINGS COULD NOT SEE IT ────────────────────────────────────────────────
 *
 * Every ceiling shipped before this one bounds a statement that ALREADY HAS a connection.
 * These requests never got one. Read the driver, not the intent:
 *
 *  · `postgres@3.4.9 src/connection.js` `execute(q)` — `query ? sent.push(q) : (query = q,
 *    q.active = true)`, and `execute` keeps returning truthy while `sent.length < max_pipeline`.
 *    `max_pipeline` defaults to **100** (`src/index.js`). So a busy `max: 1` connection does not
 *    make callers queue in the POOL — it PIPELINES up to a hundred of them onto the one socket,
 *    where Postgres runs them strictly in order. Everyone behind the head waits for the head.
 *  · `src/connection.js` starts `connectTimer` only when a socket is being CREATED and cancels
 *    it once the connection is ready. So `connect_timeout: 10` below bounds the DIAL and nothing
 *    else; a query pipelined onto an already-open connection is never touched by it.
 *
 * **MEASURED, because the intuitive model of this is wrong.** Against the real driver on :5433,
 * `max: 1`, warm: a `select pg_sleep(2)` followed 50 ms later by `select 1` — the trivial read
 * had `state` SET and `active` FALSE the moment it was dispatched, and it resolved at **+2002 ms**,
 * exactly when the sleep finished. It was never in a pool queue for a single millisecond. Reading
 * the pool's queue as the mechanism would have produced a ceiling that never fires, and the
 * ceiling below is written against `active` for that reason.
 *
 * Head-of-line blocking on one backend is the whole story, and the only thing bounding the head
 * is {@link ROLE_DEFAULT_TIMEOUTS}' 55 s. That is why the platform's 60 s knife is what ends
 * these requests, and why `HEAD /health` — one trivial select, pipelined behind a 55 s head —
 * reported 60 012 ms with `crashed=false` on a hot instance.
 *
 * This also covers the two candidates the incident named beside ours: an upstream pooler that
 * accepts the socket and then makes the client wait for a server backend is, from here, the same
 * event — a statement that has not begun. (Pooler exhaustion that fails the DIAL is already
 * bounded, by `connect_timeout`.)
 *
 * ── WHY 15 s ──────────────────────────────────────────────────────────────────────────────────
 *
 * Derived, not chosen for feel. It must be far enough under {@link API_MAX_DURATION_MS} that the
 * route still has time to RETURN the refusal rather than race the knife for it — 15 s leaves
 * 45 s — and comfortably above every healthy wait: production `/health` reports `dbLatencyMs` in
 * the tens of milliseconds, and `ADMIN_READ_TIMEOUT_MS` (12 s) already budgets the heaviest read
 * surface in the codebase end to end.
 *
 * ── WHAT IT TRADES, STATED ────────────────────────────────────────────────────────────────────
 *
 * A refusal here means more than fifteen seconds of database work sat ahead of this request on
 * the instance's one connection. That is a real condition and not a healthy one, but a wide
 * enough burst on a single instance can reach it without anything being broken, and those callers
 * are now refused where they previously waited. That is the intended trade and the runbook's: a
 * fast, attributable 503 carrying `Retry-After` beats a 60 s gateway timeout that carries nothing,
 * cannot be alerted on, and is indistinguishable from the API being down.
 *
 * Raising `max` is the separate question and is deliberately still NOT taken here. It is also the
 * one this measurement makes most interesting — `max: 1` plus `max_pipeline: 100` means one warm
 * instance serialises every concurrent invocation's database work through a single backend — but
 * the upstream pooler has its own connection budget, the burst that produced the incident was
 * modest, and nothing measured yet says what the right number is. Guessing ceilings is what
 * produced the two that could not bind.
 */
export const POOLED_ACQUIRE_TIMEOUT_MS = 15_000;

/**
 * Thrown when a query spent {@link POOLED_ACQUIRE_TIMEOUT_MS} on the pooled handle without the
 * backend ever beginning to execute it.
 *
 * It means THIS statement had not started: the connection was occupied by whatever sat ahead of
 * it. It does NOT mean the database is down, and it is not an unhandled fault — which is why it
 * is its own class rather than a 500. The API answers it 503 with `Retry-After`.
 *
 * **What it deliberately does NOT claim: that nothing reached the server.** The bytes were
 * written to the socket when the driver pipelined the query, so a statement refused here may
 * still be executed by Postgres afterwards; {@link guardAcquire} cancels it, but that cancel
 * races the server. Retry safety for a MUTATION therefore rests where it already rested — on
 * `Idempotency-Key` and `withIdempotency` — and not on this ceiling. The ceiling's contribution
 * is that the ambiguous window is now ~15 s with a named cause instead of 60 s with none: a
 * function killed by the platform mid-flight leaves exactly the same statement running, which is
 * what the paragraph on `maxDuration` in {@link POOLED_TIMEOUTS} is about.
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
   * TRUE for exactly one query per connection: the one at the head, which the backend is actually
   * running. `postgres/src/connection.js` sets it in `execute` for the head
   * (`query = q, query.active = true`) and again in the drain loop as each pipelined follower
   * reaches the front (`while (sent.length && (query = sent.shift()) && (query.active = true …`).
   *
   * So `active === false` is the driver-level spelling of "this statement has not begun" — the
   * precise condition the incident describes. **Note it is `active` and NOT `state`:** `state` is
   * assigned to every pipelined query the instant it is written to the socket, so it is true of a
   * query that will not run for another 55 s. Measured, not read — see the probe recorded in
   * {@link POOLED_ACQUIRE_TIMEOUT_MS}.
   */
  active: boolean;
  /**
   * `postgres/src/index.js` `cancel`: a pipelined query that has not begun is flagged
   * `query.cancelled`, and `connection.js` fires a CancelRequest at the backend the moment it
   * reaches the head. Best effort by construction — the statement is already on the wire, so this
   * races the server rather than preventing it — and worth doing anyway, because winning that race
   * is what keeps a refused statement from running on after nobody is waiting for its answer.
   */
  cancel(): unknown;
  then(onOk: (value: unknown) => void, onErr: (err: unknown) => void): unknown;
}

/**
 * Put a ceiling on the WAIT TO BEGIN EXECUTING — never on the statement itself.
 *
 * The timer fires once and asks one question: is the backend running THIS query? If it is
 * (`active`), the ceiling does nothing at all and the statement runs to whatever end the SERVER's
 * ceilings give it. Only a statement that has not started is cancelled and refused.
 *
 * That split is the whole design, and it is what keeps this from being a second, tighter
 * statement timeout wearing the wrong name. A statement legitimately allowed 55 s by
 * {@link ROLE_DEFAULT_TIMEOUTS} keeps all 55 s of it. What no longer happens is eleven other
 * requests silently inheriting that 55 s and dying on the platform's knife with no cause recorded.
 *
 * ── WHAT IT DOES NOT REACH, DELIBERATELY ──────────────────────────────────────────────────────
 *
 * **Transactions.** `postgres/src/index.js` `begin` opens with `sql.unsafe('begin …')` through the
 * driver's OWN internal handle, not the one handed to drizzle, so a transaction's wait to start is
 * not bounded here. It could only be bounded by racing the whole `sql.begin` promise, and that is
 * the one outcome strictly worse than the 504 being fixed: a 503 returned to a caller whose write
 * then commits anyway. Refusing that trade is deliberate. The measured burst was overwhelmingly
 * reads — `/search`, `/mailboxes`, `/sync`, `/sync/snapshot`, `/messages/bodies` and the `/health`
 * row that diagnosed it — and every one of those is bounded; a transaction benefits indirectly,
 * because refused readers stop adding to the pipeline in front of it.
 */
function guardAcquire<Q extends object>(query: Q, ms: number): Q {
  const q = query as unknown as PooledQuery;
  let raced: Promise<unknown> | null = null;
  const arm = (): Promise<unknown> => (raced ??= new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // The backend is running THIS statement: the server-side ceilings own it from here, and
      // killing work that is legitimately in progress is not this ceiling's job.
      if (q.active === true) return;
      try { q.cancel(); } catch { /* best effort — the rejection below is the contract */ }
      reject(new DbAcquireTimeoutError(ms));
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
//     dial in either case; the mechanism that reaches a pooled deployment is
//     ROLE_DEFAULT_TIMEOUTS, a role-level server default applied by `setupProdDatabase`.
//   • the WAIT FOR THIS ONE CONNECTION is bounded by POOLED_ACQUIRE_TIMEOUT_MS, client-side,
//     because none of the above can be: every one of them bounds a statement that already has a
//     connection, and `max: 1` means most of a busy instance's requests do not yet.
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
  return drizzle(
    withAcquireCeiling(pooled, opts.acquireTimeoutMs ?? POOLED_ACQUIRE_TIMEOUT_MS),
    { schema },
  );
}

export async function closePooledDbs(): Promise<void> {
  for (const p of pools.values()) await p.end({ timeout: 5 });
  pools.clear();
}
