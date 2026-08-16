import { deleteAccount, type ErasureBillingOutcome } from "@trafficflow/services";
import { serviceContext } from "../context.js";
import { clearSessionCookies } from "../cookies.js";
import { cookieSurface, json } from "./shared.js";
import type { Route } from "../router.js";

/**
 * `DELETE /account` — Art. 17 erasure, self-serve.
 *
 * The landing page says "Delete your account anytime". This route is the half of that
 * sentence that is code; the other half is the SCREEN, which for a while did not exist
 * anywhere in the product — the endpoint was reachable only by an operator with curl. It is
 * now `apps/webapp/app/(product)/mailbox/AccountSection.tsx`, in Settings.
 *
 * ## Why the options are what they are
 *
 * **`stepUp: true`.** This is the most destructive call in the API — every
 * message, every rule, every credential, unrecoverable. A stolen session must not
 * be enough. It is the same gate mailbox-credential writes and the Billing Portal
 * already carry, and this is strictly more serious than either.
 *
 * **NOT `idempotent`.** `deleteAccount` is idempotent *by construction* — the
 * second call deletes nothing and reports zero — so the `Idempotency-Key`
 * machinery would add a replay record for an operation that cannot be replayed
 * harmfully. Nothing is minted, so there is no response worth storing.
 *
 * The account itself is NOT deleted, and the response says so rather than
 * pretending otherwise: the `credit_ledger` FK forbids it and financial records
 * carry a statutory retention obligation GDPR Art. 17(3)(b) preserves. What
 * survives is a random uuid with a blank name — a billing subject, not a person.
 * See `account-deletion-service.ts`.
 *
 * The customer's MAIL is untouched, because it was never ours: it is in the
 * `ohmail/…` folders on their own IMAP server and stays exactly as organised as
 * it was. That is the whole "leave anytime" promise, discharged by doing nothing.
 *
 * ## THE ORDER: stop the money, THEN erase — never the other way round
 *
 * Erasure keeps the billing rows and touched nothing at Stripe, so before
 * `cancelForErasure` existed a customer who deleted their account kept being charged, and
 * had no session left to cancel with. That is not a retention obligation, it is a charge
 * nobody can stop.
 *
 * Three properties, each a decision rather than an accident of sequencing:
 *
 *  1. **Cancel FIRST, outside the erasure transaction.** No local transaction can contain a
 *     remote object — `createCheckout` is written under the same law. A rolled-back erasure
 *     would not un-cancel a subscription, and a Stripe round trip inside the transaction
 *     would hold row locks open across a network call.
 *  2. **A cancel failure does NOT block erasure.** Art. 17 is a right, not a favour, and it
 *     may not be withheld because a payment processor is unreachable. The outcome is
 *     REPORTED (`subscription: "cancel_failed"`) so the screen can say the one thing the
 *     customer can no longer find out for themselves.
 *  3. **The wreckage is queryable, not merely logged.** A LIVE `billing_subscriptions` row
 *     whose account has zero `users` rows is the operator's sweep, and `billing_customers`
 *     still holds the Stripe customer id.
 *
 * A host with no billing configuration (`deps.services.billingPlane`/`entitlements` absent —
 * a pre-launch deployment, and most of the suite) has no subscription to cancel and reports
 * `none`.
 *
 * ## The cookies go with the session
 *
 * `deleteAccount` deletes the `sessions` row and `resolveSession` INNER JOINs `users`, so the
 * caller's credential is dead the moment this returns. The BROWSER does not know that: it
 * would keep presenting an inert `tf_session`, and that cookie costs the edge gate an
 * invocation and a cross-host fetch on every visit to `/` until it expires. `HttpOnly` means
 * no client can clear it, so the response does — exactly as `POST /auth/logout` does.
 */
export const accountRoutes: Route[] = [
  {
    method: "DELETE",
    pattern: "/account",
    // `ceremony`, deliberately NOT `work`, and this is the classification most likely to
    // be "corrected" by somebody reading only the verb. Erasure is an Art. 17 RIGHT and may not
    // be withheld because an address is unproven — the person who mistyped their own address at
    // signup holds a session, will never receive the verification mail, and is exactly the
    // caller who most needs this to work. `ceremony` is the identity lifecycle including its
    // exit; a gate on the way out is a trap, not a control.
    cost: "ceremony",
    options: { stepUp: true },
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const plane = deps.services?.billingPlane;
      const billing = deps.services?.entitlements;
      let subscription: ErasureBillingOutcome = "none";
      if (plane && billing) {
        // `cancelForErasure` is documented never to throw — and to answer inside a
        // hard bound even against a HANGING plane (the cancel is a network hop inside an
        // Art. 17 request now; see `ERASURE_CANCEL_TIMEOUT_MS`). The try/catch is here anyway,
        // because the thing it guards is a RIGHT. A bug or an unexpected rejection inside the
        // money path would otherwise become a 500 in front of `deleteAccount`, i.e. an Art. 17
        // erasure refused by a payment integration, which is the one outcome this ordering
        // exists to prevent. Belt and brace, and the brace is the cheap one.
        try {
          subscription = await billing.cancelForErasure(ctx, plane);
        } catch {
          subscription = "cancel_failed";
        }
      }

      const result = await deleteAccount(ctx);
      return json(
        {
          erased: true,
          usersErased: result.usersErased,
          tables: result.deleted,
          // Reported separately because it is not a delete. Staged attachment tickets are the
          // only rows erasure touches whose bytes live outside the database, and the row is the
          // key the sweep removes them BY — so erasure brings their expiry forward and the next
          // maintenance pass takes row and object together. See `account-deletion-service.ts`.
          stagingTicketsExpired: result.stagingTicketsExpired,
          // Said plainly rather than buried: the operator's own audit trail and the
          // customer's confirmation mail both read from this.
          retained: "billing records only, under a pseudonymous account id",
          subscription,
        },
        200,
        cookieSurface(deps) ? clearSessionCookies() : [],
      );
    },
  },
];
