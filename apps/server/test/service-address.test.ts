import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SsrfRefusal, assertPublicHttpUrl, assertPublicHttpUrlShape, type HostResolver } from "@trafficflow/core/net";
import { accessOf, type EntitlementsComposition } from "@trafficflow/db";
import { buildProgram } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { isPrivateServiceName, parseServiceAddress } from "../src/settings/service-address.js";
import { NotPrivateNetworkError, privateNetworkFetch } from "../src/settings/private-network-fetch.js";
import { MANAGED_ENV, PROCESS_DOOR, env, fixture, functionDoor, functionInput, recordingLogger } from "./_envs.js";

/**
 * A BEARER OVER PLAIN HTTP, ONLY INSIDE A PRIVATE NETWORK. The rule has two halves and both are
 * here: the address's SHAPE, decided when the settings load, and its RESOLUTION, decided at every
 * dial, with the socket pinned to what was cleared. The sockets below are real.
 */

const ADMITTED = ["plane", "api", "localhost", "plane.localhost", "plane.internal", "billing.railway.internal", "plane.home.arpa", "PLANE.Internal."];
const REFUSED = [
  "plane.example.com", "x.internal.example.com", "plane.local", "plane.lan", "plane.test", "plane.corp",
  "10.0.0.5", "127.0.0.1", "192.168.1.9", "2130706433", "[fd12::1]", "fd12::1", "[::1]", "::ffff:10.0.0.5", "", "plane..internal", "-plane",
];

describe("which names are private by shape", () => {
  it.each(ADMITTED)("%s is a private service name", (host) => { expect(isPrivateServiceName(host)).toBe(true); });
  it.each(REFUSED)("%s is not", (host) => { expect(isPrivateServiceName(host)).toBe(false); });

  it("every name it admits is one the public-address gate refuses: the two sets never overlap", async () => {
    // By shape, where the name carries a private suffix.
    for (const host of ADMITTED.filter((h) => h !== "plane" && h !== "api")) {
      expect(() => assertPublicHttpUrlShape(`https://${host.replace(/\.$/, "")}/`), host).toThrow(SsrfRefusal);
    }
    // A single label has no suffix to read: the public gate refuses it where it resolves, privately.
    const inside: HostResolver = { resolve: async () => ["10.0.0.5"] };
    for (const host of ["plane", "api"]) {
      await expect(assertPublicHttpUrl(`https://${host}/`, inside), host).rejects.toBeInstanceOf(SsrfRefusal);
    }
  });
});

describe("the address of the entitlements program", () => {
  const VAR = "ENTITLEMENTS_URL";

  it("https to anything is admitted, as it always was", () => {
    expect(parseServiceAddress(VAR, "https://plane.example.com")).toEqual({ origin: "https://plane.example.com", hostname: "plane.example.com", transport: "https" });
    expect(parseServiceAddress(VAR, "https://10.0.0.5:8443/").transport).toBe("https");
  });

  it.each(["http://plane.internal:8080", "http://plane", "http://localhost", "http://localhost:3000"])(
    "%s is admitted over plain http, and says so", (raw) => {
      expect(parseServiceAddress(VAR, raw)).toMatchObject({ origin: raw, transport: "http-private" });
    });

  it.each(["http://plane.example.com", "http://10.0.0.5", "http://127.0.0.1", "http://[fd12::1]", "http://x.internal.example.com"])(
    "%s is refused, naming the variable and the rule and never the value", (raw) => {
      let message = "";
      try { parseServiceAddress(VAR, raw); } catch (err) { message = (err as Error).message; }
      expect(message).toContain("ENTITLEMENTS_URL must use https");
      expect(message).not.toContain(new URL(raw).hostname.replace(/[[\]]/g, ""));
    });

  it("a path, a query, credentials or another scheme refuse as before", () => {
    const withCredentials = ["https://", "u", ":", "p", "@", "plane.example.com"].join("");
    for (const raw of ["https://plane.example.com/v1", "https://plane.example.com/?a=1", withCredentials, "ftp://plane", "plane"]) {
      expect(() => parseServiceAddress(VAR, raw), raw).toThrow(/ENTITLEMENTS_URL/);
    }
  });

  it("the settings carry the transport, and refuse the start on a public name over http", () => {
    const load = (url: string) => loadSettings(env(MANAGED_ENV, { ENTITLEMENTS_URL: url }), PROCESS_DOOR);
    expect(load("http://plane.internal:8080").entitlements?.address.transport).toBe("http-private");
    expect(load("https://plane.example.com").entitlements?.address.transport).toBe("https");
    expect(() => load("http://plane.example.com")).toThrow(/ENTITLEMENTS_URL must use https/);
    expect(() => load("http://10.0.0.5")).toThrow(/ENTITLEMENTS_URL must use https/);
  });
});

/** A local server that keeps what it was sent. */
interface Heard { method: string; url: string; auth: string; host: string; body: string }
const servers: Server[] = [];
async function listenOn(address: string, answer: (req: IncomingMessage) => { status: number; body: string; headers?: Record<string, string> } = () => ({ status: 200, body: "{\"ok\":true}" })): Promise<{ port: number; heard: Heard[] }> {
  const heard: Heard[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      heard.push({
        method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization ?? "",
        host: req.headers.host ?? "", body: Buffer.concat(chunks).toString("utf8"),
      });
      const a = answer(req);
      res.writeHead(a.status, { "content-type": "application/json", ...(a.headers ?? {}) });
      res.end(a.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, address, () => resolve()); });
  return { port: (server.address() as { port: number }).port, heard };
}
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((r) => server.close(() => r(null)));
});

