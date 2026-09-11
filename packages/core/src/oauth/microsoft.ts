// Microsoft identity platform — the OAuth2 refresh-token client for Exchange Online IMAP+SMTP. In
// CORE: the always-on worker depends on core + db only, and it mints access tokens to open IMAP.
// It speaks the refresh_token grant against the tenant token endpoint and nothing else. Two
// invariants: (1) THE ENDPOINT IS DERIVED, NEVER STORED — a stored token URL is a one-PATCH
// refresh-token exfil channel: flip the host in a mailbox row and every refresh POSTs the secret
// to the attacker; the host is a constant and only the tenant SEGMENT comes from data, validated
// against a closed shape. (2) A MICROSOFT OUTAGE IS NOT A BAD CREDENTIAL — `invalid_grant` is the
// ONLY auth verdict; a 5xx, a network failure or a timeout is non-auth, or every oauth mailbox in
// the fleet would quarantine as "bad credentials" the instant Microsoft has a bad minute.
import { createHash } from "node:crypto";
import type { KeyProvider } from "../crypto.js";
import type { AccessTokenFetcherFactory, OAuthTokenProvider } from "../adapters/imap-auth.js";
/* Re-exported so every consumer of the root barrel keeps its import. The port itself moved to
 * `adapters/imap-auth.js` — the auth-assembly seam every host compiles — so a host built from the
 * mail half alone can name its token source without reaching this module, which carries the
 * Microsoft implementation. */
export type { OAuthTokenProvider } from "../adapters/imap-auth.js";

/** `fetch`, narrowed to what this client uses, so a test can inject a fake token endpoint. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * THE TOKEN IS DEAD — the user must re-consent. The one auth verdict this client emits.
 *
 * `code` is `OAUTH_INVALID_GRANT`: the worker's classifier maps it to `error_code='auth'` and
 * `mailboxErrorDetail` stores it verbatim (it is on the allowlist), so Settings can say "reconnect
 * this mailbox" rather than the generic "the mailbox rejected the password".
 */
export class OAuthReauthRequiredError extends Error {
  readonly code = "OAUTH_INVALID_GRANT";
  constructor(public readonly aadsts: string | null = null) {
    super("the OAuth refresh token is no longer valid; the mailbox must be reconnected");
    this.name = "OAuthReauthRequiredError";
  }
}

/**
 * WE COULD NOT ASK MICROSOFT — a 5xx, a dropped connection, a timeout at the token endpoint. NOT an
 * auth failure. `code` classifies to `connect` in the worker, deliberately: it means "retry later",
 * the same posture a mail server that will not serve us right now gets, and it NEVER writes a
 * mailbox off as bad credentials.
 */
export class OAuthProviderUnavailableError extends Error {
  readonly code = "OAUTH_TOKEN_ENDPOINT_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "OAuthProviderUnavailableError";
  }
}

/**
 * THIS DEPLOYMENT IS MISCONFIGURED — a missing client secret, an unusable tenant. A NAMED refusal,
 * thrown at the moment a token is actually needed (i.e. only for an oauth mailbox), so a worker with
 * no `MS_OAUTH_CLIENT_SECRET` fails with a class an operator can read instead of a flake-shaped
 * retry loop. Not `invalid_grant`: the credential is fine, the environment is not.
 */
export class OAuthConfigError extends Error {
  readonly code = "OAUTH_CONFIG_MISSING";
  constructor(public readonly configVar: string, message: string) {
    super(message);
    this.name = "OAuthConfigError";
  }
}

/**
 * Which kind of application registration is asking — the seam the three doors differ on. Managed
 * cloud: CONFIDENTIAL. Desktop: PUBLIC — a secret shipped in a binary is not a secret; PKCE
 * authenticates instead. Self-host shared client: the same public registration via the
 * device-code flow. Explicit, not inferred from an empty secret: `"" means public` fails in the
 * costliest direction — a confidential deployment whose secret failed to resolve would silently
 * emit a PUBLIC request; Entra answers `invalid_client`, mapped to a provider outage, so the
 * fleet stops refreshing and nothing quarantines. With the kind stated, that deployment gets
 * {@link OAuthConfigError} naming `MS_OAUTH_CLIENT_SECRET` — actionable.
 */
export type MicrosoftClientKind = "confidential" | "public";

/**
 * Which environment variable carries each door's client id — one map, because the refusals name
 * it. The two registrations are different applications and cannot be one (a secret shipped in a
 * downloadable binary is not a secret), so a deployment may hold either, both or neither. What
 * makes the split useful is that every refusal quotes the variable for the door actually being
 * asked for: an operator whose device-code mailbox cannot refresh must be sent to
 * `MS_DEVICE_CLIENT_ID` and not to `MS_OAUTH_CLIENT_ID`, which on their install is very likely
 * set, valid, and irrelevant. `MS_DEVICE_CLIENT_ID` has no legacy aliases: it is new, so one name
 * is one name.
 */
