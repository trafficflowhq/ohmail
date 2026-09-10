import { and, eq, ne, sql } from "drizzle-orm";
import { accounts, mailboxes, type AccessVerdict, type LedgerTx } from "@trafficflow/db";
import {
  balanceOf,
  effectiveSubscriptionOf,
  entitlementsFor,
  isSuspended,
  NotInTransactionError,
  type Entitlements,
  type Plan,
} from "@trafficflow/db/cloud";
import { ServiceError } from "./errors.js";

/**
 * PLAN-LIMIT ENFORCEMENT.
 *
 * ## The problem this exists to make impossible
 *
 * The 5/10/50 mailbox tiers were, until this module, enforced by nothing at all: no count, no
 * quota, no gate. And the obvious fix — "read the count in the handler, refuse if it is at the
 * limit" — is wrong in a way that only shows up in production. Two `POST /mailboxes` arriving
 * together at limit−1 both read `count = limit − 1`, both conclude there is room, and both
 * insert. Under READ COMMITTED neither transaction can see the other's uncommitted row, so
 * nothing about the check is at fault: **the check is correct and the outcome is still wrong.**
 * A quota that is only read is not a quota.
 *
 * So the serialization is in the DATABASE, and it is the account's OWN row:
 * {@link readMailboxAllowance} takes `SELECT … FROM accounts … FOR UPDATE` **before** it reads the
 * count. The second transaction blocks on that row lock until the first commits, and then counts a
 * world that already contains the winner's mailbox. Exactly one of the two proceeds; the other
 * gets a clean typed refusal rather than an over-provisioned account. The pg twin fires the race
 * across two independent pools, and removing the `FOR UPDATE` makes it fail.
 *
 * ## Why locking the ACCOUNT row, and not the mailboxes or the subscription
 *
 * There is no row to lock on the thing being counted — the contended resource is the COUNT, and
 * a row that does not exist yet cannot be locked. `SELECT … FOR UPDATE` over the existing
 * mailboxes would lock N rows and still miss the concurrent INSERT (Postgres row locks do not
 * lock gaps).
 *
 * The lock used to be the account's `billing_subscriptions` row, which defined the limit. The
 * limit now comes from the entitlements port, so that row is no longer the natural mutex — and it
 * carried a standing trap the account row does not: `FOR UPDATE` matching ZERO rows takes no lock
 * at all, so an account with no subscription row serialized nothing. It was harmless only because
 * such an account was refused anyway. `accounts` is per-account, always present, and cannot be
 * absent for the caller — the session resolved through it.
 *
 * ## The `canceled` seam — and the disagreement that made it a SHARED read
 *
 * `liveSubscriptionOf` deliberately excludes `canceled` — the partial unique index must let
 * resubscribe history accumulate — so wiring it straight into `entitlementsFor` makes a
 * cancelled account look like it never subscribed. The DECISION is the same either way (both
 * are refused), but the REASON the user is shown is not, and "no subscription" is simply false
 * for someone who cancelled last week. So when there is no live row the read falls back to the
 * account's NEWEST row of any status (`order by stripe_event_ts desc, created_at desc limit 1`,
 * also `FOR UPDATE`) and passes THAT snapshot, yielding the
 * entitlement table's documented `canceled` row: plan retained, creation refused. It runs ONLY
 * on the already-refusing path, so the paying hot path is still one indexed lookup, and it can
 * never shadow a live row with a stale cancellation because it is not consulted while one exists.
 *
 * **That live-preferred read used to be private to this file, and that was the bug.**
 * `BillingService.subscriptionStatus` answered the same question a second way — always
 * newest-of-any-status — so a dead `incomplete_expired` row carrying a later `stripe_event_ts`
 * made `GET /billing/subscription` report `no_subscription` for an account this gate was
 * admitting. The shared read then moved down into `packages/db`, because three further
 * readers of the same question (the AI gate's two arms and the roster that gates SYNC) sit where
 * this package cannot reach them. `effectiveSubscriptionOf` is now imported, not defined here,
 * and `packages/db/src/billing.ts` is where the argument for preferring the live row is written
 * down.
 *
 * ## The internal/dev account gets an ORDINARY subscription row, not a bypass
 *
 * "No subscription ⇒ limit 0" locks out our own account the moment this lands. The decision
 * on how that is handled is honoured here: the operator hand-seeds ONE
 * ordinary `billing_subscriptions` row (`plan='pro'`, `status='active'`,
 * `stripe_subscription_id='internal:<account_uuid>'`, far-future `current_period_end`) against
 * the production database. There is deliberately **no environment variable** that switches
 * enforcement off — an env bypass is a policy hole in the exact code whose purpose is
 * structure-over-policy, and it is invisible to every test.
 */

