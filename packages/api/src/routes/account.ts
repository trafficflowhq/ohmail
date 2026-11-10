import { deleteAccount, erasureOutcome, throttleKeysFor } from "@trafficflow/services";
import { planHintOf, storageEmptyingNow, storageFactsOf, type ReleaseOutcome, type Tx } from "@trafficflow/db";
/* Hosted-only, like `internal.ts`'s cloud imports: `accountRoutes` is mounted by `routes/index.ts`
   and deliberately NOT by the local door ("deleting the data directory IS the erasure"), so the
   cloud table the reopening reads never enters a standalone bundle. */
import { reopenedCatchUp, resumeAfterReopen } from "../account-reopen.js";
import {
  heldStorageLimitOf, isStorageCardLevel, recordStorageDismissal, setStorageMail, storageDismissalOf,
  storageReadingOf,
} from "@trafficflow/db/cloud";
import { ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { clearSessionCookies } from "../cookies.js";
import { isDbBusy } from "../middleware.js";
import { sessionEnded } from "../session-end.js";
import { storageBlockOf } from "../storage-block.js";
import { accessFor, cookieSurface, entitlementsPort, json, readBody } from "./shared.js";
import type { ApiDeps } from "../deps.js";
import type { Route } from "../router.js";

/**
 * THE ONE FIELD `POST /account/checkout/confirm` READS: the session id the program's return URL
 * carried, relayed verbatim. Opaque here — its shape is the program's business — so the bound is a
 * token's: 1 to 255 letters, digits, `_` or `-`, refused 400 before anything is dialled.
 */
export const RETURN_SESSION_ID_MAX_CHARS = 255;
const RETURN_SESSION_ID = /^[A-Za-z0-9_-]{1,255}$/;

/** The database's answers that pass on their own: a deadlock, a lock wait or a statement cut short. */
const TRANSIENT_DB_CODES: ReadonlySet<string> = new Set(["40P01", "55P03", "57014"]);

/**
 * THE ERASURE FAILED AFTER THE MONEY WAS STOPPED. The answer carries what the release did, so the
 * page can say the subscription is already cancelled, and it is thrown, never `sessionEnded`, so no
 * cookie is cleared and the session stays for the retry. 503 `erasure_unconfirmed` when no read
 * could say whether it committed; else 503 `erasure_contended` (retryable) for a cause that
 * passes on its own, 500 `erasure_failed` for anything else.
 */
function erasureFailed(err: unknown, subscription: ReleaseOutcome, outcome: "not_erased" | "unknown"): ServiceError {
  if (outcome === "unknown") {
    return new ServiceError("erasure_unconfirmed", 503,
      "the account's deletion could not be confirmed; reload to see whether it went through", { subscription });
  }
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  if (isDbBusy(err) || (typeof code === "string" && TRANSIENT_DB_CODES.has(code))) {
    return new ServiceError("erasure_contended", 503,
      "the account could not be deleted right now; nothing else was removed", { subscription }, true);
  }
  return new ServiceError("erasure_failed", 500,
    "the account could not be deleted; nothing else was removed", { subscription });
}

/** The receipt's counts, from the erasure's own result: what it removed, expired and kept, per table. */
function erasureCounts(result: Awaited<ReturnType<typeof deleteAccount>>) {
  return {
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
    // Refunds still owed, kept pseudonymised until they are paid; 0 on an unmetered host.
    retainedPending: result.retainedPending,
  };
}

/** What an erasure leaves on a host with no billing program: the pseudonymous account row and the token hashes. */
const RETAINED_UNMETERED =
  "the account row only, with a random id and no name, and hashes of its sign-in tokens for up to 400 days after they expire";
/** What it leaves where there is one: the billing records, and a refund still owed until it is paid. */
const RETAINED_METERED = "billing records and any refund still owed to you, under a pseudonymous account id";

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

      // A refund still owed is kept for the drain only where one runs, which is a metered host.
      let result: Awaited<ReturnType<typeof deleteAccount>> | null = null;
      try {
        result = await deleteAccount(ctx, {
          throttleKeys: throttleKeysFor(deps.keyProvider), drainsRefunds: port !== null,
        });
      } catch (err) {
        // "Not deleted" only once a read made after the failure finds no stamp: an answer lost after
        // the commit went out is a failure here and not a fact. A transaction the pool never began
        // is not asked. A committed erasure answers its receipt, without the counts it took along.
        const outcome = isDbBusy(err) ? "not_erased" : await erasureOutcome(ctx);
        if (outcome !== "erased") throw erasureFailed(err, subscription, outcome);
      }
      return sessionEnded(json(
        {
          erased: true,
          ...(result === null ? {} : erasureCounts(result)),
          // Said plainly rather than buried: the operator's own audit trail and the
          // customer's confirmation mail both read from this. A host with no billing program
          // keeps no billing records, so it names what it does keep.
          retained: port ? RETAINED_METERED : RETAINED_UNMETERED,
          subscription,
        },
        200,
        cookieSurface(deps) ? clearSessionCookies() : [],
      ));
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
   * `access` is the gate's own `verdict.ok` in a word — the one field a wall lifts on.
   */
  {
    method: "GET",
    pattern: "/account/access",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      // THE STORAGE READING FIRST, where a program meters, so the one read of the program carries
      // what the mail needs and its answer the offer sized to it. Five indexed reads and no count
      // of the mail tables (the worker's snapshot is where those are counted). A failed reading
      // asks without the need and leaves the storage block out; it never fails the wall's read.
      const reading = entitlementsPort(deps) !== null
        ? await storageReadingOf(ctx.db as unknown as Tx, ctx.accountId).catch(() => null)
        : null;
      // A fault in this read (it always dials) moves the fault count: such an allow reopens nothing.
      const before = entitlementsPort(deps)?.accessFaults?.();
      const verdict = await accessFor(deps, ctx.accountId,
        reading !== null ? { fresh: true, storageNeed: reading.need } : { fresh: true });
      const answered = before === undefined || entitlementsPort(deps)?.accessFaults?.() === before;
      // `null` = this host declared no program. Not an error, and not a refusal.
      if (verdict === null) return json({ metered: false }, 200);
      if (!verdict.ok) {
        return json({
          metered: true, access: "refused", canAddMailbox: false, mailboxes: 0, aiEnabled: false,
          ...(verdict.lifecycle ? { lifecycle: verdict.lifecycle } : {}),
          ...(verdict.manageUrl ? { manageUrl: verdict.manageUrl } : {}),
          exportPath: "/account/export",
        }, 200);
      }
      // The catch-up banner, only where a lifecycle exists to have reopened from. Then the
      // reopening itself: the `account_closed` block goes, and every mailbox the WALL released is
      // asked back as a `join` — the gate decides, a live claim elsewhere keeps its mailbox, and a
      // mailbox the person released is never touched. In THIS order, and not at all when the
      // catch-up faulted: the resume clears the facts it is anchored on, and the worker's pass
      // records them before it spends them. Neither on a read the program did not answer.
      const caughtUp = answered && verdict.lifecycle ? await reopenedCatchUp(deps, ctx) : null;
      if (answered && caughtUp !== "fault") await resumeAfterReopen(deps, ctx);
      // THE PERSON'S OWN STORAGE, where a cap is a number: the reading above, and the limit as every
      // cap reader applies it (a lower one held 14 days, cloud 0055). A failed read leaves the block
      // out (nothing drawn); it never fails the wall's read.
      const storage = typeof verdict.limits.storageBytes === "number" && reading !== null
        ? await heldStorageLimitOf(ctx.db as unknown as Tx, ctx.accountId, verdict, deps.now())
          .then((limit) => (limit === null ? null : storageBlockOf(reading, verdict, limit, deps.now())))
          .catch(() => null)
        : null;
      return json({
        metered: true,
        access: "open",
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
        ...(caughtUp !== null && caughtUp !== "fault" ? { caughtUp } : {}),
        ...(storage !== null ? { storage } : {}),
      }, 200);
    },
  },
  /**
   * `PATCH /account/storage` — the person's storage choices: `{dismiss: "near"|"full"|"drop"}` hides
   * that card at the facts it was dismissed at (`storage-card.ts` says until when), `{mail: false}`
   * turns the storage mails off and `{mail: true}` on again. Exactly one of the two. 404 on a host
   * with no storage limit. A dismissal reads the cap through the cached verdict, as every cap reader.
   */
  {
    method: "PATCH",
    pattern: "/account/storage",
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const body = await readBody<Record<string, unknown> | null>(req);
      const keys = body !== null && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
      const dismiss = body?.dismiss;
      const mail = body?.mail;
      const valid = keys.length === 1
        && ((keys[0] === "dismiss" && isStorageCardLevel(dismiss)) || (keys[0] === "mail" && typeof mail === "boolean"));
      if (!valid) {
        throw new ServiceError("validation_failed", 400, "name one of dismiss (near, full or drop) or mail (true or false)");
      }
      const noCap = (): ServiceError => new ServiceError("no_storage_limit", 404, "This deployment keeps no storage limit.");
      if (entitlementsPort(deps) === null) throw noCap();
      const db = ctx.db as unknown as Tx;
      const now = deps.now();
      if (typeof mail === "boolean") {
        await setStorageMail(db, ctx.accountId, mail, now);
        return json({ mail }, 200);
      }
      const verdict = await accessFor(deps, ctx.accountId);
      if (!verdict?.ok || typeof verdict.limits.storageBytes !== "number") throw noCap();
      const limit = await heldStorageLimitOf(db, ctx.accountId, verdict, now);
      if (limit === null) throw noCap();
      const counter = await storageFactsOf(db, ctx.accountId);
      const level = dismiss as Parameters<typeof storageDismissalOf>[0];
      await recordStorageDismissal(db, ctx.accountId, storageDismissalOf(level, {
        usedBytes: counter.usedBytes, capBytes: limit.capBytes, planBytes: limit.planBytes, dropsAt: limit.dropsAt,
        emptiedForSpace: counter.emptiedForSpace, emptyingNow: storageEmptyingNow(counter, limit.capBytes, now),
      }, now));
      return json({ dismissed: level }, 200);
    },
  },
  /**
   * `POST /account/manage-link` — the one door to the subscription page; an account with no
   * subscription gets a plan choice there. `paid`: a network hop to a third party, and a verified
   * address is the floor for a link to a page holding payment details. The one `paid` route a
   * refused account may reach (`ACCESS_REFUSED_MAY_REACH_ROUTES`): the way back to paying is not
   * behind the lock. The account is the session's; the optional body names the page's language,
   * one of two words, and the plan and interval a signup carried from the site's tier buttons, each
   * from its closed set (`planHintOf`) — a hint that picks the page's preselection and never a
   * price. Anything else is dropped. 404 has two causes — no such program here, or a program that
   * does not know an account we just authenticated.
   */
  {
    method: "POST",
    pattern: "/account/manage-link",
    relay: true,
    cost: "paid",
    replay: "ephemeral",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      // A body that is JSON but not an object (`null`, a string) names no language and no hint either.
      const body = await readBody<{ lang?: unknown; plan?: unknown; interval?: unknown } | null>(req);
      const lang = body?.lang;
      const hint = planHintOf(body?.plan, body?.interval);
      const port = entitlementsPort(deps);
      const link = port
        ? await port.manageLink(
          ctx.accountId, lang === "de" || lang === "en" ? lang : undefined,
          hint.plan || hint.interval ? hint : undefined,
        )
        : null;
      if (!link) {
        throw new ServiceError(
          "no_manage_surface", 404,
          "This deployment has no subscription management page.",
        );
      }
      return json(link, 200);
    },
  },
  /**
   * `POST /account/manage-link/change` — the subscription page that may change the plan and the
   * storage add-on, where Change plan and Add storage lead. `paid` on `manage-link`'s terms, and
   * `stepUp`: that page charges the card on file, so a recent second factor is the floor, and only
   * this door asks the program for an elevated page. The mail's need rides along so the page can size
   * its offer; a failed reading sends none. Not open while refused: a closed account's way back is
   * `manage-link`. The body names the page's language and nothing else.
   */
  {
    method: "POST",
    pattern: "/account/manage-link/change",
    relay: true,
    cost: "paid",
    replay: "ephemeral",
    options: { stepUp: true },
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const lang = (await readBody<{ lang?: unknown } | null>(req))?.lang;
      const port = entitlementsPort(deps);
      if (!port) {
        throw new ServiceError("no_manage_surface", 404, "This deployment has no subscription management page.");
      }
      const reading = await storageReadingOf(ctx.db as unknown as Tx, ctx.accountId).catch(() => null);
      const link = await port.manageLink(
        ctx.accountId, lang === "de" || lang === "en" ? lang : undefined, undefined,
        { elevated: true, ...(reading !== null ? { storageNeed: reading.need } : {}) },
      );
      if (!link) {
        throw new ServiceError("no_manage_surface", 404, "This deployment has no subscription management page.");
      }
      return json(link, 200);
    },
  },
  /**
   * `POST /account/checkout/confirm` — the person is back from a Checkout: ask the program to apply
   * it now instead of waiting for its webhook. `paid` on `manage-link`'s terms (a hop to a third
   * party through the program, a verified address as the floor), reachable while refused because
   * the wall is up when it runs, no step-up (it moves no mail and reads a payment already made).
   * The ACCOUNT is the session's; the body names only the session id. 200 `{state}` is the
   * program's `confirmed` or `pending`; every other answer is a 4xx/5xx the caller polls past.
   */
  {
    method: "POST",
    pattern: "/account/checkout/confirm",
    // A browser returns from a Checkout; no install's write-through relay has a reason to forward it.
    relay: false,
    cost: "paid",
    replay: "ephemeral",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const sessionId = (await readBody<{ sessionId?: unknown } | null>(req))?.sessionId;
      if (typeof sessionId !== "string" || !RETURN_SESSION_ID.test(sessionId)) {
        throw new ServiceError("invalid_session_id", 400, "sessionId must be the id the return address carried.");
      }
      const port = entitlementsPort(deps);
      if (!port?.confirmReturn) {
        throw new ServiceError("no_return_confirm", 404, "This deployment confirms no checkout.");
      }
      const outcome = await port.confirmReturn(ctx.accountId, sessionId);
      if (outcome === "not_found") {
        throw new ServiceError("return_not_found", 404, "No such checkout for this account.");
      }
      if (outcome === "fault") {
        throw new ServiceError("return_unconfirmed", 503, "The checkout could not be confirmed now.");
      }
      return json({ state: outcome }, 200);
    },
  },
];
