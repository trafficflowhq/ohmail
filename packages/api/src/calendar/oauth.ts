import { randomBytes, randomUUID } from "node:crypto";
import { classifyConsentFailure, oauthState, pkcePair, silentLogger, type FetchLike } from "@trafficflow/core";
import type { Tx } from "@trafficflow/db";
import { createOAuthCeremony, resolveOAuthProviderConfig } from "@trafficflow/db/cloud";
import {
  CALENDAR_CEREMONIES_BUILT, calendarAuthorizeUrl, consumeCalendarOAuth, exchangeCalendarCode, keepCalendarConnection, requireCalendarConnectionRoom,
  type CalendarOAuthClient, type CalendarOAuthProvider,
} from "@trafficflow/services/calendar-connect";
import { defaultOrigin, ServiceError, withAccountTx } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import type { ApiDeps } from "../deps.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { readBody } from "../routes/shared.js";

const PROVIDERS = ["google", "microsoft"] as const;
export const CALENDAR_OAUTH_STATE_CHARS = 43;
export const CALENDAR_OAUTH_CODE_MAX_CHARS = 8192;
export const CALENDAR_OAUTH_ERROR_MAX_CHARS = 128;
export const CALENDAR_OAUTH_ERROR_DESCRIPTION_MAX_CHARS = 4096;
const STATE = new RegExp(`^[A-Za-z0-9_-]{${CALENDAR_OAUTH_STATE_CHARS}}$`);
const CODE = new RegExp(`^[A-Za-z0-9._~/-]{1,${CALENDAR_OAUTH_CODE_MAX_CHARS}}$`);
const calendarPath = (provider: CalendarOAuthProvider) => `/calendar/oauth/${provider}`;

const consentRefusals = {
  consent_declined: "Calendar access was declined.",
  admin_consent_required: "Your organization needs to approve calendar access.",
  consent_failed: "The provider could not approve calendar access.",
} as const;
type ConsentRefusal = keyof typeof consentRefusals;

function refused(reason: string, message: string, status = 400): ServiceError {
  const code = {
    account_mismatch: "forbidden",
    provider_off: "oauth_unconfigured",
    state_invalid: "oauth_state_invalid",
    state_expired: "oauth_state_expired",
    exchange_failed: "oauth_exchange_failed",
  } as const;
  return new ServiceError(Object.hasOwn(code, reason) ? code[reason as keyof typeof code] : "validation_failed", status, message, { reason });
}

export async function calendarOAuthClient(deps: ApiDeps, provider: CalendarOAuthProvider): Promise<CalendarOAuthClient | null> {
  const config = deps.services?.calendarOAuth;
  const way = deps.services?.calendarConnect?.ceremonies?.[provider];
  if (!config || !way?.on || !way.configured || !CALENDAR_CEREMONIES_BUILT[provider]) return null;
  const redirectUri = new URL(`${calendarPath(provider)}/callback`, config.origin).href;
  if (provider === "google") {
    if (!config.google?.clientId || !config.google.clientSecret) return null;
    return { ...config.google, redirectUri };
  }
  const resolved = await resolveOAuthProviderConfig({
    tx: deps.db,
    decrypt: (ct, kv) => deps.keyProvider.decrypt(ct, kv),
    bootstrap: deps.msOAuth,
  });
  return resolved.enabled ? { clientId: resolved.clientId, clientSecret: resolved.clientSecret, redirectUri } : null;
}

/** Give both the early checks and the final locked write the same browser result. */
async function withConnectionResult<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ServiceError && (error.code === "calendar_off" || error.code === "conflict")) {
      const message = error.code === "calendar_off" ? "Turn on your calendar before connecting." : error.message;
      throw new ServiceError(error.code, error.httpStatus, message, { ...error.details as object, reason: error.code });
    }
    throw error;
  }
}

async function requireClient(deps: ApiDeps, provider: CalendarOAuthProvider): Promise<CalendarOAuthClient> {
  const client = await calendarOAuthClient(deps, provider);
  if (!client) throw refused("provider_off", "This calendar provider is unavailable.", 503);
  return client;
}

/**
 * The provider returns without the host-only Strict session. Bounce to the app with only the
 * single-use inputs in its URL fragment, which the browser never sends to the app's web server.
 * The app strips those inputs and posts them through its signed-in, same-origin session.
 */
