import { eq } from "drizzle-orm";
import { creditBalances } from "./schema.js";
import type { LedgerTx } from "./change-log.js";

/**
 * THE PER-ACCOUNT SPEND MUTEX — the `credit_balances` row lock, on its own, in a leaf module.
 *
 * ## Why it is not in `credits.ts` any more
 *
 * It used to be, and it belonged there while the credit primitives were its only takers. They are
 * not any more: since the suspension-race fix the two SUSPENSION writers take it too, so that a suspension
 * cannot become durable in the window between a spend's entitlement read and that spend's commit.
 * `suspension.ts` cannot import `credits.ts` — `credits.ts` imports `billing.ts` for
 * `TRIAL_GRANT_CREDITS` and `billing.ts` imports `suspension.ts` for `suspendedAccountIds`, so the
 * edge would close a three-module cycle. Moving the lock (and the transaction assert it needs) into
 * a leaf that imports only the schema and the tx types is what lets both halves take the SAME lock
 * rather than two subsystems each inventing one.
 *
 * `credits.ts` re-exports {@link lockAccountBalance} and {@link NotInTransactionError}, so every
 * existing importer — `cloud.ts`, `billing-service.ts`, `test/credits.test.ts` — is
 * unaffected, and the class identity `expect(...).rejects.toThrow(NotInTransactionError)` compares
 * against is the same object it always was.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LOCK ORDER, STATED ONCE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   1. the account's `credit_balances` row — `SELECT … FOR UPDATE`, this function;
 *   2. `account_suspensions` for that account — READ by the AI spend gate, INSERTed by the two
 *      suspension writers in `suspension.ts`.
 *
 * **Every transaction that touches both takes them in that order and no other.** That is the whole
 * suspension-race fix: the gate used to read (2) and then take (1), and the revenue-reversal writer
 * took neither — so a spend could read "not suspended", queue behind the balance lock, and commit
 * its debit after Stripe had already taken the money back. Now the gate re-reads (2) with (1) held,
 * and the suspension writers take (1) before they write (2), so a spend either commits BEFORE the
 * suspension is durable or observes it. There is no third outcome.
 *
 * ### Why the ordering is deadlock-free, rather than merely consistent
 *
 * A consistent order is the usual argument, and here there is a stronger one available: **the two
 * sides share exactly ONE lock.**
 *
 *  · the spend side never LOCKS `account_suspensions` — it reads it, and a READ COMMITTED read
 *    takes no row lock at all. So the only lock a spend and a suspension writer can both want is
 *    the `credit_balances` row, and a single shared lock cannot form a cycle;
 *  · two suspension writers racing each other take (1) then (2) in the same order, and the
 *    `account_suspensions` PRIMARY KEY decides which of them wrote;
 *  · `resumeAccount` takes only (2) (a `DELETE`) and never asks for (1) afterwards, so it takes a
 *    strict subset and cannot close a cycle either;
 *  · the gate's `ai_attempt_claims` tuple lock (the exclusive work claim) is taken strictly BEFORE (1) and
 *    never after, and no suspension writer touches that table;
 *  · the webhook's `billing_events` claim row is likewise held before (1), and no spend ever
 *    touches `billing_events`.
 *
 * `test/spend-suspension-race.pg.test.ts` races a reversal against eight spends on
 * separate physical connections and asserts that every one of them completes with no `40P01`.
 *
 * ### The two sides take the lock through DIFFERENT doors, and that asymmetry is the design
 *
 * Do not "tidy" it into symmetry — each side needs the property the other cannot have:
 *
 *  · the SUSPENSION WRITERS use {@link lockAccountBalance}, the guard-INSERTing door, because a
 *    vacuous lock on their side would evaporate the whole ordering for any account that has never
 *    held a credit balance. They are about to write a row anyway, so the insert costs nothing;
 *  · the SPEND GATE uses {@link lockExistingBalance}, the non-writing door, because its decision is
 *    usually a REFUSAL and a refusal must leave the database untouched. Its `null` case is not a
 *    hole: `null` means no committed ledger history (the trigger below enforces that), so the gate
 *    cannot permit, and it refuses instead of proceeding on an unheld lock.
 *
 * The two compose without a gap. An account with no balance row is refused by the gate outright; the
 * moment a reversal has committed, the row exists and every later spend locks it and sees the
 * suspension underneath.
 */

/** Thrown when a primitive is handed a top-level db handle instead of a transaction. */
export class NotInTransactionError extends Error {
  constructor(fn: string) {
    super(
      `${fn}: must be called INSIDE a transaction (db.transaction((tx) => …)), not on a top-level ` +
        "db handle. On an autocommit handle the SELECT … FOR UPDATE lock is released at the end of " +
        "its own statement and the ledger row commits before the balance moves, so concurrent " +
        "callers silently diverge the ledger from the balance.",
    );
    this.name = "NotInTransactionError";
  }
}

