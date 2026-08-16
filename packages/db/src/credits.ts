import { and, eq, gte, sql } from "drizzle-orm";
import { ledgerSources, type IdempotencyKey } from "./ledger-source.js";
import { TRIAL_GRANT_CREDITS } from "./billing.js";
import { assertTransaction, lockBalance } from "./spend-lock.js";
import { creditBalances, creditLedger } from "./schema.js";
import type { LedgerTx, Tx } from "./change-log.js";

/**
 * The CREDIT primitives, in `packages/db` because the WORKER calls them.
 *
 * The worker may import core + db only (the worker's dependency test pins it); a
 * `packages/services` home would typecheck, pass vitest through the alias, and then throw
 * `MODULE_NOT_FOUND` in the Docker image. `packages/services` holds only the Stripe-facing
 * code, which is API-side.
 *
 * ## THE CALLING CONTRACT: these primitives are transaction-only
 *
 * `debitCredits`, `grantCredits`, `expireCredits` and `renewCredits` MUST be handed a real
 * transaction handle — `db.transaction((tx) => …)`, never a bare `db`. This is not a style
 * preference. On an autocommit handle every statement is its own transaction, so the
 * `SELECT … FOR UPDATE` releases its lock the instant it returns and the ledger INSERT
 * commits BEFORE the balance UPDATE; the entire serialization argument below evaporates and a
 * concurrent storm leaves committed ledger rows the balance never accounted for.
 *
 * Three independent things now enforce it, weakest first:
 *
 *  • the TYPE — {@link LedgerTx} is `PgTransaction`, so `debitCredits(db, …)` does not
 *    compile;
 *  • a RUNTIME guard — {@link assertTransaction} rejects a handle with no `rollback`, which
 *    catches the `as any` and the JS caller;
 *  • the DATABASE — the deferred `credit_ledger_coupled` / `credit_balances_coupled`
 *    constraint triggers refuse to COMMIT a ledger row the balance does not match, so an
 *    autocommit call fails at its first statement instead of corrupting anything.
 *
 * ## The one invariant, at five independent layers
 *
 * "Revenue precedes token spend" must be true by CONSTRUCTION, not by politeness:
 *
 *  1. **the row lock** — every primitive begins with `SELECT balance … FOR UPDATE` on the
 *     account's single `credit_balances` row, so all balance mutations for one account
 *     serialize inside Postgres and a concurrent debit blocks until the winner commits and
 *     then re-reads the NEW balance (READ COMMITTED re-fetches the locked row);
 *  2. **the app-side sufficiency check** — `balance < amount ⇒ insufficient`, decided under
 *     that lock, so it is never a stale read;
 *  3. **the guarded UPDATE** — `WHERE balance >= amount` on the decrement, which THROWS on zero
 *     rows rather than reporting a success the money does not support;
 *  4. **`CHECK (balance >= 0)`** on `credit_balances`, and `CHECK (balance_after >= 0)` on the
 *     ledger row written first — the floors. A future refactor can buy off (1)–(3); it cannot
 *     make Postgres commit a negative balance;
 *  5. **the deferred COUPLING triggers** — at commit, `credit_balances.balance` must equal the
 *     newest ledger row's `balance_after`, and every ledger row must continue the chain
 *     (`balance_after = previous + delta`). A ledger row without a balance movement, or a
 *     balance movement without a ledger row, cannot commit at all — so "the audit trail and
 *     the money disagree" is not a reachable state, whatever code does.
 *
 * That is deliberately more redundancy than any one argument needs, and it was measured rather
 * than assumed: each layer was removed in turn and watched to fail.
 *
 * `test/credits.pg.test.ts` fires 100 concurrent debits of 1 against a balance of
 * 10 across two connection pools and asserts exactly 10 successes, ZERO rejected promises, and
 * `balance_after` values forming exactly {9,8,…,0}. The zero-rejections assertion is what
 * makes it a test of THIS contract rather than of Postgres: an implementation that "passes"
 * the arithmetic by letting CHECK violations fly fails it.
 *
 * ## Statement order, and why it deviates from the arch doc
 *
 * The arch's committed order was (1) balance-guarded `UPDATE … RETURNING`, (2) ledger
 * `INSERT … ON CONFLICT DO NOTHING`, and on conflict "roll the tx back and report duplicate".
 * **That contract is self-contradictory on a caller-owned transaction.** A function handed
 * someone else's transaction cannot both roll it back (`tx.rollback()` throws through the
 * caller) and return a value — and it must not destroy the caller's other work: the webhook
 * tx contains the `billing_events` row that is its dedup gate, and the spend gate's contains the
 * pipeline commit. Savepoints could patch it; the simpler fix is an order in which **no
 * failure outcome writes a ledger row or moves the balance**, so there is nothing to undo.
 * See {@link debitCredits} for the steps.
 *
 * ## The composition contract (the renewal's law)
 *
 * **A caller composing multiple ledger operations in ONE transaction MUST abort the entire
 * transaction the moment ANY operation returns `duplicate`.**
 *
 * This is not pedantry, it is the renewal replay trap. A renewal is
 * `expireCredits(source: expiry:<prior_invoice>)` then `grantCredits(monthly,
 * source: invoice:<invoice>)`. On a first run from balance 0 the expiry writes NO row
 * (`expired: 0`) and the grant lands, so balance = `monthly_credits`. Replay that same tx: the
 * expiry now finds a non-zero balance and — on its own — would happily **expire the fresh
 * grant**. What saves it is that the replayed GRANT returns `duplicate`, the caller throws,
 * and the whole transaction (including the wrongful expiry) rolls back.
 *
 * Because a law that only exists in prose is a law the next caller breaks, the composition is
 * itself a primitive: use {@link renewCredits}, which owns expire-then-grant AND the abort.
 * `test/credits.test.ts` proves both the helper and the counterfactual; the webhook additionally
 * fronts the tx with the `billing_events` claim gate ({@link claimBillingEvent}).
 *
 * The SINGLE-operation contract is different, and the spend gate depends on it — see
 * {@link DebitOutcome}.
 */

/** Reasons that must carry a NEGATIVE delta (`credit_ledger_sign_reason_check`). */
export type DebitReason =
  | "period_expiry" | "debit_classify" | "debit_draft"
  | "debit_propose" | "debit_workflow" | "adjustment_debit";

