/**
 * One writer at a time per database file — the platform half's side of `SqlExecutor`'s promise. On the shipped 0.14.1
 * Android build every opened message rendered "Only the preview could be loaded" while the server answered 200:
 * `withExclusiveTransactionAsync` opens a SECOND connection, and two overlapping `batch` calls became two writers —
 * the loser aborted with "database is locked". Overlap was the ordinary case (`openMessage` hydrates the body and
 * dispatches `mark_seen` in the same tick). The fix is here, not in the engine: `SqlExecutor` is a seam with a stated
 * contract the other arms honour for free. Keyed on the FILE, not the object — two of them over one path occur
 * (`forgetMirror`'s read-back), and a per-instance queue would let them collide while looking serialised. Reads are
 * queued too. Imports nothing from Expo, so the node suite drives the real batch runner.
 */
import type { SqlExecutor, SqlRow, SqlStatement, SqlValue } from "@ohmail/client-engine";

/** The transaction handle `withExclusiveTransactionAsync` hands its task — expo's `Transaction`. */
export interface ExclusiveTxn {
  runAsync(sql: string, params: readonly SqlValue[]): Promise<unknown>;
}

/**
 * The structural subset of `expo-sqlite`'s `SQLiteDatabase` this batch runner uses. Named as an
 * interface rather than imported so this file stays loadable off-device; `expoSqlExecutor`
 * (native.ts) passes the real handle, which satisfies it.
 */
export interface ExclusiveTxnDatabase {
  /** The file this handle is open on — the queue's identity. See the header. */
  readonly databasePath: string;
  getAllAsync<T>(sql: string, params: readonly SqlValue[]): Promise<T[]>;
  /**
   * One statement on THIS connection — the one the migrator opened and configured. The batch
   * runner drives `BEGIN IMMEDIATE` / `COMMIT` through it rather than handing the work to
   * `withExclusiveTransactionAsync`; see the note on {@link serialSqlExecutor.batch}.
   */
  runAsync(sql: string, params: readonly SqlValue[]): Promise<unknown>;
  closeAsync(): Promise<void>;
}

/**
 * The tail of each file's queue. Module-level for the reason the header gives: the lock is the
 * file's, so the queue must be too.
 *
 * A finished lane is NOT deleted, and that is deliberate rather than a leak worth trading for a
 * correctness hazard: dropping the entry the moment a lane went idle would let a caller that is
 * between `await`s find no tail, start a fresh one, and run beside work that has not settled.
 * One resolved promise per mirror file, for the life of the process, is a phone holding one or
 * two mailboxes.
 */
const lanes = new Map<string, Promise<unknown>>();

/**
 * Run `work` after everything already queued for `path`, and before anything queued after it.
 *
 * The lane is advanced by a promise that CANNOT reject — a rejected tail would make every later
 * caller inherit this one's failure, and worse, an unhandled rejection nobody is listening for.
 * The caller still gets the real outcome: `run` is what is returned, `settled` is what the lane
 * waits on.
 */
function inLane<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = lanes.get(path) ?? Promise.resolve();
  const run = previous.then(work, work);
  lanes.set(path, run.then(() => undefined, () => undefined));
  return run;
}

/**
 * `SqlExecutor` over an expo-shaped database, with every operation on one file serialised.
 *
 * `close` is queued like everything else: `SqlMirrorStore.close()` does not await it, and closing
 * a handle out from under a transaction that is still committing is how a forget loses the write
 * it was racing.
 */
export function serialSqlExecutor(db: ExclusiveTxnDatabase): SqlExecutor {
  const path = db.databasePath;
  return {
    all(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<ReadonlyArray<SqlRow>> {
      return inLane(path, () => db.getAllAsync<SqlRow>(sql, [...params]));
    },
    /**
     * On this connection, not a second one. A fresh connection is a fresh set of
     * per-connection settings, and `PRAGMA foreign_keys` is one: SQLite defaults it off, the
     * migrator turns it on for the connection it runs on, and nothing turns it on for a
     * connection the driver opens later — every write in a batch ran with the schema's
     * references unenforced. It cannot be fixed inside the task either: the pragma is a no-op
     * while a transaction is open, so the obvious repair would have been silent. The second
     * connection only existed to survive a concurrent read, and this queue already guarantees
     * there is no concurrent anything on this file.
     */
    batch(statements: ReadonlyArray<SqlStatement>): Promise<void> {
      return inLane(path, async () => {
        await db.runAsync("BEGIN IMMEDIATE", []);
        try {
          for (const { sql, params = [] } of statements) {
            await db.runAsync(sql, [...params]);
          }
          await db.runAsync("COMMIT", []);
        } catch (err) {
          // A failed COMMIT has already ended the transaction; a failed statement has not. Asking
          // either way is right, and the rollback's own failure must not replace the real error.
          try { await db.runAsync("ROLLBACK", []); } catch { /* no transaction to roll back */ }
          throw err;
        }
      });
    },
    close(): Promise<void> {
      return inLane(path, () => db.closeAsync());
    },
  };
}
