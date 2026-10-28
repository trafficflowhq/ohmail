import { eq, inArray } from "drizzle-orm";
import { dialect } from "./dialect/index.js";
import { fencedAccountWrite } from "./erasure-fence.js";
import { accountStorageHolds } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";
import type { AccessVerdict, TrialStorageCarry } from "./entitlements-port.js";

/**
 * A LOWER STORAGE LIMIT WAITS (cloud 0055). When the plan's own limit drops (a downgrade, a removed
 * add-on, a staff change), every cap reader keeps the previous limit for {@link STORAGE_DROP_GRACE_MS},
 * ending at the next 00:00 UTC, and the storage notice says from when the lower one applies: the same
 * three facts the trial's floor states (cap, plan limit, date). A rise to the held limit cancels it.
 * The trial floor's own end opens no hold: that date was already told. The cap is never below the
 * program's limit, so nothing is emptied earlier than without the hold.
 */
export const STORAGE_DROP_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One account's stored hold: the plan's own limit as last seen, and the held limit with its end. */
export interface StorageHold {
  seen: number;
  held: number | null;
  until: Date | null;
}

/** What a cap reader applies: the cap, the plan's own lower limit while one is above it, and its date. */
export interface StorageLimit {
  capBytes: number;
  planBytes: number | null;
  /** ISO instant the plan's limit applies; null inside an unpaid trial's floor (no date yet). */
  dropsAt: string | null;
}

/** The next 00:00 UTC at or after `ms`. */
export function utcDayCeil(ms: number): number {
  return Math.ceil(ms / DAY_MS) * DAY_MS;
}

/** The plan's own limit: inside the trial's floor the carried one, else the program's. */
export function planOwn(limit: number, carry: TrialStorageCarry | null): number {
  return carry && carry.planBytesLimit < limit ? carry.planBytesLimit : limit;
}

function holding(h: StorageHold, now: Date): h is StorageHold & { held: number; until: Date } {
  return h.held !== null && h.until !== null && h.until.getTime() > now.getTime();
}

/** The row after a reading of the plan's own limit `plan`. */
export function nextStorageHold(prev: StorageHold | null, plan: number, now: Date): StorageHold {
  if (prev === null) return { seen: plan, held: null, until: null };
  // A further drop or a partial rise keeps the hold and its date.
  if (holding(prev, now) && prev.held > plan) return { seen: plan, held: prev.held, until: prev.until };
  if (plan < prev.seen) {
    return { seen: plan, held: prev.seen, until: new Date(utcDayCeil(now.getTime() + STORAGE_DROP_GRACE_MS)) };
  }
  return { seen: plan, held: null, until: null };
}

/** The limit a cap reader applies, from the program's limit, the trial carry and the stored hold. */
export function storageLimitFrom(
  limit: number, carry: TrialStorageCarry | null, hold: StorageHold | null, now: Date,
): StorageLimit {
  const plan = planOwn(limit, carry);
  const active = limit > 0 && hold !== null && holding(hold, now) && hold.held > limit;
  const capBytes = active ? hold.held! : limit;
  const planBytes = plan < capBytes ? plan : null;
  const dropsAt = active ? hold.until!.toISOString() : planBytes !== null ? carry?.until ?? null : null;
  return { capBytes, planBytes, dropsAt };
}

function sameHold(a: StorageHold | null, b: StorageHold): boolean {
  return a !== null && a.seen === b.seen && a.held === b.held
    && (a.until === null ? b.until === null : b.until !== null && a.until.getTime() === b.until.getTime());
}

const holdColumns = {
  accountId: accountStorageHolds.accountId, seen: accountStorageHolds.seenBytes,
  held: accountStorageHolds.heldBytes, until: accountStorageHolds.heldUntil,
};

const asHold = (r: { seen: number; held: number | null; until: Date | null }): StorageHold =>
  ({ seen: Number(r.seen), held: r.held === null ? null : Number(r.held), until: r.until });

/** The stored holds of these accounts, read only (the at-cap reading). */
export async function storageHoldsOf(db: Tx, accountIds: readonly string[]): Promise<Map<string, StorageHold>> {
  const out = new Map<string, StorageHold>();
  if (accountIds.length === 0) return out;
  const rows = await db.select(holdColumns).from(accountStorageHolds)
    .where(inArray(accountStorageHolds.accountId, [...accountIds]));
  for (const r of rows) out.set(r.accountId, asHold(r));
  return out;
}

/**
 * THE ONE WRITER: the limit this verdict means for this account, after recording the reading. `null` is
 * no cap (unmetered, no limit, or a refusal), as before. A limit at or below zero is applied as stated and
 * nothing is written. One primary-key read; a changed row is written in its own fenced transaction,
 * accounts row first, then this row. Throws on a database fault or an erased account.
 */
export async function heldStorageLimitOf(
  db: Tx, accountId: string, verdict: AccessVerdict, now: Date,
): Promise<StorageLimit | null> {
  if (!verdict.ok) return null;
  const limit = verdict.limits.storageBytes;
  if (limit === null) return null;
  const carry = verdict.trialStorage ?? null;
  if (limit <= 0) return storageLimitFrom(limit, carry, null, now);
  const plan = planOwn(limit, carry);
  const [row] = await db.select(holdColumns).from(accountStorageHolds)
    .where(eq(accountStorageHolds.accountId, accountId)).limit(1);
  const stored = row ? asHold(row) : null;
  let next = nextStorageHold(stored, plan, now);
  if (!sameHold(stored, next)) {
    next = await fencedAccountWrite(db, { accountId }, async (tx) => {
      await tx.insert(accountStorageHolds).values({ accountId, seenBytes: plan, updatedAt: now }).onConflictDoNothing();
      const [locked] = await dialect(tx).forUpdate(tx.select(holdColumns).from(accountStorageHolds)
        .where(eq(accountStorageHolds.accountId, accountId)));
      const prev = asHold(locked!);
      const n = nextStorageHold(prev, plan, now);
      if (!sameHold(prev, n)) {
        await tx.update(accountStorageHolds)
          .set({ seenBytes: n.seen, heldBytes: n.held, heldUntil: n.until, updatedAt: now })
          .where(eq(accountStorageHolds.accountId, accountId));
      }
      return n;
    });
  }
  return storageLimitFrom(limit, carry, next, now);
}