export const MS_CLIENT_ID_ENV: Readonly<Record<MicrosoftClientKind, string>> = {
  confidential: "MS_OAUTH_CLIENT_ID",
  public: "MS_DEVICE_CLIENT_ID",
};

/**
 * Read a stored `clientKind` as a door, fail-safe. The value arrives from a jsonb column, so it
 * could be anything: only the exact string `"public"` selects the public door; absent, misspelt
 * or unknown all read as `"confidential"` — the door every token stored before the device flow
 * came through, the answer that keeps an existing fleet working. The failure direction is the
 * safe one: a confidential mailbox misread as public would drop its secret and be refused by
 * Entra; a device mailbox misread as confidential is refused by the kind check with a named
 * variable, before any request. Neither silently succeeds.
 */
export function wantedClientKind(clientKind: string | undefined): MicrosoftClientKind {
  return clientKind === "public" ? "public" : "confidential";
}

/**
 * The client-authentication fields of a token request, for one kind of registration.
 *
 * ONE function, called by the exchange, the refresh and the device flow, so "does a public client
 * send a secret" has exactly one answer in this package. The public arm OMITS `client_secret`
 * entirely rather than sending an empty one: an empty value is a present-but-blank credential to
 * Entra, not an absent one.
 *
 * Both refusals are {@link OAuthConfigError} — the environment is wrong, the credential is not.
 */
export function clientAuthFields(
  kind: MicrosoftClientKind, clientId: string, clientSecret: string | undefined,
): Record<string, string> {
  const secret = (clientSecret ?? "").trim();
  if (kind === "public") {
    if (secret) {
      // A caller that supplied a secret for a public registration has mixed the doors up. Refusing
      // is not pedantry: it would otherwise send this deployment's confidential secret to a token
      // request the public client id cannot authenticate, and learn nothing from the rejection.
      throw new OAuthConfigError(
        "MS_OAUTH_CLIENT_SECRET",
        "a public Microsoft client must not send a client secret",
      );
    }
    return { client_id: clientId };
  }
  if (!secret) {
    throw new OAuthConfigError(
      MS_OAUTH_CLIENT_SECRET_VAR,
      `OAuth mailbox requires ${MS_OAUTH_CLIENT_SECRET_VAR}, which is not set`,
    );
  }
  return { client_id: clientId, client_secret: secret };
}

/**
 * The env variable name the secret refusal quotes. A constant because three sites print it and an
 * operator searching for the string has to find the same one everywhere — `packages/db`'s
 * `MS_OAUTH_ENV.clientSecret` is the other half of the pair.
 */
export const MS_OAUTH_CLIENT_SECRET_VAR = "MS_OAUTH_CLIENT_SECRET";

/**
 * The tenant segment may only be one of the reserved authorities or a GUID. Validated BEFORE
 * interpolation — see the header's first invariant. Anything else is a config error, never a
 * silent string in a URL.
 */
export const MS_TENANT_RE = /^(common|organizations|consumers)$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Default IMAP+SMTP scopes for Exchange Online; `offline_access` is what returns a refresh token.
 * The scope host is `outlook.office.com` and the IMAP host is `outlook.office365.com` — they look
 * like the same name typed twice and are NOT: the scope is a RESOURCE IDENTIFIER Entra matches
 * byte-for-byte against the registration's delegated permissions (Microsoft's canonical spelling
 * is `outlook.office.com`); `outlook.office365.com:993` is a HOSTNAME the IMAP client dials, not
 * part of any scope — rewriting either to match the other breaks its own half. A mismatched scope
 * host fails at the CONSENT SCREEN, before any code exists, presenting as "the application is
 * misconfigured" with no clue which string is wrong.
 */
export const MS_MAIL_SCOPE =
  "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access";

/**
 * The OIDC scopes the AUTHORIZE request adds, and they are not decoration. The callback learns
 * the mailbox address from the `id_token`'s `preferred_username`/`email` claim — the user never
 * types it. No `openid` means no `id_token` at all; no `email` means the claim may be absent from
 * the one issued. Either way the ceremony completes, the tokens are valid, and there is no
 * address to store: a failure that looks like a Microsoft problem and is a scope list one line
 * long. NOT in {@link MS_MAIL_SCOPE}, because that constant is also what the REFRESH grant asks
 * for, and a refresh has no identity to establish.
 */
export const MS_OIDC_SCOPES: readonly string[] = ["openid", "email"];

