import {
  AUDIT_LOG_RETENTION_MS, RETENTION_DELETE_BATCH, pruneAuditLog, pruneChangeLogForAccount, type Tx,
} from "@trafficflow/db";
import { ingestIsRunning } from "./store-lanes.js";
import type { Diagnostic } from "./log.js";
import { cadenceDue, stampNow, SYSTEM_CLOCKS, type CadenceClocks, type CadenceStamp } from "./pass-cadence.js";

/**
 * THE LOCAL STORE'S RETENTION — the hosted horizon, on this door. The local door stamps
 * `sessions`/`devices.last_synced_at` on every drain, so the same horizon holds the log back for
 * the window and every paired device. Once an hour per store, one delete batch of each prune
 * (a device pays its own read latency, so the batch is the bound), and never while mail is coming
 * in. No rotation and no leader lock: one store, one account.
 */
export const LOCAL_RETENTION_EVERY_MS = 60 * 60 * 1000;

/** When each store last ran it, keyed by the store's handle — per store, not per mailbox. Both
 *  clocks (`pass-cadence.ts`): neither a clock stepped back nor a suspend skips the hour. */
const lastRunAt = new WeakMap<object, CadenceStamp>();

/** Is a pass owed on this store now? Asked before the upkeep enters the ingest's lane. */
export function localRetentionDue(db: object, clocks: CadenceClocks = SYSTEM_CLOCKS): boolean {
  return !ingestIsRunning() && cadenceDue(lastRunAt.get(db) ?? null, LOCAL_RETENTION_EVERY_MS, clocks);
}

/**
 * One pass: the change-log compaction (floor first, then one batch) and one audit-log batch.
 * Contained — a failure is logged and the next due drain asks again; the floor only rises.
 */
export async function runLocalRetention(
  db: Tx, accountId: string, now: Date, log: Diagnostic, clocks: CadenceClocks = SYSTEM_CLOCKS,
): Promise<void> {
  lastRunAt.set(db, stampNow(clocks));
  try {
    const cl = await pruneChangeLogForAccount(db, accountId, now, { batch: RETENTION_DELETE_BATCH, maxBatches: 1 });
    const audit = await pruneAuditLog(db, now, AUDIT_LOG_RETENTION_MS, RETENTION_DELETE_BATCH);
    if (cl.deleted > 0 || audit > 0) log("local_retention_pruned", { pruned: cl.deleted, removed: audit });
  } catch (err) {
    log("local_retention_failed", {
      err,
      reason: "the local store's retention pass failed; nothing was deleted past its floor and the "
        + "next due drain runs it again",
    });
  }
}
