// MICROSOFT IDENTITY PLATFORM — the OAuth2 refresh-token client for Exchange Online / Microsoft 365 IMAP+SMTP.
//
// In CORE, not services: the always-on worker depends on core + db ONLY (services resolves Stripe and
// the transactional-mail SDK, which are not in the worker's image). The worker needs to mint access tokens to open IMAP,
// so the token client lives where the worker can reach it.
//
// It speaks the refresh_token grant against `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`
// and nothing else. Two invariants shape the whole file:
//
//   1. THE ENDPOINT IS DERIVED, NEVER STORED. A stored token URL is a one-PATCH refresh-token exfil
//      channel — flip the host in a mailbox row and every refresh POSTs the secret to the attacker.
//      So the host is a constant here and only the tenant SEGMENT comes from data, validated against a
//      closed shape before it is interpolated.
//
//   2. A MICROSOFT OUTAGE IS NOT A BAD CREDENTIAL. `invalid_grant` (the token is dead — the user must
//      re-consent) is the ONLY auth verdict. A 5xx, a network failure, a timeout — anything that means
//      "we could not ask" — is a NON-auth error, because classifying it as auth would quarantine every
//      oauth mailbox in the fleet as "bad credentials" the instant Microsoft has a bad minute.
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
 * WHICH KIND OF APPLICATION REGISTRATION IS ASKING — the one seam the three doors differ on, and
 * the reason it is a discriminated value rather than "a secret, or the empty string".
 *
 * ohmail talks to Entra through three doors and they do not authenticate the same way:
 *
 *  · **managed cloud** — a CONFIDENTIAL registration. The secret lives only on ohmail's servers and
 *    every token request carries it.
 *  · **desktop** — a PUBLIC registration. There is no secret, because a secret shipped in a binary
 *    is not a secret; PKCE on a loopback redirect is what authenticates the exchange instead
 *    (RFC 8252, the model Thunderbird uses).
 *  · **self-host, shared client** — the SAME public registration, driven through the device-code
 *    flow so an operator's instance needs no redirect URI of its own.
 *
 * ── WHY THIS IS EXPLICIT AND NOT INFERRED FROM AN EMPTY SECRET ────────────────────────────
 *
 * The tempting shape is `clientSecret: string` where `""` means public. It is wrong in the
 * direction that costs the most: a CONFIDENTIAL deployment whose secret failed to resolve — an
 * unset variable, a decrypt that returned nothing, a rotation half-applied — would silently emit a
 * PUBLIC token request. Entra answers that with `invalid_client`, which this client maps to
 * {@link OAuthProviderUnavailableError} (deliberately: a rejected client is not the mailbox's
 * fault). So the fleet would stop refreshing, nothing would quarantine, nothing would page, and the
 * true cause — a missing secret — would be indistinguishable from Microsoft having a bad week.
 *
 * With the kind stated, that same deployment gets {@link OAuthConfigError} naming
 * `MS_OAUTH_CLIENT_SECRET`, which is a sentence an operator can act on. And the inverse mistake —
 * a secret handed to a public-client request — is refused too, because a caller that supplied one
 * has mixed two doors up and the request it is about to make is not the one it thinks.
 */
export type MicrosoftClientKind = "confidential" | "public";

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
 * Default IMAP+SMTP scopes for Exchange Online. `offline_access` is what returns a refresh token.
 *
 * ── THE SCOPE HOST IS `outlook.office.com`, AND THE IMAP HOST IS `outlook.office365.com` ───
 *
 * These two look like the same name typed twice and they are NOT the same thing, so the difference
 * is recorded here rather than left to be "corrected" by the next reader:
 *
 *  · `https://outlook.office.com/IMAP.AccessAsUser.All` is a RESOURCE IDENTIFIER. It is the string
 *    Entra matches against the application registration's delegated permissions, and it must equal
 *    what is registered there byte-for-byte or the authorize request is refused. Microsoft's own
 *    canonical spelling is `outlook.office.com`; `outlook.office365.com` is the legacy alias and is
 *    what this constant said until the registration was checked against it.
 *  · `outlook.office365.com:993` is a HOSTNAME the IMAP client dials. It is unchanged, it is not
 *    part of any scope, and rewriting it to match the scope would point the dialler at a host that
 *    does not serve IMAP.
 *
 * A scope host that does not match the registration fails at the CONSENT SCREEN, before any code
 * exists — which is the good direction, but it presents as "the application is misconfigured" with
 * no clue as to which of the two strings is wrong.
 */
