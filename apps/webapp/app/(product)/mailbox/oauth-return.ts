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

import { ApiError, apiConfigured, codeOf, mailboxes as mailboxApi, messageOf, pendApiOwner } from "../../api-client";
import { readOwner, readOwnerMarker } from "../../shell/owner-cookie";
import { durableSessionRemove, durableSessionSet } from "../../shell/durable";
import { resolveOwnerOutcome } from "../session-outcome";

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
/** Where this page load's return lands, once {@link beginOAuthReturn} has read it. */
let landing: OAuthLanding | null = null;
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
 * WHERE A RETURN LANDS, a closed set: `settings` (Settings → Mailboxes, the default), `join` (the sign-up
 * wizard's mailbox step) or `first-run` (the setup stage). Microsoft's bounce always comes back to `/`, and
 * an error bounce carries no `state`, so the start writes its landing into this tab before it leaves.
 */
export type OAuthLanding = "settings" | "join" | "first-run";
const LANDINGS: ReadonlySet<string> = new Set<OAuthLanding>(["settings", "join", "first-run"]);
const OAUTH_LANDING_KEY = "ohmail.oauth.landing";

/**
 * EVERY START WRITES ITS OWN LANDING, keyed by the `state` it was issued, so a `join` left behind by a
 * wizard start abandoned at Microsoft never takes a later Settings sign-in to `/join`.
 */
export function rememberOAuthLanding(where: OAuthLanding, state: string): void {
  if (typeof sessionStorage === "undefined") return;
  durableSessionSet(OAUTH_LANDING_KEY, JSON.stringify({ landing: where, state }), "oauth.landing");
}

/**
 * Read once and removed. A code return lands where the start of THAT ceremony asked; an error return names
 * no ceremony and lands where this tab's last start asked. Anything unreadable, or a removal the jar refused,
 * is Settings.
 */
function takeOAuthLanding(back: NonNullable<OAuthReturn>): OAuthLanding {
  if (typeof sessionStorage === "undefined") return "settings";
  try {
    const raw = sessionStorage.getItem(OAUTH_LANDING_KEY);
    if (raw === null) return "settings";
    if (durableSessionRemove(OAUTH_LANDING_KEY, "oauth.landing") === "lost") return "settings";
    const rec = JSON.parse(raw) as { landing?: unknown; state?: unknown };
    if (typeof rec.landing !== "string" || !LANDINGS.has(rec.landing)) return "settings";
    if (back.kind === "pending" && rec.state !== back.state) return "settings";
    return rec.landing as OAuthLanding;
  } catch {
    return "settings";
  }
}

/** `useSyncExternalStore`'s snapshot for the shell: is this load finishing a sign-in for `/join`? */
export function oauthLandsInJoin(): boolean {
  return landing === "join";
}

/** The server render lands nowhere. */
export function noJoinLanding(): boolean {
  return false;
}

/**
 * WHAT `/join` IS HANDED: the outcome's kind and reason. Never the address — the wizard reads the mailbox
 * back from `GET /mailboxes` — and a server sentence only for a reason the wizard does not word itself.
 */
export type JoinOAuthOutcome =
  | { kind: "connected" }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; reason: string | null; message?: string };
const JOIN_OUTCOME_KEY = "ohmail.oauth.join";

/**
 * The `complete` refusals the wizard words itself. The server's sentences for these were written for
 * Settings ("Start again from Settings."), which is the wrong screen inside `/join`.
 */
export const JOIN_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "state_invalid", "state_expired", "account_mismatch", "provider_unavailable",
  "exchange_failed", "no_refresh_token", "no_address", "oauth_unconfigured",
]);
const REASON_SHAPE = /^[a-z0-9_]{1,48}$/;

function joinFailureOf(err: unknown): JoinOAuthOutcome {
  const code = codeOf(err);
  const stated = err instanceof ApiError ? (err.details as { reason?: unknown } | null | undefined)?.reason : undefined;
  // The client's refusal for a jar that names another account is the server's mismatch, one step earlier.
  const reason = code === "owner_mismatch" ? "account_mismatch"
    : code === "oauth_unconfigured" ? "oauth_unconfigured"
    : typeof stated === "string" ? stated : code;
  if (JOIN_FAILURE_REASONS.has(reason)) return { kind: "failed", reason };
  const message = messageOf(err);
  return {
    kind: "failed", reason: REASON_SHAPE.test(reason) ? reason : null,
    // Kept only where it cannot name the mailbox.
    ...(message.includes("@") ? {} : { message }),
  };
}

