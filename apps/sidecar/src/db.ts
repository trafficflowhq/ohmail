import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { uptime as osUptime } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PGlite, type Transaction as PgliteTransaction } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readMigrationFiles, type MigrationConfig, type MigrationMeta } from "drizzle-orm/migrator";
import { mailSchema } from "@trafficflow/db/mail";
import {
  MAIL_JOURNAL, adoptBaseline, adoptReissuedOriginals, ensureSearchExtensions, readJournalOf,
} from "@trafficflow/db/journal";
import {
  INGEST_FOLD_WAL_BYTES, brandDialect, dialect,
  type LogBounds, type LogMark,
} from "@trafficflow/db/dialect";
import { createStoreScheduler, currentStoreLane, scheduleStoreLanes, type StoreLaneCensus } from "./store-lanes.js";
import { LocalStoreFs } from "./pglite-transport.js";
import { keepIngestPlans } from "./pglite-plans.js";
import type { Diagnostic } from "./log.js";

/**
 * The local mirror: PGlite on disk, migrated by the SAME sequence production runs — over the MAIL
 * half, and only the mail half. PGlite is the store because it takes the same Drizzle journal, so
 * the "one pipeline" argument holds, narrowed to the half a mailbox is made of. The Cloud pass was
 * removed because it minted the Cloud schema locally (a credential store, billing ledger and staff
 * directory in a database belonging to somebody with no account) AND put the Cloud journal's `.sql`
 * inside the shipped app. A bundler cannot see either — both journals are read through `node:path` —
 * so this is stated in the loop, not trusted to a census. The mail journal is closed under itself (a
 * test asserts no mail statement names a Cloud object); re-running applies only what is missing.
 */

export type LocalDb = PgliteDatabase<typeof mailSchema>;

/**
 * THE SERVER'S SEARCH EXTENSIONS, LOADED INTO EVERY LOCAL STORE. PGlite ships both as contrib
 * modules; loaded, `hasTrgm` probes true and the substring and typo arms read the same trigram
 * indexes the server reads. ONE list: the opener and the test template's key read it. A store
 * whose indexes use an operator class from these must be opened with them from then on.
 */
export const LOCAL_STORE_EXTENSIONS = { pg_trgm, btree_gin } as const;

/**
 * THE INGEST'S OWN TRANSACTION DOES NOT WAIT FOR THE FLUSH — that transaction, and nothing else on
 * this database or any other (`local-store-durability.test.ts` says so, from both sides).
 *
 * It does NOT make the write asynchronous: the log is opened `O_DSYNC` ({@link WAL_SYNC_METHOD}),
 * so a kill takes what is in `wal_buffers`, not everything since the last checkpoint. It stops a
 * commit FORCING the partial page out, making the writes bigger and fewer, and an import is
 * bandwidth-limited by exactly that. The scope is the TRANSACTION: gone session-wide, a statement
 * dirtying hundreds of buffers pays the flush at every eviction instead, 2 474 ms against 77 ms.
 */
const INGEST_SYNCHRONOUS_COMMIT = "off";

/**
 * …AND ONE TRANSACTION IN EVERY THIS MANY STILL WAITS, BECAUSE SOMETHING HAS TO DRAIN THE LOG.
 *
 * With no walwriter and no checkpointer, a durable commit is the only thing that writes the log
 * out in bulk. Relax every transaction a drain opens and it makes none, so each eviction flushes
 * the log itself — one 8 KiB page a write where two fit, which is what an import is bound by.
 * Measured on one corpus: 8 439 bytes a write and 32.98 transactions a second without, 17 806 and
 * 56.90 with. It NARROWS what a kill takes, to this many transactions rather than everything in
 * `wal_buffers` — sixteen over the forty-four that reads the same census, for that reason.
 */
export const INGEST_DURABLE_COMMIT_EVERY = 16;

/**
 * HOW THE LOG IS WRITTEN, AND THE ONE PROPERTY THIS STORE'S DURABILITY RESTS ON.
 *
 * PGlite's emulated filesystem implements NO flush — 500 inserts issue 509 writes and zero
 * fsync-class calls, and an explicit `CHECKPOINT` issues 42 and zero — so nothing here is durable
 * because somebody flushed it. It is durable because Postgres' Linux default opens the log
 * `O_DSYNC` and the write itself reaches the disk. Change it and a rule, a draft or a send-lock
 * claim stops surviving a power loss while every test still passes, because a process kill leaves
 * the page cache intact. So the value is asserted at every open rather than assumed.
 */
const WAL_SYNC_METHOD = "open_datasync";

/** Thrown when the store would open with a log this build cannot vouch for. See {@link WAL_SYNC_METHOD}. */
export class ForeignWalSyncMethodError extends Error {
  constructor(readonly found: string) {
    super(
      `the local store would open with wal_sync_method = ${found}, not ${WAL_SYNC_METHOD}: this `
      + "store has no fsync behind it, so that descriptor is the whole of its durability and a "
      + "rule, a draft or a send-lock claim would stop surviving a power loss",
    );
    this.name = "ForeignWalSyncMethodError";
  }
}

/** Read it back from the server and refuse anything else — never from a config file. */
async function assertWalSyncMethod(client: PGlite): Promise<void> {
  const rows = await client.query<Record<string, string>>("show wal_sync_method");
  const found = String(Object.values(rows.rows[0] ?? {})[0]);
  if (found !== WAL_SYNC_METHOD) throw new ForeignWalSyncMethodError(found);
}

/**
 * Put {@link INGEST_SYNCHRONOUS_COMMIT} inside the ingest's transactions, in place on the client
 * this module constructed — so drizzle, the compaction pass and the checkpointer all reach the same
 * object, and one in {@link INGEST_DURABLE_COMMIT_EVERY} keeps the default so the log is drained.
 * `SET LOCAL` reverts at the commit, so the setting can never outlive the transaction that
 * asked for it, and the lane is read INSIDE the transaction because that is where the drain's async
 * context is live (`store-lanes.ts`). Unnamed work is interactive and keeps Postgres' default,
 * which covers the migrator, the compaction and every window read without depending on where in
 * this file the call sits.
 */
function relaxIngestCommits(client: PGlite): void {
  const inner = client.transaction.bind(client);
  /* Counted per STORE, not per drain: the cadence is about the log this one client writes. */
  let sinceDurable = 0;
  Object.defineProperty(client, "transaction", {
    configurable: true,
    writable: true,
    value: function relaxed<T>(cb: (tx: PgliteTransaction) => Promise<T>): Promise<T | undefined> {
      return inner(async (tx) => {
        if (currentStoreLane() === "ingest") {
          sinceDurable += 1;
          if (sinceDurable >= INGEST_DURABLE_COMMIT_EVERY) sinceDurable = 0;
          else await tx.exec(`set local synchronous_commit = ${INGEST_SYNCHRONOUS_COMMIT}`);
        }
        return cb(tx);
      });
    },
  });
}