/**
 * Every reason the sign CHECK admits on a POSITIVE delta — the DATABASE's vocabulary
 * (`credit_ledger_sign_reason_check`), which is a larger set than what {@link grantCredits}
 * accepts. See {@link GrantReason}.
 *
 * `trial_grant` is deliberately its OWN reason rather than an `adjustment_credit` with a
 * different `meta`. Two things turn on the distinction and neither is cosmetic:
 *
 *  · the source-reason CHECK pins `trial_grant` to the `trial:` namespace, and since cloud
 *    migration 0014 the INSERT guard pins it further to `trial:<the row's own account_id>` — so
 *    "one trial bounty per account, ever" is a fact about the TABLE (0013's partial unique index
 *    counts it; 0014 says whose it is) rather than a promise the granting code makes. Under
 *    `adjustment_credit` the source would have to be `admin:<uuid>`, a fresh uuid per call, and
 *    every redelivered subscription event would grant again;
 *  · an `adjustment_credit` row means a human decided something. Reading the ledger to answer
 *    "who has been compensated by staff" must not turn up every trial account in the product.
 */
export type LedgerGrantReason =
  | "invoice_grant" | "refund" | "adjustment_credit" | "trial_grant";

/**
 * The reasons {@link grantCredits} — the GENERIC grant surface — will take.
 *
 * Narrower than {@link LedgerGrantReason} by two entries, and the narrowing is the fix rather
 * than a tidy-up (a review fix, and the same rule applied to `refund`). A reason that has a NAMED
 * primitive is not also on the generic surface, because the properties that make it safe are
 * decided by that primitive and a generic caller can decline every one of them:
 *
 *  · **`trial_grant` ⇒ {@link grantTrialCredits}.** Its AMOUNT is `TRIAL_GRANT_CREDITS`, a
 *    policy constant, and no database layer bounds it: cloud 0013 caps the COUNT at one per
 *    account and cloud 0014 pins the SOURCE to that account, but `grantCredits(tx, A, 5_000_000,
 *    "trial_grant", "trial:" || A)` satisfies both and mints five million credits under the
 *    bounty's name. The size is deliberately NOT a table fact — see {@link grantTrialCredits} on
 *    why the amount must stay out of the row's identity — so THIS is the layer that bounds it.
 *  · **`refund` ⇒ {@link refundCredits}.** The origin read under the balance row lock, the typed
 *    {@link RefundOriginMissingError} / {@link RefundExceedsDebitError}, and the `refund:` prefix
 *    built rather than passed. Cloud 0013's trigger caps the magnitude for every writer, so the
 *    generic surface could not over-refund — what it could do is raise a driver exception from
 *    inside a caller's transaction where the contract promises a typed refusal.
 *
 * Tests that must exercise a database layer BENEATH these primitives write the row through the
 * driver instead (`credits.pg.test.ts`'s `raw` helper, `migration-cloud-0014.roundtrip.test.ts`),
 * which is the honest way to test the table: reaching the constraint means bypassing the app, and
 * the test should say so rather than borrow a typed door that no longer opens.
 */
export type GrantReason = "invoice_grant" | "adjustment_credit";

/**
 * The outcome of a debit. A UNION, never an exception, because the spend gate's caller is
 * `packages/core/src/pipeline.ts`'s AI branch, which has no try/catch around it: a
 * throw there aborts the whole message's routing instead of degrading to rules-only.
 *
 * **The single-operation mapping the spend gate must use:**
 *  • `ok`           → proceed (charged now);
 *  • `duplicate`    → **proceed** — this exact work was already paid for; do not charge
 *                     twice, and do not refuse either;
 *  • `insufficient` → degrade to rules-only (the graceful out-of-credits path).
 *
 * `duplicate` is decided BEFORE sufficiency, and that ordering is load-bearing for exactly
 * this mapping: charge 1 from a balance of 1, then reprocess the same message after a worker
 * restart. A sufficiency-first implementation reads balance 0 and answers `insufficient`, so
 * the worker REFUSES work the customer has already paid for — precisely when the account is
 * out of credits and the refusal is least recoverable.
 *
 * A caller composing SEVERAL ledger operations in one transaction must instead abort the whole
 * transaction on `duplicate` — see the module doc and {@link renewCredits}.
 */
export type DebitOutcome =
  | { ok: true; balanceAfter: number }
  | { ok: false; reason: "insufficient"; balance: number }
  | { ok: false; reason: "duplicate" };

export type GrantOutcome =
  | { ok: true; balanceAfter: number }
  | { ok: false; reason: "duplicate" };

export type ExpireOutcome =
  /** `expired === 0` ⇒ there was nothing to expire and NO ledger row was written. */
  | { ok: true; expired: number }
  | { ok: false; reason: "duplicate" };

/* The ledger-source VOCABULARY and the client-key brand moved to `./ledger-source.js`, a leaf
 * whose only import is `node:crypto`. They are pure string construction, and their CALLERS are
 * mail-half modules that also ship in the desktop engine — so an import edge into THIS module
 * would drag `billing.js`, `admin-db.js` and the whole Cloud schema into that artifact.
 * Re-exported here so `@trafficflow/db/cloud` still presents one ledger surface. */
export {
  clientIdempotencyKey, ledgerSources, type IdempotencyKey,
} from "./ledger-source.js";

/**
 * The largest amount any single operation may move, and the ceiling the balance may reach.
 *
 * `credit_balances.balance` and `credit_ledger.delta` are PostgreSQL `integer`, so anything
 * past 2^31−1 is a raw database exception raised inside the CALLER's transaction — a failure
 * mode outside the outcome union, arriving where the contract promised a value. One billion is
 * comfortably below int32 while being ~50 000 years of the largest plan's monthly grant, so
 * hitting it means a bug or a runaway admin adjustment, and saying so plainly beats an
 * `integer out of range` from three frames down.
 */
export const MAX_CREDIT_AMOUNT = 1_000_000_000;

/** The longest `source` the ledger accepts (`credit_ledger_source_len_check` is the floor). */
export const MAX_SOURCE_LENGTH = 200;

/* THE SERIALIZER AND ITS TRANSACTION GUARD moved to `./spend-lock.ts`, a leaf whose imports are
 * the schema and the tx types. Not a tidy-up: the two SUSPENSION writers now take
 * the same `credit_balances` row lock (so a suspension cannot commit inside a spend's decision
 * window), and `suspension.ts` cannot import THIS module — credits → billing → suspension → credits
 * would be a cycle. The lock order both halves obey is written out there, once.
 *
 * Re-exported, so `cloud.ts`, `billing-service.ts` and `test/credits.test.ts` are unaffected and
 * the class identity `rejects.toThrow(NotInTransactionError)` compares against is unchanged. */
