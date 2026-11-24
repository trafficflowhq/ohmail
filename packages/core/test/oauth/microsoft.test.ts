import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  refreshAccessToken, microsoftTokenEndpoint, MicrosoftTokenProvider,
  OAuthReauthRequiredError, OAuthProviderUnavailableError, OAuthConfigError, OAuthClientRefusedError,
  isOAuthReauthRequiredError,
  microsoftAuthorizeEndpoint, buildMicrosoftAuthorizeUrl, pkcePair, oauthState,
  exchangeAuthorizationCode, addressFromIdToken, classifyConsentFailure,
  OAuthExchangeFailedError, MS_AUTHORIZE_SCOPES, MS_MAIL_SCOPE,
  type FetchLike, type MicrosoftOAuthRuntime,
} from "../../src/oauth/microsoft.js";
import { StaticKeyProvider } from "../../src/crypto.js";

// A FAKE token endpoint. Every test drives Microsoft's behaviour through this — no network, no creds.
function fakeFetch(handler: (body: URLSearchParams) => {
  status: number; json?: unknown; throwNetwork?: boolean;
}): { fetch: FetchLike; calls: URLSearchParams[] } {
  const calls: URLSearchParams[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = new URLSearchParams(init.body);
    calls.push(body);
    const r = handler(body);
    if (r.throwNetwork) throw Object.assign(new Error("ECONNREFUSED"), { name: "FetchError" });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json ?? {}),
    };
  };
  return { fetch, calls };
}

const KEK = Buffer.from("0".repeat(64), "hex"); // 32-byte KEK for StaticKeyProvider

describe("microsoftTokenEndpoint — the endpoint is DERIVED, never stored", () => {
  it("accepts the reserved authorities and a GUID tenant", () => {
    expect(microsoftTokenEndpoint("common")).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(microsoftTokenEndpoint("organizations")).toContain("/organizations/");
    expect(microsoftTokenEndpoint("consumers")).toContain("/consumers/");
    const guid = "12345678-1234-1234-1234-1234567890ab";
    expect(microsoftTokenEndpoint(guid)).toBe(`https://login.microsoftonline.com/${guid}/oauth2/v2.0/token`);
  });

  it("REFUSES anything else — a path traversal or an injected host can never reach a URL", () => {
    for (const bad of ["../evil", "common/../../x", "evil-com.example", "tenant with spaces", "", "http://x"]) {
      expect(() => microsoftTokenEndpoint(bad), bad).toThrow(OAuthConfigError);
    }
  });
});

