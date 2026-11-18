import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage, Server } from "node:http";
import { serviceContext, type ApiDeps } from "@trafficflow/api";
import { canonicalIp } from "@trafficflow/core/adapters/http-host";
import { bindDb } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  makeHttpServer, makeTrustedProxies, toWebRequest,
  type AdapterOptions, type ForwardingNote, type TrustedProxies,
} from "../src/http.js";

/**
 * WHO THE CLIENT IS, behind the self-host server's own proxy. Every request reaches the server
 * from the proxy's socket; the proxy writes the client into `x-forwarded-for`. The server must
 * believe that header from the proxy (or every visitor is the proxy: one lockout, one signup
 * limit, one audit address for everybody) and from NOBODY else (or a visitor picks its own
 * address). Read through `serviceContext().ip`, which is what every throttle and audit row keys on.
 * The fake-socket arms drive `toWebRequest` with the verdict `serve()` would take; the socket arms
 * drive `serve()` itself.
 */

const PROXY = "172.18.0.10";
const A = "198.51.100.9";
const B = "192.0.2.44";

/**
 * A real handle, as the host mints a request's: bound to nothing, which a request with no session
 * keeps (the binder refuses no handle at all, and a plain one).
 */
const db = bindDb(await makeTestDb(), { account: null });

/** The client address the route table reads. */
const clientOf = (r: Request): string => serviceContext({ session: null, db } as unknown as ApiDeps, r).ip ?? "";

/** An inbound request on a socket whose peer the test chooses. GET, so no body path is taken. */
function fakeReq(peer: string | undefined, headers: Array<[string, string]>): IncomingMessage {
  const raw = [["Host", "mail.example.com"], ...headers];
  const parsed: Record<string, string> = {};
  for (const [k, v] of raw) parsed[k!.toLowerCase()] = v!;
  return {
    method: "GET", url: "/hello", headers: parsed, rawHeaders: raw.flat(), socket: { remoteAddress: peer },
  } as unknown as IncomingMessage;
}

/** What the route table sees for this peer and these headers, deciding the peer as `serve()` does. */
async function seen(
  set: TrustedProxies | undefined, peer: string | undefined, headers: Array<[string, string]> = [],
  notes: ForwardingNote[] = [],
): Promise<{ ip: string; xff: string | null }> {
  const trust = set
    ? { proxies: set, peerTrusted: await set.trustsPeer(canonicalIp(peer ?? "")), onNote: (n: ForwardingNote) => { notes.push(n); } }
    : undefined;
  const r = toWebRequest(fakeReq(peer, headers), { bodyMaxBytes: 1024, onTooLarge: () => {}, ...(trust ? { trust } : {}) });
  return { ip: clientOf(r), xff: r.headers.get("x-forwarded-for") };
}

const noLookup = async (): Promise<string[]> => { throw new Error("no lookup expected"); };
const set = (...entries: string[]): TrustedProxies => makeTrustedProxies(entries, { lookup: noLookup });

describe("the red control: two clients behind the trusted proxy are two clients", () => {
  it("the proxy's word names each client, so they key apart", async () => {
    const s = set(PROXY);
    expect((await seen(s, `::ffff:${PROXY}`, [["X-Forwarded-For", A]])).ip).toBe(A);
    expect((await seen(s, `::ffff:${PROXY}`, [["X-Forwarded-For", B]])).ip).toBe(B);
  });

  it("without the setting they are one: the proxy (the shape the server shipped with)", async () => {
    expect((await seen(undefined, `::ffff:${PROXY}`, [["X-Forwarded-For", A]])).ip).toBe(`::ffff:${PROXY}`);
    expect((await seen(set(), `::ffff:${PROXY}`, [["X-Forwarded-For", B]])).ip).toBe(PROXY);
  });
});

