import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { onNotice } from "./notices.js";
import postgres, { type Sql } from "postgres";
import { adoptBaseline, adoptReissuedOriginals } from "./baseline.js";
import { assertNoActiveAddressDuplicates } from "./mailbox-dedup.js";
import { JOURNALS } from "./journal-specs.js";

/**
 * The journal SPECS — folders and pinned migrations tables — are pure data in `journal-specs.ts`,
 * a leaf with no server driver. Re-exported here so every host that runs a migration keeps a
 * single import, and so the desktop engine can reach the specs through `@trafficflow/db/journal`
 * WITHOUT this module — which pulls `postgres` and its dependency tree, none of which belongs in
 * a shipped engine that migrates via PGlite. Folders are composed with `node:path`, deliberately
 * NOT `new URL("../drizzle", import.meta.url)`: webpack treats that form as a static ASSET
 * reference and `next build` in `apps/api-vercel` failed with `Module not found`. `node:path` is
 * opaque to the bundler and identical at runtime.
 */
export {
  MAIL_MIGRATIONS_DIR, LEGACY_MIGRATIONS_DIR, CLOUD_MIGRATIONS_DIR,
  MAIL_JOURNAL, CLOUD_JOURNAL, JOURNALS,
} from "./journal-specs.js";

/**
 * The session-level advisory lock the whole two-pass migration runs under. It MUST NOT be the
 * worker's leader-election key: contending on `LEADER_LOCK_KEY` (+N per shard) would either block
 * behind a running worker forever or take the key a standby is waiting on and hand a second
 * process leadership on release. This key sits 9000 above the leader band, which no plausible
 * shard count reaches; `migration-lock-key.test.ts` asserts the gap is real. A blocking
 * `pg_advisory_lock`, not `try`: two concurrent `db:setup:prod` invocations should SERIALIZE (the
 * second applies nothing — the idempotency proof), not fail. {@link MIGRATION_LOCK_TIMEOUT_MS}
 * keeps "blocking" from meaning "forever".
 */
export const MIGRATION_LOCK_KEY = 4207279001n;

/**
 * How long to wait for the migration lock before giving up, in ms.
 *
 * `lock_timeout` is set for the ACQUISITION ONLY and then reset to 0. That reset is not
 * tidiness: every DDL statement in the journal takes heavy table locks, and leaving a
 * `lock_timeout` in place would let a momentarily busy table abort a migration mid-pass.
 */
export const MIGRATION_LOCK_TIMEOUT_MS = 120_000;

/**
 * The session a setup took the migration lock on closed while the setup was still using it. A
 * session-level advisory lock dies with its backend, so nothing ran after the loss: re-run
 * `pnpm db:setup:prod`, every pass is idempotent.
 */
export class MigrationSessionLostError extends Error {
  constructor() {
    super(
      "the database session holding the migration lock was lost mid-setup, and the lock went " +
        "with it, so nothing further ran. Re-run 'pnpm db:setup:prod' — every pass is idempotent.",
    );
    this.name = "MigrationSessionLostError";
  }
}

/** A migration session: the guarded client, whether it was lost, and its own end. */
interface MigrationSession {
  readonly sql: Sql;
  lost(): MigrationSessionLostError | null;
  end(): Promise<void>;
}

/**
 * ONE CONNECTION FOR THE LOCK AND EVERYTHING DONE UNDER IT, NEVER REPLACED. postgres.js reopens
 * a closed connection on the next statement and recycles an idle one after 30-60 min on its own,
 * so a lost backend ran the rest of a setup without the lock and without this session's SETs.
 * Here a close after open marks the session lost and every later statement throws before it
 * reaches the driver. A transaction is BEGIN/COMMIT on this connection rather than postgres.js
 * `begin`, whose rollback after a lost backend writes to a closed socket and crashes the process.
 */