/**
 * What the authorize URL asks for: identity + mail + `offline_access`, in that order.
 *
 * Derived from the two constants above so the mail scopes cannot be stated twice and drift. The
 * config store's own default (`MS_DEFAULT_SCOPES`, `packages/db/src/oauth-config.ts`) is asserted
 * equal to this by a test rather than importing it — `packages/db` does not depend on this package.
 */
export const MS_AUTHORIZE_SCOPES: readonly string[] =
  [...MS_OIDC_SCOPES, ...MS_MAIL_SCOPE.split(" ")];

/**
 * The token endpoint for a tenant. Throws {@link OAuthConfigError} on a tenant that fails
 * {@link MS_TENANT_RE} — the derivation cannot proceed on an unvalidated segment.
 */
export function microsoftTokenEndpoint(tenant: string): string {
  const t = (tenant ?? "").trim();
  if (!MS_TENANT_RE.test(t)) {
    throw new OAuthConfigError("MS_OAUTH_TENANT", `invalid Microsoft tenant segment (got ${t.length} chars)`);
  }
  return `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`;
}

/**
 * The AUTHORIZE endpoint for a tenant — the URL a browser is sent to. Same derivation and
 * validation as {@link microsoftTokenEndpoint}, and a separate function rather than a string
 * built at the call site for the derivation invariant's reason: the host is a constant in this
 * file and the tenant SEGMENT is the only thing that comes from data — a caller assembling this
 * URL itself would be a second place a stored value could become a host. Less dangerous than the
 * token endpoint (no secret is POSTed), but a redirect to an attacker's host is a credible phish
 * of the user's Microsoft password, so it is held to the same rule.
 */
export function microsoftAuthorizeEndpoint(tenant: string): string {
  const t = (tenant ?? "").trim();
  if (!MS_TENANT_RE.test(t)) {
    throw new OAuthConfigError("MS_OAUTH_TENANT", `invalid Microsoft tenant segment (got ${t.length} chars)`);
  }
  return `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`;
}

/** A PKCE pair: the verifier this service keeps and the S256 challenge it publishes. */
export interface PkcePair {
  /** 43 base64url characters — RFC 7636's minimum, from 32 bytes of CSPRNG. Kept server-side. */
  verifier: string;
  /** `base64url(sha256(verifier))`. Public: it goes in the authorize URL. */
  challenge: string;
  /** Always `"S256"`. `"plain"` is not generated here and never will be. */
  method: "S256";
}

/**
 * base64url of a buffer — no padding, URL-safe. Node's own `base64url` encoding, named here so the
 * three call sites below cannot drift into `base64` (whose `+`, `/` and `=` would be re-encoded by
 * every URL builder that touches them, silently changing the value Microsoft compares).
 */
const b64u = (b: Buffer): string => b.toString("base64url");

/**
 * Mint a PKCE pair. S256 ONLY: RFC 7636 permits `plain`, and `plain` in a redirect flow is no
 * protection at all — the challenge and the verifier are the same string, so anyone who can read
 * the authorize URL can complete the exchange. There is no parameter to select it. PKCE is here
 * even though this is a CONFIDENTIAL client that also sends a secret: the authorization code
 * travels through the user's browser and Microsoft's redirect, the one leg this service cannot
 * see, and PKCE makes a code captured there useless without the verifier, which never leaves the
 * server.
 */
