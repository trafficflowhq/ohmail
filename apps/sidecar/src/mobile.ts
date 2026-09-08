/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PHONE'S COMPOSITION ROOT — the same engine, in the app's own runtime, over SQLite
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `main.ts` is the desktop's composition root: it reads the environment a native shell spawned it
 * with, opens the store, builds the engine, and serves it over a stdio frame protocol. This is the
 * same job for a phone, and the differences are the whole file:
 *
 *  · there is no process to spawn, so there is no environment and no frame codec. The engine is
 *    called IN-PROCESS and `handle(req)` is the seam — `serveOverStdio` is its desktop twin.
 *  · there is no PGlite, no lock file and no filesystem module, so the store arrives already open
 *    through `SidecarConfig.store`.
 *  · there is no `hostname()`, so `machineName` is required rather than defaulted.
 *  · there is no host door and no same-network door, and this build must not contain the code for
 *    one. See `src/phone/README.md` for what each of the desktop's boot-time modules answers here
 *    and why none of the three that are CALLED at boot may be a thrower.
 *
 * ── WHAT THIS FILE IS NOT ─────────────────────────────────────────────────────────────────
 *
 * It is not a second engine. `createSidecar` is imported and called, once, with a config — the
 * drain loop, the lease gate, the reconnect, the services and `runSyncCycle` are the desktop's, not
 * a phone-shaped copy of them. A fork would be two implementations of "organize a mailbox" and the
 * one thing that must never differ between them is which install may move a message.
 *
 * ── THE ONE CAST, AND WHY IT IS HERE ──────────────────────────────────────────────────────
 *
 * The services are typed against the server's handle and stay that way; the device store is a
 * `SqliteRemoteDatabase` that renders the same statements through the dialect seam. Exactly one
 * place hands one where the other is expected, and it is {@link openPhoneStore} below — the same
 * arrangement `packages/db/src/testing.ts` uses for the test harness, for the same reason: three
 * thousand call sites must not each be told there is a second dialect.
 *
 * ── HOST-MODE KNOBS ARE REFUSED, NOT IGNORED ──────────────────────────────────────────────
 *
 * A config carrying `hostMode`, `hostOrigin`, `hostPort`, `hostAssetsDir` or `lanBind` is refused
 * by name before anything is composed. The substitutes would disarm it anyway, and that is exactly
 * why the refusal is here: a caller that asked for a host door and got a silently disarmed one
 * would believe it had a door. The census over this refusal is `phone-engine-boot.test.ts`.
 */
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { brandDialect } from "@trafficflow/db/dialect";
import { migrateSqlite } from "@trafficflow/db/sqlite-migrate";
import type { OrganizerKindWritten } from "@trafficflow/core/adapters/organizer-lease";
/* THE WORKER'S SOCKET PROFILE, not a third one. See {@link startPhoneEngine}. */
import { WORKER_NET_TIMEOUTS } from "@trafficflow/core/adapters/imap";
import type { ImapConfig, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  createSidecar,
  type AdapterDialContext,
  type OrganizerState,
  type MailboxConnectionState,
  type SidecarImapConfig,
} from "./engine.js";
import type { LocalDb, OpenLocalDb } from "./db.js";
import type { Diagnostic } from "./log.js";
/* `@trafficflow/core/mail` and NOT the default barrel, for the reason `engine.ts:6` and
   `log.ts:1` both give: the barrel is `export *` over twenty-odd modules and reaches the private
   half. Type-only here, so it erases — but a specifier a later edit turns into a value import
   would carry the whole barrel into a phone's artifact, and the census would be the only witness. */
import type { LogFields, Logger, LogLevel } from "@trafficflow/core/mail";

