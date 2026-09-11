import {
  ServiceError,
  type AuthorizeQuery, type TokenBodyAuthCode, type TokenBodyRefresh,
} from "@trafficflow/services";
import { serviceContext } from "../context.js";
import { errorResponse } from "../responses.js";
import type { Route } from "../router.js";
import { json, readBody } from "./shared.js";
import { auth } from "./shared-cloud.js";

/** §2.6 — native OAuth2 (Authorization-Code + PKCE). */
export const oauthRoutes: Route[] = [
  {
    // Raw route: the browser flow already authenticated (tf_session), so mint a code and 302 to
    // the redirect_uri — no JSON envelope. `stepUp: true`: what this mints buys, at `POST
    // /oauth/token`, a session on the native surface — a new family, a new device row,
    // `nativeRefreshTtlMs` (four hundred rolling days). Without the gate, any live 15-minute
    // bearer could exchange a code for an independently-revocable 400-day session that the
    // victim's device revocation does not touch. The flag is not self-enforcing: `raw` routes run
    // a reduced chain, and `withStepUp` had to be added to it (`app.ts#RAW_PIPELINE`). `public`
    // stays and the two are not in tension: `public` lets `withSession` drop an enrollment-scoped
    // cookie rather than 403 it — what keeps a password-only session from escalating into full
    // native tokens; `withStepUp` then answers 401 for the anonymous caller.
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
        const { redirect } = await auth(deps).authorize(serviceContext(deps, req), query);
        return new Response(null, { status: 302, headers: { Location: redirect } });
      } catch (err) {
        // Raw pipeline has no error envelope; surface a plain ApiError so an
        // invalid client/redirect can't crash the request.
        if (err instanceof ServiceError) return errorResponse(err.code, err.httpStatus, err.message, err.details);
        throw err;
      }
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
      const tokens = await auth(deps).token(serviceContext(deps, req), body);
      return json(tokens, 200);
    },
  },
];