/**
 * What opening the mirror cost, in wall-clock milliseconds, split by phase. Returned rather than
 * logged, because {@link openLocalDb} has no logger and giving it one would put a second diagnostic
 * seam in a function whose whole job is a database handle — the two constructors that call it own the
 * line (`engine.ts`, `cloud-engine.ts`'s `boot_phases`). `Date.now()`, not `performance.now()`,
 * matching the drain timing and the mailbox-attach phases: these are multi-second quantities read by
 * a human, and one clock across the codebase is worth more than sub-millisecond resolution. The
 * three sum to slightly less than the whole call (mkdir, the lock and the `drizzle()` wrapper sit
 * between them), which is why the constructors report their own total.
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
  /** {@link reclaimBodyBloat} — ~a millisecond of ANALYZE on a healthy store, minutes ONCE on a bloated one. */
  compactMs: number;
  /** {@link setUpLocalSearch} — the extensions plus any trigram index not built yet; once per index. */
  searchSetupMs: number;
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
   * What the schema upgrade was — how many ran, and which one paid. See {@link MigrationCensus}.
   *
   * `null` — and REQUIRED rather than optional, exactly as {@link laneCensus} is — for a store
   * this build does not migrate (the phone's, whose SQLite schema is the platform's). "Nothing was
   * pending" and "no migrator ran here" are different facts, and a boot line reading `0` for the
   * second would be a measurement nobody took.
   */
  migrations: MigrationCensus | null;
  /**
   * Take a write-ahead-log checkpoint now, returning how many segments it reclaimed. Runs on its own
   * interval while the database is open; exposed because a periodic side effect nothing can call is
   * a periodic side effect nothing can check. See {@link checkpointWal}.
   */
  checkpoint(): Promise<number>;
  /**
   * Take one only once the log has GROWN past {@link INGEST_FOLD_WAL_BYTES} since the last fold —
   * the gate the drain's per-cycle call goes through. See {@link walGrownSince} for the pointer it
   * reads and why it is the insert one.
   */
  foldIfLogGrew(): Promise<StoreFold>;
  /**
   * WHICH RUN OF THIS STORE THE ROWS BEHIND IT BELONG TO — see {@link readStoreGeneration}.
   *
   * Handed to the doors so every `/sync` cursor carries it and every read checks it. `null` for a
   * store that cannot lose a committed row (the phone's, the hosted Postgres): absent means "no
   * generation to state", which is a different answer from a generation that happens to be its
   * first, and only the second admits a cursor that names none.
   */
  storeGeneration: number | null;
  /**
   * The store's own memory in bytes — the WASM heap Postgres runs inside, which `heapUsed` cannot
   * see and `external` can only lump together with everything else off the JavaScript heap.
   *
   * A FLOOR, not a per-message cost: measured at a constant 202 MB from an empty store to a
   * large mirror, which is also the two private anonymous mappings (150 MB + 64 MB) a running
   * build shows in `/proc`. So a reading that GROWS with the mailbox is the finding.
   * `0` when the runtime exposes no heap; see {@link storeHeapBytes}.
   */
  storeBytes(): number;
  /**
   * How the one connection was shared between the mail coming in and everything else asking for
   * it — see `store-lanes.ts`. Cumulative since the open, so a caller reads it twice and
   * subtracts. Exposed because a scheduler nothing can read is a scheduler nothing can check.
   *
   * `null` — and REQUIRED rather than optional — for a store this build does not schedule (the
   * phone's, whose SQLite goes through the platform and has its own transaction gate). Absent and
   * "not scheduled" would be the same answer to a reader; this way every store has to say which.
   */
  laneCensus(): StoreLaneCensus | null;
  /**
   * Refresh the search's planner statistics, per table the arms read, when missing or stale — see
   * {@link analyzeSearchIfStale}. `true` when an ANALYZE ran. The phone's store answers `false`.
   */
  analyzeSearchIfStale(): Promise<boolean>;
  /** Flush and release. Idempotent — shutdown paths call it from more than one place. */
  close(): Promise<void>;
}

/**
 * PGlite's WASM heap, read from the runtime rather than inferred from `process.memoryUsage()`.
 *
 * Never throws and never guesses: `Module` is undefined until the WASM is instantiated and a
 * future PGlite may not expose `HEAPU8` at all, and both answer `0` — which reads as "not
 * available" on a log line, where a fabricated number would read as a measurement.
 */
function storeHeapBytes(client: PGlite): number {
  const heap = (client as unknown as { Module?: { HEAPU8?: { byteLength?: number } } }).Module?.HEAPU8;
  return typeof heap?.byteLength === "number" ? heap.byteLength : 0;
}

/**
 * What the open is about to spend its time on, named before the work starts. `boot_phases` (the
 * timings above) answers "where did the seconds GO" after the fact for a log; this answers "what is
 * happening NOW" for a person watching the window. `creating_store` — no database yet (a first
 * launch: initdb then the full schema); `replaying_wal` — a write-ahead log big enough that
 * Postgres' recovery replay is the wait (a previous run ended without a checkpoint), bounded by the
 * log's size not the mailbox's; `opening_store` — the ordinary launch; `migrating` — the schema
 * ledger being brought up to date, sub-second except on the first launch after an upgrade.
 */
export type LocalDbOpenPhase =
  | "creating_store" | "replaying_wal" | "opening_store" | "migrating"
  /**
   * `compacting_store` — {@link reclaimBodyBloat} decided the body table's dead space is worth a
   * rewrite and is running one. Minutes on the store that needs it, ONCE; never announced on a
   * healthy launch, whose bloat check is a millisecond of `ANALYZE` arithmetic.
   */
  | "compacting_store";

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

/**
 * How far the `migrating` phase has got — the second argument of {@link OpenLocalDbOptions.onPhase},
 * and the only phase that carries one.
 *
 * A SECOND ARGUMENT rather than a phase object, because the phase is a wire token with a
 * hand-written map at the far end (`BootStatus.tsx`) and four callers pass the narration
 * straight through: a function that ignores the extra value still satisfies the type, so the
 * shells that do not want it did not have to change.
 */
export interface MigrationProgress {
  /** Migrations finished. `0` before the first one, `pending` after the last. */
  applied: number;
  /** How many this open has to apply. Fixed before the first one runs, so it is a real total. */
  pending: number;
}

/** What the migrator did, for the boot line. See {@link SLOW_MIGRATION_MS}. */
export interface MigrationCensus {
  /** How many the journal owed this store when it opened. `0` on an ordinary launch. */
  pending: number;
  /** How many ran. Equal to `pending` unless the open threw. */
  applied: number;
  /** The one that cost the most, named — `null` when none ran. */
  slowest: { migration: string; ms: number } | null;
}

/**
 * A migration at least this slow earns a line of its own (`migration_applied`, naming its journal
 * tag and what it cost).
 *
 * An ordinary upgrade's whole pass is 25–43 ms, so the floor keeps the log at zero lines there and
 * only speaks where a person waited — a 1.2 GB store spent 3 min 58 s in one pass and the log
 * could name the pass, not the migration inside it.
 */
export const SLOW_MIGRATION_MS = 1_000;

/** Everything optional about opening the local database. */
export interface OpenLocalDbOptions {
  log?: Diagnostic;
  /** How often to checkpoint while open. Production takes {@link CHECKPOINT_INTERVAL_MS}. */
  checkpointIntervalMs?: number;
  /**
   * The {@link INGEST_FOLD_WAL_BYTES} window, injectable so a test can cross it in seconds rather
   * than by writing sixty-four megabytes of log.
   */
  ingestFoldWalBytes?: number;
  /**
   * Told which {@link LocalDbOpenPhase} the open is entering, just before it does. Best-effort
   * narration for a window that is waiting; never awaited and never load-bearing. `migrating`
   * arrives once per migration with its {@link MigrationProgress}, which is what lets the window
   * count instead of spin; every other phase arrives once with none.
   */
  onPhase?: (phase: LocalDbOpenPhase, progress?: MigrationProgress) => void;
  /** The {@link SLOW_MIGRATION_MS} floor, injectable so a test can drive both sides of it. */
  slowMigrationFloorMs?: number;
  /**
   * Run once the data directory's lock is held and before anything in it is read — the one place a
   * caller may remove files beside the database (the cloud door's owner check discards a foreign
   * mirror and its seal). Run before the lock, a second launch deleted a RUNNING engine's files and
   * was refused only afterwards. A throw releases the lock and fails the open.
   */
  underLock?: () => void;
  /**
   * TEST SEAM: open WITHOUT the search extensions — the store that refused them, which searches
   * through the ILIKE degrade. Only for a data directory that never had them.
   */
  withoutSearchExtensions?: true;
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
  /**
   * `remedy` REPLACES the default way out, and one refusal needs its own: a lock file that is
   * empty because another launch is a syscall away from writing its record clears by itself,
   * so telling that person to delete a file would be telling them to delete a live lock.
   * NOT a `readonly` field — `log.test.ts` holds this class to the two enumerable own
   * properties the redaction was written against.
   */
  constructor(readonly dataDir: string, readonly holder: string, remedy?: string) {
    super(
      `the ohmail local database at ${dataDir} is already open by ${holder}. PGlite has no ` +
        "cross-process locking of its own, so two engines on one directory corrupt it. " +
        (remedy ?? "Close the other instance, or delete the .lock file if that process is "
          + "definitely gone."),
    );
    this.name = "DataDirLockedError";
  }
}

