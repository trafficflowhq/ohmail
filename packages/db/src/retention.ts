import { sql } from "drizzle-orm";
import { accountSyncState, auditLog, changeLog, devices, sessions } from "./schema-mail.js";
import { authEvents } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * RETENTION — every horizon this deployment prunes by, in ONE place, and the prunes themselves.
 * `change_log` is COMPACTED, never truncated: the desktop Cloud mirror bootstraps by a full
 * `since=0` log replay whose mark-and-sweep deletes what the feed no longer carries, so below
 * the floor the pass keeps each live entity's FIRST row (creation order preserves the FK apply
 * order; the delta materializes CURRENT state) plus the ohbox-tidy user-wins moves, and deletes
 * churn, tombstones and dead entities. The floor (`account_sync_state.pruned_through_seq`,
 * mail 0122) is raised BEFORE any delete; `getChanges` 410s an untagged cursor below it and the
 * client re-bootstraps. `audit_log`/`auth_events` age out on the fixed horizons stated below.
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

/** auth_events keeps 180 days — the alert windows read hours, the user's own history a page.
 *  It carries `ip` and `device`, so keeping less is the point, not a saving. */
export const AUTH_EVENTS_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/** Accounts visited per maintenance tick (round-robin by account id, wrapping). */
export const RETENTION_ACCOUNTS_PER_TICK = 25;
/** Rows one compact/prune DELETE may take — the transaction bound. */
export const RETENTION_DELETE_BATCH = 20_000;
/** Compact DELETEs per account per tick — with the batch above, the per-tick work bound. */
export const RETENTION_BATCHES_PER_ACCOUNT = 4;

/** Rows a statement changed, across the drivers' three spellings of the same number. */
const affected = (res: unknown): number => {
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

/**
 * The account's retention horizon INSTANT: the oldest live client's last committed drain, minus
 * the grace. "Live" is a session that is unrevoked and refresh-valid, or a registered device,
 * either seen within {@link CHANGE_LOG_HOLDBACK_LIVE_MS}; a client that never completed a drain
 * holds at its own creation instant (its first cursor postdates its registration — a fresh
 * client bootstraps, it never resumes a cursor older than itself). No live client ⇒ `now` minus
 * grace: a returning stale client is exactly who the 410 re-bootstrap contract serves.
 */
export async function changeLogHorizon(db: Tx, accountId: string, now: Date): Promise<Date> {
  const liveAfter = new Date(now.getTime() - CHANGE_LOG_HOLDBACK_LIVE_MS);
  const rows = await db.execute(sql`
    select min(x) as m from (
      select coalesce(${sessions.lastSyncedAt}, ${sessions.createdAt}) as x
        from ${sessions}
       where ${sessions.accountId} = ${accountId}
         and ${sessions.revokedAt} is null
         and ${sessions.refreshExpiresAt} > ${now.toISOString()}::timestamptz
      union all
      select coalesce(${devices.lastSyncedAt}, ${devices.createdAt})
        from ${devices}
       where ${devices.accountId} = ${accountId}
    ) t
    where x >= ${liveAfter.toISOString()}::timestamptz
  `) as unknown as
    Array<{ m: string | Date | null }> | { rows?: Array<{ m: string | Date | null }> };
  const list = Array.isArray(rows) ? rows : rows.rows ?? [];
  const m = list[0]?.m;
  const oldest = m == null ? now : new Date(m as string | Date);
  return new Date(Math.min(oldest.getTime(), now.getTime()) - CHANGE_LOG_RETENTION_GRACE_MS);
}

/**
 * Raise the floor to the newest seq older than the horizon, then compact below it in bounded
 * batches. The ORDER is the correctness property: the floor is durably raised first, so every
 * cursor the compaction could orphan is already refused (410) before the first row goes — a
 * crash in between costs conservative 410s only. The floor UPDATE never lowers (`greatest`),
 * so a slow tick racing a fresh one cannot move it backwards.
 */
export async function pruneChangeLogForAccount(
  db: Tx, accountId: string, now: Date,
  opts: { batch?: number; maxBatches?: number } = {},
): Promise<ChangeLogPruneResult> {
  const batch = opts.batch ?? RETENTION_DELETE_BATCH;
  const maxBatches = opts.maxBatches ?? RETENTION_BATCHES_PER_ACCOUNT;
  const horizon = await changeLogHorizon(db, accountId, now);

  // The floor: max(seq) among rows older than the horizon. Correlated on the counter row so an
  // account without one (no change ever written) updates nothing. `greatest` keeps it monotone.
  await db.execute(sql`
    update ${accountSyncState}
       set pruned_through_seq = greatest(
         ${accountSyncState.prunedThroughSeq},
         coalesce((
           select max(${changeLog.seq}) from ${changeLog}
            where ${changeLog.accountId} = ${accountSyncState.accountId}
              and ${changeLog.createdAt} < ${horizon.toISOString()}::timestamptz
         ), 0)
       )
     where ${accountSyncState.accountId} = ${accountId}
  `);

  const floorRows = await db
    .select({ f: sql<string>`coalesce(${accountSyncState.prunedThroughSeq}, 0)::text` })
    .from(accountSyncState)
    .where(sql`${accountSyncState.accountId} = ${accountId}`);
  const floor = BigInt(floorRows[0]?.f ?? "0");
  if (floor === 0n) return { prunedThroughSeq: 0n, deleted: 0 };

  // COMPACTION below the floor. Keep: each entity's first row while it lives, and every
  // user-wins move-to-INBOX row. Delete: later rows per entity (`rn > 1` — the delta pipeline
  // materializes current state, so the first row already replays the entity whole), every row of
  // an entity with a tombstone at or below the floor (`dead`), and the tombstones themselves.
  // The window runs over the whole sub-floor range and the LIMIT bounds what one statement
  // takes; a converged account's sub-floor range is one row per live entity, so the steady-state
  // scan is small. Deleting is idempotent — a rerun re-derives the same victims minus the gone.
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const res = await db.execute(sql`
      with sub as (
        select ${changeLog.seq} as seq, ${changeLog.op} as op, ${changeLog.meta} as meta,
               row_number() over (
                 partition by ${changeLog.entityType}, ${changeLog.entityId}
                 order by ${changeLog.seq}
               ) as rn,
               bool_or(${changeLog.op} = 'delete') over (
                 partition by ${changeLog.entityType}, ${changeLog.entityId}
               ) as dead
          from ${changeLog}
         where ${changeLog.accountId} = ${accountId} and ${changeLog.seq} <= ${floor.toString()}::bigint
      ),
      victims as (
        select seq from sub
         where (rn > 1 or dead)
           and not (op = 'move' and meta ->> 'to' = 'INBOX')
         order by seq
         limit ${batch}
      )
      delete from ${changeLog}
       where ${changeLog.accountId} = ${accountId}
         and ${changeLog.seq} in (select seq from victims)
    `);
    const n = affected(res);
    deleted += n;
    if (n < batch) break;
  }
  return { prunedThroughSeq: floor, deleted };
}

