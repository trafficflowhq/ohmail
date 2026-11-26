import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { BearerRegistry } from "../src/net/bearer-registry";
import { drainPendingSignOuts, MANAGED_ORIGIN, pairApproved, probePairing, revokeBrowserPair, signOutProfile, type PairingEnv } from "../src/net/pairing";
import { ServerProfileStore } from "../src/state/servers";
import { listen, pairServer, sqlWorld } from "./helpers/pair-server";
import { awaitBrowserApproval, browserSignInOrigin, probeBrowserSignIn, type BrowserApprovalDeps } from "../src/net/approval";

const origin = "https://mail.example.test";
const id = "11111111-1111-4111-8111-111111111111";
const tokens = { accessToken: "fake-access", refreshToken: "fake-refresh" };
const start = () => Response.json({ approvalId: id, expiresIn: 120 });

function attemptAt(target: string, ...responses: (Response | Error)[]) {
  const fetchImpl = vi.fn(async (_url: string, _init?: unknown) => {
    const response = responses.shift();
    if (response instanceof Response) return response;
    throw response ?? new Error("offline");
  });
  const open = vi.fn<BrowserApprovalDeps["open"]>(async () => true);
  const close = vi.fn();
  const run = (calendarOnly = false) => awaitBrowserApproval({
    fetchImpl, open, close, kind: "mobile-android", label: "Android",
    calendarOnly,
    pkce: async () => ({ verifier: "fake-verifier", challenge: "fake-challenge" }),
    sleep: async () => { if (responses.length === 0) throw new Error("no more replies"); }, now: () => 0, previousSession: null,
  }, { origin: target }, new AbortController().signal);
  return { fetchImpl, open, close, run };
}

const attempt = (...responses: (Response | Error)[]) => attemptAt(MANAGED_ORIGIN, ...responses);

