import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { makeTrustedProxies, toWebRequest } from "@trafficflow/core/adapters/http-host";
import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, req } from "./helpers.js";

/**
 * The shared invite counter over the wire: strangers' open signups from one address do not spend
 * the invite path's slots for that address. The service test holds the counters; this one holds
 * the route — the address it keys on is the last hop written by the API host.
 */

const app = createApp(apiRoutes);
const IP = "198.51.100.23";

const post = (deps: ApiDeps, email: string, inviteCode?: string): Promise<Response> =>
  app.handle(req("POST", "/auth/register", {
    headers: { "x-forwarded-for": IP },
    body: JSON.stringify({
      email, password: "long-signin-password", displayName: "S",
      ...(inviteCode === undefined ? {} : { inviteCode }),
    }),
  }), { ...deps, session: null, idempotency: null });

describe("POST /auth/register keeps the invite path's slots", () => {
  it("a flood of open signups past the public ceiling leaves the invite redeemable", async () => {
    const { deps } = await makeDeps(undefined, {
      publicSignup: true, maxPublicRegistrationsPerWindow: 1, maxRegistrationsPerWindow: 2,
    });
    const flood: number[] = [];
    for (let i = 0; i < 4; i++) flood.push((await post(deps, `stranger${i}@example.com`)).status);
    expect(flood).toEqual([202, 429, 429, 429]);

    // `INVITE-OK` is the operator bootstrap code in the test deps: the invite path, same address.
    expect((await post(deps, "invited1@example.com", "INVITE-OK")).status).toBe(201);
    expect((await post(deps, "invited2@example.com", "INVITE-OK")).status).toBe(201);
    expect((await post(deps, "invited3@example.com", "INVITE-OK")).status).toBe(429);
  });
});

describe("web and direct signups use the same per-client limit", () => {
  it("shares a client's slots across entry points and gives a second client their own slots", async () => {
    const { deps } = await makeDeps(undefined, {
      publicSignup: true, maxPublicRegistrationsPerWindow: 1,
    });
    const proxy = "192.0.2.10";
    const edge = "192.0.2.11";
    const other = "198.51.100.24";
    const clientIpSecret = randomBytes(32).toString("hex");
    const proxies = makeTrustedProxies([proxy], { lookup: async () => [] });
    const options = {
      bodyMaxBytes: 1024,
      onTooLarge: () => {},
      trust: { proxies, peerTrusted: await proxies.trustsPeer(proxy) },
      clientIpSecret,
    };
    const seconds = Math.floor(Date.now() / 1000);
    const signed = (ip: string): string => {
      const payload = `${ip};${seconds}`;
      return payload + ";" + createHmac("sha256", clientIpSecret).update(payload).digest("hex");
    };
    let forwardedProof = false;
    const register = async (email: string, forwarded: string, proof?: string): Promise<number> => {
      const headers = { "x-forwarded-for": forwarded, ...(proof ? { "x-ohmail-client-ip": proof } : {}) };
      const received = toWebRequest({
        headers, rawHeaders: Object.entries(headers).flat(), socket: { remoteAddress: proxy },
      } as unknown as IncomingMessage, options);
      const response = await app.handle(req("POST", "/auth/register", {
        headers: Object.fromEntries(received.headers),
        body: JSON.stringify({ email, password: "long-signin-password", displayName: "S" }),
      }), { ...deps, session: null, idempotency: null });
      forwardedProof ||= received.headers.has("x-ohmail-client-ip");
      return response.status;
    };

    const statuses = [
      await register("direct@example.com", IP),
      await register("web@example.com", edge, signed(IP)),
      await register("changed@example.com", IP, other + signed(IP).slice(IP.length)),
      await register("other@example.com", edge, signed(other)),
    ];
    expect(statuses).toEqual([202, 429, 429, 202]);
    expect(forwardedProof).toBe(false);
  });
});