export const MS_MAIL_SCOPE =
  "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access";

/**
 * The OIDC scopes the AUTHORIZE request adds, and they are not optional decoration.
 *
 * The callback learns the mailbox address from the `id_token`'s `preferred_username` / `email`
 * claim — the user never types it (see {@link addressFromIdToken}). No `openid` means no `id_token`
 * at all, and no `email` means the claim may be absent from the one that is issued. Either way the
 * ceremony completes, the tokens are valid, and there is no address to store: a failure that looks
 * like a Microsoft problem and is a scope list one line long.
 *
 * They are NOT in {@link MS_MAIL_SCOPE}, because that constant is also what the REFRESH grant asks
 * for and a refresh has no identity to establish.
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
 * The AUTHORIZE endpoint for a tenant — the URL a browser is sent to.
 *
 * Same derivation and same validation as {@link microsoftTokenEndpoint}, and it is a separate
 * function rather than a string built at the call site for the derivation invariant's reason: the host is a
 * constant in this file and the tenant SEGMENT is the only thing that comes from data. A caller that
 * assembled this URL itself would be a second place a stored value could become a host.
 *
 * This one is less dangerous than the token endpoint — no secret is POSTed to it — but a redirect
 * to an attacker's host is a credible phish of the user's Microsoft password, so it is held to the
 * same rule rather than to a weaker one.
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
 * Mint a PKCE pair.
 *
 * S256 ONLY. RFC 7636 permits `plain`, and `plain` in a redirect flow is no protection at all — the
 * challenge and the verifier are the same string, so anyone who can read the authorize URL can
 * complete the exchange. There is no parameter to select it.
 *
 * PKCE is here even though this is a CONFIDENTIAL client that also sends a secret, and that is not
 * belt-and-braces for its own sake: the authorization code travels through the user's browser and
 * through Microsoft's redirect, which is the one leg this service cannot see. PKCE is what makes a
 * code captured on that leg useless without the verifier, which never leaves the server.
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
 * The URL the browser is sent to.
 *
 * `prompt=select_account` rather than the default, deliberately: the default reuses whatever session
 * the browser already has at Microsoft, which on a shared machine (or for somebody with a work and
 * a personal account) silently connects the wrong mailbox — and the address is taken from the token,
 * so "silently" is exact. Being asked which account is the point of the screen.
 *
 * `response_mode` is left at its default (`query`) so the callback reads its parameters from the
 * query string of a GET. `fragment` would put them where no server can see them and `form_post`
 * would make the callback a POST, which the reduced pipeline's `withRequestGuard` would then have to
 * treat as a mutation with no CSRF token — a cross-site POST by construction.
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
 * Redeem an authorization code for tokens — the CONFIDENTIAL-client half of the ceremony.
 *
 * Error mapping is deliberately NOT the same as {@link refreshAccessToken}'s, and the difference is
 * the point. There, `invalid_grant` means "this mailbox's stored credential is dead, tell the user
 * to reconnect", which is a durable verdict about a stored row. Here there is no stored row yet:
 * `invalid_grant` means the code was already redeemed, or expired, or the verifier did not match —
 * i.e. THIS ATTEMPT failed and there is nothing to quarantine. So it raises
 * {@link OAuthExchangeFailedError} and never {@link OAuthReauthRequiredError}, because emitting the
 * re-auth verdict from a path with no mailbox would put `error_code='auth'` on whatever the caller
 * happened to be holding.
 *
 * `invalid_client` — OUR secret is wrong — is the one an operator must be able to see, and it is
 * carried in `reason` so the callback can say "this deployment's Outlook credentials were rejected"
 * rather than blaming the person who clicked the button.
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
 * THE MAILBOX ADDRESS, FROM THE `id_token`. The user never types it.
 *
 * ── WHY THE SIGNATURE IS NOT VERIFIED, AND WHY THAT IS SOUND HERE ─────────────────────────
 *
 * This token was not presented by a client. It came back in the BODY of a TLS response to a POST
 * this process made to a URL it derived itself, authenticated with the confidential client's secret.
 * There is no untrusted party on that leg, which is exactly the case OpenID Connect Core §3.1.3.7
 * names: a client MAY skip id_token signature validation when the token is obtained directly from
 * the token endpoint over a protected channel. Fetching Microsoft's JWKS to verify a token we just
 * received from Microsoft would add a network dependency and a key-rotation failure mode to buy
 * nothing.
 *
 * It is therefore parsed and NOT trusted for anything beyond the address. No `iss`, no `aud`, no
 * role, no group, no entitlement is read from here — the account this mailbox lands on comes from
 * the SESSION and from the ceremony row's `account_id`, which the callback asserts are the same. If
 * that ever changes, the argument above stops being sufficient and the verification has to be
 * written.
 *
 * ── WHICH CLAIM, AND IN WHICH ORDER ───────────────────────────────────────────────────────
 *
 * `preferred_username` first: for Microsoft work/school accounts it is the UPN, which is the string
 * the IMAP server authenticates as, and that is the one property this address must have — it is
 * about to be stored as `meta.user` and used as the XOAUTH2 login. `email` second, for personal
 * accounts where `preferred_username` may be absent. `upn` last, as the legacy spelling. `sub` is
 * deliberately NOT a fallback: it is an opaque pairwise identifier, not an address, and storing it
 * would produce a mailbox row whose `address` no mail server has ever heard of.
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
   * RESOLVE THE REGISTRATION AT TOKEN TIME, rather than at construction. When present it WINS over
   * the three static fields above, which stay as the fallback for a host that has nothing to resolve
   * from (and for every existing test).
   *
   * ── WHY THIS IS NOT A CONSTRUCTOR ARGUMENT ────────────────────────────────────────────────
   *
   * The whole point of moving the registration into a database row (cloud 0009) is that an operator
   * can rotate an expiring Entra client secret from the admin console WITHOUT redeploying. The
   * always-on worker builds this provider ONCE, at boot, and then lives for weeks — so a
   * registration read at construction is a registration frozen at the last deploy, and the console's
   * save would appear to work while every refresh in the fleet kept using the dead secret. That
   * failure is silent in the worst way: `refreshAccessToken` maps a rejected client to
   * `OAuthProviderUnavailableError` (deliberately — it is not the mailbox's fault), so nothing is
   * quarantined, nothing pages, and mail simply stops arriving.
   *
   * It is called on the path that already makes an HTTP round trip to Microsoft, and only when the
   * cached access token is inside its refresh margin — at most once per mailbox per ~55 minutes — so
   * there is deliberately NO CACHE in front of it. A cache here would reintroduce exactly the
   * staleness window this field exists to remove, to save a single-row indexed SELECT per hour.
   */
  resolveClient?: () => Promise<MicrosoftClientCredentials>;
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
 * Mints and caches Microsoft access tokens, and persists a rotated refresh token.
 *
 * The cache is keyed by mailbox id. A cached token is reused only while it has more than
 * `refreshMargin + skew` of life left; inside that window the next call refreshes. On the worker the
 * instance lives for the process, so the cache spans reconnects for one mailbox; on the API a fresh
 * instance per invocation makes the cache per-request, which is all a serverless send needs.
 *
 * NO mid-session re-auth is implied by any of this: a live IMAP session is not driven from here, and
 * `connect()` calls the fetcher exactly once per dial. The cache only spares a redundant token POST
 * when the SAME provider is asked again (a second send in one API invocation, a re-dial that lands
 * inside the token's life).
 */
export class MicrosoftTokenProvider implements OAuthTokenProvider {
  private readonly cache = new Map<string, { accessToken: string; expiresAtMs: number }>();
  constructor(private readonly rt: MicrosoftOAuthRuntime) {}

  forMailbox(mailboxId: string): AccessTokenFetcherFactory {
    return ({ refreshToken, tenant, provider }) => {
      if (provider !== "microsoft") {
        // Should never happen — buildImapAuth already gated the provider — but a factory that
        // silently accepted a foreign provider would be a hole waiting for a caller that skips it.
        throw new OAuthConfigError("provider", `MicrosoftTokenProvider cannot serve provider ${provider}`);
      }
      return () => this.accessToken(mailboxId, refreshToken, tenant);
    };
  }

  private async accessToken(mailboxId: string, refreshToken: string, tenant: string): Promise<string> {
    // THE CACHE IS CHECKED BEFORE THE REGISTRATION IS RESOLVED, and that order is deliberate: a live
    // access token is good regardless of what the console has since been edited to say, and resolving
    // first would put a query in front of every dial rather than in front of every REFRESH.
    const now = (this.rt.now ?? Date.now)();
    const margin = (this.rt.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS) + (this.rt.skewMs ?? DEFAULT_SKEW_MS);
    const cached = this.cache.get(mailboxId);
    if (cached && cached.expiresAtMs - now > margin) return cached.accessToken;

    // The resolver WINS over the static fields when one is wired — see `resolveClient`.
    const client: MicrosoftClientCredentials = this.rt.resolveClient
      ? await this.rt.resolveClient()
      : {
        clientId: this.rt.clientId,
        clientSecret: this.rt.clientSecret,
        defaultTenant: this.rt.defaultTenant,
        ...(this.rt.kind ? { kind: this.rt.kind } : {}),
      };

    // The NAMED refusals, still deferred to the moment a token is actually needed. They quote the
    // ENV variable because that is the name an operator can search for, and it remains the honest
    // name even when the value would have come from the config row: an empty resolution means
    // neither source carried it.
    if (!client.clientId.trim()) {
      throw new OAuthConfigError("MS_OAUTH_CLIENT_ID", "OAuth mailbox requires MS_OAUTH_CLIENT_ID, which is not set");
    }
    /* THE SECRET REFUSAL BELONGS TO THE CONFIDENTIAL DOOR ONLY. A public registration has no secret
     * to be missing, and demanding one here would make the desktop and the self-host device-code
     * install unable to refresh at all. `clientAuthFields` is what refuses an EMPTY confidential
     * secret — one place, reached by every grant — so there is no second copy of the rule here.
     *
     * ── THE SECRET IS PASSED THROUGH UNCONDITIONALLY, AND THAT IS THE WHOLE POINT ────────────
     *
     * This used to read `...(kind === "confidential" ? { clientSecret } : {})`, which DROPPED the
     * secret before the seam could look at it — and in doing so bypassed the guard this seam exists
     * to be. A review caught it. The case it re-opened is the mirror of the one
     * `clientAuthFields` was written for: a CONFIDENTIAL registration MISLABELLED `public` (a wrong
     * `kind` on a config row, a resolver returning the wrong door) would have its perfectly good
     * secret silently discarded, send a secretless request, and have Entra's `invalid_client`
     * surface as {@link OAuthProviderUnavailableError} — the fleet quietly failing to refresh while
     * looking like a Microsoft outage, which is EXACTLY the failure the explicit kind was
     * introduced to make impossible.
     *
     * So the value goes to the seam and the seam decides. A public runtime whose secret is empty
     * (the correct configuration) is unaffected; one carrying a secret is refused by name.
     */
    const kind: MicrosoftClientKind = client.kind ?? "confidential";

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
