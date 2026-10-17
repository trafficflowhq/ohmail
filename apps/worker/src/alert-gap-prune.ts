import { pruneAlertDriverGaps, ALERT_DRIVER_GAP_RETENTION_DAYS } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import type { Logger } from "@trafficflow/core/mail";

/**
 * `alert_driver_gaps`' RETENTION (cloud 0048) — a hundred days, deleted after the alert pass that
 * writes the table, on `apiFaultPrunePass`' terms: leader lock held, an empty range when nothing
 * is due. NEVER THROWS — a missed cycle is repaired by the next one.
 */
export async function alertGapPrunePass(
  db: Tx, now: Date, log: Logger, retentionDays: number = ALERT_DRIVER_GAP_RETENTION_DAYS,
): Promise<number> {
  try {
    const removed = await pruneAlertDriverGaps(db, now, retentionDays);
    if (removed > 0) log.info("alert_gap_prune", { removed });
    return removed;
  } catch (err) {
    log.warn("alert_gap_prune_failed", { err });
    return 0;
  }
}