export const LOCK_FILE = "sidecar.lock";

/**
 * WHICH RUN OF THIS STORE A CLIENT'S CURSOR BELONGS TO — `<dataDir>/store-generation.json`.
 *
 * A file and not a row, because it has to be readable BEFORE the database is and has to survive
 * the very transactions it is about. See {@link readStoreGeneration} for the whole argument.
 */
export const STORE_GENERATION_FILE = "store-generation.json";

/**
 * HOW OLD AN EMPTY LOCK FILE HAS TO BE before it is read as a crash rather than as a launch.
 *
 * A build that created the lock and wrote its record a statement later could be killed between
 * the two, and the empty file it left refuses every launch after it for ever. That window is two
 * adjacent syscalls; a minute is six orders of magnitude past it, so an empty lock this old is
 * not a launch in progress. It is also the wait the refusal below asks a person for, which is why
 * the number is the same one in both places.
 */
export const EMPTY_LOCK_STALE_AFTER_MS = 60_000;

/**
 * HOW OFTEN TO CHECKPOINT WHILE THE APP IS OPEN. See {@link checkpointWal} for why anything has to.
 *
 * Five minutes is Postgres's own `checkpoint_timeout` default — this is standing in for the process
 * that would have honoured it, so it keeps its number rather than inventing one.
 */
export const CHECKPOINT_INTERVAL_MS = 5 * 60_000;


/** What {@link OpenLocalDb.foldIfLogGrew} did, so a caller can count folds rather than calls. */
export interface StoreFold {
  /** Whether this call took a checkpoint. */
  folded: boolean;
  /** The log's growth since the last fold, or `null` when the pointer could not be read. */
  grewBytes: number | null;
  /** Segments reclaimed — {@link checkpointWal}'s answer, `0` when nothing folded. */
  dropped: number;
}

/**
 * The bloat gate: `message_bodies` is rewritten when its on-disk size exceeds this many times the
 * estimated live bytes AND the absolute floor below. Four is far above anything ordinary churn
 * produces and far below the measured pathology (see {@link reclaimBodyBloat}), so the check
 * cannot flap on estimation noise.
 */
export const BLOAT_COMPACT_RATIO = 4;
/**
 * …and never for less than a gigabyte of table. Below this the rewrite saves seconds of I/O per
 * year and costs a boot-time pause; above it the dead space is the reason the app feels slow.
 */
export const BLOAT_COMPACT_MIN_BYTES = 1024 * 1024 * 1024;

/**
 * How many rows the FALLBACK live-size read may touch when the page sample hits nothing.
 *
 * Sixty-four, and the number is a bound on a read rather than a statistical choice: each row
 * pulls its whole body out of TOAST, so this is the difference between "a few megabytes" and
 * "read the table". A page sample misses on exactly the shape where rows are few and large, so a
 * handful of them already describes the average well; where rows are many the 1 % sample lands
 * and this never runs.
 */
export const BLOAT_SAMPLE_ROWS = 64;

/**
 * THE SERVER'S SEARCH SETUP, RUN OVER THIS STORE after the migrator: the extensions, then every
 * trigram index `ensureSearchExtensions` names. A present index costs a catalog read; a missing
 * one is built once, here, before anything reads the handle. A store that refuses keeps serving:
 * search reads through the ILIKE degrade (slower, never narrower) and the refusal is logged.
 */
export async function setUpLocalSearch(db: LocalDb, log?: Diagnostic): Promise<void> {
  try {
    // Plain builds: nothing else holds this store while it opens, so a concurrent build buys nothing.
    await ensureSearchExtensions(db, { concurrently: false });
  } catch (err) {
    log?.("search_setup_failed", {
      err,
      reason: "the search extensions or their indexes could not be set up on this store; search "
        + "reads through the unindexed arms, and the next launch tries again",
    });
  }
}

/** The tables the search arms read, whose planner statistics the store keeps. */
export const SEARCH_STATISTICS_TABLES = ["messages", "message_search", "message_bodies", "folder_state"] as const;

/**
 * THE SEARCH'S PLANNER STATISTICS — what autovacuum keeps on the server and PGlite never does.
 * Per table the arms read, stale when it holds rows and has no column statistics (an index build
 * sets the row count and nothing else), or by the server's threshold read from a count, as PGlite
 * does not flush its pgstat counters: 50 + 10 % of its rows different since. Measured on a large
 * store, the page read up to a second with `messages` never analyzed. `true` when an ANALYZE ran.
 */
export async function analyzeSearchIfStale(client: PGlite): Promise<boolean> {
  try {
    const r = await client.query<{ t: string; n: number; rt: number; read: boolean }>(
      SEARCH_STATISTICS_TABLES.map((t) => `SELECT '${t}' AS t, (SELECT count(*) FROM public.${t})::int AS n,
         COALESCE((SELECT c.reltuples FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                    WHERE ns.nspname = 'public' AND c.relname = '${t}'), -1)::float8 AS rt,
         EXISTS (SELECT 1 FROM pg_stats s WHERE s.schemaname = 'public' AND s.tablename = '${t}') AS read`).join(" UNION ALL "),
    );
    const stale = r.rows.filter(({ n, rt, read }) =>
      n > 0 && (!read || rt < 0 || Math.abs(n - rt) > 50 + 0.1 * Math.max(rt, 0)));
    for (const { t } of stale) await client.exec(`ANALYZE public.${t}`);
    return stale.length > 0;
  } catch {
    return false;
  }
}

/**
 * Reclaim the body table's dead space, when — and only when — it dominates the table. On a real
 * install (2026-08-21) `message_bodies` held ~1.6 GB of content in 21 GB on disk: dead tuples from a
 * since-fixed defect (the body walk re-upserted every body per poll), and PGlite runs single-user
 * with no autovacuum, so the space was never reclaimed — one launch spent 80.8 s inside `new
 * PGlite()` alone. Plain `VACUUM` cannot return the space, so the repair is `VACUUM FULL`: a rewrite,
 * exclusive-locked, minutes for gigabytes, run at BOOT behind its own phase and only when the gate
 * says the table is mostly dead. Live bytes are an UPPER-bound estimate, the gate a 4× ratio with a
 * 1 GB floor, and it refuses to run on a statistic it lacks — a wrong "yes" is minutes of lock.
 */
