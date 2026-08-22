import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { readBody } from "./shared.js";
import {
  billingPlane, billingPlaneOrNull, entitlements, entitlementsOrNull,
} from "./shared-cloud.js";

/**
 * The four billing endpoints on the extraction seam: every DB-facing
 * decision lives in the OPEN `EntitlementsService` (`packages/services/src/entitlements/`),
 * every Stripe-facing one behind the injected `BillingPlanePort` — the
 * HTTP client of the PRIVATE plane service, which is where all Stripe code and configuration
 * live; this host holds neither. The routes compose the two — preflight open, then the port —
 * and the composition is the host's (`apps/api-vercel/src/deps.ts`), so nothing here names a
 * concrete plane.
 *
 * ## The route OPTIONS are the security design, so each one is argued
 *
 * **`POST /billing/checkout` — default protected pipeline, nothing else.**
 *  · A session is required because the checkout is FOR this account: the preflight's
 *    `accountId` comes from `deps.session.accountId` and never from the body (contract §1.9).
 *    A body-supplied account id would let anyone start a subscription attached to someone
 *    else's account.
 *  · NOT `idempotent`. The idempotency machinery's law is that the dedup record commits in the SAME transaction as its
 *    effect, and the effect here is a REMOTE object in Stripe — no transaction can contain it,
 *    so marking the route idempotent would promise something the mechanism cannot deliver.
 *    Checkout sessions are cheap and expire on their own, and the one harmful double-outcome —
 *    two live subscriptions — is refused by the preflight's 409 in front and by
 *    `billing_sub_one_live_idx` beneath.
 *  · NOT `stepUp`. The sensitive act is entering a card, and that happens on Stripe's hosted
 *    page with its own proof of presence. A stolen session can at worst pay FOR the victim.
 *
 * **`POST /billing/portal` — `stepUp: true`.** The Billing Portal exposes the payment method,
 * the full invoice history and destructive plan changes including cancellation. That is the
 * same class of surface as a mailbox-credential write, which this codebase already gates on a
 * recent second factor, so it gets the same gate: a stolen session must not be enough to cancel
 * a subscription or read card details. The open `portalCustomerRef` 404s BEFORE the network —
 * the plane is never asked about a customer that does not exist.
 *
 * **`GET /billing/subscription` — default protected.** Read-only status for the webapp and
 * the plan picker. Served ENTIRELY open — zero plane calls, works with the plane down.
 *
 * **`POST /billing/webhook` — `{ public: true, raw: true }`, and BOTH are load-bearing:**
 *  · `public` because Stripe carries no session — and `RAW_PIPELINE` still runs `withSession`,
 *    which would 401 a protected route before the handler ever saw the signature.
 *  · `raw` for two independent reasons. The handler must own the EXACT request bytes
 *    (`await req.arrayBuffer()`): the plane HMACs precisely what it is handed, and `readBody`
 *    parses JSON whose re-serialization is not byte-stable — key order, number formatting and
 *    non-ASCII escaping all differ, so every signature would fail. And the response semantics
 *    must be STRIPE's (200 = applied, 400 = do not retry, 5xx = retry), not the `{ error }`
 *    envelope's.
 *  · THE RELAY'S VERDICT MAPPING IS THE MONEY-CRITICAL LINE. Only the plane's
 *    own explicit refusal — a bad signature, a bad envelope — may become a 400, because 400
 *    tells Stripe to drop the delivery forever. A plane that is unreachable, times out, throws,
 *    or answers garbage is a 503, so Stripe retries; inverting that mapping turns a plane
 *    outage into permanent, silent money loss, one webhook at a time. The mapping is pinned
 *    both ways by `test/billing-plane-relay.test.ts`, including the zero-DB-write half of the
 *    extraction's acceptance ("bad signature ⇒ 400 and no write") which now spans the two programs.
 *  · Consequences handled here rather than inherited: the raw pipeline has NO
 *    `withErrorEnvelope`, so an uncaught throw becomes the host's generic 500 with nothing
 *    recorded — the entitlements service catches everything, the relay's try/catch owns the plane hop, and
 *    this handler adds the unconfigured-503 check that the enveloped routes get from
 *    `entitlements()`. `withRequestGuard` still runs and passes (Stripe sends
 *    `application/json`; the `;charset` suffix is split off). `withCsrf` cannot fire (no cookie
 *    session on a server-to-server POST). `withIdempotency` is absent from the raw pipeline and
 *    would be wrong anyway: the dedup here is `billing_events`, keyed by Stripe's event id, not
 *    by a client header.
 */
