import { and, eq, isNull, sql } from "drizzle-orm";
import { accountSyncState, auditLog, changeLog, devices, sessions } from "./schema-mail.js";
import { prunedThroughSeq, type Tx } from "./change-log.js";
import { dialect } from "./dialect/index.js";

/**
 * THE MAIL HALF OF RETENTION — the change-log compaction and the audit-log age-out, spoken in both
 * stores' dialects, because the local engine runs them on its own store (a desktop's PGlite, a
 * phone's SQLite) as the hosted worker runs them on the server. `change_log` is COMPACTED, never
 * truncated: the floor (`account_sync_state.pruned_through_seq`) is raised BEFORE any delete, and
 * below it each live entity keeps its FIRST row plus the ohbox-tidy user-wins moves. `retention.ts`
 * keeps the hosted rest and re-exports these, so the hosted barrel's census never names this file.
 */

/** Nothing younger than this is ever pruned, whatever the stamps say. It absorbs the device
 *  stamp throttle (5 min), commit-vs-createdAt skew and the final-page handover many times over. */
export const CHANGE_LOG_RETENTION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How recently a session or device must have synced (or been created) to hold the horizon back.
 * A client staler than this re-bootstraps through the 410 contract when it returns — without the
 * bound, one abandoned device row (a rig account carries hundreds) pins every account's log for
 * ever, which is the unbounded growth this module exists to end.
 */
export const CHANGE_LOG_HOLDBACK_LIVE_MS = 90 * 24 * 60 * 60 * 1000;

/** audit_log keeps a year: the workflow undo/idempotency reads and the admin lists are all
 *  recent-window reads; a year-old run's undo finding no inverses is stated, not silent. */
export const AUDIT_LOG_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/** Rows one compact/prune DELETE may take — the transaction bound. */
export const RETENTION_DELETE_BATCH = 20_000;
/** Compact DELETEs per account per tick — with the batch above, the per-tick work bound. */
export const RETENTION_BATCHES_PER_ACCOUNT = 4;

/** Rows a raw statement changed, across the server drivers' three spellings of the same number. */
export const affected = (res: unknown): number => {
  const r = res as { count?: number; rowCount?: number; affectedRows?: number };
  return Number(r.count ?? r.rowCount ?? r.affectedRows ?? 0);
};

/** One tick's work for one account, for the pass's log line. */
export interface ChangeLogPruneResult {
  /** The floor after this tick (0 = nothing prunable yet). */
  prunedThroughSeq: bigint;
  /** Rows the compaction deleted this tick. */
  deleted: number;
}

/** A timestamp as either driver hands it back: a Date, the server's text, or the device's ms. */
const instant = (v: unknown): number | null =>
  v == null ? null : new Date(v as string | number | Date).getTime();

/**
 * The account's retention horizon INSTANT: the oldest live client's last committed drain, minus
 * the grace. "Live" is a session that is unrevoked and refresh-valid, or a registered device,
 * either seen within {@link CHANGE_LOG_HOLDBACK_LIVE_MS}; a client that never completed a drain
 * holds at its own creation instant. No live client ⇒ `now` minus grace: a returning stale
 * client is exactly who the 410 re-bootstrap contract serves.
 */
export async function changeLogHorizon(db: Tx, accountId: string, now: Date): Promise<Date> {
  const d = dialect(db);
  const liveAfter = d.ts(new Date(now.getTime() - CHANGE_LOG_HOLDBACK_LIVE_MS));
  const sessionAt = sql`coalesce(${sessions.lastSyncedAt}, ${sessions.createdAt})`;
  const deviceAt = sql`coalesce(${devices.lastSyncedAt}, ${devices.createdAt})`;
  const [s] = await db.select({ m: sql<unknown>`min(${sessionAt})` }).from(sessions).where(and(
    eq(sessions.accountId, accountId), isNull(sessions.revokedAt),
    sql`${sessions.refreshExpiresAt} > ${d.ts(now)}`, sql`${sessionAt} >= ${liveAfter}`,
  ));
  const [v] = await db.select({ m: sql<unknown>`min(${deviceAt})` }).from(devices).where(and(
    eq(devices.accountId, accountId), sql`${deviceAt} >= ${liveAfter}`,
  ));
  const held = [instant(s?.m), instant(v?.m)].filter((t): t is number => t !== null && Number.isFinite(t));
  const oldest = held.length > 0 ? Math.min(...held) : now.getTime();
  return new Date(Math.min(oldest, now.getTime()) - CHANGE_LOG_RETENTION_GRACE_MS);
}

