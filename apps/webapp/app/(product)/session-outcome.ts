/**
 * ═══ IS THERE A SESSION, OR DID WE JUST FAIL TO ASK? — ONE CLASSIFIER, TWO CALLERS ═════════
 *
 * `GET /auth/session` is asked from exactly two places in this app: the shell's confirm
 * (`(product)/mailbox/CloudShell.tsx`, which names the mirror after the account it returns)
 * and `/login`'s "you are already signed in" bootstrap
 * (`(product)/login/LoginScreen.tsx`). Both used to hold their own `catch`, and both mapped
 * every failure onto their own version of "no session":
 *
 *     } catch { return null; }     // CloudShell  → "You are signed out."
 *     } catch { }                  // LoginScreen → render the form
 *
 * — the second one's own comment reading "no session, or unreachable", with one screen for
 * both.
 *
 * That is one defect written twice, and it is why the report it came from has two halves. A
 * `503 db_busy` on the confirm rendered "You are signed out." over a live cookie; clicking
 * Sign in then showed the FORM if the same burst was still going and dropped the person
 * straight into their mailbox if it was over — which is the product contradicting itself
 * inside ten seconds. `AUTH-FLICKER-DIAGNOSIS.md` has the failing request (12:40:09.296Z,
 * `{"event":"request_db_busy","route":"/auth/session","status":503}`) and the eleven-case
 * reproduction.
 *
 * So the predicate lives here, once, and neither caller calls `auth.session()` any more. Two
 * screens that answer the same question must not be able to answer it differently, and the
 * only way to mean that is for there to be one answer.
 *
 * ── `none` HAS EXACTLY TWO ARMS. EVERYTHING ELSE IS `unknown`. ──────────────────────────────
 *
 * `none` is a VERDICT: the caller renders it immediately, with no retry. It is therefore the
 * narrow arm, and it is narrow on purpose — the failure this module exists to end was a
 * verdict inferred from a status code. The two facts that qualify:
 *
 *   (a) the server answered 200 and said `scope !== "full"`. An enrollment-scoped session is
 *       a real credential for a real user who has not finished 2FA; it authenticates
 *       `/auth/2fa/*` and nothing else, and handing it a mailbox is the escalation the scope
 *       exists to prevent. The server SAID this, so it is answered, not guessed.
 *   (b) a coded 401 whose refresh came back `"revoked"`. `POST /auth/refresh` is the recovery
 *       path itself: its coded 401 is the server stating the refresh family is gone and the
 *       cookie jar cleared, which is the one unambiguous "you are signed out" this product
 *       ever receives. It is the same fact `session-truth.ts` latches, read from the same
 *       branch that latches it.
 *
 * Both halves of (b) are load-bearing. Without `wire.coded` a platform 401 — deployment
 * protection, an alias mid-roll — counts as the server's word when nothing of ours answered.
 * Without the refresh outcome a *transient* 401 counts, and `sync-scheduler.ts` records
 * measuring exactly that: during a ~6-minute deploy window the API answered coded 401s that
 * were not revocations at all.
 *
 * ── WHY NOT `sessionIsDead()`, WHICH LOOKS LIKE THE SAME QUESTION ───────────────────────────
 *
 * Because that latch is sticky and deliberately survives a sign-in — `engine.tsx` documents
 * the case where `/login`'s own 401 latches it and `router.push("/")` carries the latch into a
 * freshly signed-in shell, which is why the confirmed owner WITHDRAWS the claim there. Keying
 * this predicate on it would read that stale `true`, meet one unrelated 503, and reproduce the
 * pane over a session the server had just confirmed. `lastRefreshOutcome()` is the
 * non-sticky fact: what the last refresh actually learned.
 *
 * ── AND NOT `wire.retryable` EITHER ─────────────────────────────────────────────────────────
 *
 * `retryable === false` is true of nearly every clean refusal — `HttpAdapter.rejectionOf`
 * defaults it from the status — so a predicate keyed on it catches far more than a revoked
 * session. `sync-scheduler.ts` names that as a measured defect. The field is carried on
 * {@link ApiWire} for backoff and reporting; it decides nothing here.
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
     * `ceremony: true` — THE FRONT DOOR, and this is the only call in the app that may say it.
     *
     * This request is how the client finds out whether the browser holds a session at all, so by
     * definition it runs before anybody could be bound to an account and the account boundary
     * cannot apply to it. `/auth/session` used to be exempt BY PATH, which handed the same
     * exemption to six ordinary shell reads — the panes that want the signed-in person's email,
     * account id and enrolled factors — and therefore handed them the OTHER account's answer
     * whenever the browser had become somebody else. The exemption belongs to this caller, not
     * to the route.
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
       * NOTHING IS BOUND HERE, AND THAT IS THE CORRECTION.
       *
       * This function used to call `bindApiOwner(accountId)` on its way past. It reads as
       * convenient — one place learns the id, so one place records it — and it mutates SHARED
       * state before the caller has decided whether to believe the answer.
       *
       * The sequence review found: a warm request for A leaves while the client is `pending(A)`;
       * another tab signs in as B; this classifier answers B and rebinds the client to B on the
       * spot; the in-flight A request's recovery path then re-reads the binding, sees B, and is
       * judged to hold — so it refreshes and retries under B and accepts B's answer, all before
       * the A shell has been torn down. A resolver whose effect was already CANCELLED did it too,
       * because a cancelled promise still runs its `.then`.
       *
       * So the classifier returns an identity and commits nothing. The caller binds after its own
       * cancellation check and its own comparison against the mirror's account — `EngineProvider`'s
       * `onConfirmed`, called
       * beside `confirmSyncOwner` in the arm where the answer has already been believed.
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
     * EVERYTHING ELSE, enumerated so the next reader knows it was considered rather than
     * forgotten: an uncoded 401 (a platform interposing); a coded 401 whose refresh was
     * `"unavailable"` (the refresh could not be made either) or `"minted"` (a server that
     * mints a session and then refuses it is deploy skew, and the scheduler measured exactly
     * that); any 403, coded or not — `/auth/session` is `enrollmentOk`, so no ohmail 403
     * exists there today and a future one must not become a verdict by default; 419, which is
     * not a status this API sends; 429; every 5xx, `db_busy` included; a platform body with no
     * envelope of ours; and `OFFLINE_CODE`, a fetch that never reached anybody.
     *
     * `retryAfterMs` is carried through when the server named one — it seeds the caller's
     * backoff and is clamped there (`confirm-schedule.ts`), because how long a server wants to
     * be left alone and how long a person will look at a blank screen are different questions.
     */
    return { kind: "unknown", retryAfterMs: err.wire.retryAfterMs ?? null };
  }
}