export { NotInTransactionError, lockAccountBalance } from "./spend-lock.js";

/**
 * Thrown when a `source` is reused for a DIFFERENT economic event.
 *
 * `duplicate` means "this exact thing already happened". Reporting it for a row that says
 * something else — a different reason, a different amount — would let a caller that charged
 * the wrong amount, or reused a key it should not have, be told it was an idempotent replay
 * and carry on. That is a bug, so it is an exception rather than an outcome.
 */
export class LedgerIdentityConflictError extends Error {
  constructor(
    readonly accountId: string,
    readonly source: string,
    readonly expected: { reason: string; delta: number | null },
    readonly actual: { reason: string; delta: number },
  ) {
    super(
      `credit_ledger: source ${source} on account ${accountId} already records ` +
        `${actual.reason} ${actual.delta >= 0 ? "+" : ""}${actual.delta}, but this call means ` +
        `${expected.reason}${expected.delta == null ? "" : ` ${expected.delta >= 0 ? "+" : ""}${expected.delta}`}. ` +
        "A source is an economic IDENTITY, not a free-form key.",
    );
    this.name = "LedgerIdentityConflictError";
  }
}

/**
 * Thrown by {@link refundCredits} when the refund names no debit it could reverse.
 *
 * The `credit_ledger_refund_origin` trigger would refuse the row anyway; this is the same fact
 * decided earlier, under the balance row lock, with a NAME the caller can catch instead of a
 * plpgsql RAISE surfacing as a bare driver error from inside its transaction.
 */
export class RefundOriginMissingError extends Error {
  constructor(readonly accountId: string, readonly originalSource: string) {
    super(
      `refundCredits: no DEBIT under source ${originalSource} exists on account ${accountId} — ` +
        "there is nothing to reverse. A refund names the exact source of the charge it refunds.",
    );
    this.name = "RefundOriginMissingError";
  }
}

/**
 * Thrown by {@link refundCredits} when the refund would credit MORE than the original debit
 * moved. An over-refund is never a legitimate runtime state — it is a caller that computed the
 * wrong amount or an attempt to mint credits through the refund path — so it is an exception,
 * not an outcome, exactly like {@link LedgerIdentityConflictError}. It is deliberately NOT a
 * silent clamp: a caller asking to refund 4 against a charge of 3 is wrong about something, and
 * granting 3 while reporting success would hide which.
 */
export class RefundExceedsDebitError extends Error {
  constructor(
    readonly accountId: string,
    readonly originalSource: string,
    readonly requested: number,
    readonly charged: number,
  ) {
    super(
      `refundCredits: refusing to credit ${requested} against ${originalSource} on account ` +
        `${accountId} — the original debit moved only ${charged}. A refund cannot exceed the ` +
        "charge it reverses.",
    );
    this.name = "RefundExceedsDebitError";
  }
}

/**
 * Thrown by {@link renewCredits} when the renewal has already been applied.
 *
 * It exists so the composition contract has a NAME the caller can catch. The webhook catches it
 * OUTSIDE the transaction — by then the whole transaction, including any wrongful expiry, has
 * rolled back — and answers Stripe 200 "already applied". Catching it INSIDE the transaction
 * and continuing is the money corruption the contract forbids.
 */
export class LedgerReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerReplayError";
  }
}

/**
 * `amount` must be a POSITIVE INTEGER within {@link MAX_CREDIT_AMOUNT}. Anything else is a
 * programmer error and throws — the outcome unions are reserved for legitimate runtime states,
 * and an `insufficient` returned for `NaN` would hide a bug behind a plausible-looking
 * business answer.
 */
function assertAmount(amount: number, fn: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`${fn}: amount must be a positive integer, got ${String(amount)}`);
  }
  if (amount > MAX_CREDIT_AMOUNT) {
    throw new Error(`${fn}: amount ${amount} exceeds MAX_CREDIT_AMOUNT (${MAX_CREDIT_AMOUNT})`);
  }
}

/** `source` is an index key and part of it can be client-controlled — bound it in code too. */
function assertSource(source: string, fn: string): void {
  if (source.length === 0 || source.length > MAX_SOURCE_LENGTH) {
    throw new Error(
      `${fn}: source must be 1..${MAX_SOURCE_LENGTH} characters, got ${source.length} — ` +
        "build it with ledgerSources, never by hand",
    );
  }
}

/**
 * Has this exact economic event already been recorded for this account?
 *
 * Read UNDER the balance row lock, which is what makes it decisive rather than advisory: a
 * concurrent same-source writer for the same account cannot be between its own ledger insert
 * and its commit while we hold that lock.
 *
 * `expectedDelta` is `null` where the amount is legitimately variable ({@link expireCredits}
 * expires whatever is there); everywhere else a mismatch is a
 * {@link LedgerIdentityConflictError}, never a quiet `duplicate`.
 */
async function findExistingEvent(
  tx: LedgerTx,
  accountId: string,
  source: string,
  expect: { reason: DebitReason | LedgerGrantReason; delta: number | null },
): Promise<boolean> {
  const rows = await tx
    .select({ reason: creditLedger.reason, delta: creditLedger.delta })
    .from(creditLedger)
    .where(and(eq(creditLedger.accountId, accountId), eq(creditLedger.source, source)))
    .limit(1);
  const existing = rows[0];
  if (!existing) return false;
  if (existing.reason !== expect.reason || (expect.delta != null && existing.delta !== expect.delta)) {
    throw new LedgerIdentityConflictError(accountId, source, expect, existing);
  }
  return true;
}

/**
 * Append a ledger row, reporting whether it was NEW.
 *
 * `ON CONFLICT (account_id, source) DO NOTHING RETURNING id` — zero rows back means this
 * economic event is already recorded for this account. Callers reach this only after
 * {@link findExistingEvent} said otherwise under the row lock, so a conflict here would mean
 * the lock is not serializing; it is kept as the structural backstop, and it writes nothing
 * when it fires.
 */
