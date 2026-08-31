import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { onNotice } from "./notices.js";
import postgres from "postgres";
import { adoptBaseline, adoptReissuedOriginals } from "./baseline.js";
import { assertNoActiveAddressDuplicates } from "./mailbox-dedup.js";
import { JOURNALS } from "./journal-specs.js";

/**
 * The journal SPECS — folders and pinned migrations tables — are pure data and live in
 * `journal-specs.ts`, a leaf that imports no server driver. They are re-exported here so every
 * host that runs a migration keeps a single import (`@trafficflow/db/admin` → `./migrate.js`),
 * and so the desktop engine can reach the specs through `@trafficflow/db/journal` WITHOUT
 * reaching this module — which pulls `postgres`, the SOCKS client and the IP-address parser, none
 * of which belongs in a shipped, GPL-published engine that migrates via PGlite.
 *
 * Folders are composed with `node:path`, deliberately NOT `new URL("../drizzle", import.meta.url)`:
 * webpack treats that form as a static ASSET reference and `next build` in `apps/api-vercel` failed
 * with `Module not found: Can't resolve '../drizzle'`. `node:path` is opaque to the bundler and
 * identical at runtime.
 */
export {
  MAIL_MIGRATIONS_DIR, LEGACY_MIGRATIONS_DIR, CLOUD_MIGRATIONS_DIR,
  MAIL_JOURNAL, CLOUD_JOURNAL, JOURNALS,
} from "./journal-specs.js";

/**
 * The session-level advisory lock the whole two-pass migration runs under.
 *
 * **It MUST NOT be the worker's leader-election key.** `apps/worker/src/leader-lock.ts` holds
 * `LEADER_LOCK_KEY = 4207270001n` for its single-active guarantee, and shard N holds
 * `LEADER_LOCK_KEY + N`. If migration contended on that key it would either block behind a
 * running worker forever or — worse — take the key a standby is waiting on and hand a second
 * process leadership the moment it released. This key sits 9000 above the leader band, which no
 * plausible shard count reaches, and `migration-lock-key.test.ts` asserts the two constants
 * differ and that the gap is real.
 *
 * Chosen as a blocking `pg_advisory_lock` rather than `pg_try_advisory_lock`: two concurrent
 * `db:setup:prod` invocations should SERIALIZE (the second then applies nothing, which is the
 * idempotency proof), not fail. {@link MIGRATION_LOCK_TIMEOUT_MS} keeps "blocking" from
 * meaning "forever".
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
 * The mail pass committed and the cloud pass did not.
 *
 * **This state is reachable and it is named here rather than discovered in an incident.** Before
 * the split all 24 entries applied inside ONE transaction. Two journals are two transactions, so
 * a cloud failure now leaves a database with the whole mail schema and a partial Cloud one.
 *
 * Shared-first is what makes that the RECOVERABLE direction:
 *
 *  · re-running `runMigrations` is idempotent — the mail pass finds its 21 rows and applies
 *    nothing, the cloud pass resumes where it stopped;
 *  · `GET /health` answers **503 `schema_incomplete`** while it lasts, because the cloud
 *    SCHEMA_MARKERS (`credit_ledger.source`, `worker_heartbeats.beat_at`, `waitlist.email`,
 *    `invites.code_hash`, `invites.revoked_at`) are missing — so the deployment reports the
 *    truth instead of serving requests that would 500 on a missing table;
 *  · nothing in the mail half depends on the cloud half, so the reverse order would have left
 *    an unusable database instead.
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
 * Replay BOTH journals against `url`: **adopt → mail → cloud**, under ONE session-level
 * advisory lock, on ONE `postgres(url, { max: 1 })` client. A LIBRARY function only — tests call
 * it directly, and production reaches it exclusively through `setupProdDatabase`.
 *
 * **No caller can run half of it**, and that is why the two passes live inside one function
 * rather than being exposed separately. A `runMailMigrations` sitting next to a
 * `runCloudMigrations` is an invitation to run one of them, and the failure mode of running only
 * the cloud pass on a virgin database is a journal whose foreign keys reference tables that do
 * not exist.
 *
 * `adopt` runs before each pass and is the safety net for every long-lived database in this
 * repository: the shared `trafficflow_test` accumulator and the worker's per-file databases were
 * all built by the single journal, so without adoption the mail pass would REPLAY 21 migrations
 * over a populated schema. See `baseline.ts` for why that replay is dangerous rather than merely
 * wrong (most of it succeeds silently). The pleasant consequence: **CI gets a fresh container and
 * exercises the virgin path; every laptop has the accumulator and exercises the adoption path.**
 *
 * There is deliberately **NO CLI on this module.** It used to expose one
 * (`pnpm --filter @trafficflow/db migrate`, reading a generic `DATABASE_URL`), and that
 * command was the green-but-dead provisioning defect with a bow on it: it accepted a POOLER URL, skipped
 * `ensureSearchExtensions`, and verified nothing — so an operator who reached for the
 * obvious-looking command got a database whose fuzzy search arm was dead while every test
 * in the repository stayed green. One provisioning entry point exists, `pnpm db:setup:prod`
 * (`setup-prod.ts`), which pins the endpoint, migrates, installs the extensions, and then
 * PROVES all five properties. An unsafe shortcut that sits next to the safe path will be
 * taken eventually; the fix is to not ship it.
 */
