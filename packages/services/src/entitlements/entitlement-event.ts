/**
 * `EntitlementEvent` v2: what the billing plane hands the open server after it has
 * verified a Stripe delivery. (v2, 2026-08-22: items and lines carry the plane's add-on and
 * billing-interval verdicts — the annual prices and the two paid add-ons.)
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
export const ENTITLEMENT_EVENT_VERSION = 2 as const;

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