async function appendLedger(
  tx: LedgerTx,
  row: {
    accountId: string; delta: number; balanceAfter: number;
    reason: DebitReason | LedgerGrantReason; source: string; meta: Record<string, unknown>;
  },
): Promise<boolean> {
  const inserted = await tx
    .insert(creditLedger)
    .values({
      accountId: row.accountId,
      delta: row.delta,
      balanceAfter: row.balanceAfter,
      reason: row.reason,
      source: row.source,
      meta: row.meta,
    })
    .onConflictDoNothing({ target: [creditLedger.accountId, creditLedger.source] })
    .returning({ id: creditLedger.id });
  return inserted.length > 0;
}

/**
 * Spend `amount` credits, at most once per `(accountId, source)`.
 *
 * Runs entirely on the CALLER's transaction and never rolls it back. The statement order is
 * chosen so that **no failure outcome writes a ledger row or moves the balance**, which is
 * what makes the union honest on a shared transaction (see the module doc):
 *
 *  1. `SELECT balance … FOR UPDATE` — the serializer. **No row ⇒ balance 0**: a missing
 *     `credit_balances` row is semantically identical to a zero balance, so no backfill was
 *     ever needed for accounts predating migration 0018.
 *  2. **`duplicate` is decided FIRST**, before sufficiency: an already-recorded `source` means
 *     this work was already paid for, and that stays true at balance 0. Answering
 *     `insufficient` there would make a worker refuse, on restart, work the customer bought.
 *     A source that exists with a different reason or amount is a
 *     {@link LedgerIdentityConflictError}, not a `duplicate`.
 *  3. `balance < amount` ⇒ `insufficient` with the balance the caller may surface.
 *  4. ledger `INSERT … ON CONFLICT DO NOTHING RETURNING id`. `balance_after` is computed from
 *     the LOCKED read, so it is stable.
 *  5. `UPDATE credit_balances SET balance = balance - amount WHERE … AND balance >= amount`.
 *     The `balance >= amount` guard is belt-and-braces — the lock already makes it redundant —
 *     and zero rows here is IMPOSSIBLE, so it throws loudly rather than returning a plausible
 *     lie about the money.
 *
 * Steps 1–3 write nothing at all. (Postgres still burns a `bigserial` value while building the
 * conflicting INSERT in step 4, so the honest claim is "no ledger row and no balance movement"
 * rather than "no database state whatsoever changed".)
 *
 * Same-source concurrency needs no extra machinery: both debits are for the same account, so
 * step 1 serializes them and the loser reaches step 2 after the winner committed, getting a
 * clean `duplicate`.
 *
 * @param tx MUST be a transaction handle — see the module doc.
 * @param source Build it with {@link ledgerSources} — never by hand.
 */
export async function debitCredits(
  tx: LedgerTx,
  accountId: string,
  amount: number,
  reason: DebitReason,
  source: string,
  meta: Record<string, unknown> = {},
): Promise<DebitOutcome> {
  assertTransaction(tx, "debitCredits");
  assertAmount(amount, "debitCredits");
  assertSource(source, "debitCredits");

  const balance = (await lockBalance(tx, accountId)) ?? 0;
  if (await findExistingEvent(tx, accountId, source, { reason, delta: -amount })) {
    return { ok: false, reason: "duplicate" };
  }
  if (balance < amount) return { ok: false, reason: "insufficient", balance };

  const balanceAfter = balance - amount;
  const wrote = await appendLedger(tx, {
    accountId, delta: -amount, balanceAfter, reason, source, meta,
  });
  if (!wrote) return { ok: false, reason: "duplicate" };

  const updated = await tx
    .update(creditBalances)
    .set({ balance: sql`${creditBalances.balance} - ${amount}`, updatedAt: sql`now()` })
    .where(and(eq(creditBalances.accountId, accountId), gte(creditBalances.balance, amount)))
    .returning({ balance: creditBalances.balance });
  const after = updated[0];
  if (!after) {
    // Unreachable while the row lock holds: we read `balance >= amount` under it and nobody
    // else can have changed the row since. If it ever fires, the serialization is broken and
    // the ledger row we just wrote is a lie — fail the transaction rather than report success.
    throw new Error(
      `debitCredits: balance guard failed for account ${accountId} after a locked read — ` +
        "the credit_balances row lock is not serializing",
    );
  }
  return { ok: true, balanceAfter: after.balance };
}

/**
 * Add `amount` credits, at most once per `(accountId, source)`.
 *
 *  1. guard-INSERT `credit_balances (account_id, balance) VALUES ($1, 0) ON CONFLICT DO
 *     NOTHING` — the `allocateSeq` idiom, so there IS a row to lock. A surviving zero-balance
 *     guard row after a `duplicate` outcome is semantically nothing: a missing row and a zero
 *     balance are the same state everywhere in this module.
 *  2. `SELECT balance … FOR UPDATE`.
 *  3. an already-recorded `source` ⇒ `duplicate` (a source recording something ELSE ⇒
 *     {@link LedgerIdentityConflictError}); balance untouched.
 *  4. `UPDATE … SET balance = balance + amount … RETURNING balance`, after the ledger row.
 *
 * @param tx MUST be a transaction handle — see the module doc.
 */
export async function grantCredits(
  tx: LedgerTx,
  accountId: string,
  amount: number,
  reason: GrantReason,
  source: string,
  meta: Record<string, unknown> = {},
): Promise<GrantOutcome> {
  return grantInternal(tx, accountId, amount, reason, source, meta, amount, "grantCredits");
}

/**
 * The body of {@link grantCredits}, with the one thing no exported caller may choose: WHICH PART
 * OF THE ROW IS THE IDENTITY.
 *
 * `identityDelta` is handed to {@link findExistingEvent}. `grantCredits` passes `amount`, so a
 * source recorded at a different size is a {@link LedgerIdentityConflictError} — the right answer
 * for an invoice, where the amount is the money and a second figure under the same invoice id
 * means somebody computed one of them wrong. {@link grantTrialCredits} passes `null`, and the
 * reasoning for that is on it.
 *
 * NOT an optional parameter on the exported function. "Report a duplicate whatever the amount
 * says" is exactly the switch that turns a wrong charge into a silent success, and the only caller
 * entitled to it is the one whose amount is a POLICY CONSTANT rather than a computed sum.
 *
 * Its `reason` is the WIDE {@link LedgerGrantReason} rather than {@link GrantReason} — this is
 * where `refund` and `trial_grant` are written, from the two named primitives that own them. The
 * narrowing is on the EXPORTED door, which is the only one a future caller can reach.
 */
