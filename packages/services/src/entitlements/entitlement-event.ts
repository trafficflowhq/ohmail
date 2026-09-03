/**
 * `EntitlementEvent` v3: what the billing plane hands the open server after it has
 * verified a Stripe delivery. (v2, 2026-08-22: items and lines carry the plane's add-on and
 * billing-interval verdicts — the annual prices and the two paid add-ons. v3, 2026-09-03: a
 * revenue reversal carries the MONEY it reversed and the invoice it reversed, so the invoice
 * mirror can record a refund as cents rather than as a suspension nobody can put a figure on.)
 *
 * This file is the WIRE CONTRACT between two programs that must not link (the AGPL boundary):
 * the private plane verifies the HMAC, checks the envelope (`livemode`, `api_version`, the org
 * account stamp) and maps price ids to plans; the open server executes — the claim, the mirror,
 * the ledger. So the shape here is a projection of exactly the fields the open apply logic
 * reads, plus the verified payload verbatim for the audit trail, and NOTHING here may import
 * `stripe`: the plane repo re-declares this structurally, and a type dependency in either
 * direction would be the link the boundary forbids.
 *
 * ## Versioning
 *
 * The version is stamped on every event. A field the apply logic newly needs is a NEW VERSION, not a
 * quiet widening: the plane and the open server deploy separately, so an optional field
 * silently absent is `undefined` flowing into a credit computation — the exact failure class the
 * plane's own `api_version` pin exists to refuse.
 *
 * ## Decisions live open-side
 *
 * The plane TRANSLATES; it does not decide. `kind` is a mechanical mapping of the eight handled
 * Stripe event types (an unhandled type is `"ignored"`, so Dashboard config drift stays a
 * recorded 200, never a 400 or a 500 loop). `plan` on a price is the ONE mapping the plane owns,
 * because the price ids are plane configuration — `null` means "not one of the configured plan
 * prices", and every open consumer turns that into a retryable failure, never a default.
 */

/** The version this module speaks. The plane stamps it; the open server refuses anything else. */
export const ENTITLEMENT_EVENT_VERSION = 3 as const;

/**
 * The two purchasable add-ons, as the plane's verdict about a price id. Structurally identical
 * to `AddonKind` in `@trafficflow/db/cloud` (`keyof typeof ADDON_CARD`), re-declared here for
 * the same reason `EntitlementPlan` is: this contract file imports nothing.
 */
export type EntitlementAddon = "storage" | "mailbox";

/** The billing cadence of a configured price — the plane knows it from its own price map. */
export type EntitlementInterval = "month" | "year";

/**
 * The plan a price id maps to. Structurally identical to `Plan` in `@trafficflow/db/cloud`
 * (`keyof typeof PLAN_LIMITS`), re-declared here so the contract file imports nothing.
 */
export type EntitlementPlan = "solo" | "plus" | "pro";

interface EntitlementEventBase {
  v: typeof ENTITLEMENT_EVENT_VERSION;
  /** Stripe's `evt_…` — the claim key in `billing_events`. */
  id: string;
  /** The literal Stripe event type, recorded in `billing_events.type`. */
  type: string;
  /** `event.created`, unix SECONDS — the mirror fence and the dunning-grace clock. */
  created: number;
  /**
   * The verified event exactly as Stripe delivered it, parsed. Stored verbatim in
   * `billing_events.payload` (the audit trail and the re-attribution data for an unattributed
   * failure) and read by NOTHING else — every field the apply logic consumes is projected into
   * the typed members below, which is what keeps the apply side free of Stripe shapes.
   */
  payload: unknown;
}

/** `checkout.session.completed` — the customer↔account link, and nothing else. */
export interface CheckoutLinkDTO {
  /** `client_reference_id` — the account id our Checkout stamped on the session. */
  clientReferenceId: string | null;
  /** The session's customer id (`cus_…`), or null on a $0/no-customer session. */
  customerId: string | null;
  /** `customer_details.email ?? customer_email` — refreshes the link row's email. */
  customerEmail: string | null;
}

