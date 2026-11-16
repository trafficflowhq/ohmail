import postgres from "postgres";
import { runMigrations } from "@trafficflow/db/admin";
import { journalDrift } from "@trafficflow/db/testing";
import { checkoutKeyOf, checkoutRoot, databaseOf, isolatedDbName } from "./_isolateddb-name.js";
import { DB_URL } from "../../../packages/organizer/test/_workerdb.js";

// ─────────────────────────────────────────────────────────────────────────────
// A DEDICATED database per multi-account test file.
//
// Since that change the worker's production configuration has NO account filter: it serves
// EVERY enabled mailbox in its shard. The shared `trafficflow_test` database is a
// long-lived accumulator (thousands of mailbox rows and accounts from every previous
// run), so a no-filter worker pointed at it would try to open hundreds of IMAP
// connections and its `maxMailboxes` cap would truncate away the mailboxes the test
// just seeded. These tests therefore own an isolated database, which also makes the
// per-shard advisory lock (leader/standby) uncontended by the rest of the suite.
// ─────────────────────────────────────────────────────────────────────────────

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** This checkout's key, from the resolved test URL and this tree's own root. */
export function checkoutKey(): string {
  return checkoutKeyOf(databaseOf(DB_URL), checkoutRoot());
}

/**
 * THE RESET BUDGET — why the files below name a hook timeout instead of taking vitest's default.
 *
 * `truncateAll` empties 88 tables, and a worker e2e `beforeEach` runs it AFTER a case that started
 * a worker, so it also waits on the Postgres connections that worker is still letting go of. At
 * vitest's 10 s default `hookTimeout` that is not a comfortable margin, it is the whole budget:
 * measured on this machine, the reset cost 4.1 s per database before the single-statement TRUNCATE
 * above, so a file resetting two databases spent ~8.3 s of 10 s in the hook. Whether such a file
 * was green or red was therefore decided by scheduler load, and it failed as
 * `Hook timed out in 10000ms` on every case after the first worker case — which reads as a defect
 * in the code under test and is not one. It cost a release-blocking investigation on 2026-09-06,
 * where a lease test was reported as a product regression because the hook, not the assertion, was
 * what failed.
 *
 * The single-statement TRUNCATE took the reset to ~1.9 s per database; this budget is the second
 * half, so the margin no longer depends on how busy the machine is. It is NOT license for a slow
 * hook: a reset that genuinely hangs still fails, later and just as red, and the census in
 * `isolated-db-hook-budget.test.ts` is what keeps a new file from silently taking the default
 * again.
 */
export const ISOLATED_DB_RESET_BUDGET_MS = 60_000;

/** `datconnlimit = -2` is Postgres 16's mark for a database whose `DROP` was interrupted. */
type DbState = "absent" | "present" | "invalid";

async function databaseState(admin: ReturnType<typeof postgres>, name: string): Promise<DbState> {
  const rows = await admin`SELECT datconnlimit FROM pg_database WHERE datname = ${name}`;
  if (rows.length === 0) return "absent";
  return Number((rows[0] as { datconnlimit: number }).datconnlimit) === -2 ? "invalid" : "present";
}

/**
 * DROP, then READ THE ROW BACK — a drop that was cut short leaves it INVALID, not absent.
 *
 * The role carries `statement_timeout = 55s` and `lock_timeout = 30s` as SERVER-SIDE session
 * defaults (`ROLE_DEFAULT_TIMEOUTS`, and `runMigrations` clears them for the same reason), and one
 * that interrupts `DROP DATABASE` leaves `pg_database.datconnlimit = -2`. Every later connection
 * then fails as `cannot connect to invalid database` — for every lane, until somebody drops the
 * row by hand. Clearing both on this session is why it should not happen; reading the row back is
 * what makes that a measurement rather than a claim.
 */
async function dropDatabase(admin: ReturnType<typeof postgres>, name: string): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } catch (e) {
      last = e;
    }
    if (await databaseState(admin, name) === "absent") return;
  }
  throw new Error(
    `[isolateddb] ${name} survived three DROP attempts and is still on the cluster`
      + `${last instanceof Error ? `: ${last.message}` : ""}`,
  );
}