export async function reclaimBodyBloat(
  client: PGlite,
  log?: Diagnostic,
  onPhase?: (phase: LocalDbOpenPhase) => void,
  /** Test seam. The shipped paths never pass it, so the two constants are what every install runs. */
  gate: { minBytes?: number; ratio?: number } = {},
): Promise<{ ran: boolean; beforeBytes: number; afterBytes: number }> {
  const minBytes = gate.minBytes ?? BLOAT_COMPACT_MIN_BYTES;
  const ratio = gate.ratio ?? BLOAT_COMPACT_RATIO;
  const none = { ran: false, beforeBytes: 0, afterBytes: 0 };
  try {
    await client.exec(`ANALYZE message_bodies`);
    const measure = async (): Promise<{ bytes: number; rows: number }> => {
      const r = await client.query<{ bytes: string; rows: string }>(
        `SELECT pg_total_relation_size(c.oid)::text AS bytes, greatest(c.reltuples, 0)::bigint::text AS rows
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         WHERE c.relname = 'message_bodies'`,
      );
      const row = r.rows[0];
      return row ? { bytes: Number(row.bytes), rows: Number(row.rows) } : { bytes: 0, rows: 0 };
    };
    const before = await measure();
    // The cheap short-circuit FIRST: below the floor no estimate is worth computing, and this is
    // what keeps a healthy launch at one ANALYZE plus one catalog read.
    if (before.bytes < minBytes) return { ...none, beforeBytes: before.bytes, afterBytes: before.bytes };
    /* The live estimate is a sampled `octet_length`, not `pg_stats.avg_width`. `avg_width` was first
     * and RE-FIRED: on the measured store it answered 72.9 MB for 1.6 GB of TOASTed content (the
     * statistic reflects the datum header, not the out-of-line bytes), so a freshly compacted ~1.0
     * GiB table read as 14× bloated and the rewrite would run every launch — a one-time repair turned
     * into a sixty-second boot tax. A 1% page sample of the actual `octet_length` is the uncompressed
     * content per row, so `reltuples × avg` is an upper bound of the live bytes and the ratio cannot
     * undercount. Verified: 21.0 GiB fires (> 4 × ~1.7 GiB); its 0.96 GiB rewrite never fires again. */
    const sampled = await client.query<{ avg: string | null }>(
      `SELECT avg(octet_length(text) + coalesce(octet_length(html), 0))::bigint::text AS avg
       FROM message_bodies TABLESAMPLE SYSTEM (1)`,
    );
    /* A sample that hit no rows is not a measurement of zero, and the difference is a rewrite. `avg`
     * is NULL when the 1% page sample landed on no live tuple, and reading that as 0 makes the
     * estimate `128 × reltuples` — small enough that any table past the floor looks mostly dead. It
     * is not exotic, it is the HEALTHY shape of this table: TOASTed bodies put hundreds of megabytes
     * behind a handful of heap pages, which a 1% sample routinely misses. `reltuples <= 0` is the
     * same failure from the other side (an ANALYZE that did not land leaves -1). Both DECLINE, the
     * only safe direction — a wrong "yes" is a minutes-long exclusive rewrite of the only copy,
     * repeated every launch. The next boot samples again. */
    let avgRaw = sampled.rows[0]?.avg;
    if (avgRaw == null) {
      /* THE BOUNDED EXACT READ, for the table shape a page sample cannot see. Capped at
         {@link BLOAT_SAMPLE_ROWS} rows so the read is bounded even when every body is megabytes,
         and biased toward the first pages — which is fine for an ESTIMATE feeding a 4× gate, and
         is the only alternative to either declining for ever or trusting a zero. */
      const exact = await client.query<{ avg: string | null }>(
        `SELECT avg(octet_length(text) + coalesce(octet_length(html), 0))::bigint::text AS avg
         FROM (SELECT text, html FROM message_bodies LIMIT ${BLOAT_SAMPLE_ROWS}) t`,
      );
      avgRaw = exact.rows[0]?.avg ?? null;
    }
    if (avgRaw == null || before.rows <= 0) {
      log?.("store_compact_unmeasurable", {
        beforeBytes: before.bytes,
        reason: "how much of this table is live could not be measured, so it is left alone and the " +
          "next launch measures again",
      });
      return { ...none, beforeBytes: before.bytes, afterBytes: before.bytes };
    }
    const avgRowBytes = Number(avgRaw);
    const liveEstimate = before.rows * (avgRowBytes + 128);
    if (before.bytes <= ratio * Math.max(liveEstimate, 1)) {
      return { ...none, beforeBytes: before.bytes, afterBytes: before.bytes };
    }
    onPhase?.("compacting_store");
    // WHICH table is in the reason sentence, fixed — the census keeps free identifiers off lines.
    log?.("store_compacting", {
      beforeBytes: before.bytes, liveEstimateBytes: liveEstimate,
      reason: "message_bodies is mostly dead space; rewriting it once so every later read stops paying for it",
    });
    const t = Date.now();
    await client.exec(`VACUUM FULL message_bodies`);
    const after = await measure();
    log?.("store_compacted", {
      beforeBytes: before.bytes, afterBytes: after.bytes, totalMs: Date.now() - t,
    });
    return { ran: true, beforeBytes: before.bytes, afterBytes: after.bytes };
  } catch (err) {
    log?.("store_compact_failed", {
      err,
      reason: "the bloat check or rewrite failed; the mirror keeps serving and the next launch retries",
    });
    return none;
  }
}

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

/** The migrator config both paths below take — the mail journal's folder and its pinned table. */
const MAIL_MIGRATION_CONFIG = {
  migrationsFolder: MAIL_JOURNAL.dir,
  migrationsSchema: MAIL_JOURNAL.migrationsSchema,
};

/**
 * The migrator, reachable ONE MIGRATION AT A TIME — `drizzle-orm/pglite/migrator`'s own `migrate`
 * is `dialect.migrate(readMigrationFiles(config), session, config)`, and the pair it reads off the
 * database object is marked `@internal` in the published types rather than absent. Named here, and
 * ABSENCE IS A SUPPORTED STATE: a drizzle upgrade that moves it takes the narration away
 * ({@link applyMigrations} falls back to the whole-pass call), never the boot.
 */
interface StepwiseMigrator {
  dialect?: {
    migrate?: (
      migrations: MigrationMeta[],
      session: unknown,
      config: MigrationConfig,
    ) => Promise<void>;
  };
  session?: unknown;
}

/**
 * The watermark drizzle itself migrates against: the highest `created_at` in the journal's own
 * ledger, or `null` when the table does not exist yet (a first launch). Read with PGlite directly
 * — the same route {@link reclaimBodyBloat} takes — because this runs before anything has the
 * handle and a `select` is not worth a schema import.
 */
async function migratedThrough(client: PGlite, migrationsSchema: string): Promise<number | null> {
  const present = await client.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`${migrationsSchema}.__drizzle_migrations`],
  );
  if (present.rows[0]?.present !== true) return null;
  // The identifier is this module's own pinned constant (`journal-specs.ts`), never user input.
  const last = await client.query<{ last: string | null }>(
    `SELECT max(created_at)::text AS last FROM "${migrationsSchema}"."__drizzle_migrations"`,
  );
  const raw = last.rows[0]?.last;
  return raw == null ? null : Number(raw);
}

/**
 * Bring the schema up to date, ONE MIGRATION PER TRANSACTION, saying so as it goes.
 *
 * `PgDialect.migrate` wraps the whole pending set in one transaction, so nothing outside it can be
 * told which migration is running or what it cost — and the store behind this spent 3 min 58 s in
 * there behind a motionless sentence. The pending set, the statements and the ledger row stay
 * drizzle's; only the commit boundary moves, so a killed upgrade resumes at the next migration.
 * NOT on a first launch: with nothing in the ledger every migration runs against an empty store
 * and the flushes are pure cost (329 ms whole-pass against 1 465 ms stepwise, measured).
 */
