import { describe, it, expect, beforeEach, vi } from "vitest";
import { createApp, apiRoutes, connectAttemptRecorder, type ApiDeps } from "@trafficflow/api";
import {
  mailboxes, mailboxCredentials, type Db, type Tx,
} from "@trafficflow/db";
import {
  connectAttempts, mailboxOauthCeremonies, oauthProviderConfig, OAUTH_CEREMONY_TTL_MS,
} from "@trafficflow/db/cloud";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { MS_AUTHORIZE_SCOPES, type FetchLike } from "@trafficflow/core";
import { and, eq } from "drizzle-orm";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * EXCHANGE / WEB ONBOARDING — the guards, each one written to fail first.
 *
 * The subject is not "the happy path works". It is the six properties that make a redirect ceremony
 * safe, and each one is asserted against the mechanism rather than against a message:
 *
 *  1. **REPLAY** — a `state` consumed once cannot be consumed again. Asserted here on the SEQUENTIAL
 *     case; the CONCURRENT case is `mailbox-oauth.pg.test.ts`, because PGlite is a single connection
 *     and structurally cannot interleave two UPDATEs (a read-then-write implementation passes here).
 *  2. **CROSS-ACCOUNT** — a `state` minted by account A, completed with account B's session, is 403.
 *  3. **TTL** — a ceremony older than ten minutes is refused, and refused DIFFERENTLY from a replay,
 *     because "that took too long" and "that link is not valid" are different sentences.
 *  4. **THE ADDRESS COMES FROM THE `id_token`** — never from the body. Driven by a fake token
 *     endpoint whose `preferred_username` disagrees with everything the caller sent.
 *  5. **PROBE BEFORE STORE** — a refused IMAP probe writes NO mailbox and NO credential, and on the
 *     reconnect path leaves the existing credential untouched.
 *  6. **RECONNECT TARGETS THE SAME ROW** — a second consent for an address that already has a live
 *     mailbox updates that row rather than creating a duplicate, and the credential is the new one.
 *
 * Plus: the registration is read from the config store with env as the fallback, a disabled row
 * refuses, and the bounce is not an open redirect.
 */

/** base64url, no padding — the encoding a JWT segment uses. */
const b64u = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

/**
 * A FAKE `id_token`. Header and signature are `x`: nothing in this flow verifies either, and the
 * reason is written out at {@link addressFromIdToken} — the token arrives in the body of a TLS
 * response to a POST this process made, authenticated with the confidential client's secret, which
 * is the case OIDC Core §3.1.3.7 permits skipping verification for. A test that signed it would be
 * asserting a property the implementation deliberately does not have.
 */
const idToken = (claims: Record<string, unknown>): string => `x.${b64u(JSON.stringify(claims))}.x`;

interface FakeTokenEndpoint {
  fetch: FetchLike;
  /** Every request body this endpoint received, parsed. The exchange's parameters are asserted. */
  calls: URLSearchParams[];
}

/**
 * A token endpoint that answers whatever the test needs.
 *
 * The DEFAULT is a complete, correct grant — access token, refresh token, and an `id_token` naming
 * the fixture account's address. A test that is about a failure arm overrides `respond`.
 */
