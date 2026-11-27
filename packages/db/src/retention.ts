import { and, asc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { accounts, accountSyncState } from "./schema-mail.js";
import { authEvents, connectAttempts } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";
import {
  RETENTION_BATCHES_PER_ACCOUNT, RETENTION_DELETE_BATCH, affected, changeLogHorizon,
  pruneChangeLogForAccount as pruneLocalChangeLog, type ChangeLogPruneOptions, type ChangeLogPruneResult,
} from "./change-log-retention.js";
import { dialect } from "./dialect/index.js";
import { readAccountErasedAt } from "./erasure-fence.js";
import { accountPass, readPassProgress, writePassProgress } from "./pass-progress.js";

/**
 * RETENTION — every horizon this deployment prunes by, in ONE place. `change_log` is COMPACTED,
 * never truncated, below a floor raised BEFORE any delete; `getChanges` 410s an untagged cursor
 * below it and the client re-bootstraps. `audit_log`/`auth_events` age out on fixed horizons. The
 * mail half (the compaction and the audit age-out) is `change-log-retention.ts`, in both stores'
 * dialects; this file is the hosted rest.
 */

/* The mail half lives in `change-log-retention.ts`, which the local engine reaches from the mail
   barrel. The hosted worker also has a bounded sequence walk for account-bound work. */
export {
  CHANGE_LOG_RETENTION_GRACE_MS, CHANGE_LOG_HOLDBACK_LIVE_MS, AUDIT_LOG_RETENTION_MS,
  RETENTION_DELETE_BATCH, RETENTION_BATCHES_PER_ACCOUNT,
  changeLogHorizon, pruneAuditLog, type ChangeLogPruneResult,
} from "./change-log-retention.js";

/** The hosted worker uses its bounded walk with an account-bound handle. */
export async function pruneChangeLogForAccount(
  db: Tx, accountId: string, now: Date, opts: ChangeLogPruneOptions & { hosted?: boolean } = {},
): Promise<ChangeLogPruneResult> {
  if (!opts.hosted) return pruneLocalChangeLog(db, accountId, now, opts);
  const { batch = RETENTION_DELETE_BATCH, maxBatches = RETENTION_BATCHES_PER_ACCOUNT } = opts;
  return pruneHostedChangeLog(db, accountId, now, batch, maxBatches);
}

/**
 * Walk a finite lap, even while the account is writing new changes. Age is tested only
 * after the index has produced one sequence page. The next lap revisits rows above the floor.
 */
async function discoverHostedFloor(
  tx: Tx, accountId: string, horizon: Date, floor: bigint, newest: bigint, position: string,
): Promise<{ floor: bigint; position: string }> {
  const saved = /^(\d+):(\d+)$/.exec(position);
  const ceiling = saved ? BigInt(saved[1]!) : newest;
  const after = saved && BigInt(saved[2]!) > floor ? BigInt(saved[2]!) : floor;
  if (after >= ceiling) return { floor, position: "" };
  const [row] = await tx.execute(sql`
    with floor_page as materialized (
      select seq, created_at from change_log
      where account_id = ${accountId} and seq > ${after.toString()}::bigint and seq <= ${ceiling.toString()}::bigint
      order by seq limit ${RETENTION_DELETE_BATCH}
    )
    select max(seq)::text as last, count(*)::int as visited,
      (max(seq) filter (where created_at < ${dialect(tx).ts(horizon)}))::text as eligible
    from floor_page
  `) as unknown as Array<{ last: string | null; visited: number; eligible: string | null }>;
  if (row!.eligible !== null) {
    floor = BigInt(row!.eligible);
    await tx.update(accountSyncState).set({ prunedThroughSeq: floor }).where(eq(accountSyncState.accountId, accountId));
  }
  return { floor, position: row!.visited < RETENTION_DELETE_BATCH || row!.last === ceiling.toString()
    ? "" : `${ceiling}:${row!.last}` };
}

/**
 * A hosted page visits at most `batch` sequence positions. First process live facts and
 * deletions' other rows, then remove the tombstones that justified those deletions. Each page
 * commits its cursor with its deletes. If the floor moves during a lap, finish that lap before
 * starting the next so a busy account cannot repeatedly restart at the head.
 */
async function pruneHostedChangeLog(
  db: Tx, accountId: string, now: Date, batch: number, maxBatches: number,
): Promise<ChangeLogPruneResult> {
  const horizon = await changeLogHorizon(db, accountId, now);
  const key = accountPass("retention_prune", accountId);
  let deleted = 0;
  let prunedThroughSeq = 0n;
  for (let i = 0; i < maxBatches; i++) {
    const page = await db.transaction(async (raw) => {
      const tx = raw as unknown as Tx;
      if (await readAccountErasedAt(tx, dialect(tx), accountId) != null) {
        return { floor: 0n, gone: 0, done: true };
      }
      // Serializes pages and floor changes on this account with writers and other compactors.
      const [state] = await tx.select({ floor: accountSyncState.prunedThroughSeq, newest: accountSyncState.nextSeq }).from(accountSyncState)
        .where(eq(accountSyncState.accountId, accountId)).for("update");
      if (!state) return { floor: 0n, gone: 0, done: true };
      const cursor = (await readPassProgress(tx, key)).cursor ?? "";
      const [mark = "", position = ""] = cursor.split(";");
      const discovery = i === 0 ? await discoverHostedFloor(tx, accountId, horizon, state.floor, state.newest, position)
        : { floor: state.floor, position };
      const { floor } = discovery;
      const persist = async (compaction: string) => {
        const next = discovery.position ? `${compaction};${discovery.position}` : compaction;
        if (next !== cursor) await writePassProgress(tx, key, { cursor: next || null });
      };
      const saved = /^(\d+):(rows|tombstones|done):(\d+)$/.exec(mark);
      const complete = saved?.[2] === "done";
      const prior = saved ? BigInt(saved[1]!) : 0n;
      if (floor === 0n || (complete && prior === floor)) {
        await persist(mark);
        return { floor, gone: 0, done: true };
      }
      const resume = saved !== null && !complete && prior <= floor;
      const ceiling = resume ? prior : floor;
      const phase = resume ? saved[2] : "rows";
      const after = resume ? saved[3]! : "0";
      const [result] = await tx.execute(sql`
        with candidates as materialized (
          select seq, entity_type, entity_id, op, meta
          from change_log where account_id = ${accountId} and seq > ${after}::bigint and seq <= ${ceiling.toString()}::bigint
          order by seq limit ${batch}
        ), removed as (
          delete from change_log victim using candidates c
          where victim.account_id = ${accountId} and victim.seq = c.seq
            and c.seq < (select max(seq) from change_log where account_id = ${accountId})
            and not (c.op = 'move' and c.meta->>'to' = 'INBOX')
            and ${phase === "tombstones" ? sql`c.op = 'delete'` : sql`c.op <> 'delete' and (
              exists (select 1 from change_log earlier
                where earlier.account_id = ${accountId} and earlier.entity_type = c.entity_type
                  and earlier.entity_id = c.entity_id and earlier.seq < c.seq)
              or exists (select 1 from change_log tombstone
                where tombstone.account_id = ${accountId} and tombstone.entity_type = c.entity_type
                  and tombstone.entity_id = c.entity_id and tombstone.op = 'delete'
                  and tombstone.seq <= ${ceiling.toString()}::bigint)
            )`}
          returning 1
        )
        select (select count(*)::int from candidates) as visited,
          (select max(seq)::text from candidates) as last, (select count(*)::int from removed) as gone
      `) as unknown as Array<{ visited: number; last: string | null; gone: number }>;
      const atEnd = result!.visited < batch;
      const next = !atEnd ? `${ceiling}:${phase}:${result!.last}`
        : phase === "rows" ? `${ceiling}:tombstones:0` : `${ceiling}:done:0`;
      await persist(next);
      return { floor, gone: result!.gone, done: atEnd && phase === "tombstones" };
    });
    prunedThroughSeq = page.floor;
    deleted += page.gone;
    if (page.done) break;
  }
  return { prunedThroughSeq, deleted };
}

/** auth_events keeps 180 days — the alert windows read hours, the user's own history a page.
 *  It carries `ip` and `device`, so keeping less is the point, not a saving. */
export const AUTH_EVENTS_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/** connect_attempts keeps 30 days (cloud 0054): what /privacy states, and what the console reads. */
export const CONNECT_ATTEMPTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Sign-in records, codes, staff sessions and unused invitations go this long past their expiry,
 *  and a session this long after it ended. Past the 30-day history the staff console reads and the
 *  14 days the device-staleness alert reads (`sign-in-horizon-coherence.test.ts`). */
export const SIGN_IN_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/* The deletes, beside it: `sign-in-retention.ts` takes the horizon as an argument, so it never
   imports this file back. */
export {
  pruneSignInRecords, emptySignInRetention, SIGN_IN_SESSION_BATCH, SIGN_IN_RETENTION_DEADLINE_MS,
  type SignInRetentionResult, type SignInRetentionOptions,
} from "./sign-in-retention.js";

/** Accounts visited per maintenance tick (round-robin by account id, wrapping). */
export const RETENTION_ACCOUNTS_PER_TICK = 25;
/** The worker can discover active accounts even when all their mailboxes are disabled. */
export async function retentionAccountsAfter(
  db: Tx, afterAccountId: string, limit: number = RETENTION_ACCOUNTS_PER_TICK, shard?: SQL,
): Promise<string[]> {
  const rows = await db.select({ id: accounts.id }).from(accounts)
    .where(and(isNull(accounts.erasedAt), afterAccountId ? gt(accounts.id, afterAccountId) : undefined, shard))
    .orderBy(asc(accounts.id)).limit(limit);
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

/** One bounded batch of the connect_attempts fixed-age prune, on its full key; loop while full. */
export async function pruneConnectAttempts(
  db: Tx, now: Date, retentionMs: number = CONNECT_ATTEMPTS_RETENTION_MS,
  batch: number = RETENTION_DELETE_BATCH,
): Promise<number> {
  const cut = new Date(now.getTime() - retentionMs);
  const res = await db.execute(sql`
    delete from ${connectAttempts}
     where (${connectAttempts.accountId}, ${connectAttempts.at}, ${connectAttempts.id}) in (
      select ${connectAttempts.accountId}, ${connectAttempts.at}, ${connectAttempts.id} from ${connectAttempts}
       where ${connectAttempts.at} < ${cut.toISOString()}::timestamptz
       order by ${connectAttempts.at}
       limit ${batch}
    )
  `);
  return affected(res);
}
