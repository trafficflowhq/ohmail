import { randomInt } from "node:crypto";
import postgres from "postgres";
import { onNotice } from "@trafficflow/db";
import { pgTlsOptions } from "@trafficflow/db/cloud";

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

/**
 * Why a leader stopped leading, as a closed set (the log line carries it as the error's code):
 * the lock's session closed, was replaced by a reconnect, or no longer holds the lock; the lock
 * could not be proven inside its bound; the heartbeat row names another holder, or would not take
 * this one's claim; a mail-bearing write was refused by the fence.
 */
export type LockLostCode =
  | "LOCK_SESSION_CLOSED" | "LOCK_SESSION_REPLACED" | "LOCK_NOT_HELD"
  | "LOCK_UNPROVEN" | "LOCK_SUPERSEDED" | "LOCK_UNCLAIMED" | "LOCK_FENCED";

/** This instance is no longer SURE it holds the lock: leadership must be surrendered. */
export class LockLostError extends Error {
  constructor(reason: string, readonly code: LockLostCode) {
    super(`leader lock lost: ${reason}`);
    this.name = "LockLostError";
  }
}

/** How long `release()` waits for the unlock's answer before it ends the session without it. */
export const LOCK_RELEASE_DEADLINE_MS = 5_000;

/**
 * A lock session's private MARK: a second advisory lock, of the two-key form, that the session takes
 * for itself beside the leader lock (this first key, and a random second one). It is how a session
 * that had to be ended unanswered can be found again and ended at the server ({@link LockGhost}), and
 * what the heartbeat row's claim asks for beside the lock (`LeaderLock.mark`).
 * By its mark and not by its backend pid: behind a session pooler a backend outlives its client and
 * is handed to the next one, pid and start time unchanged, while the mark is session state and goes
 * when the pooler resets the backend. The two-key form is a key space of its own, so a mark is never
 * read as a leader lock (those have a first half of zero in `pg_locks`).
 */
const LOCK_MARK_CLASS = 1_869_114_732;

/**
 * A session this process ended WITHOUT the unlock's answer. If the server was not told either (a path
 * that drops packets both ways), it still runs the session, and the session still holds the lock:
 * nobody leads until the server notices a peer that is gone, which by default takes hours.
 */
export interface LockGhost { mark: number }

