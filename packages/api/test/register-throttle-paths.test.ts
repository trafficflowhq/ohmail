import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, req } from "./helpers.js";

/**
 * The shared invite counter over the wire: strangers' open signups from one address do not spend
 * the invite path's slots for that address. The service test holds the counters; this one holds
 * the route — the address it keys on is the one `clientIp` reads from the platform header.
 */

const app = createApp(apiRoutes);
const IP = "198.51.100.23";

const post = (deps: ApiDeps, email: string, inviteCode?: string): Promise<Response> =>
  app.handle(req("POST", "/auth/register", {
    headers: { "x-vercel-forwarded-for": IP },
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
