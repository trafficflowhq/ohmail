import { createHash, randomUUID } from "node:crypto";
import { intlZones } from "@ohmail/cal-core";
import { parseCredential } from "@ohmail/cal-providers/connect";
import type { CalendarProvider } from "@ohmail/cal-providers";
import { calendarPool, newCalendarSyncMemory } from "@ohmail/organizer/calendar-sync";
import { calendarSyncPass } from "@ohmail/organizer/calendar-sync-pass";
import { describe, expect, it, vi } from "vitest";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { calendarRoutes } from "@trafficflow/api/calendar";
import { createLogger, type FetchLike } from "@trafficflow/core";
import { createOAuthCeremony, resolveOAuthProviderConfig } from "@trafficflow/db/cloud";
import { calConnections, calCredentials, calSettings } from "@trafficflow/db/mail";
import { CALENDAR_CONNECTION_CEILING } from "@trafficflow/services/calendar-connect";
import { calendarFeed } from "@trafficflow/services/calendar";
import { FIXED_NOW, makeDeps, req, seedSession } from "../packages/api/test/helpers.js";

const app = createApp([...apiRoutes, ...calendarRoutes]);
const apiOrigin = "https://api.example.test";
const appOrigin = "https://app.example.test";
const googleScopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
type Provider = "google" | "microsoft";
const path = (provider: Provider, step: string) => `/calendar/oauth/${provider}/${step}`;

