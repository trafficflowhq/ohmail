import type {
  EntitlementAddon, EntitlementEvent, EntitlementPlan, ReconcilePageDTO,
} from "./entitlement-event.js";

/**
 * `BillingPlanePort`: how the open server reaches the Stripe machinery, and the ONLY way
 * it may.
 *
 * The port is the extraction seam. It was first implemented in-tree over the then-existing
 * `StripePort` so production behaviour stayed byte-identical while the seam bedded in; then
 * the HTTP client of the private plane (`plane-client.ts`) was added; finally the composition
 * root flipped and the in-tree adapter was DELETED together with the `stripe` dependency. The
 * client is the only
 * implementation left in this repository — routes and tests are written against THIS surface,
 * so nothing re-plumbed at the flip.
 *
 * The zero-external-requests rule applies to it exactly as it did to `StripePort`: no test may
 * dial the plane. The
 * port is injected and faked everywhere; the plane's own tests live with the plane.
 */

/** What the open checkout preflight hands the plane — the `POST /v1/checkout` body. */
export interface PlaneCheckoutRequest {
  /** From the SESSION, never the body — becomes `client_reference_id` + subscription metadata. */
  accountId: string;
  plan: EntitlementPlan;
  /**
   * The billing cadence the customer chose — 'month' (the pricing page's default) or 'year'
   * (two months free). The plane picks the corresponding configured price; it is also a
   * parameter of the Stripe idempotency key, because two otherwise-identical clicks that
   * differ here are genuinely different sessions.
   */
  interval: "month" | "year";
  /**
   * The open preflight's verdict (no non-incomplete subscription history), which selects the
   * no-card trial fork. It is a PARAMETER of the Stripe idempotency key, because it is the one
   * input that can flip between two otherwise-identical calls.
   */
  trialEligible: boolean;
  /** The existing customer to reuse on a resubscribe, or null to let Checkout mint one. */
  stripeCustomerId: string | null;
}

/**
 * The webhook verdict, IN-BAND. The two arms are deliberately asymmetric, because Stripe reads
 * the status as an instruction (ruling risk #1):
 *
 *  · `{ ok: false }` is an EXPLICIT refusal — a bad signature or a bad envelope. The relay
 *    answers 400 with `body`, and Stripe drops the event forever. Only the plane's own verdict
 *    may produce this.
 *  · A plane that is unreachable, times out, or answers 5xx must REJECT the promise. The relay
 *    maps a rejection to 503 so Stripe retries. An implementation that turns transport failure
 *    into `{ ok: false }` converts an outage into permanent, silent money loss.
 */
export type WebhookVerdict =
  | { ok: true; event: EntitlementEvent }
  | { ok: false; body: unknown };

export interface BillingPlanePort {
  /**
   * Build a Checkout session for a preflighted request. The plane owns the Stripe parameters —
   * price ids, the trial fork's settings, the return URLs, the deterministic idempotency key.
   * Throws on any Stripe failure or a session with no URL; the route's error envelope answers.
   */
  checkout(req: PlaneCheckoutRequest): Promise<{ url: string }>;

  /**
   * Open the Billing Portal for a customer the OPEN preflight already resolved — the
   * 404-before-network read stays open-side, so the plane is never asked about a customer that
   * does not exist.
   */
  portal(req: { stripeCustomerId: string }): Promise<{ url: string }>;

  /**
   * Cancel a subscription immediately — the erasure path, and nothing else. Throws on
   * refusal; the open caller (`cancelForErasure`) bounds it in time and maps every failure to
   * `"cancel_failed"`, because Art. 17 may not be blocked by a payment processor.
   */
  cancelSubscription(req: { stripeSubscriptionId: string }): Promise<void>;

  /**
   * SET an add-on's quantity on a live subscription — the purchase and the removal are one
   * declarative operation, so a double-click sets the same number twice instead of buying
   * twice. The plane adds/updates/deletes the add-on line item with `always_invoice`
   * proration, so an increase charges the card on file immediately (revenue precedes the
   * entitlement mirror) and a decrease credits the balance. Throws on any Stripe failure —
   * including a subscription with no payable card — and the route's error envelope answers.
   */
  setAddonQuantity(req: {
    stripeSubscriptionId: string; addon: EntitlementAddon; quantity: number;
  }): Promise<void>;

  /**
   * Verify a webhook delivery over the EXACT raw bytes and translate it.
   *
   * `rawBody` must be the request body verbatim — any re-encoding fails every HMAC, and a 400
   * tells Stripe never to retry (billing.ts:43), so a byte-mangling relay is permanent money
   * loss. `signature` is the `stripe-signature` header, passed through untouched; `null` (the
   * header missing) is an explicit refusal, not a transport failure.
   *
   * @returns the in-band verdict — see {@link WebhookVerdict} for the 400/503 contract.
   */
  verifyWebhook(rawBody: Uint8Array, signature: string | null): Promise<WebhookVerdict>;

  /**
   * THE RECONCILIATION READ — one page of the plane's Stripe subscription list
   * (`status: "all"`), each subscription translated into the `subscription`-kind event the
   * missed webhook would have carried. The plane decides nothing; the comparison against the
   * mirror and the apply both live HERE, open-side (`entitlements/reconcile.ts`), which is what
   * keeps the extraction ruling's boundary: no plane→open callback, no second write path.
   * Throws on any plane/Stripe failure — the pass records a failed run, never a converged one.
   */
  reconcileSubscriptions(req: { cursor: string | null; limit: number }): Promise<ReconcilePageDTO>;
}