export interface LeaderLock {
  /**
   * Give the lock back and end its session. Never rejects and never takes longer than
   * {@link LOCK_RELEASE_DEADLINE_MS}: a stop or a surrender must not hang on a session that no
   * longer answers. The session's end is what frees the lock; where the server has not been told
   * (nothing reaches it), the lock stays the old session's until the server lets that go.
   */
  release(): Promise<void>;
  /**
   * Resolves (never rejects) the moment the lock is KNOWN to be lost — the dedicated session closed, or a
   * heartbeat proved another backend now owns it. It never settles on the happy path, and NOT for a
   * deliberate `release()`. Why (split brain): the advisory lock is SESSION-scoped, so Postgres frees it
   * the instant the connection drops (a network blip, a `pg_terminate_backend`, a failover), and
   * postgres.js then silently RECONNECTS on the next query — so without this the process keeps reporting
   * `leader: true` and syncing while a standby legitimately acquires the lock and syncs the SAME accounts.
   */
  readonly lost: Promise<LockLostError>;
  /** Heartbeat: is the lock still held by the exact backend that acquired it? */
  verify(): Promise<boolean>;
  /** The backend PID that owns the lock (a reconnect changes it ⇒ the lock is gone). */
  readonly backendPid: number;
  /**
   * The two keys of this session's mark. With `backendPid` it names the SESSION to the database (the
   * heartbeat row's claim asks for both): a pid alone can be another client's by then.
   */
  readonly mark: readonly [number, number];
  /**
   * After `release()`: null when the unlock was answered, else what the next attempt needs to end
   * this session at the server (`acquireLeaderLock`'s `evict`). Null before a release.
   */
  ghost(): LockGhost | null;
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
 *
 * `signal` is the caller's deadline on the ATTEMPT, never on a lock that was handed back: aborted
 * while this is still acquiring, the session is ended at once, so a statement the server never
 * answers rejects and a lock it granted unseen goes with the session.
 *
 * `evict` is a session the CALLER'S OWN earlier lock left behind ({@link LockGhost}). Before the lock
 * is asked for, the backend that still carries that session's mark is ended; `onEvicted` says it
 * was. Best effort: a ghost that cannot be ended holds the lock until the server lets it go, and
 * this attempt then reads the lock as held elsewhere, as it is.
 */
export async function acquireLeaderLock(
  url: string, key: bigint = LEADER_LOCK_KEY,
  opts: { signal?: AbortSignal; evict?: LockGhost | null; onEvicted?: () => void } = {},
): Promise<LeaderLock | null> {
  // postgres.js supports bigint params at runtime; its published types omit bigint, so cast the
  // interpolated key to keep the 64-bit advisory-lock key exact while satisfying the compiler.
  const k = key as unknown as number;

  let released = false;
  let signalLost: (err: LockLostError) => void = () => { /* replaced below */ };
  const lost = new Promise<LockLostError>((resolve) => { signalLost = resolve; });
  let settled = false;
  const markLost = (reason: string, code: LockLostCode): void => {
    if (settled || released) return;      // a deliberate release() is not a loss
    settled = true;
    signalLost(new LockLostError(reason, code));
  };

  const sql = postgres(url, {
    ...pgTlsOptions(url), max: 1, idle_timeout: 0, max_lifetime: 0,
    // Fires when the dedicated connection closes for ANY reason. postgres.js will happily
    // reconnect on the next query — into a session that does NOT hold the lock.
    onclose: () => {
      markLost("the dedicated lock session closed (postgres.js will reconnect WITHOUT the lock)", "LOCK_SESSION_CLOSED");
    },
    // Without this postgres.js writes the raw notice OBJECT to stdout, bypassing the hardened
    // logger. This connection is the most sensitive one in the process: it holds the leader advisory
    // lock, so anything it emits is read as evidence about leadership. `onNotice` rather than a bare
    // `() => {}`: a hand-rolled drop at each site is the copied-sink defect's shape, and routing through the one policy
    // point means a host that installs a sink lights this connection up too.
    onnotice: onNotice,
  });

  const abandon = (): void => { released = true; void sql.end({ timeout: 0 }); };
  opts.signal?.addEventListener("abort", abandon, { once: true });
  let backendPid = 0;
  let mark = 0;
  let ghost: LockGhost | null = null;
  try {
    if (opts.evict) {
      const theirs = opts.evict.mark;
      const ended = await sql`
        SELECT pg_terminate_backend(pid) FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()
          AND classid::bigint = ${LOCK_MARK_CLASS} AND objid::bigint = ${theirs} AND objsubid = 2
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
        .catch(() => []);
      if (ended.length > 0) opts.onEvicted?.();
    }
    const rows = await sql`SELECT pg_try_advisory_lock(${k}) AS locked`;
    if (rows[0]?.locked !== true) { released = true; await sql.end({ timeout: 5 }); return null; }
    const wanted = randomInt(1, 2 ** 31 - 1);
    const pidRows = await sql<{ pid: number; marked: boolean }[]>`
      SELECT pg_backend_pid() AS pid, pg_try_advisory_lock(${LOCK_MARK_CLASS}, ${wanted}) AS marked`;
    backendPid = Number(pidRows[0]?.pid ?? 0);
    // A mark another session already carries is not this one's, and a session without one cannot
    // claim the row: it does not lead. The lock goes with the session; the next attempt draws again.
    if (pidRows[0]?.marked !== true) { released = true; await sql.end({ timeout: 5 }); return null; }
    mark = wanted;
  } catch (err) {
    released = true;
    await sql.end({ timeout: 5 });
    throw err;
  } finally {
    opts.signal?.removeEventListener("abort", abandon);
  }

  return {
    backendPid,
    mark: [LOCK_MARK_CLASS, mark],
    lost,
    ghost: () => ghost,
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
        markLost(`the lock session was replaced (backend pid ${backendPid} → ${pid})`, "LOCK_SESSION_REPLACED");
        return false;
      }
      if (rows[0]?.held !== true) {
        markLost(`pg_locks no longer shows advisory lock ${key} held by backend pid ${pid}`, "LOCK_NOT_HELD");
        return false;
      }
      return true;
    },
    async release() {
      if (released) return;
      released = true;                    // first: a close during the wait below is not a loss
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let unlocked = false;
      try {
        // A session known to be closed or replaced gets no unlock: the driver would dial again to
        // send it, into a session that never held the lock, and that dial's own error would be the
        // one the caller sees.
        if (!settled) {
          unlocked = await Promise.race([
            sql`SELECT pg_advisory_unlock_all()`.then(() => true, () => false),
            new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(false), LOCK_RELEASE_DEADLINE_MS); }),
          ]);
        }
        // Not answered: the server may still run this session, with the lock.
        if (!unlocked) ghost = { mark };
        await sql.end({ timeout: 0 });
      } catch {
        // Nothing to add: this side of the session is over either way.
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
