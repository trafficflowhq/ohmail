/**
 * THE SHELL'S HTTP DOOR AND THE BRIDGE'S NATIVE END, over a transport double that records every
 * call. A path that names another place, a route only native may call, a request under another
 * profile's scope, a message from a frame that is not the page's: each is refused with the
 * transport called zero times. Credentials the page names are dropped; the native stamp is the
 * session's own. The drain routes stay shut until the identity verdict has settled. The route copy the
 * door reads is held to the relay's own list, entry for entry, outside the phone's app:
 * `test/phone-relay-routes-copy.test.ts` at the repository's root.
 */
import { describe, expect, it } from "vitest";
import { BearerManagerRN } from "../src/net/bearer";
import { shellSessionOf, type ShellSession } from "../src/net/pairing";
import { BridgeHost } from "../src/shell/bridge-host";
import { HttpDoor, NATIVE_ONLY } from "../src/shell/http-door";
import { RELAY_ROUTES } from "../src/shell/relay-routes";
import routes from "../src/shell/relay-routes.json";
import type { ServerProfile } from "../src/state/servers";

const SCOPE = "p0123456789abcdef0123456789abcdef";
const ORIGIN = "https://mail.example.test";

function transport() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init?: unknown) => {
    calls.push({ url, init: (init ?? {}) as RequestInit });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "s=1", "x-sync-seq": "7", "x-internal": "no" },
    });
  };
  return { calls, fetch };
}

function sessionOver(fetch: ShellSession["fetch"], cleared = true): ShellSession {
  const lifetime = new AbortController();
  return {
    profile: { id: "a", origin: ORIGIN, accountId: "acct-1", apiBase: null } as unknown as ServerProfile,
    bearer: null,
    fetch,
    send: (path, init) => fetch(`${ORIGIN}${path}`, init),
    ownerKey: `${ORIGIN}::acct-1`,
    standalone: false,
    verifyIdentity: async () => ({ kind: "verified" }),
    boundAccount: () => cleared && !lifetime.signal.aborted ? "acct-1" : null,
    lifetime: lifetime.signal,
    leave: () => lifetime.abort(),
    oldCopy: null,
  };
}

