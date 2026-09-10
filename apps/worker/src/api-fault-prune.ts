import { pruneApiFaults, API_FAULT_RETENTION_MS } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import type { Logger } from "@trafficflow/core/mail";

/**
 * `api_faults`' RETENTION (cloud 0032) — seven days, deleted by the arm that reads the table.
 *
 * It rides the alert cadence rather than a timer of its own: the alert pass is already the only
 * reader, already holds the leader lock, and a `DELETE` on an indexed `at` with nothing due is an
 * empty range scan. `platform_signals` makes the same choice inside its own poller.
 *
 * NEVER THROWS. It runs beside a pass whose whole job is to notice things, and an unhandled
 * rejection here would take down a worker that is syncing mail perfectly well; a retention sweep
 * that missed one cycle is repaired by the next one.
 */
export async function apiFaultPrunePass(
  db: Tx, now: Date, log: Logger, retentionMs: number = API_FAULT_RETENTION_MS,
): Promise<number> {
  try {
    const removed = await pruneApiFaults(db, now, retentionMs);
    if (removed > 0) log.info("api_fault_prune", { removed, retentionMs });
    return removed;
  } catch (err) {
    // A host deployed ahead of the migration is the ordinary reason, and it is a WARN: the board
    // is empty either way and nothing a person sees is wrong.
    log.warn("api_fault_prune_failed", { err });
    return 0;
  }
}
