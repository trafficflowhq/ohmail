/**
 * ONE WRITER AT A TIME PER DATABASE FILE — the platform half's side of `SqlExecutor`'s promise.
 *
 * ── THE DEFECT THIS CLOSES (measured on the shipped 0.14.1 Android build) ────────────────────
 *
 * Every message opened on the phone rendered `Only the preview could be loaded. Reopen to try
 * again.` while the server answered `GET /messages/:id/body` with HTTP 200 and the whole text.
 * The wire was never the problem; the WRITE was.
 *
 * `SqlExecutor.batch` is contracted to run its statements atomically, and the expo half delivered
 * that with `withExclusiveTransactionAsync`. What that call does is open a SECOND CONNECTION to
 * the same file (`SQLiteDatabase.js` → `Transaction.createAsync`, `useNewConnection: true`) and
 * drive `BEGIN` / statements / `COMMIT` across real `await`s. Two overlapping `batch` calls are
 * therefore two connections both trying to write, and expo's own documentation says what happens:
 * *"As long as the transaction is converted into a write transaction, the other async write
 * queries will abort with `database is locked` error."*
 *
 * Overlap was not rare, it was the ordinary case. `liveActions.openMessage` hydrates the body and
 * — for an unread message — dispatches `mark_seen` in the same tick, so the body's `ready` write
 * and the mutation's writes reach the mirror together. Every message in a mailbox is unread the
 * first time somebody opens it, which is why a race read as "this app never loads bodies". The
 * losing write threw, `OhmailEngine.fetchBodyInto` caught it and wrote a `failed` record, and the
 * surface rendered the sentence above over a body the phone had already been given.
 *
 * The device said all of this out loud once it was asked: with the mirror pulled off the
 * emulator, the message the screen called failed held `{state: "loading"}` — the marker written
 * before the request — while a message opened with NO concurrent mutation held
 * `{state: "ready"}` and its full text.
 *
 * ── WHY THE FIX IS HERE AND NOT IN THE ENGINE ───────────────────────────────────────────────
 *
 * `SqlExecutor` is a seam with a stated contract, and the engine above it is entitled to it: the
 * browser arm (IndexedDB) and the node arm (`node:sqlite`'s fully SYNCHRONOUS `DatabaseSync`,
 * which no other JS can interleave with) both honour it for free. Only this platform half does
 * not. Serialising in the engine would make every other arm pay for one host's transaction model,
 * and would leave the next caller of `expoSqlExecutor` — a tool, a probe, a later screen — with
 * the same broken guarantee.
 *
 * ── AND IT IS KEYED ON THE FILE, NOT ON THE OBJECT ──────────────────────────────────────────
 *
 * The thing SQLite locks is the database, so that is what the queue has to be about. Two
 * `SqlExecutor` instances over one path do occur — `forgetMirror` opens the same name again for
 * its read-back probe — and a per-instance queue would let those two collide exactly as before
 * while looking serialised. `databasePath` is the identity.
 *
 * Reads are queued too. Expo's sentence names write queries, but the guarantee it describes rests
 * on the journal mode, and a read that loses is a `load()` that throws where a body write used to
 * — the same class of silent damage one layer over. The store issues a handful of reads per open,
 * so there is nothing to buy by leaving them out.
 *
 * This module imports NOTHING from Expo, which is what lets the node suite drive the real batch
 * runner against a database with the platform's transaction semantics
 * (`test/helpers/expo-sqlite-shape.ts`) rather than against one that cannot express the defect.
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
     * ON THIS CONNECTION, NOT A SECOND ONE.
     *
     * `withExclusiveTransactionAsync` opens a fresh connection for the transaction, and a fresh
     * connection is a fresh set of per-connection settings. `PRAGMA foreign_keys` is one of them:
     * SQLite defaults it OFF, the migrator turns it ON for the connection it runs on, and nothing
     * turns it on for a connection opened later by the driver. Every write in a batch therefore
     * ran with the schema's references UNENFORCED — an orphaned row committed as readily as a good
     * one, and the store's shape was being kept by luck.
     *
     * It cannot be fixed by setting the pragma inside the task, either: SQLite makes that
     * statement a no-op while a transaction is open, so the obvious repair would have been silent
     * and the guard would still have been green.
     *
     * The second connection was only ever there to get a write transaction that survives a
     * concurrent read — and this queue already guarantees there is no concurrent anything on this
     * file. So the transaction runs here, on the connection that was configured, and the
     * serialisation that made the second connection unnecessary is the same serialisation that
     * made it dangerous.
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