/** One subscription item — Basil keeps the period and the price on the ITEMS. */
export interface SubscriptionItemDTO {
  priceId: string | null;
  /** The plane's price→plan verdict for this item's price. `null` ⇒ not a configured plan price. */
  plan: EntitlementPlan | null;
  /**
   * The plane's price→ADD-ON verdict (v2). A subscription now legitimately carries several
   * items: exactly one PLAN item (`plan` set, `addon` null) and zero or more add-on items
   * (`addon` set, `plan` null). An item with BOTH null is an unconfigured price, which the open
   * mirror refuses exactly as it always refused an unknown plan price.
   */
  addon: EntitlementAddon | null;
  /** The item's quantity — how many units of an add-on. `null` when Stripe carries none. */
  quantity: number | null;
  /**
   * The configured price's cadence (v2), from the plane's own price map — `null` for a price
   * the map does not know. The mirror denormalizes the PLAN item's interval; an annual cycle
   * invoice grants twelve months of credits at once.
   */
  interval: EntitlementInterval | null;
  /** Unix seconds, or null when the item carries none. */
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
}

/** `customer.subscription.*` — the mirror's whole input. */
export interface SubscriptionDTO {
  /** `sub_…`. */
  id: string;
  /** Stripe's status word, verbatim — the open side owns the `SubscriptionStatus` domain. */
  status: string;
  /** The subscription's customer id, for the `billing_customers` fallback resolution. */
  customerId: string | null;
  /** `subscription_data.metadata.account_id` — the ordering-independent primary resolution. */
  accountIdFromMetadata: string | null;
  cancelAtPeriodEnd: boolean;
  /** `trial_end`, unix seconds — provenance on the trial bounty's ledger row. */
  trialEnd: number | null;
  items: SubscriptionItemDTO[];
}

/** One invoice line — only what the grant policy reads. */
export interface InvoiceLineDTO {
  priceId: string | null;
  /** The plane's price→plan verdict for this line's price. */
  plan: EntitlementPlan | null;
  /** The plane's price→ADD-ON verdict (v2). Add-on lines never grant credits. */
  addon: EntitlementAddon | null;
  /** The configured price's cadence (v2) — the ×12 decision on an annual cycle grant. */
  interval: EntitlementInterval | null;
  /** The line's amount in cents — sign separates a proration pair's old (−) from new (+). */
  amount: number;
  /** Whether Stripe marks this line a proration (either parent shape). */
  proration: boolean;
}

/** `invoice.paid` / `invoice.payment_failed`. */
export interface InvoiceDTO {
  /** `in_…`, or null when the payload carries none (refused open-side). */
  id: string | null;
  billingReason: string | null;
  amountPaid: number;
  /**
   * The invoice's currency, ISO-4217 as Stripe reports it (v3). Held because the mirror stores
   * `amount_paid_cents` and a cent figure with no denomination beside it is a number that does
   * not exist — the same rule that keeps `value` and `unit` together on `platform_costs`.
   */
  currency: string;
  /**
   * The billed PERIOD, unix seconds, or null (v3). Stripe's Basil shapes keep the period on the
   * invoice's LINES, so the plane takes the widest span across them — min start, max end — which
   * is the same composition `periodOf` performs for a subscription's items. It is on the mirror
   * so the board can say what a payment BOUGHT rather than only when it arrived: an annual
   * invoice and a monthly one are the same cents and very different revenue.
   */
  periodStart: number | null;
  periodEnd: number | null;
  /**
   * `status_transitions.paid_at`, unix seconds, or null (v3) — when STRIPE says the money
   * arrived, which is not when we heard about it.
   *
   * The distinction is the whole reason this is a field rather than `event.created`. The mirror
   * has two writers, and the reconcile pass can heal an invoice weeks after the fact; keyed on
   * the event clock, that invoice would land in the month we noticed rather than the month it was
   * paid, and a monthly cash figure that moves when the reconciler runs is not a cash figure.
   * Null on a `payment_failed` — nothing was paid — and null on a paid invoice whose payload
   * carries no transition, where the mirror records the money and not the moment.
   */
  paidAt: number | null;
  customerId: string | null;
  /** `parent.subscription_details.subscription` — the mirror row this invoice belongs to. */
  subscriptionId: string | null;
  /** `parent.subscription_details.metadata.account_id`. */
  accountIdFromMetadata: string | null;
  /**
   * `lines.has_more` — a TRUNCATED list may hide a recurring line, so the open policy refuses
   * to reason about it. The plane must never page the list to "complete" it: the refusal is
   * the policy, and it is exercised by tests that set this flag.
   */
  linesTruncated: boolean;
  lines: InvoiceLineDTO[];
}

