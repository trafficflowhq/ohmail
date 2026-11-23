import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createApp, apiRoutes, authRoutes, desktopApprovalRoutes, type ApiDeps } from "@trafficflow/api";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { makeHttpServer } from "@trafficflow/core/adapters/http-host";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * The browser approval of a desktop sign-in lives on the hosted service only. A self-hosted
 * server answers 404 on every approval route, measured behind its own HTTP adapter with the
 * proxy-shaped forwarding a bundled reverse proxy sends; the hosted table keeps the routes and
 * still tells two networks apart.
 */

const key = (r: { method: string; pattern: string }): string => `${r.method} ${r.pattern}`;
const APPROVAL = ["POST /auth/desktop-approval", "POST /auth/desktop-approval/claim",
  "GET /auth/desktop-approval/:id", "POST /auth/desktop-approval/:id/confirm", "POST /auth/desktop-approval/:id/deny"];

const challenge = (): string =>
  createHash("sha256").update(randomBytes(32).toString("base64url"), "utf8").digest("base64url");

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise((r) => s.close(() => r(null))); }
});

/** `selfHostRoutes` behind the real adapter `apps/server` runs, on a loopback port. */
async function selfHosted(deps: ApiDeps): Promise<string> {
  const app = createApp(selfHostRoutes);
  const server = makeHttpServer((r) => app.handle(r, { ...deps, session: null, idempotency: null }), {
    bodyMaxBytes: 64 * 1024, headersTimeoutMs: 30_000, requestTimeoutMs: 30_000,
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
}

describe("the browser approval of a desktop sign-in is the hosted service's alone", () => {
  it("the tables: every approval route is in the hosted table, none in the self-hosted one", () => {
    expect(desktopApprovalRoutes.map(key)).toEqual(APPROVAL);
    for (const k of APPROVAL) {
      expect(apiRoutes.filter((r) => key(r) === k), k).toHaveLength(1);
      expect(selfHostRoutes.some((r) => key(r) === k), `${k} is mounted on a self-hosted server`).toBe(false);
      expect(authRoutes.some((r) => key(r) === k), `${k} rides in authRoutes, which self-host spreads whole`).toBe(false);
    }
  });

  it("a self-hosted server answers 404 on all five, and still serves the auth surface beside them", async () => {
    const { db, deps } = await makeDeps();
    const base = await selfHosted(deps);
    const me = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const id = randomUUID();
    const json = { "content-type": "application/json", "x-forwarded-for": "198.51.100.9" };
    const bearer = { ...json, authorization: `Bearer ${me.token}` };
    const calls: [string, string, Record<string, string>, string | undefined][] = [
      ["POST", "/auth/desktop-approval", json, JSON.stringify({ challenge: challenge(), kind: "desktop-linux", label: "x" })],
      ["POST", "/auth/desktop-approval/claim", json, JSON.stringify({ approvalId: id, verifier: "v".repeat(43) })],
      ["GET", `/auth/desktop-approval/${id}`, bearer, undefined],
      ["POST", `/auth/desktop-approval/${id}/confirm`, bearer, "{}"],
      ["POST", `/auth/desktop-approval/${id}/deny`, bearer, "{}"],
    ];
    for (const [method, path, headers, body] of calls) {
      const res = await fetch(`${base}${path}`, { method, headers, body });
      const code = ((await res.json()) as { error?: { code?: string } }).error?.code;
      expect([res.status, code], `${method} ${path}`).toEqual([404, "not_found"]);
    }
    // Positive control: the same bearer is a live session on this server, so the 404s above are
    // not an auth refusal, and the auth surface the approval sat in is still mounted.
    expect((await fetch(`${base}/auth/session`, { headers: bearer })).status).toBe(200);
    const sibling = await fetch(`${base}/auth/desktop-claim`, { method: "POST", headers: json, body: "{}" });
    expect(sibling.status, "a sibling auth route must still be mounted").not.toBe(404);
  });

  it("the hosted table keeps them: a desktop and a browser on two networks read different", async () => {
    const { db, deps } = await makeDeps();
    const app = createApp(apiRoutes);
    const H = (r: Request): Promise<Response> => app.handle(r, { ...deps, session: null, idempotency: null });
    const asked = await H(req("POST", "/auth/desktop-approval", {
      headers: { "x-forwarded-for": "198.51.100.9" },
      body: JSON.stringify({ challenge: challenge(), kind: "desktop-linux", label: "studio-mac" }),
    }));
    expect(asked.status, await asked.clone().text()).toBe(200);
    const { approvalId } = (await asked.json()) as { approvalId: string };
    const me = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const read = await H(req("GET", `/auth/desktop-approval/${approvalId}`, {
      bearer: me.token, headers: { "x-forwarded-for": "192.0.2.44" },
    }));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { network?: string }).network).toBe("different");
  });
});