function bounce(deps: ApiDeps, params: URLSearchParams): Response {
  const target = new URL("/", deps.appOrigin ?? defaultOrigin(deps.authConfig));
  target.hash = `/cal/cal-setup?${params}`;
  return new Response(null, {
    status: 303,
    headers: {
      Location: target.href,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function classifyRefusal(provider: CalendarOAuthProvider, query: URLSearchParams, error: string): ConsentRefusal {
  if (error.length > CALENDAR_OAUTH_ERROR_MAX_CHARS) return "consent_failed";
  if (provider === "microsoft") {
    const description = query.get("error_description");
    const subcode = query.get("error_subcode");
    if ((description?.length ?? 0) > CALENDAR_OAUTH_ERROR_DESCRIPTION_MAX_CHARS ||
        (subcode?.length ?? 0) > CALENDAR_OAUTH_ERROR_MAX_CHARS) return "consent_failed";
    return classifyConsentFailure(error, description, subcode);
  }
  return error === "access_denied" ? "consent_declined" : "consent_failed";
}

export const calendarOAuthRoutes: Route[] = PROVIDERS.flatMap((provider): Route[] => [
  {
    method: "POST",
    pattern: `${calendarPath(provider)}/start`,
    relay: false,
    cost: "work",
    replay: "ephemeral",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      await withConnectionResult(() => requireCalendarConnectionRoom(ctx));
      const client = await requireClient(deps, provider);
      const state = oauthState(randomBytes);
      const pkce = pkcePair(randomBytes);
      let sealed;
      try {
        sealed = await deps.keyProvider.encrypt(pkce.verifier);
      } catch {
        throw refused("exchange_failed", "Calendar sign-in could not start. Try connecting again.", 503);
      }
      await withAccountTx(ctx, (tx) => createOAuthCeremony(tx as unknown as Tx, {
        state, accountId: ctx.accountId, provider, purpose: "calendar",
        codeVerifierEnc: sealed.ciphertext, codeVerifierKeyVersion: sealed.keyVersion, now: deps.now(),
      }));
      const authorizeUrl = calendarAuthorizeUrl(provider, client, state, pkce.challenge);
      return jsonResponse({ authorizeUrl }, { status: 201, headers: { "Cache-Control": "no-store" } });
    },
  },
  {
    method: "GET",
    pattern: `${calendarPath(provider)}/callback`,
    relay: false,
    cost: "unauthenticated",
    options: { public: true, raw: true, anonymous: true },
    handler: async (req, deps) => {
      const query = new URL(req.url).searchParams;
      const state = query.get("state") ?? "";
      const code = query.get("code") ?? "";
      const error = query.get("error");
      if (error) {
        const refusal = classifyRefusal(provider, query, error);
        if (!STATE.test(state)) return bounce(deps, new URLSearchParams({ oauth: refusal }));
        return bounce(deps, new URLSearchParams({ oauth: "pending", provider, state, refusal }));
      }
      if (!STATE.test(state) || !CODE.test(code)) return bounce(deps, new URLSearchParams({ oauth: "state_invalid" }));
      return bounce(deps, new URLSearchParams({ oauth: "pending", provider, state, code }));
    },
  },
  {
    method: "POST",
    pattern: `${calendarPath(provider)}/complete`,
    relay: false,
    cost: "work",
    replay: "guarded",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const body = await readBody<{ state?: unknown; code?: unknown; refusal?: unknown } | null>(req);
      const state = typeof body?.state === "string" ? body.state : "";
      const code = typeof body?.code === "string" ? body.code : "";
      const refusal = typeof body?.refusal === "string" && Object.hasOwn(consentRefusals, body.refusal)
        ? body.refusal as ConsentRefusal : null;
      const invalid = () => refused("state_invalid", "This calendar sign-in is no longer valid. Start again.");
      if (!STATE.test(state) || (refusal === null && !CODE.test(code))) throw invalid();

      const spent = await consumeCalendarOAuth(ctx, provider, state);
      if (spent.outcome === "unknown") throw invalid();
      if (spent.outcome === "wrong_account") {
        throw refused("account_mismatch", "This calendar sign-in was started by a different ohmail account.", 403);
      }
      if (spent.outcome === "expired") {
        throw refused("state_expired", "This calendar sign-in expired. Start again.");
      }
      if (refusal !== null) throw refused(refusal, consentRefusals[refusal]);

      await withConnectionResult(() => requireCalendarConnectionRoom(ctx));
      const client = await requireClient(deps, provider);
      let verifier: string;
      try {
        verifier = await deps.keyProvider.decrypt(spent.row.codeVerifierEnc, spent.row.codeVerifierKeyVersion);
      } catch {
        throw refused("exchange_failed", "Calendar sign-in could not finish. Try connecting again.", 503);
      }
      const signal = AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]);
      const fetchToken: FetchLike = deps.oauthFetch ?? ((url, init) => fetch(url, { ...init, redirect: "error", signal }));
      const signIn = await exchangeCalendarCode(provider, client, code, verifier, fetchToken, () => deps.now().getTime(), signal, deps.logger ?? silentLogger);
      const connectionId = randomUUID();
      const { seq } = await withConnectionResult(() => keepCalendarConnection(
        ctx, deps.keyProvider, { id: connectionId, provider, serverUrl: null, sourceHost: null },
        signIn,
      ));
      return jsonResponse({ connectionId }, { status: 201, seq, headers: { "Cache-Control": "no-store" } });
    },
  },
]);