/** `charge.refunded` / `charge.dispute.funds_withdrawn` — revenue reversed ⇒ suspend. */
export interface RevenueReversalDTO {
  /** The charge or dispute id — the suspension row's source, `stripe:<type>:<objectId>`. */
  objectId: string;
  /**
   * The customer the reversed money belonged to. For a dispute the payload names only the
   * charge, so the PLANE resolves the charge to its customer (it holds the Stripe key); a
   * failed resolution is a plane 5xx, which the relay maps to 503 so Stripe re-drives.
   */
  customerId: string | null;
  /**
   * HOW MUCH was reversed, in the smallest currency unit (v3). For `charge.refunded` this is
   * the charge's `amount_refunded` — CUMULATIVE, so a second partial refund carries the running
   * total and the mirror can write it idempotently instead of adding; for a lost dispute it is
   * the dispute's own amount.
   *
   * It exists because the suspension alone could not answer the one question a money board is
   * for. "This account was suspended for a reversal" is a support fact; "we gave back $29 of the
   * $1,240 we took in March" is the fact that belongs in a revenue figure, and before v3 the only
   * place that number existed was inside `billing_events.payload`, which is un-granted for a
   * customer's postal address. Zero is a legitimate value (a $0 dispute is not a thing, but a
   * charge whose refunds have been reversed is), so this is a number and never null.
   */
  amountCents: number;
  /** The reversal's currency, ISO-4217 as Stripe reports it. Held for `amountCents`' sake: a
   *  cent figure with no denomination beside it is a number that does not exist. */
  currency: string;
  /**
   * The invoice the reversed charge PAID (`in_…`), or null.
   *
   * This is the field that makes the reversal reach the invoice mirror at all, and it is
   * nullable for two honest reasons rather than one: a charge created outside an invoice (a
   * one-off Dashboard charge) has none, and a DISPUTE names only its charge — the plane resolves
   * the charge to its invoice with the Stripe key it holds, and a resolution that fails is a
   * plane 5xx, which the relay maps to 503 so Stripe re-drives rather than a null that would
   * silently lose the figure.
   *
   * A null is NOT a failure open-side: the suspension still happens, exactly as it did in v2, and
   * the mirror simply has no row to attribute the money to. The board reads that as revenue it
   * cannot allocate, which is the truth.
   */
  stripeInvoiceId: string | null;
}

/**
 * The discriminated union the apply side switches on. `kind` is mechanical from `type`:
 *
 *  · `checkout.session.completed`                        → `checkout_completed`
 *  · `customer.subscription.created|updated`             → `subscription` (phase created/updated)
 *  · `customer.subscription.deleted`                     → `subscription` (phase deleted)
 *  · `invoice.paid`                                      → `invoice_paid`
 *  · `invoice.payment_failed`                            → `invoice_payment_failed`
 *  · `charge.refunded` / `charge.dispute.funds_withdrawn`→ `revenue_reversal`
 *  · anything else                                       → `ignored` (recorded, applied-no-op)
 */
export type EntitlementEvent =
  | (EntitlementEventBase & { kind: "checkout_completed"; checkout: CheckoutLinkDTO })
  | (EntitlementEventBase & {
    kind: "subscription";
    phase: "created" | "updated" | "deleted";
    subscription: SubscriptionDTO;
  })
  | (EntitlementEventBase & { kind: "invoice_paid"; invoice: InvoiceDTO })
  | (EntitlementEventBase & { kind: "invoice_payment_failed"; invoice: InvoiceDTO })
  | (EntitlementEventBase & { kind: "revenue_reversal"; reversal: RevenueReversalDTO })
  | (EntitlementEventBase & { kind: "ignored" });

/**
 * The `type` a RECONCILIATION event carries — a `subscription`-kind event the plane minted from
 * a LISTED subscription rather than from a delivered webhook. Not a Stripe event type on
 * purpose: the audit trail (`billing_events.type`) must name the provenance, and a row claiming
 * `customer.subscription.updated` with no `evt_…` behind it would be a half-truth. The apply
 * switch reads `kind`/`phase`, never this string, so the apply path is the webhook's verbatim.
 */
export const RECONCILIATION_EVENT_TYPE = "reconciliation.subscription" as const;

