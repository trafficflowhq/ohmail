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
    // RAW route: the browser flow has already authenticated (tf_session cookie),
    // so we mint a code and 302 to the redirect_uri — no JSON envelope.
    //
    // ── `stepUp: true` ────────────────────────────────────────────────────────────────────
    //
    // What this route mints is a native authorization code, and what that code buys at
    // `POST /oauth/token` is a session on the NATIVE surface: a new family, a new device row,
    // and `nativeRefreshTtlMs` — four hundred rolling days — none of it reachable from the
    // browser session that authorized it. Minting a long-lived credential is the thing step-up
    // exists for, and this is the same gate `POST /auth/desktop-link` has carried all along for
    // the mirror-image reason. The two doors both ADD a device; only one of them was gated.
    //
    // Without it, a still-live access token was enough. Not the password, not a current second
    // factor — any 15-minute bearer could call this directly with the shipped client and its
    // fixed redirect, exchange the code, and hold an independently-revocable 400-day session
    // that the victim's revocation of the compromised device does not touch. That is not a
    // longer window on one compromise; it is a different, durable one.
    //
    // THE FLAG IS NOT SELF-ENFORCING. `raw` routes run a reduced chain, and until this gate
    // landed that chain had no `withStepUp` in it — so this line would have been decorative. See
    // `app.ts#RAW_PIPELINE`, where the middleware was added and the miss is written up.
    //
    // `public` STAYS, and the two are not in tension: `public` is what lets `withSession` DROP
    // an enrollment-scoped cookie here rather than 403 it, which is what keeps a password-only
    // session from escalating into full native bearer tokens. `withStepUp` then answers 401 for
    // the resulting anonymous caller and 403 only for a real session with a stale factor.
    method: "GET",
    pattern: "/oauth/authorize",
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
    cost: "ceremony",
    options: { public: true },
    handler: async (req, deps) => {
      const body = await readBody<TokenBodyAuthCode | TokenBodyRefresh>(req);
      const tokens = await auth(deps).token(serviceContext(deps, req), body);
      return json(tokens, 200);
    },
  },
];