/**
 * ONE STATEMENT AT A TIME, ONE HANDLE, AND ROWS AS ARRAYS IN THE STATEMENT'S COLUMN ORDER.
 *
 * The shape the phone's platform half implements and the node-side suite doubles. Three of its four
 * members carry a rule the device measured rather than a rule of taste:
 *
 *  · **`all` returns rows as ARRAYS, ordered by the STATEMENT's columns.** `drizzle-orm/sqlite-proxy`
 *    maps positionally. Both platform halves return row OBJECTS, and two columns of one name
 *    collapse to a single key — which fills both positions from one value and produces a row of the
 *    right length carrying the wrong data. That is worse than a short row, because nothing errors.
 *    So the conversion belongs to the implementation, which is the only thing that can ask the
 *    statement what its columns are, and this contract states the obligation.
 *  · **`batch` runs its statements in one transaction, in one call.** A drain page written
 *    statement by statement is a commit and a bridge crossing per row: measured at roughly 90 ms
 *    per single-row insert on a device, which turned a 3.6 s drain pass into 17–22 s. Used by
 *    `db.batch([...])`.
 *  · **Every call is SERIALIZED against every other.** Not an optimisation: the device's driver is
 *    asynchronous, so two overlapping read-modify-writes lose one.
 *
 * ── AND SERIALIZING EACH CALL IS NOT ENOUGH, WHICH IS WHY {@link oneTransactionAtATime} EXISTS ──
 *
 * The ruling's amendment says to wrap a drain page in one `batch` transaction "through the
 * executor's seam; `drizzle-orm/sqlite-proxy` supports it (`sqlite-proxy/session.js:40`)". Line 40
 * of that file is `transaction()`, and READ RATHER THAN ASSUMED it is precisely the method that
 * does NOT use the batch callback: it issues `begin`, the body's statements and `commit` as
 * SEPARATE calls through the ordinary one, and the batch callback serves only `db.batch([...])`,
 * an API the services never call. Measured on this composition's own boot: 132 executor calls,
 * one `begin`, one `commit`, and ZERO batch calls.
 *
 * So the amendment's citation supports the opposite of its conclusion, and the hazard it was
 * written to close is live: with `begin` and `commit` in different queue slots, another
 * transaction's `begin` lands between them and the store REFUSES it — "cannot start a transaction
 * within a transaction" — with one writer's work lost and a message naming nothing the caller was
 * doing.
 *
 * An executor cannot fix this by itself. It sees a flat stream of statements with no idea which
 * caller each belongs to, so "hold the queue after `begin`" would block the transaction's own
 * body and deadlock. The place that HAS the caller is the handle's `transaction` method, and that
 * is where the mutex goes — see {@link oneTransactionAtATime}.
 *
 * The harness's own executor must YIELD between calls. A synchronous double cannot express any of
 * this: with `node:sqlite`'s synchronous driver, removing the serialization changes nothing and the
 * suite stays green while the device path is broken.
 */
export interface PhoneSqlRows {
  /**
   * The STATEMENT's column names, in its own order — not the keys of whatever the driver returned.
   *
   * Returned beside the rows rather than left implicit because two consumers need opposite shapes
   * from one call: `drizzle-orm/sqlite-proxy` maps POSITIONALLY and wants arrays, and the SQLite
   * migrator reads `select sqlite_version() as version` and `pragma compile_options` as OBJECTS.
   * An executor that answered only one of them would leave the other guessing, and the guess that
   * was written first — take element zero and hope — makes the capability check read version
   * "0.0.0" and refuse every store.
   */
  readonly columns: readonly string[];
  readonly rows: readonly unknown[][];
}

export interface PhoneSqlExecutor {
  /** Rows as arrays, in the statement's own column order, with those names. See the banner. */
  all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows>;
  /** A statement with no rows to return. */
  run(sql: string, params: readonly unknown[]): Promise<void>;
  /** All of these, in one transaction, in one call. Rolls back as a unit. */
  batch(statements: readonly { sql: string; params?: readonly unknown[] }[]): Promise<void>;
  /** Release the handle. Idempotent — shutdown paths call it more than once. */
  close(): Promise<void>;
}