/**
 * THE STALE-DATABASE CHECK — why this fixture verifies a database it did not just create.
 *
 * These databases are long-lived: `prepareIsolatedDb` created them once, days ago, and every run
 * since has re-used them. `runMigrations` decides what to replay from the journal's `when`
 * (the folder millis), so a migration file EDITED IN PLACE — same `when`, new content — is
 * already recorded as applied and is never run again. The database then sits one column behind
 * this tree, for ever, and nothing says so.
 *
 * That is not hypothetical either. `0030_heartbeat_signals_alert_runs.sql` was amended four times
 * after it first ran here; one of those amendments added `worker_heartbeats.degraded_since`. The
 * isolated databases carried the pre-amendment `0030`, so the column was missing, so every
 * `writeHeartbeat` failed with `42703 undefined_column` — caught, logged `heartbeat_write_failed`
 * and otherwise ignored, because a beat is best-effort by design. With no heartbeat row, the
 * leader fence (`leaderStillOurs`) could not confirm this instance still led the shard, so EVERY
 * fenced lifecycle write was refused: `markMailboxSyncBlocked` returned false, and
 * `organizer-lease.e2e.test.ts` failed on the row never explaining itself. On 2026-09-06 that was
 * reported as a product regression in the organizer lease. Three layers of correct, defensive
 * behaviour composed into a failure that named the wrong component, and the database was a schema
 * older than the code the whole time.
 *
 * So drift is DETECTED rather than assumed away, and the detection itself is not this fixture's:
 * `journalDrift` in `@trafficflow/db/testing` is the one implementation, shared with the
 * SHARED-database entry points, and it answers only "is this database's schema the one this tree
 * declares". What to do about a yes is a POLICY, and there are two of them. This one is the
 * recreate policy: a database this fixture created for one test file IN THIS CHECKOUT is nobody
 * else's — which is true only because the name carries `checkoutKey()`. The shared
 * `trafficflow_test` cannot be dropped by whoever happens to notice, so its entry points refuse
 * instead — see `realPgAvailable` and, for the worker's own e2e door, `_workerenv.ts`.
 */

/**
 * THE ADMIN SESSION every CREATE and DROP here runs on. The role's own timeouts reach it as
 * session defaults, and one that cuts a `DROP DATABASE` leaves the row INVALID for every later
 * run on the cluster — so both are cleared before it is handed out. `options` exists for the
 * control that opens it with a timeout already set.
 */
export async function openAdmin(options: Parameters<typeof postgres>[1] = {}): Promise<ReturnType<typeof postgres>> {
  const admin = postgres(withDatabase(DB_URL, "postgres"), { ...options, max: 1 });
  await admin`set statement_timeout = 0`;
  await admin`set lock_timeout = 0`;
  return admin;
}

/** How many runs of one checkout may hold one logical database at once. */
export const RUN_SLOTS = 8;
const claimed = new Map<string, string>();
const slotHolders: ReturnType<typeof postgres>[] = [];

/**
 * THE NAME CARRIES THE RUN, not only the checkout. Two runs of one checkout at once would share
 * `isolatedDbName(logical, key)` and truncate or drop each other's database, so a run CLAIMS a slot:
 * a session advisory lock on the name, held on its own connection until the process ends. Slot 0
 * is the plain name, so a lone run re-uses what it made before; a concurrent run gets `_run<n>`.
 */
export async function claimRunSlot(logical: string, key: string): Promise<string> {
  const mine = claimed.get(logical);
  if (mine) return mine;
  for (let slot = 0; slot < RUN_SLOTS; slot++) {
    const name = isolatedDbName(slot === 0 ? logical : `${logical}_run${slot}`, key);
    const holder = postgres(withDatabase(DB_URL, "postgres"), { max: 1, idle_timeout: 0 });
    const [row] = await holder`select pg_try_advisory_lock(hashtextextended(${name}, 0)) as held`;
    if ((row as { held: boolean }).held) {
      claimed.set(logical, name);
      slotHolders.push(holder);
      return name;
    }
    await holder.end({ timeout: 5 });
  }
  throw new Error(`[isolateddb] ${RUN_SLOTS} runs of this checkout already hold ${logical} — refusing another`);
}