function fakeTokenEndpoint(
  respond?: (form: URLSearchParams) => { ok: boolean; status: number; body: unknown },
): FakeTokenEndpoint {
  const calls: URLSearchParams[] = [];
  const fetch: FetchLike = async (url, init) => {
    // The ENDPOINT is asserted, not merely reached: the "Sensitive mail" invariant says the host is a constant in
    // `packages/core` and only the tenant segment comes from data. A test that accepted any URL
    // would not notice a stored token URL being reintroduced.
    expect(url).toMatch(/^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/);
    const form = new URLSearchParams(init.body);
    calls.push(form);
    const r = respond?.(form) ?? {
      ok: true,
      status: 200,
      body: {
        access_token: "ACCESS-TOKEN-1",
        refresh_token: "REFRESH-TOKEN-1",
        expires_in: 3600,
        id_token: idToken({ preferred_username: "oauth-user@contoso-com.example", sub: "opaque-sub" }),
      },
    };
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
  return { fetch, calls };
}

const app = createApp(apiRoutes);

const TENANT = "common";
const CLIENT_ID = "26dd5904-19d1-495d-bc3c-67aa2da6f5e3";
const REDIRECT = "https://ohmail.app/api/mailboxes/oauth/microsoft/callback";

/** The registration as an `oauth_provider_config` ROW — the source that wins over env. */
async function seedRegistrationRow(
  db: Db, deps: ApiDeps, over: Partial<{ enabled: boolean; clientId: string; tenant: string; redirectUris: string[] }> = {},
): Promise<void> {
  const enc = await deps.keyProvider.encrypt("THE-CLIENT-SECRET");
  await db.insert(oauthProviderConfig).values({
    provider: "microsoft",
    clientId: over.clientId ?? CLIENT_ID,
    clientSecretEnc: enc.ciphertext,
    clientSecretKeyVersion: enc.keyVersion,
    tenant: over.tenant ?? TENANT,
    redirectUris: over.redirectUris ?? [REDIRECT, "http://localhost"],
    scopes: [...MS_AUTHORIZE_SCOPES],
    enabled: over.enabled ?? true,
    updatedAt: FIXED_NOW,
  });
}

/** The registration as the ENV BOOTSTRAP — what a deployment with no row falls back to. */
const envBootstrap = {
  clientId: CLIENT_ID,
  clientSecret: "THE-CLIENT-SECRET",
  tenant: TENANT,
  redirectUri: REDIRECT,
};

interface World {
  db: Db;
  deps: ApiDeps;
  token: string;
  accountId: string;
  endpoint: FakeTokenEndpoint;
  H: (r: Request, over?: Partial<ApiDeps>) => Promise<Response>;
}

async function world(
  opts: { registration?: "row" | "env" | "none"; disabled?: boolean; record?: boolean } = {},
): Promise<World> {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const registration = opts.registration ?? "row";
  if (registration === "row") await seedRegistrationRow(db, deps, { enabled: !opts.disabled });
  const endpoint = fakeTokenEndpoint();
  const base: ApiDeps = {
    ...deps,
    appOrigin: "https://ohmail.app",
    oauthFetch: endpoint.fetch,
    ...(registration === "env" ? { msOAuth: envBootstrap } : {}),
    // The managed host's recorder (cloud 0054), where a case asks for it.
    ...(opts.record ? { connectAttempts: connectAttemptRecorder(db as unknown as Tx, deps.now) } : {}),
  };
  return {
    db, deps: base, token: s.token, accountId: s.accountId, endpoint,
    H: (r, over) => app.handle(r, { ...base, ...over, session: null, idempotency: null }),
  };
}

const startReq = (token: string, body: unknown = {}): Request =>
  req("POST", "/mailboxes/oauth/microsoft/start", { bearer: token, body: JSON.stringify(body) });

const completeReq = (token: string, state: string, code = "AUTH-CODE-1"): Request =>
  req("POST", "/mailboxes/oauth/microsoft/complete", { bearer: token, body: JSON.stringify({ state, code }) });

/** Run start and hand back the minted `state` plus the authorize URL it published. */
async function start(w: World, body: unknown = {}): Promise<{ state: string; authorizeUrl: string }> {
  const res = await w.H(startReq(w.token, body));
  expect(res.status, await res.clone().text()).toBe(201);
  const json = (await res.json()) as { data?: { state: string; authorizeUrl: string } } & { state?: string; authorizeUrl?: string };
  const payload = json.data ?? (json as { state: string; authorizeUrl: string });
  return { state: payload.state!, authorizeUrl: payload.authorizeUrl! };
}

beforeEach(() => { vi.restoreAllMocks(); });

describe("cloud 0009 — POST /mailboxes/oauth/microsoft/start", () => {
  it("mints a ceremony bound to the SESSION's account and a PKCE authorize URL", async () => {
    const w = await world();
    const { state, authorizeUrl } = await start(w);

    const [row] = await w.db.select().from(mailboxOauthCeremonies)
      .where(eq(mailboxOauthCeremonies.state, state));
    expect(row).toBeDefined();
    // THE ACCOUNT COMES FROM THE SESSION, never from the body (contract §1.9). This is the field
    // the callback's 403 compares against, so a ceremony bound to anything else is the whole
    // cross-account guard defeated at the source.
    expect(row!.accountId).toBe(w.accountId);
    expect(row!.consumedAt).toBeNull();
    // 256 bits, base64url — 43 characters with no padding.
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The verifier is ENCRYPTED at rest and is not the state.
    expect(row!.codeVerifierEnc).not.toContain(state);
    expect(row!.codeVerifierKeyVersion).toBeGreaterThan(0);
    const verifier = await w.deps.keyProvider.decrypt(row!.codeVerifierEnc, row!.codeVerifierKeyVersion);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const u = new URL(authorizeUrl);
    expect(u.origin).toBe("https://login.microsoftonline.com");
    expect(u.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("response_mode")).toBe("query");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("state")).toBe(state);
    // SHA-256 AND NEVER `plain`. `plain` in a redirect flow is no protection at all — the challenge
    // and the verifier are the same string — and there is no parameter that can select it.
    expect(u.searchParams.get("code_challenge_method")).toBe("S" + "256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("code_challenge")).not.toBe(verifier);
    // `select_account`: the default reuses whatever Microsoft session the browser holds, which on a
    // shared machine silently connects the wrong mailbox — and the address comes from the token, so
    // "silently" is exact.
    expect(u.searchParams.get("prompt")).toBe("select_account");
  });

  it("asks for openid + email as well as the mail scopes — without them there is no address", async () => {
    // RED FIRST: drop `openid`/`email` from `MS_AUTHORIZE_SCOPES` and the ceremony still completes,
    // the tokens are still valid, and `addressFromIdToken` returns null — a failure that reads as a
    // Microsoft problem. The scope list is therefore asserted as a SET, not as a prefix.
    const w = await world();
    const { authorizeUrl } = await start(w);
    const scopes = new URL(authorizeUrl).searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("openid");
    expect(scopes).toContain("email");
    expect(scopes).toContain("offline_access");
    // The SCOPE host is `outlook.office.com` — the Entra registration's resource identifier. The
    // IMAP host is `outlook.office365.com` and is a different string on purpose.
    expect(scopes).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(scopes).toContain("https://outlook.office.com/SMTP.Send");
    expect(scopes.join(" ")).not.toContain("outlook.office365.com");
  });

  it("carries a login_hint for a RECONNECT, and 404s a mailbox the account does not own", async () => {
    const w = await world();
    const [mine] = await w.db.insert(mailboxes).values({
      accountId: w.accountId, provider: "microsoft", address: "mine@contoso-com.example", authKind: "oauth",
    }).returning();
    const { authorizeUrl } = await start(w, { mailboxId: mine!.id });
    expect(new URL(authorizeUrl).searchParams.get("login_hint")).toBe("mine@contoso-com.example");

    // OWNERSHIP FIRST. Without the account-scoped read, a guessed uuid turns this route into a
    // "does this mailbox exist" oracle — the same reason `GET /mailboxes/:id/organizer` reads before
    // it dials.
    const other = await seedSession(w.db, { now: FIXED_NOW });
    const [theirs] = await w.db.insert(mailboxes).values({
      accountId: other.accountId, provider: "microsoft", address: "theirs@contoso-com.example", authKind: "oauth",
    }).returning();
    const res = await w.H(startReq(w.token, { mailboxId: theirs!.id }));
    expect(res.status).toBe(404);
    // …and nothing was minted for the refused attempt.
    const rows = await w.db.select().from(mailboxOauthCeremonies);
    expect(rows).toHaveLength(1);
  });

  it("REFUSES when the deployment has no registration, and when the row is DISABLED", async () => {
    const none = await world({ registration: "none" });
    const r1 = await none.H(startReq(none.token));
    expect(r1.status).toBe(503);
    expect(((await r1.json()) as { error: { code: string; details?: { gap?: string } } }).error.code)
      .toBe("oauth_unconfigured");

    // A DISABLED ROW REFUSES, and it must not fall back to env — an off switch an environment
    // variable can bypass is not a switch. Both are configured here; the row still wins.
    const off = await world({ disabled: true });
    const r2 = await off.H(startReq(off.token, {}), { msOAuth: envBootstrap });
    expect(r2.status).toBe(503);
    const body = (await r2.json()) as { error: { details?: { gap?: string; source?: string } } };
    expect(body.error.details?.gap).toBe("disabled");
    expect(body.error.details?.source).toBe("db");
    expect(await off.db.select().from(mailboxOauthCeremonies)).toHaveLength(0);
  });

  it("works from the ENV BOOTSTRAP alone — a deployment with no row is not broken", async () => {
    const w = await world({ registration: "env" });
    const { authorizeUrl } = await start(w);
    expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe(CLIENT_ID);
  });

  it("refuses an UNVERIFIED account — `cost: \"work\"`, the same class as POST /mailboxes", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, emailVerified: false });
    await seedRegistrationRow(db, deps);
    const res = await app.handle(
      startReq(s.token),
      { ...deps, appOrigin: "https://ohmail.app", session: null, idempotency: null },
    );
    expect(res.status).toBe(403);
    expect(await db.select().from(mailboxOauthCeremonies)).toHaveLength(0);
  });
});

