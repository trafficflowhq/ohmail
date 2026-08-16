"use client";

/**
 * THE CONSENT CEREMONY COMING BACK — and it must not depend on a screen being open.
 *
 * ══ THE PRODUCTION FAILURE THIS FILE EXISTS FOR ════════════════════════════════════════════
 *
 * A real connect: the tenant's administrator approved the app, the Microsoft consent screen
 * succeeded, and the browser came back to the Ohbox with no mailbox added and nothing said. The
 * ceremony row was still `consumed_at IS NULL`, so `POST …/complete` was never CALLED — this was not
 * a refusal that went unrendered, it was a step that never ran.
 *
 * It never ran because it lived in `MailboxSection`'s mount effect, and that component mounts only
 * when the Settings VIEW is open AND the Mailboxes PANE is selected. The view is selected by the URL
 * FRAGMENT (`shell/routing.ts`), a fragment is never sent to a server, and the bounce reached the app
 * through a second redirect (`/mailbox` → 308 → `/`) whose `Location` carries no fragment of its own.
 * Fragment inheritance across a redirect is a browser SHOULD, and `parseHash("")` is `ohbox`. So one
 * dropped `#` moved the whole ceremony from "finishing" to "silently abandoned", with the
 * authorization code sitting unread in the query.
 *
 * ── SO THE COMPLETION IS NOT A COMPONENT EFFECT ANY MORE ────────────────────────────────────
 *
 * {@link beginOAuthReturn} runs at MODULE SCOPE from `CloudShell`, before anything renders and
 * before any router has read anything. It does three things in this order, and the order is the
 * point: it corrects the route from the QUERY (which every redirect hop preserves), it strips the
 * single-use parameters, and only then does it POST. The outcome goes into a module-level store that
 * outlives every mount, so the pane RENDERS the result rather than being the thing that causes it.
 *
 * The invariant, stated so it can be tested: **landing on the bounce URL completes the ceremony,
 * whatever the fragment said and whether or not the Mailboxes pane is ever shown.**
 *
 * ── WHY THIS FILE IS HERE AND NOT IN `app/shell/` ───────────────────────────────────────────
 *
 * It needs `app/api-client`, which `scripts/publish-desktop.mjs` DENYs from the shared shell. Same
 * seam, same reason as `MailboxSection` itself: this is Cloud-only code.
 */

import { apiConfigured, mailboxes as mailboxApi, messageOf } from "../../api-client";

/**
 * WHAT THE CONSENT REDIRECT LEFT IN THE QUERY.
 *
 * The API's `GET /mailboxes/oauth/microsoft/callback` cannot finish the ceremony: `tf_session` is
 * `SameSite=Strict`, so the browser withholds it on the cross-site navigation back from Microsoft.
 * It bounces here instead with either `oauth=pending&state=…&code=…` (finish it from this origin,
 * where the cookie IS sent) or `oauth=error&reason=<closed-set code>`.
 */
export type OAuthReturn =
  | { kind: "pending"; state: string; code: string }
  | { kind: "error"; reason: string }
  | null;

export function readOAuthReturn(search: string): OAuthReturn {
  const q = new URLSearchParams(search);
  const oauth = q.get("oauth");
  if (oauth === "pending") {
    const state = q.get("state");
    const code = q.get("code");
    return state && code ? { kind: "pending", state, code } : { kind: "error", reason: "state_invalid" };
  }
  if (oauth === "error") return { kind: "error", reason: q.get("reason") ?? "consent_failed" };
  return null;
}

/**
 * The reason codes this client has copy for. Anything else falls back to one honest sentence.
 *
 * EXPORTED so a test can assert the pair: every member has a `mailboxes.oauth_<code>` key in
 * `en.json`. A member with no key renders the literal key path at a user, which is the failure the
 * fallback exists to prevent and which the fallback cannot catch — a KNOWN reason never reaches it.
 *
 * FOUR, and not one per refusal. These are the only outcomes that arrive as a REDIRECT PARAMETER,
 * where there is no body for the server to put a sentence in. Everything `complete` refuses arrives
 * as a JSON error carrying the server's own sentence, which `messageOf` renders — so a key here for
 * (say) an expired ceremony would be a second English sentence for a failure that already has one.
 * See `OAuthOutcomeCode` in `packages/api/src/routes/mailbox-oauth.ts`.
 */
export const OAUTH_REASONS = new Set([
  "admin_consent_required", "consent_declined", "consent_failed", "state_invalid",
]);