async function rig() {
  const { db, deps, clock } = await makeDeps();
  const session = await seedSession(db, { now: FIXED_NOW });
  const other = await seedSession(db, { now: FIXED_NOW });
  await db.insert(calSettings).values([session, other].map(({ accountId }) => ({ accountId, enabledAt: FIXED_NOW })));
  const clientSecret = randomUUID();
  const accessToken = randomUUID();
  const refreshToken = randomUUID();
  const code = randomUUID();
  const lines: string[] = [];
  const responses: string[] = [];
  const fetchToken = vi.fn<FetchLike>(async () => new Response(JSON.stringify({
    access_token: accessToken, refresh_token: refreshToken, scope: googleScopes.join(" "), expires_in: 3600,
  })));
  deps.logger = createLogger({ service: "api", level: "debug", sink: (line) => lines.push(line) });
  deps.appOrigin = appOrigin;
  deps.msOAuth = { clientId: "fixture-microsoft", clientSecret, tenant: "organizations", redirectUri: `${appOrigin}/mail/callback` };
  deps.oauthFetch = fetchToken;
  const on = { on: true, configured: true };
  deps.services = {
    ...deps.services,
    calendar: calendarFeed,
    calendarConnect: { policy: "cloud", ceremonies: { google: on, microsoft: on } },
    calendarOAuth: { origin: apiOrigin, google: { clientId: "fixture-google", clientSecret } },
  } as ApiDeps["services"];
  const ask = async (method: string, route: string, body?: unknown, as = session.token) => {
    const response = await app.handle(req(method, route, {
      ...(as ? { bearer: as } : {}), headers: { "x-requested-with": "ohmail" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { ...deps, session: null, idempotency: null });
    responses.push(JSON.stringify([...response.headers]) + await response.clone().text());
    return response;
  };
  const start = async (provider: Provider) => {
    const res = await ask("POST", path(provider, "start"), {});
    expect(res.status).toBe(201);
    return new URL((await res.json()).authorizeUrl);
  };
  const complete = (provider: Provider, state: string | null, as?: string) =>
    ask("POST", path(provider, "complete"), { state, code }, as);
  const connections = () => db.select().from(calConnections);
  return { db, deps, clock, session, other, ask, start, complete, connections, fetchToken, lines, responses, code, clientSecret, accessToken, refreshToken };
}

async function reason(res: Response) {
  return [res.status, (await res.json()).error?.details?.reason];
}

describe("calendar OAuth", () => {
  it.each(["google", "microsoft"] as const)("exchanges %s once, seals the refresh credential and records the account's connection", async (provider) => {
    const r = await rig();
    if (provider === "microsoft") {
      r.fetchToken.mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: r.accessToken, refresh_token: r.refreshToken, scope: "Calendars.ReadWrite", expires_in: 3600,
      })));
    }
    const ways = await (await r.ask("GET", "/calendar/connect")).json();
    expect(ways.ways).toContain(provider);
    const authorize = await r.start(provider);
    const state = authorize.searchParams.get("state");
    const redirectUri = `${apiOrigin}${path(provider, "callback")}`;
    expect(authorize.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S" + "256");

    const callback = await r.ask("GET", path(provider, "callback") + "?" + new URLSearchParams({ state: state!, code: r.code }), undefined, "");
    expect(callback.status).toBe(303);
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
    const landing = new URL(callback.headers.get("location")!);
    expect(landing.origin).toBe(appOrigin);
    expect(landing.search).toBe("");
    const params = new URLSearchParams(landing.hash.split("?")[1]);
    expect(params.get("provider")).toBe(provider);
    expect(r.fetchToken).not.toHaveBeenCalled();
    const done = await r.ask("POST", path(provider, "complete"), { state: params.get("state"), code: params.get("code") });
    expect(done.status).toBe(201);
    const { connectionId } = await done.json();
    expect(await reason(await r.complete(provider, state))).toEqual([400, "state_invalid"]);
    expect(r.fetchToken).toHaveBeenCalledTimes(1);
    const [endpoint, init] = r.fetchToken.mock.calls[0]!;
    const form = new URLSearchParams(init.body);
    expect(form.get("redirect_uri")).toBe(redirectUri);
    expect(form.get("client_secret") === r.clientSecret).toBe(true);
    expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"))
      .toBe(authorize.searchParams.get("code_challenge"));
    if (provider === "google") {
      expect(authorize.searchParams.get("scope")?.split(" ")).toEqual(googleScopes);
      expect(authorize.searchParams.get("access_type")).toBe("offline");
    } else {
      expect(new URL(endpoint).pathname).toBe("/common/oauth2/v2.0/token");
      expect(authorize.searchParams.get("scope")).toBe("Calendars.ReadWrite offline_access");
    }
    expect(await r.connections()).toMatchObject([{ id: connectionId, accountId: r.session.accountId, provider, status: "active", nextPollAt: expect.any(Date) }]);
    const [saved] = await r.db.select().from(calCredentials);
    expect(saved).toMatchObject({ accountId: r.session.accountId, connectionId, kind: "oauth" });
    expect(saved!.secretEnc.includes(r.refreshToken)).toBe(false);
    const clear = await r.deps.keyProvider.decrypt(saved!.secretEnc, saved!.keyVersion);
    const stored = parseCredential(clear, { accountId: r.session.accountId, connectionId });
    expect(stored?.kind === "oauth" && stored.provider === provider && stored.refreshToken.reveal() === r.refreshToken).toBe(true);
    expect(parseCredential(clear, { accountId: r.other.accountId, connectionId })).toBe(null);

    const short = randomUUID();
    const renew = vi.fn<CalendarProvider["http"]["request"]>(async (url, request) => {
      const body = new URLSearchParams(request.body ?? "");
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token") === r.refreshToken).toBe(true);
      if (provider === "microsoft") expect(new URL(url).pathname).toBe("/common/oauth2/v2.0/token");
      return {
        arrived: true, status: 200, url, header: () => null, location: null, hops: 0,
        body: Buffer.from(JSON.stringify({ access_token: short, expires_in: 3600 })),
      };
    });
    const upstream: CalendarProvider = {
      http: { request: renew }, writer: null, notices: null,
      reader: {
        provider,
        async listCalendars(connection, signal) {
          const credential = connection.credential;
          expect(credential.kind).toBe("bearer");
          if (credential.kind !== "bearer") throw new Error("Expected an OAuth credential");
          const renewed = await credential.accessToken(signal);
          expect(renewed.ok && renewed.token === short).toBe(true);
          return { ok: true, value: [] };
        },
        async checkSignIn() { throw new Error("Unexpected sign-in probe"); },
        async readChanges() { throw new Error("Unexpected calendar read"); },
      },
    };
    expect(await calendarSyncPass({
      db: calendarPool(r.db), log: r.deps.logger!,
      providers: { get: () => upstream }, keys: r.deps.keyProvider, zones: intlZones(),
      clock: { now: () => r.clock.now().getTime() }, memory: newCalendarSyncMemory(),
      halted: () => false, random: () => 0.5,
      oauth: {
        google: r.deps.services!.calendarOAuth!.google,
        microsoft: async (kind) => {
          expect(kind).toBe("confidential");
          const resolved = await resolveOAuthProviderConfig({
            tx: r.db, decrypt: (ct, kv) => r.deps.keyProvider.decrypt(ct, kv), bootstrap: r.deps.msOAuth,
          });
          return { clientId: resolved.clientId, clientSecret: resolved.clientSecret, defaultTenant: resolved.tenant, kind };
        },
      },
    }, { accountId: r.session.accountId, id: connectionId, provider, status: "active" }, new AbortController().signal))
      .toMatchObject({ kind: "synced" });
    expect(renew).toHaveBeenCalledTimes(1);
    for (const privateValue of [r.clientSecret, r.refreshToken, r.accessToken, short, form.get("code_verifier")!]) {
      expect(r.lines.concat(r.responses).some((line) => line.includes(privateValue))).toBe(false);
    }
    expect(r.lines.some((line) => line.includes(r.code) || line.includes(state!))).toBe(false);
  });

  it("refuses the other account and provider, without spending the rightful account's state", async () => {
    const r = await rig();
    const state = (await r.start("google")).searchParams.get("state");
    expect(await reason(await r.complete("google", state, r.other.token))).toEqual([403, "account_mismatch"]);
    expect(await reason(await r.complete("microsoft", state))).toEqual([400, "state_invalid"]);
    expect(r.fetchToken).not.toHaveBeenCalled();
    expect((await r.complete("google", state)).status).toBe(201);
  });

  it("expires a state and spends it without exchanging the code", async () => {
    const r = await rig();
    const state = (await r.start("google")).searchParams.get("state");
    r.clock.advance(10 * 60_000 + 1);
    expect(await reason(await r.complete("google", state))).toEqual([400, "state_expired"]);
    expect(await reason(await r.complete("google", state))).toEqual([400, "state_invalid"]);
    expect(r.fetchToken).not.toHaveBeenCalled();
  });

  it("names declined consent and discards the provider's description", async () => {
    const r = await rig();
    const state = (await r.start("microsoft")).searchParams.get("state")!;
    const callback = await r.ask("GET", path("microsoft", "callback") + "?" + new URLSearchParams({
      state, error: "access_denied", error_description: r.refreshToken,
    }), undefined, "");
    expect(callback.status).toBe(303);
    const landing = new URL(callback.headers.get("location")!);
    const params = new URLSearchParams(landing.hash.split("?")[1]);
    expect(await reason(await r.ask("POST", path("microsoft", "complete"), {
      state: params.get("state"), refusal: params.get("refusal"),
    }))).toEqual([400, "consent_declined"]);
    expect(await reason(await r.complete("microsoft", state))).toEqual([400, "state_invalid"]);
    expect(r.fetchToken).not.toHaveBeenCalled();
    expect(r.responses.concat(r.lines).some((line) => line.includes(r.refreshToken))).toBe(false);
  });

  it("refuses a full calendar before starting or spending a provider grant", async () => {
    const r = await rig();
    const state = (await r.start("google")).searchParams.get("state");
    await r.db.insert(calConnections).values(Array.from({ length: CALENDAR_CONNECTION_CEILING }, () => ({
      accountId: r.session.accountId, provider: "ics", label: "", status: "active",
    })));
    expect(await reason(await r.ask("POST", path("google", "start"), {}))).toEqual([409, "conflict"]);
    expect(await reason(await r.complete("google", state))).toEqual([409, "conflict"]);
    expect(r.fetchToken).not.toHaveBeenCalled();
  });

  it("names a calendar switched off during consent before the token exchange", async () => {
    const r = await rig();
    const state = (await r.start("google")).searchParams.get("state");
    expect((await r.ask("PATCH", "/calendar/settings", { enabled: false })).status).toBe(200);
    expect(await reason(await r.ask("POST", path("google", "start"), {}))).toEqual([409, "calendar_off"]);
    expect(await reason(await r.complete("google", state))).toEqual([409, "calendar_off"]);
    expect(r.fetchToken).not.toHaveBeenCalled();
  });

  it.each(["google", "microsoft"] as const)("names declined %s consent even without a valid state", async (provider) => {
    const r = await rig();
    for (const state of ["", "broken"]) {
      const callback = await r.ask("GET", path(provider, "callback") + "?" + new URLSearchParams({
        state, error: "access_denied", error_description: r.refreshToken,
      }), undefined, "");
      expect(callback.status).toBe(303);
      expect(new URL(callback.headers.get("location")!).hash).toBe("#/cal/cal-setup?oauth=consent_declined");
    }
    expect(r.fetchToken).not.toHaveBeenCalled();
    expect(r.responses.concat(r.lines).some((line) => line.includes(r.refreshToken))).toBe(false);
  });

  it.each([["google", googleScopes[0]], ["microsoft", "User.Read"]] as const)(
    "explains a missing %s permission without keeping the grant",
    async (provider, scope) => {
      const r = await rig();
      r.fetchToken.mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: r.accessToken, refresh_token: r.refreshToken, scope, expires_in: 3600,
      })));
      const state = (await r.start(provider)).searchParams.get("state");
      expect(await reason(await r.complete(provider, state))).toEqual([400, "missing_permissions"]);
      expect(await r.connections()).toEqual([]);
      expect(r.lines.some((line) => line.includes("calendar_oauth_exchange_failed") && line.includes("missing_permissions"))).toBe(true);
      expect(r.responses.concat(r.lines).some((line) => line.includes(r.refreshToken) || line.includes(r.accessToken))).toBe(false);
    },
  );

  it("logs a known exchange refusal and discards an unexpected provider error value", async () => {
    const r = await rig();
    for (const error of ["invalid_client", r.refreshToken]) {
      r.fetchToken.mockResolvedValueOnce(new Response(JSON.stringify({ error, error_description: r.refreshToken }), { status: 400 }));
      const state = (await r.start("microsoft")).searchParams.get("state");
      expect(await reason(await r.complete("microsoft", state))).toEqual([502, "exchange_failed"]);
    }
    expect(r.lines.filter((line) => line.includes("calendar_oauth_exchange_failed"))).toEqual([
      expect.stringContaining("invalid_client"), expect.stringContaining("unknown_error"),
    ]);
    expect(r.responses.concat(r.lines).some((line) => line.includes(r.refreshToken))).toBe(false);
  });

  it("discards credential values when a token endpoint rejects the exchange", async () => {
    const r = await rig();
    r.fetchToken.mockRejectedValueOnce(new Error(r.refreshToken));
    const state = (await r.start("google")).searchParams.get("state");
    expect(await reason(await r.complete("google", state))).toEqual([503, "provider_unavailable"]);
    expect(await r.connections()).toEqual([]);
    expect(r.responses.concat(r.lines).some((line) => line.includes(r.refreshToken))).toBe(false);
  });

  it("offers and starts neither a switched-off Google client nor an unconfigured Microsoft client", async () => {
    const r = await rig();
    const services = r.deps.services!;
    services.calendarConnect = { policy: "cloud", ceremonies: {
      google: { on: false, configured: true }, microsoft: { on: true, configured: true },
    } };
    delete r.deps.msOAuth;
    expect((await (await r.ask("GET", "/calendar/connect")).json()).ways).toEqual(["icloud", "caldav", "ics"]);
    for (const provider of ["google", "microsoft"] as const) {
      expect(await reason(await r.ask("POST", path(provider, "start"), {}))).toEqual([503, "provider_off"]);
    }
    expect((await r.ask("POST", path("google", "start"), {}, "")).status).toBe(401);
  });

  it("does not send a mailbox ceremony to the calendar token trade", async () => {
    const r = await rig();
    const state = randomUUID().replaceAll("-", "") + "a".repeat(11);
    const sealed = await r.deps.keyProvider.encrypt(randomUUID());
    await createOAuthCeremony(r.db, {
      state, accountId: r.session.accountId, provider: "microsoft", codeVerifierEnc: sealed.ciphertext,
      codeVerifierKeyVersion: sealed.keyVersion, now: FIXED_NOW,
    });
    expect(await reason(await r.complete("microsoft", state))).toEqual([400, "state_invalid"]);
    expect(r.fetchToken).not.toHaveBeenCalled();
  });
});