/** What a phone hands the engine. Everything the desktop reads from its environment, as values. */
export interface PhoneEngineDeps {
  /** The ENGINE's store — a second SQLite file, never the UI mirror's. */
  exec: PhoneSqlExecutor;
  /** The user's own IMAP (and optionally SMTP) server. */
  imap: SidecarImapConfig;
  /** The mailbox address. Defaults to the IMAP username, as it does on every other door. */
  address?: string;
  /**
   * HOW THIS PHONE NAMES ITSELF in the claim it writes — required, and required for a reason a
   * default would hide. The holder line on somebody's desktop reads this string. A composition with
   * no name of its own has nothing true to put there, and the engine refuses rather than inventing
   * one (there is no `hostname()` here to fall back to).
   */
  machineName: string;
  /**
   * WHO THIS INSTALL IS TO THE LEASE — from the app's install marker, which rotates on a restore.
   * Never the store's own account id: a restored backup carries that id back and two installs
   * sharing one are coalesced by the lease into a single organizer nobody can see.
   */
  installId: string;
  /**
   * THE PER-INSTALL KEY RING, `version → 64 hex characters`. The desktop's `OHMAIL_KEK` contract as
   * a value rather than an environment variable; `apps/mobile/src/engine/kek.ts` produces it.
   *
   * ABSENT ⇒ nothing is sealed to disk at all and credential storage is REFUSED rather than
   * performed under a key that dies with the process. That is the engine's own rule and it is not
   * softened here.
   */
  keks?: Record<number, string>;
  /** What the phone calls itself in the claim's kind. `mobile`, and the default is not `local`. */
  organizerKind?: OrganizerKindWritten;
  now?: () => Date;
  log?: Diagnostic;
  /**
   * A nominal directory, for the few paths that name one in a log line. Nothing is created here and
   * nothing is read from here: the store arrives open and this build has no filesystem module.
   */
  dataDir?: string;
  /**
   * TEST SEAM — how a mailbox connection is opened. Production passes nothing and the engine dials
   * for real.
   *
   * It is here because {@link startPhoneEngine} now DIALS on its own, and a composition suite that
   * did not intercept the dial would open a socket to whatever host its fixture named. The suite
   * had been passing this all along and it was being dropped on the floor: the config assembled
   * below never carried it, so the file's own statement that "no socket is opened: the adapter is
   * a double" was false, and harmless only for as long as nothing started the engine.
   */
  adapterFactory?: (cfg: ImapConfig, ctx: AdapterDialContext) => MailboxAdapter;
}

/** What a phone gets back. `handle` is the seam the in-app client talks to. */
export interface PhoneEngine {
  /** `Request → Response` over the local API — the desktop's stdio door, called directly. */
  handle(req: Request): Promise<Response>;
  /** The per-launch bearer the in-app client must send. In memory only. */
  readonly sessionToken: string;
  /**
   * RE-DIAL EVERY DEAD CONNECTION NOW — call this when the app returns to the foreground.
   *
   * A phone's socket dies on every background. Without this the phone shows "organizing" and files
   * nothing until the next poll tick comes round, bounded on the desktop's own numbers at up to
   * 120 s. It restores a connection and lets the ordinary gated cycle decide what may happen on
   * it; it never drains, because draining over a connection whose lease has not been read is how
   * two installs organize one mailbox.
   */
  wake(): Promise<void>;
  /** What each mailbox reports — the row's answer, not the gate's optimism. */
  runtimes(): { organizer: Record<string, OrganizerState>; connection: Record<string, MailboxConnectionState> };
  /** Flush and release. */
  stop(): Promise<void>;
}

/**
 * ONE-CLICK UNSUBSCRIBE, REFUSED BY NAME — because on this build it cannot work, and the way it
 * fails today is a module error.
 *
 * The chain, read end to end: `UnsubscribeService` posts through `pinnedHttpRequest`, which reaches
 * `node:http`/`node:https`, which on a phone are thrower stubs. The engine's own comment says
 * production "passes nothing and gets `nodeOneClickPost`" — so without this arm a person tapping
 * unsubscribe on a standalone phone gets a sentence about a Node process rather than an answer about
 * their mail.
 *
 * ── A REFUSAL, NOT A HALF-WIRED IMPLEMENTATION ────────────────────────────────────────────
 *
 * The platform HAS a working HTTP client, so a pass-through looks like a one-line fix. It is not.
 * The URL a `List-Unsubscribe` header names is the SENDER's choice, and the desktop refuses one
 * pointing at a LAN address for a reason that applies here more strongly rather than less: a phone
 * sits inside somebody's home network. That refusal is enforced by an SSRF gate that resolves DNS,
 * and DNS on this build is a thrower too — so honouring the header safely needs a device resolver
 * and a ruling about what the gate means on a device. Both belong to the door's own slice.
 *
 * Until then the honest answer is a refusal that says so. It THROWS rather than answering a status,
 * and the service's own error path is what makes that correct: it records the attempt as `failed`,
 * does NOT retry it (at-most-once, because nothing can tell whether the sender received it), and
 * re-throws. So the bookkeeping is right and the sentence reaches the person.
 *
 * NOTHING LEAVES THE DEVICE. No client is constructed, no address is resolved, no request is made —
 * asserted by a control rather than by this paragraph.
 */
