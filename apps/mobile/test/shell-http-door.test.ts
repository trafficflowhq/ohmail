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
import type { ShellSession } from "../src/net/pairing";
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
  return {
    profile: { id: "a", origin: ORIGIN, accountId: "acct-1", apiBase: null } as unknown as ServerProfile,
    bearer: null,
    fetch,
    send: (path, init) => fetch(`${ORIGIN}${path}`, init),
    ownerKey: `${ORIGIN}::acct-1`,
    standalone: false,
    verifyIdentity: async () => ({ kind: "verified" }),
    identityCleared: () => cleared,
    oldCopy: null,
  };
}

const get = (path: string, more: object = {}) => ({ scope: SCOPE, method: "GET" as const, path, headers: [] as [string, string][], body: null, ...more });

function hostOver(door: HttpDoor) {
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
  });
  host.begin("e1");
  const say = (message: object, facts: Partial<{ origin: string; mainFrame: boolean; epoch: string }> = {}) =>
    host.receive({ epoch: "e1", origin: "https://appassets.androidplatform.net", mainFrame: true, data: JSON.stringify(message), ...facts });
  const settled = () => new Promise((r) => setTimeout(r, 0));
  return { host, posted, say, settled };
}

describe("the shell's HTTP door", () => {
  it("reads its list from the route copy, and refuses for native only routes the copy holds", () => {
    expect(RELAY_ROUTES).toEqual(routes);
    for (const spec of NATIVE_ONLY) expect(RELAY_ROUTES, spec).toContain(spec);
  });

  it("refuses a second spelling of a path and the base's own prefix", async () => {
    const t = transport();
    const door = new HttpDoor({ live: () => ({ session: sessionOver(t.fetch), scope: SCOPE }), ready: () => true });
    const signal = new AbortController().signal;
    for (const path of ["/mailboxes/", "//mailboxes", "/api/mailboxes", "/mailboxes//x"]) {
      expect(await door.request(get(path), signal), path).toMatchObject({ status: 403 });
    }
    expect(t.calls).toHaveLength(0);
  });

  it("never dials for a path that names another place, from the page's own message", async () => {
    const t = transport();
    const door = new HttpDoor({ live: () => ({ session: sessionOver(t.fetch), scope: SCOPE }), ready: () => true });
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
    const door = new HttpDoor({ live: () => ({ session: sessionOver(t.fetch), scope: SCOPE }), ready: () => true });
    const signal = new AbortController().signal;
    for (const spec of NATIVE_ONLY) {
      const [method, pattern] = spec.split(" ") as ["GET" | "POST" | "DELETE", string];
      const answer = await door.request(get(pattern.replace(":id", "x1"), { method }), signal);
      expect(answer, spec).toMatchObject({ status: 403 });
    }
    expect(await door.request(get("/admin/accounts"), signal)).toMatchObject({ status: 403 });
    expect(t.calls).toHaveLength(0);
  });

  it("refuses a request under another profile's scope, and dials nothing before the launch is done", async () => {
    const t = transport();
    let ready = false;
    const door = new HttpDoor({ live: () => ({ session: sessionOver(t.fetch), scope: SCOPE }), ready: () => ready });
    const signal = new AbortController().signal;
    expect(await door.request(get("/mailboxes", { scope: "p" + "f".repeat(32) }), signal)).toEqual({ refused: "foreignScope" });
    expect(await door.request(get("/mailboxes"), signal)).toMatchObject({ status: 503 });
    ready = true;
    expect(await door.request(get("/mailboxes"), signal)).toMatchObject({ status: 200 });
    expect(t.calls.map((c) => c.url)).toEqual([`${ORIGIN}/mailboxes`]);
  });

  it("drops the credentials the page names and hands back only the headers it may read", async () => {
    const t = transport();
    const door = new HttpDoor({ live: () => ({ session: sessionOver(t.fetch), scope: SCOPE }), ready: () => true });
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
    const door = new HttpDoor({ live: () => ({ session: { ...sessionOver(t.fetch), identityCleared: () => cleared }, scope: SCOPE }), ready: () => true });
    const signal = new AbortController().signal;
    const held = await door.request(get("/sync?since=0"), signal);
    expect(held).toMatchObject({ status: 503 });
    expect(JSON.stringify(held)).toContain("sync_held_pre_identity");
    cleared = true;
    expect(await door.request(get("/sync?since=0"), signal)).toMatchObject({ status: 200 });
    expect(t.calls.map((c) => c.url)).toEqual([`${ORIGIN}/sync?since=0`]);
  });
});

describe("the bridge's native end", () => {
  it("runs nothing for a message that is not the page's main frame or not this web view's", async () => {
    const t = transport();
    const door = new HttpDoor({ live: () => ({ session: sessionOver(t.fetch), scope: SCOPE }), ready: () => true });
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
    const door = new HttpDoor({ live: () => ({ session: sessionOver(hanging), scope: SCOPE }), ready: () => true });
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