export function pkcePair(randomBytes: (n: number) => Buffer): PkcePair {
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/**
 * A 256-bit `state`. The redirect's CSRF token (RFC 6749 §10.12) and, here, the primary key of the
 * ceremony row it names — so it is also the value two concurrent replays contend on.
 */
export function oauthState(randomBytes: (n: number) => Buffer): string {
  return b64u(randomBytes(32));
}

export interface AuthorizeUrlParams {
  tenant: string;
  clientId: string;
  /** EXACTLY the URI the token exchange will replay. Microsoft compares the two byte-for-byte. */
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  /**
   * The address to preselect at the consent screen. A CONVENIENCE and never a constraint: the
   * mailbox this ceremony ends up writing is decided by the `id_token` claim, so a user who ignores
   * the hint and signs in as somebody else gets that other mailbox, not this one silently repointed.
   */
  loginHint?: string;
}

/**
 * The URL the browser is sent to. `prompt=select_account` rather than the default, deliberately:
 * the default reuses whatever session the browser already has at Microsoft, which on a shared
 * machine — or for somebody with a work and a personal account — silently connects the wrong
 * mailbox; the address is taken from the token, so "silently" is exact. Being asked which account
 * IS the point of the screen. `response_mode` stays at its default (`query`) so the callback
 * reads a GET's query string: `fragment` would put the parameters where no server can see them,
 * and `form_post` would make the callback a cross-site POST by construction.
 */
export function buildMicrosoftAuthorizeUrl(p: AuthorizeUrlParams): string {
  const url = new URL(microsoftAuthorizeEndpoint(p.tenant));
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", p.scopes.join(" "));
  url.searchParams.set("state", p.state);
  url.searchParams.set("code_challenge", p.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  if (p.loginHint) url.searchParams.set("login_hint", p.loginHint);
  return url.toString();
}

export interface ExchangeParams {
  code: string;
  codeVerifier: string;
  /** The SAME value that was sent to `/authorize`. Microsoft rejects a mismatch. */
  redirectUri: string;
  tenant: string;
  clientId: string;
  /** Required for `clientKind: "confidential"`; MUST be absent for `"public"`. */
  clientSecret?: string;
  /**
   * Which registration is redeeming the code. Defaults to `"confidential"` — the managed cloud
   * door, which is every caller that existed before the desktop one — so an omitted kind can never
   * silently become a public request. See {@link MicrosoftClientKind}.
   */
  clientKind?: MicrosoftClientKind;
  scopes?: readonly string[];
  fetch: FetchLike;
}

export interface ExchangeResult {
  accessToken: string;
  /**
   * THE THING THIS WHOLE FLOW EXISTS TO OBTAIN. Absent ⇒ the grant returned no long-lived
   * credential, which for this application means `offline_access` was not in the granted scopes —
   * a configuration fault, not a mailbox that can be stored. The caller refuses.
   */
  refreshToken: string | null;
  expiresAtMs: number;
  /** The OIDC identity token, raw. {@link addressFromIdToken} is the only reader. */
  idToken: string | null;
}

/**
 * Redeem an authorization code for tokens — the confidential-client half of the ceremony. The
 * error mapping is deliberately NOT {@link refreshAccessToken}'s: there, `invalid_grant` means a
 * stored credential is dead — a durable verdict about a row. Here there is no stored row: it
 * means the code was already redeemed, expired, or the verifier did not match — THIS ATTEMPT
 * failed, nothing to quarantine. So it raises {@link OAuthExchangeFailedError}, never the re-auth
 * verdict, which with no mailbox would land `error_code='auth'` on whatever the caller was
 * holding. `invalid_client` — OUR secret is wrong — is carried in `reason`, so the callback
 * blames the deployment's credentials, not the person who clicked.
 */
export async function exchangeAuthorizationCode(
  p: ExchangeParams, now: () => number = Date.now,
): Promise<ExchangeResult> {
  const endpoint = microsoftTokenEndpoint(p.tenant);
  const form = new URLSearchParams({
    ...clientAuthFields(p.clientKind ?? "confidential", p.clientId, p.clientSecret),
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier,
    scope: (p.scopes ?? MS_MAIL_SCOPE.split(" ")).join(" "),
  }).toString();

  const startedAt = now();
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await p.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form,
    });
  } catch (err) {
    throw new OAuthProviderUnavailableError(`token endpoint unreachable: ${(err as Error)?.name ?? "error"}`);
  }

  if (res.status >= 500) throw new OAuthProviderUnavailableError(`token endpoint returned ${res.status}`);

  if (!res.ok) {
    let body: TokenError = {};
    try { body = (await res.json()) as TokenError; } catch { /* unparseable 4xx */ }
    const error = typeof body.error === "string" ? body.error : "unknown_error";
    // The DESCRIPTION is never propagated: Microsoft puts request ids, timestamps and occasionally
    // the redirect URI in it, and this string reaches a redirect the browser follows. The `error`
    // code is a closed OAuth2 vocabulary and is safe.
    throw new OAuthExchangeFailedError(error, res.status);
  }

  let ok: TokenSuccess & { refresh_token?: unknown; id_token?: unknown };
  try { ok = (await res.json()) as TokenSuccess & { refresh_token?: unknown; id_token?: unknown }; } catch {
    throw new OAuthProviderUnavailableError("token endpoint returned an unparseable success body");
  }
  const accessToken = typeof ok.access_token === "string" ? ok.access_token : "";
  if (!accessToken) throw new OAuthProviderUnavailableError("token endpoint returned no access_token");
  const expiresInSec = typeof ok.expires_in === "number" ? ok.expires_in : 3600;
  return {
    accessToken,
    refreshToken: typeof ok.refresh_token === "string" && ok.refresh_token.length > 0 ? ok.refresh_token : null,
    expiresAtMs: startedAt + expiresInSec * 1000,
    idToken: typeof ok.id_token === "string" && ok.id_token.length > 0 ? ok.id_token : null,
  };
}

