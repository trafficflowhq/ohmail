import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { creditRefundObligations } from "./schema-cloud.js";
import { dialect } from "./dialect/index.js";
import { readAccountErasedAt } from "./erasure-fence.js";
import type { Tx } from "./change-log.js";
import type {
  RefundObligation, RefundObligationPort, RefundObligationReason, SpendAction, SpendMeta,
} from "./entitlements-port.js";

/**
 * A SPEND THAT BOUGHT NOTHING, AS A DURABLE OBLIGATION (cloud 0036) — record, claim, settle,
 * fault.
 *
 * The invariant: a refund is a ROW, not a call. If the call fails, the row is what makes it
 * happen later. Everything here is keyed on `(account_id, attempt)` — the program's own attempt
 * id — which is what makes recording the same failure twice one debt and a replayed drain unable
 * to pay twice.
 *
 * This module names a Cloud table, so nothing in the desktop engine's import closure may reach
 * it: the drafting path writes through {@link RefundObligationPort}, composed only by a host that
 * has an entitlements program.
 */

/** How long a drain holds a row before another may take it. Two minutes is ten call budgets. */
export const REFUND_OBLIGATION_LEASE_MS = 2 * 60 * 1000;

/** How many debts one drain pass settles. A bound on the pass, never on what is owed. */
export const REFUND_OBLIGATION_BATCH = 50;

/** One debt as the drain reads it back — exactly the release it has to make. */
export interface ClaimedRefundObligation {
  id: string;
  accountId: string;
  action: SpendAction;
  attemptKey: string;
  attempt: string;
  meta: SpendMeta | null;
  reason: RefundObligationReason;
  tries: number;
}

/**
 * RECORD THE DEBT — idempotent, and that is the whole exactly-once story on this side.
 *
 * `ON CONFLICT DO NOTHING` on `(account_id, attempt)`: the first observation of a failed spend
 * owes the reversal, and a retry that observes the same failure again adds nothing. It does NOT
 * update the existing row — a second observation carries no new fact, and clearing `settled_at`
 * on one would resurrect a debt somebody has already been paid.
 */
export async function recordRefundObligation(
  tx: Tx, o: RefundObligation, now: Date = new Date(),
): Promise<void> {
  // THIS WRITER FENCES ITSELF, and it is the one db-layer primitive that has to.
  //
  // Every other one writes inside the CALLER's transaction, so the door that opened it holds the
  // Art. 17 fence. This one deliberately does not: the debt has to survive the transaction that
  // FAILED, which is the whole reason it exists — so it inherits nobody's fence and would happily
  // write a row naming an account the sweep erased a moment earlier. That row would then STAY:
  // `accounts` is the row erasure KEEPS, so this table's `ON DELETE CASCADE` never fires for it.
  //
  // An erased account is owed nothing HERE in any case — `releaseAccount` is what ends its
  // standing with the entitlements program, and this row is only a reminder to dial that program
  // about an account that no longer exists. SHARE, the default: it is ordered against the
  // sweep's exclusive lock and against nothing else.
  const erasedAt = await readAccountErasedAt(tx, dialect(tx), o.accountId);
  if (erasedAt !== null && erasedAt !== undefined) return;
  await tx.insert(creditRefundObligations).values({
    accountId: o.accountId,
    action: o.action,
    attemptKey: o.attemptKey,
    attempt: o.attempt,
    reason: o.reason,
    ...(o.meta ? { meta: o.meta } : {}),
    owedAt: now,
  }).onConflictDoNothing({
    target: [creditRefundObligations.accountId, creditRefundObligations.attempt],
  });
}

/**
 * THE PROGRAM TOOK IT — mark the debt paid, by the pair that identifies it.
 *
 * Scoped `settled_at IS NULL` so a settle can never move an already-settled row's timestamp, and
 * so a late duplicate settle is a no-op rather than a rewrite of when somebody was paid.
 */
export async function settleRefundObligation(
  tx: Tx, accountId: string, attempt: string, now: Date = new Date(),
): Promise<void> {
  await tx.update(creditRefundObligations)
    .set({ settledAt: now, claimedUntil: null, lastFault: null })
    .where(and(
      eq(creditRefundObligations.accountId, accountId),
      eq(creditRefundObligations.attempt, attempt),
      isNull(creditRefundObligations.settledAt),
    ));
}