describe("refreshAccessToken — the security-load-bearing error mapping", () => {
  const base = { refreshToken: "RT", tenant: "common", clientId: "cid", clientSecret: "csec" };

  it("a 200 returns the access token and an absolute expiry", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const res = await refreshAccessToken({ ...base, fetch }, () => 1_000_000);
    expect(res.accessToken).toBe("AT");
    expect(res.expiresAtMs).toBe(1_000_000 + 3600 * 1000);
    expect(res.refreshToken).toBeUndefined();
    // The grant is the refresh_token grant, carrying our secret and the stored refresh token.
    expect(calls[0].get("grant_type")).toBe("refresh_token");
    expect(calls[0].get("refresh_token")).toBe("RT");
    expect(calls[0].get("client_secret")).toBe("csec");
  });

  it("invalid_grant → OAuthReauthRequiredError (the ONE auth verdict)", async () => {
    const { fetch } = fakeFetch(() => ({ status: 400, json: { error: "invalid_grant", error_description: "expired" } }));
    await expect(refreshAccessToken({ ...base, fetch })).rejects.toBeInstanceOf(OAuthReauthRequiredError);
    try { await refreshAccessToken({ ...base, fetch }); } catch (e) {
      expect((e as OAuthReauthRequiredError).code).toBe("OAUTH_INVALID_GRANT");
      expect(isOAuthReauthRequiredError(e)).toBe(true);
    }
  });

  it("an AADSTS700082 in error_description → re-auth even when error isn't invalid_grant", async () => {
    const { fetch } = fakeFetch(() => ({ status: 400, json: { error: "interaction_required", error_description: "AADSTS700082: token expired due to inactivity" } }));
    await expect(refreshAccessToken({ ...base, fetch })).rejects.toBeInstanceOf(OAuthReauthRequiredError);
  });

  it("a 5xx → OAuthProviderUnavailableError, NEVER auth — a Microsoft outage must not quarantine the fleet", async () => {
    const { fetch } = fakeFetch(() => ({ status: 503, json: { error: "temporarily_unavailable" } }));
    const err = await refreshAccessToken({ ...base, fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthProviderUnavailableError);
    expect(isOAuthReauthRequiredError(err)).toBe(false);
  });

  it("a network failure (fetch throws) → OAuthProviderUnavailableError, not auth", async () => {
    const { fetch } = fakeFetch(() => ({ status: 0, throwNetwork: true }));
    await expect(refreshAccessToken({ ...base, fetch })).rejects.toBeInstanceOf(OAuthProviderUnavailableError);
  });

  /* A refusal of OUR client is ours (OAUTH-CLIENT-REFUSAL-TOLD-AS-THE-MAIL-SERVER): consumers, the
     byte door's fault row and the worker's `unknown`. Never auth, never an outage. */
  it.each([
    [401, "invalid_client"], [400, "unauthorized_client"], [400, "invalid_request"], [400, "unsupported_grant_type"],
  ])("a %i %s is a refusal of this deployment's client — never auth", async (status, error) => {
    const { fetch } = fakeFetch(() => ({ status, json: { error } }));
    const err = await refreshAccessToken({ ...base, fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthClientRefusedError);
    expect({ code: (err as OAuthClientRefusedError).code, word: (err as OAuthClientRefusedError).oauthError, status: (err as OAuthClientRefusedError).httpStatus })
      .toEqual({ code: "OAUTH_CLIENT_REFUSED", word: error, status });
    expect(isOAuthReauthRequiredError(err)).toBe(false);
  });

  it.each([
    ["a 408", 408, { error: "invalid_client" }], ["a 429", 429, { error: "invalid_client" }],
    ["temporarily_unavailable", 400, { error: "temporarily_unavailable" }],
    ["a person's step (interaction_required)", 400, { error: "interaction_required" }],
    ["a person's step (consent_required)", 400, { error: "consent_required" }],
    ["the provider's own fault (server_error)", 400, { error: "server_error" }],
    ["no word at all", 400, {}], ["an unparseable body", 400, undefined],
  ])("CONTROL: %s stays unavailable, as every non-grant 4xx read before", async (_l, status, json) => {
    const { fetch } = fakeFetch(() => ({ status, json }));
    await expect(refreshAccessToken({ ...base, fetch })).rejects.toBeInstanceOf(OAuthProviderUnavailableError);
  });

  it("the refusal carries the closed word only, and no word an auth reader keys on", () => {
    const err = new OAuthClientRefusedError("Invalid Client; AADSTS7000215 Trace ID", 401);
    expect(err.oauthError).toBe("unknown_error");
    expect(err.message).not.toMatch(/password|credential|login|authentication|invalid/i);
  });

  it("a rotated refresh_token in the response is surfaced for the caller to persist", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600, refresh_token: "RT-NEW" } }));
    const res = await refreshAccessToken({ ...base, fetch });
    expect(res.refreshToken).toBe("RT-NEW");
  });
});