/**
 * THE CODE EXCHANGE FAILED. A verdict about THIS ATTEMPT and never about a stored credential — see
 * {@link exchangeAuthorizationCode}. `code` is a stable constant; `oauthError` is Microsoft's own
 * closed-vocabulary `error` value (`invalid_grant`, `invalid_client`, `unauthorized_client`, …).
 */
export class OAuthExchangeFailedError extends Error {
  readonly code = "OAUTH_EXCHANGE_FAILED";
  constructor(public readonly oauthError: string, public readonly httpStatus: number) {
    super(`the authorization code could not be redeemed (${oauthError})`);
    this.name = "OAuthExchangeFailedError";
  }
}

/**
 * The mailbox address, from the `id_token`. The user never types it. The signature is NOT
 * verified, and that is sound: the token came back in the BODY of a TLS response to a POST this
 * process made to a URL it derived itself — no untrusted party on that leg, the case OpenID
 * Connect Core §3.1.3.7 names. Parsed and NOT trusted beyond the address: no `iss`, `aud`, role
 * or entitlement is read — the account comes from the SESSION and the ceremony row, which the
 * callback asserts agree; if that changes, the verification must be written. `preferred_username`
 * first (the UPN, what the IMAP server authenticates as), `email` second, `upn` last; `sub` is
 * NOT a fallback — an opaque pairwise identifier is not an address.
 */
export function addressFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const key of ["preferred_username", "email", "upn"] as const) {
    const v = claims[key];
    // An address, not merely a string: `preferred_username` on some account types is a display name
    // or a phone number, and either would be stored as an address nothing can log in with.
    if (typeof v === "string" && v.includes("@") && !/\s/.test(v)) return v.trim();
  }
  return null;
}

/**
 * WHAT WENT WRONG AT THE CONSENT SCREEN — the closed taxonomy the callback puts on the redirect it
 * sends the browser to, and the webapp renders copy for.
 *
 * A CODE and never a sentence, for the reason `mailbox-errors.ts` gives about the sync failures:
 * one vocabulary, one set of translated sentences, and `error_description` is Microsoft's own prose
 * carrying request ids and timestamps that must not end up in a URL a user can share.
 */
export type ConsentFailure =
  /**
   * AN ADMINISTRATOR MUST APPROVE THIS APPLICATION.
   *
   * Two causes land here and they are DELIBERATELY not split: the application has never been
   * consented for the tenant (`AADSTS65001`), and the tenant has switched user consent OFF so no
   * individual can grant it (which Microsoft signals with the SAME `AADSTS65001` behind an
   * `access_denied`). We cannot reliably tell them apart from the callback parameters, the remedy is
   * identical — an admin grants consent for the organisation — and inventing a distinction would be
   * a confidently wrong sentence rather than a vague true one. The copy names both causes.
   */
  | "admin_consent_required"
  /** The person said no, or closed the screen. Not a fault, and not something to retry silently. */
  | "consent_declined"
  /** Anything else the authorize endpoint reported. The copy says we could not complete it. */
  | "consent_failed";

/**
 * Classify the authorize endpoint's error redirect.
 *
 * THE ORDER IS THE FINDING, and it is the same shape as `verdictFor`'s: the admin-consent codes are
 * tested BEFORE `access_denied`, because a tenant that restricts user consent sends BOTH — an
 * `error=access_denied` carrying `AADSTS65001` in the description. Testing `access_denied` first
 * would tell every user in such a tenant that they declined a screen they were never allowed to
 * accept, which is a confident lie about their own action.
 */
export function classifyConsentFailure(
  error: string | null, errorDescription: string | null, errorSubcode?: string | null,
): ConsentFailure {
  const e = (error ?? "").trim().toLowerCase();
  const d = errorDescription ?? "";
  // `AADSTS90094` — "the grant requires admin permission" — is the same remedy and joins the same arm.
  if (d.includes("AADSTS65001") || d.includes("AADSTS90094") || e === "consent_required") {
    return "admin_consent_required";
  }
  // `AADSTS65004` is "user declined to consent"; `error_subcode=cancel` is the closed-the-window
  // variant. Both are the person's own decision.
  if (d.includes("AADSTS65004") || e === "access_denied" || (errorSubcode ?? "").trim() === "cancel") {
    return "consent_declined";
  }
  return "consent_failed";
}