export async function openMigrationSession(url: string): Promise<MigrationSession> {
  let open = false;
  let ending = false;
  let lost: MigrationSessionLostError | null = null;
  const raw = postgres(url, {
    max: 1, onnotice: onNotice, max_lifetime: null,
    onclose: () => { if (open && !ending && lost === null) lost = new MigrationSessionLostError(); },
  });
  const refuse = (): void => { if (lost !== null) throw lost; };
  let guarded: Sql | undefined;
  const begin = async (...args: unknown[]): Promise<unknown> => {
    const fn = args[0];
    if (args.length !== 1 || typeof fn !== "function") {
      throw new Error("the migration session's begin takes one callback and no options");
    }
    refuse();
    await raw.unsafe("begin");
    try {
      const out: unknown = await (fn as (tx: Sql) => unknown)(guarded!);
      refuse();
      await raw.unsafe("commit");
      return out;
    } catch (err) {
      if (lost === null) await raw.unsafe("rollback").catch(() => undefined);
      throw lost ?? err;
    }
  };
  const unsupported = (name: string) => (): never => {
    throw new Error(`the migration session has no ${name}: everything runs on its one connection`);
  };
  guarded = new Proxy(raw, {
    apply: (target, self, args) => { refuse(); return Reflect.apply(target, self, args) as unknown; },
    get: (target, prop, receiver) => {
      if (prop === "unsafe") {
        return (...a: Parameters<Sql["unsafe"]>) => { refuse(); return target.unsafe(...a); };
      }
      if (prop === "begin") return begin;
      if (prop === "reserve" || prop === "savepoint" || prop === "listen" || prop === "end") {
        return unsupported(String(prop));
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  try {
    await raw`select 1`;
  } catch (err) {
    await raw.end({ timeout: 0 });
    throw err;
  }
  open = true;
  return {
    sql: guarded,
    lost: () => lost,
    // A lost connection keeps its dead statement referenced, and a graceful end would wait out
    // the whole timeout for it; there is nothing left to flush, so it is destroyed at once.
    end: async () => { ending = true; await raw.end({ timeout: lost === null ? 5 : 0 }); },
  };
}

/**
 * The mail pass committed and the cloud pass did not — reachable, and named here rather than
 * discovered in an incident. Two journals are two transactions, so a cloud failure leaves the
 * whole mail schema and a partial Cloud one. Shared-first makes that the RECOVERABLE direction:
 * re-running `runMigrations` is idempotent (the mail pass applies nothing, the cloud pass
 * resumes); `GET /health` answers 503 `schema_incomplete` while it lasts, because the cloud
 * SCHEMA_MARKERS are missing — the deployment reports the truth instead of serving requests that
 * would 500; and nothing in the mail half depends on the cloud half, so the reverse order would
 * have left an unusable database.
 */
export class PartialMigrationError extends Error {
  constructor(
    readonly journal: string,
    readonly applied: readonly string[],
    cause: unknown,
  ) {
    super(
      `the ${journal} migration pass FAILED after ${applied.join(" then ")} committed. The ` +
        `database is in a known, recoverable state: re-run 'pnpm db:setup:prod' — every pass is ` +
        `idempotent and the completed ones will apply nothing. Until the ${journal} pass ` +
        `completes, GET /health answers 503 schema_incomplete for this deployment, which is ` +
        `correct. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "PartialMigrationError";
    this.cause = cause;
  }
}

/**
 * Replay BOTH journals against `url`: adopt → mail → cloud, under one session advisory lock, on
 * one {@link openMigrationSession}. A LIBRARY function — production reaches it only through
 * `setupProdDatabase`; no caller can run half of it. `adopt` runs before each pass — without it
 * the mail pass would REPLAY 21 migrations over a database built by the single journal.
 * Deliberately NO CLI here: the old one accepted a POOLER URL, skipped `ensureSearchExtensions`
 * and verified nothing. The one entry point, `pnpm db:setup:prod`, pins the endpoint, migrates,
 * installs extensions and PROVES the properties. An unsafe shortcut beside the safe path will be
 * taken eventually; the fix is to not ship it.
 */
export async function runMigrations(
  url: string,
  opts: { log?: (msg: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? (() => {});
  const session = await openMigrationSession(url);
  const sql = session.sql;
  // postgres.js takes bigint params at runtime; its published types omit bigint, so the cast
  // keeps the 64-bit advisory-lock key EXACT while satisfying the compiler. Same treatment as
  // `apps/worker/src/leader-lock.ts`, for the same reason.
  const key = MIGRATION_LOCK_KEY as unknown as number;
  try {
    // `SET` is a utility statement and takes no bind parameters: postgres-js turns every template
    // `${}` into a placeholder, so the obvious tagged-template form emits `set lock_timeout = $1`
    // and the server answers `syntax error at or near "$1"`. Every migration then throws, and the
    // failure surfaces downstream as `relation "messages" does not exist` — pointing at the
    // schema rather than the one broken line. Third interpolation bite in this project
    // (Date-as-TEXT and an escaping aborted transaction were the others), all invisible to
    // PGlite. `unsafe` is correct here rather than a smell: the value is this module's own
    // constant, asserted a non-negative integer immediately before interpolation.
    if (!Number.isInteger(MIGRATION_LOCK_TIMEOUT_MS) || MIGRATION_LOCK_TIMEOUT_MS < 0) {
      throw new Error(`MIGRATION_LOCK_TIMEOUT_MS must be a non-negative integer`);
    }
    // Neutralize the role's server-side defaults before anything else on this session.
    // `setupProdDatabase` applies `ROLE_DEFAULT_TIMEOUTS` as `ALTER ROLE … SET`, which reaches
    // THIS connection too, before the advisory-lock call. Two live-tested consequences:
    // `statement_timeout` (55 s) would cut the `pg_advisory_lock` wait short of the 120 s
    // `MIGRATION_LOCK_TIMEOUT_MS` — a lock wait is one long statement to the server; and
    // `idle_in_transaction_session_timeout` (60 s) would end a long journal pass the moment a
    // statement left the connection briefly idle between drizzle calls, which the two-pass
    // migrator does routinely. Reset to 0 HERE, before the lock dance, so every later line keeps
    // meaning what its comments say regardless of the role default it runs against.
    await sql`set statement_timeout = 0`;
    await sql`set idle_in_transaction_session_timeout = 0`;
    await sql.unsafe(`set lock_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
    try {
      await sql`select pg_advisory_lock(${key})`;
    } catch (err) {
      if (session.lost() !== null) throw session.lost()!;
      throw new Error(
        `could not take the migration advisory lock (${MIGRATION_LOCK_KEY}) within ` +
          `${MIGRATION_LOCK_TIMEOUT_MS}ms — another migration is running against this database. ` +
          `Wait for it and re-run; both passes are idempotent. Cause: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Reset BEFORE any DDL: the journal's statements take heavy table locks and must not be
    // abortable by the acquisition timeout.
    await sql`set lock_timeout = 0`;
    try {
      const db = drizzle(sql);

      // Before any journal statement: refuse a database whose data 0021 would destroy. Mail 0021
      // opens with a dedup prelude that keeps the OLDEST duplicate and deletes the others'
      // credentials — "oldest" is not evidence of health, and the failure is silent. This is the
      // only place the rule can be corrected: 0021 is applied and unmodifiable, and an appended
      // entry runs AFTER it on the one population that matters, so only something before the
      // migrator can stop the deletion — the check REFUSES rather than repairs
      // (`mailbox-dedup.ts` carries the full argument and the operator's tool). The cost where it
      // does not apply: one catalog query on an indexed database, two on a virgin one — read from
      // the CATALOG, not `__drizzle_migrations`, so a database whose index was dropped by hand is
      // still checked.
      await assertNoActiveAddressDuplicates(db);

      const done: string[] = [];
      for (const spec of JOURNALS) {
        try {
          await adoptBaseline(db, spec, log);
          await migrate(db, { migrationsFolder: spec.dir, migrationsSchema: spec.migrationsSchema });
          // AFTER the pass: a journal entry that exists twice (an original plus its reissue)
          // owes the original's bookkeeping row wherever only the reissue could run — the
          // skipped-window population, whose watermark had already passed the original. See
          // `REISSUED_ORIGINALS` in baseline.ts for the one case and the whole argument.
          await adoptReissuedOriginals(db, spec, log);
        } catch (err) {
          const cause = session.lost() ?? err;
          if (done.length > 0) throw new PartialMigrationError(spec.name, done, cause);
          throw cause;
        }
        done.push(spec.name);
      }
    } finally {
      // A lost session has no lock to release, and asking would throw over the error on its way up.
      if (session.lost() === null) {
        await sql`select pg_advisory_unlock(${key})`.catch(() => {
          /* the lock dies with the session two lines below; a failed unlock must not mask a
           * migration error that is on its way up the stack. */
        });
      }
    }
  } catch (err) {
    // A partial pass already names the loss as its cause and keeps what committed before it.
    throw err instanceof PartialMigrationError ? err : session.lost() ?? err;
  } finally {
    await session.end();
  }
}
