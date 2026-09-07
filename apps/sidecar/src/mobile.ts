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
import {
  createSidecar,
  type OrganizerState,
  type MailboxConnectionState,
  type SidecarImapConfig,
} from "./engine.js";
import type { LocalDb, OpenLocalDb } from "./db.js";
import type { Diagnostic } from "./log.js";

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

/** The knobs that only mean something on a machine that serves a door to another device. */
const HOST_ONLY_KEYS = ["hostMode", "hostOrigin", "hostPort", "hostAssetsDir", "lanBind"] as const;

const KEK_HEX_RE = /^[0-9a-f]{64}$/i;

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
 * the handle's own `transaction` method. Nested transactions (drizzle renders them as savepoints
 * on the transaction OBJECT, not on the handle) are inside the lock already and are untouched —
 * routing them through this would deadlock on the mutex their parent holds.
 *
 * The engine is UNCHANGED by this. It goes on calling `db.transaction(...)` exactly as it does
 * against the desktop's store, and the difference in what that store guarantees is absorbed here
 * rather than pushed into five thousand lines of composition.
 */
export function oneTransactionAtATime<T extends object>(db: T): T {
  const handle = db as T & {
    transaction?: (fn: unknown, config?: unknown) => Promise<unknown>;
  };
  const inner = handle.transaction;
  if (typeof inner !== "function") return db;
  let tail: Promise<unknown> = Promise.resolve();
  handle.transaction = function serialized(fn: unknown, config?: unknown): Promise<unknown> {
    const next = tail.then(
      () => inner.call(handle, fn, config),
      () => inner.call(handle, fn, config),
    );
    // The CHAIN swallows, the CALLER does not: one transaction's failure must not reject the next
    // caller's turn, and it still reaches whoever started it through `next`.
    tail = next.catch(() => undefined);
    return next;
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
export async function openPhoneStore(exec: PhoneSqlExecutor): Promise<OpenLocalDb> {
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

  const branded = brandDialect(oneTransactionAtATime(db), "sqlite") as unknown as LocalDb;
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

  const store = await openPhoneStore(deps.exec);
  const sidecar = await createSidecar({
    dataDir: deps.dataDir ?? "",
    imap: deps.imap,
    ...(deps.address !== undefined ? { address: deps.address } : {}),
    machineName: deps.machineName,
    installId: deps.installId,
    organizerKind: deps.organizerKind ?? "mobile",
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    // Hex to bytes happens HERE and nowhere else: `Buffer` is bound in this bundle by the builder's
    // `inject`, and the app-side code that reads the keystore has no such global.
    ...(Object.keys(keks).length > 0
      ? { keks: Object.fromEntries(Object.entries(keks).map(([v, hex]) => [Number(v), Buffer.from(hex, "hex")])) }
      : {}),
    // The store, already open. This is the line the whole file exists for.
    store: async () => store,
  });

  return {
    handle: (req) => sidecar.handle(req),
    sessionToken: sidecar.sessionToken,
    wake: () => sidecar.wake(),
    runtimes: () => ({ organizer: sidecar.organizerStates(), connection: sidecar.connectionStates() }),
    stop: () => sidecar.stop(),
  };
}
