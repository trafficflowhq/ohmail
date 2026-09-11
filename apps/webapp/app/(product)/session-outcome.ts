/**
 * Is there a session, or did we just fail to ask? — one classifier, two callers. `GET
 * /auth/session` is asked from the shell's confirm (`CloudShell.tsx`) and `/login`'s bootstrap;
 * both used to hold their own `catch` mapping every failure onto "no session", so a `503 db_busy`
 * rendered "You are signed out." over a live cookie and Sign in contradicted it seconds later
 * (`AUTH-FLICKER-DIAGNOSIS.md` has the failing request and the eleven-case reproduction). The
 * predicate lives here, once; neither caller calls `auth.session()` any more — two screens that
 * answer the same question must not be able to answer it differently.
 */

/**
 * `none` has exactly two arms; everything else is `unknown`. `none` is a VERDICT the caller renders
 * immediately, so it is the narrow arm: (a) a 200 with `scope !== "full"` — an enrollment-scoped
 * session authenticates `/auth/2fa/*` and nothing else; (b) a coded 401 whose refresh came back
 * `"revoked"` — the one unambiguous "signed out" this product receives. Both halves of (b) are
 * load-bearing: without `wire.coded` a platform 401 counts as the server's word; without the refresh
 * outcome a transient 401 counts (`sync-scheduler.ts` measured deploy-window 401s that were not
 * revocations). Not `sessionIsDead()` — sticky, survives a sign-in (`lastRefreshOutcome()` is the
 * non-sticky fact); not `wire.retryable` — defaulted from the status, it decides nothing here.
 */

import { ApiError, auth } from "../api-client";
import { lastRefreshOutcome } from "../session-refresh";
import type { OwnerOutcome } from "../shell/engine";

/** No answer, with no advice about when to come back. */
const UNKNOWN: OwnerOutcome = { kind: "unknown", retryAfterMs: null };

/**
 * Ask the server whose mailbox this browser holds, and classify what came back.
 *
 * Never rejects for a network or server reason — those are outcomes, which is the whole
 * point. It DOES rethrow one thing: `api_unconfigured`, which `api-client.ts` raises when the
 * bundle has no API base. That is a broken deployment rather than an auth result, and
 * dressing it as one would be the same silent lie `EngineUnarmedError` exists to end.
 */
export async function resolveOwnerOutcome(
  /**
   * Stop the request, not just its continuation. `/login` aborts this when a sign-in ceremony
   * starts: a confirm that lands after the new session's cookies are written can rewrite the
   * jar out from under it (the refresh it triggers rotates or clears every cookie), and no
   * amount of ignoring the answer undoes a `Set-Cookie`. An abort surfaces here as a
   * non-`ApiError` throw and is classified `unknown`, which is what it is.
   */
  opts: { signal?: AbortSignal } = {},
): Promise<OwnerOutcome> {
  try {
    /*
     * `ceremony: true` — the front door, and this is the only call in the app that may say it. This
     * request is how the client finds out whether the browser holds a session at all, so it runs
     * before anybody could be bound to an account and the account boundary cannot apply to it.
     * `/auth/session` used to be exempt BY PATH, which handed the same exemption to six ordinary
     * shell reads — and therefore handed them the OTHER account's answer whenever the browser had
     * become somebody else. The exemption belongs to this caller, not to the route.
     */
    const { user, scope } = await auth.session({ ...opts, ceremony: true });
    /*
     * A 200 THAT IS NOT OUR ANSWER. A captive portal, a proxy interstitial and a cache with
     * ideas of its own all return 200 with a body this client can parse into an object with
     * no `scope` in it. Reading a missing field as "not full" would make a coffee-shop Wi-Fi
     * login page a statement about the account, so a shape we do not recognise is no answer
     * at all — and the caller retries, which is what gets past a portal once it clears.
     */
    if (typeof scope !== "string") return UNKNOWN;
    // (a) The server answered. `=== "full"` and not `!== "enrollment"`, so an unrecognised
    //     future scope fails toward the verdict rather than becoming a silent promotion —
    //     the same comparison `session-gate.ts` makes at the edge, for the same reason.
    if (scope !== "full") return { kind: "none" };
    const accountId = user?.accountId;
    if (typeof accountId === "string" && accountId !== "") {
      /*
       * Nothing is bound here, and that is the correction. This used to call `bindApiOwner(accountId)` on its
       * way past — one place learns the id, so one place records it — mutating SHARED state before the caller
       * decided whether to believe the answer. The sequence the review found: a warm request for A leaves while
       * the client is `pending(A)`; another tab signs in as B; this classifier answers B and rebinds on the
       * spot; the in-flight A request's recovery re-reads the binding and retries under B — before the A shell
       * is torn down; a cancelled resolver did it too (a cancelled promise still runs its `.then`). So the
       * classifier returns an identity and commits nothing; the caller binds after its own cancellation check
       * and comparison against the mirror's account (`EngineProvider.onConfirmed`).
       */
      return { kind: "owner", accountId };
    }
    /*
     * `scope: "full"` with no account id is our server answering something it cannot mean.
     * It is not a refusal — nothing was refused — so it is not a verdict; it is a malformed
     * answer, and the honest classification is that we still do not know. `session-gate.ts`
     * carries the cost of the opposite habit: its first cut read `user.id` instead of
     * `user.userId`, every unit test passed against the shape the code expected, and
     * production then rendered the marketing page to live full sessions.
     */
    return UNKNOWN;
  } catch (err) {
    // Not an `ApiError` at all: something threw before or beside the wire. No evidence.
    if (!(err instanceof ApiError)) return UNKNOWN;
    // A bundle with no server behind it. Not an outcome — see the doc above.
    if (err.status === 0 && err.code === "api_unconfigured") throw err;
    // (b) The one refusal that is a verdict. All three conditions, always.
    if (err.status === 401 && err.wire.coded && lastRefreshOutcome() === "revoked") {
      return { kind: "none" };
    }
    /*
     * Everything else, enumerated so the next reader knows it was considered: an uncoded 401 (a
     * platform interposing); a coded 401 whose refresh was `"unavailable"` or `"minted"` (a
     * server that mints a session and then refuses it is deploy skew — measured by the scheduler);
     * any 403 (`/auth/session` is `enrollmentOk`, so no ohmail 403 exists there today, and a future
     * one must not become a verdict by default); 419 (not sent by this API); 429; every 5xx,
     * `db_busy` included; a platform body with no envelope of ours; and `OFFLINE_CODE`.
     * `retryAfterMs` is carried through when the server named one — it seeds the caller's backoff
     * and is clamped there (`confirm-schedule.ts`).
     */
    return { kind: "unknown", retryAfterMs: err.wire.retryAfterMs ?? null };
  }
}
