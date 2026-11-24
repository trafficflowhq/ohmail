import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { makeTrustedProxies, toWebRequest } from "@trafficflow/core/adapters/http-host";
import { clientIp } from "../../../packages/api/src/context";
import { addressUnitOf, ipClassOf, networkVerdict } from "../../../packages/services/src/auth/ip-class";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const proofHeader = "x-ohmail-client-ip";

describe("forwarding the browser's client address to the API", () => {
  it("passes the signed address on the external rewrite to the API and the approval check", async () => {
    vi.resetModules();
    const secret = randomBytes(32).toString("hex");
    const origin = "http://localhost:3002";
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("OHMAIL_WEB_PLATFORM", "vercel");
    vi.stubEnv("TF_API_ORIGIN", origin);
    vi.stubEnv("TF_WEB_CLIENT_IP_SECRET", secret);
    const { middleware } = await import("../middleware");
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const client = "2001:db8::7";
    const egress = "198.51.100.5";
    const peer = "192.0.2.5";
    const proxies = makeTrustedProxies([peer], { lookup: async () => [] });
    const trust = { proxies, peerTrusted: await proxies.trustsPeer(peer) };
    const apiPath = "/auth/desktop-approval/request?check=1";
    const browser = new NextRequest("https://web.example.test/api" + apiPath, {
      headers: {
        host: "web.example.test",
        connection: "keep-alive, x-proxy-hop",
        "keep-alive": "timeout=5",
        "x-proxy-hop": "fixture",
        "x-real-ip": `${client} , ${egress}`,
        [proofHeader]: "unverified",
      },
    });
    const response = await middleware(browser);
    const destination = response.headers.get("x-middleware-rewrite");
    // A separate external config rewrite has no explicit request override on its destination.
    const outboundProof = destination
      ? response.headers.get("x-middleware-request-" + proofHeader)
      : browser.headers.get(proofHeader);
    const throughRailway = (directAddress: string, proof: string | null): string => clientIp(toWebRequest({
      method: "GET",
      url: apiPath,
      headers: { host: "api.example.test" },
      rawHeaders: ["Host", "api.example.test", "x-real-ip", directAddress, ...(proof ? [proofHeader, proof] : [])],
      socket: { remoteAddress: peer },
    } as IncomingMessage, { bodyMaxBytes: 1024, onTooLarge: () => {}, trust, clientIpHeader: "x-real-ip", clientIpSecret: secret }));

    const fromBrowser = throughRailway(egress, outboundProof);
    expect(fromBrowser === client).toBe(true);
    expect(destination === origin + apiPath).toBe(true);
    expect(new URL(destination!).host).toBe(new URL(origin).host);
    const overrides = response.headers.get("x-middleware-override-headers")?.split(",");
    for (const name of ["host", "connection", "keep-alive", "x-proxy-hop"]) {
      expect(overrides).not.toContain(name);
      expect(response.headers.has(`x-middleware-request-${name}`)).toBe(false);
    }
    expect(response.headers.has(proofHeader)).toBe(false);
    const fromDesktop = throughRailway(client, null);
    expect(fromDesktop === client).toBe(true);
    const keyOf = (unit: string) => createHmac("sha256", secret).update(unit).digest("hex");
    const asked = ipClassOf(fromDesktop);
    const storedKey = keyOf(addressUnitOf(fromDesktop));
    expect(networkVerdict(asked, storedKey, fromBrowser, keyOf)).toBe("same");

    const forged = outboundProof?.replace(client, egress) ?? null;
    expect(throughRailway(client, forged) === client).toBe(true);
    const fromOtherNetwork = throughRailway(egress, null);
    expect(networkVerdict(asked, storedKey, fromOtherNetwork, keyOf)).toBe("different");
    clock.mockReturnValue(now + 61_000);
    const stale = throughRailway(egress, outboundProof);
    expect(stale === egress).toBe(true);
  });

  it("authenticates the platform address in the upstream request headers", async () => {
    vi.resetModules();
    const secret = randomBytes(32).toString("hex");
    vi.stubEnv("OHMAIL_WEB_PLATFORM", "vercel");
    vi.stubEnv("TF_API_ORIGIN", "http://localhost:3002");
    vi.stubEnv("TF_WEB_CLIENT_IP_SECRET", secret);
    vi.stubEnv("VERCEL", undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { middleware } = await import("../middleware");
    const client = "2001:db8::7";
    const seconds = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(seconds * 1000);
    const payload = `${client};${seconds}`;
    const expected = payload + ";" + createHmac("sha256", secret).update(payload).digest("hex");

    const answer = (path: string, platform: boolean, method = "POST") => middleware(new NextRequest("https://web.example.test" + path, {
      method,
      headers: {
        [proofHeader]: "unverified",
        ...(platform ? { "x-vercel-forwarded-for": "198.51.100.5", "x-real-ip": client } : {}),
      },
    }));
    const headerSent = (response: Response) => response.headers.get("x-middleware-request-" + proofHeader);

    const encoded = await answer("/%61pi/hello", true, "GET");
    expect(headerSent(encoded) === expected).toBe(true);
    expect(encoded.headers.get("x-middleware-rewrite") === "http://localhost:3002/hello").toBe(true);
    const api = await answer("/api/auth/register", true);
    expect(headerSent(api) === expected).toBe(true);
    expect(api.headers.has(proofHeader)).toBe(false);
    const mixed = await answer("/ApI/auth/register", true);
    expect(headerSent(mixed) === expected).toBe(true);
    expect(mixed.headers.get("x-middleware-rewrite") === "http://localhost:3002/auth/register").toBe(true);
    const escaped = await answer("/api/messages/a%2Fb?search=%23", true, "GET");
    expect(escaped.headers.get("x-middleware-rewrite") === "http://localhost:3002/messages/a%2Fb?search=%23").toBe(true);
    expect(headerSent(await answer("/%61pi/waitlist", true, "GET"))).toBeNull();
    const missing = await answer("/api/auth/register", false);
    expect(headerSent(missing)).toBeNull();
    expect(missing.headers.has("x-middleware-rewrite")).toBe(false);
    const waitlist = await answer("/api/waitlist", true);
    expect(headerSent(waitlist)).toBeNull();
    expect(waitlist.headers.has("x-middleware-rewrite")).toBe(false);
  });

  it("scrubs an unsigned proof on an API request outside a Vercel build", async () => {
    vi.resetModules();
    vi.stubEnv("OHMAIL_WEB_PLATFORM", "");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("TF_API_ORIGIN", "http://localhost:3002");
    vi.stubEnv("TF_WEB_CLIENT_IP_SECRET", randomBytes(32).toString("hex"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { middleware } = await import("../middleware");
    const response = await middleware(new NextRequest("https://web.example.test/api/auth/register", {
      method: "POST",
      headers: { [proofHeader]: "unverified", "x-vercel-forwarded-for": "2001:db8::7" },
    }));
    expect(response.headers.has("x-middleware-request-" + proofHeader)).toBe(false);
    expect(response.headers.has("x-middleware-rewrite")).toBe(false);
    const forwarded = response.headers.get("x-middleware-override-headers")?.split(",");
    expect(forwarded).toContain("x-vercel-forwarded-for");
    expect(forwarded).not.toContain(proofHeader);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { secretSet: false, address: "2001:db8::7", missing: "secret" },
    { secretSet: true, address: undefined, missing: "address header" },
    { secretSet: true, address: "invalid", missing: "address header" },
    { secretSet: false, address: undefined, missing: "secret, address header" },
  ])("warns once per isolate about a missing $missing", async ({ secretSet, address, missing }) => {
    vi.resetModules();
    vi.stubEnv("OHMAIL_WEB_PLATFORM", "vercel");
    vi.stubEnv("TF_API_ORIGIN", "http://localhost:3002");
    vi.stubEnv("TF_WEB_CLIENT_IP_SECRET", secretSet ? randomBytes(32).toString("hex") : undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { middleware } = await import("../middleware");
    const request = () => new NextRequest("https://web.example.test/api/hello", {
      headers: { [proofHeader]: "unverified", ...(address ? { "x-real-ip": address } : {}) },
    });
    const response = await middleware(request());
    await middleware(request());
    expect(response.headers.has("x-middleware-rewrite")).toBe(false);
    expect(response.headers.has("x-middleware-request-" + proofHeader)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`Web client address proof missing input: ${missing}`);
  });

  it("matches API paths in any case", async () => {
    expect(await matches("/API/auth/register")).toBe(true);
    expect(await matches("/aPi/auth/register")).toBe(true);
  });

  it("scrubs a client copy on an otherwise skipped route", async () => {
    const { middleware } = await import("../middleware");
    const path = "/auth/refresh";
    const headers = { [proofHeader]: "unverified", "content-type": "application/json" };
    expect(await matches(path)).toBe(false);
    expect(await matches(path, headers)).toBe(true);
    const response = await middleware(new NextRequest("https://web.example.test" + path, { method: "POST", headers }));
    const forwarded = response.headers.get("x-middleware-override-headers")?.split(",");
    expect(forwarded).toContain("content-type");
    expect(forwarded).not.toContain(proofHeader);
    expect(response.headers.get("x-middleware-request-" + proofHeader)).toBeNull();
  });
});

async function matches(url: string, headers?: Record<string, string>): Promise<boolean> {
  const { config } = await import("../middleware");
  const matchConfig = config as Parameters<typeof unstable_doesMiddlewareMatch>[0]["config"];
  return unstable_doesMiddlewareMatch({ config: matchConfig, nextConfig: {}, url, headers });
}