/**
 * The round-robin window of accounts one tick visits, keyed above the caller's last position and
 * wrapping at the end (the caller passes "" to start over). `account_sync_state` is the roster:
 * an account is only here once it has written a change, which is exactly the population with a
 * log to prune.
 */
export async function retentionAccountsAfter(
  db: Tx, afterAccountId: string, limit: number = RETENTION_ACCOUNTS_PER_TICK,
): Promise<string[]> {
  const rows = await db
    .select({ id: sql<string>`${accountSyncState.accountId}::text` })
    .from(accountSyncState)
    .where(sql`${accountSyncState.accountId}::text > ${afterAccountId}`)
    .orderBy(sql`${accountSyncState.accountId}::text`)
    .limit(limit);
  return rows.map((r) => r.id);
}

/** One bounded batch of the audit_log fixed-age prune; the caller loops while it returns full. */
export async function pruneAuditLog(
  db: Tx, now: Date, retentionMs: number = AUDIT_LOG_RETENTION_MS,
  batch: number = RETENTION_DELETE_BATCH,
): Promise<number> {
  const cut = new Date(now.getTime() - retentionMs);
  const res = await db.execute(sql`
    delete from ${auditLog} where ${auditLog.id} in (
      select ${auditLog.id} from ${auditLog}
       where ${auditLog.createdAt} < ${cut.toISOString()}::timestamptz
       order by ${auditLog.createdAt}
       limit ${batch}
    )
  `);
  return affected(res);
}

/** One bounded batch of the auth_events fixed-age prune; the caller loops while it returns full. */
export async function pruneAuthEvents(
  db: Tx, now: Date, retentionMs: number = AUTH_EVENTS_RETENTION_MS,
  batch: number = RETENTION_DELETE_BATCH,
): Promise<number> {
  const cut = new Date(now.getTime() - retentionMs);
  const res = await db.execute(sql`
    delete from ${authEvents} where ${authEvents.id} in (
      select ${authEvents.id} from ${authEvents}
       where ${authEvents.at} < ${cut.toISOString()}::timestamptz
       order by ${authEvents.at}
       limit ${batch}
    )
  `);
  return affected(res);
}
