// THE DEVICE AUTHORIZATION GRANT (RFC 8628) — the door a SELF-HOSTED instance connects Exchange
// Online through, and the reason a self-host operator needs no Azure registration of their own.
//
// ══ WHY THIS FLOW EXISTS HERE AT ALL ═══════════════════════════════════════════════════════
//
// The managed deployment's ceremony (`packages/api/src/routes/mailbox-oauth.ts`) turns on a
// REDIRECT URI registered in Entra: `https://ohmail.app/api/mailboxes/oauth/microsoft/callback`.
// That value is per-deployment, and a self-hoster running on `mail.example.invalid` cannot use it —
// Microsoft would send their consent to somebody else's server. Their options were therefore: run
// their own Azure app registration (real work, and a hard stop for anyone whose organisation will
// not let them), or send their users' tokens through ohmail's infrastructure (RULED OUT — no
// stranger's refresh token transits our servers, ever).
//
// The device grant removes the choice. There is NO redirect URI: the operator's instance asks
// Microsoft for a code, shows the user a short code and a URL, the user approves on any browser they
// like, and the tokens are issued DIRECTLY to the operator's instance over its own back channel.
// Nothing about the exchange touches ohmail. That is the whole reason it is the self-host default.
//
// ══ NO PKCE HERE, AND THAT IS NOT AN OMISSION ══════════════════════════════════════════════
//
// PKCE protects an authorization code on the one leg the client cannot see: the browser redirect.
// This flow HAS no redirect and no authorization code — the `device_code` is minted on the back
// channel, held only by the process that asked, and redeemed on the back channel. There is nothing
// for a verifier to bind. Adding a `code_challenge` "for consistency" would be a parameter Entra
// ignores, and a reader who assumed it was doing something.
//
// What DOES carry the security property is that the `device_code` is a bearer credential for the
// duration of the ceremony. It is never logged, never rendered, and never leaves this process — the
// user is shown the `user_code`, which is the short human one and is useless without a session at
// Microsoft.
//
// ══ THE SINGLE-USE DISCIPLINE, AND WHERE IT LIVES ══════════════════════════════════════════
//
// The redirect flow gets its replay defence from the ceremony store (`packages/db/src/oauth-ceremony.ts`),
// whose consume-once UPDATE is the security property. The device flow's equivalent is enforced by
// MICROSOFT, not by us, and that is a real difference worth stating rather than papering over: a
// `device_code` is redeemable exactly once and expires on its own schedule, so there is no state for
// us to replay-protect. What this module owns instead is the BOUND — see {@link deviceDeadline} —
// so a poll loop cannot outlive the grant it is polling for.
import {
  MS_CLIENT_ID_ENV, MS_MAIL_SCOPE, MS_TENANT_RE,
  OAuthConfigError, OAuthProviderUnavailableError,
  clientAuthFields, microsoftTokenEndpoint,
  type FetchLike, type MicrosoftClientKind,
} from "./microsoft.js";

/**
 * THE PUBLIC CLIENT THIS FLOW RUNS AS — a registration of its own, with no secret field anywhere in
 * the type.
 *
 * ── WHY IT CANNOT BE THE CONFIDENTIAL REGISTRATION'S CLIENT ID ─────────────────────────────
 *
 * A confidential application is one Entra expects to authenticate with a secret. Presenting its
 * client id on the device grant — which by definition carries no secret — is refused with
 * `unauthorized_client`, and that refusal is not something this code can pre-empt: a client id is an
 * opaque uuid, and nothing about the string says which kind of application it names. So the two ids
 * live in two variables and this flow reads only its own. An operator who has set up their own
 * confidential registration has NOT thereby armed the device door, and an operator who pastes their
 * confidential id here gets Entra's `unauthorized_client` surfaced as an operator-side fault, which
 * is what it is.
 *
 * The absent secret is also a structural refusal rather than a convention: there is no field to put
 * one in, and {@link clientAuthFields} refuses a secret on the public arm even if a caller found a
 * way to supply one.
 */
export interface MicrosoftDeviceClient {
  /** The PUBLIC application's client id. `MS_DEVICE_CLIENT_ID`. */
  clientId: string;
  /**
   * The authority segment. `common` for the multi-tenant public registration, which is what lets a
   * work mailbox and an `outlook.com` mailbox both sign in through one application.
   */
  tenant: string;
}