export const phoneOneClickPost = {
  async post(_url: string, _pin: readonly string[]): Promise<{ status: number }> {
    throw new Error(
      "one-click unsubscribe is not available on this phone yet. The link a sender puts in an " +
        "unsubscribe header has to be checked before anything is sent to it — a link pointing " +
        "inside your own network must be refused — and that check is not built for this app yet. " +
        "Nothing was sent.",
    );
  },
};

/** The knobs that only mean something on a machine that serves a door to another device. */
const HOST_ONLY_KEYS = ["hostMode", "hostOrigin", "hostPort", "hostAssetsDir", "lanBind"] as const;

const KEK_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * HOW LONG A TRANSACTION MAY WAIT FOR THE ONE AHEAD OF IT BEFORE IT REFUSES BY NAME.
 *
 * Generous against any honest transaction on a device store — a drain page is milliseconds and the
 * slowest measured single-row write is about 90 ms — and short enough that the failure it exists to
 * name is diagnosable rather than a frozen screen.
 */
export const TRANSACTION_WAIT_MS = 30_000;

/**
 * NO TWO TRANSACTIONS IN FLIGHT ON THIS STORE, EVER — an install-wide mutex on `transaction`.
 *
 * ── THE FAILURE, MEASURED ON THE DEVICE'S BINDING RATHER THAN ARGUED ──────────────────────
 *
 * Two transactions started in the same tick end with the first committed and the second DEAD:
 * "cannot start a transaction within a transaction", and the row carries one writer's work. The
 * store does not order the second one, it refuses it. And it is reachable without a second
 * connection existing, because the proxy issues `begin`, the statements and `commit` as separate
 * calls — so a queue that serializes each STATEMENT does not make a TRANSACTION atomic.
 *
 * ── WHY HERE AND NOT IN THE EXECUTOR, AND NOT IN THE ENGINE ───────────────────────────────
 *
 * The executor cannot: it has no idea which caller a statement belongs to, so holding the queue
 * after `begin` would block that transaction's own body for ever. The engine's passes are already
 * serialized PER MAILBOX by the roster's queue — and per mailbox is the wrong granularity here,
 * for the reason the roster's own comment gives: it lets different mailboxes' drains overlap
 * because the desktop's store serializes transactions on its own mutex. This one does not. An API
 * request arriving during a drain is the same overlap from the other direction.
 *
 * So it goes at the one place every transaction on this store funnels through, whoever started it:
 * the handle's own `transaction` method.
 *
 * ── AND A MUTEX ON A RE-ENTRANT CALL IS A DEADLOCK, SO THE WAIT IS BOUNDED AND NAMED ──────
 *
 * Drizzle renders a NESTED transaction as a savepoint on the transaction OBJECT (`tx.transaction`),
 * which never reaches this method and is correct as it stands. But a caller that reaches for the
 * outer HANDLE from inside a transaction body — `db.transaction(...)` within `db.transaction(...)`
 * — would queue behind a transaction that cannot finish until the inner one returns. That is a
 * hang, and a hang is the worst of the three possible outcomes: it is indistinguishable from a slow
 * mail server, it holds the store for every later caller, and it names nothing.
 *
 * So the queue wait is bounded by {@link TRANSACTION_WAIT_MS} and the refusal SAYS WHAT TO LOOK
 * FOR. The entry stays in the chain rather than being dropped — dropping it would let the next
 * transaction start while the one ahead is still running, which is the invariant this whole
 * function exists for — so the outer transaction proceeds, its body receives the named rejection,
 * and its rollback releases the queue. Bounded, diagnosable, and self-healing rather than fatal.
 */
