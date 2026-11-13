import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@trafficflow/core";
import { createApp, apiRoutes, type ApiDeps, type HelloConfig } from "@trafficflow/api";
import { CLIENT_KINDS as ENGINE_KINDS } from "@ohmail/client-engine";
import { CLIENT_HEADER, CLIENT_KINDS, clientIdentityOf, MAX_BYTES } from "../src/client-identity.js";
import { makeDeps, req } from "./helpers.js";

/**
 * THE CLIENT'S NAME IS A COUNT, NEVER AN INPUT. `x-ohmail-client` is read by `GET /hello` alone, parsed
 * to a closed form and written on its `hello_served` line, so the builds in use can be counted. No other
 * line of any request carries it. The server answers every request the same whether the header is
 * absent, valid, a lie or a hostile value, and no raw byte of it reaches a line. Nothing is stored.
 */

const HELLO: HelloConfig = {
  flavor: "managed", needsSetup: false,
  auth: { password: true, totp: true, webauthn: true, publicSignup: false },
  features: { sse: false, staging: true, ai: true, pairing: false, remoteImages: true, scheduleFiles: false },
};

const app = createApp(apiRoutes);
const lines: Array<Record<string, unknown>> = [];
const logger = createLogger({ service: "api", level: "info", sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });

async function helloAs(name: string | null): Promise<{ status: number; body: string; line: Record<string, unknown> | undefined }> {
  const { deps } = await makeDeps();
  lines.length = 0;
  const headers: Record<string, string> = name === null ? {} : { [CLIENT_HEADER]: name };
  const res = await app.handle(req("GET", "/hello", { headers }), { ...deps, session: null, hello: HELLO, logger } as ApiDeps);
  return { status: res.status, body: await res.text(), line: lines.find((l) => l.event === "hello_served") };
}

describe("the parser", () => {
  const parse = (value: string | null) => clientIdentityOf(new Headers(value === null ? {} : { [CLIENT_HEADER]: value }));

  it("reads the five kinds with a release of three small numbers, or dev", () => {
    for (const kind of CLIENT_KINDS) {
      expect(parse(`${kind}/1.0.12`)).toEqual({ clientKind: kind, clientRelease: "1.0.12" });
    }
    expect(parse("phone/dev")).toEqual({ clientKind: "phone", clientRelease: "dev" });
    expect(parse("web/9999.9999.9999")).toEqual({ clientKind: "web", clientRelease: "9999.9999.9999" });
  });

  it("names the same five kinds the clients do", () => {
    expect([...CLIENT_KINDS]).toEqual([...ENGINE_KINDS]);
  });

  it("anything else is unknown, and says nothing more", () => {
    const hostile = [
      null, "", "web", "web/", "/1.0.12", "toaster/1.0.12", "WEB/1.0.12", "web/1.0", "web/1.0.12.1", "web/1.0.12-beta",
      "web/1.0.12+abc", "web/12345.0.0", "web/1.0.12/extra", "web/1.0.12, phone/1.0.12",
      'web/1.0.12"}', "web/1.0.1é", "x".repeat(MAX_BYTES + 1), `web/${"1".repeat(10_000)}`, "web/v1.0.12", "web /1.0.12",
    ];
    for (const value of hostile) {
      const found = (() => { try { return parse(value); } catch { return { clientKind: "threw" }; } })();
      expect(found, JSON.stringify(value)).toEqual({ clientKind: "unknown" });
    }
  });
});

describe("the hello line", () => {
  it("one hello_served line per hello carries the parsed pair", async () => {
    const seen = await helloAs("phone/1.0.12");
    expect(seen.status).toBe(200);
    expect(seen.line).toMatchObject({ event: "hello_served", level: "info", flavor: "managed", clientKind: "phone", clientRelease: "1.0.12" });
    expect(lines.filter((l) => l.event === "hello_served")).toHaveLength(1);
  });

  it("answers the same bytes with no header, a valid one, a lie and a hostile value", async () => {
    const baseline = await helloAs(null);
    expect(baseline.line).toMatchObject({ clientKind: "unknown" });
    expect(baseline.line).not.toHaveProperty("clientRelease");
    for (const name of ["web/1.0.12", "phone/99.0.0", "desktop-engine/0.0.1", "toaster/1.0.12", "x".repeat(10_000)]) {
      const seen = await helloAs(name);
      expect(seen.status, name.slice(0, 20)).toBe(baseline.status);
      expect(seen.body, name.slice(0, 20)).toBe(baseline.body);
    }
  });

  it("rides the hello line alone: a failing request that names its client writes none of it", async () => {
    const { deps } = await makeDeps();
    lines.length = 0;
    const secret = "the-probe-secret";
    const res = await app.handle(
      req("POST", "/internal/fault", { bearer: secret, headers: { [CLIENT_HEADER]: "web/9.9.9" } }),
      {
        ...deps, session: null, idempotency: null, logger, faultLog: { record: async () => {} },
        alerts: { secret, sinks: [], environment: "test" },
      } as unknown as ApiDeps,
    );
    expect(res.status).toBe(500);
    const failure = lines.find((l) => l.event === "request_unhandled");
    expect(failure, "the failing request wrote no line").toBeDefined();
    expect(Object.keys(failure!).filter((k) => k.startsWith("client"))).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain("9.9.9");
  });

  it("no raw byte of a hostile value reaches a line", async () => {
    await helloAs(`web/1.0.12"}{"event":"forged","x":"${"A".repeat(200)}`);
    const written = JSON.stringify(lines);
    expect(written).not.toContain("forged");
    expect(written).not.toContain("AAAA");
    expect(lines.find((l) => l.event === "hello_served")).toMatchObject({ clientKind: "unknown" });
  });

  it("a session route and an anonymous one answer the same with and without it", async () => {
    const { deps } = await makeDeps();
    for (const [method, path] of [["GET", "/health"], ["GET", "/auth/session"], ["GET", "/sync?since=0"]] as const) {
      const bare = await app.handle(req(method, path), { ...deps, session: null } as ApiDeps);
      for (const name of ["web/1.0.12", "phone/99.0.0", "x".repeat(10_000)]) {
        const named = await app.handle(req(method, path, { headers: { [CLIENT_HEADER]: name } }), { ...deps, session: null } as ApiDeps);
        // The status and the error's code: a body may carry a request id or a clock.
        const code = async (r: Response): Promise<unknown> => (await r.clone().json().catch(() => ({})) as { error?: { code?: unknown } }).error?.code;
        expect([named.status, await code(named)], `${method} ${path} ${name.slice(0, 12)}`).toEqual([bare.status, await code(bare)]);
      }
    }
  });
});

describe("nothing decides on it", () => {
  /** Every server source file that spells the header's name. Only the parser may. */
  it("the header's name appears in no server source but the parser's", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const repo = join(here, "..", "..", "..");
    const roots = ["packages/api/src", "packages/services/src", "apps/api-vercel/src", "apps/server/src", "apps/worker/src"];
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|mjs)$/.test(e.name) ? [join(dir, e.name)] : []);
    const spelling = new RegExp(CLIENT_HEADER, "i");
    const files = roots.flatMap((r) => walk(join(repo, r)));
    expect(files.length, "the walk found nothing").toBeGreaterThan(100);
    const spelled = files.filter((f) => spelling.test(readFileSync(f, "utf8"))).map((f) => f.slice(repo.length + 1));
    expect(spelled).toEqual(["packages/api/src/client-identity.ts"]);
  });
});