function deferred<T>() {
  let resolve!: (answer: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const affirmed = (accountId = "acct-1") => Response.json({ user: { accountId } });

function pairedOver(answer: (path: string) => Promise<Response>, deadline = 1_000) {
  const calls: string[] = [];
  const bearer = new BearerManagerRN({
    origin: ORIGIN,
    accessToken: ["fixture", "access"].join("-"),
    refreshToken: ["fixture", "refresh"].join("-"),
    vault: {
      save: async () => "landed", clear: async () => "landed",
      armAttempt: async () => "landed", oweSignOut: async () => false,
    },
    fetchImpl: (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      return answer(path);
    },
  });
  const profile = { ...sessionOver(bearer.fetch).profile, flavor: "managed" };
  const session = shellSessionOf({ kind: "paired", profile, bearer, fetch: bearer.fetch, apiBase: null }, null, deadline);
  return { session, calls };
}

const get = (path: string, more: object = {}) => ({ scope: SCOPE, method: "GET" as const, path, headers: [] as [string, string][], body: null, ...more });

const accountCalls = [
  get("/mailboxes"), get("/consent"), get("/messages/letter/body"), get("/sync/snapshot"),
  get("/consent/settings", { method: "PATCH" }), get("/drafts/letter/send", { method: "POST" }),
];

function doorOver(session: ShellSession, options: Partial<ConstructorParameters<typeof HttpDoor>[0]> = {}) {
  return new HttpDoor({ live: () => ({ session, scope: SCOPE }), ready: () => true, ...options });
}

function hostOver(door: HttpDoor, more: Partial<ConstructorParameters<typeof BridgeHost>[0]> = {}, epoch = "e1") {
  const posted: Record<string, unknown>[] = [];
  const host = new BridgeHost({
    post: (_epoch, text) => void posted.push(JSON.parse(text) as Record<string, unknown>),
    config: () => null,
    http: door,
    act: async () => ({}),
    openHeld: async () => false,
    ready: () => {},
    place: () => {},
    note: () => {},
    oldCopy: { page: async () => ({ refused: "notReady" as const }), done: async () => ({ refused: "notReady" as const }) },
    ...more,
  });
  host.begin(epoch);
  const say = (message: object, facts: Partial<{ origin: string; mainFrame: boolean; epoch: string }> = {}) =>
    host.receive({ epoch, origin: "https://appassets.androidplatform.net", mainFrame: true, data: JSON.stringify(message), ...facts });
  const settled = () => new Promise((r) => setTimeout(r, 0));
  return { host, posted, say, settled };
}

describe("the shell's HTTP door", () => {
  it("reads its list from the route copy, and refuses for native only routes the copy holds", () => {
    expect(RELAY_ROUTES).toEqual(routes);
    for (const spec of NATIVE_ONLY) expect(RELAY_ROUTES, spec).toContain(spec);
  });

  it("keeps the calendar phone away from mail routes during sign-out and account changes", async () => {
    const t = transport();
    const first = sessionOver(t.fetch);
    const next = sessionOver(t.fetch);
    const nextScope = "pabcdef0123456789abcdef0123456789";
    let live: { session: ShellSession; scope: string } | null = { session: first, scope: SCOPE };
    const door = new HttpDoor({ live: () => live, ready: () => true, calendarOnly: true });
    const signal = new AbortController().signal;
    for (const path of ["/messages", "/messages/letter/body", "/mailboxes?counts=1", "/search?q=letter",
      "/sync/snapshot?phase=tail", "/sync?types=message", "/calendar/connect", "/account/export"]) {
      expect(await door.request(get(path), signal)).toMatchObject({ status: 403 });
    }
    for (const path of ["/auth/password", "/auth/2fa/recovery-codes", "/auth/2fa/totp/enroll"]) {
      expect(await door.request({ ...get(path), method: "POST" }, signal)).toMatchObject({ status: 403 });
    }
    expect(await door.account({ scope: SCOPE, do: "pairs" }, signal)).toMatchObject({ result: { status: 403 } });
    expect(t.calls).toEqual([]);
    let diagnostics = 0;
    const epoch = "calendar-page";
    const bridge = hostOver(door, {
      app: "ohcal",
      act: async () => { first.leave(); live = null; return {}; },
      diagnostics: {
        beginPage: () => {},
        answer: async () => { diagnostics++; return { shared: true }; },
      },
    }, epoch);
    bridge.say({ kind: "phone.diagnostics", id: 1, epoch, do: "share" });
    await bridge.settled();
    expect(diagnostics).toBe(0);
    expect(bridge.posted[0]).toMatchObject({ refused: "malformed" });
    expect(await door.request(get("/calendar/sync/snapshot"), signal)).toMatchObject({ status: 200 });
    bridge.say({ kind: "act", id: 2, epoch, act: "signOut" });
    await bridge.settled();
    expect(await door.request(get("/calendar/sync"), signal)).toEqual({ refused: "foreignScope" });
    live = { session: next, scope: nextScope };
    expect(await door.request(get("/calendar/sync"), signal)).toEqual({ refused: "foreignScope" });
    expect(await door.request(get("/calendar/sync", { scope: nextScope }), signal)).toMatchObject({ status: 200 });
    expect(t.calls.map(({ url }) => new URL(url).pathname)).toEqual(["/calendar/sync/snapshot", "/calendar/sync"]);
  });

  it("refuses a second spelling of a path and the base's own prefix", async () => {
    const t = transport();
    const door = doorOver(sessionOver(t.fetch));
    const signal = new AbortController().signal;
    for (const path of ["/mailboxes/", "//mailboxes", "/api/mailboxes", "/mailboxes//x"]) {
      expect(await door.request(get(path), signal), path).toMatchObject({ status: 403 });
    }
    expect(t.calls).toHaveLength(0);
  });

  it("never dials for a path that names another place, from the page's own message", async () => {
    const t = transport();
    const door = doorOver(sessionOver(t.fetch));
    const { posted, say, settled } = hostOver(door);
    for (const [i, path] of ["https://elsewhere.example/sync", "//elsewhere.example/sync", "/a/../pair", "/%2e%2e/pair", "/sync\\x"].entries()) {
      say({ id: i + 1, epoch: "e1", kind: "http", ...get(path) });
    }
    await settled();
    expect(t.calls).toHaveLength(0);
    expect(posted.map((p) => p.refused)).toEqual(["malformed", "malformed", "malformed", "malformed", "malformed"]);
  });

  it("refuses every route only native calls, and anything the relay does not forward", async () => {
    const t = transport();
    const door = doorOver(sessionOver(t.fetch));
    const signal = new AbortController().signal;
    for (const spec of NATIVE_ONLY) {
      const [method, pattern] = spec.split(" ") as ["GET" | "POST" | "DELETE", string];
      const answer = await door.request(get(pattern.replace(":id", "x1"), { method }), signal);
      expect(answer, spec).toMatchObject({ status: 403 });
    }
    expect(await door.request(get("/admin/accounts"), signal)).toMatchObject({ status: 403 });
    expect(t.calls).toHaveLength(0);
  });

  it("passes the calendar's connect door, and a typed sign-in goes out in the one request's body and is counted or kept nowhere", async () => {
    const t = transport();
    const counted: string[] = [];
    const door = doorOver(sessionOver(t.fetch), { count: (what) => void counted.push(what) });
    const signal = new AbortController().signal;
    // Values nobody wrote down, put together here so that no line of this file is shaped like a sign-in.
    const typedPassword = ["mk", "phone", "pw", String(Date.now())].join("");
    const typedAddress = `https://feeds.example.test/${["mk", "phone", "feed", String(Date.now())].join("")}/basic.ics`;
    const post = (path: string, body: object) =>
      door.request({ ...get(path, { method: "POST" as const }), headers: [["content-type", "application/json"], ["idempotency-key", "k1"]], body: { as: "text", text: JSON.stringify(body) } }, signal);
    const id = "7c0d4f0e-3b1a-4a55-8f1c-2f6a9a3b1c22";
    const answers = [
      await door.request(get("/calendar/connect"), signal),
      await post("/calendar/connections", { way: "caldav", connectionId: id, server: "https://dav.studio.example.test/", user: "mila", password: typedPassword }),
      await post(`/calendar/connections/${id}/sign-in`, { address: typedAddress }),
      await post(`/calendar/connections/${id}/check`, {}),
      await door.request(get(`/calendar/calendars/${id}`, { method: "PATCH" as const, body: { as: "text" as const, text: JSON.stringify({ shown: false }) } }), signal),
      await door.request(get(`/calendar/connections/${id}`, { method: "DELETE" as const }), signal),
    ];
    expect(answers.map((a) => ("status" in a ? a.status : a.refused))).toEqual([200, 200, 200, 200, 200, 200]);
    expect(t.calls.map((c) => [c.init.method, c.url])).toEqual([
      ["GET", `${ORIGIN}/calendar/connect`], ["POST", `${ORIGIN}/calendar/connections`], ["POST", `${ORIGIN}/calendar/connections/${id}/sign-in`],
      ["POST", `${ORIGIN}/calendar/connections/${id}/check`], ["PATCH", `${ORIGIN}/calendar/calendars/${id}`], ["DELETE", `${ORIGIN}/calendar/connections/${id}`],
    ]);
    // Each secret is in its request's body, once, and in no address, header, count or answer of the door.
    expect([String(t.calls[1]!.init.body).includes(typedPassword), String(t.calls[2]!.init.body).includes(typedAddress)]).toEqual([true, true]);
    const around = JSON.stringify([t.calls.map((c) => [c.url, c.init.headers]), counted, answers]);
    expect([around.includes(typedPassword), around.includes(typedAddress)]).toEqual([false, false]);
    // A path beside the door's is not the door's: refused before anything is sent.
    expect(await door.request(get("/calendar/connections"), signal)).toMatchObject({ status: 403 });
    expect([t.calls.length, counted]).toEqual([6, ["notRelayed"]]);
  });

  it("never lets the page reach a route that answers session tokens or spends a pairing or handoff code", async () => {
    const t = transport();
    const door = doorOver(sessionOver(t.fetch));
    const signal = new AbortController().signal;
    for (const path of ["/auth/2fa/totp/activate", "/auth/2fa/webauthn/register/verify", "/pair/handoff", "/pair/redeem"]) {
      const answer = await door.request(get(path, { method: "POST", body: { as: "text", text: "{}" } }), signal);
      expect(answer, path).toMatchObject({ status: 403 });
    }
    expect(t.calls).toHaveLength(0);
  });

  it("refuses a request under another profile's scope, and dials nothing before the launch is done", async () => {
    const t = transport();
    let ready = false;
    const door = doorOver(sessionOver(t.fetch), { ready: () => ready });
    const signal = new AbortController().signal;
    expect(await door.request(get("/mailboxes", { scope: "p" + "f".repeat(32) }), signal)).toEqual({ refused: "foreignScope" });
    expect(await door.request(get("/mailboxes"), signal)).toMatchObject({ status: 503 });
    ready = true;
    expect(await door.request(get("/mailboxes"), signal)).toMatchObject({ status: 200 });
    expect(t.calls.map((c) => c.url)).toEqual([`${ORIGIN}/mailboxes`]);
  });

  it("drops the credentials the page names and hands back only the headers it may read", async () => {
    const t = transport();
    const door = doorOver(sessionOver(t.fetch));
    const answer = await door.request(get("/mailboxes", {
      headers: [
        ["authorization", "Bearer stolen"], ["cookie", "s=1"], ["x-csrf-token", "c"], ["x-ohmail-client", "forged"],
        ["idempotency-key", "k1"], ["x-ohmail-account", "acct-1"], ["content-type", "application/json"],
      ],
    }), new AbortController().signal);
    const sent = t.calls[0]!.init;
    expect(sent.headers).toEqual({ "idempotency-key": "k1", "x-ohmail-account": "acct-1", "content-type": "application/json" });
    expect(sent.credentials).toBe("omit");
    expect(answer).toMatchObject({ status: 200, headers: [["content-type", "application/json"], ["x-sync-seq", "7"]] });
  });

  it("holds the drain routes shut until the identity verdict, then forwards them", async () => {
    const t = transport();
    let cleared = false;
    const door = doorOver({ ...sessionOver(t.fetch), boundAccount: () => cleared ? "acct-1" : null });
    const signal = new AbortController().signal;
    const held = await door.request(get("/sync?since=0"), signal);
    expect(held).toMatchObject({ status: 503 });
    expect(JSON.stringify(held)).toContain("sync_held_pre_identity");
    cleared = true;
    expect(await door.request(get("/sync?since=0"), signal)).toMatchObject({ status: 200 });
    expect(t.calls.map((c) => c.url)).toEqual([`${ORIGIN}/sync?since=0`]);
  });

  it("holds account reads and acts until the native probe confirms this pairing", async () => {
    const identity = deferred<Response>();
    const { session, calls } = pairedOver((path) => path === "/auth/session" ? identity.promise : Promise.resolve(Response.json({})));
    const door = new HttpDoor({ live: () => ({ session, scope: SCOPE }), ready: () => true });
    const signal = new AbortController().signal;
    const probe = session.verifyIdentity();
    try {
      const held = await Promise.all(accountCalls.map((ask) => door.request(ask, signal)));
      expect(calls).toEqual(["/auth/session"]);
      expect(held.map((answer) => "status" in answer ? answer.status : answer.refused)).toEqual(accountCalls.map(() => 503));
    } finally {
      identity.resolve(affirmed());
    }
    expect((await probe).kind).toBe("verified");
    expect(await door.request(get("/mailboxes"), signal)).toMatchObject({ status: 200 });
    expect(await door.request(get("/consent/settings", { method: "PATCH" }), signal)).toMatchObject({ status: 200 });
    expect(calls).toEqual(["/auth/session", "/mailboxes", "/consent/settings"]);
  });

  it.each([
    ["mismatched", () => affirmed("acct-2"), "mismatch"],
    ["unverified", () => Response.json({}), "unverified"],
  ] as const)("forwards no account calls after a %s identity answer", async (_label, answer, verdict) => {
    const { session, calls } = pairedOver(async () => answer());
    const door = new HttpDoor({ live: () => ({ session, scope: SCOPE }), ready: () => true });
    expect((await session.verifyIdentity()).kind).toBe(verdict);
    const refused = await Promise.all(accountCalls.map((ask) => door.request(ask, new AbortController().signal)));
    expect(calls).toEqual(["/auth/session"]);
    expect(refused.map((result) => "status" in result ? result.status : result.refused)).toEqual(accountCalls.map(() => 503));
  });

  it("keeps calls held when the identity answer comes after the deadline", async () => {
    const identity = deferred<Response>();
    const { session, calls } = pairedOver(() => identity.promise, 1);
    const door = new HttpDoor({ live: () => ({ session, scope: SCOPE }), ready: () => true });
    expect((await session.verifyIdentity()).kind).toBe("unverified");
    identity.resolve(affirmed());
    const refused = await Promise.all(accountCalls.map((ask) => door.request(ask, new AbortController().signal)));
    expect(calls).toEqual(["/auth/session"]);
    expect(refused.map((result) => "status" in result ? result.status : result.refused)).toEqual(accountCalls.map(() => 503));
  });

  it("does not replay a write on a renewed credential before checking its account", async () => {
    let renewed = false;
    const { session, calls } = pairedOver(async (path) => {
      if (path === "/auth/session") return affirmed(renewed ? "acct-2" : "acct-1");
      if (path === "/auth/refresh") {
        renewed = true;
        return Response.json({ tokens: {
          accessToken: ["renewed", "fixture"].join("-"), refreshToken: ["next", "fixture"].join("-"),
        } });
      }
      return new Response(null, { status: 401 });
    });
    const door = doorOver(session);
    expect((await session.verifyIdentity()).kind).toBe("verified");
    const write = get("/consent/settings", { method: "PATCH" });
    await door.request(write, new AbortController().signal);
    expect(calls).toEqual(["/auth/session", "/consent/settings", "/auth/refresh"]);
    expect(session.boundAccount()).toBeNull();
    expect((await session.verifyIdentity()).kind).toBe("mismatch");
    expect(await door.request(write, new AbortController().signal)).toMatchObject({ status: 503 });
    expect(calls).toEqual(["/auth/session", "/consent/settings", "/auth/refresh", "/auth/session"]);
  });

  it.each(["header", "mailbox row", "sync row"] as const)("discards another account's %s after identity was confirmed", async (where) => {
    const foreign = () => {
      const row = { accountId: "acct-2", subject: "Foreign fixture" };
      if (where === "header") return Response.json(row, { headers: { "x-ohmail-account": "acct-2" } });
      if (where === "mailbox row") return Response.json({ items: [row] });
      return Response.json({ changes: { creates: [{ entity: row }] } });
    };
    const { session } = pairedOver(async (path) => path === "/auth/session" ? affirmed() : foreign());
    const door = new HttpDoor({ live: () => ({ session, scope: SCOPE }), ready: () => true });
    expect((await session.verifyIdentity()).kind).toBe("verified");
    const answer = await door.request(get(where === "sync row" ? "/sync" : "/mailboxes"), new AbortController().signal);
    expect(answer).toMatchObject({ status: 403 });
    expect(JSON.stringify(answer)).not.toContain("Foreign fixture");
  });

  it("discards an answer still being read when the session leaves", async () => {
    const headers = deferred<void>();
    const bytes = deferred<ArrayBuffer>();
    const { session } = pairedOver(async (path) => {
      if (path === "/auth/session") return affirmed();
      const response = Response.json({});
      response.arrayBuffer = () => { headers.resolve(); return bytes.promise; };
      return response;
    });
    let live = { session, scope: SCOPE } as { session: ShellSession; scope: string } | null;
    const door = new HttpDoor({ live: () => live, ready: () => true });
    expect((await session.verifyIdentity()).kind).toBe("verified");
    const read = door.request(get("/mailboxes"), new AbortController().signal);
    await headers.promise;
    live = null;
    bytes.resolve(new TextEncoder().encode('{"items":[]}').buffer);
    expect(await read).toEqual({ refused: "foreignScope" });
  });
});

describe("account management through the native HTTP door", () => {
  const signal = new AbortController().signal;
  const ask = { scope: SCOPE, do: "activate", code: "123456" } as const;
  const mint = { scope: SCOPE, do: "mint", grant: "device-pair", name: "Travel phone" } as const;
  const hosted = (send: ShellSession["send"], flavor: ServerProfile["flavor"] = "managed") => {
    const session = sessionOver(async (url, init) => send(new URL(url).pathname, init as RequestInit));
    return { ...session, profile: { ...session.profile, flavor } };
  };
  it("activates a factor without returning session material to the page", async () => {
    const send = async (path: string, init: RequestInit) => {
      expect(path).toBe("/auth/2fa/totp/activate");
      expect(JSON.parse(String(init.body))).toEqual({ code: "123456" });
      return Response.json({ accessToken: "fixture-access", refreshToken: "fixture-refresh", user: { accountId: "acct-1" } });
    };
    const door = doorOver(hosted(send));
    expect(await door.account(ask, signal)).toMatchObject({ result: { status: 204, body: null, headers: [] } });
  });

  it("constructs the one-use device link from the bound origin and filters its answer", async () => {
    const send = async (path: string, init: RequestInit) => {
      expect(path).toBe("/pair");
      expect(JSON.parse(String(init.body))).toEqual({ grant: "device-pair", label: "Travel phone" });
      return Response.json({ id: "one-link", label: "Travel phone", token: "fixture", grant: "device-pair", expiresAt: "2026-11-04T10:05:00Z", extra: "elsewhere" });
    };
    const door = doorOver(hosted(send));
    const answer = await door.account(mint, signal);
    expect("result" in answer && answer.result?.body).toEqual({ as: "text", text: JSON.stringify({
      id: "one-link", label: "Travel phone", expiresAt: "2026-11-04T10:05:00Z", link: `${ORIGIN}/pair#fixture`,
    }) });
  });

  it("rejects a different profile and a grant the managed service cannot issue", async () => {
    const send = async () => { throw new Error("Unexpected account request"); };
    const door = doorOver(hosted(send));
    expect(await door.account({ ...mint, scope: "different" }, signal)).toEqual({ refused: "foreignScope" });
    expect(await door.account({ ...mint, grant: "invite" }, signal)).toMatchObject({ result: { status: 403 } });
  });

  it("drops a code minted after the person switches accounts", async () => {
    const reply = deferred<Response>();
    const session = hosted(() => reply.promise);
    let live = true;
    const door = doorOver(session, { live: () => live ? { session, scope: SCOPE } : null });
    const pending = door.account(mint, signal);
    live = false;
    reply.resolve(Response.json({ id: "one-link", label: "Travel phone", token: "fixture", grant: "device-pair", expiresAt: "2026-11-04T10:05:00Z" }));
    expect(await pending).toEqual({ refused: "foreignScope" });
  });
});

describe("the bridge's native end", () => {
  it("runs nothing for a message that is not the page's main frame or not this web view's", async () => {
    const t = transport();
    const door = doorOver(sessionOver(t.fetch));
    const { posted, say, settled } = hostOver(door);
    const asked = { id: 1, epoch: "e1", kind: "http", ...get("/mailboxes") };
    say(asked, { mainFrame: false });
    say(asked, { origin: "https://elsewhere.example" });
    say(asked, { epoch: "e0" });
    await settled();
    expect(t.calls).toHaveLength(0);
    expect(posted).toHaveLength(0);
    say(asked);
    await settled();
    await settled();
    expect(t.calls).toHaveLength(1);
    expect(posted[0]).toMatchObject({ id: 1, epoch: "e1", ok: true, status: 200 });
  });

  it("aborts what the page cancels, and every request of a web view that ended", async () => {
    const seen: AbortSignal[] = [];
    const hanging = (_url: string, init?: unknown) => {
      seen.push((init as RequestInit).signal!);
      return new Promise<Response>(() => {});
    };
    const door = doorOver(sessionOver(hanging));
    const { host, say, settled } = hostOver(door);
    say({ id: 1, epoch: "e1", kind: "http", ...get("/mailboxes") });
    say({ id: 2, epoch: "e1", kind: "http", ...get("/mailboxes") });
    await settled();
    say({ id: 3, epoch: "e1", kind: "cancel", of: 1 });
    await settled();
    expect(seen.map((s) => s.aborted)).toEqual([true, false]);
    host.begin("e2");
    expect(seen.map((s) => s.aborted)).toEqual([true, true]);
  });
});

describe("the switch's kinds at the bridge's native end", () => {
  const EVENT = "0b9f2c1e-7d4a-4c1b-9e3f-5a6b7c8d9e0f";
  const quiet = new HttpDoor({ live: () => null, ready: () => false });

  function switchDouble() {
    const opened: unknown[] = [];
    return {
      opened,
      door: {
        read: async () => ({ other: "here" as const }),
        open: async (to: unknown) => (opened.push(to), { went: "absent" as const }),
        store: async () => ({ opened: true }),
      },
    };
  }

  it("answers each kind from native's switch, and a place of this app's direction only", async () => {
    const { door, opened } = switchDouble();
    const { posted, say, settled } = hostOver(quiet, { app: "ohmail", switch: door });
    say({ id: 1, epoch: "e1", kind: "switch.read" });
    say({ id: 2, epoch: "e1", kind: "switch.open", to: { to: "event", id: EVENT } });
    say({ id: 3, epoch: "e1", kind: "switch.open", to: { to: "message", id: EVENT } });
    say({ id: 4, epoch: "e1", kind: "switch.store" });
    await settled();
    await settled();
    const by = (id: number) => posted.find((p) => p.id === id);
    expect(by(1)).toMatchObject({ ok: true, other: "here" });
    expect(by(2)).toMatchObject({ ok: true, went: "absent" });
    expect(by(3)).toMatchObject({ ok: false, refused: "malformed" });
    expect(by(4)).toMatchObject({ ok: true, opened: true });
    expect(opened).toEqual([{ to: "event", id: EVENT }]);
  });

  it("answers not ready where no switch is wired, and opens nothing when it does not know its app", async () => {
    const { door, opened } = switchDouble();
    const bare = hostOver(quiet);
    bare.say({ id: 1, epoch: "e1", kind: "switch.read" });
    await bare.settled();
    expect(bare.posted[0]).toMatchObject({ ok: false, refused: "notReady" });
    const unnamed = hostOver(quiet, { switch: door });
    unnamed.say({ id: 2, epoch: "e1", kind: "switch.open", to: { to: "last" } });
    await unnamed.settled();
    expect(unnamed.posted[0]).toMatchObject({ ok: false, refused: "malformed" });
    expect(opened).toEqual([]);
  });
});
