import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  evictOldestBodies, mailboxes, recomputeAccountStorage, storageUsageOf,
  EVICT_BATCH_BODIES, EVICT_HIGH_WATER_RATIO, EVICT_LOW_WATER_RATIO,
  type Tx,
} from "@trafficflow/db";
import { UNMETERED_STORAGE_CAP, type Logger, type StorageCap } from "@trafficflow/core/mail";
import { dialect } from "@trafficflow/db/dialect";

/**
 * THE ROLLING-WINDOW TRIM — the background half of the at-cap behaviour ratified 2026-08-21. When an
 * account's counted stored-body bytes reach {@link EVICT_HIGH_WATER_RATIO} of its cap, this husks its
 * OLDEST stored bodies (headers kept, content emptied, `withheld_reason = 'storage_cap'`) down to
 * {@link EVICT_LOW_WATER_RATIO}, so ingest almost always finds headroom ("old mail's copy quietly gives
 * way", never "new mail stops being stored"); IMAP originals are untouched. The band is hysteresis
 * (trimming to the cap would re-arm on the next message); `reserveBodyBytesEvicting` covers the burst
 * between cycles. {@link EVICT_ROUNDS_PER_CYCLE} transactions of {@link EVICT_BATCH_BODIES} bodies per
 * account per cycle, each locking the `account_storage` row FIRST (`packages/db/src/storage.ts` order), in
 * the serial per-account section. An UNBOUNDED cap is never trimmed (no ceiling to keep under). */
export const EVICT_ROUNDS_PER_CYCLE = 4;

export interface StorageEvictResult {
  /** Whether the account was over its high-water mark at all. */
  ran: boolean;
  evicted: number;
  freedBytes: number;
  /** `true` ⇒ the per-cycle round bound stopped the trim short; the next cycle resumes. */
  capped: boolean;
  /** A "Remove and erase" is still sweeping: its bytes are on the counter, so no trim yet. */
  waitsForErasure?: boolean;
}

export async function storageEvictPass(
  db: Tx,
  opts: {
    accountId: string; log?: Logger; storageCap: (accountId: string) => Promise<StorageCap>;
    /** Names a database call as the database's; the cap above is a remote's and is never wrapped. */
    dbCall?: <T>(op: string, fn: () => Promise<T>) => Promise<T>;
  },
  now: Date,
): Promise<StorageEvictResult> {
  const { accountId } = opts;
  const dbCall = opts.dbCall ?? (<T>(_op: string, fn: () => Promise<T>): Promise<T> => fn());
  // Resolved OUTSIDE any transaction: the answer may be a network hop to whoever operates
  // metering, and one taken inside a transaction holds its connection across that hop.
  const resolved = await opts.storageCap(accountId);
  const cap = resolved === UNMETERED_STORAGE_CAP ? null : resolved;
  if (cap === null || cap <= 0) return { ran: false, evicted: 0, freedBytes: 0, capped: false };

  const used = await dbCall("storageEvict.usage", () => storageUsageOf(db, accountId));
  if (used < cap * EVICT_HIGH_WATER_RATIO) {
    return { ran: false, evicted: 0, freedBytes: 0, capped: false };
  }
  const erasing = await dbCall("storageEvict.erasing", () => db.select({ id: mailboxes.id }).from(mailboxes)
    .where(and(eq(mailboxes.accountId, accountId), isNotNull(mailboxes.erasedAt), isNull(mailboxes.erasureDoneAt)))
    .limit(1));
  if (erasing.length > 0) return { ran: false, evicted: 0, freedBytes: 0, capped: false, waitsForErasure: true };
  // An erase an older worker finished left its bytes on the counter: trim only against a recount.
  const erased = await dbCall("storageEvict.erased", () => db.select({ id: mailboxes.id }).from(mailboxes)
    .where(and(eq(mailboxes.accountId, accountId), isNotNull(mailboxes.erasureDoneAt))).limit(1));
  if (erased.length > 0) {
    const recounted = await dbCall("storageEvict.recount", () => db.transaction(async (tx) =>
      recomputeAccountStorage(tx as Tx, dialect(db), accountId)));
    if (recounted < cap * EVICT_HIGH_WATER_RATIO) return { ran: false, evicted: 0, freedBytes: 0, capped: false };
  }

  const target = Math.floor(cap * EVICT_LOW_WATER_RATIO);
  let evicted = 0;
  let freedBytes = 0;
  let more = true;
  for (let round = 0; round < EVICT_ROUNDS_PER_CYCLE && more; round++) {
    const result = await dbCall("storageEvict.round", () => db.transaction(async (tx) =>
      evictOldestBodies(tx as Tx, dialect(db), accountId,
        { targetBytes: target, maxBodies: EVICT_BATCH_BODIES })));
    evicted += result.evicted;
    freedBytes += result.freedBytes;
    more = result.more;
  }
  return { ran: true, evicted, freedBytes, capped: more };
}
