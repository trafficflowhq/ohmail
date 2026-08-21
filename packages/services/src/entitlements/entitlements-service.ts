import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { accounts, mailboxes, type LedgerTx, type Tx } from "@trafficflow/db";
import {
  LIVE_SUBSCRIPTION_STATUSES,
  PLAN_LIMITS,
  TRIAL_GRANT_CREDITS,
  TRIAL_STARTS_PER_IP,
  TRIAL_START_WINDOW_MS,
  balanceOf,
  billingCustomers,
  billingSubscriptions,
  claimBillingEvent,
  entitlementsFor,
  getAiEnabled,
  isSuspended,
  expireCredits,
  grantCredits,
  grantTrialCredits,
  latestInvoiceGrantSource,
  ledgerSources,
  liveSubscriptionOf,
  lockAccountBalance,
  recordBillingEventFailure,
  recordBillingEventNoop,
  renewCredits,
  suspendAccountForRevenueReversal,
  LedgerReplayError,
  type Entitlements,
  type Plan,
  type SubscriptionStatus,
} from "@trafficflow/db/cloud";
import type { Db, ServiceContext } from "./../context.js";
import { ServiceError } from "./../errors.js";
import {
  ENTITLEMENT_EVENT_VERSION,
  type EntitlementEvent,
  type InvoiceDTO,
  type InvoiceLineDTO,
  type SubscriptionDTO,
} from "./entitlement-event.js";
import type { BillingPlanePort, PlaneCheckoutRequest } from "./plane-port.js";
// The shared per-IP slot claim. The trial fork of the checkout preflight is its fourth
// caller — see the bound inside `checkoutPreflight`; a second limiter beside this one is how two
// endpoints end up disagreeing about what an origin is allowed. The revenue-first rule names
// this bound
// explicitly, and it must stay in the OPEN preflight: it reads and writes open state, and a
// plane that enforced it would be a stateless program keeping state.
import { reserveIpSlot } from "./../ip-throttle.js";
// The ONE read of "what is this account's subscription state", shared with the mailbox
// gate. The import direction is deliberate and one-way: `mailbox-allowance.ts` must NOT import
// this module back.
import { effectiveSubscriptionOf } from "./../mailbox-allowance.js";

/**
 * THE OPEN ENTITLEMENTS SIDE: every billing decision that touches the database,
 * split out of the original `billing-service.ts` (whose Stripe-facing half is now the plane —
 * a separate private service reached over a documented API).
 *
 * All state and all transactions live HERE, on the open side: `billing_customers`,
 * `billing_subscriptions`, `billing_events`, the credit ledger, the suspensions. The plane is a
 * pure verify-and-translate service reached only through {@link BillingPlanePort}; it owns no
 * database and is never called from inside a transaction.
 *
 * ## The one rule the whole file is arranged around
 *
 * **Nothing may be written to the database before the delivery is VERIFIED.** Verification is
 * the plane's `verifyWebhook`; {@link EntitlementsService.applyEvent} only ever sees an event
 * the plane has already accepted, and the relay in `routes/billing.ts` returns before touching
 * the database on any refusal — the original acceptance ("bad signature ⇒ 400 and no DB write")
 * now spans the two programs and is pinned at the route with row counts.
 *
 * ## The second rule: `LedgerReplayError` propagates OUT of the transaction
 *
 * `renewCredits` throws it on a replay, and the throw IS the mechanism — it rolls the
 * transaction back, taking with it a wrongful expiry that would otherwise eat the credits the
 * customer just bought (catching it inside and continuing is the money corruption).
 * So the apply function never catches it, and `applyEvent` catches it OUTSIDE
 * `db.transaction`, records the event as applied-with-no-effect, and answers Stripe 200.
 *
 * ## What this file deliberately does NOT do
 *
 *  · **No metering.** It grants and expires; it never spends. The only `DebitReason` it can
 *    produce is `period_expiry`, and only through `renewCredits` — `billing-boundaries.test.ts`
 *    greps for the debit primitive by name across every `src/` file.
 *  · **No outbound network call from inside the apply transaction.** The plane resolved
 *    everything network-shaped (a dispute's charge→customer read included) BEFORE the DTO was
 *    handed over, so the transaction is offline-provable by construction.
 *  · **No credit clawback on Stripe refunds — but a refund SUSPENDS.** See the
 *    `revenue_reversal` arm.
 *  · **No mail.** Stripe's own Dashboard sends invoices, receipts and dunning.
 */

/** Dunning grace, measured from the EVENT's timestamp — never from `now()`. See {@link graceFrom}. */
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The bound on the erasure path's plane call. `cancelForErasure` sits
 * inside an Art. 17 request, so a plane outage may cost at most this long before the answer is
 * `"cancel_failed"` — never a hang, never a throw. Ten seconds is generous for one Stripe
 * cancel and comfortably inside the serverless invocation budget.
 */
export const ERASURE_CANCEL_TIMEOUT_MS = 10_000;

/**
 * An apply failure we RAISED on purpose, carrying a code that names the fault without quoting
 * any of the payload.
 *
 * The scrubbing rule is that a recorded error may carry the error's CLASS and CODE
 * and never its message text, because a driver message routinely contains the connection string
 * and a parse error quotes the body. That rule is only tolerable if the codes are informative,
 * so the deliberate failures get real names — `unknown_price`, `account_unresolved` — instead
 * of degrading to a bare `Error`.
 */
export class BillingApplyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BillingApplyError";
  }
}

/** class + code, never message text. What lands in `billing_events.error`. */
function scrub(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; constructor?: { name?: string } } | null;
  const cls = typeof e?.name === "string" ? e.name : e?.constructor?.name ?? "unknown";
  const code = typeof e?.code === "string" ? e.code : null;
  return code ? `${cls}:${code}` : cls;
}

/**
 * Run a RECOVERY-path write whose failure must not change the answer.
 *
 * Used only on the two paths where the HTTP status is already decided by something the database
 * cannot contradict — see `applyEvent`'s catch. It is not a general "ignore errors" helper and
 * must never wrap an APPLY: swallowing there is how a customer pays and gets nothing.
 *
 * It REPORTS whether the write landed, because "the audit row could not be written" is itself the
 * thing an operator most needs to hear (fix #7): a best-effort write that silently fails leaves a
 * paid customer with no credits, no trail and no alert.
 */
async function attempt(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;                 /* the caller's status is already correct without this write */
  }
}

const fromUnix = (seconds: number): Date => new Date(seconds * 1000);

/** The dunning deadline for an event, derived from the EVENT's own clock (contract f). */
const graceFrom = (createdUnix: number): Date => new Date(createdUnix * 1000 + GRACE_MS);

/** What a webhook delivery answers Stripe. */
export interface WebhookResult {
  status: number;
  body: unknown;
}

/** The `GET /billing/subscription` shape — the plan picker reads exactly this. */
export interface SubscriptionStatusDTO {
  subscription: {
    plan: Plan;
    status: SubscriptionStatus;
    mailboxLimit: number;
    monthlyCredits: number;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    graceUntil: string | null;
  } | null;
  balance: number;
  entitlements: Entitlements;
  /** The canonical plan card, so the client need not hardcode prices. */
  plans: typeof PLAN_LIMITS;
  /**
   * What a trial is granted, shipped for the same reason the plan card is: so no screen has to
   * hardcode a policy number.
   *
   * It is a CONSTANT and not this account's remaining balance — `balance` is that. A surface
   * that wants to say "your trial starts with N" is asking a question about the product, and one
   * that wants "N left" is asking about the account; conflating them is how a signup page ends
   * up advertising whatever the last visitor had left.
   */
  trialCredits: number;
  /**
   * Whether an `invoice_grant` ledger row exists for this account — has revenue EVER landed.
   *
   * Shipped for one sentence: the client must not present a `trialing` account's balance as
   * the trial's non-refilling pot once a paid invoice has granted credits. `invoice.paid`
   * applies the plan's allowance the moment it arrives; `customer.subscription.updated` — the
   * event that moves the mirror row off `trialing` — is a separate delivery, so for that
   * window `subscription.status` alone mislabels paid credits a trial bounty. This
   * is a fact about the ledger's whole history, not about the current period.
   */
  invoiceGranted: boolean;
}

/**
 * A SANITIZED operational signal. Codes and ids only — never a payload, never a message, never a
 * connection string (the class-and-code scrubbing rule applies to alerts exactly as it does to
 * `billing_events.error`, because an alert sink is a log sink someone will point at a third
 * party one day).
 */
export interface BillingAlert {
  /** Where in the pipeline it happened. `verify` is raised by the plane adapter/client. */
  stage: "verify" | "apply" | "record" | "link";
  /** `unknown_price`, `api_version_mismatch`, `record_failed`, … — always a fixed vocabulary. */
  code: string;
  stripeEventId: string | null;
  eventType: string | null;
  accountId: string | null;
}

/** Where sanitized operational signals go. The host wires it; `packages/services` never logs. */
export type BillingAlertSink = (alert: BillingAlert) => void;

/**
 * What erasure did about the money side. Reported to the caller and, through
 * `DELETE /account`, to the person who asked to be erased.
 *
 *  · `none` — no live subscription existed. Nothing was asked of the plane.
 *  · `cancelled` — a live subscription existed and Stripe accepted the cancellation.
 *  · `cancel_failed` — the plane refused, was unreachable, or ran past the bound. The account
 *    is STILL erased; this is the one outcome the screen has to say out loud, because the
 *    customer can no longer sign in to fix it themselves.
 */
export type ErasureBillingOutcome = "none" | "cancelled" | "cancel_failed";