/* The suite's own network gate lets a test dial a loopback NAME only, so the dials below name
   `localhost` (and `ip6-localhost`): private service names like any other to the rule under test,
   resolved here by a resolver the test controls. */
const answers = (map: Record<string, string[]>): HostResolver => ({
  resolve: async (host) => {
    const found = map[host];
    if (!found) throw new Error("no such host");
    return found;
  },
});
const BEARER = `Bearer ${fixture("plane", "bearer")}`;
const post = (body = "{\"accountId\":\"a\"}") => ({
  method: "POST" as const, headers: { authorization: BEARER, "content-type": "application/json" },
  body, signal: new AbortController().signal,
});

describe("the dial: resolved, checked and pinned at every call", () => {
  it("a private name that resolves to a private address is dialled there, bearer and Host intact", async () => {
    const { port, heard } = await listenOn("127.0.0.1");
    const seen: unknown[] = [];
    const fetch = privateNetworkFetch(answers({ localhost: ["127.0.0.1"] }), (s) => seen.push(s));
    const res = await fetch(`http://localhost:${port}/v1/access`, post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(heard).toEqual([{ method: "POST", url: "/v1/access", auth: BEARER, host: `localhost:${port}`, body: "{\"accountId\":\"a\"}" }]);
    // The first dial says the family and the count, never an address.
    expect(seen).toEqual([{ family: 4, addresses: 1 }]);
    await fetch(`http://localhost:${port}/v1/access`, post());
    expect(seen).toHaveLength(1);
  });

  it("one public answer among private ones: nothing is sent, to either", async () => {
    const { port, heard } = await listenOn("127.0.0.1");
    const fetch = privateNetworkFetch(answers({ localhost: ["203.0.113.7", "127.0.0.1"] }));
    await expect(fetch(`http://localhost:${port}/v1/access`, post())).rejects.toBeInstanceOf(NotPrivateNetworkError);
    expect(heard, "the bearer left the process").toEqual([]);
  });

  it("a name that resolves to nothing is a fault, never a dial", async () => {
    const { port, heard } = await listenOn("127.0.0.1");
    const fetch = privateNetworkFetch(answers({}));
    await expect(fetch(`http://localhost:${port}/v1/access`, post())).rejects.toBeInstanceOf(NotPrivateNetworkError);
    await expect(privateNetworkFetch(answers({ localhost: [] }))(`http://localhost:${port}/x`, post())).rejects.toBeInstanceOf(NotPrivateNetworkError);
    expect(heard).toEqual([]);
  });

  it("a redirect off the private name is not followed: the 3xx comes back as itself", async () => {
    const elsewhere = await listenOn("127.0.0.1");
    const { port, heard } = await listenOn("127.0.0.1", () => ({ status: 307, body: "{}", headers: { location: `http://127.0.0.1:${elsewhere.port}/v1/access` } }));
    const res = await privateNetworkFetch(answers({ localhost: ["127.0.0.1"] }))(`http://localhost:${port}/v1/access`, post());
    expect(res.status).toBe(307);
    expect(heard).toHaveLength(1);
    expect(elsewhere.heard, "the bearer followed a redirect").toEqual([]);
  });

  it("an IPv6-only private network: the pin carries the family", async () => {
    let v6: { port: number; heard: Heard[] };
    try {
      v6 = await listenOn("::1");
    } catch {
      return;          // a machine with no IPv6 loopback has nothing to dial
    }
    const seen: unknown[] = [];
    const res = await privateNetworkFetch(answers({ "ip6-localhost": ["::1"] }), (s) => seen.push(s))(`http://ip6-localhost:${v6.port}/v1/access`, post());
    expect(res.status).toBe(200);
    expect(v6.heard).toHaveLength(1);
    expect(seen).toEqual([{ family: 6, addresses: 1 }]);
  });
});

describe("through the wiring: the program's own entitlements client", () => {
  const ACCESS = readFileSync(fileURLToPath(new URL(
    "../../../packages/db/test/fixtures/entitlements-port/access-200-active.json", import.meta.url)), "utf8");

  it("an http-private address rides the pinned dial, and /health names the transport", async () => {
    const { port, heard } = await listenOn("127.0.0.1", () => ({ status: 200, body: ACCESS }));
    const { logger, lines } = recordingLogger();
    const settings = loadSettings(env(MANAGED_ENV, { ENTITLEMENTS_URL: `http://localhost:${port}` }), functionDoor());
    const program = buildProgram(settings, functionInput(logger));
    const verdict = await accessOf(program.services.entitlementsPort as EntitlementsComposition, "11111111-1111-4111-8111-111111111111");
    expect(verdict).toMatchObject({ ok: true });
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ method: "POST", url: "/v1/access", auth: `Bearer ${"b".repeat(32)}`, host: `localhost:${port}` });
    expect(lines.filter((l) => l.event === "entitlements_private_dial")).toHaveLength(1);
    const reading = await program.buildDeps(new Request("https://api.ohmail.app/health")).health!.dbTls!(false) as { billing?: unknown };
    expect(reading.billing).toEqual({ transport: "http-private" });
    await program.close();
  });

  it("an https address keeps the ordinary fetch, and /health says https once the client is composed", async () => {
    const { logger } = recordingLogger();
    const program = buildProgram(loadSettings(env(MANAGED_ENV), functionDoor()), functionInput(logger));
    expect(program.services.entitlementsPort).toBeDefined();
    const reading = await program.buildDeps(new Request("https://api.ohmail.app/health")).health!.dbTls!(false) as { billing?: unknown };
    expect(reading.billing).toEqual({ transport: "https" });
    await program.close();
  });
});