describe("cloud 0009 — GET /mailboxes/oauth/microsoft/callback (the bounce)", () => {
  it("303s to the CONFIGURED origin and never to one from the request", async () => {
    const w = await world();
    const res = await w.H(req("GET", "/mailboxes/oauth/microsoft/callback?state=abc&code=xyz"));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    // The origin is `deps.appOrigin`, NOT `new URL(req.url).origin` (which is `http://localhost`
    // in this harness). If it were derived from the request, this is the assertion that fails.
    expect(loc.origin).toBe("https://ohmail.app");
    /*
     * `/`, THE APP'S ONE PUBLIC URL — and this line is a production repair, not tidying.
     *
     * The bounce used to target `/mailbox`, which `apps/webapp/app/session-gate.ts` calls an internal
     * rewrite target and *"never a URL a human types or a link points at"*, and which `middleware.ts`
     * answers with a **308 back to `/`**. That extra hop is where a consent was lost on 2026-08-10: the
     * 308's `Location` carries no fragment, fragment inheritance across a redirect is a browser SHOULD
     * rather than a MUST, and the fragment is the only thing that selects the view (`parseHash("")` is
     * `ohbox`). The user landed on the Ohbox with the ceremony parameters unread in the query, and the
     * ceremony row stayed `consumed_at IS NULL`.
     */
    expect(loc.pathname, "one hop, to the app's only public address").toBe("/");
    expect(loc.searchParams.get("oauth")).toBe("pending");
    expect(loc.searchParams.get("state")).toBe("abc");
    expect(loc.searchParams.get("code")).toBe("xyz");
    expect(loc.searchParams.get("settings")).toBe("mailboxes");
    expect(loc.hash).toBe("#/settings");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("reads NOTHING and WRITES NOTHING — it cannot, and that is the design", async () => {
    const w = await world({ record: true });
    const { state } = await start(w);
    await w.H(req("GET", `/mailboxes/oauth/microsoft/callback?state=${state}&code=xyz`));
    // The ceremony is UNSPENT after the bounce. If the bounce consumed it, the same browser's
    // follow-up POST would be refused as a replay and the flow could never complete.
    const [row] = await w.db.select().from(mailboxOauthCeremonies)
      .where(eq(mailboxOauthCeremonies.state, state));
    expect(row!.consumedAt).toBeNull();
    // Nor a connect record (cloud 0054): the one row is the start's, recorded ok.
    expect(await w.db.select({ door: connectAttempts.door, preset: connectAttempts.preset, outcome: connectAttempts.outcome })
      .from(connectAttempts)).toEqual([{ door: "oauth_start", preset: "microsoft", outcome: "ok" }]);
  });

  it("refuses to reflect a value that could break out of the Location header", async () => {
    const w = await world();
    /*
     * PERCENT-ENCODED, so the DECODED VALUE carries the dangerous characters. The first version of
     * this list used `a&code=other` and `a#frag` raw and PASSED for the wrong reason: `&` and `#` are
     * query SEPARATORS, so `searchParams.get("state")` returned a bare `"a"` — a perfectly valid
     * state — and the assertion was measuring URL parsing rather than the guard. Written out because
     * a guard nobody has watched fail is not evidence.
     */
    for (const bad of [
      "a%0d%0aSet-Cookie:%20x=1",   // CR/LF — header splitting
      "a%26code%3Dother",           // & and = — a smuggled second parameter
      "a%23frag",                   // # — a smuggled fragment
      "https%3A%2F%2Fevil.example%2F",
      "a".repeat(4096),             // unbounded input in a response header
    ]) {
      const res = await w.H(req("GET", `/mailboxes/oauth/microsoft/callback?state=${bad}&code=xyz`));
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin).toBe("https://ohmail.app");
      expect(loc.searchParams.get("oauth")).toBe("error");
      expect(loc.searchParams.get("reason")).toBe("state_invalid");
      expect(loc.searchParams.get("state")).toBeNull();
    }
  });

  it("passes a LONG authorization code through — a real Microsoft code is not a forged one", async () => {
    const w = await world();
    /*
     * The cap on the `code` was 2048 and Microsoft's v2.0 codes for a work account are long — over a
     * kilobyte routinely, and they grow with the tenant's configuration. A code one byte over the cap
     * was answered with `state_invalid`, whose sentence is *"That Outlook connection link is no longer
     * valid"* — the copy for a FORGED or REPLAYED value, shown to somebody whose consent had just
     * succeeded, with no way to tell the two apart. The bound is still finite (8192); what changed is
     * that it is no longer tight enough to refuse the real thing.
     */
    const long = `0.${"AaBbCc09-_~.".repeat(200)}`; // 2402 characters, base64url plus what MS uses
    expect(long.length).toBeGreaterThan(2048);
    const res = await w.H(req("GET", `/mailboxes/oauth/microsoft/callback?state=abc&code=${long}`));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("oauth"), "a long code is PENDING, not invalid").toBe("pending");
    expect(loc.searchParams.get("code")).toBe(long);
    // …and `complete` accepts the same value rather than 400ing on its own copy of the bound. The
    // ceremony is unknown here, so the answer is the state's refusal — never `validation_failed`,
    // which is what a code the body validator rejected would produce.
    const done = await w.H(req("POST", "/mailboxes/oauth/microsoft/complete", {
      bearer: w.token, body: JSON.stringify({ state: "no-such-state", code: long }),
    }));
    expect(((await done.json()) as { error: { code: string } }).error.code)
      .toBe("oauth_state_invalid");
  });

  it("classifies the provider's own refusals — and admin-consent is tested BEFORE access_denied", async () => {
    const w = await world();
    const reason = async (qs: string): Promise<string> => {
      const res = await w.H(req("GET", `/mailboxes/oauth/microsoft/callback?${qs}`));
      return new URL(res.headers.get("location")!).searchParams.get("reason")!;
    };

    expect(await reason("error=consent_required")).toBe("admin_consent_required");
    expect(await reason("error=access_denied&error_description=AADSTS65001%3A%20not%20consented"))
      .toBe("admin_consent_required");
    // THE ORDER IS THE FINDING. A tenant that RESTRICTS user consent sends `access_denied` WITH
    // `AADSTS65001`. Testing `access_denied` first would tell every user in such a tenant that they
    // declined a screen they were never allowed to accept — a confident lie about their own action.
    // Swap the two arms in `classifyConsentFailure` and this line goes red while the next passes.
    expect(await reason("error=access_denied&error_description=AADSTS90094%3A%20admin%20permission"))
      .toBe("admin_consent_required");
    expect(await reason("error=access_denied")).toBe("consent_declined");
    expect(await reason("error=access_denied&error_subcode=cancel")).toBe("consent_declined");
    expect(await reason("error=access_denied&error_description=AADSTS65004%3A%20user%20declined"))
      .toBe("consent_declined");
    expect(await reason("error=server_error")).toBe("consent_failed");
    // Microsoft's own prose NEVER reaches the URL: it carries request ids, timestamps and can echo
    // the redirect URI, and this Location is a string a user can paste into a support ticket.
    const res = await w.H(req(
      "GET",
      "/mailboxes/oauth/microsoft/callback?error=server_error&error_description=Trace%20ID%3A%20abc-123",
    ));
    expect(res.headers.get("location")).not.toContain("abc-123");
    expect(res.headers.get("location")).not.toContain("Trace");
  });
});

