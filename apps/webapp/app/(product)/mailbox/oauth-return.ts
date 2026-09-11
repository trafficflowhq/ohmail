"use client";

/**
 * The consent ceremony coming back — and it must not depend on a screen being open. A real connect approved on
 * the Microsoft consent screen returned to the Ohbox with no mailbox added: `POST …/complete` never ran,
 * because it lived in `MailboxSection`'s mount effect, and the view is selected by the URL FRAGMENT — never
 * sent to a server, and dropped by the bounce's second redirect. {@link beginOAuthReturn} therefore runs at
 * MODULE SCOPE from `CloudShell`: it corrects the route from the QUERY (which every hop preserves), strips the
 * single-use parameters, then POSTs; the outcome lives in a module-level store, so the pane renders the result
 * rather than causing it. The invariant: landing on the bounce URL completes the ceremony, whatever the
 * fragment said. Cloud-only — it needs `app/api-client`, which the publish denies from the shell.
 */

import { apiConfigured, mailboxes as mailboxApi, messageOf, pendApiOwner } from "../../api-client";
import { readOwner } from "../../shell/owner-cookie";
import { durableSessionRemove, durableSessionSet } from "../../shell/durable";

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
 * The reason codes this client has copy for; anything else falls back to one honest sentence.
 * Exported so a test can assert the pair: every member has a `mailboxes.oauth_<code>` key in
 * `en.json` — a member with no key renders the literal key path at a user, which the fallback
 * cannot catch because a known reason never reaches it. Four, not one per refusal: these are the
 * only outcomes that arrive as a REDIRECT PARAMETER, where no body can carry a sentence; everything
 * `complete` refuses arrives as a JSON error with the server's own sentence, which `messageOf`
 * renders. See `OAuthOutcomeCode` in `packages/api/src/routes/mailbox-oauth.ts`.
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
 * Put the browser where the answer will be, and take the single-use values out of the URL. One `replaceState`
 * doing both, because they are the same edit: `?settings=mailboxes` is read at mount and kept (a pane name is
 * not a credential); `#/settings` is SET rather than trusted — the fragment is what the redirect chain can
 * drop, and it decides which screen this is; `oauth`, `state`, `code`, `reason` are removed BEFORE the POST —
 * the authorization code is single-use and must not sit in an address bar for the length of an IMAP probe, and
 * a reload must not re-POST a spent state. `replaceState` and not `location.hash = …`: assigning the hash
 * pushes a history entry, and Back returning to a URL with a spent code is the reload case again. A
 * `hashchange` is dispatched by hand for any router that already read the old fragment.
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
/**
 * WHICH ACCOUNT STARTED THIS CEREMONY: The consent flow leaves this origin and comes back, and "comes back" can be
 * minutes later — long enough for another tab to have signed in as somebody else. The completion used to pend
 * whatever the cookie jar named ON RETURN, which is the wrong account by exactly the amount that matters: the server
 * then consumes the single-use `state` BEFORE it compares accounts, so the legitimate owner's ceremony is destroyed
 * and they have to start over, with nothing on screen explaining why. No mailbox is attached to the wrong account —
 * the server's comparison is sound — but the person who did everything right is the one who pays. So the account is
 * written down when the ceremony STARTS, keyed by the `state` the server issued for it, and read back at return.
 * `sessionStorage` because the lifetime is exactly right: one tab, across navigations, gone when the tab is.
 */

/**
 * Best-effort by construction. A private window with storage disabled, a `state` that never got recorded, an entry
 * evicted — all answer `null`, and the caller then falls back to the marker, which is what it did before this
 * existed. This narrows a window; it is not a proof of identity, and it must not be able to BLOCK a legitimate
 * completion.
 */
const OAUTH_OWNER_PREFIX = "ohmail.oauth.owner.";

export function rememberOAuthOwner(state: string, accountId: string | null): void {
  if (typeof sessionStorage === "undefined" || accountId === null) return;
  // The return falls back to the marker exactly as it always did; the refusal is announced once.
  durableSessionSet(OAUTH_OWNER_PREFIX + state, accountId, "oauth.owner");
}

function takeOAuthOwner(state: string): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const key = OAUTH_OWNER_PREFIX + state;
    const owner = sessionStorage.getItem(key);
    // Single use, like the `state` it is keyed by: a consumed ceremony must not leave an
    // expectation behind for whatever navigates here next. A removal that REFUSED leaves that
    // expectation in the jar, so the caller falls back to the marker — `null`, exactly as it
    // did when the whole accessor threw.
    if (durableSessionRemove(key, "oauth.owner") === "lost") return null;
    return owner;
  } catch {
    return null;
  }
}

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

  /*
   * PEND THE ACCOUNT THAT STARTED THIS, not the one the jar happens to name now. See
   * `rememberOAuthOwner`. Falling back to the marker keeps the pre-existing behaviour where
   * nothing was recorded, which must never be a reason to refuse a legitimate completion.
   */
  pendApiOwner(takeOAuthOwner(back.state) ?? readOwner());

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
