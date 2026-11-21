import { expect, it } from "vitest";
import { StaticKeyProvider } from "@trafficflow/core/mail";
import type { ApiDeps, ResolvedSession } from "../src/deps.js";
import { selfHostRoutes } from "../src/routes/self-host.js";

it("issues a routing reference for a full session and accepts only that account until expiry", async () => {
  const keys = StaticKeyProvider.fromSecret(Buffer.alloc(32, 17));
  const route = selfHostRoutes.find((route) => route.method === "GET" && route.pattern === "/auth/session")!;
  const session = (accountId: string, scope: ResolvedSession["scope"] = "full", via: ResolvedSession["via"] = "cookie"): ResolvedSession => ({
    accountId, scope, userId: "person", sessionId: "session", via,
    lastTwofaAt: null,
  });
  let time = 1_000;
  const request = (query: string, session: ResolvedSession | null) => route.handler(
    new Request(`https://server.example.invalid/auth/session?${query}`),
    { session, keyProvider: keys, now: () => new Date(time) } as ApiDeps,
    {},
  );
  expect((await request("settingsPane=devices", null)).status).toBe(401);
  expect((await request("settingsPane=other", session("first", "full", "bearer"))).status).toBe(400);
  const response = await request("settingsPane=devices", session("first", "full", "bearer"));
  expect(response.status).toBe(200);
  const { reference } = await response.json() as { reference: string };
  expect(/^[A-Za-z0-9_-]+$/.test(reference)).toBe(true);
  const check = `settingsHandoff=${reference}`;
  expect((await request(check, session("second"))).status).toBe(409);
  expect((await request(check, session("first", "enrollment"))).status).toBe(401);
  expect((await request(check, null)).status).toBe(401);
  expect((await request(check, session("first", "full", "bearer"))).status).toBe(401);
  expect(await (await request(check, session("first"))).json()).toEqual({ account: "first", pane: "devices" });
  time += 300_000;
  expect((await request(check, session("first"))).status).toBe(410);
});
