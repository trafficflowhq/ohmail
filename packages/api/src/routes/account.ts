import { deleteAccount } from "@trafficflow/services";
import type { ReleaseOutcome } from "@trafficflow/db";
import { ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { clearSessionCookies } from "../cookies.js";
import { accessFor, cookieSurface, entitlementsPort, json } from "./shared.js";
import type { Route } from "../router.js";

/**
 * `DELETE /account` — Art. 17 erasure, self-serve; the screen is `AccountSection.tsx`. `stepUp:
 * true`: the most destructive call in the API. Not `idempotent`: the second call deletes nothing.
 * The account row survives as a random uuid with a blank name — the `credit_ledger` FK forbids
 * deletion and financial records carry a retention obligation (Art. 17(3)(b)); see
 * `account-deletion-service.ts`. The customer's mail is untouched because it was never ours.
 * Cancel the subscription first, outside the erasure transaction; a cancel failure does not block
 * erasure and is reported (`subscription: "cancel_failed"`). The response clears the cookies, as
 * `POST /auth/logout` does.
 */
export const accountRoutes: Route[] = [
  {
    method: "DELETE",
    pattern: "/account",
    relay: true,
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
      /**
       * STOP THE MONEY — through the port, which is bounded, never throws, and answers this
       * response's own three words one-to-one, so nothing translates between them.
       *
       * The try/catch stays for the reason it was written: the thing it guards is a RIGHT, and a
       * bug in the money path may not become a 500 in front of an Art. 17 erasure. An unmetered
       * host answers `none`, which is the truth there.
       */
      let subscription: ReleaseOutcome = "none";
      // `null` is a host that meters nothing, whose honest answer is `"none"` — there is no
      // subscription to stop. It is not the same as a port that could not be reached, which
      // answers `"cancel_failed"` below.
      const port = entitlementsPort(deps);
      if (port) {
        try {
          subscription = await port.releaseAccount(ctx.accountId);
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
   * `GET /account/access` — what the entitlements program says this account may do. The one
   * client-facing read of the port's verdict: the mailbox pane refuses a connect it knows will be
   * refused before a step-up ceremony. It answers limits, never a refusal — a refused account
   * cannot reach a `read` route at all (`withSpendGate` answers 402 first), so `ok: false` is
   * unreachable by construction. `metered: false` is a host with no program. `canAddMailbox` is
   * not derivable from the numbers: an account may keep the mailboxes it has and be forbidden
   * another, and collapsing them is how a refusal offers a plan the customer already holds.
   */
  {
    method: "GET",
    pattern: "/account/access",
    relay: true,
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
   * `POST /account/manage-link` — the one door to the subscription page; an account with no
   * subscription gets a plan choice there. `paid`: the port's answer is a network hop to a third
   * party, and a verified address is the right floor for a door minting a link to a page holding
   * payment details. Also the one `paid` route a refused account may reach
   * (`ACCESS_REFUSED_MAY_REACH_ROUTES`): the way back to paying cannot be behind the lock. The
   * account comes from the session; there is no body. 404 has two causes — no such program here
   * (the ordinary self-host answer), or a program that does not know an account we just
   * authenticated; the client's contract-fault report names the second.
   */
  {
    method: "POST",
    pattern: "/account/manage-link",
    relay: true,
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
