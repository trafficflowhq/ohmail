import { randomBytes } from "node:crypto";
import {
  buildMicrosoftAuthorizeUrl, pkcePair, oauthState, exchangeAuthorizationCode,
  addressFromIdToken, classifyConsentFailure, deviceFlowAvailable, MS_TENANT_RE,
  OAuthConfigError, OAuthExchangeFailedError, OAuthProviderUnavailableError,
  silentLogger, type FetchLike,
} from "@trafficflow/core";
import {
  createOAuthCeremony, consumeOAuthCeremony, pruneOAuthCeremonies,
  resolveOAuthProviderConfig, webRedirectUri, MICROSOFT_PROVIDER,
  type ResolvedOAuthConfig,
} from "@trafficflow/db/cloud";
import { defaultOrigin, ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import type { ApiDeps } from "../deps.js";
import { makeImapProbe } from "../imap-probe.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { mailbox, readBody } from "./shared.js";

/**
 * EXCHANGE / MICROSOFT 365 ONBOARDING — the consent ceremony, in THREE routes and not two.
 *
 * ══ WHY THREE, AND WHY THE CALLBACK CANNOT DO THE WORK ═════════════════════════════════════
 *
 * The obvious design is `POST …/start` then `GET …/callback`, with the callback consuming the
 * ceremony, exchanging the code and writing the mailbox. **That design cannot work on this
 * deployment, and the reason is a cookie attribute this repository is explicitly forbidden to
 * widen.**
 *
 * `tf_session` is `SameSite=Strict` (`packages/api/src/cookies.ts`), and Strict means the browser
 * withholds the cookie on a **cross-site top-level navigation**. Microsoft's redirect back from
 * `login.microsoftonline.com` is exactly that. So the callback GET arrives with NO session cookie —
 * not sometimes, always — and a callback that resolved a session would answer 401 to every consent
 * this product will ever run. `cookies.ts` already records this precise behaviour as the reason the
 * `tf_resume` marker exists: *"`SameSite=Strict` withholds every cookie on a cross-site top-level
 * navigation"*. The invariant is `The session cookie is host-only, no Domain=… Never widen it`, and
 * relaxing it to `Lax` for this feature is not on the table.
 *
 * The consequence is a THREE-step shape, and each step's authority is different:
 *
 *  1. **`POST /mailboxes/oauth/microsoft/start`** — a normal authenticated mutation on the FULL
 *     pipeline: verified session (`cost: "work"`), CSRF double-submit, same-site fetch. It mints the
 *     `state` + PKCE pair, writes the ceremony row bound to `session.accountId`, and returns the
 *     authorize URL as JSON for the client to navigate to at top level.
 *  2. **`GET /mailboxes/oauth/microsoft/callback`** — the BOUNCE. It is the URI registered in Azure,
 *     it resolves no session (it cannot), it reads no database, it consumes nothing, and it
 *     authorises nothing. All it does is validate the SHAPE of the parameters Microsoft sent and
 *     303 the browser to this deployment's own app origin carrying them. The origin comes from
 *     CONFIG, never from the request, so this is not an open redirect.
 *  3. **`POST /mailboxes/oauth/microsoft/complete`** — the real thing, and once the browser is on
 *     `ohmail.app` this is a SAME-SITE fetch, so `tf_session` and `tf_csrf` are both sent. It
 *     consumes the ceremony exactly once, asserts the session's account IS the ceremony's account,
 *     exchanges the code, reads the address from the `id_token`, PROBES IMAP, and only then stores.
 *
 * Nothing is lost by the split. The authorization code is single-use and PKCE-bound; the `state` is
 * single-use and account-bound; and the step that spends them both is the one holding a session.
 * What is GAINED is the assertion that the session OWNS the ceremony —
 * `session.accountId === row.account_id` — which the
 * two-route design could not make at all, because it has no session to compare against.
 *
 * ══ ORDER OF OPERATIONS IN `complete`, AND WHY IT IS THIS ORDER ════════════════════════════
 *
 *   consume (single-use, replay-safe) → TTL → ACCOUNT MATCH → exchange → address → probe → store
 *
 *  · CONSUME FIRST, before anything expensive. The `UPDATE … WHERE state = $1 AND consumed_at IS
 *    NULL RETURNING` is the whole replay defence (see `packages/db/src/oauth-ceremony.ts`); doing it
 *    first means a replayed request is refused before it can make this process POST to Microsoft.
 *  · THE ACCOUNT MATCH BEFORE THE EXCHANGE. A `state` belonging to another account is refused
 *    without spending the code, so a stolen `state` cannot be used to burn somebody else's ceremony
 *    AND learn whether the exchange would have worked.
 *  · THE PROBE BEFORE THE STORE — `MailboxService.connectOAuth` owns that ordering, exactly as
 *    `create` and `update` do for a password. A refused probe leaves an existing mailbox syncing on
 *    the credential it already has.
 *
 * ══ WHAT IS NEVER LOGGED HERE ═════════════════════════════════════════════════════════════
 *
 * No line in this file prints an authorization code, a `state`, an access token, a refresh token, an
 * `id_token`, or Microsoft's `error_description` (which carries request ids and can echo the
 * redirect URI). `log.ts` redacts on the `token`/`secret` substrings, and that is a backstop rather
 * than the plan: the plan is that these values are not passed to a logger. The one diagnostic that
 * leaves is the closed-set reason code.
 */

/**
 * The mailbox provider preset, server-side. The client does not get to name the IMAP or SMTP host
 * for an oauth mailbox, unlike the password form where an unusual server is legitimate: the
 * provider is fixed by the token issuer — a Microsoft refresh token is only good against
 * Microsoft's servers — so a host from the body would be an argument with one correct value, and
 * a different one an attempt to point our dialler at an arbitrary host. Mirrors the webapp's
 * `microsoft` preset. The scope host and the IMAP host differ on purpose — see `MS_MAIL_SCOPE` in
 * `packages/core/src/oauth/microsoft.ts`.
 */
const MS_MAILBOX_PRESET = {
  provider: "microsoft",
  imap: { host: "outlook.office365.com", port: 993, secure: true },
  smtp: { host: "smtp.office365.com", port: 587, secure: false },
} as const;

/**
 * Where the bounce sends the browser — the app's one public URL, no longer `/mailbox`.
 * `?settings=mailboxes` opens the right pane; `#/settings` is the hash route; the client strips
 * the query once read. `/mailbox` is an internal rewrite target the middleware 308s back to `/`,
 * and the 308's `Location` carries no fragment — fragment inheritance on redirect is a SHOULD,
 * and the fragment selected the view, so a browser that dropped it left the ceremony parameters
 * unread: consent granted, row unconsumed, no mailbox. One hop, to the only address the app has;
 * the client also re-derives the route from the query (`oauth-return.ts`), which every hop
 * preserves.
 */
export const OAUTH_RETURN_PATH = "/";
const OAUTH_RETURN_HASH = "#/settings";

/**
 * What the bounce may put in a URL, as a closed set — deliberately short. A code and never a
 * sentence, the `MailboxErrorCode` rule: one vocabulary, translated sentences in `en.json`
 * (`mailboxes.oauth_*`), and no chance of Microsoft's own prose — request ids, timestamps,
 * sometimes the callback URI — in a URL a user pastes into a ticket. This is the only place the
 * client owns the copy, and the split is not an inconsistency: everything `complete` refuses
 * comes back as a JSON `ServiceError` whose sentences the server owns; the bounce is a 303 with
 * no body, and the URL must not carry prose. The list is what the bounce can actually emit, and
 * `bounceUrl` is typed on it, so inventing a fifth is a compile error.
 */
export type OAuthOutcomeCode =
  /** From `classifyConsentFailure` — the provider's own error redirect. */
  | "admin_consent_required" | "consent_declined" | "consent_failed"
  /** A `state`/`code` whose shape could not have come from Microsoft. */
  | "state_invalid";

/**
 * `code` and `state` as they may appear in a URL, and nothing else may. The escaping is not what
 * this buys — `searchParams.set` percent-encodes regardless — it buys a refusal instead of a
 * reflection, and the cap keeps unbounded input out of a response header. A failing value gets
 * `state_invalid`, the same answer a forged `state` gets. Two caps because the values differ in
 * size: a `state` is ours (43 characters; 512 is generous), a `code` is Microsoft's and grows
 * with tenant configuration — a 2048 cap refused a genuine consent, silently, as the sentence for
 * a forged value. The cap is a bound, not the security control.
 */
const URL_SAFE_STATE = /^[A-Za-z0-9._~-]{1,512}$/;
const URL_SAFE_CODE = /^[A-Za-z0-9._~-]{1,8192}$/;

const q = (u: URL, name: string): string | null => {
  const v = u.searchParams.get(name);
  return typeof v === "string" && v.length > 0 ? v : null;
};

/** The app origin. From CONFIG, never from the request — this is what stops an open redirect. */
function appOrigin(deps: ApiDeps): string {
  return deps.appOrigin ?? defaultOrigin(deps.authConfig);
}

/**
 * Build the bounce target.
 *
 * `returnTo` is deliberately NOT accepted here as an absolute URL and is not accepted from the
 * callback's query at all: the only `returnTo` this flow honours is the one the ceremony row stored,
 * which `start` validated as a same-site RELATIVE PATH. A redirect target that came back through
 * Microsoft's redirect would be attacker-controlled by construction.
 */
/**
 * The parameters the bounce may carry, as a TYPE rather than a `Record<string, string>`.
 *
 * `OAuthOutcomeCode` was an exported type nothing referenced — a closed set stated in a comment,
 * which is decoration. Naming it here is what makes it a compile error to invent a reason the
 * webapp has no sentence for; `en.json`'s `mailboxes.oauth_*` keys are the other half of the pair.
 */
type BounceParams =
  | { oauth: "pending"; state: string; code: string }
  | { oauth: "error"; reason: OAuthOutcomeCode };

function bounceUrl(
  deps: ApiDeps, params: BounceParams, returnPath: string = OAUTH_RETURN_PATH,
): string {
  const url = new URL(returnPath, appOrigin(deps));
  url.searchParams.set("settings", "mailboxes");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.hash = OAUTH_RETURN_HASH;
  return url.toString();
}

/**
 * 303, and 303 specifically. The callback is a GET so 302 would work — but 303's meaning is "the
 * result is at another URI, fetch it with GET" regardless of the original method, which keeps the
 * answer correct if the response mode ever changes to `form_post`. `Cache-Control: no-store`
 * because the Location carries single-use ceremony parameters, and `Referrer-Policy: no-referrer`
 * so the app page does not forward the callback URL — which contains the authorization code — to
 * anything it loads.
 */
function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/** Resolve the registration for this deployment: the row if there is one, else the env bootstrap. */
async function resolveConfig(deps: ApiDeps): Promise<ResolvedOAuthConfig> {
  return resolveOAuthProviderConfig({
    tx: deps.db,
    decrypt: (ct, kv) => deps.keyProvider.decrypt(ct, kv),
    bootstrap: deps.msOAuth,
    provider: MICROSOFT_PROVIDER,
  });
}

/**
 * Exactly what `POST …/start` will accept — the one predicate the webapp reads to decide whether
 * to offer the Outlook door. `cfg.enabled` is already the resolver's whole verdict; the redirect
 * and the tenant are re-checked here so this expression and the gate in `…/start` are the same
 * three clauses, and a button can never be shown for a press that would 503. It is the boolean
 * the capability read publishes, and the only thing about the registration that ever reaches a
 * browser — no client id, no tenant, no secret, no redirect URI.
 */
export function microsoftOAuthAvailable(cfg: ResolvedOAuthConfig): boolean {
  return cfg.enabled && webRedirectUri(cfg) !== null && MS_TENANT_RE.test(cfg.tenant);
}

/**
 * The refusal when this deployment has no usable registration.
 *
 * 503 and not 404: the surface EXISTS and the operator has not finished arming it, which is a
 * different sentence from "there is no such route". `details.gap` carries the resolver's closed-set
 * reason so the admin console and the webapp can say which half is missing without either of them
 * re-deriving the precedence rule.
 */
const unconfigured = (cfg: ResolvedOAuthConfig): ServiceError => new ServiceError(
  "oauth_unconfigured", 503,
  "Connecting a Microsoft mailbox is not available on this deployment yet.",
  { gap: cfg.gap, source: cfg.source },
);

/**
 * A same-site RELATIVE path, or null.
 *
 * Accepts `/mailbox`, `/mailbox/x`; refuses everything else — an absolute URL, a scheme-relative
 * `//evil.example` (which `new URL(x, origin)` resolves to another ORIGIN), a bare path with no
 * leading slash, anything with a backslash (which some browsers normalise to `/`), and anything
 * carrying its own query or fragment (this builder owns both). The check is on the STRING and then
 * re-checked on the resolved URL's origin, because "starts with one slash and not two" is exactly
 * the kind of rule that a normalisation step downstream can invalidate.
 */
export function safeReturnPath(raw: unknown, origin: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  if (raw.includes("?") || raw.includes("#")) return null;
  try {
    const u = new URL(raw, origin);
    return u.origin === new URL(origin).origin ? u.pathname : null;
  } catch {
    return null;
  }
}

/**
 * How this host reaches the token endpoint. `deps.oauthFetch` when a host injected one (every test
 * does), else Node's global. An injected PORT rather than a stubbed global, for the reason
 * `deps-cloud.ts` states on the field.
 */
const tokenFetch = (deps: ApiDeps): FetchLike =>
  deps.oauthFetch ?? (globalThis.fetch as unknown as FetchLike);

interface StartBody {
  /**
   * OPTIONAL, and used for ONE thing: the `login_hint` on the consent screen, so somebody
   * reconnecting an expired mailbox is offered the right Microsoft account first. It is ownership-
   * checked before it is read, and it does NOT decide which mailbox row the ceremony writes — the
   * `id_token` claim does. A person who ignores the hint and signs in as somebody else gets that
   * other mailbox, which is the honest outcome; the alternative (repointing the named row at an
   * address it does not hold) is the defect cloud 0009's header refuses by omitting `mailbox_id`.
   */
  mailboxId?: string;
  /** Where to land afterwards. Validated as a same-site relative path; anything else is ignored. */
  returnTo?: string;
}

export const mailboxOAuthRoutes: Route[] = [
  {
    /**
     * Is the Outlook door armed — the one bit the webapp needs to render the Connect/Reconnect
     * affordances, so a dormant registration shows no button that 503s. `cost: "read"`, behind a
     * session: no reason to let an anonymous caller enumerate config state. The body is two
     * booleans and nothing else. `device` joined this payload rather than getting its own route —
     * the pane must know which of the two Microsoft ceremonies this deployment runs before
     * rendering. `available` is the redirect ceremony; `device` the device-code flow (a separate
     * public client, self-host only); independent. On the hosted deployment `device` is always
     * `false`.
     */
    method: "GET",
    pattern: "/mailboxes/oauth/microsoft/availability",
    relay: true,
    cost: "read",
    handler: async (_req, deps) => {
      const cfg = await resolveConfig(deps);
      return jsonResponse({
        available: microsoftOAuthAvailable(cfg),
        /*
         * The predicate comes from `packages/core`, NOT from the device route module. Importing that
         * module here would drag both device handlers into the graph of every composition that
         * mounts this route — including the hosted one, which deliberately does not serve them. The
         * device routes call the same function, so the door and its advertisement cannot disagree.
         */
        device: deviceFlowAvailable(deps.msDevice),
      }, { status: 200 });
    },
  },
  {
    method: "POST",
    pattern: "/mailboxes/oauth/microsoft/start",
    relay: true,
    /**
     * `work`, `POST /mailboxes`' class: what this begins ends in a stored credential and a full
     * sync, so it refuses an unverified account (the spend-census change is deliberate and
     * pinned). No `stepUp`, and it is not laziness: step-up proves a person is at the keyboard,
     * and this ceremony proves it more strongly one step later — the consent screen is an
     * interactive Microsoft sign-in with that account's own MFA, and the address is taken from
     * the token it issues. A stolen session gets an authorize URL and nothing else; if it
     * completes, it attaches the attacker's own mailbox. Step-up here would gate the whole
     * ceremony, so this is a real choice, recorded.
     */
    cost: "work",
    handler: async (req, deps) => {
      const cfg = await resolveConfig(deps);
      const redirectUri = webRedirectUri(cfg);
      // THE SAME PREDICATE the capability read publishes, so the Outlook door and this refusal can
      // never disagree. When it says no, name WHICH half is missing: `unconfigured(cfg)` carries the
      // resolver's own gap (`disabled`, `not_configured`, a missing field), except the one case the
      // resolver reports as usable and this still refuses — a junk tenant on an otherwise complete,
      // enabled registration — which is reported here. (The tenant is validated at the URL builder
      // too; this keeps a bad one from surfacing as a 500 instead of a configuration gap.)
      // `|| !redirectUri` is redundant with the predicate (an `enabled` config always has a web
      // redirect) and is kept only so the compiler narrows `redirectUri` to `string` past this point.
      if (!microsoftOAuthAvailable(cfg) || !redirectUri) {
        if (cfg.enabled && redirectUri) throw unconfigured({ ...cfg, gap: "tenant_missing" });
        throw unconfigured(cfg);
      }

      const ctx = serviceContext(deps, req);
      const body = await readBody<StartBody>(req).catch(() => ({} as StartBody));

      // The hint, and the OWNERSHIP CHECK that has to precede reading it. `mailbox(deps).get` is
      // account-scoped and 404s a cross-account id, so a guessed uuid cannot turn this route into a
      // "does this mailbox exist" oracle — the same reason `GET /mailboxes/:id/organizer` does its
      // ownership read before it dials.
      let loginHint: string | undefined;
      if (typeof body.mailboxId === "string" && body.mailboxId.length > 0) {
        const dto = await mailbox(deps).get(ctx, body.mailboxId);
        loginHint = dto.address;
      }

      const state = oauthState(randomBytes);
      const pkce = pkcePair(randomBytes);
      const enc = await deps.keyProvider.encrypt(pkce.verifier);
      const returnTo = safeReturnPath(body.returnTo, appOrigin(deps));

      await createOAuthCeremony(deps.db, {
        state,
        accountId: ctx.accountId,
        provider: MICROSOFT_PROVIDER,
        codeVerifierEnc: enc.ciphertext,
        codeVerifierKeyVersion: enc.keyVersion,
        returnTo,
        now: deps.now(),
      });

      /* OPPORTUNISTIC PRUNE, and its failure is swallowed on purpose: a ceremonies table that grew
       * by one row is not a reason to refuse somebody's connect. See `pruneOAuthCeremonies` for why
       * this is not a cron. */
      await pruneOAuthCeremonies(deps.db, { now: deps.now() })
        .catch((err: unknown) => {
          (deps.logger ?? silentLogger).warn?.("oauth_ceremony_prune_failed", { err: String(err) });
        });

      const authorizeUrl = buildMicrosoftAuthorizeUrl({
        tenant: cfg.tenant,
        clientId: cfg.clientId,
        redirectUri,
        scopes: cfg.scopes,
        state,
        codeChallenge: pkce.challenge,
        ...(loginHint ? { loginHint } : {}),
      });

      /* The URL is returned as JSON for the client to navigate to, rather than answered as a 303.
       * A fetch cannot follow a redirect to a different origin AND change the top-level document,
       * and it must be top-level: Microsoft's consent screen sets `X-Frame-Options`, so an iframe
       * is not an option, and a popup is blocked in the common case. So the client does
       * `window.location.assign(authorizeUrl)`. `state` is echoed so the client can hold it for the
       * complete step without having to parse it back out of the URL it navigated to. */
      return jsonResponse({ authorizeUrl, state }, { status: 201 });
    },
  },
  {
    method: "GET",
    pattern: "/mailboxes/oauth/microsoft/callback",
    relay: true,
    /**
     * `unauthenticated`, and `public` — the census requires the pair and both are true of this
     * handler: it resolves no session (the Strict cookie is withheld on this navigation), reads
     * nothing, writes nothing, decides nothing about any account; its whole output is a
     * `Location` on an origin from config. Not `anonymous`: `withSession` on the public path
     * never 401s — it populates a session if a credential happens to be present — and keeping it
     * means a request that does arrive with a session (a same-site retry) is observable rather
     * than silently discarded. The cost is one query on a path that runs once per consent.
     */
    cost: "unauthenticated",
    options: { public: true, raw: true },
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const state = q(url, "state");
      const code = q(url, "code");
      const error = q(url, "error");

      // THE PROVIDER'S OWN REFUSAL, classified. Checked before the shape tests below, because an
      // error redirect carries no `code` and would otherwise be reported as a malformed callback.
      if (error) {
        const reason = classifyConsentFailure(error, q(url, "error_description"), q(url, "error_subcode"));
        return seeOther(bounceUrl(deps, { oauth: "error", reason }));
      }

      if (!state || !URL_SAFE_STATE.test(state) || !code || !URL_SAFE_CODE.test(code)) {
        return seeOther(bounceUrl(deps, { oauth: "error", reason: "state_invalid" }));
      }

      /* The two values are handed to the CLIENT, which immediately POSTs them back same-site. They
       * are already in the browser's history from Microsoft's own redirect, so this adds no
       * exposure; the client replaces the URL as soon as it has read them. */
      return seeOther(bounceUrl(deps, { oauth: "pending", state, code }));
    },
  },
  {
    method: "POST",
    pattern: "/mailboxes/oauth/microsoft/complete",
    relay: true,
    /**
     * `work`, and it is the member of that class that most obviously earns it: it stores a
     * credential and what the credential buys is a persistent IMAP connection and a full sync. Same
     * class as `POST /mailboxes`, so an unverified account is refused here too — which matters,
     * because this is the route that would otherwise be the way around the gate on `start`.
     */
    cost: "work",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const body = await readBody<{ state?: unknown; code?: unknown }>(req);
      const state = typeof body.state === "string" ? body.state : "";
      const code = typeof body.code === "string" ? body.code : "";
      if (!URL_SAFE_STATE.test(state) || !URL_SAFE_CODE.test(code)) {
        throw new ServiceError("validation_failed", 400, "state and code are required", { reason: "state_invalid" });
      }

      // ── (1) SINGLE-USE CONSUME. First, before anything expensive, and before any decision. ──
      const spent = await consumeOAuthCeremony(deps.db, { state, now: deps.now() });
      if (spent.outcome === "unknown") {
        // A `state` that never existed and one already spent are ONE answer, deliberately: telling
        // them apart is an oracle for whether a given 256-bit value was ever issued. 400 rather than
        // 403 — nothing here is a statement about the caller's authorisation, only about the value.
        throw new ServiceError(
          "oauth_state_invalid", 400,
          "That Outlook connection link is no longer valid. Start again from Settings.",
          { reason: "state_invalid" },
        );
      }
      if (spent.outcome === "expired") {
        throw new ServiceError(
          "oauth_state_expired", 400,
          "That took too long to complete. Start again from Settings.",
          { reason: "state_expired" },
        );
      }
      const row = spent.row;

      // ── (2) INVARIANT 9 — THE SESSION'S ACCOUNT IS THE CEREMONY'S ACCOUNT. ──────────────────
      //
      // Before the exchange, so a `state` belonging to somebody else is refused without this process
      // POSTing to Microsoft. The ceremony row is the only thing that knows which account began the
      // flow; the session is the only thing that knows who is finishing it; and a mailbox may only
      // ever be attached to the account that asked for it. The row IS consumed by the step above, so
      // a stolen `state` is burnt rather than left usable — which is the right direction: the
      // legitimate owner starting again gets a fresh one.
      if (row.accountId !== ctx.accountId) {
        throw new ServiceError(
          "forbidden", 403,
          "That Outlook connection was started by a different account.",
          { reason: "account_mismatch" },
        );
      }

      const cfg = await resolveConfig(deps);
      const redirectUri = webRedirectUri(cfg);
      if (!cfg.enabled || !redirectUri) throw unconfigured(cfg);

      const verifier = await deps.keyProvider.decrypt(row.codeVerifierEnc, row.codeVerifierKeyVersion);

      // ── (3) THE CODE EXCHANGE. Confidential client: id + secret + verifier + the EXACT uri. ──
      let tokens;
      try {
        tokens = await exchangeAuthorizationCode({
          code,
          codeVerifier: verifier,
          redirectUri,
          tenant: cfg.tenant,
          clientId: cfg.clientId,
          clientSecret: cfg.clientSecret,
          scopes: cfg.scopes,
          fetch: tokenFetch(deps),
        });
      } catch (err) {
        // THREE DIFFERENT FACTS, THREE DIFFERENT SENTENCES, and the split is the point.
        //
        // `OAuthProviderUnavailableError` means we could not ask — a retry is the right advice and
        // nothing about this deployment or this person is wrong. `OAuthConfigError` means OUR tenant
        // is unusable. `OAuthExchangeFailedError` carries Microsoft's own closed-vocabulary verdict,
        // and `invalid_client` inside it means OUR client secret was rejected, which is an operator
        // problem that must never be rendered as the user's fault.
        if (err instanceof OAuthProviderUnavailableError) {
          throw new ServiceError(
            "upstream_unavailable", 503,
            "Microsoft could not be reached. Try connecting again in a moment.",
            { reason: "provider_unavailable" }, true,
          );
        }
        if (err instanceof OAuthConfigError) throw unconfigured({ ...cfg, gap: "tenant_missing" });
        if (err instanceof OAuthExchangeFailedError) {
          (deps.logger ?? silentLogger).warn?.("oauth_exchange_failed", {
            // The OAuth2 `error` code only. Never the description, never the code, never the state.
            oauthError: err.oauthError, httpStatus: err.httpStatus,
          });
          throw new ServiceError(
            "oauth_exchange_failed", 502,
            err.oauthError === "invalid_client"
              ? "This deployment's Microsoft credentials were rejected. An operator has to fix the registration."
              : "That Outlook connection could not be completed. Start again from Settings.",
            { reason: "exchange_failed" },
          );
        }
        throw err;
      }

      if (!tokens.refreshToken) {
        // No `offline_access` in the GRANTED scopes. The tokens are valid and useless to us: an
        // access token lasts an hour and there would be nothing to renew it with. A configuration
        // fault, named as one, rather than a mailbox stored to fail in sixty minutes.
        throw new ServiceError(
          "oauth_no_refresh_token", 502,
          "Microsoft did not grant long-term access, so this mailbox cannot be kept in sync. "
          + "An operator has to add the offline_access permission.",
          { reason: "no_refresh_token" },
        );
      }

      // ── (4) THE ADDRESS COMES FROM THE `id_token`. THE USER NEVER TYPES IT. ─────────────────
      const address = addressFromIdToken(tokens.idToken);
      if (!address) {
        throw new ServiceError(
          "oauth_no_address", 502,
          "Microsoft did not say which mailbox was connected, so nothing was saved.",
          { reason: "no_address" },
        );
      }

      // ── (5) PROBE, THEN STORE — the service owns the ordering. ──────────────────────────────
      const result = await mailbox(deps).connectOAuth(ctx, {
        provider: MS_MAILBOX_PRESET.provider,
        address,
        oauth: {
          provider: MICROSOFT_PROVIDER,
          tenant: cfg.tenant,
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          imap: MS_MAILBOX_PRESET.imap,
          smtp: MS_MAILBOX_PRESET.smtp,
        },
      }, { probe: makeImapProbe(deps) });

      return jsonResponse(
        { mailbox: result.mailbox, created: result.created, returnTo: row.returnTo },
        { status: result.created ? 201 : 200 },
      );
    },
  },
];