describe("cloud 0009 — POST /mailboxes/oauth/microsoft/complete", () => {
  it("REPLAY: the second completion of one state is refused, and writes nothing", async () => {
    const w = await world();
    const { state } = await start(w);

    const first = await w.H(completeReq(w.token, state));
    expect(first.status, await first.clone().text()).toBe(201);
    expect(w.endpoint.calls).toHaveLength(1);

    const second = await w.H(completeReq(w.token, state));
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("oauth_state_invalid");
    // AND THE REPLAY NEVER REACHED MICROSOFT. The consume is the FIRST thing `complete` does, so a
    // replayed request cannot make this process POST to a third party. Move the consume below the
    // exchange and this assertion is the one that fails.
    expect(w.endpoint.calls).toHaveLength(1);
    // …and there is still exactly one mailbox.
    expect(await w.db.select().from(mailboxes)).toHaveLength(1);
  });

  it("an UNKNOWN state and a SPENT state are the same answer — no issuance oracle", async () => {
    const w = await world();
    const { state } = await start(w);
    await w.H(completeReq(w.token, state));

    const spent = await w.H(completeReq(w.token, state));
    const never = await w.H(completeReq(w.token, "n".repeat(43)));
    expect(never.status).toBe(spent.status);
    expect(((await never.json()) as { error: { code: string } }).error.code)
      .toBe(((await spent.json()) as { error: { code: string } }).error.code);
  });

  it("CROSS-ACCOUNT: account B cannot complete account A's ceremony (403), and nothing is stored", async () => {
    const w = await world();
    const { state } = await start(w);

    const other = await seedSession(w.db, { now: FIXED_NOW });

    const res = await w.H(completeReq(other.token, state));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { details?: { reason?: string } } }).error.details?.reason)
      .toBe("account_mismatch");
    // BEFORE THE EXCHANGE. A stolen `state` must not be usable to burn somebody else's ceremony AND
    // learn whether the exchange would have worked. Move the account check below the exchange and
    // this goes red.
    expect(w.endpoint.calls).toHaveLength(0);
    expect(await w.db.select().from(mailboxes)).toHaveLength(0);
    expect(await w.db.select().from(mailboxCredentials)).toHaveLength(0);

    // …and the state is SPENT, so the thief cannot hand it back to the account holder either.
    const owner = await w.H(completeReq(w.token, state));
    expect(owner.status).toBe(400);
  });

  it("TTL: a ceremony older than ten minutes is refused, and DIFFERENTLY from a replay", async () => {
    const w = await world();
    const { state } = await start(w);
    const late = new Date(FIXED_NOW.getTime() + OAUTH_CEREMONY_TTL_MS + 1_000);

    const res = await w.H(completeReq(w.token, state), { now: () => late });
    expect(res.status).toBe(400);
    // A DISTINCT code, because "that took too long — start again" is actionable and "that link is
    // not valid" is not. Collapsing the two into one refusal is the thing this asserts against.
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("oauth_state_expired");
    expect(w.endpoint.calls).toHaveLength(0);
    expect(await w.db.select().from(mailboxes)).toHaveLength(0);

    // The expired row is CONSUMED, so nudging the clock back does not revive it.
    const retry = await w.H(completeReq(w.token, state));
    expect(((await retry.json()) as { error: { code: string } }).error.code).toBe("oauth_state_invalid");
  });

  it("sends the CONFIDENTIAL-client exchange: id + secret + verifier + the EXACT redirect uri", async () => {
    const w = await world();
    const { state, authorizeUrl } = await start(w);
    const [row] = await w.db.select().from(mailboxOauthCeremonies)
      .where(eq(mailboxOauthCeremonies.state, state));
    const verifier = await w.deps.keyProvider.decrypt(row!.codeVerifierEnc, row!.codeVerifierKeyVersion);

    await w.H(completeReq(w.token, state, "THE-AUTH-CODE"));
    const form = w.endpoint.calls[0]!;
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("THE-AUTH-CODE");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe("THE-CLIENT-SECRET");
    expect(form.get("code_verifier")).toBe(verifier);
    // THE SAME redirect_uri THE AUTHORIZE REQUEST NAMED. Microsoft compares the two byte-for-byte,
    // so asserting the pair rather than the literal is what catches the two sides diverging.
    expect(form.get("redirect_uri")).toBe(new URL(authorizeUrl).searchParams.get("redirect_uri"));
  });

  it("THE ADDRESS COMES FROM THE `id_token`, not from anything the caller sent", async () => {
    const w = await world();
    const { state } = await start(w);
    // The body carries an address, a provider and a host. None of them may reach the row.
    const res = await w.H(req("POST", "/mailboxes/oauth/microsoft/complete", {
      bearer: w.token,
      body: JSON.stringify({
        state, code: "AUTH-CODE-1",
        address: "attacker@evil.example",
        provider: "imap",
        imap: { host: "imap.evil.example", port: 143, secure: false },
      }),
    }));
    expect(res.status).toBe(201);
    const [mb] = await w.db.select().from(mailboxes);
    // The claim wins.
    expect(mb!.address).toBe("oauth-user@contoso-com.example");
    expect(mb!.provider).toBe("microsoft");
    expect(mb!.authKind).toBe("oauth");
    const [cred] = await w.db.select().from(mailboxCredentials);
    const meta = cred!.meta as Record<string, unknown>;
    // The host is the SERVER-SIDE preset, not the body's. A refresh token is only good against
    // Microsoft's servers, so the host is an argument with exactly one correct value.
    expect(meta.host).toBe("outlook.office365.com");
    expect(meta.user).toBe("oauth-user@contoso-com.example");
    expect(meta.authType).toBe("oauth2");
    expect(meta.provider).toBe("microsoft");
    expect(meta.tenant).toBe(TENANT);
    expect(meta.smtp).toEqual({ host: "smtp.office365.com", port: 587, secure: false });
    // THE STORED SECRET IS THE REFRESH TOKEN, encrypted — never the access token, which expires in
    // an hour, and never in plaintext.
    expect(cred!.secretEnc).not.toContain("REFRESH-TOKEN-1");
    expect(await w.deps.keyProvider.decrypt(cred!.secretEnc, cred!.keyVersion)).toBe("REFRESH-TOKEN-1");
  });

  it("refuses a claim that is not an address, and a grant with no refresh token", async () => {
    // `preferred_username` is a display name or a phone number on some account types, and either
    // would be stored as an address no mail server has ever heard of.
    const noAddr = await world();
    noAddr.deps.oauthFetch = fakeTokenEndpoint(() => ({
      ok: true, status: 200,
      body: { access_token: "A", refresh_token: "R", expires_in: 3600, id_token: idToken({ sub: "opaque", preferred_username: "Mila G" }) },
    })).fetch;
    const s1 = await start(noAddr);
    const r1 = await noAddr.H(completeReq(noAddr.token, s1.state), { oauthFetch: noAddr.deps.oauthFetch });
    expect(((await r1.json()) as { error: { code: string } }).error.code).toBe("oauth_no_address");
    expect(await noAddr.db.select().from(mailboxes)).toHaveLength(0);

    // No `offline_access` in the granted scopes. The tokens are valid and useless: an access token
    // lasts an hour and there is nothing to renew it with. Refused, rather than stored to fail in
    // sixty minutes with a sentence about the user's consent.
    const noRefresh = await world();
    const fake = fakeTokenEndpoint(() => ({
      ok: true, status: 200,
      body: { access_token: "A", expires_in: 3600, id_token: idToken({ preferred_username: "x@contoso-com.example" }) },
    }));
    const s2 = await start(noRefresh);
    const r2 = await noRefresh.H(completeReq(noRefresh.token, s2.state), { oauthFetch: fake.fetch });
    expect(((await r2.json()) as { error: { code: string } }).error.code).toBe("oauth_no_refresh_token");
    expect(await noRefresh.db.select().from(mailboxes)).toHaveLength(0);
  });

  it("maps the exchange's failures to three DIFFERENT answers, and never blames the mailbox", async () => {
    // `invalid_client` is OUR secret being rejected. It must never be rendered as the user's fault,
    // and it must not be a 503 that reads as a Microsoft outage.
    const badSecret = await world();
    const s1 = await start(badSecret);
    const r1 = await badSecret.H(completeReq(badSecret.token, s1.state), {
      oauthFetch: fakeTokenEndpoint(() => ({ ok: false, status: 401, body: { error: "invalid_client" } })).fetch,
    });
    expect(r1.status).toBe(502);
    const b1 = (await r1.json()) as { error: { code: string; message: string } };
    expect(b1.error.code).toBe("oauth_exchange_failed");
    expect(b1.error.message).toMatch(/deployment|operator/i);

    // A 5xx is "we could not ask". Retryable, and NOT a verdict about anything.
    const down = await world();
    const s2 = await start(down);
    const r2 = await down.H(completeReq(down.token, s2.state), {
      oauthFetch: fakeTokenEndpoint(() => ({ ok: false, status: 503, body: {} })).fetch,
    });
    expect(r2.status).toBe(503);
    expect(((await r2.json()) as { error: { details?: { reason?: string } } }).error.details?.reason)
      .toBe("provider_unavailable");

    // `invalid_grant` HERE is not the re-auth verdict it is on the refresh path: there is no stored
    // mailbox to quarantine, only this attempt to refuse. It must not produce a message telling
    // somebody a mailbox they do not yet have needs reconnecting.
    const dead = await world();
    const s3 = await start(dead);
    const r3 = await dead.H(completeReq(dead.token, s3.state), {
      oauthFetch: fakeTokenEndpoint(() => ({ ok: false, status: 400, body: { error: "invalid_grant" } })).fetch,
    });
    expect(r3.status).toBe(502);
    expect(((await r3.json()) as { error: { code: string } }).error.code).toBe("oauth_exchange_failed");
  });

  it("PROBE BEFORE STORE: a refused IMAP probe writes no mailbox and no credential", async () => {
    const w = await world();
    const { state } = await start(w);
    // The dialler is stubbed suite-wide to SUCCEED; this test re-spies it to fail the way a mail
    // server refusing a login fails, which wins because it is installed second.
    vi.spyOn(ImapAdapter.prototype, "connect").mockRejectedValue(
      Object.assign(new Error("Invalid credentials"), { authenticationFailed: true }),
    );

    const res = await w.H(completeReq(w.token, state));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("mailbox_probe_failed");
    // NOTHING WAS WRITTEN. Move the probe after the transaction in `connectOAuth` and both of these
    // go red.
    expect(await w.db.select().from(mailboxes)).toHaveLength(0);
    expect(await w.db.select().from(mailboxCredentials)).toHaveLength(0);
  });

  it("each refusal is recorded by its own word, a completion as ok, and never the address (cloud 0054)", async () => {
    const w = await world({ record: true });
    const fresh = async (): Promise<string> => (await start(w)).state;
    const grant = (body: unknown, ok = true, status = 200): Partial<ApiDeps> =>
      ({ oauthFetch: fakeTokenEndpoint(() => ({ ok, status, body })).fetch });
    const other = await seedSession(w.db, { now: FIXED_NOW });
    await w.H(completeReq(w.token, "n".repeat(43)));
    await w.H(completeReq(w.token, await fresh()), { now: () => new Date(FIXED_NOW.getTime() + OAUTH_CEREMONY_TTL_MS + 1_000) });
    await w.H(completeReq(other.token, await fresh()));
    await w.H(completeReq(w.token, await fresh()), grant({}, false, 503));
    await w.H(completeReq(w.token, await fresh()), grant({ error: "invalid_grant" }, false, 400));
    await w.H(completeReq(w.token, await fresh()), grant({ access_token: "A", expires_in: 3600, id_token: idToken({ preferred_username: "x@contoso-com.example" }) }));
    await w.H(completeReq(w.token, await fresh()), grant({ access_token: "A", refresh_token: "R", expires_in: 3600, id_token: idToken({ preferred_username: "Mila G" }) }));
    vi.spyOn(ImapAdapter.prototype, "connect").mockRejectedValueOnce(
      Object.assign(new Error("Invalid credentials"), { authenticationFailed: true }));
    await w.H(completeReq(w.token, await fresh()));
    expect((await w.H(completeReq(w.token, await fresh()))).status).toBe(201);
    const last = await fresh();
    await w.db.update(oauthProviderConfig).set({ enabled: false });
    await w.H(completeReq(w.token, last));

    const done: Array<typeof connectAttempts.$inferSelect> =
      await w.db.select().from(connectAttempts).where(eq(connectAttempts.door, "oauth_complete"));
    expect(done.map((r) => r.reason).sort()).toEqual([
      "state_invalid", "state_expired", "account_mismatch", "provider_unavailable", "exchange_failed",
      "no_refresh_token", "no_address", "auth", null, "oauth_unconfigured",
    ].sort());
    expect(done.find((r) => r.reason === "auth")).toMatchObject({ preset: "microsoft", outcome: "refused", transport: "imap" });
    expect(JSON.stringify(done)).not.toContain("contoso");
  });

  it("the probe dials with the FRESH ACCESS TOKEN, not with the refresh token", async () => {
    const w = await world();
    const { state } = await start(w);
    const seen: unknown[] = [];
    // `ImapAdapter` resolves `fetchAccessToken()` inside `connect()`, so the value the probe would
    // put on the wire is observable from here.
    vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async function (this: ImapAdapter) {
      const cfg = (this as unknown as { cfg?: { auth?: unknown }; config?: { auth?: unknown } });
      const auth = (cfg.cfg ?? cfg.config)?.auth as { user?: string; pass?: string; fetchAccessToken?: () => Promise<string> };
      seen.push({ user: auth?.user, pass: auth?.pass, token: auth?.fetchAccessToken ? await auth.fetchAccessToken() : undefined });
    });

    await w.H(completeReq(w.token, state));
    expect(seen).toHaveLength(1);
    const got = seen[0] as { user?: string; pass?: string; token?: string };
    expect(got.token).toBe("ACCESS-TOKEN-1");
    // AND NEVER A PASSWORD. A refresh token handed to imapflow as an IMAP LOGIN password is the
    // single deadliest failure this feature can produce; `buildImapAuth` exists to make it
    // unrepresentable, and this is the assertion on the one path that does not go through it.
    expect(got.pass).toBeUndefined();
    expect(got.user).toBe("oauth-user@contoso-com.example");
  });

  it("RECONNECT: a second consent updates the SAME row — no duplicate, and the new credential", async () => {
    const w = await world();
    const first = await start(w);
    const r1 = await w.H(completeReq(w.token, first.state));
    expect(r1.status).toBe(201);
    const [before] = await w.db.select().from(mailboxes);

    // Quarantine it the way the worker would, so the reconnect has an outage episode to end.
    await w.db.update(mailboxes).set({
      status: "error", errorCode: "auth", errorDetail: "OAUTH_INVALID_GRANT",
      failedAt: FIXED_NOW, retryCount: 9,
    }).where(eq(mailboxes.id, before!.id));

    const second = await start(w, { mailboxId: before!.id });
    const rotated = fakeTokenEndpoint(() => ({
      ok: true, status: 200,
      body: {
        access_token: "ACCESS-TOKEN-2", refresh_token: "REFRESH-TOKEN-2", expires_in: 3600,
        id_token: idToken({ preferred_username: "oauth-user@contoso-com.example" }),
      },
    }));
    const r2 = await w.H(completeReq(w.token, second.state), { oauthFetch: rotated.fetch });
    // 200, NOT 201: `created: false` is what tells the client to say "reconnected" rather than
    // "connected", which is a different thing to somebody who was fixing a broken mailbox.
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { created: boolean }).created).toBe(false);

    // ONE mailbox, the SAME id. mail 0021's `mailboxes_active_address_uq` makes at most one live row
    // per (account, lower(address)); a create here would have raised 23505 → 409 instead.
    const after = await w.db.select().from(mailboxes);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before!.id);
    // THE OUTAGE EPISODE IS ENDED, all four columns together. `markMailboxFailed` COALESCEs
    // `failed_at`, so a value left behind here is inherited by the next unrelated failure and
    // reported as a nine-attempt multi-day outage.
    expect(after[0]!.status).toBe("connected");
    expect(after[0]!.errorCode).toBeNull();
    expect(after[0]!.errorDetail).toBeNull();
    expect(after[0]!.failedAt).toBeNull();
    expect(after[0]!.retryCount).toBe(0);

    // …and the credential is the NEW refresh token.
    const [cred] = await w.db.select().from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, before!.id), eq(mailboxCredentials.transport, "imap")));
    expect(await w.deps.keyProvider.decrypt(cred!.secretEnc, cred!.keyVersion)).toBe("REFRESH-TOKEN-2");
  });

  it("a reconnect of a PASSWORD mailbox drops its dead smtp credential row", async () => {
    const w = await world();
    const [mb] = await w.db.insert(mailboxes).values({
      accountId: w.accountId, provider: "microsoft", address: "oauth-user@contoso-com.example", authKind: "password",
    }).returning();
    const enc = await w.deps.keyProvider.encrypt("the-old-password");
    for (const transport of ["imap", "smtp"] as const) {
      await w.db.insert(mailboxCredentials).values({
        mailboxId: mb!.id, transport, secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
        meta: { host: "outlook.office365.com", port: 993, secure: true, user: "oauth-user@contoso-com.example" },
        updatedAt: FIXED_NOW,
      });
    }

    const { state } = await start(w);
    expect((await w.H(completeReq(w.token, state))).status).toBe(200);

    const creds = await w.db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mb!.id));
    // The smtp row held an encrypted password that is now dead. Keeping a dead credential because
    // it happens not to be read on the oauth branch is how it gets read later.
    expect(creds.map((c) => c.transport)).toEqual(["imap"]);
    const [row] = await w.db.select().from(mailboxes).where(eq(mailboxes.id, mb!.id));
    expect(row!.authKind).toBe("oauth");
  });
});