async function grantInternal(
  tx: LedgerTx,
  accountId: string,
  amount: number,
  reason: LedgerGrantReason,
  source: string,
  meta: Record<string, unknown>,
  identityDelta: number | null,
  fn: string,
): Promise<GrantOutcome> {
  assertTransaction(tx, fn);
  assertAmount(amount, fn);
  assertSource(source, fn);

  await tx.insert(creditBalances).values({ accountId, balance: 0 }).onConflictDoNothing();
  const balance = (await lockBalance(tx, accountId)) ?? 0;
  if (await findExistingEvent(tx, accountId, source, { reason, delta: identityDelta })) {
    return { ok: false, reason: "duplicate" };
  }

  const balanceAfter = balance + amount;
  if (balanceAfter > MAX_CREDIT_AMOUNT) {
    // `integer` would take another billion, but a balance this size is a bug or a runaway
    // adjustment, and the transaction has written nothing yet — so say so before it does.
    throw new Error(
      `${fn}: account ${accountId} would reach ${balanceAfter}, past MAX_CREDIT_AMOUNT ` +
        `(${MAX_CREDIT_AMOUNT})`,
    );
  }
  const wrote = await appendLedger(tx, {
    accountId, delta: amount, balanceAfter, reason, source, meta,
  });
  if (!wrote) return { ok: false, reason: "duplicate" };

  const updated = await tx
    .update(creditBalances)
    .set({ balance: sql`${creditBalances.balance} + ${amount}`, updatedAt: sql`now()` })
    .where(eq(creditBalances.accountId, accountId))
    .returning({ balance: creditBalances.balance });
  const after = updated[0];
  if (!after) {
    throw new Error(`${fn}: credit_balances row for account ${accountId} vanished under its own lock`);
  }
  return { ok: true, balanceAfter: after.balance };
}

/**
 * THE REFUND — reverse a debit, bounded by what that debit actually moved.
 *
 * A named primitive rather than `grantCredits(…, "refund", …)` at each call site, for the same
 * reason {@link grantTrialCredits} is one: the properties that make a refund safe have to hold
 * at every caller or they hold nowhere. Three of them, two structural and one decided here:
 *
 *  · **one refund per charge** — the source is `refund:<original_source>`, built HERE, so a
 *    crashed-and-retried refund path answers `duplicate` instead of paying twice
 *    (`UNIQUE (account_id, source)`);
 *  · **it reverses something real** — a refund of nothing, and a refund of a refund, throw
 *    {@link RefundOriginMissingError} (and the `credit_ledger_refund_origin` trigger refuses the
 *    row even for a writer that bypasses this function);
 *  · **it is CAPPED by the original debit** — `amount > |original.delta|` throws
 *    {@link RefundExceedsDebitError}. Because the source admits exactly one refund row per
 *    original, the per-row cap IS the per-scope cap: the total refunded for a charge can never
 *    exceed the charge. Never a silent clamp — an over-cap caller is wrong about something, and
 *    granting less while reporting success would hide which.
 *
 * The origin read happens UNDER the balance row lock (every ledger write for the account holds
 * it, so the debit either committed before we took the lock or does not exist for us), and the
 * same cap is enforced again by the trigger — cloud migration 0013 — which is the layer that
 * survives a refactor of this function.
 *
 * @param tx MUST be a transaction handle — see the module doc.
 * @param originalSource the SOURCE OF THE CHARGE being reversed (e.g. a `draft:` or `classify:`
 *   value), NOT a `refund:` value — this function adds the `refund:` namespace itself.
 */
export async function refundCredits(
  tx: LedgerTx,
  accountId: string,
  amount: number,
  originalSource: string,
  meta: Record<string, unknown> = {},
): Promise<GrantOutcome> {
  assertTransaction(tx, "refundCredits");
  assertAmount(amount, "refundCredits");
  assertSource(originalSource, "refundCredits");
  const source = ledgerSources.refund(originalSource);
  assertSource(source, "refundCredits");

  // The serializer, taken before the origin read so the answer cannot go stale — the same
  // guard-INSERT + lock opening every grant uses (see grantInternal; re-locking there is free).
  await tx.insert(creditBalances).values({ accountId, balance: 0 }).onConflictDoNothing();
  await lockBalance(tx, accountId);

  const originals = await tx
    .select({ delta: creditLedger.delta })
    .from(creditLedger)
    .where(and(eq(creditLedger.accountId, accountId), eq(creditLedger.source, originalSource)))
    .limit(1);
  const original = originals[0];
  if (!original || original.delta >= 0) {
    throw new RefundOriginMissingError(accountId, originalSource);
  }
  if (amount > -original.delta) {
    throw new RefundExceedsDebitError(accountId, originalSource, amount, -original.delta);
  }

  return grantInternal(tx, accountId, amount, "refund", source, meta, amount, "refundCredits");
}

/**
 * Debit the ENTIRE current balance — the no-rollover renewal step.
 *
 * Prefer {@link renewCredits}, which owns the whole renewal. Reach for this directly only for
 * a standalone expiry, and only inside a transaction that aborts on `duplicate`.
 *
 * The amount is computed UNDER the row lock, so the caller can never race a stale read and
 * expire the wrong number.
 *
 *  1. guard-INSERT the zero balance row, then `SELECT balance … FOR UPDATE`. The guard insert
 *     is not cosmetic: with no row, `FOR UPDATE` matches nothing and the call holds NO LOCK at
 *     all, so a concurrent first grant could interleave between a zero-expiry and the renewal
 *     grant and survive un-expired.
 *  2. an already-recorded `source` ⇒ `duplicate` — decided BEFORE the balance is consulted, so
 *     a replayed expiry is reported as a replay even when the balance happens to be 0.
 *  3. `balance === 0` ⇒ `{ ok: true, expired: 0 }` and **NO ledger row** — the sign↔reason
 *     CHECK forbids `delta = 0`, and an empty expiry is not an event, it is the absence of one.
 *  4. ledger insert (`delta = -balance`, `balance_after = 0`), then `UPDATE … SET balance = 0`.
 *
 * **Why the zero case writing nothing is not an idempotency hole.** Step 2 makes a replay of
 * an expiry that DID write a row idempotent on its own. A replay of an expiry that wrote
 * nothing has nothing to conflict with — and on its own would expire a freshly granted balance
 * — but it is never on its own: the renewal pairs it with a grant, the replayed grant returns
 * `duplicate`, and the composition contract aborts the whole transaction, taking the wrongful
 * expiry with it. {@link renewCredits} is that contract, in code.
 *
 * @param tx MUST be a transaction handle — see the module doc.
 */
