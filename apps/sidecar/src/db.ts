import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { mailSchema } from "@trafficflow/db/mail";
import { MAIL_JOURNAL, adoptBaseline } from "@trafficflow/db/journal";
import type { Diagnostic } from "./log.js";

/**
 * THE LOCAL MIRROR: PGlite ON DISK, migrated by the SAME sequence production runs — over the
 * MAIL HALF, and only the mail half.
 *
 * PGlite is the sidecar's store precisely because it takes the same Drizzle journal, so it gets
 * the same schema. That is what makes the "one pipeline implementation" argument true — here
 * **narrowed to the half a mailbox is made of.**
 * The same MAIL journal, the same MAIL schema; the Cloud half never runs here and never ships.
 *
 * ── WHY THE CLOUD PASS WAS REMOVED, AND WHY NOTHING CAUGHT IT ─────────────────────────────
 *
 * This loop used to walk `JOURNALS` — mail then cloud — because that is what production does.
 * Two consequences, both invisible to every test in the repository:
 *
 *  1. **Every desktop install minted the Cloud schema locally.** The hosted credential store, the
 *     billing ledger, the subscription table, the staff directory and fifteen more, created in a
 *     database belonging to somebody who has no account with us, cannot log in, is not billed and
 *     has no operator. A table nobody writes is not harmless when its NAME is the disclosure.
 *  2. **It put the Cloud journal's SQL inside the shipped application.** The migrator reads
 *     `.sql` files off disk at runtime, so `drizzle-cloud/`'s eight files — the identity ceremony,
 *     Stripe, the credit ledger, the admin console's staff tables — would have had to be packaged
 *     beside the engine to make this line work at all. Readable text, the private half, in a
 *     public download.
 *
 * **A bundler cannot see either one.** Both journals are read through `node:path` at runtime, so
 * they are not esbuild inputs: a bundle-input census of the engine reports the private half at
 * zero while the artifact still has to carry it. That is why this is stated here, in the loop,
 * rather than trusted to a measurement.
 *
 * The mail journal is closed under itself by construction — a test over the journal asserts that
 * no mail statement names an object belonging to the Cloud half — so mail-alone, first, against an
 * empty database is exactly the case it was designed for.
 *
 * `adoptBaseline` is a no-op for a brand-new local database (it hits the `fresh` cell of its truth
 * table) and it is still called rather than skipped, for the same reason `testing.ts` calls it: a
 * code path only production takes is a code path nothing checks.
 *
 * Re-running this against a directory that already has the schema applies nothing. That is the
 * upgrade path for an installed desktop app — a new release ships new migrations and the first
 * launch replays only what is missing.
 *
 * ── CAVEAT WORTH WRITING DOWN NOW ──────────────────────────────────────────────────────────
 *
 * The on-disk format belongs to PGlite, not to us. A future PGlite major that changes it turns
 * every installed local mirror into a migration problem that no SQL journal can express. The
 * dependency is therefore pinned in `package.json`, and the honest answer if it ever moves is to
 * rebuild the mirror by re-syncing. Everything in the local database is reconstructible from IMAP
 * EXCEPT the decisions that have no representation on the server — rules, triage state and
 * Resurface timers, Screener verdicts, contacts and notes, snippets, workflows. Those are the only
 * rows a rebuild would actually lose, and preserving them across such a move is not handled here.
 */

export type LocalDb = PgliteDatabase<typeof mailSchema>;

/**
 * WHAT OPENING THE MIRROR COST, in wall-clock milliseconds, split by phase.
 *
 * Returned rather than logged, because {@link openLocalDb} has no logger and giving it one would
 * put a second diagnostic seam in a function whose whole job is a database handle. The two
 * constructors that call it own the line — see `engine.ts` and `cloud-engine.ts`'s `boot_phases`.
 *
 * `Date.now()` and not `performance.now()`, matching the drain timing in `engine.ts` and the
 * mailbox-attach phases the server-side sync reports: these are multi-second quantities read by a
 * human, and one clock across the codebase is worth more here than sub-millisecond resolution.
 *
 * The three sum to slightly less than the whole call — `mkdirSync`, the lock and the `drizzle()`
 * wrapper sit between them and are sub-millisecond — which is why the constructors also report
 * their own total rather than adding these up.
 */
export interface OpenTimings {
  /**
   * `new PGlite(dir)` to the moment it can answer a statement.
   *
   * On a large on-disk mirror this is where a cold launch spends its time: the WASM module is
   * instantiated, the data directory is mounted into the emulated filesystem, and Postgres runs
   * its own startup (including WAL replay if the previous exit was not clean).
   */
  pgliteOpenMs: number;
  /** {@link adoptBaseline} — a metadata read on an established mirror, a no-op on a fresh one. */
  adoptBaselineMs: number;
  /** The migrator. Zero new migrations still costs a read of the journal and of the ledger table. */
  migrateMs: number;
}