/** CREATE (once, or again after drift) + migrate + empty a dedicated database; returns its URL. */
export async function prepareIsolatedDb(logical: string): Promise<string> {
  const key = checkoutKey();
  const name = await claimRunSlot(logical, key);
  const url = withDatabase(DB_URL, name);
  const admin = await openAdmin();
  try {
    if (await databaseState(admin, name) === "invalid") {
      process.stderr.write(
        `[isolateddb] ${name} was left INVALID by an interrupted DROP — dropping it again\n`);
      await dropDatabase(admin, name);
    }
    if (await databaseState(admin, name) === "present") {
      const drift = await journalDrift(url);   // POLICY here: recreate.
      if (drift) {
        // FORCE, because this database's own previous run may still be letting go of a
        // connection; a drop that waits would turn a stale schema into a hung fixture.
        process.stderr.write(`[isolateddb] recreating ${name} (checkout ${key}): ${drift}\n`);
        await dropDatabase(admin, name);
      }
    }
    if (await databaseState(admin, name) === "absent") {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  await runMigrations(url);
  await truncateAll(url);
  return url;
}

/**
 * DROP the database this run holds for `logical`, and read the row back. Only a name this process
 * CLAIMED can be dropped here — the door never takes a name from its caller — and `adminOptions`
 * reaches the session before its timeouts are cleared, which is what the drop control needs.
 */
export async function dropIsolatedDb(logical: string, adminOptions: Parameters<typeof postgres>[1] = {}): Promise<"absent"> {
  const name = claimed.get(logical);
  if (!name) throw new Error(`[isolateddb] this run holds no database for ${logical} — nothing to drop`);
  const admin = await openAdmin(adminOptions);
  try {
    await dropDatabase(admin, name);
    const state = await databaseState(admin, name);
    if (state !== "absent") throw new Error(`[isolateddb] ${name} is ${state} after its DROP`);
    return state;
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Empty every application table (the drizzle journal excepted) so each test starts clean.
 *
 * ── A NOTE THAT BELONGS IN THE WORKER'S FIXTURE, ABOUT A GUARD IN packages/db ──
 *
 * Since that change, `credit_ledger` carries a statement-level `BEFORE UPDATE OR DELETE OR TRUNCATE`
 * guard that raises on any attempt to rewrite the money trail — and it did its job here,
 * aborting this reset and with it every worker e2e file. Emptying a scratch database between
 * tests is precisely the case the guard is not aimed at, so the fixture steps around it. The
 * guard itself is untouched; that it fires is asserted in packages/db's own suite
 * (`credits.pg.test.ts`, `migration-0018.roundtrip.test.ts`).
 *
 * ONE named trigger comes off, not `DISABLE TRIGGER USER` across every table. The blanket form
 * worked, but it made this file a worked example of how to switch the money-path guards off
 * wholesale — including the deferred `*_coupled` constraint triggers that keep the ledger and
 * the balance in agreement. Naming the single trigger keeps the demonstration honest and the
 * blast radius one line wide.
 *
 * It comes off before ANY table is truncated, and that ordering is the point: `CASCADE` reaches
 * `credit_ledger` through foreign keys from tables that are not themselves guarded, so a
 * disable-truncate-enable done one table at a time would still fire the guard the moment some
 * earlier table cascaded into it. The whole thing is one DO block, hence one transaction — if a
 * TRUNCATE throws, the re-enable is not skipped, the disable rolls back with it.
 *
 * ── ONE `TRUNCATE` NAMING EVERY TABLE, NOT 88 OF THEM IN A LOOP ────────────────────────────
 *
 * This used to be `FOREACH t IN ARRAY tables LOOP EXECUTE 'TRUNCATE TABLE %I CASCADE'`, and the
 * loop is what made this fixture a flake generator. Measured on this machine against the worker's
 * isolated databases (88 tables): the per-table loop costs 4149 ms, one statement naming all 88
 * costs 1898 ms. A `beforeEach` that resets TWO databases therefore spent ~8.3 s of vitest's 10 s
 * default `hookTimeout` doing nothing but truncating — a large share of the budget — so whether a file was
 * green or red was decided by scheduler load rather than by the code under test. It presented as
 * `Hook timed out in 10000ms` on every case AFTER the first worker case, which reads as a defect
 * in the thing under test and is not one; `release-stranded-claim.test.ts` hit the same wall and
 * bought its way out with a per-file 60 s hook, which cures that file and leaves the cost.
 *
 * One statement is also strictly SAFER than the loop it replaces: Postgres takes the
 * `ACCESS EXCLUSIVE` locks for all 88 relations in one deterministic pass, where 88 separate
 * statements acquire them one at a time and can interleave with another connection's ordering.
 * `CASCADE` stays even though every table is named — a table added later that is referenced by a
 * named one must still be reachable, and the whole point of the sweep is that it needs no list. */
export async function truncateAll(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => { /* TRUNCATE … CASCADE is chatty */ } });
  try {
    await sql.unsafe(`
      DO $$
      DECLARE tables text;
      DECLARE has_ledger boolean;
      DECLARE has_staff_audit boolean;
      BEGIN
        SELECT string_agg(quote_ident(tablename), ', ') INTO tables FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT LIKE '\\_\\_drizzle%';
        IF tables IS NULL THEN RETURN; END IF;

        has_ledger := to_regclass('public.credit_ledger') IS NOT NULL;
        IF has_ledger THEN
          ALTER TABLE credit_ledger DISABLE TRIGGER credit_ledger_append_only;
        END IF;
        -- Cloud 0047's staff audit refuses TRUNCATE by trigger; a test reset is the one caller.
        has_staff_audit := to_regclass('public.staff_audit_events') IS NOT NULL;
        IF has_staff_audit THEN
          ALTER TABLE staff_audit_events DISABLE TRIGGER staff_audit_events_no_truncate;
        END IF;

        EXECUTE format('TRUNCATE TABLE %s CASCADE', tables);

        IF has_ledger THEN
          ALTER TABLE credit_ledger ENABLE TRIGGER credit_ledger_append_only;
        END IF;
        IF has_staff_audit THEN
          ALTER TABLE staff_audit_events ENABLE TRIGGER staff_audit_events_no_truncate;
        END IF;
      END $$;
    `);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
