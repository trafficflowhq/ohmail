import {
  evictOldestBodies, storageUsageOf,
  EVICT_BATCH_BODIES, EVICT_HIGH_WATER_RATIO, EVICT_LOW_WATER_RATIO,
  type Tx,
} from "@trafficflow/db";
import { storageCapOf } from "@trafficflow/db/cloud";
import type { Logger } from "@trafficflow/core";

/**
 * THE ROLLING-WINDOW TRIM — the background half of the at-cap behaviour ratified 2026-08-21.
 *
 * When an account's counted stored-body bytes reach {@link EVICT_HIGH_WATER_RATIO} of its cap,
 * this pass husks its OLDEST stored bodies (headers kept, content emptied,
 * `withheld_reason = 'storage_cap'`) until the counter is back at {@link EVICT_LOW_WATER_RATIO}
 * — so ingest almost always finds headroom and the ordinary at-cap experience is "old mail's
 * stored copy quietly gives way to new", never "new mail stops being stored". The IMAP
 * originals are untouched, always: eviction rewrites the hosted copy only.
 *
 * The band between the two marks is the hysteresis: trimming exactly to the cap would re-arm
 * the trigger on the next message and turn every cycle into a one-message trim. The inline
 * fallback (`reserveBodyBytesEvicting`, in the ingest adapter) covers the burst that outruns
 * this pass between cycles, bounded per body; this pass is what makes that fallback cold.
 *
 * ## Bounds and ordering
 *
 *  · {@link EVICT_ROUNDS_PER_CYCLE} transactions of {@link EVICT_BATCH_BODIES} bodies each per
 *    account per cycle — a lagging account converges across cycles rather than monopolizing one.
 *  · Each round is ONE transaction that locks the `account_storage` row FIRST, then husks —
 *    the module lock order (`packages/db/src/storage.ts`). Registered in the worker's serial
 *    per-account section, like the repair passes, so the two never interleave on one account.
 *  · The probe is two indexed reads (cap, counter); for every account under the high-water mark
 *    the pass is those reads and nothing else.
 *
 * `capBytes === null` (no subscription row) is the roster's own fail-open, inherited: such an
 * account stores unmetered and is never trimmed.
 */
export const EVICT_ROUNDS_PER_CYCLE = 4;

export interface StorageEvictResult {
  /** Whether the account was over its high-water mark at all. */
  ran: boolean;
  evicted: number;
  freedBytes: number;
  /** `true` ⇒ the per-cycle round bound stopped the trim short; the next cycle resumes. */
  capped: boolean;
}

export async function storageEvictPass(
  db: Tx,
  opts: { accountId: string; log?: Logger },
  now: Date,
): Promise<StorageEvictResult> {
  const { accountId } = opts;
  const cap = await db.transaction(async (tx) => storageCapOf(tx as Tx, accountId, now));
  if (cap === null || cap <= 0) return { ran: false, evicted: 0, freedBytes: 0, capped: false };

  const used = await storageUsageOf(db, accountId);
  if (used < cap * EVICT_HIGH_WATER_RATIO) {
    return { ran: false, evicted: 0, freedBytes: 0, capped: false };
  }

  const target = Math.floor(cap * EVICT_LOW_WATER_RATIO);
  let evicted = 0;
  let freedBytes = 0;
  let more = true;
  for (let round = 0; round < EVICT_ROUNDS_PER_CYCLE && more; round++) {
    const result = await db.transaction(async (tx) =>
      evictOldestBodies(tx as Tx, accountId, { targetBytes: target, maxBodies: EVICT_BATCH_BODIES }));
    evicted += result.evicted;
    freedBytes += result.freedBytes;
    more = result.more;
  }
  return { ran: true, evicted, freedBytes, capped: more };
}