export interface EntitlementsServiceConfig {
  /** Sanitized operational signals. Absent ⇒ nobody is listening (and that is a recorded gap). */
  alert?: BillingAlertSink;
}

/**
 * The open billing surface. DELIBERATELY PORT-FREE: this service holds no network capability at
 * all — the plane appears only where a route hands it in (`cancelForErasure`) or composes the
 * two at the seam (`checkoutPreflight` → `plane.checkout`). That is what makes "all state and
 * all transactions stay open" a structural property rather than a discipline.
 */
export interface EntitlementsService {
  /**
   * Everything that must be decided BEFORE the plane is asked for a Checkout session: the plan
   * validation, the 409 live-sub refusal, the trial-eligibility read, the per-IP trial
   * throttle, and the customer-ref read. Returns the plane request; the route forwards it to
   * {@link BillingPlanePort.checkout}.
   */
  checkoutPreflight(ctx: ServiceContext, plan: string): Promise<PlaneCheckoutRequest>;
  /** The 404-before-network read: this account's Stripe customer, or `no_billing_account`. */
  portalCustomerRef(ctx: ServiceContext): Promise<{ stripeCustomerId: string }>;
  /** Served entirely open — zero plane calls; works with the plane down. */
  subscriptionStatus(ctx: ServiceContext): Promise<SubscriptionStatusDTO>;
  /** Today's claim+apply transaction, over the plane's verified DTO. */
  applyEvent(db: Db, event: EntitlementEvent): Promise<WebhookResult>;
  /** Stop the money when the person is erased. Bounded, and it never throws. */
  cancelForErasure(ctx: ServiceContext, plane: BillingPlanePort): Promise<ErasureBillingOutcome>;
}