describe("the spoof controls: nobody but the proxy names a client", () => {
  const forged: Array<[string, string]> = [
    ["X-Forwarded-For", B], ["X-Real-IP", B], ["Forwarded", `for=${B}`], ["X-Vercel-Forwarded-For", B],
  ];

  it("1: with no trusted proxy, every forged header lands on the caller's own address", async () => {
    expect((await seen(undefined, A, forged)).ip).toBe(A);
    expect((await seen(set(), A, forged)).ip).toBe(A);
    expect((await seen(set(PROXY), A, forged)).ip).toBe(A);
  });

  it("2: another container on the proxy's network is not the proxy", async () => {
    expect((await seen(set(PROXY), "172.18.0.66", forged)).ip).toBe("172.18.0.66");
    // Why the bundled default names the proxy and not its network: a CIDR covering the network
    // believes every container on it.
    expect((await seen(set("172.18.0.0/16"), "172.18.0.66", forged)).ip).toBe(B);
  });

  it("3: a published port's gateway is not the proxy either", async () => {
    expect((await seen(set(PROXY), "::ffff:172.18.0.1", forged)).ip).toBe("172.18.0.1");
  });

  it("4: through the proxy only x-forwarded-for is read; X-Real-IP, Forwarded and x-vercel are not", async () => {
    const r = await seen(set(PROXY), PROXY, [
      ["X-Forwarded-For", A], ["X-Real-IP", B], ["Forwarded", `for=${B}`], ["X-Vercel-Forwarded-For", B],
    ]);
    expect(r.ip).toBe(A);
  });

  it("5: the RIGHTMOST address not in the set is the client, never a forged one to its left", async () => {
    expect((await seen(set(PROXY), PROXY, [["X-Forwarded-For", `${B}, ${A}`]])).ip).toBe(A);
    // A trusted terminator in front of the proxy is walked past as well.
    const both = set(PROXY, "172.16.0.0/12");
    expect((await seen(both, PROXY, [["X-Forwarded-For", `${B}, ${A}, 172.18.0.1`]])).ip).toBe(A);
  });

  it("6: a trusted proxy that names nobody leaves NO address, never its own", async () => {
    const notes: ForwardingNote[] = [];
    const none = await seen(set(PROXY), PROXY, [], notes);
    expect(none).toEqual({ ip: "", xff: null });
    expect((await seen(set(PROXY), PROXY, [["X-Forwarded-For", "unknown"]], notes)).ip).toBe("");
    expect((await seen(set(PROXY, "172.16.0.0/12"), PROXY, [["X-Forwarded-For", "172.18.0.1"]], notes)).ip).toBe("");
    expect(notes).toEqual(Array.from({ length: 3 }, () => ({ kind: "no_client_address", peer: PROXY })));
  });
});

describe("one spelling per address at both sites", () => {
  it("a mapped peer and a plain hop are the same client", async () => {
    // Untrusted peer, dual-stack spelling: appended in the proxy's spelling.
    expect((await seen(set(PROXY), "::ffff:203.0.113.7")).ip).toBe("203.0.113.7");
    // The same address written by the proxy.
    expect((await seen(set(PROXY), PROXY, [["X-Forwarded-For", "::ffff:203.0.113.7"]])).ip).toBe("203.0.113.7");
  });

  it("a mapped peer matches a plain literal", async () => {
    expect((await seen(set("172.18.0.5"), "::ffff:172.18.0.5", [["X-Forwarded-For", A]])).ip).toBe(A);
  });
});

describe("serve(): the verdict taken on a real socket", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise((r) => s.close(() => r(null)));
    }
  });

  async function listen(extra: Partial<AdapterOptions>, sink: { ip: string; xff: string | null }[]): Promise<number> {
    const server = makeHttpServer(async (req) => {
      sink.push({ ip: clientOf(req), xff: req.headers.get("x-forwarded-for") });
      return new Response("{}", { status: 200 });
    }, { bodyMaxBytes: 64 * 1024, headersTimeoutMs: 30_000, requestTimeoutMs: 30_000, ...extra });
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
  }

  it("a trusted loopback proxy's header names the client; an untrusted one's is appended to", async () => {
    const sink: { ip: string; xff: string | null }[] = [];
    const trusted = await listen({ trustedProxies: set("127.0.0.1") }, sink);
    await fetch(`http://127.0.0.1:${trusted}/hello`, { headers: { "x-forwarded-for": A } });
    const untrusted = await listen({ trustedProxies: set("10.9.9.9") }, sink);
    await fetch(`http://127.0.0.1:${untrusted}/hello`, { headers: { "x-forwarded-for": A } });
    expect(sink).toEqual([{ ip: A, xff: A }, { ip: "127.0.0.1", xff: `${A}, 127.0.0.1` }]);
  });

  it("through serve(): a name that resolves late is trusted on the first request after it does", async () => {
    let answer: string[] | null = null;
    const proxies = makeTrustedProxies(["proxy"], {
      lookup: async () => { if (answer === null) throw new Error("ENOTFOUND"); return answer; },
      minLookupMs: 0,
    });
    const sink: { ip: string; xff: string | null }[] = [];
    const port = await listen({ trustedProxies: proxies }, sink);
    await fetch(`http://127.0.0.1:${port}/hello`, { headers: { "x-forwarded-for": A } });
    answer = ["127.0.0.1"];
    await fetch(`http://127.0.0.1:${port}/hello`, { headers: { "x-forwarded-for": B } });
    expect(sink.map((s) => s.ip)).toEqual(["127.0.0.1", B]);
  });

  it("an untrusted forwarder is said once per peer, with its address and none of the header", async () => {
    const notes: ForwardingNote[] = [];
    const sink: { ip: string; xff: string | null }[] = [];
    const port = await listen({ trustedProxies: set("10.9.9.9"), onForwardingNote: (n) => { notes.push(n); } }, sink);
    for (let i = 0; i < 3; i++) {
      await fetch(`http://127.0.0.1:${port}/hello`, { headers: { "x-forwarded-for": `203.0.113.${i + 1}` } });
    }
    await fetch(`http://127.0.0.1:${port}/hello`);
    expect(notes).toEqual([{ kind: "untrusted_forwarder", peer: "127.0.0.1" }]);
    expect(JSON.stringify(notes)).not.toMatch(/203\.0\.113/);
    expect(sink).toHaveLength(4);
  });
});

