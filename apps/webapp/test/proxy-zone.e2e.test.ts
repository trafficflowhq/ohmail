import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ZONE_FORWARDED_HEADERS } from "../landing-zone.mjs";

/**
 * THE LANDING ZONE OVER A REAL SOCKET: a production `next build` + `next start` armed with a
 * loopback zone, between an instrumented API and an instrumented ZONE that records what it was
 * handed and answers with its own policy and a cookie marker (`x-ohmail-zone`, the live landing's
 * header). `landing-zone.test.ts` reads the middleware's answer; this reads what crossed the wire.
 * Opt-in like `proxy.e2e.test.ts`, and never beside it: both build into the same `.next`.
 *
 *     TF_PROXY_E2E=1 NODE_OPTIONS=--max-old-space-size=4096 npx vitest run apps/webapp/test/proxy-zone.e2e.test.ts
 */
const ENABLED = process.env.TF_PROXY_E2E === "1";

const WEBAPP = fileURLToPath(new URL("..", import.meta.url));
/** next's own CLI as node resolves it from the web app (the hoisted root copy under npm), run with this node. */
const NEXT_CLI = join(dirname(createRequire(`${WEBAPP}package.json`).resolve("next/package.json")), "dist/bin/next");
const BYPASS = "test-bypass";

interface Seen { method: string; path: string; query: string; headers: IncomingMessage["headers"]; body: string }

let api: Server;
let zone: Server;
let apiPort = 0;
let zonePort = 0;
let appPort = 0;
let next: ChildProcess | null = null;
let apiSeen: Seen[] = [];
let zoneSeen: Seen[] = [];

/** The API's answer, set per test; `{}` (no session) otherwise. */
let apiReply: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
};

/**
 * Every request the zone received, by its header NAMES — what the census below admits. The direct
 * control read carries `x-e2e-direct` and is left out: it is the one request sent past the middleware.
 */
const zoneNames: Array<{ path: string; names: string[]; cache: string | undefined }> = [];

/** The zone answers like the website: its own policy, a static page's cache header (none on `?quiet=1`), the marker. */
const ZONE_CACHE = "public, max-age=0, must-revalidate";
function zoneAnswer(req: IncomingMessage, res: ServerResponse): void {
  if (req.headers["x-e2e-direct"] === undefined) {
    zoneNames.push({ path: req.url ?? "", names: Object.keys(req.headers), cache: req.headers["cache-control"] as string | undefined });
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "zone-policy",
    ...((req.url ?? "").includes("quiet=1") ? {} : { "cache-control": ZONE_CACHE }),
    "x-ohmail-zone": `cookie-${req.headers.cookie ? "arrived" : "absent"}`,
  });
  res.end(`<!doctype html><html><body class="l-zone">${req.method} ${req.url}</body></html>`);
}