/**
 * A transaction has `rollback()`; a top-level `PgDatabase` does not. Cheap, driver-agnostic,
 * and it catches the `as any` that the type alone cannot.
 */
export function assertTransaction(tx: LedgerTx, fn: string): void {
  if (typeof (tx as unknown as { rollback?: unknown }).rollback !== "function") {
    throw new NotInTransactionError(fn);
  }
}

/**
 * `SELECT balance FROM credit_balances WHERE account_id = $1 FOR UPDATE` — THE serializer, and the
 * ONLY door that takes it without writing anything. `null` ⇒ there is no row, so **no lock is
 * held**; every other return value means the lock is ours until this transaction ends.
 *
 * ## Why a caller would want the non-writing door, and what it owes in exchange
 *
 * {@link lockAccountBalance} guard-INSERTs so that the lock is unconditionally real, and that is
 * the right trade for every caller that is about to move money anyway. The AI spend gate is not
 * one: it takes this lock on the way to a decision that is usually a REFUSAL, and a refusal there
 * must leave the database untouched — the metering assertion (`ai-metering.test.ts`, in the
 * services suite) compares every
 * row of every table in a refused world against a world with no gate at all, and a zero-balance
 * guard row is a difference even though the schema calls it nothing.
 *
 * The price is that a `null` here is not a lock, so a caller must not act on anything it read
 * afterwards. **What makes that safe for the gate is a fact the DATABASE enforces, not a
 * convention:** the deferred `credit_ledger_coupled` trigger (cloud 0002) refuses to commit a
 * transaction that leaves an account with ledger history and no `credit_balances` row —
 * *"account % has ledger history but no credit_balances row"*. So `null` means the account has NO
 * committed ledger history at all, which means `debitCredits` could only ever answer
 * `insufficient` for it, which means the gate cannot permit. The gate therefore refuses on `null`
 * outright rather than reasoning about a lock it does not hold.
 */
export async function lockExistingBalance(tx: LedgerTx, accountId: string): Promise<number | null> {
  assertTransaction(tx, "lockExistingBalance");
  return lockBalance(tx, accountId);
}

/** The same statement, for the callers inside `credits.ts` that guard-INSERT first themselves. */
export async function lockBalance(tx: LedgerTx, accountId: string): Promise<number | null> {
  const rows = await tx
    .select({ balance: creditBalances.balance })
    .from(creditBalances)
    .where(eq(creditBalances.accountId, accountId))
    .for("update");
  const row = rows[0];
  return row ? row.balance : null;
}

/**
 * Take the account's `credit_balances` row lock WITHOUT moving any money.
 *
 * Every primitive in `credits.ts` opens with `SELECT balance … FOR UPDATE`, and that lock is the
 * serializer the whole design rests on. This exposes it on its own for the case the primitives
 * cannot cover: a caller that must READ something else — the ledger, the subscription mirror,
 * `account_suspensions` — and then act on the answer, where "and then" is a window another
 * transaction can commit inside.
 *
 * **Being inside one transaction is NOT serialization.** Under PostgreSQL's default READ
 * COMMITTED, two transactions each read the pre-state, each take the lock afterwards, and the
 * second acts on an answer the first has already invalidated. The only thing that orders them is
 * taking the lock BEFORE the read — which is what this is for. Three callers:
 *
 *  · `packages/services`' `invoice.paid` handler, ordering a ledger read against a grant.
 *    A real-Postgres race test (`billing-renewal-race.pg.test.ts`) is the proof: without this call
 *    two distinct paid cycle invoices lose one of the two allowances;
 *  · the AI spend gate, ordering its `account_suspensions` re-read against the debit —
 *    through {@link lockExistingBalance}, the non-writing door, for the reason stated there;
 *  · both suspension writers in `suspension.ts`, so that the row they commit is visible to every
 *    spend that debits after them. See the lock order at the top of this file.
 *
 * The guard INSERT is the {@link import("./credits.js").grantCredits} one, and it is not cosmetic
 * here either: with no row, `FOR UPDATE` matches nothing and the caller holds NO LOCK AT ALL while
 * believing it does. A surviving zero-balance row is semantically nothing — a missing row and a
 * zero balance are the same state everywhere in `credits.ts`.
 *
 * @param tx MUST be a transaction handle — a lock taken on an autocommit handle is released by
 *           the statement that took it, which is the same as never taking it.
 * @returns the balance under the lock; a missing row reads 0, as everywhere else in `credits.ts`.
 */
export async function lockAccountBalance(tx: LedgerTx, accountId: string): Promise<number> {
  assertTransaction(tx, "lockAccountBalance");
  await tx.insert(creditBalances).values({ accountId, balance: 0 }).onConflictDoNothing();
  return (await lockBalance(tx, accountId)) ?? 0;
}
