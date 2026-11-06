import { describe, expect, it } from "vitest";
import { createWriteThroughProxy } from "../src/cloud-proxy.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import type { CloudMirror } from "../src/cloud-mirror.js";

/**
 * The relay forwards to the server the door names, so its refusal is the boundary between a
 * credential and somebody else's machine. It is an allowlist taken from the API's route table:
 * a member is forwarded, a non-member never reaches the network, and the two hand-off routes get
 * a sentence instead of a bare 404.
 */

function proxyWith(handoffForeign: boolean) {
  const sent: Array<{ path: string; method: string }> = [];
  const logged: Array<{ event: string; route?: unknown }> = [];
  const auth = {
    authedFetch: async (path: string, init?: RequestInit) => {
      sent.push({ path, method: String(init?.method ?? "GET") });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  } as unknown as CloudAuth;
  const mirror = {
    online: () => true,
    markConnectivity: () => {},
    awaitCloudSeq: async () => true,
    awaitFreshPull: async () => true,
  } as unknown as CloudMirror;
  const proxy = createWriteThroughProxy({
    auth,
    mirror,
    handoffForeign,
    log: (event: string, fields?: Record<string, unknown>) => logged.push({ event, route: fields?.route }),
  });
  const call = (method: string, path: string) =>
    proxy.forward(new Request(`http://engine${path}`, {
      method,
      ...(method === "GET" || method === "HEAD" ? {} : { body: "{}", headers: { "content-type": "application/json" } }),
    }));
  return { proxy, call, sent, logged };
}

describe("a member of the allowlist is forwarded", () => {
  it("a mail mutation reaches the configured server", async () => {
    const { call, sent } = proxyWith(true);
    const res = await call("POST", "/messages/abc/move");
    expect(res.status).toBe(200);
    expect(sent).toEqual([{ path: "/messages/abc/move", method: "POST" }]);
  });

  it("and so does the same path under the webapp's /api split", async () => {
    const { call, sent } = proxyWith(true);
    await call("PATCH", "/api/messages");
    /* Forwarded VERBATIM — the canonicalization decides the verdict, it does not rewrite the
       request. The server strips its own prefix. */
    expect(sent).toEqual([{ path: "/api/messages", method: "PATCH" }]);
  });
});

describe("a non-member never reaches the network", () => {
  it("a route that does not exist is a 404 and no request is made", async () => {
    const { call, sent } = proxyWith(true);
    const res = await call("POST", "/not-a-route");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    expect(sent).toEqual([]);
  });

  it("a real route with the wrong method is refused", async () => {
    const { call, sent } = proxyWith(true);
    expect((await call("GET", "/messages/abc/move")).status).toBe(404);
    expect(sent).toEqual([]);
  });

  it("the hosted console is refused", async () => {
    const { call, sent } = proxyWith(true);
    expect((await call("GET", "/admin/overview")).status).toBe(404);
    expect((await call("POST", "/internal/alerts")).status).toBe(404);
    expect(sent).toEqual([]);
  });

  it("a refusal is logged, so a missing verdict is not a silent 404", async () => {
    /* A route added without a relay verdict would answer 404 and look exactly like a server that
       does not have the route. One log line tells those apart. */
    const { call, logged } = proxyWith(true);
    await call("POST", "/not-a-route");
    expect(logged.map((l) => l.event)).toContain("cloud_relay_refused");
    expect(logged.find((l) => l.event === "cloud_relay_refused")?.route).toBe("not-a-route");
  });

  it("and the line carries no message id — the first segment only, id-shaped or `other`", () => {
    /* `path` is DROPPED by the logger because a pathname carries ids; the census caught the first
       version of this line passing one. */
    const { call, logged } = proxyWith(true);
    return call("POST", "/messages/11111111-1111-4111-8111-111111111111/nope").then(() => {
      const line = logged.find((l) => l.event === "cloud_relay_refused");
      expect(line?.route).toBe("messages");
      return call("POST", "/%2e%2e/../../etc/passwd").then(() => {
        const odd = logged.filter((l) => l.event === "cloud_relay_refused").pop();
        expect(String(odd?.route)).toMatch(/^([A-Za-z0-9._~-]{1,32}|other)$/);
      });
    });
  });
});

describe("Send later with files is this computer's own (mail 0179)", () => {
  it("the files route is never forwarded to Cloud: a 404 the window reads as unsupported, and no request", async () => {
    const { call, sent } = proxyWith(false);
    const res = await call("POST", "/drafts/abc/schedule-with-files");
    expect(res.status).toBe(404);
    expect(sent).toEqual([]);
  });

  it("while /hello is, so the window reads Cloud's own answer about keeping files", async () => {
    const { call, sent } = proxyWith(false);
    await call("GET", "/hello");
    expect(sent).toEqual([{ path: "/hello", method: "GET" }]);
  });
});

describe("the hand-off routes get the sentence, on the door where it helps", () => {
  it("409 on a server the person runs themselves", async () => {
    const { call, sent } = proxyWith(true);
    for (const p of ["/auth/desktop-claim", "/auth/desktop-link", "/api/auth/desktop-claim/"]) {
      const res = await call("POST", p);
      expect(res.status, p).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: "handoff_not_available" } });
    }
    expect(sent).toEqual([]);
  });

  it("and a plain 404 on the hosted door, where the sentence would be wrong", async () => {
    /* The engine's own sign-in posts the claim directly; it never goes through the relay. On the
       hosted door the honest answer is that this is not forwarded, not advice about a server the
       person does not run. */
    const { call, sent } = proxyWith(false);
    const res = await call("POST", "/auth/desktop-claim");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    expect(sent).toEqual([]);
  });
});

describe("the relay refuses to run on an empty allowlist", () => {
  it("construction fails rather than answering 404 to everything", () => {
    /* A build whose projection arrived empty would refuse every write and read as an offline
       install. Watch it: lower ALLOWLIST_MIN below the real length and this stops firing. */
    expect(() => createWriteThroughProxy({
      auth: {} as unknown as CloudAuth,
      mirror: { online: () => true } as unknown as CloudMirror,
    })).not.toThrow();
  });
});
