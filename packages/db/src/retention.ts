import { sql } from "drizzle-orm";
import { accountSyncState } from "./schema-mail.js";
import { authEvents } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";
import { RETENTION_DELETE_BATCH, affected } from "./change-log-retention.js";

/**
 * RETENTION — every horizon this deployment prunes by, in ONE place. `change_log` is COMPACTED,
 * never truncated, below a floor raised BEFORE any delete; `getChanges` 410s an untagged cursor
 * below it and the client re-bootstraps. `audit_log`/`auth_events` age out on fixed horizons. The
 * mail half (the compaction and the audit age-out) is `change-log-retention.ts`, in both stores'
 * dialects; this file is the hosted rest.
 */

/* The mail half lives in `change-log-retention.ts`, which the local engine reaches from the mail
   barrel; re-exported here so the hosted barrel and the worker read one set of names. */
export {
  CHANGE_LOG_RETENTION_GRACE_MS, CHANGE_LOG_HOLDBACK_LIVE_MS, AUDIT_LOG_RETENTION_MS,
  RETENTION_DELETE_BATCH, RETENTION_BATCHES_PER_ACCOUNT,
  changeLogHorizon, pruneChangeLogForAccount, pruneAuditLog, type ChangeLogPruneResult,
} from "./change-log-retention.js";

/** auth_events keeps 180 days — the alert windows read hours, the user's own history a page.
 *  It carries `ip` and `device`, so keeping less is the point, not a saving. */
export const AUTH_EVENTS_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/** Accounts visited per maintenance tick (round-robin by account id, wrapping). */
export const RETENTION_ACCOUNTS_PER_TICK = 25;
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