export interface RefreshParams {
  refreshToken: string;
  tenant: string;
  clientId: string;
  /** Required for `clientKind: "confidential"`; MUST be absent for `"public"`. */
  clientSecret?: string;
  /**
   * Which registration holds this grant. Defaults to `"confidential"`.
   *
   * It must match the door the refresh token was ISSUED through: a token minted by the desktop's
   * public client cannot be refreshed with the managed deployment's secret, and vice versa. Entra
   * answers a mismatch with `invalid_client`, which this function maps to
   * {@link OAuthProviderUnavailableError} rather than to a dead credential — correct, and silent.
   * The kind therefore travels with the stored credential, not with the process.
   */
  clientKind?: MicrosoftClientKind;
  scope?: string;
  fetch: FetchLike;
}

export interface RefreshResult {
  accessToken: string;
  /** Absolute expiry, ms since epoch, computed from `expires_in` at the moment of the response. */
  expiresAtMs: number;
  /** Present ONLY when Microsoft rotated it; the caller re-encrypts and persists (see the provider). */
  refreshToken?: string;
}

interface TokenSuccess { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown }
interface TokenError { error?: unknown; error_description?: unknown }

/** AADSTS codes that mean the same thing as `invalid_grant`: the token needs a fresh interactive consent. */
const REAUTH_AADSTS = ["AADSTS700082", "AADSTS70000", "AADSTS50076"];

/**
 * POST the refresh_token grant and return a fresh access token. Pure over its injected `fetch`.
 *
 * Error mapping is the security-load-bearing part (see the header's second invariant):
 *   · `fetch` rejects (network/DNS/socket)      → {@link OAuthProviderUnavailableError}
 *   · HTTP 5xx                                   → {@link OAuthProviderUnavailableError}
 *   · HTTP 4xx, body `error:"invalid_grant"` or a re-auth AADSTS code → {@link OAuthReauthRequiredError}
 *   · any other non-2xx                          → {@link OAuthProviderUnavailableError} (never auth)
 *   · 2xx without an `access_token`              → {@link OAuthProviderUnavailableError}
 */