/**
 * Raise the floor to the newest seq older than the horizon, then compact below it in bounded
 * batches. The ORDER is the correctness property: the floor is raised first, so every cursor the
 * compaction could orphan is already refused (410) before the first row goes — a crash in between
 * costs conservative 410s only. The floor never lowers (`greatest`), so a slow tick racing a fresh
 * one cannot move it backwards.
 */
export async function pruneChangeLogForAccount(
  db: Tx, accountId: string, now: Date,
  opts: { batch?: number; maxBatches?: number } = {},
): Promise<ChangeLogPruneResult> {
  const d = dialect(db);
  const batch = opts.batch ?? RETENTION_DELETE_BATCH;
  const maxBatches = opts.maxBatches ?? RETENTION_BATCHES_PER_ACCOUNT;
  const horizon = await changeLogHorizon(db, accountId, now);

  // Correlated on the counter row, so an account without one (no change ever written) updates nothing.
  await db.update(accountSyncState).set({
    prunedThroughSeq: sql`${d.greatest(accountSyncState.prunedThroughSeq, sql`coalesce((
      select max(${changeLog.seq}) from ${changeLog}
       where ${changeLog.accountId} = ${accountSyncState.accountId}
         and ${changeLog.createdAt} < ${d.ts(horizon)}
    ), 0)`)}`,
  }).where(eq(accountSyncState.accountId, accountId));

  const floor = await prunedThroughSeq(db, accountId);
  if (floor === 0n) return { prunedThroughSeq: 0n, deleted: 0 };

  // COMPACTION below the floor. Keep each entity's first row while it lives, every user-wins
  // move-to-INBOX row, and the account's NEWEST row (on an idle account the floor lands on it).
  // Delete later rows per entity, every row of an entity with a tombstone at or below the floor,
  // and the tombstones. The LIMIT bounds one statement; a rerun re-derives the same victims. The
  // count is the RETURNING rows: the device store's driver reports no affected count at all.
  const victims = sql`select seq from (
      select ${changeLog.seq} as seq, ${changeLog.op} as op, ${d.jsonText(changeLog.meta, "to")} as moved_to,
             row_number() over (
               partition by ${changeLog.entityType}, ${changeLog.entityId} order by ${changeLog.seq}
             ) as rn,
             max(case when ${changeLog.op} = 'delete' then 1 else 0 end) over (
               partition by ${changeLog.entityType}, ${changeLog.entityId}
             ) as dead
        from ${changeLog}
       where ${changeLog.accountId} = ${accountId} and ${changeLog.seq} <= ${Number(floor)}
    ) sub
     where (rn > 1 or dead = 1)
       and not (op = 'move' and moved_to = 'INBOX')
       and seq < (select max(${changeLog.seq}) from ${changeLog} where ${changeLog.accountId} = ${accountId})
     order by seq
     limit ${batch}`;
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const gone = await db.delete(changeLog)
      .where(and(eq(changeLog.accountId, accountId), sql`${changeLog.seq} in (${victims})`))
      .returning({ seq: changeLog.seq });
    const n = gone.length;
    deleted += n;
    if (n < batch) break;
  }
  return { prunedThroughSeq: floor, deleted };
}

/** One bounded batch of the audit_log fixed-age prune; the caller loops while it returns full. */
export async function pruneAuditLog(
  db: Tx, now: Date, retentionMs: number = AUDIT_LOG_RETENTION_MS,
  batch: number = RETENTION_DELETE_BATCH,
): Promise<number> {
  const cut = dialect(db).ts(new Date(now.getTime() - retentionMs));
  const gone = await db.delete(auditLog).where(sql`${auditLog.id} in (
    select ${auditLog.id} from ${auditLog}
     where ${auditLog.createdAt} < ${cut}
     order by ${auditLog.createdAt}
     limit ${batch}
  )`).returning({ id: auditLog.id });
  return gone.length;
}