export const billingRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/billing/checkout",
    // `paid`, which is what refuses an unverified address here. A live Stripe subscription
    // against an unproven address is a recurring charge whose receipts, dunning and cancellation
    // notices go somewhere nobody has shown belongs to the payer. It is NOT `stepUp` (see the
    // header: the card is entered on Stripe's page, which has its own proof of presence), so the
    // class is the only privilege check in front of the money.
    cost: "paid",
    handler: async (req, deps) => {
      const body = await readBody<{ plan?: string; interval?: string }>(req);
      // Preflight OPEN (the 409, the trial eligibility, the per-IP trial throttle, the customer
      // ref — every one a DB fact), THEN the plane. The order is load-bearing: a refusal after
      // Checkout has created a session is a subscription somebody may have to cancel.
      // `interval` (month|year, monthly the default) picks the annual price; validated in the
      // preflight beside the plan for the same one-authority reason.
      const preflight = await entitlements(deps)
        .checkoutPreflight(serviceContext(deps, req), body.plan ?? "", body.interval);
      const out = await billingPlane(deps).checkout(preflight);
      return jsonResponse(out);
    },
  },
  {
    method: "POST",
    pattern: "/billing/addons",
    // `paid` + `stepUp`, the portal's exact posture: this is a money MUTATION against the card
    // on file (an increase invoices immediately), so a recent second factor is owed — unlike
    // checkout, where Stripe's own page collects the card and is its own proof of presence.
    cost: "paid",
    options: { stepUp: true },
    handler: async (req, deps) => {
      const body = await readBody<{ addon?: string; quantity?: unknown }>(req);
      // Preflight OPEN (kind + quantity bounds, the live-and-active requirement, the
      // subscription ref), THEN the plane — the checkout ordering, for the checkout reason.
      const preflight = await entitlements(deps)
        .addonPreflight(serviceContext(deps, req), body.addon ?? "", body.quantity);
      await billingPlane(deps).setAddonQuantity(preflight);
      // DECLARATIVE ack only. The new limits arrive through the webhook mirror, not this
      // response: inventing them here would be a second copy of the entitlement computation
      // that is right until the webhook is delayed, then wrong in the customer's favour.
      return jsonResponse({ ok: true, addon: preflight.addon, quantity: preflight.quantity });
    },
  },
  {
    method: "POST",
    pattern: "/billing/portal",
    // `paid`, and this route was NOT gated on a verified address at first: it carried
    // `stepUp` alone. It is a live Stripe API call (through the plane), so an unverified
    // account could reach a paid provider through it. A recent second factor is a different
    // question from a proven address and neither substitutes for the other.
    cost: "paid",
    options: { stepUp: true },
    handler: async (req, deps) => {
      // 404-before-network preserved: the customer ref is an open read, and an account that
      // never checked out is refused before the plane is dialled.
      const ref = await entitlements(deps).portalCustomerRef(serviceContext(deps, req));
      const out = await billingPlane(deps).portal(ref);
      return jsonResponse(out);
    },
  },
  {
    method: "GET",
    pattern: "/billing/subscription",
    cost: "read",
    handler: async (req, deps) => {
      const out = await entitlements(deps).subscriptionStatus(serviceContext(deps, req));
      return jsonResponse(out);
    },
  },
  {
    method: "POST",
    pattern: "/billing/webhook",
    cost: "unauthenticated",
    options: { public: true, raw: true },
    handler: async (req, deps) => {
      // The unconfigured check is INLINE rather than through `entitlements(deps)`, because a raw
      // route has no error envelope to turn a thrown ServiceError into a status. Both members
      // are one capability; a host that armed only one is misarmed and answers the same 503.
      const plane = billingPlaneOrNull(deps);
      const svc = entitlementsOrNull(deps);
      if (!plane || !svc) {
        return jsonResponse({ error: "billing_unconfigured" }, { status: 503 });
      }
      // `req.arrayBuffer()` on the raw pipeline: nothing above has consumed or re-encoded the
      // body, and the serverless host buffered the wire bytes verbatim
      // (`apps/api-vercel/src/prefix.ts` `normalizeRequest`). The bytes travel to the plane
      // UNTOUCHED — the plane HMACs exactly these octets, and any re-encoding here would fail
      // every signature as a 400, which Stripe reads as "never retry".
      const raw = new Uint8Array(await req.arrayBuffer());
      const signature = req.headers.get("stripe-signature");

      let verdict;
      try {
        verdict = await plane.verifyWebhook(raw, signature);
      } catch {
        // A DEAD PLANE MUST NEVER READ AS 400. A rejection here is transport —
        // unreachable, timeout, 5xx, a throw — and says nothing about the signature, so the
        // answer is 503: Stripe retries with backoff for ~3 days, which is the recovery window
        // for any plane outage. Mapping this arm to 400 would drop every delivery of the outage
        // forever, invisibly.
        return jsonResponse({ error: "billing_plane_unavailable" }, { status: 503 });
      }
      if (!verdict.ok) {
        // The plane's OWN verdict — bad signature or bad envelope — and only that. Nothing has
        // been written: the entitlements service was never called, which is the zero-write
        // acceptance.
        return jsonResponse(verdict.body, { status: 400 });
      }
      // Today's claim+apply transaction, open-side, over the verified DTO.
      const result = await svc.applyEvent(deps.db, verdict.event);
      return jsonResponse(result.body, { status: result.status });
    },
  },
];