/**
 * THE CAPABILITY THE WEBAPP READS to decide whether to offer the Outlook door. Two properties:
 * it agrees with what `…/start` will ACCEPT (so a shown button is never a 503), and it leaks
 * NOTHING about the registration but the verdict (so the client id, tenant and secret stay on the
 * server). The `available` truth table is pinned to the SAME fixtures `…/start`'s refusals use.
 */
describe("cloud 0009 — GET /mailboxes/oauth/microsoft/availability", () => {
  const availabilityReq = (token: string): Request =>
    req("GET", "/mailboxes/oauth/microsoft/availability", { bearer: token });

  const readAvailability = async (res: Response): Promise<{ available?: boolean; text: string }> => {
    const text = await res.clone().text();
    const json = JSON.parse(text) as { data?: { available: boolean }; available?: boolean };
    return { available: (json.data ?? json).available, text };
  };

  it("is TRUE for a complete, enabled registration — the case `…/start` mints a ceremony for", async () => {
    const w = await world();
    const res = await w.H(availabilityReq(w.token));
    expect(res.status).toBe(200);
    expect((await readAvailability(res)).available).toBe(true);
  });

  it("is FALSE with no registration, and FALSE for a DISABLED row env cannot bypass", async () => {
    const none = await world({ registration: "none" });
    expect((await readAvailability(await none.H(availabilityReq(none.token)))).available).toBe(false);

    // A disabled row, with env ALSO present. `…/start` refuses this (gap `disabled`), and the door
    // must be hidden for exactly the same reason — an off switch a variable can bypass is not one.
    const off = await world({ disabled: true });
    const res = await off.H(availabilityReq(off.token), { msOAuth: envBootstrap });
    expect((await readAvailability(res)).available).toBe(false);
  });

  it("returns ONLY the verdict — no client id, secret or redirect URI crosses to the browser", async () => {
    const w = await world();
    const { text, available } = await readAvailability(await w.H(availabilityReq(w.token)));
    expect(available).toBe(true);
    // Asserted over the SERIALIZED body, the way `admin-oauth.test.ts` does it: a field-by-field
    // check only covers the fields somebody remembered to name. These three are what a browser must
    // never receive, and the resolver behind this route holds all of them.
    expect(text).not.toContain(CLIENT_ID);
    expect(text).not.toContain("THE-CLIENT-SECRET");
    expect(text).not.toContain(REDIRECT);
  });
});
