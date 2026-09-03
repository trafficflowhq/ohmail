import { and, eq, sql } from "drizzle-orm";
import { billingInvoices } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * THE INVOICE MIRROR'S TWO WRITE PRIMITIVES — one fenced upsert, one fenced reversal.
 *
 * ## Why the statements live here and not at either call site
 *
 * `billing_invoices` has two writers that must not disagree: the webhook apply
 * (`applyInvoicePaid`, inside the transaction that grants the month's credits) and the daily
 * reconcile pass (`reconcile-invoices.ts`, healing invoices whose webhook was never delivered).
 * Both are upserts under the same last-write-wins fence, and a fence written twice is a fence
 * that will eventually be written differently — which is the whole class of defect
 * `stripe_event_ts` exists to close.
 *
 * So there is one statement, and both callers take it. `packages/db` is the right home for the
 * same reason `credits.ts` is: this module interprets rows whose schema is next door, and both
 * callers already depend on it.
 *
 * ## THE FENCE, and why an ignored write is a SUCCESS
 *
 * Stripe fans deliveries out in parallel and retries them independently, so `invoice.paid` from
 * T+10 and `invoice.payment_failed` from T+5 can arrive in either order. An application-level
 * read-then-write cannot fix that: two deliveries both read the old row and both write it. The
 * defence is in the statement — `DO UPDATE … WHERE existing.stripe_event_ts <= excluded` — so an
 * older event updates ZERO rows and {@link upsertBillingInvoice} answers `false`.
 *
 * `false` is not a failure and callers must not retry it. It means "Stripe told us something we
 * already know to be stale", which is a correct outcome; the webhook still answers 200 and the
 * reconcile still counts the invoice as examined.
 *
 * `<=` rather than `<` on equal timestamps follows `billing_subscriptions`' choice verbatim:
 * `event.created` has one-second resolution, so two genuinely different deliveries can tie, and
 * the later ARRIVAL wins a tie. The one exception is the terminal reversal states, which the
 * statement protects separately — see below.
 *
 * ## WHAT THE UPSERT NEVER TOUCHES, and this is the load-bearing half
 *
 * Neither `amount_refunded_cents` nor a `refunded`/`disputed` status is written by
 * {@link upsertBillingInvoice}, ever.
 *
 * The reason is the reconcile pass. Stripe's INVOICE object has no notion of a refund — refunds
 * and disputes live on the CHARGE — so the invoice the reconciler observes for a fully refunded
 * customer still reads `status: "paid"`, with no field anywhere saying money went back. A
 * reconcile that mapped that state onto the mirror would, every single night, silently undo the
 * reversal arm's work: the refund figure would reset to zero and the row would go back to
 * `paid`, on a schedule, with nothing failing and the board quietly over-reporting revenue.
 *
 * The mirror therefore treats the two reversal states as TERMINAL against this path. They are
 * written only by {@link recordInvoiceReversal}, from a `charge.refunded` or
 * `charge.dispute.funds_withdrawn` delivery, which is the only evidence that exists.
 */

/** The mirror's six-word status vocabulary — the migration's CHECK, in the type system. */
export type BillingInvoiceStatus =
  | "paid" | "payment_failed" | "void" | "uncollectible" | "refunded" | "disputed";

/** Which writer produced a row. `billing_invoices.source`'s CHECK, in the type system. */
export type BillingInvoiceSource = "webhook" | "reconcile";

/** One invoice as a writer knows it. Every field is projected from a DTO; nothing is inferred. */
export interface BillingInvoiceWrite {
  stripeInvoiceId: string;
  accountId: string;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  billingReason: string | null;
  /** Never `refunded`/`disputed` from this path — see the module header. */
  status: Exclude<BillingInvoiceStatus, "refunded" | "disputed">;
  currency: string;
  amountPaidCents: number;
  plan: string | null;
  billingInterval: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date | null;
  /** The FENCE. `event.created` for a webhook; the plane's `observedAt` for a reconcile. */
  stripeEventTs: Date;
  source: BillingInvoiceSource;
}

/**
 * Write one invoice, fenced.
 *
 * @returns `true` when the row was inserted or updated, `false` when the fence refused a stale
 * event or the row is in a terminal reversal state. **`false` is a success**, and a caller that
 * retries on it will retry for ever — see the module header.
 */
export async function upsertBillingInvoice(tx: Tx, w: BillingInvoiceWrite): Promise<boolean> {
  const written = await tx
    .insert(billingInvoices)
    .values({
      stripeInvoiceId: w.stripeInvoiceId,
      accountId: w.accountId,
      stripeSubscriptionId: w.stripeSubscriptionId,
      stripeCustomerId: w.stripeCustomerId,
      billingReason: w.billingReason,
      status: w.status,
      currency: w.currency,
      amountPaidCents: w.amountPaidCents,
      plan: w.plan,
      billingInterval: w.billingInterval,
      periodStart: w.periodStart,
      periodEnd: w.periodEnd,
      paidAt: w.paidAt,
      stripeEventTs: w.stripeEventTs,
      source: w.source,
    })
    .onConflictDoUpdate({
      target: billingInvoices.stripeInvoiceId,
      set: {
        // `account_id` is deliberately NOT in the update set. An invoice cannot change owner,
        // and if the two writers ever disagreed about who owns one, the row silently moving
        // under a nightly pass is strictly worse than the two disagreeing visibly.
        stripeSubscriptionId: sql`excluded.stripe_subscription_id`,
        stripeCustomerId: sql`excluded.stripe_customer_id`,
        billingReason: sql`excluded.billing_reason`,
        status: sql`excluded.status`,
        currency: sql`excluded.currency`,
        amountPaidCents: sql`excluded.amount_paid_cents`,
        plan: sql`excluded.plan`,
        billingInterval: sql`excluded.billing_interval`,
        periodStart: sql`excluded.period_start`,
        periodEnd: sql`excluded.period_end`,
        paidAt: sql`excluded.paid_at`,
        stripeEventTs: sql`excluded.stripe_event_ts`,
        source: sql`excluded.source`,
        updatedAt: sql`now()`,
      },
      // TWO conditions, and the second is not a refinement of the first.
      //
      //  · the FENCE — an older event updates nothing (see the module header);
      //  · the TERMINAL REVERSAL GUARD — a row that says `refunded` or `disputed` is not
      //    overwritten by ANY later observation, however fresh its stamp. Stripe's invoice
      //    object cannot express a refund, so the freshest possible observation of a refunded
      //    invoice still says `paid`; without this clause the nightly reconcile would reset the
      //    refund every night, on a schedule, with nothing failing.
      setWhere: and(
        sql`${billingInvoices.stripeEventTs} <= excluded.stripe_event_ts`,
        sql`${billingInvoices.status} not in ('refunded','disputed')`,
      ),
    })
    .returning({ id: billingInvoices.stripeInvoiceId });
  return written.length > 0;
}

/** What a `charge.refunded` / `charge.dispute.funds_withdrawn` delivery knows about the money. */
export interface InvoiceReversalWrite {
  stripeInvoiceId: string;
  /** CUMULATIVE reversed cents — Stripe's `amount_refunded`, or the dispute's own amount. */
  amountRefundedCents: number;
  /** `refunded` for a refund, `disputed` for a lost dispute. */
  status: Extract<BillingInvoiceStatus, "refunded" | "disputed">;
  /** The FENCE — `event.created` of the reversal delivery. */
  stripeEventTs: Date;
}

/**
 * Record a reversal against an invoice the mirror already holds.
 *
 * ## It never INSERTS, and that is a decision
 *
 * A reversal knows the money and the invoice id; it does not know what the invoice was FOR — no
 * amount paid, no period, no plan. Creating a row from it would mean inventing an
 * `amount_paid_cents`, and a fabricated denominator on a refund rate is worse than a missing
 * numerator. So a reversal for an invoice the mirror never saw (its `invoice.paid` was lost
 * before this slice existed, or never applied) matches ZERO rows and answers `false` — which the
 * caller turns into an alert, because unattributable money is exactly what a human should see.
 *
 * The suspension is unaffected either way: `applyKind`'s reversal arm suspends the account from
 * the customer link, and always has. This write only decides whether the board can put a figure
 * on it.
 *
 * ## CUMULATIVE, so it SETS rather than adds
 *
 * Stripe's `charge.amount_refunded` is the running total after this refund, so two partial
 * refunds deliver 500 then 900 rather than 500 then 400. Setting is therefore both correct and
 * idempotent — a redelivered event writes the same number — while adding would double-count
 * every retry Stripe makes. `GREATEST` guards the one remaining order problem: two partial
 * refunds delivered out of order would otherwise let the smaller running total win.
 *
 * @returns `true` when a row was updated; `false` when the mirror holds no such invoice or the
 * fence refused a stale delivery.
 */
export async function recordInvoiceReversal(
  tx: Tx, w: InvoiceReversalWrite,
): Promise<boolean> {
  const updated = await tx
    .update(billingInvoices)
    .set({
      amountRefundedCents: sql`greatest(${billingInvoices.amountRefundedCents}, ${w.amountRefundedCents})`,
      status: w.status,
      stripeEventTs: w.stripeEventTs,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(billingInvoices.stripeInvoiceId, w.stripeInvoiceId),
      // The same fence as every other write on this table. A re-ordered reversal must not drag
      // the row's stamp backwards, because that stamp is what the reconcile pass compares
      // against — a backdated row would be re-healed and lose its reversal.
      sql`${billingInvoices.stripeEventTs} <= ${w.stripeEventTs.toISOString()}::timestamptz`,
    ))
    .returning({ id: billingInvoices.stripeInvoiceId });
  return updated.length > 0;
}