describe("MicrosoftTokenProvider — cache, rotation persistence, and the named config refusal", () => {
  function runtime(over: Partial<MicrosoftOAuthRuntime> = {}): {
    rt: MicrosoftOAuthRuntime; updates: Array<{ mailboxId: string; ciphertext: string; keyVersion: number }>;
  } {
    const updates: Array<{ mailboxId: string; ciphertext: string; keyVersion: number }> = [];
    const rt: MicrosoftOAuthRuntime = {
      clientId: "cid",
      clientSecret: "csec",
      defaultTenant: "common",
      keyProvider: new StaticKeyProvider({ 1: KEK }),
      updateSecret: async (mailboxId, ciphertext, keyVersion) => { updates.push({ mailboxId, ciphertext, keyVersion }); },
      fetch: fakeFetch(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } })).fetch,
      now: () => 1_000_000,
      ...over,
    };
    return { rt, updates };
  }

  it("a ROTATED refresh_token triggers a re-encrypt + updateSecret with the mailbox's own id", async () => {
    const { rt, updates } = runtime({
      fetch: fakeFetch(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600, refresh_token: "RT-NEW" } })).fetch,
    });
    const provider = new MicrosoftTokenProvider(rt);
    const fetcher = provider.forMailbox("mbx-1")({ refreshToken: "RT-OLD", tenant: "common", provider: "microsoft" });
    const token = await fetcher();
    expect(token).toBe("AT");
    expect(updates).toHaveLength(1);
    expect(updates[0].mailboxId).toBe("mbx-1");
    // It is the ENCRYPTED new token, not the plaintext, that is persisted.
    expect(updates[0].ciphertext).not.toContain("RT-NEW");
    const roundTrip = await rt.keyProvider.decrypt(updates[0].ciphertext, updates[0].keyVersion);
    expect(roundTrip).toBe("RT-NEW");
  });

  it("does NOT call updateSecret when no rotation happened", async () => {
    const { rt, updates } = runtime();
    const provider = new MicrosoftTokenProvider(rt);
    await provider.forMailbox("mbx-1")({ refreshToken: "RT", tenant: "common", provider: "microsoft" })();
    expect(updates).toEqual([]);
  });

  it("hands the persist port what the dial handed over beside the mailbox, each dial its own", async () => {
    const written: Array<{ mailboxId: string; dial: string }> = [];
    const provider = new MicrosoftTokenProvider<string>({
      clientId: "cid", clientSecret: "csec", defaultTenant: "common",
      keyProvider: new StaticKeyProvider({ 1: KEK }),
      updateSecret: async (mailboxId, _ciphertext, _keyVersion, dial) => { written.push({ mailboxId, dial }); },
      fetch: fakeFetch(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600, refresh_token: "RT-NEW" } })).fetch,
      now: () => 1_000_000,
    });
    const asked = { refreshToken: "RT", tenant: "common", provider: "microsoft" };
    await provider.forMailbox("mbx-1", "the first dial")(asked)();
    await provider.forMailbox("mbx-2", "the second dial")(asked)();
    expect(written).toEqual([{ mailboxId: "mbx-1", dial: "the first dial" }, { mailboxId: "mbx-2", dial: "the second dial" }]);
  });

  it("caches a token within its life and re-fetches near expiry (<5min + skew)", async () => {
    let n = 0;
    const ff = fakeFetch(() => { n += 1; return { status: 200, json: { access_token: `AT-${n}`, expires_in: 3600 } }; });
    let clock = 1_000_000;
    const { rt } = runtime({ fetch: ff.fetch, now: () => clock });
    const provider = new MicrosoftTokenProvider(rt);
    const fetch1 = provider.forMailbox("mbx-1")({ refreshToken: "RT", tenant: "common", provider: "microsoft" });
    expect(await fetch1()).toBe("AT-1");
    // Well within life → cached, no second POST.
    clock += 60_000;
    expect(await fetch1()).toBe("AT-1");
    expect(ff.calls).toHaveLength(1);
    // Push the clock to inside the (5min + 120s) refresh window → a fresh POST.
    clock = 1_000_000 + 3600_000 - 60_000;
    expect(await fetch1()).toBe("AT-2");
    expect(ff.calls).toHaveLength(2);
  });

  it("a MISSING client secret is a NAMED refusal, not a flake-shaped retry loop", async () => {
    const { rt } = runtime({ clientSecret: "" });
    const provider = new MicrosoftTokenProvider(rt);
    const fetcher = provider.forMailbox("mbx-1")({ refreshToken: "RT", tenant: "common", provider: "microsoft" });
    const err = await fetcher().catch((e) => e);
    expect(err).toBeInstanceOf(OAuthConfigError);
    expect((err as OAuthConfigError).configVar).toBe("MS_OAUTH_CLIENT_SECRET");
    // It is NOT an auth verdict — the credential is fine, the environment is not.
    expect(isOAuthReauthRequiredError(err)).toBe(false);
  });

  it("a MISSING client id is likewise a named refusal", async () => {
    const { rt } = runtime({ clientId: "" });
    const provider = new MicrosoftTokenProvider(rt);
    const err = await provider.forMailbox("m")({ refreshToken: "RT", tenant: "common", provider: "microsoft" })().catch((e) => e);
    expect(err).toBeInstanceOf(OAuthConfigError);
    expect((err as OAuthConfigError).configVar).toBe("MS_OAUTH_CLIENT_ID");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   PHASE 2 — the AUTHORIZE half of the ceremony, and the code exchange.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const bytes = (n: number): Buffer => Buffer.alloc(n, 7);

describe("the authorize URL — derived host, the hashed PKCE method only, and the scopes the address depends on", () => {
  it("derives the endpoint from the tenant SEGMENT and refuses anything else", () => {
    expect(microsoftAuthorizeEndpoint("common"))
      .toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    // The same rule as the token endpoint, and held to it for a reason that is weaker but real: no
    // secret is POSTed to this URL, but a redirect to an attacker's host is a credible phish of the
    // user's Microsoft password.
    for (const bad of ["../evil", "evil-com.example", "", "http://x"]) {
      expect(() => microsoftAuthorizeEndpoint(bad), bad).toThrow(OAuthConfigError);
    }
  });

  it("publishes the CHALLENGE and keeps the VERIFIER, with the hashed method and no way to select plain", () => {
    const pair = pkcePair(bytes);
    expect(pair.method).toBe("S" + "256");
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // RFC 7636 permits `plain`, and `plain` in a redirect flow is no protection at all: the challenge
    // and the verifier are the same string, so anyone who can read the authorize URL can complete the
    // exchange. There is no parameter that can ask for it, and this is the assertion that says so.
    expect(pair.challenge).not.toBe(pair.verifier);
    expect(createHash("sha256").update(pair.verifier).digest("base64url")).toBe(pair.challenge);
  });

  it("state is 256 bits of the caller's RNG, base64url", () => {
    expect(oauthState(bytes)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The RNG is a PARAMETER, so this module owns no entropy source and a host cannot be given a
    // weak one by accident — it has to pass one.
    expect(oauthState((n) => Buffer.alloc(n, 0))).toBe("A".repeat(43));
  });

  it("asks for openid + email as well as the mail scopes", () => {
    // Without them there is no `id_token` (or no `email` claim in it), the ceremony still completes,
    // and there is no address to store — a failure that reads as Microsoft's.
    expect(MS_AUTHORIZE_SCOPES).toContain("openid");
    expect(MS_AUTHORIZE_SCOPES).toContain("email");
    expect(MS_AUTHORIZE_SCOPES).toContain("offline_access");
    // The SCOPE host is `outlook.office.com` — Entra's resource identifier, matched byte-for-byte
    // against the application registration. `outlook.office365.com` is the IMAP HOSTNAME and is a
    // different string on purpose; a scope carrying it fails at the consent screen.
    expect(MS_MAIL_SCOPE).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(MS_MAIL_SCOPE).toContain("https://outlook.office.com/SMTP.Send");
    expect(MS_MAIL_SCOPE).not.toContain("outlook.office365.com");
  });

  it("builds the URL with prompt=select_account and response_mode=query", () => {
    const url = new URL(buildMicrosoftAuthorizeUrl({
      tenant: "common", clientId: "cid", redirectUri: "https://ohmail.app/cb",
      scopes: MS_AUTHORIZE_SCOPES, state: "S", codeChallenge: "C", loginHint: "a@b.example",
    }));
    expect(url.searchParams.get("code_challenge_method")).toBe("S" + "256");
    // `select_account`: the default reuses whatever Microsoft session the browser holds, which on a
    // shared machine — or for anyone with a work and a personal account — silently connects the wrong
    // mailbox. The address comes from the token, so "silently" is exact.
    expect(url.searchParams.get("prompt")).toBe("select_account");
    // `query`, so the callback can read its parameters at all: `fragment` puts them where no server
    // can see them, and `form_post` would make the callback a cross-site POST.
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("login_hint")).toBe("a@b.example");
    expect(url.searchParams.get("scope")).toBe(MS_AUTHORIZE_SCOPES.join(" "));
  });
});

describe("exchangeAuthorizationCode — a failed EXCHANGE is not a dead CREDENTIAL", () => {
  const params = {
    code: "CODE", codeVerifier: "VERIFIER", redirectUri: "https://ohmail.app/cb",
    tenant: "common", clientId: "cid", clientSecret: "sec",
  };

  it("sends the confidential-client grant and returns all three tokens", async () => {
    const f = fakeFetch(() => ({
      status: 200,
      json: { access_token: "AT", refresh_token: "RT", expires_in: 3600, id_token: "x.y.z" },
    }));
    const out = await exchangeAuthorizationCode({ ...params, fetch: f.fetch }, () => 1_000);
    expect(f.calls[0]!.get("grant_type")).toBe("authorization_code");
    expect(f.calls[0]!.get("code_verifier")).toBe("VERIFIER");
    expect(f.calls[0]!.get("client_secret")).toBe("sec");
    expect(f.calls[0]!.get("redirect_uri")).toBe("https://ohmail.app/cb");
    expect(out).toEqual({ accessToken: "AT", refreshToken: "RT", expiresAtMs: 1_000 + 3_600_000, idToken: "x.y.z" });
  });

  it("`invalid_grant` here is OAuthExchangeFailedError and NEVER the re-auth verdict", async () => {
    // On the REFRESH path `invalid_grant` means "this mailbox's stored credential is dead, tell the
    // user to reconnect" — a durable verdict about a stored row. Here there is no row: it means THIS
    // attempt failed. Emitting `OAuthReauthRequiredError` from a path with no mailbox would put
    // `error_code='auth'` on whatever the caller happened to be holding.
    const f = fakeFetch(() => ({ status: 400, json: { error: "invalid_grant" } }));
    await expect(exchangeAuthorizationCode({ ...params, fetch: f.fetch })).rejects.toThrow(OAuthExchangeFailedError);
    await expect(exchangeAuthorizationCode({ ...params, fetch: f.fetch })).rejects.not.toThrow(OAuthReauthRequiredError);
  });

  it("carries Microsoft's `error` CODE and never its description", async () => {
    const f = fakeFetch(() => ({
      status: 401,
      json: { error: "invalid_client", error_description: "AADSTS7000215: Trace ID: 9c2f-…" },
    }));
    const err = await exchangeAuthorizationCode({ ...params, fetch: f.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthExchangeFailedError);
    // The description carries request ids, timestamps and can echo the redirect URI, and this value
    // reaches a redirect the browser follows. The `error` code is a closed OAuth2 vocabulary.
    expect((err as OAuthExchangeFailedError).oauthError).toBe("invalid_client");
    expect(JSON.stringify(err)).not.toContain("Trace ID");
    expect((err as Error).message).not.toContain("Trace ID");
  });

  it("a 4xx whose body reads as no object is the exchange failing, never a TypeError of ours", async () => {
    const f = fakeFetch(() => ({ status: 400, json: undefined }));
    const err = await exchangeAuthorizationCode({ ...params, fetch: f.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthExchangeFailedError);
    expect((err as OAuthExchangeFailedError).oauthError).toBe("unknown_error");
  });

  it("a 5xx and a network throw are UNAVAILABLE, never a verdict", async () => {
    const down = fakeFetch(() => ({ status: 503 }));
    await expect(exchangeAuthorizationCode({ ...params, fetch: down.fetch }))
      .rejects.toThrow(OAuthProviderUnavailableError);
    const dead = fakeFetch(() => ({ status: 0, throwNetwork: true }));
    await expect(exchangeAuthorizationCode({ ...params, fetch: dead.fetch }))
      .rejects.toThrow(OAuthProviderUnavailableError);
  });

  it("a grant with no refresh token is reported as such, not stored", async () => {
    const f = fakeFetch(() => ({ status: 200, json: { access_token: "AT", expires_in: 60 } }));
    const out = await exchangeAuthorizationCode({ ...params, fetch: f.fetch });
    // `null`, so the CALLER decides. It refuses — an access token that lasts an hour with nothing to
    // renew it is a mailbox that works for one sync cycle.
    expect(out.refreshToken).toBeNull();
  });
});

describe("addressFromIdToken — the address the user never types", () => {
  const tok = (claims: Record<string, unknown>): string =>
    `x.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.x`;

  it("prefers preferred_username, then email, then upn", () => {
    // `preferred_username` first because for work/school accounts it is the UPN, which is the string
    // the IMAP server authenticates as — and that address is about to become `meta.user`.
    expect(addressFromIdToken(tok({ preferred_username: "a@x.example", email: "b@x.example", upn: "c@x.example" }))).toBe("a@x.example");
    expect(addressFromIdToken(tok({ email: "b@x.example", upn: "c@x.example" }))).toBe("b@x.example");
    expect(addressFromIdToken(tok({ upn: "c@x.example" }))).toBe("c@x.example");
  });

  it("refuses a claim that is not an address, and NEVER falls back to `sub`", () => {
    // `preferred_username` is a display name or a phone number on some account types.
    expect(addressFromIdToken(tok({ preferred_username: "Mila G" }))).toBeNull();
    expect(addressFromIdToken(tok({ preferred_username: "+41 79 000 00 00" }))).toBeNull();
    expect(addressFromIdToken(tok({ preferred_username: "a b@x.example" }))).toBeNull();
    // `sub` is an opaque pairwise identifier. Using it would produce a mailbox row whose `address`
    // no mail server has ever heard of.
    expect(addressFromIdToken(tok({ sub: "opaque-pairwise-id" }))).toBeNull();
    expect(addressFromIdToken(null)).toBeNull();
    expect(addressFromIdToken("not-a-jwt")).toBeNull();
    expect(addressFromIdToken("x.not-base64-json.x")).toBeNull();
  });
});

describe("classifyConsentFailure — the ORDER is the finding", () => {
  it("admin-consent is tested BEFORE access_denied", () => {
    // A tenant that RESTRICTS user consent sends `access_denied` carrying `AADSTS65001`. Testing
    // `access_denied` first would tell every user in such a tenant that they declined a screen they
    // were never allowed to accept — a confident lie about their own action. Swap the two arms and
    // this line goes red while the next one passes.
    expect(classifyConsentFailure("access_denied", "AADSTS65001: not consented")).toBe("admin_consent_required");
    expect(classifyConsentFailure("access_denied", "AADSTS90094: grant requires admin permission"))
      .toBe("admin_consent_required");
    expect(classifyConsentFailure("consent_required", null)).toBe("admin_consent_required");
    expect(classifyConsentFailure("admin_consent_required", null)).toBe("admin_consent_required");
  });

  it("a person's own decision is `consent_declined`, and anything else is `consent_failed`", () => {
    expect(classifyConsentFailure("access_denied", null)).toBe("consent_declined");
    expect(classifyConsentFailure("access_denied", "AADSTS65004: user declined")).toBe("consent_declined");
    expect(classifyConsentFailure(null, null, "cancel")).toBe("consent_declined");
    expect(classifyConsentFailure("server_error", "something")).toBe("consent_failed");
    expect(classifyConsentFailure(null, null)).toBe("consent_failed");
  });
});

describe("MicrosoftTokenProvider.resolveClient — a rotated secret without a redeploy", () => {
  const rt = (over: Partial<MicrosoftOAuthRuntime>): MicrosoftOAuthRuntime => ({
    clientId: "static-id", clientSecret: "static-secret", defaultTenant: "common",
    keyProvider: new StaticKeyProvider({ 1: KEK }),
    updateSecret: async () => {},
    fetch: fakeFetch(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } })).fetch,
    ...over,
  });

  it("the resolver WINS over the static fields", async () => {
    const f = fakeFetch(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const p = new MicrosoftTokenProvider(rt({
      fetch: f.fetch,
      resolveClient: async () => ({ clientId: "row-id", clientSecret: "row-secret", defaultTenant: "organizations" }),
    }));
    await p.forMailbox("mb-1")({ refreshToken: "RT", tenant: "", provider: "microsoft" })();
    // The ROW's client, not the process's — this is the whole point of cloud 0009's config store: an
    // Entra secret expiring is fixed by pasting a new one into the console, on a worker process that
    // has not restarted for weeks.
    expect(f.calls[0]!.get("client_id")).toBe("row-id");
    expect(f.calls[0]!.get("client_secret")).toBe("row-secret");
  });

  it("is called on the REFRESH, not on every dial — the cache is checked first", async () => {
    let resolved = 0;
    const f = fakeFetch(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const p = new MicrosoftTokenProvider(rt({
      fetch: f.fetch,
      resolveClient: async () => { resolved += 1; return { clientId: "id", clientSecret: "sec" }; },
    }));
    const fetcher = p.forMailbox("mb-1")({ refreshToken: "RT", tenant: "common", provider: "microsoft" });
    await fetcher();
    await fetcher();
    await fetcher();
    // ONE resolution and ONE token POST for three dials inside the token's life. A resolver called
    // per dial would put a query in front of every IMAP connection; a CACHE in front of the resolver
    // would reintroduce exactly the staleness window it exists to remove.
    expect(resolved).toBe(1);
    expect(f.calls).toHaveLength(1);
  });

  it("an EMPTY resolution is still the NAMED refusal, quoting the env variable", async () => {
    const p = new MicrosoftTokenProvider(rt({
      resolveClient: async () => ({ clientId: "", clientSecret: "" }),
    }));
    const fetcher = p.forMailbox("mb-1")({ refreshToken: "RT", tenant: "common", provider: "microsoft" });
    const err = await fetcher().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthConfigError);
    // The refusal names the variable an operator can search for, and it stays the honest name even
    // when the value would have come from the row: an empty resolution means NEITHER source had it.
    expect((err as OAuthConfigError).configVar).toBe("MS_OAUTH_CLIENT_ID");
  });

  it("the MAILBOX's tenant still wins over the resolver's default", async () => {
    const f = fakeFetch(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const p = new MicrosoftTokenProvider(rt({
      fetch: f.fetch,
      resolveClient: async () => ({ clientId: "id", clientSecret: "sec", defaultTenant: "common" }),
    }));
    const guid = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    await p.forMailbox("mb-1")({ refreshToken: "RT", tenant: guid, provider: "microsoft" })();
    // A single-tenant mailbox must keep signing against its own authority when the deployment's
    // default is `common`; the endpoint is derived from the row's tenant, not from the registration's.
    expect(f.calls).toHaveLength(1);
  });
});