/**
 * Why a create was refused. Three distinct answers, because the UI must be able to say
 * something TRUE and each one has a different remedy:
 *
 *  · `no_subscription` — there is no live subscription row (or Checkout was never completed).
 *    Remedy: choose a plan.
 *  · `not_permitted`   — a subscription exists and retains its mailboxes, but its state forbids
 *    ADDING one (`unpaid`, `canceled`, `past_due` past grace, `paused`, admin-suspended). This
 *    is the distinction `canAddMailbox` exists to carry: retention and creation are
 *    different rights. Remedy: fix the billing state.
 *  · `at_limit`        — fully entitled, and every slot the plan sold is occupied.
 *    Remedy: upgrade, or disconnect a mailbox.
 */
export type MailboxRefusal = "no_subscription" | "not_permitted" | "at_limit";

/** Everything the decision was made from — carried into the error so the UI need not re-query. */
export interface MailboxAllowance {
  /**
   * How many mailboxes this account may have connected, FROM THE ENTITLEMENTS PORT, and the one
   * number both the decision and the message read. `null` ⇒ unbounded (an unmetered install).
   *
   * It is a field of its own rather than `entitlements.mailboxLimit` because the limit and the
   * REASON now come from different places: the limit from whoever operates the service, the reason
   * still from the local subscription state until that moves too. Two readings of "the limit" is
   * how a refusal ends up quoting a number the gate did not use.
   */
  mailboxLimit: number | null;
  /**
   * MAY this account connect another at all, FROM THE PORT — a separate question from the count,
   * and not derivable from it: an account may retain the mailboxes it has and be forbidden
   * another. The local `entitlements.reason` still chooses the SENTENCE, which is the one half of
   * this decision the port deliberately does not carry.
   */
  canAddMailbox: boolean;
  entitlements: Entitlements;
  /**
   * Mailboxes that currently OCCUPY a slot: every row whose `status` is not `'disabled'`.
   * `mailboxes` has no `deleted_at` (the original sketch assumed one) — disconnect is a soft delete to
   * `status='disabled'` because `messages.mailbox_id` FK-references the row. `'error'` still
   * occupies a slot: a mailbox that is failing to sync is still connected.
   */
  enabledCount: number;
  /** The plan sold, for the message; `null` when there is no live subscription. */
  plan: Plan | null;
}

/** Refusal → the wire code and status. 402 for billing remedies, 409 for state; this is the split. */
const HTTP: Record<MailboxRefusal, { code: string; status: number }> = {
  // 402: the remedy is billing — pick a plan, or settle/resume the subscription.
  no_subscription: { code: "no_subscription", status: 402 },
  not_permitted: { code: "subscription_inactive", status: 402 },
  // 409: nothing is wrong with the subscription; the request conflicts with account state.
  at_limit: { code: "mailbox_limit_reached", status: 409 },
};

/** Factual, per-state microcopy — no slogans, and never a lie about what was kept. */
function messageFor(refusal: MailboxRefusal, a: MailboxAllowance): string {
  if (refusal === "at_limit") {
    return `This plan includes ${a.mailboxLimit} mailbox${a.mailboxLimit === 1 ? "" : "es"} and ` +
      `${a.enabledCount} are connected. Upgrade the plan or disconnect a mailbox to add another.`;
  }
  switch (a.entitlements.reason) {
    case "no_subscription":
      return "This account has no active subscription, so no mailbox can be connected. " +
        "Choosing a plan enables it; nothing already connected is ever deleted.";
    case "suspended":
      return "This account is suspended. No mailbox can be connected while it is.";
    case "past_due":
      return "Payment is past due, so no further mailbox can be connected. " +
        "The mailboxes already connected keep syncing.";
    case "unpaid":
      return "This subscription is unpaid, so no further mailbox can be connected. " +
        "The mailboxes already connected are kept.";
    case "canceled":
      return "This subscription is canceled, so no further mailbox can be connected. " +
        "The mailboxes already connected are kept, and nothing is deleted.";
    case "paused":
      // Every sibling sentence tells the user what happens to what they ALREADY connected,
      // and this one used to be the exception — while being the only state in the whole
      // table where `syncEnabled` is false. So the one refusal that silently omitted the
      // consequence was the one refusal where the consequence was worst. Say it.
      return "This subscription is paused, so no further mailbox can be connected and the " +
        "mailboxes already connected are not syncing. Nothing is deleted; resuming the " +
        "subscription starts them again.";
    default:
      return "This subscription does not permit connecting another mailbox.";
  }
}

