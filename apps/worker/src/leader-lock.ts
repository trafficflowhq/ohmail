import postgres from "postgres";
import { onNotice } from "@trafficflow/db";

/** Fixed application-wide advisory-lock key for the single-active-worker guarantee. */
export const LEADER_LOCK_KEY = 4207270001n;

/**
 * The SHARD seam. One process serves one shard of accounts and holds that
 * shard's OWN leader lock, so `shards` processes can run side by side without ever
 * serving the same account twice. Shipped configuration is `shards = 1`, shard 0 —
 * whose key is byte-identical to the historical `LEADER_LOCK_KEY`, so every existing
 * holder (the always-on worker and all four cron backstops) keeps contending on the
 * exact same key as before.
 */
export function leaderLockKeyFor(shardIndex = 0): bigint {
  if (!Number.isInteger(shardIndex) || shardIndex < 0) {
    throw new Error(`shardIndex must be a non-negative integer (got ${String(shardIndex)})`);
  }
  return LEADER_LOCK_KEY + BigInt(shardIndex);
}

/** The lock is provably no longer held by THIS session — leadership must be surrendered. */
export class LockLostError extends Error {
  constructor(reason: string) {
    super(`leader lock lost: ${reason}`);
    this.name = "LockLostError";
  }
}

export interface LeaderLock {
  release(): Promise<void>;
  /**
   * Resolves (never rejects) the moment the lock is KNOWN to be lost — the dedicated
   * session closed, or a heartbeat proved another backend now owns it. It never settles
   * on the happy path, and it does NOT settle for a deliberate `release()`.
   *
   * Why this exists (split brain): the advisory lock is SESSION-scoped, so Postgres frees
   * it the instant the connection drops — a network blip, a `pg_terminate_backend`, a
   * failover. postgres.js then silently RECONNECTS on the next query, so without this the
   * process keeps reporting `leader: true` and keeps syncing while a standby legitimately
   * acquires the lock and syncs the SAME accounts.
   */
  readonly lost: Promise<LockLostError>;
  /** Heartbeat: is the lock still held by the exact backend that acquired it? */
  verify(): Promise<boolean>;
  /** The backend PID that owns the lock (a reconnect changes it ⇒ the lock is gone). */
  readonly backendPid: number;
}

/**
 * Try to acquire the session-level advisory lock. Returns a handle on success, null if another
 * session holds it. The dedicated connection is kept open for the lock's lifetime (session scope);
 * closing it releases the lock automatically. REQUIRES a session-mode connection.
 *
 * The connection is genuinely dedicated (`max: 1`, no idle timeout, no max lifetime) and its
 * close is OBSERVED: `onclose` resolves `lost`, and `verify()` re-checks both the backend PID
 * and `pg_locks` so a silent postgres.js reconnect can never be mistaken for continued
 * leadership.
 */
export async function acquireLeaderLock(url: string, key: bigint = LEADER_LOCK_KEY): Promise<LeaderLock | null> {
  // postgres.js supports bigint params at runtime; its published types omit bigint, so cast the
  // interpolated key to keep the 64-bit advisory-lock key exact while satisfying the compiler.
  const k = key as unknown as number;

  let released = false;
  let signalLost: (err: LockLostError) => void = () => { /* replaced below */ };
  const lost = new Promise<LockLostError>((resolve) => { signalLost = resolve; });
  let settled = false;
  const markLost = (reason: string): void => {
    if (settled || released) return;      // a deliberate release() is not a loss
    settled = true;
    signalLost(new LockLostError(reason));
  };

  const sql = postgres(url, {
    max: 1, idle_timeout: 0, max_lifetime: 0,
    // Fires when the dedicated connection closes for ANY reason. postgres.js will happily
    // reconnect on the next query — into a session that does NOT hold the lock.
    onclose: () => { markLost("the dedicated lock session closed (postgres.js will reconnect WITHOUT the lock)"); },
    // Without this postgres.js writes the raw notice OBJECT to stdout, bypassing the hardened
    // logger. This connection is the most sensitive one in the process: it holds the leader advisory
    // lock, so anything it emits is read as evidence about leadership. `onNotice` rather than a bare
    // `() => {}`: a hand-rolled drop at each site is the copied-sink defect's shape, and routing through the one policy
    // point means a host that installs a sink lights this connection up too.
    onnotice: onNotice,
  });

  let backendPid = 0;
  try {
    const rows = await sql`SELECT pg_try_advisory_lock(${k}) AS locked`;
    if (rows[0]?.locked !== true) { released = true; await sql.end({ timeout: 5 }); return null; }
    const pidRows = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    backendPid = Number(pidRows[0]?.pid ?? 0);
  } catch (err) {
    released = true;
    await sql.end({ timeout: 5 });
    throw err;
  }

  return {
    backendPid,
    lost,
    async verify(): Promise<boolean> {
      if (released || settled) return false;
      // `pg_locks.objid` is an `oid` (unsigned 32-bit), so classid<<32 + objid reconstructs
      // the exact 64-bit key of the single-argument `pg_try_advisory_lock(bigint)` form.
      const rows = await sql<{ pid: number; held: boolean }[]>`
        SELECT pg_backend_pid() AS pid,
          EXISTS (
            SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
              AND ((classid::bigint << 32) + objid::bigint) = ${k}
          ) AS held`;
      const pid = Number(rows[0]?.pid ?? 0);
      if (pid !== backendPid) {
        markLost(`the lock session was replaced (backend pid ${backendPid} → ${pid})`);
        return false;
      }
      if (rows[0]?.held !== true) {
        markLost(`pg_locks no longer shows advisory lock ${key} held by backend pid ${pid}`);
        return false;
      }
      return true;
    },
    async release() {
      if (released) return;
      released = true;
      try { await sql`SELECT pg_advisory_unlock(${k})`; }
      finally { await sql.end({ timeout: 5 }); }
    },
  };
}