/** Store the outcome for the wizard and go back to it. `replace`: the bounce is no page to return to. */
function handBackToJoin(back: JoinOAuthOutcome): void {
  durableSessionSet(JOIN_OUTCOME_KEY, JSON.stringify(back), "oauth.join");
  window.location.replace("/join");
}

/** The wizard's read of what its sign-in came back with; once, then gone. */
export function takeJoinOAuthOutcome(): JoinOAuthOutcome | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(JOIN_OUTCOME_KEY);
    if (raw === null) return null;
    if (durableSessionRemove(JOIN_OUTCOME_KEY, "oauth.join") === "lost") return null;
    const rec = JSON.parse(raw) as { kind?: unknown; reason?: unknown; message?: unknown };
    if (rec.kind === "connected") return { kind: "connected" };
    if (rec.kind === "refused" && typeof rec.reason === "string") return { kind: "refused", reason: rec.reason };
    if (rec.kind !== "failed") return null;
    return {
      kind: "failed", reason: typeof rec.reason === "string" ? rec.reason : null,
      ...(typeof rec.message === "string" ? { message: rec.message } : {}),
    };
  } catch {
    return null;
  }
}

/** The values a return carries that must leave the address bar before the POST. */
const ONE_TIME = ["oauth", "state", "code", "reason"];

/**
 * Put the browser where the answer will be, and take the single-use values out of the URL. One `replaceState`
 * doing both, because they are the same edit: `?settings=mailboxes` is read at mount and kept (a pane name is
 * not a credential); `#/settings` is SET rather than trusted — the fragment is what the redirect chain can
 * drop, and it decides which screen this is; `oauth`, `state`, `code`, `reason` are removed BEFORE the POST —
 * the authorization code is single-use and must not sit in an address bar for the length of an IMAP probe, and
 * a reload must not re-POST a spent state. `replaceState` and not `location.hash = …`: assigning the hash
 * pushes a history entry, and Back returning to a URL with a spent code is the reload case again. A
 * `hashchange` is dispatched by hand for any router that already read the old fragment. A `first-run` landing
 * opens the setup stage the same way, without the pane.
 */
function landOn(where: "settings" | "first-run"): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  if (where === "settings") url.searchParams.set("settings", "mailboxes");
  else url.searchParams.delete("settings");
  for (const k of ONE_TIME) url.searchParams.delete(k);
  const hash = where === "settings" ? "#/settings" : "#/first-run";
  const changed = url.hash !== hash;
  /* The router's own `history.state` is kept, as every writer under this app keeps it: a state
     without the app router's marker makes it adopt the URL it was given and restore it over the
     next hash change (the away notice's link opened nothing that way). */
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${hash}`);
  if (changed) window.dispatchEvent(new Event("hashchange"));
}

/** A `join` landing waits on `/` behind the shell's gate: nothing single-use, no pane and no route left. */
function waitForJoin(): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  for (const k of [...ONE_TIME, "settings"]) url.searchParams.delete(k);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
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
  const where = takeOAuthLanding(back);
  landing = where;
  const join = where === "join";
  // THE ROUTE FIRST. Whatever happens next — a refusal, a dead network, an exception — the browser is
  // already on the screen the answer belongs to, which is the half of this that was missing.
  if (where === "join") waitForJoin();
  else landOn(where);

  if (back.kind === "error") {
    publish({ kind: "refused", reason: back.reason });
    if (join) handBackToJoin({ kind: "refused", reason: OAUTH_REASONS.has(back.reason) ? back.reason : "consent_failed" });
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
    let handed: JoinOAuthOutcome;
    try {
      /* A session born in the sign-up wizard can reach here with no `tf_owner` in the jar, and the
         account gate refuses a pending client that cannot read one. The session read writes it back. */
      if (join && readOwnerMarker().kind === "absent") await resolveOwnerOutcome().catch(() => null);
      const out = await mailboxApi.oauthComplete({ state: back.state, code: back.code });
      // `created` distinguishes a first connect from a reconnect, and the two are different things to
      // somebody who came here to fix a mailbox that had stopped.
      publish({ kind: "connected", address: out.mailbox.address, created: out.created });
      handed = { kind: "connected" };
    } catch (err) {
      publish({ kind: "failed", message: messageOf(err) });
      handed = joinFailureOf(err);
    }
    if (join) handBackToJoin(handed);
  })();
  return outcome;
}

/** Test seam. The store is module state by design, so a suite needs a way back to zero. */
export function resetOAuthReturn(): void {
  started = false;
  outcome = null;
  landing = null;
  listeners.clear();
}