/** The variables that arm the device door. Two, and neither has an alias — see {@link MS_CLIENT_ID_ENV}. */
export const MS_DEVICE_ENV = {
  clientId: MS_CLIENT_ID_ENV.public,
  tenant: "MS_DEVICE_TENANT",
} as const;

/**
 * Read the device door's registration out of an environment, or `null` when it is not armed.
 *
 * `null` and not a blank object: "this deployment has no public client" is the state the routes and
 * the settings pane both branch on, and a half-filled record would make that branch a field check
 * every reader has to remember to write. A missing client id is the whole answer — the tenant alone
 * arms nothing.
 *
 * The tenant defaults to `common` rather than being required, because for the shared multi-tenant
 * public registration `common` is the only correct value and requiring it would be a variable with
 * one acceptable setting. An operator whose registration is single-tenant sets it.
 */
export function msDeviceEnv(env: Record<string, string | undefined>): MicrosoftDeviceClient | null {
  const pick = (name: string): string => (typeof env[name] === "string" ? env[name]!.trim() : "");
  const clientId = pick(MS_DEVICE_ENV.clientId);
  if (!clientId) return null;
  return { clientId, tenant: pick(MS_DEVICE_ENV.tenant) || "common" };
}

/**
 * Is the device door armed — the ONE predicate a surface may ask before offering it.
 *
 * It exists for the reason the redirect flow's availability predicate exists: a button whose press
 * returns a 503 is worse than no button. The tenant is re-checked here so this expression and the
 * refusal inside the route are the same two clauses, and a junk tenant cannot surface as a 500 on a
 * door that reported itself ready.
 */
export function deviceFlowAvailable(client: MicrosoftDeviceClient | null | undefined): boolean {
  return !!client && client.clientId.trim().length > 0 && MS_TENANT_RE.test(client.tenant ?? "");
}

/**
 * The device-code endpoint for a tenant.
 *
 * Same derivation, same validation, same reason as {@link microsoftTokenEndpoint}: the HOST is a
 * constant in the sibling module and only the tenant SEGMENT comes from data. A stored endpoint here
 * would be a one-PATCH exfil channel for the `device_code`, which is a bearer credential for as long
 * as the ceremony runs.
 */
export function microsoftDeviceCodeEndpoint(tenant: string): string {
  const t = (tenant ?? "").trim();
  if (!MS_TENANT_RE.test(t)) {
    throw new OAuthConfigError("MS_OAUTH_TENANT", `invalid Microsoft tenant segment (got ${t.length} chars)`);
  }
  return `https://login.microsoftonline.com/${t}/oauth2/v2.0/devicecode`;
}

/**
 * What the user is shown, and what the poller holds.
 *
 * `userCode` and `verificationUri` are the two values that go ON SCREEN. `deviceCode` is the one
 * that must not: it is the bearer credential the token request redeems, and anything that renders or
 * logs it hands the ceremony to whoever reads that output.
 */
export interface DeviceCodeGrant {
  /** SECRET. The back-channel credential. Never rendered, never logged. */
  deviceCode: string;
  /** The short code the person types at {@link DeviceCodeGrant.verificationUri}. Safe to display. */
  userCode: string;
  /** Where the person goes — typically `https://microsoft.com/devicelogin`. Safe to display. */
  verificationUri: string;
  /** Absolute expiry of the whole ceremony, ms since epoch. The poll loop's hard deadline. */
  expiresAtMs: number;
  /** How long to wait between polls, ms. Microsoft's own `interval`, floored (see the constant). */
  intervalMs: number;
}

/**
 * FLOOR AND CEILING ON THE POLL INTERVAL.
 *
 * `interval` comes from Microsoft and is normally 5 s. It is still input, so it is bounded on both
 * sides: a `0` (or a missing value read as one) would turn the poll into a hot loop hammering the
 * token endpoint until Entra rate-limits the client id — which on the SHARED public registration
 * would degrade the flow for every self-hoster using it, not just the one with the bad response. A
 * huge value would strand a ceremony that had actually been approved.
 */
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 60_000;