export function oneTransactionAtATime<T extends object>(db: T, waitMs = TRANSACTION_WAIT_MS): T {
  const handle = db as T & {
    transaction?: (fn: unknown, config?: unknown) => Promise<unknown>;
  };
  const inner = handle.transaction;
  if (typeof inner !== "function") return db;
  let tail: Promise<unknown> = Promise.resolve();
  handle.transaction = function serialized(fn: unknown, config?: unknown): Promise<unknown> {
    let started = false;
    const run = tail.then(
      () => { started = true; return inner.call(handle, fn, config); },
      () => { started = true; return inner.call(handle, fn, config); },
    );
    // The CHAIN keeps the entry whatever the caller is told, and swallows so that one transaction's
    // failure does not reject the next caller's turn.
    tail = run.catch(() => undefined);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (started) return;   // it is running; a slow transaction is not this failure
        reject(new Error(
          "this store allows one transaction at a time, and this one waited " +
            `${waitMs} ms without its turn. The usual cause is a transaction opened on the ` +
            "database handle from INSIDE another transaction's body: a nested transaction must be " +
            "opened on the transaction object it is nested in, which the driver renders as a " +
            "savepoint, not on the handle — the handle's turn cannot come round until the outer " +
            "one returns.",
        ));
      }, waitMs);
      run.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err: unknown) => { clearTimeout(timer); reject(err); },
      );
    });
  };
  return db;
}

/**
 * THE DEVICE STORE, BEHIND THE SERVER'S HANDLE TYPE — the one cast, and the migrator that runs
 * first.
 *
 * `migrateSqlite` before `drizzle`, in that order and through the same executor: the capability
 * check and `PRAGMA foreign_keys` are the migrator's, so a factory that did them itself would be a
 * factory the next factory does not copy. The journal is the DEVICE's, never the server's — the
 * server's is adopted by `db.ts`, which this bundle does not contain.
 */
export async function openPhoneStore(
  exec: PhoneSqlExecutor,
  /** TEST SEAM. Production takes {@link TRANSACTION_WAIT_MS}; a guard cannot wait thirty seconds. */
  transactionWaitMs = TRANSACTION_WAIT_MS,
): Promise<OpenLocalDb> {
  await migrateSqlite({
    run: async (statement: string): Promise<void> => { await exec.run(statement, []); },
    /* The migrator reads BY NAME (`version`, `compile_options`), so the positional rows are zipped
       back into objects with the statement's own column names. Zipped here rather than in the
       executor, because the executor must not know what any caller's columns mean — and read by
       name rather than by position because a `pragma` that grew a column would otherwise silently
       shift the one being read. */
    all: async <T,>(statement: string): Promise<T[]> => {
      const { columns, rows } = await exec.all(statement, []);
      return rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])) as T);
    },
  });

  const db = drizzleSqliteProxy(
    async (sql, params, method) => {
      if (method === "run") {
        await exec.run(sql, params as readonly unknown[]);
        return { rows: [] };
      }
      const { rows } = await exec.all(sql, params as readonly unknown[]);
      return { rows: method === "get" ? [...(rows[0] ?? [])] : rows.map((r) => [...r]) };
    },
    /* THE BATCH CALLBACK IS WHAT MAKES A TRANSACTION ONE CALL, and it is the SECOND argument —
       `drizzle(callback, batchCallback?, config?)`. Passed third (beside an `undefined` config) it
       is read as the config, which has no member in common with a function, and the store then
       issues `BEGIN`, the statements and `COMMIT` separately: any other work interleaving between
       them is the "cannot start a transaction within a transaction" refusal with one writer's rows
       lost. Measured against the driver's own overloads rather than assumed from the order the
       parameters are documented in. */
    async (queries): Promise<{ rows: unknown[] }[]> => {
      await exec.batch(queries.map((q) => ({ sql: q.sql, params: q.params as readonly unknown[] })));
      return queries.map(() => ({ rows: [] }));
    },
  );

  const branded = brandDialect(oneTransactionAtATime(db, transactionWaitMs), "sqlite") as unknown as LocalDb;
  return {
    db: branded,
    dataDir: "",
    pgDataDir: "",
    timings: { pgliteOpenMs: 0, adoptBaselineMs: 0, migrateMs: 0, compactMs: 0 },
    // A write-ahead checkpoint is a PGlite concept the engine calls after a drain. On this store the
    // journal is the platform's and there is nothing for a caller to reclaim, so this answers zero
    // rather than pretending to have flushed something.
    checkpoint: async () => 0,
    close: async () => { await exec.close(); },
  };
}

