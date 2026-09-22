import { and, desc, eq, gt, sql } from "drizzle-orm";
import { deleteAccount, withAccountTx } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { messages } from "@trafficflow/db";
import type { ReleaseOutcome } from "@trafficflow/db";
/* Hosted-only, like `internal.ts`'s cloud imports: `accountRoutes` is mounted by `routes/index.ts`
   and deliberately NOT by the local door ("deleting the data directory IS the erasure"), so the
   cloud table never enters a standalone bundle. */
import { accountLifecycleNotices } from "@trafficflow/db/cloud";
import { ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { clearSessionCookies } from "../cookies.js";
import { accessFor, cookieSurface, entitlementsPort, json } from "./shared.js";
import type { ApiDeps } from "../deps.js";
import type { Route } from "../router.js";

/**
 * THE REOPENING BANNER'S ONE FACT (cloud 0040) — an idempotent INSERT on a GET, deliberate and
 * named here so nobody "fixes" it: the first open read after a closure claims the `reopened`
 * notice (anchor = the newest `closed` notice's own anchor, ON CONFLICT DO NOTHING) and answers
 * how much mail arrived while the account was closed. Exactly one read carries it — a replay
 * conflicts on the PK and answers nothing, so dismissal needs no server state. Best-effort by
 * contract: the wall's read must never fail over its banner.
 */
async function reopenedCatchUp(
  deps: ApiDeps, ctx: ServiceContext,
): Promise<{ since: string; count: number } | null> {
  const accountId = ctx.accountId;
  try {
    const [closed] = await deps.db.select({ anchor: accountLifecycleNotices.anchor })
      .from(accountLifecycleNotices)
      .where(and(
        eq(accountLifecycleNotices.accountId, accountId),
        eq(accountLifecycleNotices.kind, "closed"),
      ))
      .orderBy(desc(accountLifecycleNotices.anchor))
      .limit(1);
    if (!closed) return null;
    // FENCED, like every session-holding writer of an account-owned row: a GET racing the
    // caller's own erasure must not plant a notice after the Art. 17 sweep commits.
    const inserted = await withAccountTx(ctx, async (tx) =>
      tx.insert(accountLifecycleNotices)
        .values({ accountId, kind: "reopened", anchor: closed.anchor })
        .onConflictDoNothing()
        .returning());
    if (inserted.length === 0) return null;
    const [row] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(messages)
      .where(and(eq(messages.accountId, accountId), gt(messages.createdAt, closed.anchor)));
    return { since: closed.anchor.toISOString(), count: row?.n ?? 0 };
  } catch {
    // A missing table (an API ahead of cloud 0040), a fenced refusal or any read fault costs
    // the banner, never the wall's read.
    return null;
  }
}

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
          // Deliberate: the plane failing to cancel must not block erasure — the caller is told.
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
          // The signup funnel, reported separately for the same reason: these rows are
          // PSEUDONYMISED, not deleted. The operator's count of who was waiting, invited and
          // registered is a fact about the service; the address on the row is not, and it goes.
          redactedTables: result.redacted,
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
   * `GET /account/access` — what the entitlements program says this account may do, and since the
   * wall, THE WALL READING ITSELF: it sits on `ACCESS_REFUSED_MAY_REACH_ROUTES`, so a refused
   * account reaches it and the `ok: false` arm answers the lifecycle, the manage link and the
   * export path the wall renders. The ONE explicit `fresh` read — a wall that re-reads on focus
   * must see a reopening within seconds, not a cached refusal for a minute; every OTHER door
   * keeps the 60 s cache. `metered: false` is a host with no program. `canAddMailbox` is not
   * derivable from the numbers: an account may keep the mailboxes it has and be forbidden another.
   */
  {
    method: "GET",
    pattern: "/account/access",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const verdict = await accessFor(deps, ctx.accountId, { fresh: true });
      // `null` = this host declared no program. Not an error, and not a refusal.
      if (verdict === null) return json({ metered: false }, 200);
      if (!verdict.ok) {
        return json({
          metered: true, canAddMailbox: false, mailboxes: 0, aiEnabled: false,
          ...(verdict.lifecycle ? { lifecycle: verdict.lifecycle } : {}),
          ...(verdict.manageUrl ? { manageUrl: verdict.manageUrl } : {}),
          exportPath: "/account/export",
        }, 200);
      }
      // The catch-up banner, only where a lifecycle exists to have reopened from: an OPEN
      // verdict whose account has an unanswered `closed` notice claims `reopened` and says how
      // much arrived meanwhile. NO auto re-claim rides on this (DUAL-MODE §4): un-parking
      // resumes SYNC as reader, and organizing resumes per mailbox through the person's own
      // `POST /mailboxes/:id/organize` press.
      const caughtUp = verdict.lifecycle ? await reopenedCatchUp(deps, ctx) : null;
      return json({
        metered: true,
        canAddMailbox: verdict.limits.canAddMailbox,
        mailboxes: verdict.limits.mailboxes,
        // `aiEnabled` IS THE VERDICT'S OWN FIELD and was being read and dropped. It is what a
        // surface holding a stale "no AI credits remain" asks about: a refusal the person was
        // shown yesterday must not still be on their screen once this answers true. Not derivable
        // from the two above — an account may hold every mailbox it is entitled to and have AI
        // off, or the other way round.
        aiEnabled: verdict.limits.aiEnabled,
        ...(verdict.lifecycle ? { lifecycle: verdict.lifecycle } : {}),
        exportPath: "/account/export",
        ...(caughtUp ? { caughtUp } : {}),
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