export async function runMigrations(
  url: string,
  opts: { log?: (msg: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? (() => {});
  const sql = postgres(url, { max: 1, onnotice: onNotice });
  // postgres.js takes bigint params at runtime; its published types omit bigint, so the cast
  // keeps the 64-bit advisory-lock key EXACT while satisfying the compiler. Same treatment as
  // `apps/worker/src/leader-lock.ts`, for the same reason.
  const key = MIGRATION_LOCK_KEY as unknown as number;
  try {
    // `SET` IS A UTILITY STATEMENT AND TAKES NO BIND PARAMETERS.
    //
    // postgres-js turns every `${}` in a tagged template into a placeholder, so the obvious
    // `sql`set lock_timeout = ${ms}`` emits `set lock_timeout = $1` and the server answers
    // `syntax error at or near "$1"`. Every migration then throws, no table is ever created,
    // and the failure surfaces downstream as `relation "messages" does not exist` — which
    // points at the schema rather than at the one line that actually broke.
    //
    // Third time this project has been bitten by postgres-js interpolation semantics (after
    // Date objects serialized as TEXT, and an aborted transaction escaping as a raw error),
    // and all three were invisible to PGlite. `set lock_timeout = 0` below survives only
    // because it interpolates nothing.
    //
    // `unsafe` is correct here rather than a smell: the value is this module's own constant,
    // never caller input, and it is asserted to be a non-negative integer immediately before
    // interpolation, so there is no injection surface to speak of.
    if (!Number.isInteger(MIGRATION_LOCK_TIMEOUT_MS) || MIGRATION_LOCK_TIMEOUT_MS < 0) {
      throw new Error(`MIGRATION_LOCK_TIMEOUT_MS must be a non-negative integer`);
    }
    // ── NEUTRALIZE THE ROLE'S SERVER-SIDE DEFAULTS, BEFORE ANYTHING ELSE ON THIS SESSION ──────
    //
    // `setupProdDatabase` applies `ROLE_DEFAULT_TIMEOUTS` (`client.ts`) as an `ALTER ROLE …
    // SET` — a Postgres session default, not a client-side option, so it reaches this
    // connection too and it reaches it BEFORE the advisory-lock call below, not after. Two
    // consequences, both live-tested:
    //
    //  · `statement_timeout` (55 s in `ROLE_DEFAULT_TIMEOUTS`) would cut the `pg_advisory_lock`
    //    call itself short of the 120 s `MIGRATION_LOCK_TIMEOUT_MS` this module already argues
    //    for — a lock WAIT is one long-running statement from the server's point of view, and a
    //    role default sized for a serverless request has no reason to fit a migration's own
    //    intended wait.
    //  · `idle_in_transaction_session_timeout` (60 s) would end a long journal pass the moment
    //    any one statement inside it left the connection briefly idle between drizzle calls,
    //    which the two-pass migrator's own transactions do routinely.
    //
    // Reset to 0 (unlimited) HERE, before the lock dance, so every later line in this function
    // keeps meaning what its own comments say it means, regardless of what role default exists
    // on the database it happens to run against.
    await sql`set statement_timeout = 0`;
    await sql`set idle_in_transaction_session_timeout = 0`;
    await sql.unsafe(`set lock_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
    try {
      await sql`select pg_advisory_lock(${key})`;
    } catch (err) {
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

      // ── BEFORE ANY JOURNAL STATEMENT: refuse a database whose data 0021 would destroy ──
      //
      // Mail `0021_mailbox_address_unique` opens with a dedup prelude that keeps the OLDEST
      // duplicate and deletes the others' credentials. "Oldest" is not evidence of health, and
      // the failure is silent: a stale `status='error'` row outranks the working replacement,
      // whose envelope-encrypted credentials are then gone and whose re-enable the new index
      // refuses. Production held zero duplicates when 0021 shipped, so nothing was harmed there.
      //
      // THIS IS THE ONLY PLACE THE RULE CAN BE CORRECTED. 0021 is applied and unmodifiable, and
      // a new journal entry cannot help: the migrator applies entries in `when` order, so
      // anything appended runs AFTER 0021 — including on the one population that matters, a
      // populated database that has not taken 0021 yet. Only something that runs before the
      // migrator can stop the deletion, so the check is here and it REFUSES rather than repairs.
      // `packages/db/src/mailbox-dedup.ts` carries the full argument and the operator's tool.
      //
      // The cost where it does not apply: ONE catalog query on an already-indexed database
      // (production, and every `*.pg.test.ts` against the shared accumulator), two on a virgin
      // one (the index probe, then "is there a `mailboxes.status` column at all"). Both
      // conditions are read from the CATALOG rather than from `__drizzle_migrations`, so a
      // database whose 0021 row exists but whose index was dropped by hand is still checked.
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
          if (done.length > 0) throw new PartialMigrationError(spec.name, done, err);
          throw err;
        }
        done.push(spec.name);
      }
    } finally {
      await sql`select pg_advisory_unlock(${key})`.catch(() => {
        /* the lock dies with the session two lines below; a failed unlock must not mask a
         * migration error that is on its way up the stack. */
      });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