/**
 * BOUND ON THE CEREMONY ITSELF. Microsoft's `expires_in` is normally 900 s.
 *
 * Clamped for the same reason as the interval, and the LOW end matters more than it looks: an
 * `expires_in` of 0 would make {@link deviceDeadline} already past, so the first poll would report
 * the ceremony expired before the user could possibly have approved it — a failure that reads as
 * "you were too slow" to somebody who was never given a chance.
 */
const MIN_DEVICE_TTL_MS = 30_000;
const MAX_DEVICE_TTL_MS = 30 * 60_000;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export interface DeviceCodeRequest {
  tenant: string;
  clientId: string;
  /**
   * Defaults to {@link MS_MAIL_SCOPE} — IMAP, SMTP and `offline_access`.
   *
   * NOTE the OIDC scopes are NOT included by default, unlike the redirect flow's
   * `MS_AUTHORIZE_SCOPES`. The redirect flow needs `openid`/`email` because it reads the mailbox
   * address from the `id_token` and the user never types it. A caller that wants the same here must
   * ask for them explicitly and read {@link DeviceTokens.idToken}; a caller that does not gets a
   * grant with no identity claim, and has to obtain the address some other way. Stated because
   * silently adding identity scopes to a headless operator's consent screen is a change to what the
   * person is being asked to approve.
   */
  scopes?: readonly string[];
  fetch: FetchLike;
}

