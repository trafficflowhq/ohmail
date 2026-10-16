import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * THE REWRITE ITSELF, EXERCISED — not the config object that describes it.
 *
 * `api-rewrite.test.ts` imports `next.config.mjs` and reads source files. That proves the
 * INTENT and nothing about the behaviour: it never starts Next, never crosses a socket, and
 * so could not have caught any of the things the proxy actually decides — whether the query
 * string survives, what the upstream receives as a path, whether a trailing slash becomes a
 * redirect, whether MULTIPLE `Set-Cookie` headers arrive as separate headers with their
 * attributes intact, what `Host` / `X-Forwarded-Host` pair the API is handed (which is the
 * input to the entire cookie decision), or whether the demo makes a request.
 *
 * So this file runs a PRODUCTION Next build against an INSTRUMENTED upstream that records
 * the exact method, path, query and headers it was handed, and asserts on the recording.
 *
 * ## Why it is opt-in
 *
 * It runs `next build` (≈1 min) and binds two ports. `TF_PROXY_E2E=1` turns it on; it is
 * part of the gate and of any change to `next.config.mjs`. The unit-level file above
 * stays in the default suite as the fast tripwire.
 *
 *     TF_PROXY_E2E=1 npx vitest run apps/webapp/test/proxy.e2e.test.ts
 *
 * ## What it cannot reach
 *
 * This is self-hosted `next start` — a Node proxy. Vercel's edge executes the same rewrite
 * declaration with its own implementation, and nothing outside Vercel can test that. The
 * measurements here are therefore the FLOOR: whatever the deployed edge does, it is at
 * least specified by this. The project's design notes records which assertions are still owed
 * against the real domains after the DNS flip.
 */
const ENABLED = process.env.TF_PROXY_E2E === "1";

const WEBAPP = fileURLToPath(new URL("..", import.meta.url));
/** next's own CLI, resolved the way node resolves it from the web app: the package's own copy where
 *  pnpm installs one, the hoisted root copy where npm does. Run with this node, so no shim is needed. */
function nextCli(): string {
  try {
    return join(dirname(createRequire(`${WEBAPP}package.json`).resolve("next/package.json")), "dist/bin/next");
  } catch {
    return `${WEBAPP}node_modules/next/dist/bin/next`;
  }
}
const NEXT_CLI = nextCli();

/** One recorded inbound request at the upstream — everything the API would have seen. */
interface Seen {
  method: string;
  url: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let upstream: Server;
let upstreamPort = 0;
let next: ChildProcess | null = null;
let appPort = 0;
let seen: Seen[] = [];

/** The response the upstream should give for the NEXT request, set per test. */
let reply: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
};

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url, { redirect: "manual" });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
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