/**
 * THE PROXY'S OWN PEER (`proxyPeerHeader`, the external door's `x-ohmail-proxy-peer`). Caddy names
 * the client it settled on in X-Forwarded-For and its own socket peer in this header; equal, the
 * proxy took nobody's word and every visitor arriving that way is one address. Absent, nothing about
 * the request changes (the desktop's doors and the TLS door).
 */
describe("proxyPeerHeader: the proxy's own peer, read from the proxy alone", () => {
  const HDR = "x-ohmail-proxy-peer";
  const GW = "172.31.228.1";

  async function through(
    peer: string, headers: Array<[string, string]>, opts: { header?: string; trusted: boolean }, notes: ForwardingNote[],
  ): Promise<{ ip: string; peerHeader: string | null }> {
    const s = set(PROXY);
    const trust = { proxies: s, peerTrusted: opts.trusted, onNote: (n: ForwardingNote) => { notes.push(n); } };
    const r = toWebRequest(fakeReq(peer, headers), {
      bodyMaxBytes: 1024, onTooLarge: () => {}, trust, ...(opts.header ? { proxyPeerHeader: opts.header } : {}),
    });
    return { ip: clientOf(r), peerHeader: r.headers.get(HDR) };
  }

  it("absent: the header reaches the handler untouched and nothing is said, even when it equals the client", async () => {
    const notes: ForwardingNote[] = [];
    expect(await through(PROXY, [["X-Forwarded-For", GW], [HDR, GW]], { trusted: true }, notes)).toEqual({ ip: GW, peerHeader: GW });
    expect(await through("172.18.0.66", [[HDR, GW]], { trusted: false }, notes)).toEqual({ ip: "172.18.0.66", peerHeader: GW });
    expect(notes).toEqual([]);
  });

  it("present, from an untrusted peer: dropped unread, so a container cannot plant it", async () => {
    const notes: ForwardingNote[] = [];
    const got = await through("172.18.0.66", [["X-Forwarded-For", "172.18.0.66"], [HDR, "172.18.0.66"]], { header: HDR, trusted: false }, notes);
    expect(got).toEqual({ ip: "172.18.0.66", peerHeader: null });
    expect(notes.map((n) => n.kind)).toEqual(["untrusted_forwarder"]);
  });

  it("present, from the proxy: a client equal to its peer is said, in either spelling, and the header is consumed", async () => {
    const notes: ForwardingNote[] = [];
    expect(await through(PROXY, [["X-Forwarded-For", GW], [HDR, `::ffff:${GW}`]], { header: HDR, trusted: true }, notes))
      .toEqual({ ip: GW, peerHeader: null });
    expect(notes).toEqual([{ kind: "proxy_peer_is_client", peer: GW }]);
  });

  it("present, from the proxy: a client the terminator named is not a collapse; no client is the old note", async () => {
    const notes: ForwardingNote[] = [];
    expect(await through(PROXY, [["X-Forwarded-For", A], [HDR, GW]], { header: HDR, trusted: true }, notes)).toEqual({ ip: A, peerHeader: null });
    expect(await through(PROXY, [[HDR, GW]], { header: HDR, trusted: true }, notes)).toEqual({ ip: "", peerHeader: null });
    expect(notes).toEqual([{ kind: "no_client_address", peer: PROXY }]);
  });

  it("through serve(): said once per collapsed address, with the address only", async () => {
    const notes: ForwardingNote[] = [];
    const seenIps: string[] = [];
    const server = makeHttpServer(async (req) => {
      seenIps.push(`${clientOf(req)}|${req.headers.get(HDR) ?? "-"}`);
      return new Response("{}", { status: 200 });
    }, {
      bodyMaxBytes: 64 * 1024, headersTimeoutMs: 30_000, requestTimeoutMs: 30_000,
      trustedProxies: set("127.0.0.1"), proxyPeerHeader: HDR, onForwardingNote: (n) => { notes.push(n); },
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    try {
      for (const [xff, peerHdr] of [[GW, GW], [GW, GW], ["10.89.228.1", "10.89.228.1"], [A, GW]]) {
        await fetch(`http://127.0.0.1:${port}/hello`, { headers: { "x-forwarded-for": xff!, [HDR]: peerHdr! } });
      }
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r(null)));
    }
    expect(seenIps).toEqual([`${GW}|-`, `${GW}|-`, "10.89.228.1|-", `${A}|-`]);
    expect(notes).toEqual([{ kind: "proxy_peer_is_client", peer: GW }, { kind: "proxy_peer_is_client", peer: "10.89.228.1" }]);
  });
});