async function applyMigrations(
  db: LocalDb,
  client: PGlite,
  opts: Pick<OpenLocalDbOptions, "log" | "onPhase" | "slowMigrationFloorMs">,
): Promise<MigrationCensus> {
  const entries = readJournalOf(MAIL_JOURNAL);
  const through = await migratedThrough(client, MAIL_JOURNAL.migrationsSchema);
  const pending = entries.filter((e) => through === null || e.when > through);
  const stepwise = db as unknown as StepwiseMigrator;
  const step = stepwise.dialect?.migrate;

  // The ordinary launch (nothing pending), the FIRST launch (nothing recorded — see above) and
  // the launch a drizzle upgrade left us unable to narrate take the SAME call this file always
  // made, including the schema and ledger table an empty pass still creates.
  if (through === null || pending.length === 0 || typeof step !== "function") {
    opts.onPhase?.("migrating");
    await migrate(db, MAIL_MIGRATION_CONFIG);
    return { pending: pending.length, applied: pending.length, slowest: null };
  }

  const metas = new Map(readMigrationFiles(MAIL_MIGRATION_CONFIG).map((m) => [m.folderMillis, m]));
  const floorMs = opts.slowMigrationFloorMs ?? SLOW_MIGRATION_MS;
  let slowest: MigrationCensus["slowest"] = null;
  let applied = 0;
  for (const entry of pending) {
    const meta = metas.get(entry.when);
    // A journal entry whose file the migrator did not read is not a case to route around: hand
    // the whole pass back to drizzle, which throws the message that names the missing file.
    if (!meta) {
      opts.onPhase?.("migrating");
      await migrate(db, MAIL_MIGRATION_CONFIG);
      return { pending: pending.length, applied: pending.length, slowest };
    }
    opts.onPhase?.("migrating", { applied, pending: pending.length });
    const began = Date.now();
    await step.call(stepwise.dialect, [meta], stepwise.session, MAIL_MIGRATION_CONFIG);
    const ms = Date.now() - began;
    applied += 1;
    if (slowest === null || ms > slowest.ms) slowest = { migration: entry.tag, ms };
    if (ms >= floorMs) {
      opts.log?.("migration_applied", {
        migration: entry.tag,
        totalMs: ms,
        reason: "a schema upgrade a person waited for, named so the next slow launch can be read",
      });
    }
  }
  opts.onPhase?.("migrating", { applied, pending: pending.length });
  return { pending: pending.length, applied, slowest };
}

/**
 * Checkpoint, because nothing else will while the app is running. PGlite runs Postgres SINGLE-USER
 * standalone — no postmaster, so no checkpointer, bgwriter or autovacuum — and both settings that
 * bound `pg_wal` are instructions TO THE CHECKPOINTER, so with nobody to receive them NO checkpoint
 * is taken for the life of the process and every segment stays (measured: 200 MB of churn left
 * `pg_control_checkpoint()` still naming initdb's redo segment). The boundaries are covered —
 * `close()` runs the shutdown checkpoint, a crash-start the end-of-recovery one — so what remains is
 * the MIDDLE of a run, and a mail app is open for days (an install up for hours held tens of GB of
 * `pg_wal`). So only the interval is added; an explicit `CHECKPOINT` (77 ms/131 MB) never throws.
 */
/**
 * WHICH RUN OF THIS STORE A CLIENT'S CURSOR BELONGS TO — minted at an open that could have lost
 * rows, unchanged across one that could not.
 *
 * The ingest does not wait for the flush, so a kill costs the store its last commits; those rows
 * come back from the mailbox AT THE SAME change-log seqs, and a client parked above that point
 * would never be served them (`sync-cursor-store-generation.test.ts`). A record still `open` is a
 * run that never closed. A FILE, because it is read before the database is; and an unparseable one
 * takes `Date.now()` rather than a count that could re-issue a generation.
 */
function readStoreGeneration(dataDir: string): number {
  const path = join(dataDir, STORE_GENERATION_FILE);
  if (!existsSync(path)) return 1;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const rec = raw as { generation?: unknown; open?: unknown };
    const gen = typeof rec.generation === "number" && Number.isSafeInteger(rec.generation) && rec.generation >= 1
      ? rec.generation
      : null;
    if (gen === null || typeof rec.open !== "boolean") return Date.now();
    return rec.open ? gen + 1 : gen;
  } catch {
    return Date.now();
  }
}

