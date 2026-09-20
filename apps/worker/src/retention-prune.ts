import {
  pruneChangeLogForAccount, retentionAccountsAfter, pruneAuditLog, pruneAuthEvents,
  RETENTION_ACCOUNTS_PER_TICK, RETENTION_DELETE_BATCH, RETENTION_BATCHES_PER_ACCOUNT,
} from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import type { Logger } from "@trafficflow/core/mail";

/**
 * RETENTION (mail 0122) — the pass that ends three tables' unbounded growth. The
 * horizons and the deletes live in `@trafficflow/db/cloud`'s `retention.ts` (ONE place); this is
 * the cadence and the rotation. It rides the hourly maintenance block under the leader lock, so
 * exactly one process prunes, visits {@link RETENTION_ACCOUNTS_PER_TICK} accounts per tick
 * round-robin (position in module state — a restart re-starts the lap, which costs fairness and
 * nothing else), and NEVER THROWS: a retention sweep must not take down a worker that is syncing
 * mail, and a missed tick is repaired by the next one. A host deployed ahead of the migrations is
 * the ordinary failure and is a WARN per account or batch, never an abort.
 */
let rotationAfter = "";

export async function retentionPrunePass(db: Tx, now: Date, log: Logger): Promise<void> {
  try {
    let ids = await retentionAccountsAfter(db, rotationAfter);
    if (ids.length < RETENTION_ACCOUNTS_PER_TICK) {
      // The lap wrapped: refill from the roster's head, skipping any id already in this tick.
      const head = await retentionAccountsAfter(db, "", RETENTION_ACCOUNTS_PER_TICK - ids.length);
      for (const id of head) if (!ids.includes(id)) ids.push(id);
      rotationAfter = head.length > 0 ? head[head.length - 1]! : "";
    } else {
      rotationAfter = ids[ids.length - 1]!;
    }

    let pruned = 0;
    let accounts = 0;
    for (const id of ids) {
      try {
        const r = await pruneChangeLogForAccount(db, id, now);
        pruned += r.deleted;
        accounts += 1;
      } catch (err) {
        log.warn("retention_prune_account_failed", { err });
      }
    }
    if (pruned > 0) log.info("retention_prune_change_log", { accounts, pruned });

    for (const [event, prune] of [
      ["retention_prune_audit_log", pruneAuditLog],
      ["retention_prune_auth_events", pruneAuthEvents],
    ] as const) {
      try {
        let total = 0;
        for (let i = 0; i < RETENTION_BATCHES_PER_ACCOUNT; i++) {
          const n = await prune(db, now);
          total += n;
          if (n < RETENTION_DELETE_BATCH) break;
        }
        if (total > 0) log.info(event, { pruned: total });
      } catch (err) {
        log.warn("retention_prune_failed", { err });
      }
    }
  } catch (err) {
    log.warn("retention_prune_failed", { err });
  }
}