/**
 * The refusal, as a typed {@link ServiceError} subclass — so `withErrorEnvelope` maps it to the
 * `{ error: { code, message, details } }` envelope with no route change, and so a caller can
 * `instanceof` it without string-matching a code.
 *
 * `details` carries the whole decision (`reason`, the entitlement state it came from, the limit
 * and the current count). That is what lets the UI say "2 of 2 connected on Solo" instead of
 * "something went wrong", which is the entire point of distinguishing the reasons.
 */
export class MailboxAllowanceError extends ServiceError {
  constructor(readonly refusal: MailboxRefusal, readonly allowance: MailboxAllowance) {
    const { code, status } = HTTP[refusal];
    super(code, status, messageFor(refusal, allowance), {
      reason: refusal,
      entitlementReason: allowance.entitlements.reason,
      mailboxLimit: allowance.mailboxLimit,
      mailboxCount: allowance.enabledCount,
      plan: allowance.plan,
    });
    this.name = "MailboxAllowanceError";
  }
}

/**
 * The DECISION, as a pure function of an already-read allowance: `null` when the create may
 * proceed, otherwise the reason it may not.
 *
 * Pure and total on purpose — it is the half of this gate that is table-testable without a
 * database. `suspended` is fed by {@link readMailboxAllowance} from `account_suspensions`
 * (cloud 0008); this pure function is still where the DECISION for a suspended account is pinned by
 * the unit table, independent of how the flag is read.
 *
 * Order matters: `canAddMailbox` is consulted BEFORE the count. An `unpaid` account under the
 * limit must be refused for the reason that is true — its billing state — not told it is full,
 * and an account whose plan is 0 mailboxes must read `no_subscription` rather than `at_limit`.
 */
export function decideMailboxAllowance(a: MailboxAllowance): MailboxRefusal | null {
  if (!a.canAddMailbox) {
    return a.entitlements.reason === "no_subscription" ? "no_subscription" : "not_permitted";
  }
  // `null` is UNBOUNDED, not zero: an unmetered install has no count to exceed.
  if (a.mailboxLimit !== null && a.enabledCount >= a.mailboxLimit) return "at_limit";
  return null;
}

/**
 * **THE ONE READ OF "WHAT IS THIS ACCOUNT'S SUBSCRIPTION STATE"**, re-exported from
 * `packages/db` so this file's callers keep their import path.
 *
 * It USED TO BE DEFINED HERE, together with a private locked copy of `newestSubscriptionOf`, and
 * the reason it moved is the second half of the gap. Three more readers of the same
 * question — `packages/db/src/ai-gate.ts` (`spendState` and `aiRefusalReason`),
 * `packages/db/src/billing.ts` (`accountsWithSyncDisabled`, feeding both the worker's roster and
 * the `sync_lag` alert) and `apps/worker/src/mailboxes.ts`'s copy of that — live where a
 * `packages/services` home can never reach them: `packages/db` cannot import this package, and
 * `apps/worker` may import core + db only. All three took newest-of-any-status, so on the row
 * sequence that surfaced the original disagreement they refused AI and STOPPED SYNC for a
 * paying account.
 *
 * So the definition, its argument and its warnings are now in `packages/db/src/billing.ts`
 * beside `liveSubscriptionOf` and `newestSubscriptionOf` — read them there. The private
 * duplicate went with it: db's `newestSubscriptionOf` gained the opt-in `forUpdate` that was the
 * only reason a second copy of that query existed here.
 */
export { effectiveSubscriptionOf };

/** What {@link readMailboxAllowance} needs beyond the transaction it runs in. */
export interface MailboxAllowanceInput {
  /**
   * THE ACCOUNT'S ACCESS VERDICT, READ BEFORE THIS TRANSACTION OPENED — REQUIRED.
   *
   * It is a parameter and not a read because answering it may be a network hop to whoever operates
   * the service, and a remote call inside this transaction would hold the account's row lock across
   * it. The caller reads it first and hands the snapshot down; `null` is not accepted, because an
   * absent verdict and an unmetered one are different facts and only one of them means "no limit".
   *
   * The limit may therefore be microseconds staler than the count. That is the right way round: the
   * count is the contended resource and is read under the lock, while a limit that changed in that
   * window is re-read on the next request.
   */
  access: AccessVerdict;
  /**
   * The RE-ENABLE path (a mailbox moving out of `'disabled'` occupies a slot it does not yet hold):
   * the row must not count itself.
   */
  excludeMailboxId?: string;
}

