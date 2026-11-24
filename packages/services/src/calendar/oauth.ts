import { exchangeGoogleCode, googleAuthorizeUrl } from "@ohmail/cal-providers/google";
import { MS_GRAPH_CALENDAR_SCOPE } from "@ohmail/cal-providers/microsoft";
import { Secret, type StoredCredential } from "@ohmail/cal-providers/connect";
import {
  buildMicrosoftAuthorizeUrl, exchangeAuthorizationCode, OAuthExchangeFailedError, OAuthProviderUnavailableError,
  type FetchLike, type Logger,
} from "@trafficflow/core";
import { consumeOAuthCeremony } from "@trafficflow/db/cloud";
import { bridgeTx, keyedCredentialDb, type ServiceContext } from "../context.js";
import { ServiceError } from "../errors.js";

export type CalendarOAuthProvider = "google" | "microsoft";
export interface CalendarOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

const MICROSOFT_SCOPES = MS_GRAPH_CALENDAR_SCOPE.split(" ");
const MICROSOFT_TENANT = "common";
const MICROSOFT_CALENDAR_PERMISSION = "Calendars.ReadWrite";
const OAUTH_ERRORS = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope",
  "access_denied", "interaction_required", "temporarily_unavailable", "server_error",
]);

export function consumeCalendarOAuth(ctx: ServiceContext, provider: CalendarOAuthProvider, state: string) {
  return consumeOAuthCeremony(bridgeTx(keyedCredentialDb(ctx, state)), {
    state, now: ctx.now(), scope: { accountId: ctx.accountId, provider, purpose: "calendar" },
  });
}

export function calendarAuthorizeUrl(
  provider: CalendarOAuthProvider, client: CalendarOAuthClient, state: string, codeChallenge: string,
): string {
  const params = { clientId: client.clientId, redirectUri: client.redirectUri, state, codeChallenge };
  return provider === "google" ? googleAuthorizeUrl(params)
    : buildMicrosoftAuthorizeUrl({ ...params, tenant: MICROSOFT_TENANT, scopes: MICROSOFT_SCOPES });
}

/** The refresh credential alone leaves the trade. Provider and transport exceptions stay here. */
export async function exchangeCalendarCode(
  provider: CalendarOAuthProvider, client: CalendarOAuthClient, code: string, codeVerifier: string,
  fetchToken: FetchLike, now: () => number, signal: AbortSignal, log: Logger,
): Promise<{ credential: StoredCredential; meta?: { tenant: string; clientKind: "confidential" } }> {
  const params = { code, codeVerifier, redirectUri: client.redirectUri };
  let diagnostic: string;
  try {
    if (provider === "google") {
      const grant = await exchangeGoogleCode({
        clock: { now },
        http: {
          async request(url, init) {
            const response = await fetchToken(url, { method: init.method, headers: { ...init.headers }, body: init.body ?? "" });
            return {
              arrived: true, status: response.status, header: () => null, location: null, url, hops: 0,
              body: new TextEncoder().encode(await response.text()),
            };
          },
        },
      }, { ...params, client: { id: client.clientId, secret: new Secret(client.clientSecret) } }, signal);
      if (grant.ok) return { credential: { kind: "oauth", provider, refreshToken: grant.value.refreshToken } };
      diagnostic = grant.missingPermissions ? "missing_permissions" : grant.reason;
    } else {
      const grant = await exchangeAuthorizationCode({
        ...client, ...params, tenant: MICROSOFT_TENANT, scopes: MICROSOFT_SCOPES, fetch: fetchToken,
      }, now);
      const scope = grant.scope?.split(/\s+/);
      if (scope && !scope.some((word) => word === MICROSOFT_CALENDAR_PERMISSION || word === `https://graph.microsoft.com/${MICROSOFT_CALENDAR_PERMISSION}`)) {
        diagnostic = "missing_permissions";
      } else if (grant.refreshToken !== null) {
        return {
          credential: { kind: "oauth", provider, refreshToken: new Secret(grant.refreshToken) },
          meta: { tenant: MICROSOFT_TENANT, clientKind: "confidential" },
        };
      } else {
        diagnostic = "sign_in_incomplete";
      }
    }
  } catch (error) {
    if (error instanceof OAuthExchangeFailedError) {
      diagnostic = OAUTH_ERRORS.has(error.oauthError) ? error.oauthError : "unknown_error";
    } else {
      diagnostic = error instanceof OAuthProviderUnavailableError || provider === "google" ? "unavailable" : "unknown_error";
    }
  }
  // Provider bodies, exceptions, codes and credentials can carry secrets. The word above is closed.
  log.warn("calendar_oauth_exchange_failed", { code: diagnostic });
  if (diagnostic === "missing_permissions") {
    throw new ServiceError("oauth_exchange_failed", 400,
      "Allow all requested calendar permissions and try again.", { reason: "missing_permissions" });
  }
  if (diagnostic === "unavailable" || diagnostic === "temporarily_unavailable" || diagnostic === "server_error") {
    throw new ServiceError("upstream_unavailable", 503,
      "The calendar provider could not be reached. Try again in a moment.", { reason: "provider_unavailable" }, false);
  }
  throw new ServiceError("oauth_exchange_failed", 502, "The provider could not finish signing in. Try connecting again.", { reason: "exchange_failed" }, false);
}