export function makeEntitlementsService(cfg: EntitlementsServiceConfig = {}): EntitlementsService {
  const raise = (a: BillingAlert): void => {
    // An alert sink that throws must never change an answer that is already correct.
    try {
      cfg.alert?.(a);
    } catch { /* observability is never load-bearing */ }
  };

  /**
   * The plan the PLANE mapped a price to, or a retryable apply failure.
   *
   * **An unknown price is never a default.** A grandfathered custom price must become a
   * deliberate code change, not a subscription silently mirrored as `solo` — which would sell
   * a `pro` customer 2 000 credits a month and look, in every table, exactly like a correct row.
   * The mapping itself is plane configuration (the price ids are plane env); what the open side
   * owns is the REFUSAL.
   */
  const requirePlan = (plan: Plan | null | undefined, where: string): Plan => {
    if (!plan) {
      throw new BillingApplyError(
        "unknown_price",
        `${where}: the price on this subscription is not one of the three configured plan prices`,
      );
    }
    return plan;
  };

  // ── reads used by the webhook, all plain (autocommit is fine) ───────────────────────────

  const accountOfCustomer = async (db: Tx, customerId: string | null): Promise<string | null> => {
    if (!customerId) return null;
    const rows = await db
      .select({ accountId: billingCustomers.accountId })
      .from(billingCustomers)
      .where(eq(billingCustomers.stripeCustomerId, customerId))
      .limit(1);
    return rows[0]?.accountId ?? null;
  };

  /**
   * Which account does this event belong to?
   *
   * **The metadata account id is the primary source (contract d).** Linking accounts only
   * through `checkout.session.completed.client_reference_id` makes every later event depend on
   * that one having arrived FIRST — and Stripe makes no such promise. With the account id
   * stamped on the subscription at creation, every subscription and invoice event carries its
   * own answer and delivery order stops mattering. The `billing_customers` lookup remains as
   * the fallback for a subscription created outside our Checkout (a Dashboard-created
   * subscription, a migration).
   *
   * A dispute's charge→customer resolution happened PLANE-SIDE (the payload names only the
   * charge id and the plane holds the Stripe key), so by the time a `revenue_reversal` DTO is
   * here its `customerId` is already the answer — and this function is a pure open-state read,
   * which is what lets it run before the transaction with nothing locked.
   */
  const resolveAccount = async (db: Tx, event: EntitlementEvent): Promise<string | null> => {
    switch (event.kind) {
      case "checkout_completed":
        return event.checkout.clientReferenceId
          ?? (await accountOfCustomer(db, event.checkout.customerId));
      case "subscription":
        return event.subscription.accountIdFromMetadata
          ?? (await accountOfCustomer(db, event.subscription.customerId));
      case "invoice_paid":
      case "invoice_payment_failed":
        return event.invoice.accountIdFromMetadata
          ?? (await accountOfCustomer(db, event.invoice.customerId));
      case "revenue_reversal":
        return accountOfCustomer(db, event.reversal.customerId);
      case "ignored":
        return null;
    }
  };

  // ── the subscription mirror ─────────────────────────────────────────────────────────────

  /** Basil moved the period off the subscription and onto its ITEMS (contract k). */
  const periodOf = (sub: SubscriptionDTO): { start: Date | null; end: Date | null } => {
    const starts = sub.items.map((i) => i.currentPeriodStart).filter((n): n is number => typeof n === "number");
    const ends = sub.items.map((i) => i.currentPeriodEnd).filter((n): n is number => typeof n === "number");
    return {
      start: starts.length > 0 ? fromUnix(Math.min(...starts)) : null,
      end: ends.length > 0 ? fromUnix(Math.max(...ends)) : null,
    };
  };

  /** The subscription's price — exactly one distinct price id, or a retryable failure. */
  const priceOf = (sub: SubscriptionDTO): { priceId: string; plan: Plan | null } => {
    const ids = [...new Set(sub.items.map((i) => i.priceId).filter((s): s is string => !!s))];
    if (ids.length !== 1) {
      throw new BillingApplyError(
        "ambiguous_price",
        `subscription mirror: expected exactly one price on the subscription, found ${ids.length}`,
      );
    }
    const priceId = ids[0]!;
    return { priceId, plan: sub.items.find((i) => i.priceId === priceId)?.plan ?? null };
  };

  /**
   * THE mirror upsert — one statement, fenced on `stripe_event_ts` (risk 7).
   *
   * Out-of-order delivery is normal, not exotic: Stripe fans deliveries out in parallel and
   * retries independently, so a `past_due` from T+5 can land after an `active` from T+10. An
   * application-level read-then-write cannot fix that (two deliveries both read the old row and
   * both write), so the defence is in the statement: `DO UPDATE … WHERE existing.stripe_event_ts
   * <= excluded.stripe_event_ts`. An older event updates ZERO rows and is still a SUCCESSFUL
   * apply — recorded, claimed, 200 — because "Stripe told us something we already know to be
   * stale" is a correct outcome, not a failure to retry.
   *
   * `<=` rather than `<` on equal timestamps is a deliberate, recorded limitation:
   * `event.created` has ONE-SECOND resolution, so two genuine mutations inside one second carry
   * the same fence value, and there is no finer clock in the payload to break the tie. `<=`
   * makes the LATER DELIVERY win, which is the better guess (deliveries are usually ordered
   * within a second) and is at worst the same coin-flip `<` would give. The residual risk is
   * one second wide and self-healing: Stripe's next subscription event overwrites it.
   *
   * `account_id` is deliberately NOT in the SET list. A subscription belongs to one account for
   * its whole life, so an event claiming otherwise is corruption, and the safe response is to
   * keep what we already recorded rather than let a payload move a subscription between
   * accounts.
   *
   * `grace_until` is computed IN THE STATEMENT (contract f) — see the CASE below.
   *
   * @returns the row when the fence let the write through, `null` when it was stale.
   */
  const mirrorSubscription = async (
    tx: LedgerTx,
    accountId: string,
    sub: SubscriptionDTO,
    event: { id: string; created: number },
    statusOverride?: SubscriptionStatus,
  ): Promise<{ mailboxLimit: number } | null> => {
    const price = priceOf(sub);
    const plan = requirePlan(price.plan, "subscription mirror");
    const status = (statusOverride ?? sub.status) as SubscriptionStatus;
    const period = periodOf(sub);
    const eventTs = fromUnix(event.created);

    // DENORMALIZATION AT SALE TIME. The ONE legitimate read of PLAN_LIMITS on the write path.
    // It supplies the allowances for a subscription we have not seen before, or for one whose
    // PRICE has actually changed — and for nothing else: see the CASE guards in the SET list,
    // which are what make "at sale time" true rather than merely intended (fix #6).
    const card = PLAN_LIMITS[plan];

    const rows = await tx
      .insert(billingSubscriptions)
      .values({
        accountId,
        stripeSubscriptionId: sub.id,
        stripePriceId: price.priceId,
        plan,
        status,
        mailboxLimit: card.mailboxes,
        monthlyCredits: card.monthlyCredits,
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        graceUntil: status === "past_due" ? graceFrom(event.created) : null,
        stripeEventTs: eventTs,
      })
      .onConflictDoUpdate({
        target: billingSubscriptions.stripeSubscriptionId,
        set: {
          stripePriceId: sql`excluded.stripe_price_id`,
          plan: sql`excluded.plan`,
          status: sql`excluded.status`,
          // GRANDFATHERING, and it has to be a CASE rather than a promise in a doc comment
          // (fix #6). `card` above is today's PLAN_LIMITS, and `customer.subscription.updated`
          // fires for things that are not sales at all — a status change, a
          // `cancel_at_period_end` toggle, a payment-method update. Writing `excluded` here
          // meant the day the plan card changed (task #48 moved mailboxes 2/5/10 → 5/10/50),
          // every existing customer would be silently re-priced on their next routine event —
          // and any REDUCTION would then fire the retention disabler below on a paying
          // customer's mailboxes. The allowances move only when the PRICE moves.
          mailboxLimit: sql`case when excluded.stripe_price_id = ${billingSubscriptions.stripePriceId}
                                 then ${billingSubscriptions.mailboxLimit}
                                 else excluded.mailbox_limit end`,
          monthlyCredits: sql`case when excluded.stripe_price_id = ${billingSubscriptions.stripePriceId}
                                   then ${billingSubscriptions.monthlyCredits}
                                   else excluded.monthly_credits end`,
          currentPeriodStart: sql`excluded.current_period_start`,
          currentPeriodEnd: sql`excluded.current_period_end`,
          cancelAtPeriodEnd: sql`excluded.cancel_at_period_end`,
          // Set the deadline only on the TRANSITION into past_due; keep an existing one so a
          // redelivered dunning event cannot slide the deadline forward; clear it on any
          // non-past_due status.
          graceUntil: sql`
            case when excluded.status = 'past_due'
              then case
                     when ${billingSubscriptions.status} = 'past_due'
                      and ${billingSubscriptions.graceUntil} is not null
                     then ${billingSubscriptions.graceUntil}
                     else excluded.grace_until
                   end
              else null
            end`,
          stripeEventTs: sql`excluded.stripe_event_ts`,
          updatedAt: sql`now()`,
        },
        // THE FENCE, with ONE exception carved out of the `<=` tie-break (fix #9).
        //
        // `<` for a strictly older event: it loses, always. On an exact-second TIE the later
        // DELIVERY normally wins, because `event.created` has one-second resolution, there is no
        // finer clock in the payload, and the next subscription event self-heals whatever the
        // coin-flip got wrong.
        //
        // `canceled` is the state where that reasoning fails, because it is TERMINAL: nothing
        // follows it to heal it. A cancellation and a same-second `active` snapshot, committed in
        // the unlucky order, would leave a cancelled customer mirrored `active` with full
        // entitlements, forever. So a tie may never overwrite `canceled` — while a strictly LATER
        // event still can, which is what keeps resubscribe and any genuine post-cancel correction
        // working.
        setWhere: sql`${billingSubscriptions.stripeEventTs} < excluded.stripe_event_ts
          or (${billingSubscriptions.stripeEventTs} = excluded.stripe_event_ts
              and ${billingSubscriptions.status} <> 'canceled')`,
      })
      .returning({ mailboxLimit: billingSubscriptions.mailboxLimit });

    return rows[0] ?? null;
  };

  /**
   * RETENTION on a downgrade: disable the excess mailboxes, NEWEST FIRST, and never delete
   * (risk 17 — a billing event must not destroy user data).
   *
   * Newest-first because the oldest mailboxes are the ones the account was built around; losing
   * the primary mailbox because a plan changed would be the worst possible reading of "we
   * disabled two". One statement, so the count and the disable cannot drift apart under
   * concurrency.
   *
   * The predicate `status <> 'disabled'` is copied from the worker's own enabled predicate
   * (`apps/worker/src/mailboxes.ts` `ne(mailboxes.status, "disabled")`) rather than invented —
   * if the two disagreed, we would disable a number the worker does not consider enabled.
   * `mailboxes` has no `deleted_at`: disconnect is a soft delete to `status='disabled'`, because
   * `messages.mailbox_id` FK-references the row.
   *
   * Idempotent (a disabled row stays disabled, and a re-applied event finds the count already
   * at the limit). Upgrades deliberately do NOT auto-re-enable: which mailboxes come back is the
   * user's choice, and the re-enable-within-limit gate is the mailbox service's.
   *
   * **Run-parking is NOT owed here:** every plan's `mailboxLimit` is
   * at least 5, so the disabler always leaves enabled mailboxes, the account stays on the
   * worker's duty roster and its pending runs keep draining — correct, because the account is
   * still paying. Account-wide disablement belongs to the suspend path and the worker's
   * entitlement-driven sync gate.
   *
   * No `change_log` entity is emitted: mailbox status changes are REST-only today
   * (`MailboxService.update`/`delete` write the column and emit nothing), and inventing a sync
   * entity for this one path would be a protocol change smuggled in on a billing event.
   */
  const disableExcessMailboxes = async (
    tx: LedgerTx,
    accountId: string,
    mailboxLimit: number,
  ): Promise<number> => {
    const counted = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(mailboxes)
      .where(and(eq(mailboxes.accountId, accountId), ne(mailboxes.status, "disabled")));
    const enabled = Number(counted[0]?.n ?? 0);
    const excess = enabled - mailboxLimit;
    if (excess <= 0) return 0;

    const doomed = await tx
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.accountId, accountId), ne(mailboxes.status, "disabled")))
      .orderBy(desc(mailboxes.createdAt), desc(mailboxes.id))
      .limit(excess);
    if (doomed.length === 0) return 0;

    await tx
      .update(mailboxes)
      .set({ status: "disabled" })
      .where(sql`${mailboxes.id} in ${doomed.map((d) => d.id)}`);
    return doomed.length;
  };

  // ── invoice.paid: THE money ─────────────────────────────────────────────────────────────

  /**
   * How many credits a renewal grants.
   *
   * **The mirror ROW comes first**, because it is what this subscription was SOLD with — that
   * is the grandfathering guarantee, and reading `PLAN_LIMITS` here instead would quietly
   * re-price every existing customer the day the plan card changes. The plane's price→plan
   * verdict is consulted only when the mirror has not landed yet (`invoice.paid` can genuinely
   * precede `customer.subscription.created`), and an unknown price there is a THROW, never a
   * default.
   */
  const monthlyCreditsFor = async (
    tx: LedgerTx, inv: InvoiceDTO,
  ): Promise<number> => {
    // The price this invoice actually CHARGED: the recurring (non-proration) line. A renewal
    // invoice names exactly one; anything else is not a shape we can reason about, and we simply
    // do not use it as evidence.
    const recurring = inv.lines.filter((l) => !l.proration);
    const charged = [...new Set(recurring.map((l) => l.priceId).filter((s): s is string => !!s))];
    // Stripe paginates `lines` at 10 (the same fact `applyProration` refuses on). A truncated
    // list can HIDE a recurring line past the first page, so `charged` computed from it is not
    // "the price this invoice charged" — it is a guess wearing that name, and every use of it
    // below has to be off the table, including the mismatch CHECK: one visible recurring line
    // that happens to match the mirror says nothing about the line the page cut off.
    const truncated = inv.linesTruncated;

    const subId = inv.subscriptionId;
    if (subId) {
      const rows = await tx
        .select({
          monthlyCredits: billingSubscriptions.monthlyCredits,
          stripePriceId: billingSubscriptions.stripePriceId,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.stripeSubscriptionId, subId))
        .limit(1);
      const row = rows[0];
      if (row) {
        // THE MIRROR MUST AGREE WITH THE INVOICE (fix #4). Reading the row without this check
        // trusts a snapshot that may be one delivery out of date, and the two ways it goes wrong
        // both move money: a downgrade whose `customer.subscription.updated` is delayed or fenced
        // charges the customer Solo and grants them Pro's allowance, and the mirror image charges
        // Plus and grants Solo's. Neither is recoverable — once the ledger holds a grant for this
        // invoice, `latestInvoiceGrantSource` makes it the account's newest source and no replay
        // can correct the number.
        //
        // Fail and RETRY rather than pick a side: the mirror is one Stripe delivery away from
        // being right, Stripe retries for ~3 days, and the alternative is a silently wrong
        // allowance that nothing downstream can detect.
        //
        // THE CHECK RUNS OR THE GRANT DOESN'T. An invoice whose recurring line is
        // ambiguous (0 or 2+) or PAGINATED past the first 10 lines cannot be compared, and an
        // invoice on which the check CANNOT run is refused like an invoice on which it FAILED.
        // For a merely-delayed mirror the retry heals it; a genuinely many-lined invoice parks
        // as `failed` after ~3 days for the audited admin comp — a human decision, not a
        // silently wrong allowance.
        if (truncated || charged.length !== 1) {
          throw new BillingApplyError(
            "ambiguous_price",
            `invoice.paid: the mirror cannot be verified against this invoice — ` +
              (truncated
                ? "the line list is paginated (has_more) and may hide a recurring line"
                : `it names ${charged.length} recurring prices where a renewal names exactly one`),
          );
        }
        if (charged[0] !== row.stripePriceId) {
          throw new BillingApplyError(
            "price_mirror_mismatch",
            "invoice.paid: the price this invoice charged is not the price the subscription " +
              "mirror records — the mirror is stale; retry once the subscription event lands",
          );
        }
        return row.monthlyCredits;
      }
    }
    // No mirror row yet — fall back to the plane's price→plan verdict on the charged line.
    // "Fail and retry" beats "derive and proceed": a retry costs a few seconds and Stripe
    // retries for ~3 days, while a wrong derivation is a wrong number of credits that nothing
    // downstream can detect. The truncation rule is the same as above, for the same reason: a
    // paginated list may hide the real recurring line, so its single visible price is not
    // evidence either.
    if (truncated || charged.length !== 1) {
      throw new BillingApplyError(
        "ambiguous_price",
        `invoice.paid: no subscription mirror yet and the invoice ` +
          (truncated ? "has a paginated line list" : `names ${charged.length} recurring prices`),
      );
    }
    const chargedLine = recurring.find((l) => l.priceId === charged[0])!;
    return PLAN_LIMITS[requirePlan(chargedLine.plan, "invoice.paid")].monthlyCredits;
  };

  /**
   * `invoice.paid` — decided by `billing_reason`, and the two $0 forks are the whole slice.
   *
   * **`subscription_create` at `amount_paid == 0` grants NOTHING, AND THIS SURVIVED THE TRIAL
   * BOUNTY UNCHANGED.** That is the trial-start invoice: Stripe issues a $0 `subscription_create`
   * invoice the moment a trial begins, so the committed rule "grant on `billing_reason IN
   * (subscription_create, subscription_cycle)`" would hand every trial A FULL MONTH of the plan's
   * managed AI at signup. The `amount_paid > 0` guard is what stops that.
   *
   * The trial is no longer credit-less — `applyTrialGrant` gives it a fixed bounty when the
   * subscription mirror first says `trialing` — and that is precisely why this guard must not be
   * relaxed now that it looks less load-bearing. The bounty is a small, fixed number decided by
   * the policy module; a $0 `subscription_create` grant would be `monthly_credits` for whichever
   * plan was clicked at Checkout, up to 20 000, every time a trial began. The two are the same
   * word ("the trial gets credits") and different by a factor of forty, and only one of them was
   * priced. They are also granted under different sources — `trial:<account_id>` once per
   * account, against `invoice:<invoice_id>` per invoice — so a trial that started, cancelled and
   * started again would be bounded by the first and unbounded by the second.
   *
   * Recorded consequence, accepted and unchanged: a 100%-coupon first invoice also grants
   * nothing, and the escape for that is the audited admin comp, not a looser guard.
   *
   * **`subscription_cycle` renews REGARDLESS of amount.** A cycle invoice can legitimately net
   * to $0 — a downgrade proration leaves customer-balance credit that covers the next month —
   * and that month is genuinely bought. More importantly the no-rollover EXPIRY must fire at
   * every cycle boundary: if a $0 cycle skipped the renewal, an account that downgraded from
   * `pro` would carry 20 000 credits through its first `solo` month. The BOUNDARY is the
   * renewal, not the cash.
   *
   * Both directions lose money and they lose it in opposite directions, which is why the guard
   * is asymmetric and why the tests pin each fork separately.
   *
   * **A `$0 subscription_create` still runs the ROLLOVER BOUNDARY** — the half of the renewal
   * that expires the prior invoice's leftovers — and that is a correction rather than a
   * refinement. See {@link applyZeroCreateRollover}.
   */
  const applyInvoicePaid = async (
    tx: LedgerTx, accountId: string, inv: InvoiceDTO, stripeEventId: string,
  ): Promise<void> => {
    const invoiceId = inv.id;
    if (!invoiceId) {
      throw new BillingApplyError("no_invoice_id", "invoice.paid: the invoice carries no id");
    }
    const reason = inv.billingReason;
    const amountPaid = inv.amountPaid;

    const isRenewal =
      reason === "subscription_cycle" ||
      (reason === "subscription_create" && amountPaid > 0);

    if (isRenewal) {
      // THE LOCK COMES FIRST, AND THE READ BELOW IS THE REASON.
      //
      // `latestInvoiceGrantSource` is a plain READ. Under READ COMMITTED, being inside this
      // transaction orders it against nothing: two DISTINCT paid invoices delivered concurrently
      // — a redrive of one cycle overlapping the next — both selected the same prior invoice,
      // the first expired it and granted, and the second then found `expiry:<prior>` already
      // recorded. That is a `LedgerReplayError`, which `applyEvent` correctly reads as "this
      // money is already in the ledger" and answers 200 for. It was not: the second invoice's
      // allowance was never granted, and its event id will never be retried.
      //
      // Taking the account's `credit_balances` lock before the read is what serializes the two.
      // The loser blocks here, then reads the ledger the winner committed — so its prior invoice
      // is the winner's grant and the two cycles compose exactly as they would have if they had
      // arrived a minute apart. It is the SAME lock every primitive below takes, so this adds no
      // new lock ordering and cannot deadlock against them.
      await lockAccountBalance(tx, accountId);
      // The PRIOR-INVOICE RULE, read from the LEDGER under that lock. One rule covers the
      // ordinary cycle, resubscribe-after-cancel (the leftover balance of the cancelled
      // subscription is expired by the new one's first grant, so no-rollover holds across
      // subscription boundaries) and the account's genuinely first grant (null ⇒ `renewCredits`
      // skips the expiry).
      const prior = await latestInvoiceGrantSource(tx, accountId, { excludeInvoiceId: invoiceId });
      const monthlyCredits = await monthlyCreditsFor(tx, inv);
      // NOT caught here. A replay throws LedgerReplayError THROUGH this transaction so the
      // rollback takes the wrongful expiry with it; `applyEvent` catches it outside.
      await renewCredits(tx, accountId, {
        priorStripeInvoiceId: prior,
        stripeInvoiceId: invoiceId,
        monthlyCredits,
        meta: { billingReason: reason, amountPaid },
      });
      return;
    }

    if (reason === "subscription_create") {
      // `amountPaid === 0` is the only way to be here — the fork above took the paid one.
      await applyZeroCreateRollover(tx, accountId, invoiceId);
      return;
    }

    if (reason === "subscription_update") {
      await applyProration(tx, accountId, inv, invoiceId, amountPaid, stripeEventId);
      return;
    }

    // Every other `billing_reason` — `manual`, `subscription_threshold`, `upcoming` — has no
    // allowance we can compute, and guessing one would be inventing revenue. What happens next
    // depends entirely on whether MONEY changed hands (fix #3):
    //
    //  · `amount_paid == 0` ⇒ recorded, ignored, 200. Nothing was bought; nothing is owed.
    //  · `amount_paid > 0`  ⇒ a customer has PAID us and this code does not know what for.
    //    Answering 200 there is not "conservative", it is the money loss with a clean audit
    //    trail: the event is stamped `applied`, Stripe stops, and a real payment is on record as
    //    correctly handled while its credits never existed. It became durable, alertable and
    //    re-drivable instead: `failed`, 500, retries for ~3 days, and after that a row a human
    //    can find and a decision they can make (grant by admin comp, or refund).
    if (amountPaid > 0) {
      throw new BillingApplyError(
        "unsupported_billing_reason",
        `invoice.paid: ${reason ?? "an invoice with no billing_reason"} was PAID and no policy ` +
          "in this slice can decide what it buys — this needs a human, not a 200",
      );
    }
  };

  /**
   * A `$0 subscription_create` GRANTS NOTHING AND STILL CLOSES THE PRIOR PERIOD.
   *
   * The `amount_paid > 0` guard on the create fork is right about the grant and was wrong about
   * the boundary: it skipped `renewCredits` entirely, so the EXPIRY half never ran either. That
   * left one reachable hole, and it is the one `latestInvoiceGrantSource` states as a guarantee —
   * "resubscribe after cancel: the leftover balance the cancelled subscription bought must expire
   * when the new subscription's first invoice grants". A resubscriber whose reusable Stripe
   * customer carries enough invoice credit (a downgrade proration, a refund to balance) nets that
   * first invoice to zero, and Stripe applies customer balance automatically. Their old plan's
   * unspent allowance — up to a full Pro month — then funded a cycle of a plan they had just
   * started, until the NEXT cycle invoice finally expired it.
   *
   * ── WHY NOTHING IS GRANTED, STATED AS AN ACCEPTANCE RATHER THAN AN OVERSIGHT ───────────────
   *
   * A balance-covered resubscription is a month genuinely bought, so the customer ends this
   * invoice with zero credits for a month they paid for. That is the same trade the file already
   * makes and names for the 100%-coupon first invoice: the alternative is granting
   * `monthly_credits` on a create invoice that collected no cash, which is precisely the
   * up-to-20 000-credit hole the guard exists to close, and no field on the invoice separates
   * "trial start" from "covered by balance" reliably enough to bet a month's allowance on. The
   * escape is the audited admin comp, not a looser guard.
   *
   * ── AND WHY THE EXPIRY IS KEYED ON THIS INVOICE, NOT ON THE PRIOR ONE ─────────────────────
   *
   * `renewCredits` writes `expiry:<prior_invoice>` because the grant that follows it is what
   * makes the pair one economic event. Here there is no grant, and reusing that key would set a
   * trap for the NEXT cycle: `latestInvoiceGrantSource` would still return the same prior invoice
   * (this invoice granted nothing, so it is not a candidate), `renewCredits` would find
   * `expiry:<prior>` already recorded, raise `LedgerReplayError` — and the webhook would answer
   * 200 to a genuinely paid cycle. Keying on THIS invoice id makes the row mean what it is, "the
   * balance was closed out at this boundary", and keeps it unique per invoice, so a redelivery
   * under a second event id is a clean `duplicate` and moves nothing.
   *
   * ── THE FIRST-EVER TRIAL IS UNTOUCHED, AND THAT IS STRUCTURAL ─────────────────────────────
   *
   * A trial-start invoice for an account that has never bought anything has no prior invoice
   * grant, so `prior` is null and this returns before writing. The trial bounty granted by the
   * subscription event is therefore never at risk from delivery order — the two events cannot
   * both be about an account with an invoice history, because the checkout preflight refuses a
   * trial to any account that has one.
   *
   * Exactly ONE ledger operation, so the single-operation mapping applies: `duplicate` means this
   * boundary is already recorded, which is the end state this call wanted.
   */
  const applyZeroCreateRollover = async (
    tx: LedgerTx, accountId: string, invoiceId: string,
  ): Promise<void> => {
    // Same ordering rule as the renewal fork: the lock, then the ledger read it acts on.
    await lockAccountBalance(tx, accountId);
    const prior = await latestInvoiceGrantSource(tx, accountId, { excludeInvoiceId: invoiceId });
    if (prior == null) return;                  // no paid period to close — a first-ever trial
    await expireCredits(tx, accountId, ledgerSources.periodExpiry(invoiceId), {
      billingReason: "subscription_create", amountPaid: 0, priorStripeInvoiceId: prior,
    });
  };

  /**
   * An upgrade/downgrade PRORATION invoice grants the DIFFERENCE and never runs the expiry.
   *
   * `renewCredits` would be exactly wrong here: a mid-cycle upgrade is not a new period, so
   * expiring the balance would delete credits the customer already paid for, in the middle of
   * the month, as a *reward* for spending more money.
   *
   * **Old and new prices come from the invoice's own proration LINE ITEMS, not from the
   * subscription row (contract e).** The obvious source races the mirror:
   * `customer.subscription.updated` and this `invoice.paid` are independent deliveries, so by
   * the time this runs the row may already say the NEW plan — and `new − new = 0`, a silent
   * no-grant on a paid upgrade. The proration lines carry both prices inside this one event,
   * which makes the computation ordering-independent by construction: the negative (credit)
   * line names the old price, the positive line names the new one.
   */
  const applyProration = async (
    tx: LedgerTx, accountId: string, inv: InvoiceDTO, invoiceId: string, amountPaid: number,
    stripeEventId: string,
  ): Promise<void> => {
    const prorations = inv.lines.filter((l) => l.proration);
    const oldLine: InvoiceLineDTO | undefined = prorations.find((l) => l.amount < 0);
    const newLine: InvoiceLineDTO | undefined = prorations.find((l) => l.amount > 0);
    const oldPrice = oldLine?.priceId;
    const newPrice = newLine?.priceId;
    // Stripe paginates `lines` at 10 by default. A truncated list is not "the lines we see"; it
    // is a list we cannot reason about, and reasoning about it anyway is how a paid upgrade grants
    // the wrong difference.
    const truncated = inv.linesTruncated;

    if (!oldPrice || !newPrice || truncated) {
      // ABSENT OR ONE-SIDED LINES ARE ONLY SAFE AT $0 (fix #2).
      //
      // The benign case is real and must stay a 200: a plan switch DURING a trial prorates
      // nothing because nothing was paid, so there is no money to account for and the new
      // allowance lands at the next cycle's renewal.
      //
      // The dangerous case wears the same shape. A PAID proration whose line list is one-sided,
      // paginated or version-drifted would, with a bare `return`, be stamped `applied`, answered
      // 200 and grant exactly nothing — money taken, no credits, and Stripe told never to try
      // again. `amount_paid` is what separates them, and it is the only thing that can: it is the
      // one field on this invoice that says whether a card was charged.
      if (amountPaid > 0) {
        throw new BillingApplyError(
          "ambiguous_proration",
          "invoice.paid: a PAID proration invoice whose line items do not name both an old and " +
            "a new price — the difference cannot be computed and must not be assumed to be zero",
        );
      }
      return;
    }

    const from = requirePlan(oldLine!.plan, "invoice.paid (proration, old price)");
    const to = requirePlan(newLine!.plan, "invoice.paid (proration, new price)");
    const diff = Math.max(0, PLAN_LIMITS[to].monthlyCredits - PLAN_LIMITS[from].monthlyCredits);

    // A DOWNGRADE's diff is 0 — the smaller allowance is not clawed back mid-cycle; it simply
    // lands at the next cycle's renewal, where the expiry clears the old plan's balance.
    if (diff === 0) return;

    // A COMPLETE LINE PAIR IS A SHAPE, NOT A PAYMENT — and until this branch checked
    // `amount_paid` it was treated as one.
    //
    // The branch above already refuses to reason about a one-sided or truncated line list unless
    // the invoice collected nothing. Underneath that reasoning is a claim about cash, and the
    // claim is just as necessary here: two clean proration lines say only which prices were
    // swapped. They do not say that anything was paid for the swap.
    //
    // The reachable sequence is a customer's own Portal, where the pinned configuration permits
    // immediate plan changes. Change down: Stripe issues customer-balance credit and this handler
    // deliberately claws nothing back, so the high-tier allowance stays spendable. Change back up:
    // Stripe applies that balance, `amount_paid` is 0, both proration lines are present — and the
    // old code granted `PLAN_LIMITS[to] − PLAN_LIMITS[from]` in full. Solo→Pro is 18 000 credits
    // for a zero-cash invoice, repeatable, because each upgrade invoice has its own `invoice:`
    // source and ledger idempotency has nothing to refuse.
    //
    // Recorded and accepted, unchanged by this guard: an upgrade near the period end pays only a
    // small fractional proration and still receives the WHOLE monthly difference. That is a
    // pricing decision (the allowance is monthly and the plan is now the higher one), not this
    // branch's ambiguity, and re-pricing it by the fraction charged is a policy change nobody has
    // made. What `amount_paid > 0` buys is the difference between "paid something for this
    // upgrade" and "paid nothing at all", which is the difference that was missing.
    //
    // A `return` and not a throw: a zero-cash plan change is a legitimate, correctly-signed event
    // whose credit consequence is simply nothing. Throwing would retry it for three days and
    // never succeed. The mirror still moves to the new plan through the subscription event, so
    // the customer has the mailbox limit they switched to; what they do not get is a month's
    // allowance nobody paid for.
    if (amountPaid <= 0) {
      raise({
        stage: "apply", code: "zero_cash_upgrade_ignored",
        stripeEventId, eventType: "invoice.paid", accountId,
      });
      return;
    }

    const granted = await grantCredits(
      tx, accountId, diff, "invoice_grant", ledgerSources.invoiceGrant(invoiceId),
      { upgrade: true, from, to },
    );
    if (!granted.ok) {
      // The claim gate already blocks a redelivery of the same event id, so a `duplicate` here
      // means a RESENT event id for an invoice already granted. `grantCredits` reports rather
      // than throws (the spend gate depends on that for the single-operation case), so the composition
      // contract's abort has to be raised here — as LedgerReplayError, which `applyEvent`
      // answers 200.
      throw new LedgerReplayError(
        `invoice ${invoiceId} has already granted its proration on account ${accountId} — ` +
          "this delivery is a replay under a new event id; the transaction MUST abort",
      );
    }
  };

  /**
   * THE TRIAL BOUNTY — a fixed allowance (`TRIAL_GRANT_CREDITS`, in the plan-card module beside
   * `PLAN_LIMITS`) granted the first time a subscription event says this account is `trialing`.
   * The AMOUNT is deliberately not named here: this file decides WHEN, and the policy module
   * decides how much, exactly as it does for a plan's monthly allowance.
   *
   * ── WHY THE SOURCE IS THE ACCOUNT, AND WHY THAT REMOVES EVERY OTHER GUARD ────────────────
   *
   * `ledgerSources.trialGrant(accountId)` is `trial:<account_id>`, and `credit_ledger` is
   * `UNIQUE (account_id, source)`. So the second grant for an account cannot be written, whoever
   * asks and however often. That is the whole mechanism: no read-then-write, no "have we already"
   * flag on the subscription row, and no ordering requirement between this handler and the
   * one-shot backfill that covers accounts already trialing when the policy changed.
   *
   * ── DELIBERATELY NOT GATED ON THE MIRROR FENCE ───────────────────────────────────────────
   *
   * `disableExcessMailboxes` above runs only when the fenced upsert let the write through,
   * because acting on a STALE limit would disable a paying customer's mailboxes. This grant is
   * the opposite kind of fact. The fence protects the mirror ROW's current state; "this account
   * had a trial" is a statement about its history, and a late-arriving `trialing` event is
   * truthful evidence of it even when a newer `active` snapshot has already landed. Gating on
   * `applied` would silently skip the bounty for exactly the accounts whose events arrived out of
   * order — a fortnight of the product working differently, decided by delivery order. The
   * source's uniqueness is what makes ignoring the fence safe rather than sloppy.
   *
   * ── AND `duplicate` IS NOT AN ABORT HERE ─────────────────────────────────────────────────
   *
   * The composition contract ("abort the entire transaction the moment ANY ledger operation
   * returns `duplicate`") governs a transaction holding SEVERAL ledger operations, where a
   * replayed expiry beside a replayed grant would consume a real balance. This transaction holds
   * exactly one: the mirror upsert and the retention disabler move no credits. So the
   * single-operation mapping applies — `duplicate` means the bounty is already recorded, which is
   * the end state this call wanted, and the transaction commits with the mirror write intact.
   * Throwing instead would fail the whole subscription event, retry for three days, and never
   * succeed.
   *
   * No alert and no error path: there is no failure mode here that a human could act on.
   */
  const applyTrialGrant = async (
    tx: LedgerTx, accountId: string, sub: SubscriptionDTO,
  ): Promise<void> => {
    await grantTrialCredits(tx, accountId, {
      // Provenance only. `meta` is jsonb and indexes nothing; the identity that matters is the
      // source. The trial's end date is worth keeping because it is the one fact about the
      // bounty that is not derivable from the row itself.
      stripeSubscriptionId: sub.id,
      trialEnd: sub.trialEnd,
    });
  };

  // ── the apply switch ────────────────────────────────────────────────────────────────────

  const applyKind = async (tx: LedgerTx, event: EntitlementEvent, accountId: string): Promise<void> => {
    switch (event.kind) {
      case "checkout_completed": {
        // The customer↔account LINK, and nothing else. No grant and no subscription row: the
        // subscription events own the mirror and `invoice.paid` owns the money, so this event
        // having arrived (or not) never changes what the account is entitled to.
        const customerId = event.checkout.customerId;
        if (!customerId) return;              // a $0/no-customer session — nothing to link
        // THE LINK IS FIRST-WRITE-WINS (fix #5b). It used to overwrite `stripe_customer_id`
        // unconditionally, so if two checkouts for one account ever completed with different
        // customers, DELIVERY ORDER decided which customer the Billing Portal afterwards opened —
        // and a customer holding no subscription is a Portal with nothing in it. The `setWhere`
        // makes an event that would MOVE the account to a different customer update zero rows;
        // the email still refreshes for the customer we already know. A refused move is not a
        // failure (there is nothing to retry — the payload is not going to change), it is an
        // alert: two live customers for one account is the double-checkout race, and the
        // resolution is a human in the Dashboard.
        const linked = await tx
          .insert(billingCustomers)
          .values({
            accountId,
            stripeCustomerId: customerId,
            email: event.checkout.customerEmail ?? "",
          })
          .onConflictDoUpdate({
            target: billingCustomers.accountId,
            set: { email: sql`excluded.email`, updatedAt: sql`now()` },
            setWhere: eq(billingCustomers.stripeCustomerId, customerId),
          })
          .returning({ stripeCustomerId: billingCustomers.stripeCustomerId });
        if (linked.length === 0) {
          raise({
            stage: "link", code: "customer_link_conflict",
            stripeEventId: event.id, eventType: event.type, accountId,
          });
        }
        return;
      }

      case "subscription": {
        const sub = event.subscription;
        if (event.phase === "deleted") {
          // NO ledger operation, and that is a decision (contract j): credits already paid for
          // are not expired at cancel. `entitlementsFor` already turns AI off for `canceled`
          // while keeping the 30-day export window, and the leftover balance is expired by the
          // FIRST invoice of any future resubscription through the prior-invoice rule. Expiring
          // here would confiscate a paid-for balance from someone who may resubscribe next week.
          await mirrorSubscription(tx, accountId, sub, event, "canceled");
          return;
        }
        // Created and updated are ONE code path on purpose: the mirror upsert is idempotent and
        // fenced, so which of the two arrived first is not information the handler needs — and
        // two near-identical branches is how the fence ends up on only one of them.
        const applied = await mirrorSubscription(tx, accountId, sub, event);
        // The disabler runs only when the fence LET THE WRITE THROUGH. A stale event must not
        // disable mailboxes against a limit the account no longer has.
        if (applied) await disableExcessMailboxes(tx, accountId, applied.mailboxLimit);
        // THE TRIAL BOUNTY — see `applyTrialGrant`, and note that it is deliberately NOT gated on
        // `applied`.
        if (sub.status === "trialing") await applyTrialGrant(tx, accountId, sub);
        return;
      }

      case "invoice_paid": {
        await applyInvoicePaid(tx, accountId, event.invoice, event.id);
        return;
      }

      case "invoice_payment_failed": {
        // Dunning. The BALANCE IS UNTOUCHED — a failed payment never revokes credits the
        // customer already bought; `aiEnabled: false` past grace is what stops further SPEND.
        const subId = event.invoice.subscriptionId;
        if (!subId) return;                    // not a subscription invoice — nothing to mark
        const eventTs = fromUnix(event.created);
        const marked = await tx
          .update(billingSubscriptions)
          .set({
            status: "past_due",
            graceUntil: sql`case
              when ${billingSubscriptions.status} = 'past_due'
               and ${billingSubscriptions.graceUntil} is not null
              then ${billingSubscriptions.graceUntil}
              else ${graceFrom(event.created)}
            end`,
            stripeEventTs: eventTs,
            updatedAt: sql`now()`,
          })
          .where(and(
            eq(billingSubscriptions.stripeSubscriptionId, subId),
            // The same fence as the mirror: a re-ordered dunning event must not drag a
            // recovered subscription back to past_due.
            sql`${billingSubscriptions.stripeEventTs} <= ${eventTs}`,
          ))
          .returning({ id: billingSubscriptions.id });

        // ZERO ROWS HAS TWO CAUSES AND THEY DEMAND OPPOSITE ANSWERS (fix #3b). Without this the
        // statement's result was never inspected at all, so both were silently treated as
        // success:
        //  · the row EXISTS and the fence blocked it — a stale dunning event, correctly ignored,
        //    a genuine 200;
        //  · the row DOES NOT EXIST — `invoice.payment_failed` beat `customer.subscription.*`
        //    to us, which Stripe makes no promise against. Acknowledging that loses the dunning
        //    transition permanently: a later, OLDER subscription snapshot then inserts
        //    `status='active'`, and an unpaid customer keeps every entitlement including AI,
        //    with no event left to correct it.
        if (marked.length === 0) {
          const exists = await tx
            .select({ id: billingSubscriptions.id })
            .from(billingSubscriptions)
            .where(eq(billingSubscriptions.stripeSubscriptionId, subId))
            .limit(1);
          if (exists.length === 0) {
            throw new BillingApplyError(
              "subscription_not_mirrored",
              "invoice.payment_failed: no mirror row for this subscription yet — retry once " +
                "customer.subscription.* has landed, rather than losing the dunning transition",
            );
          }
        }
        return;
      }

      case "revenue_reversal": {
        // REVENUE REVERSED ⇒ SUSPEND — a deliberate product decision. A refund or a lost
        // dispute takes
        // the money back while the allowance it bought stays spendable — from here on, every
        // metered action is API cost with no revenue behind it, and Stripe sends no
        // later event to correct it. So the account is suspended: the same
        // `account_suspensions` row the admin console writes, which `entitlementsFor` and the
        // spend gate already map to "no AI, no sync, no new mailboxes".
        //
        // What is deliberately NOT done, in both directions:
        //  · no ledger clawback — the spent portion is gone regardless, and expiring the rest
        //    buys nothing a suspension does not (a suspended account cannot spend);
        //  · no unsuspend on `charge.dispute.funds_reinstated` — winning a dispute back is
        //    evidence about the money, not about the customer; an operator resumes from the
        //    console after looking, exactly as they would for a goodwill Dashboard refund that
        //    lands here (issuing a refund IS a reversal, whoever clicked it; the resume DELETE
        //    is the escape, and it is one click).
        //
        // Idempotent by the table's PRIMARY KEY: a redelivery, a partial refund following a
        // full one, or a dispute after a refund all find the row present, change nothing and
        // write no second audit row. The alert fires only on the transition, so an operator
        // hears about each suspension exactly once.
        const outcome = await suspendAccountForRevenueReversal(tx, {
          accountId,
          source: `stripe:${event.type}:${event.reversal.objectId}`,
          now: fromUnix(event.created),
        });
        if (outcome.changed) {
          raise({
            stage: "apply", code: "revenue_reversal_suspended",
            stripeEventId: event.id, eventType: event.type, accountId,
          });
        }
        return;
      }

      case "ignored":
        // RECORDED AND IGNORED. Config drift (someone ticks a ninth type in the Dashboard)
        // must not become a 500 loop. Consciously accepted consequence: an ignored event is
        // recorded as `applied` and is final — a later code version that handles the type will
        // handle new DELIVERIES, not this one.
        return;
    }
  };

  // ── the public surface ──────────────────────────────────────────────────────────────────

  return {
    async checkoutPreflight(ctx, plan) {
      if (!Object.prototype.hasOwnProperty.call(PLAN_LIMITS, plan)) {
        throw new ServiceError("validation_failed", 400, "plan must be one of solo, plus, pro");
      }
      const chosen = plan as Plan;

      // THE FRONT DOOR. Two racing checkouts is the scenario that costs a customer two
      // subscriptions, and this 409 is what makes it an against-the-odds double-pay a human
      // notices instead of a routine state. The partial unique index `billing_sub_one_live_idx`
      // is the structural backstop underneath (a second live subscription is unrepresentable);
      // this is the polite refusal that stops it being reached.
      //
      // AND IT IS THE ONE PLACE THAT MUST NOT USE `effectiveSubscriptionOf`. This asks a
      // genuinely different question — "is there a subscription this account is currently ON?" —
      // and the difference is a right: a `canceled` account has no live row and MAY resubscribe.
      // Routing this through the entitlement read would hand it a non-null cancelled snapshot and
      // 409 the resubscribe forever. `test/billing-effective-subscription.pg.test.ts`
      // pins that a `canceled`-only account is still offered a checkout.
      if (await liveSubscriptionOf(ctx.db, ctx.accountId)) {
        throw new ServiceError(
          "subscription_exists", 409,
          "this account already has a subscription — use the billing portal to change plan",
        );
      }

      // THE TRIAL IS ONCE PER ACCOUNT. Eligible iff no `billing_subscriptions` row exists
      // outside ('incomplete','incomplete_expired'): an ABANDONED Checkout parks a subscription
      // in `incomplete` for ~23 h and must not burn the trial, while a cancelled trial or any
      // real subscription history does.
      const history = await ctx.db
        .select({ id: billingSubscriptions.id })
        .from(billingSubscriptions)
        .where(and(
          eq(billingSubscriptions.accountId, ctx.accountId),
          sql`${billingSubscriptions.status} not in ('incomplete','incomplete_expired')`,
        ))
        .limit(1);
      const trialEligible = history.length === 0;

      // ── THE BOUND ON THE NO-CARD TRIAL, and why it is here and not at registration ────────
      //
      // A trial grants `TRIAL_GRANT_CREDITS` managed-AI actions with no card
      // (`applyTrialGrant`), which is a deliberate exception to the hard rule "no API cost
      // without revenue behind it". An exception to a hard rule is worth exactly the bound stated
      // with it, and "once per account" is not one: it caps what ONE account takes and says
      // nothing about how many accounts one person opens. Verified email and the signup throttle
      // bound ACCOUNT CREATION; neither bounds trial STARTS, and it is the start that spends.
      //
      // So the trial fork claims a slot on the same per-IP primitive the waitlist and
      // registration use, under its own namespace so a deployment can be generous about signups
      // and strict about spend. See `TRIAL_STARTS_PER_IP` for the figure and the arithmetic.
      //
      // BEFORE the plane call, deliberately (this bound MUST NOT travel to the
      // plane — it reads and writes open state, and a refusal after Checkout has created a
      // subscription is a subscription somebody has to cancel). And ONLY on the trial fork —
      // the paid fork's bound is the card, and rate-limiting a customer trying to pay is a
      // defect.
      //
      // ── AN UNKNOWN IP IS SKIPPED, exactly as `AuthService.register` skips it ──────────────
      //
      // `clientIp` returns `""` when no trusted platform header is present, and keying a limiter
      // on `""` is an outage rather than a limit: one shared bucket for the whole deployment means
      // three trials from anywhere refuse every trial on earth. The established rule is "an
      // unknown client is not rate-limited per-IP, it is limited by what does not need an
      // identity", and here that other thing is already in place and upstream: a trial needs an
      // ACCOUNT, and for an unidentifiable client account creation is either invite-bound (single
      // use, email-bound, one code buys one account) or refused outright when the gate is open
      // (`signupUnavailable`). So the population of accounts that could reach this branch without
      // an IP is bounded before it gets here, and skipping a limit we cannot key correctly is the
      // bounded loss while sharing one bucket is the outage.
      const trialIp = (ctx.ip ?? "").trim();
      if (trialEligible && trialIp.length > 0) {
        const claimed = await reserveIpSlot(ctx.db as unknown as Tx, {
          namespace: "trial:ip",
          ip: trialIp,
          now: ctx.now(),
          max: TRIAL_STARTS_PER_IP,
          windowMs: TRIAL_START_WINDOW_MS,
        });
        if (!claimed) {
          throw new ServiceError(
            "rate_limited", 429,
            "too many trials have been started from here recently — try again tomorrow, or start " +
              "a paid subscription now",
          );
        }
      }

      // Reuse the customer on a resubscribe so payment methods and invoice history stay in
      // one place; the plane lets Checkout create one on a first purchase.
      const existing = await ctx.db
        .select({ stripeCustomerId: billingCustomers.stripeCustomerId })
        .from(billingCustomers)
        .where(eq(billingCustomers.accountId, ctx.accountId))
        .limit(1);

      return {
        accountId: ctx.accountId,
        plan: chosen,
        trialEligible,
        stripeCustomerId: existing[0]?.stripeCustomerId ?? null,
      };
    },

    async portalCustomerRef(ctx) {
      // 404 BEFORE any plane call: an account that never checked out has no customer to open a
      // portal for, and asking the plane about a customer id we do not have is a network round
      // trip that can only fail.
      const rows = await ctx.db
        .select({ stripeCustomerId: billingCustomers.stripeCustomerId })
        .from(billingCustomers)
        .where(eq(billingCustomers.accountId, ctx.accountId))
        .limit(1);
      const customer = rows[0]?.stripeCustomerId;
      if (!customer) {
        throw new ServiceError(
          "no_billing_account", 404,
          "this account has no billing customer yet — start a subscription first",
        );
      }
      return { stripeCustomerId: customer };
    },

    async subscriptionStatus(ctx) {
      // THE SAME READ THE MAILBOX GATE MAKES, and that identity is the fix: the two surfaces
      // used to read different rows and disagree about one account.
      //
      // This was `newestSubscriptionOf` — newest-of-any-status, always. The reasoning
      // is still right as far as it goes: `liveSubscriptionOf` alone would report
      // `no_subscription` for an account that cancelled an hour ago and would cut the 30-day
      // export window `entitlementsFor` exists to grant (a billing event must never destroy
      // user data). What it missed is that
      // newest-of-any-status lets a DEAD row speak for an account that has a live one — an
      // abandoned Checkout's `incomplete_expired` row is bumped ~23 h after it was created, so it
      // out-ranks the `active` row the customer is actually paying for, and this route answered
      // `no_subscription` with `mailboxLimit: 0` for a paying account while `assertMayAddMailbox`
      // was admitting them.
      //
      // `effectiveSubscriptionOf` keeps the seam (the fallback IS `newestSubscriptionOf`'s
      // ordering) and removes the shadowing, and it is the SAME function the gate calls — no
      // `forUpdate` here, because a read must not take write locks on every request.
      const sub = await effectiveSubscriptionOf(ctx.db, ctx.accountId);
      const balance = await balanceOf(ctx.db, ctx.accountId);
      // The account's real suspension state (cloud 0008), so the status route reports
      // `reason: "suspended"` for a suspended account rather than its subscription's own word.
      const suspended = await isSuspended(ctx.db, ctx.accountId);
      // THE OWNER'S OWN AI SWITCH, because `entitlements.aiEnabled` is read as "may this account
      // spend?" and that question has TWO conjuncts. The spend gate refuses on this row before it
      // reads any subscription; this route did not read it at all, so a funded trial whose owner
      // had switched managed AI off was published as `aiEnabled: true` — and the Screener line
      // whose whole purpose is to explain a refusal BEFORE the press instead offered the purchase
      // and let the server answer 409 after it.
      //
      // One extra primary-key read on a settings route, and it is the same row `GET /account/ai`
      // serves, so the two surfaces cannot disagree about one account.
      const aiSwitchOn = await getAiEnabled(ctx.db as unknown as Tx, ctx.accountId);
      // HAS REVENUE EVER LANDED — one indexed limit-1 read, for one label. The client's
      // trial-pot line keys off `subscription.status === "trialing"`, and that is true for a
      // window AFTER `invoice.paid` has already granted the plan's allowance (the
      // subscription-updated event that flips the status is its own delivery). In that window
      // the balance is paid credits, and calling them a trial pot states a provenance that is
      // false while the number is real. The ledger row is the fact the label needs,
      // so the route ships it rather than letting the client guess from the status.
      const invoiceGranted = (await latestInvoiceGrantSource(ctx.db, ctx.accountId)) !== null;
      // COMPOSED, never re-decided: every policy question — trial semantics, grace, the export
      // window, `paused`, fail-closed nulls — is already answered by `entitlementsFor`, and an
      // `if (status === …)` here would be a second copy of it that drifts.
      const entitlements = entitlementsFor({
        sub,
        balance,
        suspended,
        aiSwitchOn,
        now: ctx.now(),
      });
      return {
        subscription: sub
          ? {
            plan: sub.plan,
            status: sub.status,
            mailboxLimit: sub.mailboxLimit,
            monthlyCredits: sub.monthlyCredits,
            currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            graceUntil: sub.graceUntil?.toISOString() ?? null,
          }
          : null,
        balance,
        entitlements,
        plans: PLAN_LIMITS,
        trialCredits: TRIAL_GRANT_CREDITS,
        invoiceGranted,
      };
    },

    /**
     * THE APPLY PATH. Resolve → claim+apply in ONE transaction → 200. The verify half
     * (signature + envelope) already happened at the plane, and the relay in `routes/billing.ts`
     * never calls this for a refused delivery — so the first write this function can make is the
     * claim, inside the transaction, exactly as the original `handleWebhook` was arranged.
     *
     *  1. the DTO version — a deploy skew between plane and open server is a RETRYABLE failure
     *     (500), never a silently misread event.
     *  2. resolve the account — a plain READ. A HANDLED kind that cannot be resolved is an apply
     *     FAILURE, not a silent 200: by the next retry the customer link usually exists, and
     *     acknowledging a money event we could not place is how a payment silently vanishes.
     *  2b. the TERMINAL NO-OP — `subscription` phase `deleted` whose resolved account no
     *     longer EXISTS ⇒ record applied-with-disposition and 200. The one shape whose retry
     *     can never succeed and whose effect has already happened (see the arm's comment);
     *     every sibling kind for a missing account stays on arm 5, loudly.
     *  3. `db.transaction`: claim, then apply. The claim row and the effect become durable
     *     TOGETHER — and that is why there is no window in which credits exist
     *     without their dedup record or vice versa. `claimed === false` ⇒ already applied ⇒
     *     commit a transaction that wrote nothing ⇒ 200.
     *  4. `LedgerReplayError` ⇒ the transaction (claim included) has rolled back and the money
     *     this event describes is already in the ledger under a DIFFERENT event id.
     *
     *     Where a second event id for one money movement actually comes from, corrected: NOT
     *     from `stripe events resend`, which re-delivers the SAME `evt_…` and is therefore
     *     stopped one layer earlier by the claim. It comes from Stripe emitting two DISTINCT
     *     Event objects describing the same resource transition — which Stripe documents as
     *     possible and which no consumer can prevent — and from any re-drive of an invoice
     *     through a second endpoint or a second delivery pipeline. The defence is the same
     *     either way, and it has to live at the LEDGER (keyed by invoice id) rather than at the
     *     claim (keyed by event id), because only the ledger knows the two ids are one payment.
     *
     *     Record the new id as applied-with-no-effect, then 200. Without this the resent id is
     *     never recorded and is retried forever against a ledger that will keep throwing —
     *     harmless to the money, but the audit trail would lie by omission.
     *  5. anything else ⇒ record `failed` from its OWN transaction (the apply tx rolled back, so
     *     it can only be written from outside) and answer **500**. `failed` is what keeps the
     *     event CLAIMABLE on Stripe's next retry. Answering 200 here is the classic
     *     money-loss: Stripe stops retrying and the credits are never granted.
     */
    async applyEvent(db, event) {
      const claim = {
        stripeEventId: event.id,
        type: event.type,
        accountId: null as string | null,
        payload: event.payload,
        eventTs: fromUnix(event.created),
      };

      try {
        if (event.v !== ENTITLEMENT_EVENT_VERSION) {
          throw new BillingApplyError(
            "entitlement_event_version",
            `applyEvent: the plane speaks EntitlementEvent v${String(event.v)} and this server ` +
              `v${ENTITLEMENT_EVENT_VERSION} — a deploy skew; retryable, never misread`,
          );
        }
        const accountId = await resolveAccount(db as unknown as Tx, event);
        claim.accountId = accountId;
        if (accountId == null && event.kind !== "ignored") {
          throw new BillingApplyError(
            "account_unresolved",
            `${event.type}: no account could be resolved from the subscription metadata or the customer link`,
          );
        }

        // ── THE TERMINAL NO-OP: subscription.deleted for a subject that no longer exists ──
        //
        // The DELETED phase alone, and only when the `accounts` row is GONE. The measured case
        // (2026-08-19, a live-mode event): the subscription's metadata names an account that
        // has been removed outright, so the mirror upsert can only ever fail the `accounts`
        // FK — and a `failed` row that can never succeed is not an operator queue item, it is
        // a stuck `billing_events_failed` alert, paging hourly about a cancellation that has
        // already happened. There is nothing to mirror (the row the mirror would write is
        // FK-anchored to the missing account) and nothing to revoke (the event IS the
        // revocation, already done at Stripe), so this is recorded as applied-with-disposition
        // and the retries stop.
        //
        // DELIBERATELY NOT its siblings: a `created`/`updated` for a missing account is a LIVE
        // subscription with nowhere to land — money being taken for nothing — and an
        // `invoice.paid` doubly so. Those keep the loud 500 + `failed` + alert path below (the
        // ordinary cause is a checkout racing account provisioning, where the retry heals it;
        // the extraordinary one is exactly what a human must see). The check-then-act race —
        // an account deleted between this read and the transaction — falls through to the FK
        // failure and self-heals on the next delivery, in this arm.
        //
        // `claim.accountId` is dropped for the record: `billing_events.account_id` FKs
        // `accounts` too (the same reason the failure fallback drops attribution), so the
        // orphaned id survives in the disposition text instead.
        if (event.kind === "subscription" && event.phase === "deleted" && accountId != null) {
          const alive = await (db as unknown as Tx)
            .select({ id: accounts.id })
            .from(accounts)
            .where(eq(accounts.id, accountId))
            .limit(1);
          if (alive.length === 0) {
            const disposition =
              `noop: ${event.type} for account ${accountId}, which no longer exists — ` +
              `nothing to mirror or revoke; recorded as applied with no effect`;
            const recorded = await attempt(() =>
              recordBillingEventNoop(db as unknown as Tx, { ...claim, accountId: null }, disposition));
            if (!recorded) {
              // Unlike the replay path, a 200 here without the row would erase the event from
              // every audit surface — there is no ledger row testifying it existed. No money
              // is at stake either way, so the safe direction is the retryable one.
              raise({
                stage: "record", code: "noop_record_failed",
                stripeEventId: event.id, eventType: event.type, accountId,
              });
              return { status: 500, body: { error: "apply_failed" } };
            }
            return { status: 200, body: { received: true, orphaned: true } };
          }
        }

        await db.transaction(async (tx) => {
          const claimed = await claimBillingEvent(tx as LedgerTx, claim);
          if (!claimed) return;                        // already applied — commit nothing
          if (accountId != null) await applyKind(tx as LedgerTx, event, accountId);
        });
        return { status: 200, body: { received: true } };
      } catch (err) {
        if (err instanceof LedgerReplayError) {
          // The effect is already recorded under another event id. Record THIS id as applied
          // with no effect so the trail is complete, and stop the retries.
          //
          // BEST EFFORT, deliberately. `LedgerReplayError` is raised only by the primitives, and
          // only when the money this event describes is ALREADY in the ledger — so 200 is
          // factually correct whether or not we manage to write the audit row. Letting a failed
          // bookkeeping write turn this into a 500 would make Stripe retry, for three days, an
          // event that can never apply.
          //
          // "Best effort" is not "unobserved", though: a trail that can lie by omission has to
          // say so out loud, so a failure to record raises an alert rather than disappearing.
          const recorded = await attempt(() => db.transaction(async (tx) => {
            await claimBillingEvent(tx as LedgerTx, claim);
          }));
          if (!recorded) {
            raise({
              stage: "record", code: "replay_record_failed",
              stripeEventId: event.id, eventType: event.type, accountId: claim.accountId,
            });
          }
          return { status: 200, body: { received: true, replay: true } };
        }
        // Also best effort, and for the opposite reason: the 500 is the load-bearing part (it is
        // what keeps Stripe retrying and the claim re-takeable), so it must not be lost to a
        // second failure while recording the first. This is not hypothetical — a claim whose
        // `account_id` does not satisfy the `accounts` foreign key fails BOTH the apply and its
        // own failure record, and without this the throw escaped the handler entirely.
        const code = scrub(err);
        let recorded = await attempt(() => recordBillingEventFailure(db as unknown as Tx, claim, code));
        if (!recorded && claim.accountId != null) {
          // THE FALLBACK AUDIT ROW (fix #7). The measured case is an `account_id` that does not
          // satisfy the `accounts` foreign key: the apply fails, and so does the record of it, so
          // the ONE query an operator has ("select … from billing_events where status='failed'")
          // is blind to precisely the failures that lost the most. `account_id` is nullable, so
          // dropping it lands the row — an unattributed failure is still a failure someone can
          // see, and the payload it carries is what re-attributes it.
          recorded = await attempt(
            () => recordBillingEventFailure(db as unknown as Tx, { ...claim, accountId: null }, code),
          );
        }
        // THE ALERT (fix #7). The failure path was correct and completely silent: 500, `failed`,
        // retryable — and after ~3 days Stripe stops, the customer has paid, the grant never
        // landed, every test is green and no human is told. This is the signal; a sink that
        // reaches a person is the host's job (`apps/api-vercel/src/deps.ts`).
        raise({
          stage: recorded ? "apply" : "record",
          code: recorded ? code : `${code}+record_failed`,
          stripeEventId: event.id, eventType: event.type, accountId: claim.accountId,
        });
        // 500, so Stripe retries with backoff for ~3 days and the claim stays re-takeable.
        return { status: 500, body: { error: "apply_failed" } };
      }
    },

    /**
     * STOP THE MONEY WHEN THE PERSON IS ERASED.
     *
     * `deleteAccount` removes every user, mailbox and credential and KEEPS the billing rows —
     * the `credit_ledger` FK forbids deleting them and Art. 17(3)(b) says financial records
     * stay. Nothing in that transaction touches Stripe, so before this method existed a
     * customer who deleted their account kept being charged, and had no session left to
     * cancel with. That is not a retention obligation, it is a charge nobody can stop.
     *
     * ── WHY THIS IS NOT INSIDE THE ERASURE TRANSACTION ──────────────────────────────────
     *
     * The same law the checkout seam is written under: no local transaction can contain a
     * remote object. A rolled-back erasure would not un-cancel a subscription, and a plane
     * call held open inside a transaction holds row locks across a network round trip. So the
     * caller runs this FIRST, outside, and erases regardless of the answer — see
     * `packages/api/src/routes/account.ts` for why that order is the safe one.
     *
     * ── WHY IT DOES NOT THROW, AND WHY IT IS BOUNDED ────────────────────────────────────
     *
     * Erasure is a right, not a favour, and it may not be blocked by a payment processor —
     * or, post-extraction, by the PLANE — being unreachable (ruling risk #5). A refusal is
     * reported (`cancel_failed`) and the operator can find the wreckage: a LIVE
     * `billing_subscriptions` row on an account with zero `users` is exactly the query, and
     * `billing_customers` still holds the Stripe customer id. The bound
     * ({@link ERASURE_CANCEL_TIMEOUT_MS}) is new with the seam and non-negotiable: the plane
     * is a network hop inside an Art. 17 request, so a HANG must decay into the same reported
     * failure a refusal does.
     *
     * `LIVE_SUBSCRIPTION_STATUSES` decides what "live" means, so a `canceled` row is `none`
     * and this is safe to run twice.
     */
    async cancelForErasure(ctx, plane) {
      const rows = await ctx.db
        .select({ stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId })
        .from(billingSubscriptions)
        .where(and(
          eq(billingSubscriptions.accountId, ctx.accountId),
          inArray(billingSubscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
        ))
        .limit(1);
      const subscriptionId = rows[0]?.stripeSubscriptionId;
      if (!subscriptionId) return "none";

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const call = plane.cancelSubscription({ stripeSubscriptionId: subscriptionId });
        // A cancel that HANGS past the bound and then rejects would otherwise become an
        // unhandled rejection long after this request answered. Attaching a handler here marks
        // the eventual rejection observed; the race below still sees the original promise.
        call.catch(() => {});
        await Promise.race([
          call,
          new Promise<never>((_, rejectAt) => {
            timer = setTimeout(
              () => rejectAt(new Error("cancelForErasure: the plane did not answer inside the bound")),
              ERASURE_CANCEL_TIMEOUT_MS,
            );
          }),
        ]);
        return "cancelled";
      } catch {
        // Deliberately swallowed rather than rethrown, and deliberately NOT alerted through
        // `cfg.alert`: that sink is the webhook pipeline's vocabulary (`stage`, `stripeEventId`)
        // and this is not a webhook. The signal that matters is durable in the database — a live
        // subscription row whose account has no users — and it outlives any log line.
        return "cancel_failed";
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