/**
 * Read the account's allowance UNDER A ROW LOCK. The two statements are ordered, and the order
 * is the mechanism:
 *
 *   1. `SELECT … FROM accounts WHERE id = $1 FOR UPDATE`  ← the serializer
 *   2. `SELECT count(*) FROM mailboxes WHERE account_id = $1 AND status <> 'disabled'`
 *
 * A concurrent creator blocks at (1) and therefore reads (2) only after the winner's INSERT is
 * durable. Reversing them, or dropping the `FOR UPDATE`, restores the double-admit race.
 *
 * MUST be called with the ambient transaction handle: a lock taken on a top-level db handle is
 * released at the end of its own statement and serializes nothing. The `LedgerTx` type refuses a
 * `PgDatabase` at compile time and the runtime guard catches the `as any` and the JS caller —
 * the same two layers the credit primitives sit under.
 */
export async function readMailboxAllowance(
  tx: LedgerTx,
  accountId: string,
  now: Date,
  input: MailboxAllowanceInput,
): Promise<MailboxAllowance> {
  if (typeof (tx as unknown as { rollback?: unknown }).rollback !== "function") {
    throw new NotInTransactionError("readMailboxAllowance");
  }
  const opts = input;

  // (1) The lock. Everything after this statement is serialized per account. `accounts` always has
  // this row — the session was resolved through it — so the lock is never silently absent.
  await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for("update");

  // The subscription snapshot, read under that lock, for the REASON a refusal is explained with.
  // It prefers the live row and falls back to the newest row of any status — the `canceled` seam,
  // unchanged. The LIMIT no longer comes from here; see `MailboxAllowance.mailboxLimit`.
  const sub = await effectiveSubscriptionOf(tx, accountId);

  // (2) The count, read under that lock.
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(mailboxes)
    .where(and(
      eq(mailboxes.accountId, accountId),
      ne(mailboxes.status, "disabled"),
      opts.excludeMailboxId ? ne(mailboxes.id, opts.excludeMailboxId) : undefined,
    ));

  // `balanceOf` does not affect `canAddMailbox` today (only `aiEnabled` reads it), but
  // `entitlementsFor` is ONE function with ONE truth: feeding it a fabricated balance would
  // make this call site's `reason` diverge from the status route's for the same account.
  const balance = await balanceOf(tx, accountId);

  // A suspended account may add no mailbox (cloud 0008). Read under the same lock as the
  // rest of the allowance so a concurrent suspend cannot interleave between this and the decision.
  const suspended = await isSuspended(tx, accountId);

  return {
    // The port decides both, and a refused account may add none at all.
    mailboxLimit: input.access.ok ? input.access.limits.mailboxes : 0,
    canAddMailbox: input.access.ok ? input.access.limits.canAddMailbox : false,
    entitlements: entitlementsFor({
      sub,
      balance,
      suspended,
      now,
    }),
    enabledCount: row?.n ?? 0,
    plan: sub?.plan ?? null,
  };
}

/**
 * {@link readMailboxAllowance} + {@link decideMailboxAllowance}, throwing
 * {@link MailboxAllowanceError} on refusal. Returns the allowance on success so a caller can
 * log or echo it.
 *
 * Throwing (rather than returning an outcome) is deliberate here, unlike the credit primitives:
 * the caller's transaction has done nothing yet at this point, so the rollback the throw causes
 * is free, and a refusal that must be remembered to be checked is a refusal that will one day
 * not be.
 */
export async function assertMayAddMailbox(
  tx: LedgerTx,
  accountId: string,
  now: Date,
  input: { access: AccessVerdict | null; excludeMailboxId?: string },
): Promise<MailboxAllowance> {
  /**
   * NO VERDICT AT ALL is a misconfigured host, not a free one — the same refusal
   * `defaultMailboxAllowance()` makes one seam over, for the same reason. Defaulting an absent
   * reader to "unmetered" would silently remove the plan limit from any host that wired THIS gate
   * and forgot the reader, and a paid gate that quietly stopped applying is not a failure anyone
   * notices from the outside. An unmetered host supplies a reader that says so.
   */
  if (input.access === null) {
    throw new ServiceError(
      "server_error", 500,
      "no entitlements reader is configured for this host, so the mailbox limit cannot be read",
    );
  }
  const allowance = await readMailboxAllowance(tx, accountId, now, {
    access: input.access, ...(input.excludeMailboxId ? { excludeMailboxId: input.excludeMailboxId } : {}),
  });
  const refusal = decideMailboxAllowance(allowance);
  if (refusal) throw new MailboxAllowanceError(refusal, allowance);
  return allowance;
}
