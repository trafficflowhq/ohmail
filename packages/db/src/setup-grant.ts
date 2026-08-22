import { and, asc, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { setupGrants, setupGrantSpends, creditLedger } from "./schema.js";
import { aiActionCost } from "./ledger-source.js";
import { aiRefusalReason } from "./ai-gate.js";
import { effectiveSubscriptionOf, entitlementsFor } from "./billing.js";
import type { AiCreditGate, AiSpendOutcome } from "./ai-gate-port.js";
import type { LedgerTx, Tx } from "./change-log.js";

/**
 * THE SETUP GRANT — a screening-only, expiring credit pool granted once per connected mailbox,
 * SEPARATE from the main credit ledger.
 *
 * ## What it is for
 *
 * A newly connected mailbox arrives with a first-contact backlog that is routinely in the
 * hundreds or thousands of senders, and screening that backlog is the product's first
 * demonstration of itself. The monthly allowance is sized for a RUNNING mailbox, not for that
 * one-time hill: making the customer spend a month's credits on day one means their first month
 * is rules-only from day two. So each connected mailbox brings a one-time
 * {@link SETUP_GRANT_CREDITS_PER_MAILBOX}-credit pool for Screener suggestions alone, alive for
 * {@link SETUP_GRANT_TTL_DAYS} days — long enough for a slow first-contact drain, short enough
 * that it cannot become a standing discount.
 *
 * ## Why a second pool and not a `setup_grant` row on the main ledger
 *
 * Two of the grant's three properties are not expressible on one balance:
 *
 *  · **screening-only** needs the spender to know WHICH pool a debit draws. The main ledger's
 *    debit path cannot tell a Screener classification's credit from a draft's — they are the
 *    same integer.
 *  · **90-day expiry** needs an attributable remainder to expire, and a commingled balance has
 *    none. Worse, the monthly renewal's `period_expiry` zeroes the whole balance at every cycle
 *    boundary, so a main-ledger setup grant would die at the FIRST renewal after connect — days
 *    into its 90 — which is the renewal-boundary hazard the architecture review flagged. The
 *    separate pool designs the hazard out instead of patching around it: `period_expiry` never
 *    sees this table.
 *
 * A setup-funded suggestion therefore writes NOTHING to `credit_ledger` — every invariant on the
 * money audit (balance coupling, sign checks, source namespaces) keeps its exact meaning — and
 * the pool keeps its own idempotency ledger (`setup_grant_spends`, PRIMARY KEY
 * `(account_id, source)`) so a crash-retried suggestion is a free retry here exactly as it is on
 * the main ledger.
 *
 * ## The bound this adds to "no API cost without revenue behind it", stated
 *
 * The pool is prepaid in kind rather than in cash: it exists only on accounts that hold a
 * subscription row (mailbox creation is gated on one), it is granted once per mailbox EVER
 * (`UNIQUE (mailbox_id)`), and mailbox creation is itself capped by the plan's limit. So the
 * ceiling one account can hold is `mailboxLimit × SETUP_GRANT_CREDITS_PER_MAILBOX` of
 * weight-1 screening actions, expiring in 90 days — for a trial account, on top of the trial's
 * own 500. That ceiling is a deliberate acquisition cost on the same argument as the trial
 * bounty, ratified with the 2026-08-21 card.
 */
export const SETUP_GRANT_CREDITS_PER_MAILBOX = 1_500;

/** How long a mailbox's setup pool lives. Days, applied at grant time from the caller's clock. */
export const SETUP_GRANT_TTL_DAYS = 90;

const SETUP_GRANT_TTL_MS = SETUP_GRANT_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Grant a mailbox its setup pool. Called from the hosted mailbox-create transaction, AFTER the
 * allowance gate and the insert — same transaction, so a refused create grants nothing.
 *
 * Idempotent at the table (`ON CONFLICT DO NOTHING` on `setup_grants_mailbox_uq`): a replayed
 * create, a reconnect or a re-enable cannot re-arm a mailbox's grant. Returns whether a grant
 * was written — callers today ignore it; tests read it.
 */
export async function grantSetupCredits(
  tx: Tx, accountId: string, mailboxId: string, now: Date,
): Promise<boolean> {
  // THE LIFETIME CEILING, enforced and not merely advertised (review finding). "Once per
  // mailbox, ever" bounds one UUID — and a disconnect is a soft-disable, so reconnecting the
  // same address mints a NEW row with a new UUID and would mint a new pool with it,
  // indefinitely, while the enabled count never crossed the limit. So the account's TOTAL
  // number of grants is capped at its CURRENT mailbox limit (base + purchased add-ons — the
  // same composition every other limit read makes): exactly the `mailboxLimit × 1 500` ceiling
  // this file's header states. An upgrade or a mailbox add-on raises the cap —
  // revenue arrived — and a downgrade lowers it for FUTURE grants only.
  //
  // No race with itself: every caller sits inside the mailbox-create transaction, which opens
  // by taking the account's allowance lock, so two concurrent creates read this count
  // serially.
  const sub = await effectiveSubscriptionOf(tx, accountId);
  const limit = sub
    ? entitlementsFor({ sub, balance: 0, suspended: false, now }).mailboxLimit
    : 0;
  const held = await tx
    .select({ n: sql`count(*)::int` })
    .from(setupGrants)
    .where(eq(setupGrants.accountId, accountId));
  if (Number((held[0] as { n: number } | undefined)?.n ?? 0) >= limit) return false;

  const rows = await tx
    .insert(setupGrants)
    .values({
      accountId,
      mailboxId,
      granted: SETUP_GRANT_CREDITS_PER_MAILBOX,
      remaining: SETUP_GRANT_CREDITS_PER_MAILBOX,
      expiresAt: new Date(now.getTime() + SETUP_GRANT_TTL_MS),
    })
    .onConflictDoNothing({ target: setupGrants.mailboxId })
    .returning({ id: setupGrants.id });
  return rows.length > 0;
}

/** One account's live setup remainder — what the settings surface shows beside the balance. */
export async function setupPoolOf(
  tx: Tx, accountId: string, now: Date,
): Promise<{ remaining: number; expiresAt: Date | null }> {
  const rows = await tx
    .select({ remaining: setupGrants.remaining, expiresAt: setupGrants.expiresAt })
    .from(setupGrants)
    .where(and(
      eq(setupGrants.accountId, accountId),
      gt(setupGrants.expiresAt, now),
      gt(setupGrants.remaining, 0),
    ));
  if (rows.length === 0) return { remaining: 0, expiresAt: null };
  return {
    remaining: rows.reduce((n, r) => n + r.remaining, 0),
    // The FURTHEST horizon: "usable until" for the whole pool, which is the sentence a settings
    // row can actually say about several grants at once.
    expiresAt: new Date(Math.max(...rows.map((r) => r.expiresAt.getTime()))),
  };
}

/**
 * Wrap a Screener suggestion gate so it draws the setup pool FIRST and falls back to the main
 * balance — the composition the two Screener arms (the request path's `makeScreenerService`
 * gate and the worker's auto-suggest gate) install, and NOBODY else: drafting, the proposer and
 * workflow steps never see this wrapper, which is what "screening-only" means mechanically.
 *
 * Setup-first is a product decision, not an accident of layering: the setup pool expires in 90
 * days and can fund nothing but screening, while the main balance funds everything — so any
 * screening the setup pool can absorb leaves the paid pool for the actions only it can buy.
 *
 * ## How it composes with the inner gate's guarantees
 *
 *  1. **State refusals are the inner gate's, verbatim.** Before drawing, the wrapper asks
 *     {@link aiRefusalReason}; any state refusal (suspended, canceled, `ai_disabled`, …)
 *     delegates straight to the inner gate so the caller sees exactly the refusal it would have
 *     seen — a canceled account cannot spend its setup pool any more than its balance.
 *     `out_of_credits` is the one answer that does NOT delegate, because an empty main balance
 *     is precisely the state the setup pool exists to cover.
 *  2. **Retries are free in both pools, and never cross-charge.** A setup-funded attempt leaves
 *     a `setup_grant_spends` row, found before anything else. A MAIN-funded attempt leaves
 *     `credit_ledger` rows; the wrapper probes for them (the bare source and its `~N` retry
 *     attempts) and delegates when they exist, so the inner gate's own duplicate/attempt logic
 *     answers — the wrapper cannot charge the setup pool for work the ledger already paid for.
 *  3. **Refunds return to the pool that paid.** `refund`/`refundAttempt` reverse a setup draw
 *     exactly once (`refunded_at`), or delegate when the spend was the inner gate's.
 *  4. **Never throws**, like the port demands: a fault in the wrapper is a `fault` outcome for
 *     `spend` and a reported no-op for refunds.
 *
 * The one guarantee it does NOT extend is the exclusive claim: the inner gate's claim is taken
 * only when the spend reaches it. For setup draws the `(account_id, source)` PRIMARY KEY is the
 * serialization — a concurrent second caller blocks on the first's insert and resolves to a free
 * retry, which is the same money outcome the claim buys (one charge per unit of work), traded
 * against a second model call in a race the Screener paths already tolerate elsewhere.
 */
export function withSetupPool(
  db: Tx,
  accountId: string,
  inner: AiCreditGate,
  opts?: { now?: () => Date; onError?: (err: unknown, ctx: { accountId: string; source: string }) => void },
): AiCreditGate {
  const now = opts?.now ?? ((): Date => new Date());
  const amount = aiActionCost("debit_classify");
  const report = opts?.onError ?? ((err, ctx) => {
    console.error(`[setup-grant] draw failed for account ${ctx.accountId} (${ctx.source}):`, err);
  });

  /** `null` ⇒ the wrapper has no answer; ask the inner gate. */
  async function tryDraw(source: string): Promise<AiSpendOutcome | null> {
    return db.transaction(async (tx): Promise<AiSpendOutcome | null> => {
      // (1) — state refusals are the inner gate's, and they run FIRST, before the free-retry
      // read. `aiRefusalReason` probes the STATE with a positive stand-in balance, so
      // `out_of_credits` is its word for "the state itself is spendable" — exactly the accounts
      // (and the only accounts) the pool may serve. Order matters: a crash retry of a
      // setup-funded source on an account that has since been suspended, canceled or switched
      // AI off must be the inner gate's refusal, never a "free retry" that runs a model for an
      // account no gate would admit — the review caught exactly that bypass when the dedup
      // read came first.
      const refusal = await aiRefusalReason(tx as LedgerTx, accountId, now());
      if (refusal !== "out_of_credits") return null;

      // (2) — free retry of a setup-funded attempt. A REFUNDED spend row means the earlier
      // attempt was abandoned (the model faulted and gave the credit back); the retry is a new
      // attempt and falls through to be paid for — by the pool if it still can, else by the
      // inner gate.
      const seen = await tx
        .select({ refundedAt: setupGrantSpends.refundedAt })
        .from(setupGrantSpends)
        .where(and(eq(setupGrantSpends.accountId, accountId), eq(setupGrantSpends.source, source)))
        .limit(1);
      if (seen.length > 0 && seen[0]!.refundedAt === null) {
        return { permitted: true, charged: false, attempt: source };
      }

      // (2, the other pool) — the ledger already paid for this work (the bare source or one of
      // its `~N` retry attempts): the inner gate's duplicate/attempt logic owns it. LIKE over
      // the `(account_id, source)` unique index; `~` is not a LIKE metacharacter.
      const ledgerRows = await tx
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(and(
          eq(creditLedger.accountId, accountId),
          sql`(${creditLedger.source} = ${source} or ${creditLedger.source} like ${source + "~%"})`,
        ))
        .limit(1);
      if (ledgerRows.length > 0) return null;

      // The draw: oldest-expiring grant with enough left, locked. Plain FOR UPDATE (no SKIP):
      // two concurrent draws serialize for the row's lifetime of the statement, which at
      // suggestion volume is the correct trade against skipping a grant that still has credit.
      const grant = await tx
        .select({ id: setupGrants.id })
        .from(setupGrants)
        .where(and(
          eq(setupGrants.accountId, accountId),
          gte(setupGrants.remaining, amount),
          gt(setupGrants.expiresAt, now()),
        ))
        .orderBy(asc(setupGrants.expiresAt), asc(setupGrants.id))
        .limit(1)
        .for("update");
      if (grant.length === 0) return null;

      // The idempotency claim, THEN the money — a conflict here is a concurrent caller that
      // claimed this exact work between our dedup read and now; their charge pays for our run.
      const claimed = await tx
        .insert(setupGrantSpends)
        .values({ accountId, source, grantId: grant[0]!.id, amount })
        .onConflictDoNothing({ target: [setupGrantSpends.accountId, setupGrantSpends.source] })
        .returning({ source: setupGrantSpends.source });
      if (claimed.length === 0) {
        // Two rows can conflict here and they mean opposite things. An UNREFUNDED row is a
        // concurrent caller that claimed this exact work between our dedup read and now — their
        // charge pays for our run, so this is a free retry. A REFUNDED row is history: the
        // earlier attempt was abandoned and its credit given back, the PRIMARY KEY will never
        // admit a second pool claim for this source, so the retry is the inner gate's to price.
        // (Caught by the pg test's refunded-retry case: without the re-read, an abandoned
        // attempt's retry was waved through as "free" and the work ran unpaid, forever.)
        const conflicting = await tx
          .select({ refundedAt: setupGrantSpends.refundedAt })
          .from(setupGrantSpends)
          .where(and(eq(setupGrantSpends.accountId, accountId), eq(setupGrantSpends.source, source)))
          .limit(1);
        if (conflicting[0]?.refundedAt == null) {
          return { permitted: true, charged: false, attempt: source };
        }
        return null;
      }

      await tx
        .update(setupGrants)
        .set({ remaining: sql`${setupGrants.remaining} - ${amount}` })
        .where(eq(setupGrants.id, grant[0]!.id));
      return { permitted: true, charged: true, attempt: source };
    });
  }

  /** Reverse a setup draw exactly once. `true` ⇒ it was ours; `false` ⇒ the inner gate's. */
  async function refundDraw(source: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .update(setupGrantSpends)
        .set({ refundedAt: now() })
        .where(and(
          eq(setupGrantSpends.accountId, accountId),
          eq(setupGrantSpends.source, source),
          isNull(setupGrantSpends.refundedAt),
        ))
        .returning({ grantId: setupGrantSpends.grantId, amount: setupGrantSpends.amount });
      if (rows.length === 0) return false;
      // The credit goes back WHETHER OR NOT the grant has meanwhile expired: the draw was real,
      // so the reversal is too, and an expired grant's remainder is inert (the draw predicate
      // reads `expires_at`), so this cannot resurrect spendability it should not.
      await tx
        .update(setupGrants)
        .set({ remaining: sql`${setupGrants.remaining} + ${rows[0]!.amount}` })
        .where(eq(setupGrants.id, rows[0]!.grantId));
      return true;
    });
  }

  async function spend(source: string, meta?: Record<string, unknown>): Promise<AiSpendOutcome> {
    let drawn: AiSpendOutcome | null = null;
    try {
      drawn = await tryDraw(source);
    } catch (err) {
      // A WRAPPER FAULT IS A FAULT OUTCOME — never a fall-through to the paid gate. The first
      // draft fell through ("the main gate can still answer"), and the review priced it: a
      // transient failure inside `tryDraw` for a source the POOL already funded skips the
      // dedup read, the inner gate finds no ledger row, and one unit of work consumes both a
      // setup credit and a paid one. `fault` is the gate contract's word for exactly this —
      // degrade the suggestion, never move money on an unknown.
      try { report(err, { accountId, source }); } catch { /* reporters never become the outcome */ }
      return { permitted: false, refusal: "fault", error: err };
    }
    return drawn ?? inner.spend(source, meta);
  }

  return {
    spend: (source, meta) => spend(source, meta),
    async tryDebit(source, meta) {
      return (await spend(source, meta)).permitted;
    },
    async refund(source, meta) {
      try {
        if (await refundDraw(source)) return;
      } catch (err) {
        // Report and FALL THROUGH to the inner gate rather than returning: the wrapper's own
        // degradation path is "pool tables unavailable ⇒ the spend fell through to the main
        // balance", and a refund that stopped here would leave exactly that main charge
        // unreversed. Falling through is safe in the other world too — a genuinely
        // setup-funded source never set the inner gate's marker, so its `refund` no-ops, and
        // our unrefunded spends row keeps the retry honest once the tables return.
        try { report(err, { accountId, source }); } catch { /* see above */ }
      }
      return inner.refund(source, meta);
    },
    async refundAttempt(attempt, meta) {
      // Setup attempts are always the bare source, so the attempt IS the spends key.
      try {
        if (await refundDraw(attempt)) return;
      } catch (err) {
        // Same fall-through as `refund`, same argument — the inner ledger's refund-origin
        // trigger refuses an attempt it never debited, so this cannot double-refund.
        try { report(err, { accountId, source: attempt }); } catch { /* see above */ }
      }
      return inner.refundAttempt(attempt, meta);
    },
    ...(inner.release
      ? {
        async release(source: string) {
          // The claim, if any, is the inner gate's; a setup draw holds none.
          await inner.release!(source);
        },
      }
      : {}),
  };
}