/**
 * A `Logger` OVER THE PHONE'S ONE DIAGNOSTIC — the inverse of `log.ts#diagnosticFor`.
 *
 * `SidecarConfig` carries two faces of the same channel and they are not interchangeable:
 * {@link Diagnostic} is `(event, detail) => void` with the level derived from the event name, and
 * `Logger` states its level per line. The desktop builds ONE `createSidecarLogger()` and passes
 * both faces of it (`main.ts:311-312`, `main.ts:364`); this composition passed only the
 * `Diagnostic`, so `config.logger` was absent on a phone and every `log?.warn` / `log?.error` in
 * the shared sync loop optional-chained into nothing. What was lost is exactly the set of lines
 * that describe a write the mail server did NOT accept — a refused `STORE`, a `STORE` whose
 * bookkeeping did not commit, a read-state intent with nowhere to go. On the one install where the
 * local store is the only other witness, "your mailbox did not take this" was discarded.
 *
 * A phone has no second sink to build one against, so this DERIVES the second face from the one
 * the caller supplied rather than constructing a logger of its own. The consequence is that both
 * faces reach the same place — which is the desktop's arrangement too, one indirection earlier.
 *
 * ── WHAT EACH MEMBER ANSWERS, AND WHY IT IS NOT MORE ──────────────────────────────────────
 *
 *  · `child(fields)` MERGES and returns another of these. `withRequestId` calls it
 *    (`packages/api/src/middleware.ts:145`), so a stub returning itself would silently drop the
 *    bindings, and one that threw would take a request down.
 *  · `level` says `info`, and `debug()` is therefore a no-op rather than an `info` line. A logger
 *    that names a level and then emits below it is lying about its own filter, and the field is
 *    read by callers deciding whether to build an expensive detail object.
 *  · `warn` and `error` both go to the `Diagnostic`. It re-derives a level from the event name
 *    (`ERROR_EVENT` — `_failed`, `_fatal`, `_unavailable`), so a warning about `store_refused`
 *    lands as `info` on the phone's own sink. That is the existing vocabulary rule and this does
 *    not fork it; `level` rides in the FIELDS so the original severity survives in the line.
 */
export function loggerOver(log: Diagnostic, bound: LogFields = {}): Logger {
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    log(event, { ...bound, ...fields, level });
  };
  return {
    level: "info",
    child: (fields: LogFields): Logger => loggerOver(log, { ...bound, ...fields }),
    /* Below `level`. See the note above: the alternative is a line the logger's own filter says
       it did not emit. */
    debug: (): void => undefined,
    info: (event, fields) => { emit("info", event, fields); },
    warn: (event, fields) => { emit("warn", event, fields); },
    error: (event, fields) => { emit("error", event, fields); },
  };
}

/**
 * START THE ENGINE IN THIS RUNTIME. The phone's `main()`.
 *
 * @throws when a host-only knob is present, when `machineName` or `installId` is empty, or when a
 * key ring entry is not 64 hex characters. All three refuse BEFORE the store is touched: a
 * composition that is wrong about who it is should not have written anything.
 */