async function listen(into: () => Seen[], answer: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      into().push({
        method: req.method ?? "", path: url.pathname, query: url.search, headers: req.headers, body: Buffer.concat(chunks).toString("utf8"),
      });
      answer(req, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: (server.address() as AddressInfo).port };
}

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function run(cmd: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: WEBAPP, env: { ...process.env, ...env }, stdio: "pipe" });
    let out = "";
    p.stdout?.on("data", (d) => { out += String(d); });
    p.stderr?.on("data", (d) => { out += String(d); });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${out}`))));
  });
}

/** One request, every response header as it arrived (a second CSP is invisible through `fetch`). */
interface Raw { status: number; headers: Array<[string, string]>; body: string }
function raw(path: string, init: { method?: string; headers?: Record<string, string>; body?: string; port?: number } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: init.port ?? appPort, path, method: init.method ?? "GET", headers: init.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const headers: Array<[string, string]> = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) headers.push([res.rawHeaders[i]!.toLowerCase(), res.rawHeaders[i + 1]!]);
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
const all = (r: Raw, name: string): string[] => r.headers.filter(([n]) => n === name).map(([, v]) => v);

/** Shaped like an issued token (43 base64url characters), so the gate asks the API about it. */
const GARBAGE = "R2FyYmFnZS10b2tlbi1zaGFwZWQtbGlrZS1hLXJlYWw";
const JAR = `tf_session=${GARBAGE}; tf_owner=acc; tf_csrf=c`;
const coded401 = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code: "unauthorized", message: "authentication required" } }));
};

describe.skipIf(!ENABLED)("the landing zone, over a real socket", () => {
  beforeAll(async () => {
    expect(existsSync(NEXT_CLI), `next's CLI missing at ${NEXT_CLI} — install the workspace's dependencies`).toBe(true);
    ({ server: api, port: apiPort } = await listen(() => apiSeen, (req, res) => apiReply(req, res)));
    ({ server: zone, port: zonePort } = await listen(() => zoneSeen, zoneAnswer));
    appPort = await freePort();
    for (const k of ["NEXT_PUBLIC_DEMO", "NEXT_PUBLIC_API_BASE", "NEXT_PUBLIC_GA_MEASUREMENT_ID", "OHMAIL_FLAVOR"]) delete process.env[k];
    const env = {
      TF_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
      LANDING_ZONE_ORIGIN: `http://127.0.0.1:${zonePort}`,
      LANDING_ZONE_BYPASS: BYPASS,
    };
    await run(process.execPath, [NEXT_CLI, "build"], env);
    next = spawn(process.execPath, [NEXT_CLI, "start", "-p", String(appPort)], { cwd: WEBAPP, env: { ...process.env, ...env }, stdio: "pipe" });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try { await raw("/login"); break; } catch {
        if (Date.now() > deadline) throw new Error("next start did not answer");
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    apiSeen = [];
    zoneSeen = [];
  }, 300_000);

  afterAll(async () => {
    next?.kill("SIGTERM");
    await new Promise<void>((r) => api?.close(() => r()) ?? r());
    await new Promise<void>((r) => zone?.close(() => r()) ?? r());
  });

  it("CONTROL: the zone read DIRECTLY with a cookie says so — the marker can say `arrived`", async () => {
    const r = await raw("/", { port: zonePort, headers: { cookie: "tf_session=x", "x-e2e-direct": "1" } });
    expect(all(r, "x-ohmail-zone")).toEqual(["cookie-arrived"]);
  });

  it("an anonymous `/` is the zone's page under exactly ONE policy, the zone's, with no cookie set", async () => {
    apiSeen = [];
    zoneSeen = [];
    const r = await raw("/");
    expect(r.status).toBe(200);
    expect(r.body).toContain("l-zone");
    expect(all(r, "content-security-policy")).toEqual(["zone-policy"]);
    expect(all(r, "x-content-type-options")).toEqual(["nosniff"]);
    expect(all(r, "x-frame-options")).toEqual(["DENY"]);
    expect(all(r, "referrer-policy")).toEqual(["strict-origin-when-cross-origin"]);
    expect(all(r, "x-ohmail-zone")).toEqual(["cookie-absent"]);
    expect(all(r, "set-cookie")).toEqual([]);
    expect(zoneSeen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /"]);
    expect(zoneSeen[0]!.headers["x-vercel-protection-bypass"]).toBe(BYPASS);
    expect(apiSeen, "an anonymous `/` asked the API").toHaveLength(0);
    for (const [name, value] of r.headers) expect(value, name).not.toContain(BYPASS);
  });

  it("a token-shaped jar the API refuses: still the zone, nothing of the jar handed over", async () => {
    apiReply = coded401;
    apiSeen = [];
    zoneSeen = [];
    const r = await raw("/?quiet=1", { headers: { cookie: JAR } });
    expect(r.status).toBe(200);
    expect(all(r, "x-ohmail-zone")).toEqual(["cookie-absent"]);
    // The middleware marks a cookie-bearing `/` private; with the zone silent on caching, that stands.
    expect(all(r, "cache-control")).toEqual(["private, no-store"]);
    expect(all(r, "set-cookie")).toEqual([]);
    expect(apiSeen.map((s) => s.path)).toEqual(["/auth/session"]);
    expect(zoneSeen).toHaveLength(1);
    expect(zoneSeen[0]!.headers.cookie).toBeUndefined();
    expect(JSON.stringify(zoneSeen[0]!.headers)).not.toContain(GARBAGE);
  });

  it("…and when the zone names its own caching, its header is what arrives: the page carries no cookie of the request", async () => {
    // Measured: the proxied answer's own Cache-Control replaces the middleware's. The zone was handed
    // no cookie, so its answer is the page every anonymous visitor gets and its own caching governs it.
    apiReply = coded401;
    zoneSeen = [];
    const r = await raw("/", { headers: { cookie: JAR } });
    expect(all(r, "x-ohmail-zone")).toEqual(["cookie-absent"]);
    expect(all(r, "cache-control")).toEqual([ZONE_CACHE]);
    expect(zoneSeen[0]!.headers.cookie).toBeUndefined();
  });

  it("the same jar WITH the resume marker is the product's splash, and the zone sees nothing", async () => {
    apiReply = coded401;
    zoneSeen = [];
    const r = await raw("/", { headers: { cookie: `${JAR}; tf_resume=1` } });
    expect(r.status).toBe(200);
    expect(all(r, "x-ohmail-zone")).toEqual([]);
    expect(all(r, "cache-control")).toEqual(["private, no-store"]);
    expect(all(r, "content-security-policy").join(" ")).toMatch(/'nonce-/);
    expect(zoneSeen).toHaveLength(0);
  });

  it("a VALID full session is the app under a nonce, and the zone is never asked", async () => {
    apiReply = (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end((req.url ?? "").startsWith("/auth/session")
        ? JSON.stringify({ user: { userId: "u-1", accountId: "a-1" }, scope: "full" }) : "{}");
    };
    zoneSeen = [];
    const r = await raw("/", { headers: { cookie: `tf_session=${GARBAGE}` } });
    expect(r.status).toBe(200);
    expect(r.body).toContain("app-body");
    expect(r.body).not.toContain("l-zone");
    expect(all(r, "content-security-policy")).toHaveLength(1);
    expect(all(r, "content-security-policy")[0]).toMatch(/script-src 'self' 'nonce-/);
    expect(all(r, "x-ohmail-zone")).toEqual([]);
    expect(all(r, "cache-control")).toEqual(["private, no-store"]);
    expect(zoneSeen).toHaveLength(0);
    apiReply = (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); };
  });

  it("every other zone path: the zone saw no cookie, the bypass, and `rsc` when sent; ONE policy, the zone's", async () => {
    for (const path of [
      "/de", "/privacy", "/imprint", "/subprocessors", "/support", "/delete-account", "/flathub-verification",
      "/.well-known/org.flathub.VerifiedApps.txt", "/site-assets/_next/static/a.js", "/landing/x.webp",
    ]) {
      zoneSeen = [];
      const r = await raw(path, { headers: { cookie: JAR, authorization: "Bearer x", rsc: "1", accept: "*/*" } });
      expect(r.status, path).toBe(200);
      expect(zoneSeen.map((s) => s.path), path).toEqual([path]);
      const seen = zoneSeen[0]!.headers;
      expect(seen.cookie, path).toBeUndefined();
      expect(seen.authorization, path).toBeUndefined();
      expect(seen["x-vercel-protection-bypass"], path).toBe(BYPASS);
      expect(seen.rsc, path).toBe("1");
      expect(all(r, "x-ohmail-zone"), path).toEqual(["cookie-absent"]);
      expect(all(r, "content-security-policy"), path).toEqual(["zone-policy"]);
      expect(all(r, "x-frame-options"), path).toEqual(["DENY"]);
      expect(all(r, "set-cookie"), path).toEqual([]);
      expect(all(r, "service-worker-allowed"), path).toEqual([]);
      for (const [name, value] of r.headers) expect(value, `${path} ${name}`).not.toContain(BYPASS);
    }
  });

  it("the platform's reserved query parameters never reach the zone; every other one does, as sent", async () => {
    zoneSeen = [];
    const r = await raw("/?x-vercel-set-bypass-cookie=true&x-vercel-protection-bypass=clientvalue&_vercel_share=s&ref=x");
    expect(r.status).toBe(200);
    expect(all(r, "set-cookie")).toEqual([]);
    expect(zoneSeen.map((s) => `${s.path}${s.query}`)).toEqual(["/?ref=x"]);
    expect(zoneSeen[0]!.headers["x-vercel-protection-bypass"]).toBe(BYPASS);
    zoneSeen = [];
    const doubled = await raw("/??x-vercel-set-bypass-cookie=true&ref=x");
    expect(all(doubled, "set-cookie")).toEqual([]);
    expect(zoneSeen.map((s) => `${s.path}${s.query}`)).toEqual(["/?ref=x"]);
  });

  it("every spelling the router serves as a zone page reaches the zone, never the in-app copy", async () => {
    for (const [spelling, path] of [
      ["/%70rivacy", "/privacy"], ["/%64e", "/de"], ["/./privacy", "/privacy"], ["/%2e/imprint", "/imprint"],
      ["/privacy/.", "/privacy"], ["/privacy/%2e", "/privacy"], ["/privacy/x/..", "/privacy"], ["/de/.", "/de"],
      ["/imprint/.", "/imprint"], ["/subprocessors/.", "/subprocessors"], ["/%70rivacy/.", "/privacy"],
    ]) {
      zoneSeen = [];
      const r = await raw(spelling!, { headers: { cookie: JAR } });
      expect(r.status, spelling).toBe(200);
      expect(all(r, "x-ohmail-zone"), spelling).toEqual(["cookie-absent"]);
      expect(zoneSeen.map((s) => s.path), spelling).toEqual([path]);
    }
  });

  it("the waitlist POST goes to the zone with its method and body and without the jar; the API never sees it", async () => {
    apiSeen = [];
    zoneSeen = [];
    const body = JSON.stringify({ email: "zone@example.test", tier: "solo" });
    const r = await raw("/api/waitlist", {
      method: "POST", body,
      headers: { cookie: JAR, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
    });
    expect(r.status).toBe(200);
    expect(zoneSeen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /api/waitlist"]);
    expect(zoneSeen[0]!.body).toBe(body);
    expect(zoneSeen[0]!.headers.cookie).toBeUndefined();
    expect(zoneSeen[0]!.headers["content-type"]).toBe("application/json");
    expect(apiSeen.filter((s) => s.path === "/waitlist" || s.path === "/api/waitlist")).toHaveLength(0);
  });

  it("the product's own paths are untouched: `/login` nonce, `/demo` its own policy, a 404 and the internal 308", async () => {
    zoneSeen = [];
    const login = await raw("/login");
    expect(login.status).toBe(200);
    expect(all(login, "content-security-policy")).toHaveLength(1);
    expect(all(login, "content-security-policy")[0]).toMatch(/'nonce-/);
    expect(all(login, "content-security-policy")[0]).not.toMatch(/google/);
    expect(all(login, "x-ohmail-zone")).toEqual([]);
    const demo = await raw("/demo");
    expect(all(demo, "content-security-policy")).toHaveLength(1);
    expect(all(demo, "content-security-policy")[0]).toContain("frame-ancestors 'self'");
    expect(all(demo, "x-ohmail-zone")).toEqual([]);
    const missing = await raw("/no-such-page");
    expect(missing.status).toBe(404);
    expect(all(missing, "x-ohmail-zone")).toEqual([]);
    expect(all(missing, "content-security-policy")).toHaveLength(1);
    expect((await raw("/mailbox")).status).toBe(308);
    expect(zoneSeen, "a product path reached the zone").toHaveLength(0);
  });

  it("a case variant of a zone path is a 308 to the zone's spelling, which the zone answers under its one policy", async () => {
    for (const [variant, path] of [
      ["/PRIVACY", "/privacy"], ["/De", "/de"], ["/Landing/x.webp", "/landing/x.webp"],
      ["/.Well-Known/org.flathub.verifiedapps.txt", "/.well-known/org.flathub.VerifiedApps.txt"],
    ]) {
      zoneSeen = [];
      const r = await raw(variant!, { headers: { cookie: JAR } });
      expect(r.status, variant).toBe(308);
      expect(zoneSeen, `${variant} reached the zone`).toHaveLength(0);
      const location = new URL(all(r, "location")[0]!, `http://127.0.0.1:${appPort}`);
      expect(location.pathname, variant).toBe(path);
      const followed = await raw(`${location.pathname}${location.search}`, { headers: { cookie: JAR } });
      expect(followed.status, path).toBe(200);
      expect(all(followed, "content-security-policy"), path).toEqual(["zone-policy"]);
      expect(all(followed, "x-ohmail-zone"), path).toEqual(["cookie-absent"]);
      expect(zoneSeen.map((s) => s.path), path).toEqual([path]);
    }
  });

  it("CENSUS: every request the zone received carried only the allow-list, the hop's own names and the middleware's cache mark", () => {
    const admitted = new Set([...ZONE_FORWARDED_HEADERS, "x-vercel-protection-bypass", "host", "connection", "x-forwarded-host", "cache-control"]);
    expect(zoneNames.length, "the census saw no zone request").toBeGreaterThan(15);
    expect(zoneNames.flatMap(({ path, names }) => names.filter((n) => !admitted.has(n)).map((n) => `${path} ${n}`))).toEqual([]);
    expect([...new Set(zoneNames.map((z) => z.cache).filter((c) => c !== undefined))]).toEqual(["private, no-store"]);
  });
});
