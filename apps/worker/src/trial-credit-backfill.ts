import { eq } from "drizzle-orm";
import {
  billingSubscriptions, grantTrialCredits, hasTrialGrant,
} from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { silentLogger, type Logger } from "@trafficflow/core";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE TRIAL-BOUNTY BACKFILL — one-shot, DB-only, dry-run by default
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHY THIS EXISTS AND WHY IT IS NOT A MIGRATION STATEMENT ────────────────────────────────

   The trial used to grant no credits. It now grants a fixed bounty when the subscription mirror
   first says `trialing` — and that handler only ever runs on a FUTURE subscription event, so
   accounts already sitting in a trial when the policy changed would sit out the rest of it with
   an empty balance while the interface tells them what a trial includes.

   The obvious place to fix that is the migration that taught the ledger the new reason. It is the
   wrong place. A migration that moves money cannot be rehearsed against a copy, cannot report what
   it did, and runs inside a deploy where a half-answer is least recoverable. This is a runner
   instead: it counts first, writes only when asked, prints what it found, and can be run again.

   ── IDEMPOTENT BY CONSTRUCTION, NOT BY CARE ────────────────────────────────────────────────

   Every grant is written under `trial:<account_id>`, the same source the live path uses, and
   `credit_ledger` is `UNIQUE (account_id, source)`. So this pass and the webhook cannot race into
   two grants, running this twice cannot grant twice, and running it BEFORE the deploy that adds
   the live path is as safe as running it after. `hasTrialGrant` below is a reporting read only —
   it is what lets a dry run say "would grant N" — and the decision that matters is made under the
   balance row lock inside `grantTrialCredits`, where it cannot be stale.

   ── WHO IS ELIGIBLE: THE LIVE ROW SAYS `trialing`, AND NOTHING ELSE IS CONSULTED ────────────

   `SELECT account_id FROM billing_subscriptions WHERE status = 'trialing'` is exact, and it is
   exact for a structural reason rather than by luck: `trialing` is one of the LIVE statuses, and
   the partial unique index `billing_sub_one_live_idx` admits at most one live row per account. So
   a `trialing` row IS the account's current subscription — there is no ordering to apply and no
   dead row that could outrank it. Deliberately NOT routed through the shared "what is this
   account's subscription state" read: that read exists to pick between candidate rows, this
   question has only ever one candidate, and importing the entitlement decision here would put a
   second copy of it in a script.

   Suspension is deliberately not consulted either. A suspended account's entitlement already
   refuses AI whatever its balance is, so withholding the bounty would change nothing today and
   would quietly deny it for ever to an account that is later un-suspended — a grant that cannot be
   re-attempted, because this pass is meant to be run once.

   ── THE ONE PROPERTY THIS PASS MUST NOT HAVE ───────────────────────────────────────────────

   It must not decide an AMOUNT. It calls `grantTrialCredits`, which takes no number: the policy
   module owns the figure, so a runner can never hand out more than the product's own bounty.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

export interface TrialBackfillDeps {
  db: Tx;
  /** False ⇒ dry run: count and report, write nothing. */
  apply: boolean;
  log?: Logger;
}

export interface TrialBackfillResult {
  /** Accounts whose live subscription row says `trialing`. */
  trialing: number;
  /** Of those, the ones with no trial grant recorded yet (dry run: would be granted). */
  eligible: number;
  /** Grants actually written. Always 0 on a dry run. */
  granted: number;
  /**
   * Accounts that were eligible on the reporting read and answered `duplicate` at grant time —
   * i.e. the webhook (or another copy of this pass) got there first between the two.
   *
   * Reported rather than folded into `granted` because it is the one number that says the
   * idempotency actually did something, and a run where it is non-zero is a run that raced and
   * was still correct.
   */
  raced: number;
  /**
   * Accounts whose own transaction THREW and rolled back. Every other account was still
   * attempted — see the isolation paragraph on {@link runTrialCreditBackfill}.
   *
   * A number and a log line rather than a rethrow, because the alternative is the failure this
   * field exists to end: one bad account taking the whole remaining population with it while the
   * header promised the opposite.
   */
  failed: number;
}

/**
 * Grant the trial bounty to every account currently on a trial that has not had it.
 *
 * ONE TRANSACTION PER ACCOUNT, and that is the point rather than a performance oversight: an
 * account whose grant fails must not take the rest of the population with it, and a single
 * transaction over hundreds of accounts would hold hundreds of `credit_balances` row locks
 * against a live webhook. There is no ordering requirement between accounts.
 *
 * ── AND THE TRANSACTION BOUNDARY IS ONLY HALF OF THAT — the `try` is the other half ─────────
 *
 * A rolled-back transaction still throws, and an exception that leaves this function ends the
 * pass: the accounts after the failing one are never attempted, the summary line never prints,
 * and a rerun stops at the same account again. The one-transaction-per-account design would have
 * been true of the DATA and false of the RUN, which is the more expensive half to get wrong for a
 * one-shot pass an operator watches once.
 *
 * The measured trigger is an account already holding more than `MAX_CREDIT_AMOUNT − bounty`, but
 * the catch is deliberately not narrowed to it: an FK violation, a serialization failure, a
 * dropped connection and a constraint the ledger learns next year all have this control flow, and
 * none of them is a reason to withhold the bounty from unrelated accounts. Each failure is
 * counted and logged with its account id, so the pass reports what it could not do instead of
 * stopping to say it.
 *
 * Rerunning remains safe for the same reason it always was — `trial:<account_id>` — so the repair
 * is "fix the named account, run it again", with the accounts that already succeeded answering
 * `duplicate`.
 */
export async function runTrialCreditBackfill(
  deps: TrialBackfillDeps,
): Promise<TrialBackfillResult> {
  const { db, apply } = deps;
  const log = deps.log ?? silentLogger;

  const rows = await db
    .select({ accountId: billingSubscriptions.accountId })
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.status, "trialing"));
  // One live row per account is an index guarantee, not an assumption — but de-duplicating here
  // costs nothing and means a future widening of the eligible set cannot turn into double work.
  const accountIds = [...new Set(rows.map((r) => r.accountId))];

  const result: TrialBackfillResult = {
    trialing: accountIds.length, eligible: 0, granted: 0, raced: 0, failed: 0,
  };

  for (const accountId of accountIds) {
    // The reporting read is outside the try on purpose: it is `hasTrialGrant`, an indexed
    // single-row SELECT, and if THAT is throwing the database is not answering at all — a
    // condition to stop on rather than to count once per account for the whole population.
    if (await hasTrialGrant(db, accountId)) continue;
    result.eligible++;
    if (!apply) continue;

    let outcome;
    try {
      outcome = await db.transaction((tx) => grantTrialCredits(tx, accountId, {
        backfill: true,
      }));
    } catch (err) {
      // ISOLATION, not tolerance — see the header. The account's transaction has already rolled
      // back; what this decides is only whether the accounts AFTER it get their bounty.
      result.failed++;
      log.error("trial credit backfill: account skipped", {
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (outcome.ok) {
      result.granted++;
      log.info("trial credit granted", { accountId, balanceAfter: outcome.balanceAfter });
    } else {
      // `duplicate` is the only non-ok outcome the primitive has, and here it means the live path
      // granted between the read above and this transaction. Correct, and worth counting.
      result.raced++;
    }
  }

  log.info("trial credit backfill complete", { ...result, apply });
  return result;
}