/**
 * One page of the reconciliation read — what the plane's `POST /v1/reconcile` answers.
 *
 * `events` holds, for EVERY subscription Stripe listed on this page (`status: "all"`, so
 * canceled subscriptions are present — the lost `customer.subscription.deleted` is the founding
 * case), the `subscription`-kind {@link EntitlementEvent} the missed webhook would have
 * carried: the same translation, `phase: "deleted"` when Stripe says `canceled`, `"updated"`
 * otherwise. The plane decides nothing — whether the mirror already holds that state is THIS
 * side's comparison, against its own rows (`entitlements/reconcile.ts`).
 *
 * `id` is `recon_<sha256 of the DTO>` — a pure function of the observed state, so a repeat pass
 * over an unchanged subscription mints the same event and the claim ledger dedups it exactly
 * like a resent webhook. `created` is `observedAt`: the moment the plane read the list, which
 * is what the mirror's `stripe_event_ts` fence measures against. `nextCursor` is Stripe's own
 * cursor (the last subscription id), or `null` on the last page.
 */
export interface ReconcilePageDTO {
  /** Unix SECONDS at which the plane read this page from Stripe. Stamped on every event. */
  observedAt: number;
  events: EntitlementEvent[];
  nextCursor: string | null;
}

/**
 * ONE INVOICE AS STRIPE HOLDS IT (v3) — the invoice reconciliation's unit, and deliberately NOT
 * an {@link EntitlementEvent}.
 *
 * The subscription reconciliation mints the `subscription`-kind event the missed webhook WOULD
 * have carried, so the heal runs down the webhook's own apply path and grants nothing twice. An
 * invoice cannot take that shape and must not be made to: minting an `invoice_paid` event for
 * every listed invoice would run `applyInvoicePaid` over the whole history, and that function
 * GRANTS CREDITS. The ledger's `UNIQUE (account_id, source)` would refuse the replays, correctly,
 * but the pass's whole output would then be `LedgerReplayError`s — a reconciler whose success
 * looks exactly like its failure.
 *
 * So this is an OBSERVATION, and the invoice pass compares it against the mirror row and upserts
 * the difference. No credits move on that path, ever: money is granted by the webhook and by
 * nothing else, which is the property that makes a daily full-history pass safe to run at all.
 */
export interface InvoiceStateDTO {
  /** `in_…`. */
  id: string;
  /** `parent.subscription_details.metadata.account_id` — the primary resolution, as ever. */
  accountIdFromMetadata: string | null;
  /** For the `billing_customers` fallback, exactly as the webhook's `resolveAccount` uses it. */
  customerId: string | null;
  subscriptionId: string | null;
  billingReason: string | null;
  /**
   * STRIPE'S OWN status word — `draft`, `open`, `paid`, `uncollectible`, `void`. Not the mirror's
   * six-word vocabulary: the translation is the OPEN side's, because the mirror's `refunded` and
   * `disputed` are states Stripe's invoice object does not have (they live on the charge) and a
   * reconcile that mapped a refunded invoice back to `paid` would silently undo the reversal
   * arm's work every night.
   */
  status: string;
  currency: string;
  amountPaid: number;
  plan: EntitlementPlan | null;
  interval: EntitlementInterval | null;
  periodStart: number | null;
  periodEnd: number | null;
  /** `status_transitions.paid_at`, unix seconds, or null. */
  paidAt: number | null;
  /** `created`, unix seconds — what a reconcile-sourced write stamps as its fence value. */
  created: number;
}

/**
 * One page of the INVOICE reconciliation read — what the plane's `POST /v1/reconcile/invoices`
 * answers.
 *
 * `observedAt` is the moment the plane read the page, and the invoice pass stamps it as the
 * `stripe_event_ts` of every row it writes. That is the conservative choice and it is the
 * opposite of the subscription pass's, which backdates by a second: there, a stale snapshot
 * losing a tie to a live webhook is the failure to avoid. Here the mirror row is a RECORD rather
 * than a live state — an invoice's amount does not change after it is paid — so the pass's job is
 * to fill gaps, and a fence that loses every tie would make a healed row un-healable if the same
 * pass ever had to correct it. The webhook still wins any genuine race, because its event clock
 * is the moment Stripe acted and the pass's is the moment we looked, which is later.
 */
export interface InvoiceReconcilePageDTO {
  /** Unix SECONDS at which the plane read this page from Stripe. */
  observedAt: number;
  invoices: InvoiceStateDTO[];
  nextCursor: string | null;
}
