import { silentLogger } from "@trafficflow/core";
import {
  OAuthCodeReplayed, ServiceError,
  type AuthorizeQuery, type TokenBodyAuthCode, type TokenBodyRefresh,
} from "@trafficflow/services";
import { defaultOrigin } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import type { ApiDeps } from "../deps.js";
import { errorResponse } from "../responses.js";
import type { Route } from "../router.js";
import { json, readBody } from "./shared.js";
import { auth } from "./shared-cloud.js";

/** §2.6 — native OAuth2 (Authorization-Code + PKCE). */

/**
 * Where the browser is sent to confirm. OUR page, on the app's own origin — the whole point of the
 * split: the provider-style redirect now lands on something that ASKS, and the client's
 * `redirect_uri` is reached only after somebody pressed a button. The webapp route of the same
 * name reads `?request=`.
 */
export const OAUTH_CONFIRM_PATH = "/authorize-desktop";

/** The app origin. From CONFIG, never from the request — this is what stops an open redirect. */
function appOrigin(deps: ApiDeps): string {
  return deps.appOrigin ?? defaultOrigin(deps.authConfig);
}

export const oauthRoutes: Route[] = [
  {
    /**
     * THE GET THAT NO LONGER ACTS.
     *
     * It used to mint a native authorization code and 302 straight to the client's `redirect_uri`
     * on nothing but the session cookie the browser happened to carry — so a link composed by
     * somebody else and clicked by a signed-in person authorized a four-hundred-day credential as
     * them, with no CSRF check available to make. Now it validates, writes the request down
     * unspendable, and bounces to a page. Still `raw` and still `public` + `stepUp`: what that
     * pair buys is unchanged and is stated at the POST, where the minting moved.
     */
    method: "GET",
    pattern: "/oauth/authorize",
    relay: false,  /* the OAuth server surface */
    cost: "ceremony",
    options: { public: true, raw: true, stepUp: true },
    handler: async (req, deps) => {
      const p = new URL(req.url).searchParams;
      const query: AuthorizeQuery = {
        response_type: (p.get("response_type") ?? "code") as "code",
        client_id: p.get("client_id") ?? "",
        redirect_uri: p.get("redirect_uri") ?? "",
        code_challenge: p.get("code_challenge") ?? "",
        code_challenge_method: (p.get("code_challenge_method") ?? "S256") as "S256",
        state: p.get("state") ?? "",
        ...(p.get("scope") ? { scope: p.get("scope")! } : {}),
      };
      try {
        const { request } = await auth(deps).authorize(serviceContext(deps, req), query);
        // The handle and nothing else. `state` stays on the server with the rest of the request:
        // echoing it here would put a caller-chosen value in a `Location` header for no reason —
        // the client gets it back at the end of the ceremony, from the stored row.
        const to = new URL(OAUTH_CONFIRM_PATH, appOrigin(deps));
        to.searchParams.set("request", request);
        return new Response(null, { status: 302, headers: { Location: to.toString() } });
      } catch (err) {
        // Raw pipeline has no error envelope; surface a plain ApiError so an
        // invalid client/redirect can't crash the request.
        if (err instanceof ServiceError) return errorResponse(err.code, err.httpStatus, err.message, err.details);
        throw err;
      }
    },
  },
  {
    /**
     * What the confirmation page is about to authorize. A read, so a GET; it spends nothing, which
     * is the property that lets the page render on load without the request dying before anybody
     * presses anything. Session-scoped and bound to the session that opened the request, so a
     * handle that reached another tab describes nothing.
     */
    method: "GET",
    pattern: "/oauth/authorize/request",
    relay: false,  /* the OAuth server surface */
    cost: "read",
    options: {},
    handler: async (req, deps) => {
      const handle = new URL(req.url).searchParams.get("request");
      return json(await auth(deps).readAuthorizeRequest(serviceContext(deps, req), handle), 200);
    },
  },
  {
    /**
     * THE CONFIRMATION — the gesture that mints, and the reason the GET above can be harmless.
     *
     * An unsafe method on a cookie session, so `withCsrf` applies: the token is recomputed from
     * the session this request presented, which a link somebody else composed cannot produce.
     * `stepUp: true` for the reason it was put on the old GET (SEC3-AUTH-6): what this mints buys
     * a session on the native surface, and without the gate any live fifteen-minute bearer could
     * grow itself a four-hundred-day credential device revocation does not touch. Not `public`.
     */
    method: "POST",
    pattern: "/oauth/authorize",
    relay: false,  /* the OAuth server surface */
    cost: "ceremony",
    options: { stepUp: true },
    handler: async (req, deps) => {
      const body = await readBody<{ request?: unknown }>(req);
      return json(await auth(deps).approveAuthorize(serviceContext(deps, req), body ?? {}), 200);
    },
  },
  {
    // Native token exchange: tokens are returned in the BODY (Keychain), no cookies.
    method: "POST",
    pattern: "/oauth/token",
    relay: false,  /* resolves a credential from the request body */
    cost: "ceremony",
    options: { public: true, credentialSubject: true },
    handler: async (req, deps) => {
      const body = await readBody<TokenBodyAuthCode | TokenBodyRefresh>(req);
      try {
        const tokens = await auth(deps).token(serviceContext(deps, req), body);
        return json(tokens, 200);
      } catch (err) {
        /**
         * ONE LINE for a replayed authorization code, written here because this is the layer that
         * has a logger. Two fields, both already on the logger's allowlist: WHAT was replayed and
         * HOW MUCH was withdrawn because of it. The code is not among them and must not be — a log
         * is read by more people than a database is. The error is re-thrown untouched, so the
         * client's answer stays the `invalid_grant` a typo gets and the refusal is not an oracle
         * for which codes were once real.
         */
        if (err instanceof OAuthCodeReplayed) {
          (deps.logger ?? silentLogger).warn("oauth_code_replayed", {
            kind: "authorization_code",
            count: err.revokedSessions + err.revokedTokens,
          });
        }
        throw err;
      }
    },
  },
];