/**
 * CLAIM UP TO `limit` PENDING DEBTS — one statement, so two drains cannot dial for one row.
 *
 * `FOR UPDATE SKIP LOCKED` inside the sub-select and the lease written in the same statement:
 * a second drain arriving mid-flight skips the locked rows rather than blocking on them, and a
 * drain that dies without settling releases its rows when the lease runs out rather than needing
 * anybody's cleanup. Oldest debt first — somebody has been waiting longest for it.
 *
 * The lease is NOT a promise that the reversal happened; only `settled_at` is. A claimed row
 * whose release is lost comes back to the front by its lease, and the program's own
 * `refund:<attempt>` uniqueness is what makes that re-send safe.
 */
export async function claimRefundObligations(
  tx: Tx, now: Date = new Date(),
  opts: { limit?: number; leaseMs?: number } = {},
): Promise<ClaimedRefundObligation[]> {
  const limit = opts.limit ?? REFUND_OBLIGATION_BATCH;
  const until = new Date(now.getTime() + (opts.leaseMs ?? REFUND_OBLIGATION_LEASE_MS));
  const due = tx.select({ id: creditRefundObligations.id })
    .from(creditRefundObligations)
    .where(and(
      isNull(creditRefundObligations.settledAt),
      or(
        isNull(creditRefundObligations.claimedUntil),
        lt(creditRefundObligations.claimedUntil, now),
      ),
    ))
    .orderBy(asc(creditRefundObligations.owedAt), asc(creditRefundObligations.id))
    .limit(limit)
    .for("update", { skipLocked: true });

  const rows = await tx.update(creditRefundObligations)
    .set({ claimedUntil: until, tries: sql`${creditRefundObligations.tries} + 1` })
    .where(sql`${creditRefundObligations.id} in ${due}`)
    .returning({
      id: creditRefundObligations.id,
      accountId: creditRefundObligations.accountId,
      action: creditRefundObligations.action,
      attemptKey: creditRefundObligations.attemptKey,
      attempt: creditRefundObligations.attempt,
      meta: creditRefundObligations.meta,
      reason: creditRefundObligations.reason,
      tries: creditRefundObligations.tries,
    });

  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    action: r.action as SpendAction,
    attemptKey: r.attemptKey,
    attempt: r.attempt,
    meta: (r.meta ?? null) as SpendMeta | null,
    reason: r.reason as RefundObligationReason,
    tries: r.tries,
  }));
}

/**
 * A DRAIN ATTEMPT THAT DID NOT SETTLE — record the fault by NAME and drop the lease.
 *
 * `fault` is one of this repository's own words, never a driver's message: an error's message can
 * quote a connection string, and this column outlives the request. Dropping the lease here rather
 * than waiting it out is what makes a transient outage cost one cycle instead of two minutes.
 */
export async function noteRefundObligationFault(
  tx: Tx, id: string, fault: string,
): Promise<void> {
  await tx.update(creditRefundObligations)
    .set({ claimedUntil: null, lastFault: fault.slice(0, 200) })
    .where(and(
      eq(creditRefundObligations.id, id),
      isNull(creditRefundObligations.settledAt),
    ));
}

/** What this account is still owed, oldest first. The read a test and an operator make. */
export async function pendingRefundObligations(
  tx: Tx, accountId: string,
): Promise<ClaimedRefundObligation[]> {
  const rows = await tx.select({
    id: creditRefundObligations.id,
    accountId: creditRefundObligations.accountId,
    action: creditRefundObligations.action,
    attemptKey: creditRefundObligations.attemptKey,
    attempt: creditRefundObligations.attempt,
    meta: creditRefundObligations.meta,
    reason: creditRefundObligations.reason,
    tries: creditRefundObligations.tries,
  }).from(creditRefundObligations)
    .where(and(
      eq(creditRefundObligations.accountId, accountId),
      isNull(creditRefundObligations.settledAt),
    ))
    .orderBy(asc(creditRefundObligations.owedAt), asc(creditRefundObligations.id));

  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    action: r.action as SpendAction,
    attemptKey: r.attemptKey,
    attempt: r.attempt,
    meta: (r.meta ?? null) as SpendMeta | null,
    reason: r.reason as RefundObligationReason,
    tries: r.tries,
  }));
}

/**
 * The port over a database handle — what a hosted composition hands the drafting path.
 *
 * It takes the handle rather than a transaction because the obligation must survive whatever the
 * caller's transaction does: a debt recorded inside a transaction that then rolls back is the
 * defect this table exists to close, wearing a different shape.
 */
export function refundObligationsOn(db: Tx, now: () => Date = () => new Date()): RefundObligationPort {
  return {
    async owe(o) { await recordRefundObligation(db, o, now()); },
    async settle(accountId, attempt) { await settleRefundObligation(db, accountId, attempt, now()); },
  };
}