/**
 * THE OUTCOME, AS FACTS — the copy belongs to the pane.
 *
 * `refused` carries a closed-set reason the pane renders through `oauth_<reason>`; `failed` carries
 * the SERVER'S OWN sentence, because everything `POST …/complete` refuses answers with one and
 * `api-client.ts`'s header is explicit that re-deriving those in the client is how somebody is told
 * they are out of mailbox slots when the real problem is an unpaid subscription.
 */
export type OAuthOutcome =
  | { kind: "running" }
  | { kind: "connected"; address: string; created: boolean }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; message: string };

let outcome: OAuthOutcome | null = null;
let started = false;
const listeners = new Set<() => void>();

function publish(next: OAuthOutcome): void {
  outcome = next;
  for (const l of [...listeners]) l();
}

/** `useSyncExternalStore`'s subscribe. */
export function subscribeOAuthOutcome(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * `useSyncExternalStore`'s snapshot. Referentially stable between publishes, which is what stops a
 * subscriber from re-rendering for ever.
 */
export function oauthOutcome(): OAuthOutcome | null {
  return outcome;
}

/** The server render has no URL and no store. */
export function noOAuthOutcome(): null {
  return null;
}

/**
 * PUT THE BROWSER WHERE THE ANSWER WILL BE, AND TAKE THE SINGLE-USE VALUES OUT OF THE URL.
 *
 * One `replaceState` doing both, because they are the same edit to the same URL:
 *
 *  · `?settings=mailboxes` — `SettingsView.initialPaneFromUrl` reads it at mount. Kept in the
 *    address bar afterwards: a pane name is not a credential, and it is only ever consulted once, so
 *    it cannot drag anybody back to a pane they have since clicked away from.
 *  · `#/settings` — the view. SET rather than trusted, which is the fix: the fragment is what the
 *    redirect chain can drop, and it is the only thing that decides which screen this is.
 *  · `oauth`, `state`, `code`, `reason` — REMOVED before the POST, never after. The authorization
 *    code is single-use and must not sit in an address bar for the length of an IMAP probe, and a
 *    reload must not re-POST a state that is already spent (a 400 about a ceremony that succeeded).
 *
 * `history.replaceState` and not `location.hash = …`: assigning the hash pushes a history entry, and
 * a back button that returns to a URL still carrying a spent code is the reload case again. Nothing
 * observes `replaceState`, so a `hashchange` is dispatched by hand for any router that has already
 * read the old fragment — this normally runs before the first render, and the event is what makes it
 * correct even when it does not.
 */
function landOnMailboxesPane(): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  url.searchParams.set("settings", "mailboxes");
  for (const k of ["oauth", "state", "code", "reason"]) url.searchParams.delete(k);
  const changed = url.hash !== "#/settings";
  window.history.replaceState(null, "", `${url.pathname}${url.search}#/settings`);
  if (changed) window.dispatchEvent(new Event("hashchange"));
}

/**
 * FINISH THE CEREMONY. Once per page load, from the query alone, before anything renders.
 *
 * Returns the outcome so a caller can act on it synchronously; `null` means this page load is not a
 * consent return, which is every other page load. The `started` latch is what makes a second call —
 * a re-import, a remount, React's double-invoked development effects — free: a `state` is single-use
 * and a second POST would answer 400 about a ceremony that had just succeeded.
 */
export function beginOAuthReturn(): OAuthOutcome | null {
  if (started) return outcome;
  if (typeof window === "undefined") return null;
  // An unarmed build (no API base, the demo) has no ceremony and nothing to POST to. Checked before
  // the latch so it cannot swallow the return on a build that has one.
  if (!apiConfigured()) return null;

  const back = readOAuthReturn(window.location.search);
  if (!back) return null;

  started = true;
  // THE ROUTE FIRST. Whatever happens next — a refusal, a dead network, an exception — the browser is
  // already on the screen the answer belongs to, which is the half of this that was missing.
  landOnMailboxesPane();

  if (back.kind === "error") {
    publish({ kind: "refused", reason: back.reason });
    return outcome;
  }

  publish({ kind: "running" });
  void (async () => {
    try {
      const out = await mailboxApi.oauthComplete({ state: back.state, code: back.code });
      // `created` distinguishes a first connect from a reconnect, and the two are different things to
      // somebody who came here to fix a mailbox that had stopped.
      publish({ kind: "connected", address: out.mailbox.address, created: out.created });
    } catch (err) {
      publish({ kind: "failed", message: messageOf(err) });
    }
  })();
  return outcome;
}

/** Test seam. The store is module state by design, so a suite needs a way back to zero. */
export function resetOAuthReturn(): void {
  started = false;
  outcome = null;
  listeners.clear();
}