export interface OpenLocalDb {
  db: LocalDb;
  /** The ohmail directory the caller named. */
  dataDir: string;
  /** The PGDATA inside it — `<dataDir>/pgdata`. See {@link PGDATA_SUBDIR}. */
  pgDataDir: string;
  /** What this open cost, by phase. See {@link OpenTimings}. */
  timings: OpenTimings;
  /**
   * Take a write-ahead-log checkpoint now, returning how many segments it reclaimed. Runs on its own
   * interval while the database is open; exposed because a periodic side effect nothing can call is
   * a periodic side effect nothing can check. See {@link checkpointWal}.
   */
  checkpoint(): Promise<number>;
  /** Flush and release. Idempotent — shutdown paths call it from more than one place. */
  close(): Promise<void>;
}

/**
 * WHAT THE OPEN IS ABOUT TO SPEND ITS TIME ON, named before the work starts.
 *
 * `boot_phases` (the timings above) answers "where did the seconds GO" after the fact, for a log.
 * This answers "what is happening NOW", for a person watching the window — the two consumers want
 * the same facts at opposite ends of the wait, which is why both exist.
 *
 *  · `creating_store`  — no database yet. A first launch: initdb, then the full schema.
 *  · `replaying_wal`   — there is a database and a write-ahead log big enough that Postgres'
 *    recovery replay is the wait (a previous run ended without a checkpoint — a crash, a kill,
 *    a power loss). Bounded by the log's size, not the mailbox's.
 *  · `opening_store`   — the ordinary launch: an established database, nothing notable to replay.
 *  · `migrating`       — the schema ledger is being brought up to date. Sub-second except on the
 *    first launch after an upgrade that ships new migrations.
 */
export type LocalDbOpenPhase = "creating_store" | "replaying_wal" | "opening_store" | "migrating";

/**
 * A write-ahead log at least this large announces itself as `replaying_wal` rather than
 * `opening_store`.
 *
 * Recovery replay measured at roughly 200–300 MB/s on an ordinary disk, so this is about a second
 * of extra wait — below it the distinction is not worth a different sentence, above it the honest
 * word for what the launch is doing is "replaying". Well above the resting pool a healthy close
 * leaves behind (~64 MB), so an ordinary launch can never trip it.
 */
export const REPLAY_PHASE_BYTES = 256 * 1024 * 1024;

/** Everything optional about opening the local database. */
export interface OpenLocalDbOptions {
  log?: Diagnostic;
  /** How often to checkpoint while open. Production takes {@link CHECKPOINT_INTERVAL_MS}. */
  checkpointIntervalMs?: number;
  /**
   * Told which {@link LocalDbOpenPhase} the open is entering, just before it does. Best-effort
   * narration for a window that is waiting; never awaited and never load-bearing.
   */
  onPhase?: (phase: LocalDbOpenPhase) => void;
}

/**
 * PGlite gets a SUBDIRECTORY, not the directory the caller named.
 *
 * `initdb` refuses a data directory that already contains anything at all — a single sibling file
 * makes it `exit(1)` with no JavaScript error to catch, only a WASM abort. So the lock file (and
 * anything else that later needs to sit beside the database) lives in `<dataDir>/`, and PGlite owns
 * `<dataDir>/pgdata` exclusively.
 */
export const PGDATA_SUBDIR = "pgdata";

/** Raised when another process already holds this data directory. */
export class DataDirLockedError extends Error {
  constructor(readonly dataDir: string, readonly holder: string) {
    super(
      `the ohmail local database at ${dataDir} is already open by ${holder}. PGlite has no ` +
        "cross-process locking of its own, so two engines on one directory corrupt it. Close the " +
        "other instance, or delete the .lock file if that process is definitely gone.",
    );
    this.name = "DataDirLockedError";
  }
}

export const LOCK_FILE = "sidecar.lock";

/**
 * HOW OFTEN TO CHECKPOINT WHILE THE APP IS OPEN. See {@link checkpointWal} for why anything has to.
 *
 * Five minutes is Postgres's own `checkpoint_timeout` default — this is standing in for the process
 * that would have honoured it, so it keeps its number rather than inventing one.
 */
export const CHECKPOINT_INTERVAL_MS = 5 * 60_000;

/** WAL segment files in a data directory. `pg_wal` also holds `archive_status/`, which is not one. */
function walSegments(pgDataDir: string): number {
  try {
    return readdirSync(join(pgDataDir, "pg_wal")).filter((f) => /^[0-9A-F]{24}$/.test(f)).length;
  } catch {
    return 0;
  }
}