/** Write the record and make it durable, because it is the only witness of its own run. */
function writeStoreGeneration(dataDir: string, generation: number, open: boolean): void {
  const fd = openSync(join(dataDir, STORE_GENERATION_FILE), "w");
  try {
    writeSync(fd, JSON.stringify({ generation, open }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * The log this store has GENERATED since `since`, in bytes, and where that pointer now stands.
 *
 * `pg_current_wal_insert_lsn()` and never `pg_current_wal_lsn()`. The ingest's commits do not wait
 * for the flush ({@link INGEST_SYNCHRONOUS_COMMIT}), so the WRITE pointer sits still inside
 * `wal_buffers` while commit after commit piles up behind it — a gate reading it would see a log
 * that never grows and would never fold, which is the same bug as having no gate. The insert
 * pointer is every record the store has generated, which is what a kill takes. Both values come
 * out of ONE statement so they cannot be read either side of a fold.
 */
async function walGrownSince(client: PGlite, since: string): Promise<{ grew: number; at: string }> {
  const { rows } = await client.query<{ grew: string; at: string }>(
    "SELECT (pg_current_wal_insert_lsn() - $1::pg_lsn)::bigint::text AS grew, "
    + "pg_current_wal_insert_lsn()::text AS at",
    [since],
  );
  return { grew: Number(rows[0]!.grew), at: rows[0]!.at };
}

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
 * Which process, not merely which number — the identity written into the lock file. A pid on its own
 * is not an identity: pids are recycled (the counter wraps, a machine that lost power hands the same
 * numbers out again), so a lock left by a crash names a number some UNRELATED process now uses,
 * `kill(pid, 0)` says "alive", and the engine refuses to open a mailbox it alone owns — permanently,
 * until somebody deletes a file. Every field is OPTIONAL because the platforms disagree: `startTicks`
 * and `bootId` come from `/proc` (Linux-only), and the rule is written so ABSENCE never decides
 * anything — a missing field falls back to the old behaviour and only a POSITIVE mismatch takes a
 * lock away. Getting that backwards opens a second engine on a live PGlite directory, which corrupts it.
 */
interface LockRecord {
  pid: number;
  /**
   * The process's start time in clock ticks since boot, from `/proc/<pid>/stat` field 22.
   *
   * BOOT-RELATIVE and therefore exact: unlike a wall-clock start instant it involves no arithmetic
   * over `os.uptime()`, so two reads of the same live process always agree to the tick. That is
   * what makes it usable as an identity rather than as an estimate.
   */
  startTicks?: number;
  /** `/proc/sys/kernel/random/boot_id` — a fresh UUID for every boot of this machine. */
  bootId?: string;
  /**
   * When this machine booted, in ms since the epoch, derived from `os.uptime()`.
   *
   * The PORTABLE half, and deliberately fuzzy: it drifts by however much the clock is adjusted, so
   * it is compared with a wide tolerance and only ever used to answer "has this machine rebooted
   * since the lock was written", which is the common way a pid gets recycled.
   */
  bootAtMs?: number;
  /**
   * The writer's executable image, normalized by {@link normalizedImage}. An exe cannot change
   * under a live pid, so a LIVE process whose image differs from this is a different process —
   * the one positive identity every platform can answer, where `startTicks` is `/proc`-only.
   */
  exe?: string;
  /**
   * Minted per record, so two records that agree on every identity field still differ in BYTES —
   * {@link removeIfUnchanged} compares bytes, and this keeps "same bytes" meaning "same claim".
   */
  nonce?: string;
}

/**
 * One bounded, silent read of a platform tool's answer. `null` is "could not read" and never an
 * error: everything built on it treats absence as I-cannot-tell, which refuses rather than acts.
 */
function probe(cmd: string, args: readonly string[]): string | null {
  try {
    const out = execFileSync(cmd, [...args], {
      encoding: "utf8", timeout: 5_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** `reg query`'s answer for Windows' per-boot prefetcher counter → a stable token, or null. */
export function bootIdFromRegQuery(text: string | null): string | null {
  const m = text?.match(/\bBootId\b\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/);
  return m ? `winboot-${Number(m[1])}` : null;
}

/**
 * The OS's per-boot identity, where one exists. Linux mints a kernel UUID, macOS
 * `kern.bootsessionuuid`, and Windows increments a per-boot counter under the prefetcher's
 * registry key. All three are values a clock adjustment cannot move — the property that lets a
 * MISMATCH take a lock away, and exactly what the wall-clock `bootAtMs` lacks. The spawned reads
 * are cached (a boot id cannot change under a live process); Linux's stays a plain file read.
 */
let spawnedBootId: string | null | undefined;
function osBootId(): string | undefined {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return raw === "" ? undefined : raw;
    } catch {
      return undefined;
    }
  }
  if (spawnedBootId === undefined) {
    if (process.platform === "darwin") {
      spawnedBootId = probe("sysctl", ["-n", "kern.bootsessionuuid"]);
    } else if (process.platform === "win32") {
      spawnedBootId = bootIdFromRegQuery(probe("reg", [
        "query",
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters",
        "/v", "BootId",
      ]));
    } else {
      spawnedBootId = null;
    }
  }
  return spawnedBootId ?? undefined;
}

/** This machine's boot, as the two mechanisms see it. `bootAtMs` is read fresh, never cached. */
function bootIdentity(): { bootId?: string; bootAtMs: number } {
  const bootId = osBootId();
  return { ...(bootId === undefined ? {} : { bootId }), bootAtMs: Date.now() - osUptime() * 1000 };
}

/**
 * A live process's start time in clock ticks since boot, or null where it cannot be read.
 *
 * The field is the 22nd of `/proc/<pid>/stat`, and the parse starts AFTER the last `)` rather
 * than splitting the whole line: field 2 is the executable name in parentheses and may itself
 * contain spaces and parentheses, so a naive split puts every later field in the wrong place.
 */
function processStartTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterName = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    // `afterName[0]` is field 3 (state), so field 22 is index 19.
    const ticks = Number.parseInt(afterName[19] ?? "", 10);
    return Number.isInteger(ticks) && ticks >= 0 ? ticks : null;
  } catch {
    return null;
  }
}

/**
 * An executable path reduced to the name two different readers agree on: lower-cased basename,
 * Windows' `.exe` stripped, and the ` (deleted)` marker `/proc/<pid>/exe` grows when the binary
 * is replaced on disk under a live process — without that strip, upgrading Node while an engine
 * runs would read as "a different process" and take a live lock away.
 */
export function normalizedImage(name: string): string {
  const leaf = name.replace(/ \(deleted\)$/, "").split(/[\\/]/).pop() ?? "";
  return leaf.toLowerCase().replace(/\.exe$/, "");
}

/** One `tasklist /FO CSV /NH` row → the image of exactly `pid`, or null on anything else. */
export function imageFromTasklistCsv(text: string | null, pid: number): string | null {
  const m = text?.match(/^"([^"]+)","(\d+)"/m);
  return m && Number(m[2]) === pid ? normalizedImage(m[1]!) : null;
}

/**
 * WHAT is running as `pid`, not merely whether something is — the live half of {@link LockRecord.exe}.
 * Linux answers from `/proc` (the exe link, then argv[0] where the link is another user's);
 * Windows and macOS ask their own process tools, only ever on the contested path. `null` is
 * "cannot read", which decides nothing.
 */
function processImageOf(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return normalizedImage(readlinkSync(`/proc/${pid}/exe`));
    } catch {
      /* another user's process hides its exe link; argv[0] below is world-readable */
    }
    try {
      const argv0 = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? "";
      return argv0 === "" ? null : normalizedImage(argv0);
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const comm = probe("ps", ["-p", String(pid), "-o", "comm="]);
    return comm === null ? null : normalizedImage(comm);
  }
  if (process.platform === "win32") {
    return imageFromTasklistCsv(probe("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]), pid);
  }
  return null;
}

/**
 * Could this image be a mail engine at all? The engine is always the vendored Node runtime — the
 * desktop shell's rule is "the program is the runtime and the engine is its argument", on every
 * platform — so an image naming neither node nor ohmail is positively not one. Deliberately a
 * CLASS test and not an equality: it must stay true for every spelling the runtime ships under.
 */
function couldBeAnEngine(image: string): boolean {
  return image.includes("node") || image.includes("ohmail");
}

/**
 * Does `rec` describe THE PROCESS that is currently running as `rec.pid`?
 *
 * Answers `true` whenever it cannot tell, which is the whole design: `false` takes a lock away
 * from a running engine, so it is returned only on evidence.
 */
function lockStillOurs(rec: LockRecord, nowBoot: { bootId?: string; bootAtMs: number }): boolean {
  /* A different boot id is evidence. A different wall clock is not. `bootId` is a fresh UUID per
   * boot from the kernel: if it differs the machine rebooted and whatever holds this pid is not the
   * writer — safe to act on. `bootAtMs` is `Date.now() - os.uptime()`, and releasing the lock when it
   * moved by ten minutes was WRONG in the one direction that corrupts: the value moves with every
   * clock adjustment (NTP step, dead RTC, a resuming VM, a user correcting the date), and on a host
   * with no `/proc` it was the ONLY test — so a clock correction let the next launch unlink a live
   * lock and open a second PGlite on the directory. With only `bootAtMs`, the answer is I CANNOT TELL
   * and the launcher refuses; it is kept in the record as a diagnostic, not evidence to act on. */
  if (rec.bootId !== undefined && nowBoot.bootId !== undefined && rec.bootId !== nowBoot.bootId) {
    return false;
  }
  // SAME BOOT (or we could not tell): the pid can still have been recycled within it.
  if (rec.startTicks !== undefined) {
    const live = processStartTicks(rec.pid);
    if (live !== null && live !== rec.startTicks) return false;
  }
  /* WHAT holds the number, not merely that something does. Two positive arms: a live image that
   * differs from the recorded one is a different process (an exe cannot change under a pid), and
   * a live image that could not be an engine at all frees even a LEGACY record, which carries no
   * identity fields — after a power loss the crashed engine's number usually lands on some system
   * process, and "cannot tell" there refused every later launch of the only app that can fix it.
   * Both arms act only on a POSITIVE reading; an unreadable image decides nothing. */
  const image = processImageOf(rec.pid);
  if (image !== null) {
    if (rec.exe !== undefined && image !== rec.exe) return false;
    if (!couldBeAnEngine(image)) return false;
  }
  return true;
}

/** The identity of THIS process, as it goes into the file. */
function selfLockRecord(): LockRecord {
  const boot = bootIdentity();
  const ticks = processStartTicks(process.pid);
  return {
    pid: process.pid,
    ...(ticks === null ? {} : { startTicks: ticks }),
    ...boot,
    exe: normalizedImage(process.execPath),
    nonce: randomUUID(),
  };
}

/**
 * Parse a lock file's contents. Understands the JSON record and the BARE PID this file used to
 * write, because an install updating in place finds the old spelling and a lock that failed to
 * parse would be treated as stale — which is the one direction that must never happen by
 * accident.
 */
function parseLockRecord(raw: string): LockRecord | null {
  const text = raw.trim();
  if (text === "") return null;
  if (text.startsWith("{")) {
    try {
      const o = JSON.parse(text) as Partial<LockRecord>;
      if (!Number.isInteger(o.pid) || (o.pid as number) <= 0) return null;
      return {
        pid: o.pid as number,
        ...(Number.isInteger(o.startTicks) ? { startTicks: o.startTicks as number } : {}),
        ...(typeof o.bootId === "string" && o.bootId ? { bootId: o.bootId } : {}),
        ...(Number.isFinite(o.bootAtMs) ? { bootAtMs: o.bootAtMs as number } : {}),
        ...(typeof o.exe === "string" && o.exe ? { exe: o.exe } : {}),
        ...(typeof o.nonce === "string" && o.nonce ? { nonce: o.nonce } : {}),
      };
    } catch {
      return null;
    }
  }
  const pid = Number.parseInt(text, 10);
  // THE LEGACY SPELLING — a bare pid and nothing else. It carries no identity, so `lockStillOurs`
  // will answer "cannot tell" for it and the behaviour is exactly what it was before this record
  // existed. A lock written by an older build is not a lock this build may steal on a guess.
  return Number.isInteger(pid) && pid > 0 ? { pid } : null;
}

/** A lock file's bytes together with the inode they came from — see {@link removeIfUnchanged}. */
interface HeldLock {
  raw: string;
  dev: bigint;
  ino: bigint;
  /**
   * When these bytes were last written, read through the SAME descriptor they came from — so the
   * age and the content describe one file. Only {@link EMPTY_LOCK_STALE_AFTER_MS} reads it, and a
   * clock that has moved backwards makes the age negative, which refuses: the safe direction.
   */
  mtimeMs: number;
}

/**
 * Read the lock file THROUGH ONE DESCRIPTOR, so the bytes and the inode describe the same file.
 * `null` when there is nothing there to read.
 *
 * Reading the path and then stat-ing the path is two resolutions of one name, which is the defect
 * this exists to avoid: between them the name can come to mean a different file entirely.
 */
function readLockFile(path: string): HeldLock | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const st = fstatSync(fd, { bigint: true });
    return {
      raw: readFileSync(fd, "utf8").trim(), dev: st.dev, ino: st.ino, mtimeMs: Number(st.mtimeMs),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * ── COMPARE AND DELETE, NEVER DELETE ─────────────────────────────────────────────────────────
 *
 * Remove the lock only while the path still names the FILE THAT WAS JUDGED, and say whether it
 * did. Judging a lock stale takes a signal, a `/proc` read and a boot-id read, and the unlink used
 * to name the path rather than that file: a launcher that judged in that window went on to delete
 * the lock a second launcher had already replaced it with, after which both held the directory.
 *
 * Identity is the inode AND the bytes: the inode alone would admit a record rewritten in place,
 * and the bytes alone would admit a new file that happens to say the same thing. The residual
 * window is the two adjacent syscalls below, which is as narrow as this gets without `unlinkat`.
 */
function removeIfUnchanged(path: string, judged: HeldLock): boolean {
  const now = readLockFile(path);
  // Already gone — somebody else cleared the same stale lock. Nothing of theirs is at risk.
  if (now === null) return true;
  if (now.dev !== judged.dev || now.ino !== judged.ino || now.raw !== judged.raw) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * ── THE FILE AND ITS RECORD ARE ONE ACT ──────────────────────────────────────────────────────
 *
 * Create the lock file WITH ITS OWNER ALREADY IN IT, or throw `EEXIST` because somebody holds it.
 * `openSync(path, "wx")` then a write is two steps where the file system offers one: killed
 * between them, a build left an EMPTY lock naming nobody, and the rule below — no record is not
 * evidence a process is gone — refused every later launch. So the record goes to a temp file in
 * the same directory and is `link`ed into place: `link` fails `EEXIST` when the name is taken,
 * and the name appears only once the bytes are behind it.
 */
function claimLockFile(path: string): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    const fd = openSync(tmp, "wx");
    try {
      // A TRAILING NEWLINE, as before: `cat`ing this file in a terminal is how somebody debugs it.
      writeSync(fd, `${JSON.stringify(selfLockRecord())}\n`);
    } finally {
      closeSync(fd);
    }
    linkSync(tmp, path);
  } finally {
    /* The link made the inode reachable under `path`; this only drops the second name. On the
       refused path it drops the only one, so nothing of this attempt survives. */
    rmSync(tmp, { force: true });
  }
}

/**
 * Take an exclusive lock on the data directory, or refuse. {@link claimLockFile} is atomic, and
 * the winner's file names it from the instant it exists. A lock left by a crash names a pid, and
 * a pid that is gone releases it — the alternative means a laptop that lost power cannot open its
 * mail. A pid that is BACK releases it too, the half that was missing: after a reboot the counter
 * starts again and some unrelated process is issued the dead engine's number, so `kill(pid, 0)`
 * answers "alive" for a process that never heard of this mailbox. {@link LockRecord} records
 * WHICH process, and a live pid whose identity does not match the record is taken over.
 */
export function lockDataDir(dataDir: string, log?: Diagnostic): () => void {
  const path = join(dataDir, LOCK_FILE);
  /* Three passes, not two: a pass that finds the lock REPLACED underneath it removes nothing and
     spends its turn judging the replacement instead, and the O_EXCL retry after a real removal
     still needs one of its own. */
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      claimLockFile(path);
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const held = readLockFile(path);
      // Gone between the refused create and the read: nothing to judge, race for it again.
      if (held === null) continue;
      const rec = parseLockRecord(held.raw);
      /* ── NO RECORD IS NOT EVIDENCE THAT A PROCESS IS GONE ──────────────────────────────────
       *
       * An EMPTY lock file is the ordinary state of one another launcher is HALFWAY THROUGH
       * TAKING — created `O_EXCL`, record written a statement later — so reading empty as stale
       * deleted a live lock and put two PGlite instances on one directory. Truncated bytes take
       * the same answer, and their refusal names the way out: delete the file if that process is
       * definitely gone. EXCEPT BY AGE: {@link claimLockFile} cannot produce an empty lock, so an
       * EMPTY file older than {@link EMPTY_LOCK_STALE_AFTER_MS} is a pre-fix crash residue, not a
       * launch in progress — replaced once, then raced for. Unreadable BYTES are not this shape.
       */
      if (rec === null) {
        if (held.raw === "" && Date.now() - held.mtimeMs >= EMPTY_LOCK_STALE_AFTER_MS) {
          // Removed only while the path still names THE FILE THAT WAS JUDGED, on the stale
          // record's rule below; either way the next pass judges whatever it then finds.
          removeIfUnchanged(path, held);
          continue;
        }
        if (held.raw === "") {
          throw new DataDirLockedError(
            dataDir, "a launch that is still taking it",
            `The lock is ${path}. Wait a minute and open ohmail again.`,
          );
        }
        throw new DataDirLockedError(dataDir, "a lock file this build cannot read");
      }
      const holderAlive = alive(rec.pid);
      if (holderAlive && lockStillOurs(rec, bootIdentity())) {
        throw new DataDirLockedError(dataDir, `pid ${rec.pid}`);
      }
      // Stale (or a recycled pid): clear THE FILE THAT WAS JUDGED and try again, so two processes
      // both finding it stale still resolve to one winner via the O_EXCL race above. One sentence
      // in the log and none for the person — recovering from a crash is the ordinary path.
      if (!removeIfUnchanged(path, held)) continue;
      log?.("data_dir_lock_reclaimed", {
        kind: holderAlive ? "owner-replaced" : "owner-gone",
        reason: "a leftover data-directory lock from a crash or power loss named a process that " +
          "is provably not the engine that wrote it; reclaimed, and the start continues",
      });
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
  const unlock = lockDataDir(dataDir, log);
  try {
    opts.underLock?.();
  } catch (err) {
    unlock();
    throw err;
  }
  /* BEFORE `new PGlite`, because the record has to be read before recovery can hide what it is
     about — a store that replays a crash's log looks exactly like one that closed cleanly once
     it is up. Written back `open: true` immediately, so a kill from here on is seen as one. */
  const storeGeneration = readStoreGeneration(dataDir);
  writeStoreGeneration(dataDir, storeGeneration, true);
  const pgDataDir = join(dataDir, PGDATA_SUBDIR);
  let client: PGlite;
  try {
    // BEFORE `new PGlite`, because the whole point is to name the wait while it is happening —
    // and read from the directory rather than from PGlite, which says nothing until it is done.
    opts.onPhase?.(openPhaseFor(dataDir));
    const tOpen = Date.now();
    /* PGlite's NodeFS with the protocol transport kept in memory (`pglite-transport.ts`); the log,
       the relations and the durability properties below are the disk exactly as before. */
    client = new PGlite({
      dataDir: pgDataDir,
      fs: new LocalStoreFs(pgDataDir),
      ...(opts.withoutSearchExtensions ? {} : { extensions: LOCAL_STORE_EXTENSIONS }),
    });
    // AWAITED HERE ON PURPOSE, AND IT CHANGES NOTHING EXCEPT WHERE THE COST IS ATTRIBUTED.
    //
    // `new PGlite()` returns before the database is usable — the WASM instantiation, the data
    // directory mount and Postgres' own startup are deferred behind `waitReady`, which the FIRST
    // statement then awaits implicitly. Without this line every millisecond of that lands inside
    // `adoptBaseline`, whose own work is one metadata read, and the phase breakdown below would
    // name the wrong phase. The total is identical either way: the same promise is awaited, once,
    // a few microseconds earlier.
    await client.waitReady;
    /* BEFORE ANY WRITE, because this is the property every other durability claim in this file
       rests on and a wrong one is invisible to every test. See {@link WAL_SYNC_METHOD}. */
    await assertWalSyncMethod(client);
    /**
     * THE FAIR SHARE, IN FRONT OF THE HANDLE AND BEFORE ANYTHING ELSE HOLDS IT.
     *
     * Here and not at each caller: drizzle, the compaction pass and the checkpointer are all handed
     * this same object, so a wrapper any of them could be given instead would leave that one
     * outside the scheduler with nothing to say so. See `store-lanes.ts` for what it schedules and
     * why FIFO is the defect.
     */
    const lanes = createStoreScheduler();
    /* FIRST, beneath the relaxed commits and the scheduler, so both still wrap the whole statement
       and every transaction's `query` is the planned one. See `pglite-plans.ts`. */
    keepIngestPlans(client);
    /* BEFORE the scheduler, so an admission still wraps a whole transaction rather than sitting
       inside one. See {@link relaxIngestCommits}: the migrator below runs outside every lane and
       therefore keeps the default, which is what a schema change and its journal row need. */
    relaxIngestCommits(client);
    scheduleStoreLanes(client, lanes);
    const pgliteOpenMs = Date.now() - tOpen;
    const db = brandDialect(drizzle(client, { schema: mailSchema }), "pg");
    // ONE JOURNAL, and the loop is gone with the second one: a `for` over a one-element list is
    // an invitation to put the other element back. `adoptBaseline` still runs — it is a no-op on
    // a brand-new local database (the `fresh` cell of its truth table), and a code path only
    // production takes is a code path nothing checks.
    const tAdopt = Date.now();
    await adoptBaseline(db, MAIL_JOURNAL);
    const adoptBaselineMs = Date.now() - tAdopt;
    const tMigrate = Date.now();
    // The phase — and, per migration, how far it has got — is announced from inside, because only
    // there is the pending set known. See {@link applyMigrations}.
    const migrations = await applyMigrations(db, client, opts);
    // AFTER the pass, exactly as the server runner orders it: a journal entry that exists
    // twice (an original plus its reissue) owes the original's bookkeeping row wherever only
    // the reissue could run — a local mirror that migrated in the skip window is that
    // population too, and the journal README names the local engine as a first-class consumer.
    // A no-op everywhere else (`REISSUED_ORIGINALS`, packages/db/src/baseline.ts).
    await adoptReissuedOriginals(db, MAIL_JOURNAL);
    const migrateMs = Date.now() - tMigrate;
    // AFTER the migrator (the table must exist on a first launch) and BEFORE serving: a rewrite
    // holds an exclusive lock, and the one place that lock collides with nothing is here, where
    // no reader has the handle yet. See {@link reclaimBodyBloat} for the measured pathology and
    // the gate that keeps a healthy launch's cost at one ANALYZE.
    const tCompact = Date.now();
    await reclaimBodyBloat(client, log, opts.onPhase);
    const compactMs = Date.now() - tCompact;
    // AFTER the migrator (the indexed tables must exist) and BEFORE serving, like the compaction.
    const tSearch = Date.now();
    if (!opts.withoutSearchExtensions) await setUpLocalSearch(db, log);
    await analyzeSearchIfStale(client);
    const searchSetupMs = Date.now() - tSearch;
    let closed = false;
    /**
     * The insert pointer as the last fold left it, or `null` for "unknown" — which is what an
     * unreadable pointer leaves behind, and {@link foldIfLogGrew} FOLDS on it rather than skipping.
     * Every checkpoint this handle takes resets it, the periodic one included, so the window is
     * measured from the last fold of any kind and not from the last gated one.
     */
    let logMark: LogMark = { folded: null };
    const checkpoint = async (): Promise<number> => {
      if (closed) return 0;
      const dropped = await checkpointWal(client, pgDataDir, log, () => !closed);
      // Every checkpoint resets the window, the periodic one included, so the next gate measures
      // from the last fold of ANY kind rather than from the last gated one.
      const at = closed ? null : await walGrownSince(client, "0/0").then((r) => r.at).catch(() => null);
      logMark = { folded: at };
      return dropped;
    };
    const bounds: LogBounds = {
      foldBytes: opts.ingestFoldWalBytes ?? INGEST_FOLD_WAL_BYTES,
    };
    /**
     * THE GATE IS THE DIALECT'S, THE SEGMENT CENSUS IS THIS MODULE'S. `foldLog` decides whether
     * the log has earned a fold and issues it in the store's own spelling — so the phone's SQLite
     * is bounded by the same number of bytes rather than by nothing — and the reclaimed-segment
     * count stays here, where the data directory is. An unreadable mark folds rather than
     * skipping, which is the safe side of a question about what a crash would replay.
     */
    const foldIfLogGrew = async (): Promise<StoreFold> => {
      if (closed) return { folded: false, grewBytes: 0, dropped: 0 };
      const before = walSegments(pgDataDir);
      const out = await dialect(db).foldLog(db, bounds, logMark)
        .catch(() => ({ folded: false as const, grewBytes: null, mark: { folded: null } }));
      logMark = out.mark;
      if (!out.folded) return { folded: false, grewBytes: out.grewBytes, dropped: 0 };
      return { folded: true, grewBytes: out.grewBytes, dropped: before - walSegments(pgDataDir) };
    };
    /* WHERE THE WINDOW STARTS — the pointer as the open leaves it, so the first drain's gate
       measures the mail that drain took and not the migrator and compaction behind it. */
    const opened = await walGrownSince(client, "0/0").then((r) => r.at).catch(() => null);
    logMark = { folded: opened };

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
      timings: { pgliteOpenMs, adoptBaselineMs, migrateMs, compactMs, searchSetupMs },
      migrations,
      checkpoint,
      foldIfLogGrew,
      storeGeneration,
      storeBytes: () => storeHeapBytes(client),
      laneCensus: () => lanes.census(),
      analyzeSearchIfStale: () => (closed ? Promise.resolve(false) : analyzeSearchIfStale(client)),
      close: async () => {
        if (closed) return;
        closed = true;
        if (tick) clearTimeout(tick);
        tick = null;
        try {
          // Postgres takes its own shutdown checkpoint here, which is why there is not one of ours.
          await client.close();
          /* AND ONLY THEN is the run recorded as closed — after the shutdown checkpoint, so the
             record cannot say "nothing was lost" about a store that was still flushing. A throw
             above leaves it `open: true` and the next launch mints a new generation, which is the
             safe side of a question about somebody's mail. */
          writeStoreGeneration(dataDir, storeGeneration, false);
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
