import { deleteAccount, type ErasureBillingOutcome } from "@trafficflow/services";
import { ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { clearSessionCookies } from "../cookies.js";
import { accessFor, cookieSurface, entitlementsPort, json } from "./shared.js";
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
      let subscription: ErasureBillingOutcome = "none";
      /**
       * STOP THE MONEY. Two arms, and the ORDER is deliberate: while this host still composes the
       * in-tree billing service, that arm answers, because it is the one holding the subscription.
       * The port arm is what a host answers with once the state has moved out — `releaseAccount`
       * is bounded, never throws, and answers this response's own three words.
       *
       * Preferring the port while the local service is armed would report `none` for every erasure
       * on a host whose port composes no `releaseAccount` — a customer deleted and still charged,
       * which is the exact defect this ordering was written for.
       *
       * The try/catch stays for the reason it was written: the thing it guards is a RIGHT, and a
       * bug in the money path may not become a 500 in front of an Art. 17 erasure.
       */
      const plane = deps.services?.billingPlane;
      const billing = deps.services?.entitlements;
      const port = plane && billing ? null : entitlementsPort(deps);
      if (port) {
        try {
          // ONE-TO-ONE: the port answers this response's own three words, so nothing translates
          // between them and none of them can be reported as another.
          subscription = await port.releaseAccount(ctx.accountId);
        } catch {
          subscription = "cancel_failed";
        }
      }
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
  /**
   * `GET /account/access` — what the entitlements program says this account may do.
   *
   * The one CLIENT-FACING read of the port's verdict, and the reason it exists: the mailbox pane
   * refuses a connect it knows will be refused BEFORE walking somebody through a step-up
   * ceremony, and `accessFor` is server-side only, so a browser had no way to ask.
   *
   * It answers LIMITS, never a refusal. A refused account cannot reach a `read` route at all —
   * `withSpendGate` answers 402 first and the client swaps to the lock screen — so `ok: false`
   * is unreachable from this door by construction, and the shape says so: what comes back is
   * "may you add another, and how many does the plan hold". `metered: false` is a host with no
   * entitlements program, where the answer to both is "no limit".
   *
   * `canAddMailbox` is NOT derivable from the numbers and is carried separately for the reason
   * {@link AccessLimits} gives: an account may keep the mailboxes it has and be forbidden
   * another. Collapsing them is how a refusal ends up offering a plan the customer already holds.
   */
  {
    method: "GET",
    pattern: "/account/access",
    cost: "read",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const verdict = await accessFor(deps, ctx.accountId);
      // `null` = this host declared no program. Not an error, and not a refusal.
      if (verdict === null) return json({ metered: false }, 200);
      if (!verdict.ok) {
        // Unreachable through this route's own pipeline (see above). Answered rather than
        // thrown so that a caller which somehow arrives here reads "no, and nowhere to go"
        // instead of a 500 — the arm is watched by driving the rule through the middleware.
        return json({ metered: true, canAddMailbox: false, mailboxes: 0 }, 200);
      }
      return json({
        metered: true,
        canAddMailbox: verdict.limits.canAddMailbox,
        mailboxes: verdict.limits.mailboxes,
      }, 200);
    },
  },
  /**
   * `POST /account/manage-link` — the one door to the managed service's own page.
   *
   * Not only "manage": an account with no subscription gets a plan CHOICE there, so this is the
   * route to a FIRST subscription as well as to an existing one. Both callers read it — the
   * settings row and the onboarding step — and both render nothing when no URL comes back.
   *
   * `paid`, because the port's answer is a network hop to a third party on this account's behalf;
   * and because a verified address is the right floor for a door that mints a link to a page
   * holding payment details. It is also the ONE `paid` route a REFUSED account may still reach
   * (`ACCESS_REFUSED_MAY_REACH_ROUTES`): the way back to paying cannot be behind the lock.
   *
   * The account comes from the SESSION, never the body. There is no body.
   *
   * 404 has TWO causes and they are not equally innocent: this host operates no such program (the
   * ordinary state, and what a self-host answers for ever), or a program that does not know an
   * account we have just authenticated — which is a real inconsistency rather than an absence. The
   * status cannot tell them apart; the client's contract-fault report is where the second one is
   * named, because only that path meets a body.
   */
  {
    method: "POST",
    pattern: "/account/manage-link",
    cost: "paid",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const port = entitlementsPort(deps);
      const link = port ? await port.manageLink(ctx.accountId) : null;
      if (!link) {
        throw new ServiceError(
          "no_manage_surface", 404,
          "This deployment has no subscription management page.",
        );
      }
      return json(link, 200);
    },
  },
];