export async function expireCredits(
  tx: LedgerTx,
  accountId: string,
  source: string,
  meta: Record<string, unknown> = {},
): Promise<ExpireOutcome> {
  assertTransaction(tx, "expireCredits");
  assertSource(source, "expireCredits");

  await tx.insert(creditBalances).values({ accountId, balance: 0 }).onConflictDoNothing();
  const balance = (await lockBalance(tx, accountId)) ?? 0;
  // `delta` is null: an expiry legitimately expires whatever happens to be there, so the
  // AMOUNT is not part of its identity — only that this period's expiry already happened.
  if (await findExistingEvent(tx, accountId, source, { reason: "period_expiry", delta: null })) {
    return { ok: false, reason: "duplicate" };
  }
  if (balance === 0) return { ok: true, expired: 0 };

  const wrote = await appendLedger(tx, {
    accountId, delta: -balance, balanceAfter: 0, reason: "period_expiry", source, meta,
  });
  if (!wrote) return { ok: false, reason: "duplicate" };

  const updated = await tx
    .update(creditBalances)
    .set({ balance: 0, updatedAt: sql`now()` })
    .where(eq(creditBalances.accountId, accountId))
    .returning({ balance: creditBalances.balance });
  if (!updated[0]) {
    throw new Error(`expireCredits: credit_balances row for account ${accountId} vanished under its own lock`);
  }
  return { ok: true, expired: balance };
}

/**
 * THE TRIAL BOUNTY — {@link TRIAL_GRANT_CREDITS}, once per account, for as long as the account
 * exists.
 *
 * A named primitive rather than a `grantCredits(…, "trial_grant", …)` at each call site, because
 * there are two call sites and the amount, the reason and the source have to be identical at
 * both or the guarantee evaporates:
 *
 *  · the subscription-event handler, when a trial row first lands;
 *  · the one-shot backfill, for accounts already trialing when the policy changed.
 *
 * `ledgerSources.trialGrant(accountId)` is keyed by the ACCOUNT, so the guarantee is structural:
 * `UNIQUE (account_id, source)` admits the first of any number of calls, in any order, from
 * either caller, and answers `duplicate` to the rest. A caller that hand-wrote the source could
 * key it by subscription instead and turn a resubscribe into a second bounty; there is nothing to
 * hand-write here — and since cloud 0014 there is nothing to hand-write ANYWHERE, because
 * `credit_ledger_trial_guard` refuses a `trial_grant` INSERT whose source is not
 * `trial:<that row's own account_id>`. That is what makes the sentence above a property of the
 * table rather than of this function: 0013 caps the COUNT at one bounty per account, 0014 says
 * whose it is, and this function is the only door that also decides how big it is.
 *
 * ## `duplicate` is a SUCCESS for both callers, and that is the single-operation contract
 *
 * The composition rule ("abort the whole transaction on any `duplicate`") governs a caller that
 * runs SEVERAL ledger operations in one transaction, because a replayed expiry beside a replayed
 * grant eats a real balance. Neither caller here does: the webhook's trial branch performs the
 * mirror upsert, the retention disabler and this one grant, and none of the first two is a ledger
 * operation. So the mapping is {@link DebitOutcome}'s single-operation one — `duplicate` means
 * "this account already has its bounty", which is exactly the desired end state, and the caller
 * carries on and commits.
 *
 * ## THE AMOUNT IS NOT PART OF THIS SOURCE'S IDENTITY — and that is what makes the constant
 * ## changeable
 *
 * Every other grant passes its `amount` to {@link findExistingEvent}, so a source already
 * recorded at a different size raises {@link LedgerIdentityConflictError}. For an invoice that is
 * exactly right: the amount IS the money, and two figures under one invoice id mean somebody
 * computed one of them wrong.
 *
 * For the bounty it is a POISON PILL, because the amount is a policy constant and constants get
 * edited. Lower {@link TRIAL_GRANT_CREDITS} from 500 to 300 and every account already holding a
 * `trial:<id>` row at +500 stops being a duplicate and starts being a conflict — an EXCEPTION,
 * thrown from inside the caller's transaction:
 *
 *  · the webhook's trial branch aborts, so the SUBSCRIPTION MIRROR write beside it is rolled back
 *    too. Every redelivery does the same, for the three days Stripe retries, and then stops. The
 *    account's mirror is permanently stale over a number that has nothing to do with it;
 *  · the backfill throws on that account instead of skipping it.
 *
 * So `identityDelta` is `null` here. The identity of this row is "this account had its trial
 * bounty" — one fact, keyed by the account, true for the life of the account. How BIG the bounty
 * was on the day it was granted is history: it is on the row, in `delta`, where the ledger keeps
 * history, and no reader is entitled to demand that today's policy match it. A second grant is
 * still impossible; only the reason a second call is refused changes, from "the amounts match" to
 * "the account already has one", which is the guarantee this function actually makes.
 *
 * `expireCredits` passes `null` for the same structural reason (an expiry expires whatever is
 * there), so this is the existing rule applied to the second amount that is not an identity, not
 * a new escape hatch.
 *
 * ## The duplicate check is keyed by the ACCOUNT, not by the source — matching the index
 *
 * Cloud migration 0013 made "one bounty per account" a fact about the TABLE:
 * `credit_ledger_one_trial_grant_idx` is unique on `(account_id) WHERE reason = 'trial_grant'`
 * (un-voided rows), whatever the source string says. The duplicate check here asks the same
 * question, for one reason that matters: a `trial_grant` row that some earlier writer keyed by
 * something other than the account (the exact hole the index closes) would be invisible to a
 * source-keyed check, and this function's INSERT would then surface as a raw unique-violation
 * from inside the webhook's transaction — a driver exception where the contract promises
 * `duplicate`. Asking "does this account have a bounty" makes the answer the index's own, and
 * `duplicate` here still means what it always meant: the end state this call wants is already
 * true. VOIDED rows are excluded exactly as the index excludes them — a voided bounty is one an
 * operator explicitly ruled does not count.
 *
 * @param tx MUST be a transaction handle — see the module doc.
 */