/** Shapes of the two bodies this module parses. Everything is `unknown` until checked. */
interface DeviceCodeBody {
  device_code?: unknown; user_code?: unknown; verification_uri?: unknown;
  expires_in?: unknown; interval?: unknown;
}
interface TokenBody {
  access_token?: unknown; refresh_token?: unknown; id_token?: unknown;
  expires_in?: unknown; error?: unknown; error_description?: unknown;
}

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const n = (v: unknown, fallback: number): number =>
  (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * READ A JSON BODY THAT MAY NOT BE ONE — and never let that be a `TypeError`.
 *
 * `res.json()` has two failure shapes and only one of them throws. An HTML error page REJECTS, which
 * a `try/catch` handles. A body that is empty, `null`, or a bare JSON scalar RESOLVES — to
 * `undefined` or `null` — and a `catch` never runs, so the next property read is
 * `Cannot read properties of undefined`. That escapes as a `TypeError`, i.e. as a crash rather than
 * as this module's honest "we could not ask" verdict, and it does so precisely on the paths that
 * matter: a 5xx from a load balancer that returns no body at all.
 *
 * Found by the test that asserts every transport failure maps to
 * {@link OAuthProviderUnavailableError}; the 503-with-no-body case threw a `TypeError` instead.
 */
async function readJsonObject(res: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  try {
    const v = await res.json();
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * STEP 1 — ask Microsoft for a device code.
 *
 * Public client only: this grant is defined for clients that cannot hold a secret, and
 * {@link clientAuthFields} refuses a secret on the public arm, so a caller that passed one gets a
 * named config error rather than a request that leaks it.
 *
 * Error mapping follows the same law as the rest of this package — a 5xx, a network throw or an
 * unparseable body means WE COULD NOT ASK, never that a credential is bad. There is no credential
 * yet at this point, so there is nothing an auth verdict could even be about.
 */
export async function requestDeviceCode(
  p: DeviceCodeRequest, now: () => number = Date.now,
): Promise<DeviceCodeGrant> {
  const endpoint = microsoftDeviceCodeEndpoint(p.tenant);
  const form = new URLSearchParams({
    ...clientAuthFields("public", p.clientId, undefined),
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
    throw new OAuthProviderUnavailableError(`device endpoint unreachable: ${(err as Error)?.name ?? "error"}`);
  }

  // A 5xx carries no OAuth verdict, so its body is never read — the same order
  // `pollDeviceCodeOnce` keeps, and the reason is the same: an HTML error page parsed as JSON would
  // be reported as a registration fault instead of as an outage.
  if (res.status >= 500) throw new OAuthProviderUnavailableError(`device endpoint returned ${res.status}`);

  if (!res.ok) {
    // A 4xx here is almost always OUR registration — a client id that is not enabled for public
    // client flows is the classic one, and it is an operator fault, not the user's. It is still
    // mapped to "unavailable" rather than to any auth verdict, because the only alternative would be
    // to blame a credential that has not been issued yet. The `error` CODE is carried; the
    // description never is (it holds request ids and timestamps).
    const body = (await readJsonObject(res)) as TokenBody;
    const code = s(body.error) || `http_${res.status}`;
    throw new OAuthProviderUnavailableError(`device endpoint refused the request (${code})`);
  }

  const ok = (await readJsonObject(res)) as DeviceCodeBody;

  const deviceCode = s(ok.device_code);
  const userCode = s(ok.user_code);
  const verificationUri = s(ok.verification_uri);
  // ALL THREE OR NOTHING. A grant missing any one of them cannot be completed: no `device_code`
  // means nothing to redeem, and no `user_code`/`verification_uri` means nothing to show the person.
  // Refusing here is better than returning a half-grant that strands the caller in a poll loop for a
  // ceremony no human was ever invited to approve.
  if (!deviceCode || !userCode || !verificationUri) {
    throw new OAuthProviderUnavailableError("device endpoint returned an incomplete grant");
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresAtMs: startedAt + clamp(n(ok.expires_in, 900) * 1000, MIN_DEVICE_TTL_MS, MAX_DEVICE_TTL_MS),
    intervalMs: clamp(n(ok.interval, 5) * 1000, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS),
  };
}

/** The tokens a completed device ceremony yields. Same shape as the redirect flow's result. */
export interface DeviceTokens {
  accessToken: string;
  /**
   * THE THING THE CEREMONY EXISTS TO OBTAIN. `null` means the grant carried no `offline_access`,
   * so there is nothing to keep the mailbox in sync with past the access token's hour. The caller
   * refuses rather than storing a mailbox that dies at teatime.
   */
  refreshToken: string | null;
  expiresAtMs: number;
  /** Present only when the caller asked for `openid`. See {@link DeviceCodeRequest.scopes}. */
  idToken: string | null;
}

/**
 * ONE POLL'S VERDICT — a closed set, and deliberately a RETURN rather than a throw for the four
 * states that are part of normal operation.
 *
 * `authorization_pending` is the overwhelmingly common answer and it arrives as an HTTP **400**.
 * That is the trap this type exists to close: the sibling module's refresh mapping turns a
 * non-`invalid_grant` 4xx into {@link OAuthProviderUnavailableError}, so a device poll routed
 * through it would report "the token endpoint rejected the grant" once every five seconds for the
 * entire fifteen minutes a person spends walking to their browser. Every one of those would look
 * like a Microsoft outage. The device flow needs its own mapping and this is it.
 */
export type DevicePollVerdict =
  /** Nobody has approved it yet. Wait `intervalMs` and poll again. The normal answer. */
  | { status: "pending" }
  /**
   * POLLING TOO FAST. RFC 8628 §3.5 requires the interval to increase by 5 s — CUMULATIVELY, each
   * time this is seen, not reset to the original on the next poll. `nextIntervalMs` carries the
   * already-increased value so a caller cannot get that arithmetic wrong; a caller that ignored it
   * and kept its original interval would be throttled harder, not less.
   */
  | { status: "slow_down"; nextIntervalMs: number }
  /** The person declined, or the ceremony ran out of time. Both mean: start again. Not a fault. */
  | { status: "declined" }
  | { status: "expired" }
  /** Approved. The tokens are here. */
  | { status: "granted"; tokens: DeviceTokens };

export interface DevicePollParams {
  tenant: string;
  clientId: string;
  /** The SECRET half of {@link DeviceCodeGrant}. Never logged. */
  deviceCode: string;
  /** The interval currently in force, so a `slow_down` can be reported already incremented. */
  intervalMs: number;
  fetch: FetchLike;
}

/** RFC 8628 §3.5: `slow_down` increases the interval by five seconds. */
const SLOW_DOWN_STEP_MS = 5_000;

/** The device grant's `grant_type`, spelled once. */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * STEP 2 — poll the token endpoint ONCE.
 *
 * One poll, not a loop, and that is the shape on purpose: the loop needs a clock and a way to sleep,
 * and both of those belong to the host (a Node CLI, a Tauri command, a test with fake timers). This
 * function is pure over its injected `fetch` and holds no timers, so a test can drive the entire
 * state machine — pending, slow_down, declined, expired, granted — without waiting a real second.
 * {@link pollDeviceCodeUntilDone} is the loop, for hosts that want it.
 *
 * ── WHAT THROWS AND WHAT RETURNS ───────────────────────────────────────────────────────────
 *
 * The five states above RETURN. Everything else — a 5xx, a network failure, an unparseable body, an
 * `error` code this flow does not define — throws {@link OAuthProviderUnavailableError}, because
 * "we could not ask" is the honest reading and none of them says anything about a credential.
 *
 * NOTHING here throws the re-auth verdict. There is no stored credential to declare dead: the same
 * reasoning `exchangeAuthorizationCode` records for its own `invalid_grant`.
 */
export async function pollDeviceCodeOnce(
  p: DevicePollParams, now: () => number = Date.now,
): Promise<DevicePollVerdict> {
  const endpoint = microsoftTokenEndpoint(p.tenant);
  const form = new URLSearchParams({
    ...clientAuthFields("public", p.clientId, undefined),
    grant_type: DEVICE_CODE_GRANT_TYPE,
    device_code: p.deviceCode,
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

  // A 5xx is checked BEFORE the body is read: it carries no OAuth verdict, and reading an HTML error
  // page as JSON would land in the `unknown_error` arm and be reported as a flow failure.
  if (res.status >= 500) throw new OAuthProviderUnavailableError(`token endpoint returned ${res.status}`);

  if (!res.ok) {
    const body = (await readJsonObject(res)) as TokenBody;
    const error = s(body.error);
    switch (error) {
      case "authorization_pending":
        return { status: "pending" };
      case "slow_down":
        return { status: "slow_down", nextIntervalMs: Math.min(p.intervalMs + SLOW_DOWN_STEP_MS, MAX_POLL_INTERVAL_MS) };
      // Microsoft spells the decline `authorization_declined`; RFC 8628 says `access_denied`. Both
      // are accepted because the wire is not ours to standardise and either one means the person
      // said no. `consent_required` lands here too: an admin-consent tenant that refuses at the
      // device screen is, from this loop's point of view, the same "start again elsewhere".
      case "authorization_declined":
      case "access_denied":
        return { status: "declined" };
      case "expired_token":
        return { status: "expired" };
      // `bad_verification_code` means OUR `device_code` is wrong — a caller bug or a mangled value.
      // It is not a state a poll loop should keep polling through, and it is not the person's doing,
      // so it is a hard failure rather than a verdict.
      case "bad_verification_code":
        throw new OAuthProviderUnavailableError("the device code was rejected as malformed");
      default:
        throw new OAuthProviderUnavailableError(
          `device poll refused (${error || `http_${res.status}`})`,
        );
    }
  }

  const ok = (await readJsonObject(res)) as TokenBody;
  const accessToken = s(ok.access_token);
  if (!accessToken) throw new OAuthProviderUnavailableError("token endpoint returned no access_token");

  return {
    status: "granted",
    tokens: {
      accessToken,
      refreshToken: s(ok.refresh_token) || null,
      expiresAtMs: startedAt + n(ok.expires_in, 3600) * 1000,
      idToken: s(ok.id_token) || null,
    },
  };
}

/** The hard deadline for a grant — the moment after which polling it is pointless. */
export const deviceDeadline = (grant: DeviceCodeGrant): number => grant.expiresAtMs;

export interface DevicePollLoopParams {
  tenant: string;
  clientId: string;
  grant: DeviceCodeGrant;
  fetch: FetchLike;
  /** How the host waits. Injected so a test drives the whole loop with no real time. */
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called after each poll that is still pending, so a UI can show progress. Never given the device code. */
  onPending?: (info: { pollCount: number; msRemaining: number }) => void;
}

/**
 * The whole ceremony's second half: poll until it resolves, or until the grant expires.
 *
 * ── THE LOOP IS BOUNDED BY THE GRANT, NOT BY A COUNT ───────────────────────────────────────
 *
 * The deadline is {@link DeviceCodeGrant.expiresAtMs}, which came from Microsoft and is clamped on
 * the way in. A poll count would be the wrong bound: `slow_down` legitimately stretches the interval,
 * so a fixed count silently shortens the window a person has to approve — and it shortens it exactly
 * when Microsoft has asked us to go slower, which is the worst time to give up.
 *
 * The clock is read BEFORE each poll and the loop exits without one when the deadline has passed, so
 * the bound holds even if the host's `sleep` overshoots badly (a laptop that suspended mid-ceremony
 * is the ordinary case).
 */
export async function pollDeviceCodeUntilDone(
  p: DevicePollLoopParams,
): Promise<{ outcome: "granted"; tokens: DeviceTokens } | { outcome: "declined" | "expired" }> {
  const clock = p.now ?? Date.now;
  const deadline = deviceDeadline(p.grant);
  let intervalMs = p.grant.intervalMs;
  let pollCount = 0;

  for (;;) {
    if (clock() >= deadline) return { outcome: "expired" };
    await p.sleep(intervalMs);
    // Re-checked after the sleep: the wait itself can cross the deadline, and a poll issued past it
    // spends a request to be told what we already know.
    if (clock() >= deadline) return { outcome: "expired" };

    pollCount += 1;
    const verdict = await pollDeviceCodeOnce({
      tenant: p.tenant, clientId: p.clientId,
      deviceCode: p.grant.deviceCode, intervalMs, fetch: p.fetch,
    }, clock);

    switch (verdict.status) {
      case "granted": return { outcome: "granted", tokens: verdict.tokens };
      case "declined": return { outcome: "declined" };
      case "expired": return { outcome: "expired" };
      case "slow_down":
        intervalMs = verdict.nextIntervalMs;
        break;
      case "pending":
        break;
    }
    p.onPending?.({ pollCount, msRemaining: Math.max(0, deadline - clock()) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DESKTOP DOOR'S REDIRECT — a loopback URI, for the PUBLIC client's PKCE flow.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The loopback redirect URI a desktop app listens on (RFC 8252 §7.3 — "the native app is the
 * authorization server's redirect target on a port it opened itself").
 *
 * ── `127.0.0.1`, NOT `localhost` ───────────────────────────────────────────────────────────
 *
 * RFC 8252 §8.3 is explicit that the IP LITERAL is preferred: `localhost` resolves through the
 * host's name resolution, which a compromised or merely misconfigured `hosts` file, a DNS search
 * suffix, or an IPv6-first stack can point somewhere the app is not listening. The literal cannot be
 * redirected by any of them. `http` is correct here and is not a downgrade — the redirect never
 * leaves the machine, and RFC 8252 §7.3 says so in as many words.
 *
 * ── THE PORT IS EPHEMERAL, AND THE REGISTRATION MUST ALLOW THAT ────────────────────────────
 *
 * A fixed port would collide with whatever else is on the machine and would let another local
 * process squat the redirect before ohmail binds it. So the app binds port 0, learns the port the
 * OS gave it, and builds the URI from that — which means the Entra registration has to accept a
 * VARYING port. Microsoft documents that it does so for loopback redirect URIs registered under the
 * "Mobile and desktop applications" platform; that behaviour is Microsoft's and not something this
 * repository can prove at build time, so it must be checked against the real Entra app
 * registration rather than asserted here as fact.
 */
export function loopbackRedirectUri(port: number, path = "/oauth/microsoft"): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new OAuthConfigError("loopback_port", `loopback redirect needs a real TCP port (got ${String(port)})`);
  }
  // The path is normalised rather than trusted: this string is compared byte-for-byte by Entra
  // against the registration and replayed at the token exchange, so a caller that passed a path
  // without its leading slash would produce a URI that fails at consent time with no clue why.
  const p = path.startsWith("/") ? path : `/${path}`;
  return `http://127.0.0.1:${port}${p}`;
}

/**
 * Is this a loopback redirect URI — i.e. the DESKTOP door's, rather than the hosted one's?
 *
 * The mirror of `webRedirectUri` in `packages/db/src/oauth-config.ts`, which selects the first
 * `https://` entry for the browser ceremony. One registration's `redirectUris` list holds both, and
 * each door must pick its own: a hosted callback that grabbed the loopback entry would send a user's
 * consent to a port on their own machine where nothing is listening.
 */
export function isLoopbackRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:") return false;
    // `[::1]` arrives from `URL` with the brackets kept. Both literals, and NOTHING resolved by
    // name — `localhost` is deliberately excluded here for the reason `loopbackRedirectUri` gives.
    return u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * The client kind each door authenticates as, named so a host wiring one cannot pick by feel.
 * `confidential` is the managed cloud's; both self-service doors are `public`.
 */
export const DESKTOP_CLIENT_KIND: MicrosoftClientKind = "public";
export const DEVICE_CLIENT_KIND: MicrosoftClientKind = "public";