describe.skipIf(!ENABLED)("the /api rewrite, over a real socket", () => {
  beforeAll(async () => {
    expect(existsSync(NEXT_CLI), `next's CLI missing at ${NEXT_CLI} — install the workspace's dependencies`).toBe(true);

    upstreamPort = await freePort();
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${upstreamPort}`);
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          path: url.pathname,
          query: url.search,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        reply(req, res);
      });
    });
    upstream.listen(upstreamPort, "127.0.0.1");
    await once(upstream, "listening");

    appPort = await freePort();
    const origin = `http://127.0.0.1:${upstreamPort}`;
    // `NEXT_PUBLIC_DEMO` is deliberately NOT set: this is the post-flip production shape,
    // the one in which a demo fail-open reaches a live mailbox.
    delete process.env.NEXT_PUBLIC_DEMO;
    delete process.env.NEXT_PUBLIC_API_BASE;
    await run(process.execPath, [NEXT_CLI, "build"], { TF_API_ORIGIN: origin });

    next = spawn(process.execPath, [NEXT_CLI, "start", "-p", String(appPort)], {
      cwd: WEBAPP,
      env: { ...process.env, TF_API_ORIGIN: origin },
      stdio: "pipe",
    });
    await waitFor(`http://127.0.0.1:${appPort}/`);
    seen = [];
  }, 300_000);

  afterAll(async () => {
    next?.kill("SIGTERM");
    await new Promise<void>((r) => upstream?.close(() => r()) ?? r());
  });

  const app = (path: string): string => `http://127.0.0.1:${appPort}${path}`;

  /**
   * One request with an ARBITRARY `Host` header.
   *
   * `fetch` cannot do this: `Host` is a forbidden header name in undici, so a `headers:
   * { host }` is silently dropped and the request arrives as `127.0.0.1:PORT`. The
   * canonical-host rule is a rule ABOUT that header, so testing it needs the raw client.
   */
  interface Raw {
    status: number;
    location: string | null;
    /** Header NAMES as they arrived, in order — the only way to see duplicates. */
    names: string[];
  }
  function withHost(path: string, host: string, headers: Record<string, string> = {}): Promise<Raw> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: appPort, path, method: "GET", headers: { ...headers, host } },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              location: res.headers.location ?? null,
              names: res.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase()),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
  const last = (): Seen => {
    expect(seen.length, "the upstream received nothing").toBeGreaterThan(0);
    return seen[seen.length - 1]!;
  };

  it("STRIPS /api and forwards the query string byte for byte", async () => {
    // The claim the prefix contract rests on. `host-split.pg.test.ts` asserts the API copes
    // with BOTH spellings; this is what says which one the proxy actually sends — and the
    // query has to survive intact or `canonicalQuery` hashes a different request.
    seen = [];
    await fetch(app("/api/sync?since=0&b=2&a=1"));
    expect(last().path).toBe("/sync");
    expect(last().query).toBe("?since=0&b=2&a=1");
    expect(last().method).toBe("GET");
  });

  it("does not strip /api twice, and leaves a look-alike path alone", async () => {
    seen = [];
    await fetch(app("/api/api/sync"));
    expect(last().path).toBe("/api/sync");
    seen = [];
    await fetch(app("/api/apiary"));
    expect(last().path).toBe("/apiary");
  });

  it("forwards an ENCODED path segment without decoding it", async () => {
    // If the proxy decoded `%61` to `a`, the idempotency hash the API takes would differ
    // from the one the direct host takes for the same request.
    seen = [];
    await fetch(app("/api/messages/%61bc/move"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(last().path).toBe("/messages/%61bc/move");
  });

  it("a TRAILING SLASH is a 308 redirect, not a silently different upstream path", async () => {
    // Next's own `skipTrailingSlashRedirect` default. Worth pinning: a client that follows
    // it lands on the canonical path, and one that does not sees a redirect rather than a
    // request that quietly hashed differently.
    seen = [];
    const res = await fetch(app("/api/sync/"), { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/api/sync");
    expect(seen).toHaveLength(0);
  });

  it("carries the METHOD, the body and the request headers the API authenticates on", async () => {
    seen = [];
    await fetch(app("/api/push/subscriptions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "tf_session=sess-value; tf_csrf=csrf-value",
        "x-csrf-token": "csrf-value",
        "idempotency-key": "e2e-key",
        origin: "https://ohmail.app",
      },
      body: JSON.stringify({ transport: "webpush" }),
    });
    const r = last();
    expect(r.method).toBe("POST");
    expect(r.path).toBe("/push/subscriptions");
    expect(r.body).toBe(JSON.stringify({ transport: "webpush" }));
    expect(r.headers.cookie).toBe("tf_session=sess-value; tf_csrf=csrf-value");
    expect(r.headers["x-csrf-token"]).toBe("csrf-value");
    expect(r.headers["idempotency-key"]).toBe("e2e-key");
    expect(r.headers.origin).toBe("https://ohmail.app");
  });

  it("HEAD and OPTIONS reach the upstream as themselves", async () => {
    seen = [];
    await fetch(app("/api/health"), { method: "HEAD" });
    expect(last().method).toBe("HEAD");
    seen = [];
    await fetch(app("/api/health"), { method: "OPTIONS" });
    expect(last().method).toBe("OPTIONS");
  });

  it("adds NO CORS headers of its own — a hostile Origin is the API's decision to make", async () => {
    // The topology's premise is that there is no CORS anywhere. If the proxy answered a
    // preflight, a cross-site page could talk to the API through this app.
    reply = (_req, res) => { res.writeHead(204); res.end(); };
    const res = await fetch(app("/api/sync"), {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    // …and the hostile Origin was handed onward verbatim, so `withRequestGuard` sees it.
    expect(last().headers.origin).toBe("https://evil.example");
    reply = (_req, r2) => { r2.writeHead(200, { "content-type": "application/json" }); r2.end("{}"); };
  });

  it("MULTIPLE Set-Cookie headers survive as separate headers, attributes unmodified", async () => {
    // The whole session lands through this hop. A proxy that folded them into one header,
    // or rewrote `Path` / `Domain` / `SameSite`, would break the login silently — or, worse,
    // widen a cookie the API deliberately kept host-only.
    reply = (_req, res) => {
      res.writeHead(204, {
        "set-cookie": [
          "tf_session=a; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=900",
          "tf_refresh=b; HttpOnly; SameSite=Strict; Secure; Path=/auth/refresh; Max-Age=2592000",
          "tf_csrf=c; SameSite=Strict; Secure; Path=/; Max-Age=900",
        ],
      });
      res.end();
    };
    const res = await fetch(app("/api/auth/logout"), {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(3);
    expect(cookies[0]).toBe("tf_session=a; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=900");
    expect(cookies[1]).toBe("tf_refresh=b; HttpOnly; SameSite=Strict; Secure; Path=/auth/refresh; Max-Age=2592000");
    expect(cookies[2]).toBe("tf_csrf=c; SameSite=Strict; Secure; Path=/; Max-Age=900");
    // No Domain= was introduced anywhere: the cookies stay host-only on this app's origin,
    // which is the property the whole same-origin topology exists to produce.
    for (const c of cookies) expect(c).not.toMatch(/Domain=/i);
    reply = (_req, r2) => { r2.writeHead(200, { "content-type": "application/json" }); r2.end("{}"); };
  });

  it("/auth/refresh — the refresh cookie's OWN path is served, and lands unprefixed", async () => {
    // Without this rewrite `tf_refresh` (Path=/auth/refresh) is stored by the browser and
    // sent to a URL this app does not serve: 404, session never renews, and the failure is
    // invisible until sessions start dying at the access TTL.
    seen = [];
    const res = await fetch(app("/auth/refresh"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tf_refresh=r-value" },
      body: "{}",
    });
    expect(res.status).not.toBe(404);
    expect(last().path).toBe("/auth/refresh");
    expect(last().headers.cookie).toBe("tf_refresh=r-value");
  });

  it("/auth/refresh/logout — the sign-out door below it is served too, with a body or without", async () => {
    // The web signs out here because a browser sends `tf_refresh` nowhere else. Without its own
    // rewrite, or with the page-body refusal in front of it, every web sign-out reads as refused.
    reply = (_req, res) => { res.writeHead(204); res.end(); };
    const presses: Array<{ headers: Record<string, string>; body?: string }> = [
      { headers: { "content-type": "application/json", cookie: "tf_refresh=r-value" }, body: "{}" },
      { headers: { cookie: "tf_refresh=r-value" } },
    ];
    for (const init of presses) {
      seen = [];
      const res = await fetch(app("/auth/refresh/logout"), { method: "POST", redirect: "manual", ...init });
      expect(res.status, JSON.stringify(init.headers)).toBe(204);
      expect(last().path).toBe("/auth/refresh/logout");
      expect(last().method).toBe("POST");
      expect(last().headers.cookie).toBe("tf_refresh=r-value");
    }
    reply = (_req, r2) => { r2.writeHead(200, { "content-type": "application/json" }); r2.end("{}"); };
  });

  it("presents the API with a Host it can decide on, and forwards the browser's own host", async () => {
    // The input to the ENTIRE cookie decision (`assertedHosts`). Recorded rather than
    // asserted to a fixed value: what matters is that a host arrives, and that any
    // X-Forwarded-Host names this app rather than something unlisted.
    seen = [];
    await fetch(app("/api/health"), { headers: { host: `127.0.0.1:${appPort}` } });
    const r = last();
    expect(r.headers.host).toBeDefined();
    const xfh = r.headers["x-forwarded-host"];
    if (xfh !== undefined) expect(String(xfh)).toContain("127.0.0.1");
  });

  it("the DEMO makes no upstream request — with the rewrite armed and the API base baked in", async () => {
    // The adversarial shape: `NEXT_PUBLIC_API_BASE=/api` IS in the bundle and the rewrite
    // IS live, so the demo had every opportunity. This asserts the server half (the
    // document render); the browser half — zero fetch/EventSource/WebSocket from the
    // hydrated page — is the Playwright pass recorded in the project's design notes §.
    seen = [];
    const res = await fetch(app("/?demo=1"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("demo-ribbon");
    expect(seen, "the demo reached the API").toHaveLength(0);

    // …and the repeated-parameter shape that used to fall through to the live client.
    const dup = await fetch(app("/?demo=1&demo=0"));
    expect(await dup.text()).toContain("demo-ribbon");
    expect(seen).toHaveLength(0);
  });

  it("the bundle really does carry /api — so the test above is not vacuous", async () => {
    // Read off the APP document, not `/`: since that change `/` is the marketing page and its
    // chunk has no reason to mention the API base at all. `?demo=1` boots the app shell.
    const html = await fetch(app("/?demo=1")).then((r) => r.text());
    // WHICH chunk carries the inlined `/api` base is a code-splitting detail that moves as
    // routes are added — Next hoists the shared api-client constant into a common chunk once
    // more than one route pulls the shell. The claim under test is only that the bundle the
    // app boots WITH carries `/api` at all, so scan every chunk the document loads, not one.
    const chunks = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[^"]+\.js/g)].map((m) => m[0]))];
    expect(chunks.length, "no chunks in the document").toBeGreaterThan(0);
    const bodies = await Promise.all(chunks.map((c) => fetch(app(c)).then((r) => r.text())));
    expect(bodies.some((js) => js.includes('"/api"')), "no chunk the app loads carries the /api base")
      .toBe(true);
  });

  // ── one origin, two front doors ───────────────────────────────────────
  //
  // `session-gate.test.ts` proves the DECISION as a pure function. These prove the
  // wiring: that middleware actually runs on this build, that a rewrite really does
  // serve the other route group's HTML under the URL `/`, and that the two documents
  // are the two different pages they are supposed to be. Nothing below stubs anything
  // in the app — the instrumented upstream simply answers `GET /auth/session` the way
  // a real API would, which is exactly the seam the gate depends on.

  /** Make the upstream answer `/auth/session` with `body`/`status`; 200 `{}` otherwise. */
  function sessionUpstream(status: number, body: unknown): void {
    reply = (req, res) => {
      if ((req.url ?? "").startsWith("/auth/session")) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
  }
  // The REAL `GET /auth/session` shape — `SessionUser.userId`, not `id`. Spelled out
  // because guessing it shipped a live bug: a valid session rendered the marketing page
  // on the deployed origin while every unit test agreed with the guess.
  const FULL = {
    user: { userId: "u-1", accountId: "a-1", email: "gil@x.example", displayName: "Gil" },
    scope: "full",
  };
  /**
   * A cookie value shaped like one the API could actually have issued.
   *
   * `generateToken()` is `randomBytes(32).toString("base64url")` — 43 characters of
   * base64url — and since the repair `resolveSurface` refuses to spend a network call
   * on a value that could not be one (`looksLikeSessionToken`, the free half of the
   * amplifier fix). This used to be the 10-character string `live-token`, which the gate
   * now correctly declines to look up; the fixture was never realistic, and the check that
   * exposed it is the point.
   */
  const TOKEN = "wtodazjkkdrmkvkkbogsbndzgxedvjdcrzrfabmtjhc-fixture-token";
  const withSession = { headers: { cookie: `tf_session=${TOKEN}` } };

  /* This repository carries the app and not the website: an anonymous `/` with no landing zone armed
     is Next's 404 (the zone, when armed, sends it to the website's deployment). Whatever answers, it is
     never the app, and it asks the API nothing. The website's own cases are process rows of the
     landing repository. */
  it("ANONYMOUS `/` is not the app — the 404 of a tree without the website — and asks the API nothing", async () => {
    seen = [];
    const res = await fetch(app("/"));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain("demo-ribbon");
    expect(html).not.toContain("app-body");      // not the product root layout
    expect(seen, "the anonymous page hit the API").toHaveLength(0);
  });

  it("a VALID full session turns the SAME URL into the app, with no redirect", async () => {
    sessionUpstream(200, FULL);
    seen = [];
    const res = await fetch(app("/"), { ...withSession, redirect: "manual" });
    expect(res.status).toBe(200);                          // NOT a 30x — the URL stays `/`
    const html = await res.text();
    expect(html).toContain("app-body");                    // the product root layout
    expect(html).not.toContain("l-hero");
    // Exactly one upstream call, and it authenticated as a bearer.
    expect(seen.map((r) => r.path)).toEqual(["/auth/session"]);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // A per-user answer must not be reusable by a shared cache. (`Vary` is Next's — it
    // writes its own RSC list over anything middleware sets, which is why middleware
    // does not try; `no-store` is what actually forbids storage.)
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("an EXPIRED / REVOKED cookie gets the anonymous answer, not a broken app shell", async () => {
    sessionUpstream(401, { error: { code: "unauthorized" } });
    seen = [];
    const res = await fetch(app("/"), { ...withSession });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("app-body");
    expect(seen.map((r) => r.path)).toEqual(["/auth/session"]);
  });

  it("an ENROLLMENT-scoped session does NOT get the app", async () => {
    sessionUpstream(200, { user: { userId: "u-1" }, scope: "enrollment" });
    seen = [];
    const res = await fetch(app("/"), { ...withSession });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("app-body");
  });

  it("`?demo=1` is the demo for a SIGNED-IN browser too, and still asks the API nothing", async () => {
    // The zero-network promise has to hold for the state that has something to leak.
    sessionUpstream(200, FULL);
    seen = [];
    const html = await fetch(app("/?demo=1"), { ...withSession }).then((r) => r.text());
    expect(html).toContain("demo-ribbon");
    expect(seen, "the demo reached the API").toHaveLength(0);
  });

  it("the internal rewrite target is not a public URL — it 308s to `/`", async () => {
    sessionUpstream(200, FULL);
    seen = [];
    const res = await fetch(app("/mailbox"), { ...withSession, redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toMatch(/\/$|\/\?/);
    expect(seen, "the guard should not need the API").toHaveLength(0);
  });

  it("the app's manifest and public assets resolve, and ask the API nothing", async () => {
    seen = [];
    const manifest = await fetch(app("/manifest.webmanifest"));
    expect(manifest.status).toBe(200);
    expect((await manifest.json()).start_url).toBe("/");
    for (const asset of ["/og.png", "/favicon.ico"]) {
      expect((await fetch(app(asset))).status, asset).toBe(200);
    }
    expect(seen, "a static path reached the API").toHaveLength(0);
  });

  // ── REPAIR ────────────────────────────────────────────────────────────────────────

  it("THE EVIDENCE for finding 2: the rewrite is COMPILED, the gate is a RUNTIME lookup", async () => {
    // This is the measurement that disproved the claim `middleware.ts` used to make —
    // "Next inlines it into the middleware bundle, so there is no runtime lookup". Both
    // artefacts below come from the `next build` this file just ran, with TF_API_ORIGIN
    // set to the loopback upstream.
    const manifest = readFileSync(`${WEBAPP}.next/routes-manifest.json`, "utf8");
    const bundle = readFileSync(`${WEBAPP}.next/server/middleware.js`, "utf8");
    const origin = `http://127.0.0.1:${upstreamPort}`;

    // The REWRITE: the value is baked into the manifest, so it cannot change without a
    // build, and `apiOrigin()` gates that build against ALLOWED_API_ORIGINS.
    expect(manifest, "the rewrite destination is not compiled in").toContain(`${origin}/:path*`);

    // The GATE: still an environment read at request time. That is not a bug to remove —
    // it is why the allow-list has to exist at runtime too, and the middleware bundle
    // therefore has to CARRY the allow-list.
    expect(bundle).toContain("TF_API_ORIGIN");
    expect(bundle, "the middleware shipped without the allow-list — the gate is unguarded")
      .toContain("https://api.ohmail.app");
  });

  it("an UNKNOWN TF_API_ORIGIN would fail closed — the allow-list travels with the gate", () => {
    // A full behavioural test would need a second build with a hostile value, which
    // `apiOrigin()` refuses at build time by design (that refusal is asserted in
    // api-rewrite.test.ts). What CAN be shown here is that the compiled middleware
    // contains the list it must check against and the refusal path that uses it —
    // `test/api-origin.test.ts` drives every branch of that function directly.
    const bundle = readFileSync(`${WEBAPP}.next/server/middleware.js`, "utf8");
    expect(bundle).toContain("https://api.ohmail.app");
    // The canonical-host list rides along too — it is the other rule that must not depend
    // on external configuration.
    expect(bundle).toContain("www.ohmail.app");
  });

  it("a cookie that CANNOT be a token costs no upstream call at all (finding 6)", async () => {
    // The amplifier. Before this, any `tf_session` value at all — a single character, a
    // path traversal, anything — bought an edge invocation, a cross-host fetch held open
    // for 1.5s, an API invocation and two indexed reads, spent before anything could
    // reject it. `generateToken()` is base64url; a value outside that alphabet is one no
    // session has ever had.
    sessionUpstream(200, FULL);
    for (const junk of ["x", "../../etc/passwd", "<script>", "a".repeat(400)]) {
      seen = [];
      const html = await fetch(app("/"), { headers: { cookie: `tf_session=${junk}` } }).then((r) => r.text());
      expect(html, junk.slice(0, 16)).not.toContain("app-body");
      expect(seen, `a malformed cookie reached the API: ${junk.slice(0, 16)}`).toHaveLength(0);
    }
  });

  it("A REDIRECT-ONLY HOST cannot serve the product, whatever Vercel is configured to do (finding 7)", async () => {
    // The `www` canonicalisation lives in Vercel domain configuration, which is external
    // state nothing in the tree asserts. One commit records what its drift produced:
    // `www.ohmail.app 200` — a 200 that renders the app and refuses every sign-in ceremony
    // (the host is on NEVER_AUTH_HOSTS) with nothing on screen explaining why.
    sessionUpstream(200, FULL);
    seen = [];
    for (const [host, path] of [
      ["www.ohmail.app", "/"],
      ["app.ohmail.app", "/privacy"],
      ["mailoh.app", "/login?next=x"],
      ["WWW.OHMAIL.APP:443", "/imprint"], //  Host is not normalized for us
    ] as const) {
      const res = await withHost(path, host);
      expect(res.status, host).toBe(308);
      expect(res.location, host).toBe(`https://ohmail.app${path}`);
    }
    // …and the check costs nothing: it runs before the cookie is read.
    const res = await withHost("/", "www.ohmail.app", { cookie: `tf_session=${TOKEN}` });
    expect(res.status).toBe(308);
    expect(seen, "the host redirect asked the API something").toHaveLength(0);
  });

  it("the canonical host is LEFT ALONE — no redirect loop", async () => {
    // A default-deny host rule is how a production apex ends up redirecting to itself the
    // first time an alias moves. These are hosts this deployment really answers on.
    // `/login` is a page this tree serves to anyone, so a 200 is the page and not a redirect.
    for (const host of ["ohmail.app", "ohmail-landing-abc.vercel" + ".app", `127.0.0.1:${appPort}`]) {
      const res = await withHost("/login", host);
      expect(res.status, host).toBe(200);
    }
  });

  it("EVERY response carries the security headers this origin used to ship none of (finding 4)", async () => {
    for (const path of ["/", "/privacy", "/login", "/join", "/og.png"]) {
      const res = await fetch(app(path), { redirect: "manual" });
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      // The credential screens carry the stricter `no-referrer` (`middleware.ts` credentialPage).
      const referrer = ["/login", "/join"].includes(path) ? "no-referrer" : "strict-origin-when-cross-origin";
      expect(res.headers.get("referrer-policy"), path).toBe(referrer);
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
      const csp = res.headers.get("content-security-policy");
      expect(csp, `${path} has no CSP`).toBeTruthy();
      // The directives that are the point: nothing may be sent off-origin, and nothing
      // may frame this document.
      expect(csp, path).toContain("connect-src 'self'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).toContain("form-action 'self'");
      expect(csp, path).toContain("base-uri 'self'");
      expect(csp, path).not.toMatch(/https?:\/\//);
    }
  });

  it("the demo route is the real client, framed same-origin under exactly ONE policy", async () => {
    // Two CSP headers are enforced as an INTERSECTION, not last-one-wins — so a blanket
    // `frame-ancestors 'none'` plus a `/demo` override of `'self'` would render the landing's
    // centrepiece as a blank frame. The blanket rule excludes `/demo` instead. And the demo is
    // now the real app in demo mode, so it needs the baseline BUNDLE policy, not a sealed one.
    const res = await fetch(app("/demo"));
    expect(res.status).toBe(200);
    // Counted from the RAW header names: `Headers` merges duplicates into one comma-joined
    // value, so a second CSP would be invisible through `fetch` and very visible to a
    // browser, which would enforce both.
    const raw = await withHost("/demo", "ohmail.app");
    const cspCount = raw.names.filter((n) => n === "content-security-policy").length;
    expect(cspCount, "more than one CSP header on /demo — a browser enforces the intersection").toBe(1);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'"); //  the shipped bundle runs — not a sealed doc
    expect(csp).toContain("script-src 'self'"); //   the /_next chunks load
    expect(csp).toContain("frame-ancestors 'self'"); // …and the landing may still frame it
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("the SIGNED-IN app is served under a NONCE policy, and the page carries that nonce", async () => {
    // The surface that renders mail gets `script-src 'self' 'nonce-…'`, under which
    // `'unsafe-inline'` is ignored. Static marketing keeps the baseline policy because a
    // per-request nonce cannot survive a prerender — see app/security-headers.ts.
    sessionUpstream(200, FULL);
    const res = await fetch(app("/"), { ...withSession });
    const csp = res.headers.get("content-security-policy")!;
    const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce, `no nonce in the app's CSP: ${csp}`).toBeTruthy();
    expect(csp).not.toContain("'unsafe-inline' 'nonce-");

    const html = await res.text();
    expect(html).toContain("app-body");
    // Next stamps its OWN bootstrap scripts from the request header; the hand-written
    // theme-boot script is nonced by (product)/layout.tsx. Both have to be there or the
    // page is a blank screen / a flash of the wrong theme.
    expect(html, "the RSC bootstrap was not nonced — the page would be blank").toContain(`nonce="${nonce}"`);
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]!);
    expect(inline.length).toBeGreaterThan(0);
    for (const attrs of inline) {
      expect(attrs, `an inline <script> with no nonce: ${attrs.slice(0, 80)}`).toContain(`nonce="${nonce}"`);
    }
    // Every response gets a different one.
    const again = await fetch(app("/"), { ...withSession });
    expect(again.headers.get("content-security-policy")).not.toBe(csp);
  });

  it("the credential screens get the strict policy AND a page that satisfies it", async () => {
    // Asserting the header alone would be worse than asserting nothing: a strict
    // `script-src` over a page whose scripts are not nonced is a BLANK SIGN-IN SCREEN,
    // and the header would look perfect while the product was unusable.
    for (const path of ["/login", "/join"]) {
      const res = await fetch(app(path));
      expect(res.status, path).toBe(200);
      const csp = res.headers.get("content-security-policy")!;
      const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce, `${path} has no nonce: ${csp}`).toBeTruthy();

      const html = await res.text();
      const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]!);
      expect(inline.length, `${path} rendered no inline script at all`).toBeGreaterThan(0);
      for (const attrs of inline) {
        expect(attrs, `${path}: an inline <script> with no nonce — the page would not boot`)
          .toContain(`nonce="${nonce}"`);
      }
      // The theme-boot block specifically: it is the one this app writes by hand, and the
      // one Next cannot nonce for us.
      expect(html, `${path} lost the theme boot`).toContain("ohmail.theme");
    }
  });

  it("a request body never reaches a PAGE — every page answers a Server Action request with 405", async () => {
    // The matcher's conditional arms on a real build: the catch-all and `/demo` sit off the
    // literal list, and a body there must still meet the refusal before Next's decoder.
    for (const path of ["/", "/login", "/no-such-page", "/demo"]) {
      const res = await fetch(app(path), {
        method: "POST", redirect: "manual", body: "[]",
        headers: { "next-action": "0123456789abcdef", "content-type": "text/plain;charset=UTF-8" },
      });
      expect(res.status, path).toBe(405);
      expect(res.headers.get("allow"), path).toBe("GET, HEAD");
    }
    const form = await fetch(app("/no-such-page"), {
      method: "POST", redirect: "manual", body: "--x--\r\n",
      headers: { "content-type": "multipart/form-data; boundary=x" },
    });
    expect(form.status).toBe(405);
    expect((await fetch(app("/login"))).status).toBe(200);
    expect((await fetch(app("/login"), { headers: { rsc: "1" } })).status).toBe(200);
    seen = [];
    const refresh = await fetch(app("/auth/refresh"), {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(refresh.status).not.toBe(405);
    expect(seen.some((r) => r.path === "/auth/refresh" && r.method === "POST"), "refresh not proxied").toBe(true);
  });
});