export async function grantTrialCredits(
  tx: LedgerTx,
  accountId: string,
  meta: Record<string, unknown> = {},
): Promise<GrantOutcome> {
  assertTransaction(tx, "grantTrialCredits");
  if (Object.hasOwn(meta, "voided_at")) {
    // The 0013 trial-guard trigger refuses a row born voided (it would silently sidestep the
    // unique index); saying so here keeps the raise out of the caller's transaction.
    throw new Error(
      "grantTrialCredits: meta.voided_at is reserved for the dedup runner's break-glass void — " +
        "a new grant cannot be born voided",
    );
  }

  // Guard-insert + lock first (grantInternal will re-take both; a second lock inside one
  // transaction is free), so the account-level read below cannot be stale.
  await tx.insert(creditBalances).values({ accountId, balance: 0 }).onConflictDoNothing();
  await lockBalance(tx, accountId);
  const existing = await tx
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(
      eq(creditLedger.accountId, accountId),
      eq(creditLedger.reason, "trial_grant"),
      sql`(${creditLedger.meta} ->> 'voided_at') is null`,
    ))
    .limit(1);
  if (existing.length > 0) return { ok: false, reason: "duplicate" };

  return grantInternal(
    tx, accountId, TRIAL_GRANT_CREDITS, "trial_grant",
    ledgerSources.trialGrant(accountId), meta, null, "grantTrialCredits",
  );
}

/**
 * Has this account already had its trial bounty?
 *
 * A READ, so a top-level handle is fine — and it exists for the BACKFILL, which needs to report
 * "N accounts would be granted" before it grants anything. The live path does not consult it:
 * {@link grantTrialCredits} decides under the balance row lock, where the answer cannot be stale,
 * and a check-then-grant in the webhook would be a race with nothing to win.
 *
 * Keyed on `reason = 'trial_grant'` (un-voided) so the question asked is exactly the one
 * uniqueness answers — since cloud 0013 the uniqueness IS the account-keyed partial index
 * `credit_ledger_one_trial_grant_idx`, not the `(account_id, source)` pair. This used to read
 * the `trial:<account_id>` source, which answers a narrower question: a `trial_grant` row keyed
 * some other way (the hole the index closes) would read as "no bounty" and send the backfill
 * into a grant the index refuses.
 */
export async function hasTrialGrant(tx: Tx, accountId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(
      eq(creditLedger.accountId, accountId),
      eq(creditLedger.reason, "trial_grant"),
      sql`(${creditLedger.meta} ->> 'voided_at') is null`,
    ))
    .limit(1);
  return rows.length > 0;
}

/** What a renewal is: last period's credits expire, this period's are granted. */
export interface RenewalInput {
  /** The invoice whose credits are ending. `null` on the very first invoice for an account. */
  priorStripeInvoiceId: string | null;
  stripeInvoiceId: string;
  /** The subscription row's DENORMALIZED `monthly_credits` — never `PLAN_LIMITS`. */
  monthlyCredits: number;
  meta?: Record<string, unknown>;
}

/**
 * THE no-rollover renewal, as ONE primitive: expire the prior period, grant the new one, and
 * abort on any replay.
 *
 * This exists because the composition contract was previously prose plus a helper that lived
 * only in a test file, which is to say it did not exist. Every caller that composes
 * `expireCredits` + `grantCredits` by hand has to remember to throw on `duplicate`; the suite's
 * own counterexample shows what forgetting costs — the replayed expiry eats the freshly
 * granted month and the customer who just paid has nothing.
 *
 * On a replay this throws {@link LedgerReplayError}, which the CALLER must let propagate out of
 * the transaction. That abort is the mechanism: it takes the wrongful expiry with it. Catch it
 * outside the transaction (the webhook answers Stripe 200 — the effect is already recorded).
 *
 * @param tx MUST be a transaction handle, and the caller must not swallow the throw.
 */
export async function renewCredits(
  tx: LedgerTx,
  accountId: string,
  input: RenewalInput,
): Promise<{ expired: number; balanceAfter: number }> {
  assertTransaction(tx, "renewCredits");
  const meta = input.meta ?? {};

  let expired = 0;
  if (input.priorStripeInvoiceId != null) {
    const out = await expireCredits(
      tx, accountId, ledgerSources.periodExpiry(input.priorStripeInvoiceId),
      { ...meta, priorStripeInvoiceId: input.priorStripeInvoiceId },
    );
    if (!out.ok) {
      throw new LedgerReplayError(
        `renewCredits: the expiry for invoice ${input.priorStripeInvoiceId} is already recorded on ` +
          `account ${accountId} — this renewal is a replay; the transaction MUST abort`,
      );
    }
    expired = out.expired;
  }

  const granted = await grantCredits(
    tx, accountId, input.monthlyCredits, "invoice_grant",
    ledgerSources.invoiceGrant(input.stripeInvoiceId), { ...meta, stripeInvoiceId: input.stripeInvoiceId },
  );
  if (!granted.ok) {
    throw new LedgerReplayError(
      `renewCredits: invoice ${input.stripeInvoiceId} has already been granted on account ` +
        `${accountId} — this renewal is a replay; the transaction MUST abort (otherwise the expiry ` +
        "above would consume the credits that invoice already bought)",
    );
  }
  return { expired, balanceAfter: granted.balanceAfter };
}

/**
 * The O(1) balance read: the `credit_balances` row, 0 when absent.
 *
 * **Never `SUM(delta)` over the ledger.** Besides being O(rows), a derived balance is what
 * lets two concurrent debits read the same starting value and both succeed — the exact
 * overspend this design exists to prevent (risk 6). A plain read, so a top-level handle is
 * fine here.
 */
export async function balanceOf(tx: Tx, accountId: string): Promise<number> {
  const rows = await tx
    .select({ balance: creditBalances.balance })
    .from(creditBalances)
    .where(eq(creditBalances.accountId, accountId));
  return rows[0]?.balance ?? 0;
}

