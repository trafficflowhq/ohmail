import { sql } from "drizzle-orm";
import { makeOwnedDb } from "@trafficflow/db/cloud";

/**
 * THE LEADER LOCK OF THE API'S OWN CLOCKS: of the copies of this program alive at once, one holds
 * it and drives the clocks (`clocks.ts`).
 *
 * The lock is one transaction, held open on a connection of its own:
 * `pg_try_advisory_xact_lock` lives exactly as long as that transaction, so it is released when
 * the holder lets go, and by Postgres itself the moment the holder's connection is gone. A copy
 * that stalls is let go too: the database ends a transaction left idle for a minute
 * (`idle_in_transaction_session_timeout`), which is why the holder's heartbeat ({@link
 * LeaderLock.verify}) must run well inside that. The transaction writes nothing and holds no
 * snapshot between statements.
 *
 * It needs a session-capable connection: through a transaction-mode pooler the lock would be
 * taken on a backend the next statement has already left.
 */

/**
 * The API clocks' own key: 8000 above the worker's leader band (4207270001 + shard), below the
 * migration lock (4207279001) and the first-run setup lock (4207279101). A worker leading its
 * cycle and an API copy leading the clocks never contend.
 */
export const API_CLOCK_LOCK_KEY = 4207278001n;

export interface LeaderLock {
  /** The backend that holds the lock: ending it is losing the lock. */
  readonly backendPid: number;
  /**
   * Resolves (never rejects) once the lock is KNOWN to be lost: a heartbeat could not run on the
   * holding transaction. Never for a deliberate {@link release}.
   */
  readonly lost: Promise<Error>;
  /** The heartbeat: one statement on the holding transaction. False, and `lost`, when it cannot run. */
  verify(): Promise<boolean>;
  /** Let go: the transaction ends, Postgres frees the lock, the connection closes. */
  release(): Promise<void>;
}

/**
 * Try to take the lock. A handle on success; null when another copy holds it. Throws when the
 * database cannot be asked, which is neither.
 */
export async function acquireLeaderLock(url: string, key: bigint = API_CLOCK_LOCK_KEY): Promise<LeaderLock | null> {
  const owned = makeOwnedDb(url);
  type Tx = Parameters<Parameters<typeof owned.db.transaction>[0]>[0];

  let released = false;
  let settled = false;
  let signalLost: (err: Error) => void = () => { /* replaced below */ };
  const lost = new Promise<Error>((resolve) => { signalLost = resolve; });
  const markLost = (reason: string): void => {
    if (settled || released) return;       // a deliberate release() is not a loss
    settled = true;
    signalLost(new Error(`clock lock lost: ${reason}`));
  };

  let letGo: () => void = () => { /* replaced below */ };
  const until = new Promise<void>((resolve) => { letGo = resolve; });
  let answer: (taken: { tx: Tx; pid: number } | null) => void = () => { /* replaced below */ };
  let refuse: (err: unknown) => void = () => { /* replaced below */ };
  const asked = new Promise<{ tx: Tx; pid: number } | null>((resolve, reject) => { answer = resolve; refuse = reject; });

  // The transaction IS the lock: it stays open until `letGo`, pinned to one connection.
  const held = owned.db.transaction(async (tx) => {
    // The key as text, cast in SQL: a 64-bit key stays exact whatever the driver does with numbers.
    const rows = await tx.execute(sql`select pg_try_advisory_xact_lock(${key.toString()}::bigint) as locked, pg_backend_pid() as pid`);
    const row = rows[0] as { locked?: unknown; pid?: unknown } | undefined;
    if (row?.locked !== true) { answer(null); return; }
    answer({ tx, pid: Number(row.pid ?? 0) });
    await until;
  }).catch((err: unknown) => {
    // Before the answer this is "the database could not be asked"; after it, the lock is gone.
    refuse(err);
    markLost("the holding transaction ended");
  });

  let taken: { tx: Tx; pid: number } | null;
  try {
    taken = await asked;
  } catch (err) {
    await owned.close().catch(() => { /* nothing was held */ });
    throw err;
  }
  if (taken === null) {
    await held;
    await owned.close();
    return null;
  }
  const { tx, pid } = taken;

  return {
    backendPid: pid,
    lost,
    async verify(): Promise<boolean> {
      if (released || settled) return false;
      try {
        await tx.execute(sql`select 1`);
        return true;
      } catch {
        markLost("the heartbeat could not run on the holding transaction");
        return false;
      }
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // After a loss the transaction has no backend to commit on: it is not resumed, and the
      // pool is closed under it.
      if (!settled) { letGo(); await held; }
      await owned.close().catch(() => { /* the connection is gone already */ });
    },
  };
}