/** The write-ahead log's size in bytes — the bound on what a recovery replay costs. */
function walBytes(pgDataDir: string): number {
  try {
    const dir = join(pgDataDir, "pg_wal");
    let total = 0;
    for (const f of readdirSync(dir)) {
      if (/^[0-9A-F]{24}$/.test(f)) total += statSync(join(dir, f)).size;
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Which {@link LocalDbOpenPhase} the coming open is, read from the directory before PGlite touches
 * it. A pure look at the filesystem: it starts nothing and holds nothing, so a caller that only
 * wants the answer (a test, a diagnostic) can ask without paying for an open.
 */
export function openPhaseFor(dataDir: string): Exclude<LocalDbOpenPhase, "migrating"> {
  const pgDataDir = join(dataDir, PGDATA_SUBDIR);
  if (!existsSync(join(pgDataDir, "PG_VERSION"))) return "creating_store";
  if (walBytes(pgDataDir) >= REPLAY_PHASE_BYTES) return "replaying_wal";
  return "opening_store";
}

/**
 * CHECKPOINT, BECAUSE NOTHING ELSE WILL WHILE THE APP IS RUNNING.
 *
 * PGlite runs Postgres as a SINGLE-USER STANDALONE BACKEND — `pg_stat_activity.backend_type` says
 * so in as many words — and standalone means no postmaster, which means none of the background
 * processes exist: no checkpointer, no bgwriter, no autovacuum launcher. Both settings that are
 * supposed to bound `pg_wal` are instructions TO THE CHECKPOINTER: `max_wal_size` is the threshold
 * at which the WAL writer asks it for one, and `checkpoint_timeout` is the interval it wakes on.
 * With nobody to receive either, **no checkpoint is taken for as long as the process lives**, and
 * every segment ever written stays on disk. Measured: 200 MB of churn against a fresh PGlite left
 * `pg_control_checkpoint()` still naming initdb's redo segment, one 1 MB file per megabyte written.
 *
 * ── WHAT ALREADY WORKS, AND SO IS NOT DONE HERE ───────────────────────────────────────────────
 *
 * Two paths do checkpoint, and both were measured before this was written, because a redundant
 * checkpoint dressed up as a fix is worse than none. A clean `close()` runs Postgres's shutdown
 * checkpoint (170 segments → 64), and a start over a directory left by a CRASH runs the
 * end-of-recovery one (170 → 64 again). So the boundaries of a run are covered by Postgres itself
 * and there is deliberately no checkpoint at open or at close here.
 *
 * What neither covers is the MIDDLE of a run, and a desktop mail app is open for days. That is the
 * whole exposure: an install whose engine had been up for hours held tens of gigabytes of `pg_wal`
 * beside a database of a fraction the size, because nothing between the first write and the last
 * would ever reclaim a segment. So the interval is what is added, and nothing else.
 *
 * ── COST ──────────────────────────────────────────────────────────────────────────────────────
 *
 * An explicit `CHECKPOINT` is performed inline when there is no postmaster to hand it to, and it
 * does the whole job: the redo pointer advances and `RemoveOldXlogFiles` unlinks everything below
 * it beyond the `min_wal_size` pool. Measured at 77 ms to reclaim 131 MB, and near-instant when
 * there is nothing to reclaim, against a queue this shares with the app's own reads.
 *
 * It never throws at the caller. A database that cannot checkpoint is still a database that serves
 * mail, and the boundary checkpoints above remain as the backstop.
 */
async function checkpointWal(
  client: PGlite,
  pgDataDir: string,
  log: Diagnostic | undefined,
  stillOpen: () => boolean,
): Promise<number> {
  const began = Date.now();
  const before = walSegments(pgDataDir);
  try {
    await client.exec("CHECKPOINT;");
  } catch (err) {
    // A tick that fired just before the close is the ordinary way this throws, and a quit is not a
    // failure. `stillOpen` is read AFTER the await, which is the only moment that can tell the two
    // apart — checking before it would report the race as an error on every clean shutdown.
    if (!stillOpen()) return 0;
    log?.("local_db_checkpoint_failed", {
      err,
      reason: "the write-ahead log could not be checkpointed; the database is open and serving, " +
        "and the next attempt is one interval away",
    });
    return 0;
  }
  const dropped = before - walSegments(pgDataDir);
  // Only when it reclaimed something. A settled install checkpoints an almost empty log every few
  // minutes, and a line saying so each time is noise around the one occasion it is not.
  if (dropped > 0) {
    log?.("local_db_checkpointed", {
      dropped,
      totalMs: Date.now() - began,
      reason: "write-ahead log segments reclaimed; nothing else takes a checkpoint while this " +
        "process is running",
    });
  }
  return dropped;
}

/** Is `pid` a live process this user can see? `kill(pid, 0)` is the portable probe. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take an exclusive lock on the data directory, or refuse.
 *
 * `wx` is `O_CREAT|O_EXCL`, which is atomic: two processes racing here cannot both win. A lock
 * left behind by a crash names a pid, and a pid that is gone releases it — the alternative, a
 * lock that outlives the crash, means a user whose laptop lost power cannot open their mail.
 */
function lockDataDir(dataDir: string): () => void {
  const path = join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const raw = (() => {
        try {
          return readFileSync(path, "utf8").trim();
        } catch {
          return "";
        }
      })();
      const pid = Number.parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new DataDirLockedError(dataDir, `pid ${pid}`);
      // Stale (or unreadable): clear it and try exactly once more, so two processes both finding
      // it stale still resolve to one winner via the O_EXCL race above.
      rmSync(path, { force: true });
    }
  }
  throw new DataDirLockedError(dataDir, "another process that keeps re-taking the lock");
}

/**
 * Open (creating if needed) the local database at `dataDir` and bring its schema up to date.
 *
 * The returned handle is the PROCESS SINGLETON: the API deps and the sync loop share it. Two
 * PGlite instances on one directory corrupt it even inside one process, and two on one directory
 * across processes is what {@link lockDataDir} refuses.
 */
export async function openLocalDb(dataDir: string, opts: OpenLocalDbOptions = {}): Promise<OpenLocalDb> {
  const log = opts.log;
  mkdirSync(dataDir, { recursive: true });
  const unlock = lockDataDir(dataDir);
  const pgDataDir = join(dataDir, PGDATA_SUBDIR);
  let client: PGlite;
  try {
    // BEFORE `new PGlite`, because the whole point is to name the wait while it is happening —
    // and read from the directory rather than from PGlite, which says nothing until it is done.
    opts.onPhase?.(openPhaseFor(dataDir));
    const tOpen = Date.now();
    client = new PGlite(pgDataDir);
    // AWAITED HERE ON PURPOSE, AND IT CHANGES NOTHING EXCEPT WHERE THE COST IS ATTRIBUTED.
    //
    // `new PGlite()` returns before the database is usable — the WASM instantiation, the data
    // directory mount and Postgres' own startup are deferred behind `waitReady`, which the FIRST
    // statement then awaits implicitly. Without this line every millisecond of that lands inside
    // `adoptBaseline`, whose own work is one metadata read, and the phase breakdown below would
    // name the wrong phase. The total is identical either way: the same promise is awaited, once,
    // a few microseconds earlier.
    await client.waitReady;
    const pgliteOpenMs = Date.now() - tOpen;
    const db = drizzle(client, { schema: mailSchema });
    // ONE JOURNAL, and the loop is gone with the second one: a `for` over a one-element list is
    // an invitation to put the other element back. `adoptBaseline` still runs — it is a no-op on
    // a brand-new local database (the `fresh` cell of its truth table), and a code path only
    // production takes is a code path nothing checks.
    const tAdopt = Date.now();
    await adoptBaseline(db, MAIL_JOURNAL);
    const adoptBaselineMs = Date.now() - tAdopt;
    opts.onPhase?.("migrating");
    const tMigrate = Date.now();
    await migrate(db, {
      migrationsFolder: MAIL_JOURNAL.dir,
      migrationsSchema: MAIL_JOURNAL.migrationsSchema,
    });
    const migrateMs = Date.now() - tMigrate;
    let closed = false;
    const checkpoint = async (): Promise<number> =>
      (closed ? 0 : checkpointWal(client, pgDataDir, log, () => !closed));

    /* The checkpointer this database does not otherwise have. `unref` so it can never be the reason
       a process stays alive, and a fresh timer per tick rather than `setInterval` so a slow
       checkpoint cannot have a second one queued behind it. */
    const every = opts.checkpointIntervalMs ?? CHECKPOINT_INTERVAL_MS;
    let tick: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (closed) return;
      tick = setTimeout(() => {
        void checkpoint().finally(schedule);
      }, every);
      tick.unref?.();
    };
    schedule();

    return {
      db,
      dataDir,
      pgDataDir,
      timings: { pgliteOpenMs, adoptBaselineMs, migrateMs },
      checkpoint,
      close: async () => {
        if (closed) return;
        closed = true;
        if (tick) clearTimeout(tick);
        tick = null;
        try {
          // Postgres takes its own shutdown checkpoint here, which is why there is not one of ours.
          await client.close();
        } finally {
          unlock();
        }
      },
    };
  } catch (err) {
    unlock();
    throw err;
  }
}