/**
 * The invoice id of the account's NEWEST `invoice_grant` ledger row, or `null`.
 *
 * This is THE prior-invoice rule of the renewal (`renewCredits(…, { priorStripeInvoiceId })`),
 * and it is deliberately a ledger read rather than a subscription read — which is what makes
 * one rule cover three cases that a subscription-scoped query gets wrong:
 *
 *  · **the ordinary cycle** — last month's invoice is the newest grant, so its credits expire;
 *  · **resubscribe after cancel** — the newest grant belongs to the CANCELLED subscription, and
 *    that is exactly right: the leftover balance it bought must expire when the new
 *    subscription's first invoice grants. Scoping this to the current subscription id would
 *    return `null` there, no expiry row would be written, and the customer would carry the old
 *    plan's balance into the new one — no-rollover silently broken across the one boundary
 *    nobody tests by hand;
 *  · **the account's genuinely first grant** — no rows, `null`, and `renewCredits` skips the
 *    expiry entirely.
 *
 * `excludeInvoiceId` is defence in depth for a REPLAY. Without it, a replayed `invoice.paid`
 * would find its own grant as the "prior" invoice and try to expire the credits that same
 * invoice bought; `renewCredits`' abort contract still saves it (the replayed grant returns
 * `duplicate` ⇒ `LedgerReplayError` ⇒ the whole transaction, wrongful expiry included, rolls
 * back), but with the exclusion the replay is refused one step earlier, at the expiry's own
 * duplicate check, and the failure is legible instead of clever.
 *
 * Ordered by `id DESC` — the bigserial insertion order, which is the only total order the
 * ledger has (`created_at` can tie inside one transaction). O(1) through
 * `credit_ledger_account_id_desc_idx`.
 *
 * ── THE CALLER MUST HOLD {@link lockAccountBalance} FIRST, and this used to say otherwise ──
 *
 * The previous wording here was "the webhook calls it INSIDE the renewal transaction so the answer cannot
 * go stale between the read and the expiry". **That was false**, and it was the load-bearing kind
 * of false. A plain read inside a transaction is still a READ COMMITTED read: it takes no lock,
 * and the primitives that act on its answer take theirs afterwards. Two paid cycle invoices
 * delivered concurrently therefore both saw the SAME prior invoice, the first expired it and
 * granted, and the second found the expiry already recorded — `LedgerReplayError`, which the
 * webhook correctly reads as "already applied" and answers 200 for. A genuinely paid month
 * vanished, under an event id Stripe would never retry.
 *
 * Being in one transaction orders NOTHING on its own. What orders it is taking the account's
 * `credit_balances` lock before this read, so the loser blocks here and re-reads the ledger the
 * winner left behind — at which point its own prior invoice is the winner's grant and the two
 * cycles compose the way they would have if they had arrived a minute apart.
 *
 * `Tx` is still the parameter type, because this IS only a read and the report/CLI callers have
 * no transaction. The obligation is the acting caller's, and it is pinned by a real-Postgres
 * race test (`billing-renewal-race.pg.test.ts`, in the services suite).
 *
 * The `invoice:` prefix is stripped, so the return value is a bare Stripe invoice id ready to
 * hand back to {@link ledgerSources.periodExpiry} — the round trip through the namespace is
 * `ledgerSources.invoiceGrant(id)` in and `id` out.
 */
export async function latestInvoiceGrantSource(
  tx: Tx,
  accountId: string,
  opts: { excludeInvoiceId?: string } = {},
): Promise<string | null> {
  const filters = [eq(creditLedger.accountId, accountId), eq(creditLedger.reason, "invoice_grant")];
  if (opts.excludeInvoiceId != null) {
    filters.push(sql`${creditLedger.source} <> ${ledgerSources.invoiceGrant(opts.excludeInvoiceId)}`);
  }
  const rows = await tx
    .select({ source: creditLedger.source })
    .from(creditLedger)
    .where(and(...filters))
    .orderBy(sql`${creditLedger.id} desc`)
    .limit(1);

  const source = rows[0]?.source;
  if (source == null) return null;
  // `credit_ledger_source_reason_check` guarantees an `invoice_grant` row's source starts
  // `invoice:`, so this slice is total — but a row written before that CHECK existed, or by a
  // future migration, would produce a nonsense expiry source rather than a silent wrong answer.
  return source.startsWith("invoice:") ? source.slice("invoice:".length) : null;
}

/** One account whose ledger and balance disagree. Empty is the only acceptable result. */
export interface CreditDivergence {
  accountId: string;
  balance: number;
  ledgerSum: number;
  lastBalanceAfter: number | null;
}

/**
 * RECONCILIATION: every account whose `credit_balances.balance` is not what its ledger says.
 *
 * The deferred coupling triggers make divergence uncommittable going forward, so in a healthy
 * database this is always empty — which is exactly what makes it worth running. Its two jobs
 * are (a) proving a RESTORE is trustworthy: `scripts/backup-prod.sh` dumps `credit_ledger` and
 * `credit_balances` in one snapshot and this query is what says the restored pair is coherent,
 * and (b) catching a divergence introduced with triggers disabled, which is the only way one
 * can now arise.
 *
 * ── THE LEDGER-ONLY DIVERGENCE HAS TO NAME SOMEBODY ───────────────────────────────────────
 *
 * The join is FULL OUTER precisely so that a ledger row whose `credit_balances` row is MISSING
 * is reported — and that is the row whose identity was being dropped. Selecting `b.account_id`
 * returned `{accountId: null}` for it, against a declared `accountId: string`, because the
 * balance side is the absent one. Of the shapes this query can find it is the worst one to lose
 * the account of: `balanceOf` reads 0 for that account, so credits an invoice has already been
 * paid for cannot be spent, and the reconciliation an operator runs to find out WHOSE balance to
 * repair named nobody. Hence the `coalesce`.
 *
 * O(ledger rows) — an operator/report query, never a request path.
 */
export async function findCreditDivergence(tx: Tx): Promise<CreditDivergence[]> {
  const rows = await tx.execute<{
    account_id: string; balance: number; ledger_sum: number; last_balance_after: number | null;
  }>(sql`
    select
      -- COALESCE: the join is a FULL OUTER one, so b is the side that can be absent. See the
      -- LEDGER-ONLY paragraph on this function.
      coalesce(b.account_id, l.account_id)           as account_id,
      b.balance                                      as balance,
      coalesce(l.total, 0)::int                      as ledger_sum,
      l.last_balance_after                           as last_balance_after
    from credit_balances b
    full outer join (
      select account_id,
             sum(delta)::int as total,
             (array_agg(balance_after order by id desc))[1] as last_balance_after
        from credit_ledger group by account_id
    ) l on l.account_id = b.account_id
    where coalesce(b.balance, 0) <> coalesce(l.total, 0)
       or coalesce(b.balance, 0) <> coalesce(l.last_balance_after, 0)
    order by 1`);
  const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: typeof rows }).rows;
  return (list as unknown as Array<{
    account_id: string; balance: number; ledger_sum: number; last_balance_after: number | null;
  }>).map((r) => ({
    accountId: r.account_id,
    balance: Number(r.balance),
    ledgerSum: Number(r.ledger_sum),
    lastBalanceAfter: r.last_balance_after == null ? null : Number(r.last_balance_after),
  }));
}