export async function refreshAccessToken(p: RefreshParams, now: () => number = Date.now): Promise<RefreshResult> {
  const endpoint = microsoftTokenEndpoint(p.tenant);
  const form = new URLSearchParams({
    ...clientAuthFields(p.clientKind ?? "confidential", p.clientId, p.clientSecret),
    grant_type: "refresh_token",
    refresh_token: p.refreshToken,
    scope: p.scope ?? MS_MAIL_SCOPE,
  }).toString();

  const startedAt = now();
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await p.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form,
    });
  } catch (err) {
    // A thrown fetch is the network arm. It carries no server verdict, so it CANNOT be auth.
    throw new OAuthProviderUnavailableError(`token endpoint unreachable: ${(err as Error)?.name ?? "error"}`);
  }

  if (res.status >= 500) {
    throw new OAuthProviderUnavailableError(`token endpoint returned ${res.status}`);
  }

  if (!res.ok) {
    // A 4xx carries a verdict. Parse it defensively; a body we cannot read is treated as unavailable,
    // never as auth — the safe direction is "retry later", not "quarantine as bad credentials".
    let body: TokenError = {};
    try { body = (await res.json()) as TokenError; } catch { /* unparseable 4xx */ }
    const error = typeof body.error === "string" ? body.error : "";
    const desc = typeof body.error_description === "string" ? body.error_description : "";
    if (error === "invalid_grant" || REAUTH_AADSTS.some((c) => desc.includes(c))) {
      throw new OAuthReauthRequiredError(REAUTH_AADSTS.find((c) => desc.includes(c)) ?? null);
    }
    // invalid_client (our secret is wrong), unauthorized_client, an unrecognised 4xx: our problem or
    // Microsoft's, but not the mailbox's credential. Non-auth so the fleet is never blamed.
    throw new OAuthProviderUnavailableError(`token endpoint rejected the grant (${res.status})`);
  }

  let ok: TokenSuccess;
  try { ok = (await res.json()) as TokenSuccess; } catch {
    throw new OAuthProviderUnavailableError("token endpoint returned an unparseable success body");
  }
  const accessToken = typeof ok.access_token === "string" ? ok.access_token : "";
  if (!accessToken) {
    throw new OAuthProviderUnavailableError("token endpoint returned no access_token");
  }
  const expiresInSec = typeof ok.expires_in === "number" ? ok.expires_in : 3600;
  const rotated = typeof ok.refresh_token === "string" && ok.refresh_token.length > 0
    ? ok.refresh_token : undefined;
  return {
    accessToken,
    expiresAtMs: startedAt + expiresInSec * 1000,
    ...(rotated ? { refreshToken: rotated } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PROVIDER — caching + rotation persistence, shared by both hosts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one-method port a host injects so a ROTATED refresh token is persisted. It receives the
 * already-encrypted envelope — the provider re-encrypts with the host's KeyProvider — so this stays
 * a pure DB write with no key material of its own.
 */
export type UpdateSecretPort = (mailboxId: string, ciphertextEnc: string, keyVersion: number) => Promise<void>;

/** The application registration, as the provider needs it at the moment it mints a token. */
export interface MicrosoftClientCredentials {
  clientId: string;
  /** Empty for a `"public"` registration, which has none. */
  clientSecret: string;
  /** Used when the MAILBOX row carries no tenant of its own. */
  defaultTenant?: string;
  /**
   * Which door this deployment refreshes through. Defaults to `"confidential"` — the managed cloud
   * — so a host that says nothing keeps the behaviour it had. The desktop and the self-host
   * device-code install set `"public"`. See {@link MicrosoftClientKind}.
   */
  kind?: MicrosoftClientKind;
}

/** What a host wires once per process (worker) or once per invocation (API). */
export interface MicrosoftOAuthRuntime {
  /** `MS_OAUTH_CLIENT_ID`. Empty ⇒ a token request is a {@link OAuthConfigError}. */
  clientId: string;
  /** `MS_OAUTH_CLIENT_SECRET`. Empty ⇒ the NAMED refusal, not a retry loop — unless `kind` is `"public"`. */
  clientSecret: string;
  /** `MS_OAUTH_TENANT` fallback when a row carries none. */
  defaultTenant?: string;
  /**
   * Which door this HOST refreshes through, when `resolveClient` is not wired. Defaults to
   * `"confidential"`. A `resolveClient` that returns its own `kind` wins, exactly as it does for
   * the id and the secret.
   */
  kind?: MicrosoftClientKind;
  /**
   * Resolve the registration at TOKEN TIME, not construction; when present it wins over the
   * static fields, which stay as the fallback. Not a constructor argument: the point of the
   * database row is rotating an expiring Entra secret WITHOUT redeploying — the worker builds
   * this provider once at boot and lives for weeks, so a construction-time read is frozen at the
   * last deploy and the console's save would appear to work while every refresh used the dead
   * secret. Called only inside the refresh margin — at most once per mailbox per ~55 minutes — so
   * there is deliberately NO cache in front of it. Asked for a DOOR, it answers about that door;
   * a host that cannot serve it returns an empty `clientId`, never the other door's credentials.
   */
  resolveClient?: (want: MicrosoftClientKind) => Promise<MicrosoftClientCredentials>;
  keyProvider: KeyProvider;
  updateSecret: UpdateSecretPort;
  fetch: FetchLike;
  now?: () => number;
  /** Refresh when the cached token is within this of expiry. Default 5 min. */
  refreshMarginMs?: number;
  /** Clock-skew allowance added to the margin. Default 120 s. */
  skewMs?: number;
}

const DEFAULT_REFRESH_MARGIN_MS = 5 * 60_000;
const DEFAULT_SKEW_MS = 120_000;

/**
 * Mints and caches Microsoft access tokens, and persists a rotated refresh token. The cache is
 * keyed by mailbox id; a cached token is reused only while it has more than `refreshMargin +
 * skew` of life left. On the worker the instance lives for the process, so the cache spans
 * reconnects for one mailbox; on the API a fresh instance per invocation makes it per-request,
 * which is all a serverless send needs. No mid-session re-auth is implied: a live IMAP session is
 * not driven from here, and `connect()` calls the fetcher exactly once per dial — the cache only
 * spares a redundant token POST when the same provider is asked again.
 */
export class MicrosoftTokenProvider implements OAuthTokenProvider {
  private readonly cache = new Map<string, { accessToken: string; expiresAtMs: number }>();
  constructor(private readonly rt: MicrosoftOAuthRuntime) {}

  forMailbox(mailboxId: string): AccessTokenFetcherFactory {
    return ({ refreshToken, tenant, provider, clientKind }) => {
      if (provider !== "microsoft") {
        // Should never happen — buildImapAuth already gated the provider — but a factory that
        // silently accepted a foreign provider would be a hole waiting for a caller that skips it.
        throw new OAuthConfigError("provider", `MicrosoftTokenProvider cannot serve provider ${provider}`);
      }
      return () => this.accessToken(mailboxId, refreshToken, tenant, wantedClientKind(clientKind));
    };
  }

  private async accessToken(
    mailboxId: string, refreshToken: string, tenant: string,
    /**
     * The door the MAILBOX's token came through. Defaults to `"confidential"` at
     * {@link wantedClientKind}, so every mailbox stored before the device flow existed keeps
     * refreshing through exactly the registration that issued it.
     */
    want: MicrosoftClientKind = "confidential",
  ): Promise<string> {
    // THE CACHE IS CHECKED BEFORE THE REGISTRATION IS RESOLVED, and that order is deliberate: a live
    // access token is good regardless of what the console has since been edited to say, and resolving
    // first would put a query in front of every dial rather than in front of every REFRESH.
    const now = (this.rt.now ?? Date.now)();
    const margin = (this.rt.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS) + (this.rt.skewMs ?? DEFAULT_SKEW_MS);
    const cached = this.cache.get(mailboxId);
    if (cached && cached.expiresAtMs - now > margin) return cached.accessToken;

    // The resolver WINS over the static fields when one is wired — see `resolveClient`. It is told
    // WHICH DOOR the mailbox's token came through; the static fallback cannot select, so a host with
    // no resolver serves whatever single registration it was constructed with.
    const client: MicrosoftClientCredentials = this.rt.resolveClient
      ? await this.rt.resolveClient(want)
      : {
        clientId: this.rt.clientId,
        clientSecret: this.rt.clientSecret,
        defaultTenant: this.rt.defaultTenant,
        ...(this.rt.kind ? { kind: this.rt.kind } : {}),
      };

    // The NAMED refusals, still deferred to the moment a token is actually needed. They quote the
    // ENV variable because that is the name an operator can search for, and it remains the honest
    // name even when the value would have come from the config row: an empty resolution means
    // neither source carried it. WHICH variable is named follows the door — a device-connected
    // mailbox on a host with no public client is missing `MS_DEVICE_CLIENT_ID`, and sending its
    // operator to look for `MS_OAUTH_CLIENT_ID` (which may well be set, and is irrelevant) is a
    // wrong answer that reads as a right one.
    if (!client.clientId.trim()) {
      throw new OAuthConfigError(
        MS_CLIENT_ID_ENV[want],
        `OAuth mailbox requires ${MS_CLIENT_ID_ENV[want]}, which is not set`,
      );
    }
    /**
     * The secret refusal belongs to the confidential door only — a public registration has no
     * secret to be missing, and demanding one would break the desktop and device-code installs;
     * `clientAuthFields` refuses an EMPTY confidential secret in one place. The secret is passed
     * through UNCONDITIONALLY, and that is the point: this used to drop it for a `public` kind
     * before the seam could look — bypassing the guard. The re-opened case: a CONFIDENTIAL
     * registration mislabelled `public` would have its good secret silently discarded and Entra's
     * `invalid_client` surface as a provider outage — exactly the failure the explicit kind
     * exists to prevent. The value goes to the seam and the seam decides.
     */
    const kind: MicrosoftClientKind = client.kind ?? "confidential";

    /**
     * The door that answered must be the door that was asked for. `want` came from the mailbox's
     * credential; `kind` is what the host resolved. A mismatch means renewing a refresh token
     * against a registration that did not issue it — Microsoft answers `invalid_client` or
     * `invalid_grant`, read as a provider outage or as "your consent expired" ten minutes after
     * consent: both wrong, both actionable by the wrong person. Refused HERE, by name, before a
     * request goes out. Applies only when a RESOLVER was asked — not a loophole: the static
     * fallback is a host declaring its one door, and checking `want` there would refuse every
     * mailbox on a single-door host with no fix available.
     */
    if (this.rt.resolveClient && kind !== want) {
      throw new OAuthConfigError(
        MS_CLIENT_ID_ENV[want],
        `this mailbox's token was issued by the ${want} registration, but this host resolved the ${kind} one`,
      );
    }

    const res = await refreshAccessToken({
      refreshToken,
      tenant: tenant.trim() || (client.defaultTenant ?? this.rt.defaultTenant ?? ""),
      clientId: client.clientId,
      clientKind: kind,
      clientSecret: client.clientSecret,
      fetch: this.rt.fetch,
    }, this.rt.now ?? Date.now);

    if (res.refreshToken) {
      // Rotation: Microsoft handed back a NEW refresh token; the old one may already be dead. Persist
      // the new one so the next dial (which re-reads the DB) uses it. Encrypt with the host's key.
      const enc = await this.rt.keyProvider.encrypt(res.refreshToken);
      await this.rt.updateSecret(mailboxId, enc.ciphertext, enc.keyVersion);
    }
    this.cache.set(mailboxId, { accessToken: res.accessToken, expiresAtMs: res.expiresAtMs });
    return res.accessToken;
  }
}

/**
 * A type guard the worker's classifier uses to recognise the re-auth verdict structurally, rather
 * than by `instanceof` across a package boundary. Keys on the stable `code`.
 */
export function isOAuthReauthRequiredError(err: unknown): err is OAuthReauthRequiredError {
  return typeof err === "object" && err !== null
    && (err as { code?: unknown }).code === "OAUTH_INVALID_GRANT";
}