describe("phone browser sign-in", () => {
  it("starts, waits and claims a native pair while only the approval id enters the hosted browser", async () => {
    const pending = Response.json({ retryAfterMs: 500 }, { status: 202 });
    const phone = attempt(start(), pending, Response.json({ tokens }));
    expect(await phone.run()).toEqual({ ok: true, approved: tokens });
    expect(phone.open.mock.calls.map(([url]) => url)).toEqual([`https://ohmail.app/approve?request=${id}&device=phone`]);
    expect(phone.fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${MANAGED_ORIGIN}/auth/desktop-approval`, `${MANAGED_ORIGIN}/auth/desktop-approval/claim`, `${MANAGED_ORIGIN}/auth/desktop-approval/claim`,
    ]);
    expect(JSON.parse(String((phone.fetchImpl.mock.calls[0]![1] as RequestInit).body))).toEqual({
      challenge: "fake-challenge", kind: "mobile-android", label: "Android",
    });
    expect(JSON.parse(String((phone.fetchImpl.mock.calls[2]![1] as RequestInit).body))).toEqual({
      approvalId: id, verifier: "fake-verifier", kind: "mobile-android",
    });
    expect(phone.close).toHaveBeenCalledOnce();
  });

  it("requires a successful credential-free page check before opening a self-hosted approval", async () => {
    const launch = "1780000000000." + "a".repeat(32);
    const request = () => Response.json({ approvalId: id, expiresIn: 120, launch });
    const page = `${origin}/approve?request=${id}`;
    const phone = attemptAt(origin, request(), new Response(null, { status: 302 }));
    expect(await phone.run()).toMatchObject({ ok: false, reason: { say: "signInWrongServer" } });
    expect(phone.open).not.toHaveBeenCalled();
    expect(phone.fetchImpl).toHaveBeenLastCalledWith(page, expect.objectContaining({
      method: "GET", credentials: "omit", redirect: "manual",
    }));

    const unconfirmed = new Response(null, { status: 200 });
    Object.defineProperty(unconfirmed, "url", { value: page.replace("https:", "http:") });
    const insecure = attemptAt(origin, request(), unconfirmed);
    expect(await insecure.run()).toMatchObject({ ok: false, reason: { say: "signInWrongServer" } });
    expect(insecure.open).not.toHaveBeenCalled();

    const ready = new Response(null, { status: 200 });
    Object.defineProperty(ready, "url", { value: page });
    const good = attemptAt(origin, request(), ready, Response.json({ tokens }));
    expect(await good.run()).toEqual({ ok: true, approved: tokens });
    expect(good.open.mock.calls.map(([url]) => url)).toEqual([page]);
    expect(good.open.mock.calls[0]?.[3]).toBe(launch);
    expect(good.fetchImpl.mock.calls.map(([url]) => url).join("\n")).not.toContain(launch);
  });

  it("requests calendar scope before the browser opens and carries the claimed scope to pairing", async () => {
    const scoped = { accessToken: "cal.fixture-access", refreshToken: "cal.fixture-refresh" };
    const phone = attempt(start(), Response.json({ scope: "calendar", tokens: scoped }));
    expect(await phone.run(true)).toEqual({ ok: true, approved: scoped, scope: "calendar" });
    expect(JSON.parse(String((phone.fetchImpl.mock.calls[0]![1] as RequestInit).body))).toMatchObject({ scope: "calendar" });
    expect(JSON.parse(String((phone.fetchImpl.mock.calls[1]![1] as RequestInit).body))).not.toHaveProperty("scope");
  });

  it.each(["/hello", "/sync"])("does not send a request past a redirect from the initial %s probe", async (path) => {
    const originRequests: string[] = [];
    const foreignRequest = vi.fn();
    const foreign = createServer((_request, response) => {
      foreignRequest();
      response.end("{}");
    });
    const destination = await listen(foreign);
    const chosen = createServer((request, response) => {
      originRequests.push(request.url!);
      if (request.url === path) {
        response.writeHead(302, { location: destination }).end();
      } else if (request.url === "/hello") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ product: "ohmail", flavor: "selfhost", features: { pairing: true } }));
      } else {
        response.writeHead(404).end();
      }
    });
    const local = await listen(chosen);
    const world = sqlWorld();
    const approvalTransport = vi.fn((url: string, init?: unknown) => fetch(url.replace(origin, local), init as RequestInit));
    const env: PairingEnv = {
      profiles: new ServerProfileStore({ get: async () => null, set: async () => {}, remove: async () => {} }),
      engineDeps: { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => id },
      // RN fetch may follow even when asked for manual redirects.
      fetchImpl: (url, init) => fetch(url.replace(origin, local), { ...(init as RequestInit), redirect: "follow" }),
      approvalFetchImpl: approvalTransport,
    };
    try {
      expect((await probeBrowserSignIn(env, origin, new AbortController().signal)).kind).toBe("refused");
      expect(originRequests).toContain(path);
      expect(foreignRequest).not.toHaveBeenCalled();
      expect(approvalTransport).toHaveBeenCalledWith(`${origin}${path}`, expect.objectContaining({
        credentials: "omit", redirect: "error",
      }));
    } finally {
      for (const server of [chosen, foreign]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it.each(["screens", "shell"] as const)("adopts an approved pair through the %s pairing path", async (surface) => {
    const fake = pairServer({ flavor: "managed", sessionRoute: true });
    const loopback = await listen(fake.server);
    const secure = new Map<string, string>();
    const world = sqlWorld();
    const fetchImpl = vi.fn(async (url: string, init?: unknown) => {
      const path = new URL(url).pathname;
      if (path === "/auth/desktop-approval") return start();
      if (path === "/auth/desktop-approval/claim") return Response.json({ tokens: fake.mintBrowserPair() });
      // A fake HTTPS origin routed to the fixture, preserving the API probe's same-URL answer.
      const response = await fetch(url.replace(MANAGED_ORIGIN, loopback), init as RequestInit);
      return Object.defineProperty(response, "url", { value: url });
    });
    const env: PairingEnv = {
      profiles: new ServerProfileStore({
        get: async (key) => secure.get(key) ?? null,
        set: async (key, value) => { secure.set(key, value); },
        remove: async (key) => { secure.delete(key); },
      }),
      engineDeps: { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => id },
      bearers: new BearerRegistry(),
      fetchImpl,
    };
    try {
      const probed = await probePairing(env, { origin: MANAGED_ORIGIN });
      if (probed.kind !== "offers") throw new Error("The fixture did not offer pairing");
      const open = vi.fn(async (_url: string) => true);
      const approval = await awaitBrowserApproval({
        fetchImpl, open, close: () => {}, kind: "mobile-ios", label: "iPhone",
        pkce: async () => ({ verifier: "fake-verifier", challenge: "fake-challenge" }),
        sleep: async () => {}, now: () => 0, previousSession: null,
      }, probed.admission, new AbortController().signal);
      if (!approval.ok) throw new Error("The fixture did not approve the phone");
      expect(open.mock.calls.map(([url]) => url)).toEqual([`https://ohmail.app/approve?request=${id}&device=phone`]);
      const outcome = await pairApproved(env, { admission: probed.admission, approved: approval.approved }, surface);
      expect(outcome.kind).toBe(surface === "shell" ? "shell" : "paired");
      expect(await env.profiles.active()).toMatchObject({
        accountId: "acct-1", origin: MANAGED_ORIGIN, refreshToken: approval.approved.refreshToken,
      });
      expect(fake.seen.some((request) => request.url === "/pair/redeem")).toBe(false);
      if (outcome.kind === "paired") outcome.session.store.close();
    } finally {
      fake.server.closeAllConnections();
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
      for (const name of world.names()) await world.drop(name);
    }
  });

  it("returns from Back during identity lookup and ends the issued session without saving a pairing", async () => {
    const controller = new AbortController();
    const persisted = vi.spyOn(ServerProfileStore.prototype, "add");
    const fake = pairServer({ flavor: "managed", sessionRoute: true });
    const loopback = await listen(fake.server);
    const world = sqlWorld();
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => { markReading = resolve; });
    const fetchImpl = vi.fn(async (url: string, init?: unknown) => {
      if (url === `${MANAGED_ORIGIN}/auth/session`) {
        markReading();
        return new Promise<Response>(() => {});
      }
      const response = await fetch(url.replace(MANAGED_ORIGIN, loopback), init as RequestInit);
      return Object.defineProperty(response, "url", { value: url });
    });
    const env: PairingEnv = {
      profiles: new ServerProfileStore({
        get: async () => null, set: async () => {}, remove: async () => {},
      }),
      engineDeps: { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => id },
      bearers: new BearerRegistry(),
      fetchImpl,
    };
    try {
      const probed = await probePairing(env, { origin: MANAGED_ORIGIN });
      if (probed.kind !== "offers") throw new Error("The fixture did not offer pairing");
      const adopted = pairApproved(env, { admission: probed.admission, approved: fake.mintBrowserPair() }, "shell",
        { signal: controller.signal, current: () => true, persisting: vi.fn() });
      await reading;
      controller.abort();
      expect(await adopted).toMatchObject({ kind: "refused", reason: { say: "connectSuperseded" } });
      expect(persisted).not.toHaveBeenCalled();
      expect(fetchImpl.mock.calls.some(([url]) => url === `${MANAGED_ORIGIN}/auth/logout`)).toBe(true);
    } finally {
      persisted.mockRestore();
      fake.server.closeAllConnections();
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  }, 3_000);

  it("revokes a full session returned to the calendar app before opening or saving a pairing", async () => {
    const fake = pairServer({ flavor: "managed", calendarSync: true, sessionRoute: true });
    const local = await listen(fake.server);
    const world = sqlWorld();
    const profiles = new ServerProfileStore({ get: async () => null, set: async () => {}, remove: async () => {} });
    const persist = vi.spyOn(profiles, "add");
    const fetchImpl = async (url: string, init?: unknown) => {
      const response = await fetch(url.replace(MANAGED_ORIGIN, local), init as RequestInit);
      return Object.defineProperty(response, "url", { value: url });
    };
    const env: PairingEnv = {
      profiles, fetchImpl, approvalFetchImpl: fetchImpl, calendarOnly: true,
      engineDeps: { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => id },
    };
    try {
      const probed = await probeBrowserSignIn(env, MANAGED_ORIGIN, new AbortController().signal);
      if (probed.kind !== "offers") throw new Error("The fixture did not offer calendar pairing");
      const outcome = await pairApproved(
        env, { admission: probed.admission, approved: fake.mintBrowserPair(false) }, "shell",
        { signal: new AbortController().signal, current: () => true, persisting: vi.fn() },
      );
      expect(outcome).toMatchObject({ kind: "refused", reason: { say: "calendarServerUnavailable" } });
      expect(persist).not.toHaveBeenCalled();
      expect(fake.seen.some((request) => request.url === "/auth/session")).toBe(false);
      expect(fake.seen.some((request) => request.url === "/auth/logout")).toBe(true);
    } finally {
      fake.server.closeAllConnections();
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  it("retries an interrupted browser sign-out on the original server with redirects refused", async () => {
    const secure = new Map<string, string>();
    const world = sqlWorld();
    const ordinary = vi.fn(async () => { throw new Error("Use the approval transport"); });
    const strict = vi.fn(async (_url: string, _init?: unknown) => new Response(null, { status: 204 }));
    const env: PairingEnv = {
      profiles: new ServerProfileStore({
        get: async (key) => secure.get(key) ?? null,
        set: async (key, value) => { secure.set(key, value); },
        remove: async (key) => { secure.delete(key); },
      }),
      engineDeps: { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => id },
      fetchImpl: ordinary,
      approvalFetchImpl: strict,
    };
    await revokeBrowserPair(env, { origin, pin: null }, tokens, ordinary);
    ordinary.mockClear();
    expect(await drainPendingSignOuts(env)).toBe(0);
    expect(ordinary).not.toHaveBeenCalled();
    expect(strict).toHaveBeenCalledOnce();
    expect(strict).toHaveBeenCalledWith(`${origin}/auth/refresh/logout`, expect.objectContaining({
      method: "POST", credentials: "omit", redirect: "error",
    }));
    expect(await env.profiles.pendingSignOuts()).toEqual([]);
  });

  it("uses the strict phone transport for a regular pairing and retains its retry after a redirect", async () => {
    const requests: string[] = [];
    const other = createServer((req, res) => { requests.push(req.url!); res.writeHead(204).end(); });
    const otherOrigin = await listen(other);
    const own = createServer((req, res) => {
      requests.push(req.url!);
      res.writeHead(307, { location: `${otherOrigin}/elsewhere` }).end();
    });
    const local = await listen(own);
    try {
      const secure = new Map<string, string>();
      const profiles = new ServerProfileStore({
        get: async (key) => secure.get(key) ?? null,
        set: async (key, value) => { secure.set(key, value); },
        remove: async (key) => { secure.delete(key); },
      });
      const world = sqlWorld();
      const ordinary = vi.fn((url: string, init?: unknown) => fetch(url.replace(origin, local), { ...(init as RequestInit), redirect: "follow" }));
      const strict = vi.fn((url: string, init?: unknown) => fetch(url.replace(origin, local), init as RequestInit));
      const env: PairingEnv = {
        profiles, fetchImpl: ordinary, approvalFetchImpl: strict, bearers: new BearerRegistry(() => undefined),
        engineDeps: { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => id },
      };
      const profile = await profiles.add({ origin, flavor: "selfhost", accountId: id, refreshToken: tokens.refreshToken });
      expect(await signOutProfile(env, profile)).toBe("owed");
      expect(await drainPendingSignOuts(env)).toBe(1);
      expect(await profiles.pendingSignOuts()).toHaveLength(1);
      expect(ordinary).not.toHaveBeenCalled();
      expect(strict).toHaveBeenCalledTimes(2);
      expect(requests).toEqual(["/auth/refresh/logout", "/auth/refresh/logout"]);
    } finally {
      own.close();
      other.close();
    }
  });

  it.each([
    ["signInExpired", () => [start(), Response.json({ error: { code: "approval_expired" } }, { status: 410 })]],
    ["signInDenied", () => [start(), Response.json({ error: { code: "approval_denied" } }, { status: 403 })]],
    ["signInUnreachable", () => [new Error("offline")]],
    ["signInUnreachable", () => [start(), new Error("offline")]],
    ["signInNotOffered", () => [new Response(null, { status: 404 })]],
  ] as const)("returns a recoverable %s", async (key, replies) => {
    const phone = attempt(...replies());
    expect(await phone.run()).toMatchObject({ ok: false, reason: { say: key } });
  });

  it("uses the existing typed-address rules and requires HTTPS for browser sign-in", () => {
    expect(browserSignInOrigin(" mail.example.test ")).toEqual({ origin });
    for (const value of ["", "http://localhost", "http://mail.example.test", "https://192.168.1.5",
      "https://mail.example.test/path", "https://mail.example.test/#link", "https://a:b@mail.example.test"]) {
      expect(browserSignInOrigin(value), value).toHaveProperty("reason");
    }
  });
});