export async function startPhoneEngine(deps: PhoneEngineDeps): Promise<PhoneEngine> {
  const bag = deps as unknown as Record<string, unknown>;
  const present = HOST_ONLY_KEYS.filter((k) => bag[k] !== undefined);
  if (present.length > 0) {
    throw new Error(
      `this build has no host door, so it cannot accept ${present.join(", ")}. A phone organizes ` +
        "its own mailbox and never serves one to another device; the modules that would answer " +
        "these knobs are not in this artifact at all. Refused rather than disarmed silently, so a " +
        "caller cannot believe it has a door it has not got.",
    );
  }
  if (deps.machineName.trim() === "") {
    throw new Error(
      "machineName is required: it is the name every other install shows for the holder of this " +
        "mailbox, and this build has no machine name of its own to fall back to",
    );
  }
  if (deps.installId.trim() === "") {
    throw new Error(
      "installId is required: the lease tells two installs apart by it, and an empty one would " +
        "make this phone and any restored copy of it read as a single organizer",
    );
  }
  const keks = deps.keks ?? {};
  for (const [version, hex] of Object.entries(keks)) {
    if (!KEK_HEX_RE.test(hex)) {
      // The VERSION, never the value.
      throw new Error(`the key ring's version ${version} is not a 32-byte key in hex`);
    }
  }

  /* ONE DIAGNOSTIC, handed to the engine AND to the launch catch below. Two would be two places a
     caller has to wire up, and the one that gets forgotten is the one that swallows the only
     record of a mailbox that never came up. */
  const log: Diagnostic = deps.log ?? ((): void => undefined);

  const store = await openPhoneStore(deps.exec);
  const sidecar = await createSidecar({
    dataDir: deps.dataDir ?? "",
    /**
     * THE PHONE'S SOCKET DEADLINE IS THE COMPOSITION'S, AND IT IS THE WORKER'S NUMBER.
     *
     * The engine's default profile documents itself as chosen against a sixty-second serverless
     * invocation ceiling — a 25 s socket deadline for a connection that is opened, used and thrown
     * away inside one request. This connection is nothing like that: it is held for as long as the
     * app is in the foreground, and a single fetch pass over a couple of hundred messages was
     * measured at 42 s on a device. Under the serverless profile that pass is a dead socket, and
     * what a person sees is a mailbox that never finishes opening.
     *
     * `WORKER_NET_TIMEOUTS` is the profile that already exists for exactly this shape, with
     * exactly this reason written on it, and the worker passes it the same way — INSIDE the config
     * object, which flows through the seed mailbox's dial to the adapter with no engine change at
     * all. A third profile would be a third number to keep in step with two others.
     *
     * A caller that supplies its own timeouts WINS, so this is a default rather than an override.
     */
    imap: { ...deps.imap, timeouts: deps.imap.timeouts ?? WORKER_NET_TIMEOUTS },
    ...(deps.address !== undefined ? { address: deps.address } : {}),
    machineName: deps.machineName,
    installId: deps.installId,
    organizerKind: deps.organizerKind ?? "mobile",
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    /* BOTH FACES OF THE ONE CHANNEL, spread on the same condition — see {@link loggerOver}. A
       caller that supplies no `log` gets neither, which keeps the pre-existing shape for the many
       compositions that pass nothing (`exactOptionalPropertyTypes` wants absence, not
       `undefined`); a caller that supplies one gets the sync loop's diagnostics too. */
    ...(deps.log ? { logger: loggerOver(deps.log) } : {}),
    ...(deps.adapterFactory ? { adapterFactory: deps.adapterFactory } : {}),
    // Hex to bytes happens HERE and nowhere else: `Buffer` is bound in this bundle by the builder's
    // `inject`, and the app-side code that reads the keystore has no such global.
    ...(Object.keys(keks).length > 0
      ? { keks: Object.fromEntries(Object.entries(keks).map(([v, hex]) => [Number(v), Buffer.from(hex, "hex")])) }
      : {}),
    // The store, already open. This is the line the whole file exists for.
    store: async () => store,
    /* See {@link phoneOneClickPost}: refused by name, so the failure is about the person's mail
       rather than about a missing Node module. */
    oneClickPost: phoneOneClickPost,
  });

  /**
   * THE ENGINE STARTS ITSELF. Nobody outside has to remember to.
   *
   * `main.ts` is the desktop's composition root and it does exactly this, on the line after the
   * engine is built. This file did not, and it exposed no way to do it either — so a phone booted,
   * answered its door, reported `organizing: true`, and synchronised nothing for ever, with no
   * diagnostic anywhere. Every part worked; the launch was simply never made.
   *
   * NOT a `start()` member on {@link PhoneEngine}. A door that must remember to call something is
   * the built-tested-unreachable shape this whole composition exists to close, and it would have
   * put "does this install organize its mailbox?" in the app rather than in the engine.
   *
   * `void` and a catch, not an `await`: the handle is usable the moment this function resolves,
   * which is the desktop's own "door before mailbox" order. A launch that fails is not fatal — the
   * runtime arms its poll on the way out and `wake()` re-dials when the app returns to the
   * foreground — and it is VISIBLE without a logger, because the failure marks the connection dead
   * and {@link PhoneEngine.runtimes} reports the row rather than the gate's optimism.
   *
   * This is a READ. Nothing moves before the lease is consulted; the dial and the gate are the
   * engine's own, unchanged.
   */
  void sidecar.start().catch((err: unknown) => {
    log("mailbox_start_failed", {
      err,
      reason: "the mailbox did not come up; the engine keeps serving the local store and the " +
        "poll will re-dial",
    });
  });

  return {
    handle: (req) => sidecar.handle(req),
    sessionToken: sidecar.sessionToken,
    wake: () => sidecar.wake(),
    runtimes: () => ({ organizer: sidecar.organizerStates(), connection: sidecar.connectionStates() }),
    stop: () => sidecar.stop(),
  };
}
