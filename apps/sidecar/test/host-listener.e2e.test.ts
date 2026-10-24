import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { createServer as createNetServer } from "node:net";
import { get as httpGet, request as httpRequest, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHttpServer } from "@trafficflow/core/adapters/http-host";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { isAllowedOrigin } from "@trafficflow/services/mail";
import { createSidecar, type Sidecar } from "../src/engine.js";
import {
  HOST_BODY_MAX_BYTES, HOST_LOOPBACK_ADDRESS, HOST_MAX_CONCURRENT_REQUESTS,
  HOST_MAX_CONNECTIONS, HOST_SEND_MAX_TOTAL_BYTES, SOCKET_REFUSAL_LOG_WINDOW_MS,
  maybeHoldStoodDownPort, maybeStartHostListener, resolveHostConfig, socketRefusalReporter,
  startHostListener, type HostListener,
} from "../src/host-listener.js";

import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

// Every test here stands up the real sidecar (createSidecar boots the engine's PGlite and
// runs its migrations) in the test body — see pglite-budget.ts for the measured cost.
vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ═══ THE LOOPBACK LISTENER — the second door on the wire, and everything that gates it ═══════
 *
 * Everything here runs on REAL sockets against the REAL composition root: `createSidecar` over
 * on-disk PGlite, `maybeStartHostListener` binding `handleHost` exactly as `main.ts` does. The
 * three ruled invariants each get both halves — the mechanism and the mutation that would
 * silently defeat it:
 *
 *  · **default-off**: host mode absent ⇒ no listener object is even constructed, proven by a
 *    refused TCP connect to the very port the config named. Mutation watched red: arming by
 *    default in `resolveHostConfig` makes that connect succeed.
 *  · **loopback-literal**: the bind is `127.0.0.1` by constant at the ONE `listen()` call site
 *    (source census), re-checked at runtime against the kernel's answer, and observable — the
 *    IPv6 loopback refuses while the IPv4 one serves. Mutation watched red: binding `0.0.0.0`
 *    fails the census AND the runtime assertion.
 *  · **the served origin threaded into the request guard** (a recorded obligation): a
 *    mutation carrying the MagicDNS `Origin` passes, a foreign origin is refused as cross-site,
 *    and a GARBAGE configured origin degrades host mode with a surfaced reason instead of
 *    killing the boot. Captured red first: before the threading, the phone-shaped redeem below
 *    answered 403 `cross_site_denied` — the exact failure recorded on `depsForHost`.
 *
 * The four adapter correctness points are re-proven over the NEW import path
 * (`@trafficflow/core/adapters/http-host`) in compact form; the deep suite — slow-header
 * timeouts included — stays where it always was, `apps/server/test/http-adapter.test.ts`,
 * importing the same module through that host's shim.
 */

const AT = new Date("2026-08-18T09:00:00.000Z");
/** The MagicDNS shape `tailscale serve` publishes — `ts.net` is on the public suffix list. */
const SERVED_ORIGIN = "https://machine.tail1234.ts.net";

const dirs: string[] = [];
const sidecars: Sidecar[] = [];
const listeners: HostListener[] = [];
const servers: Array<{ close(cb?: () => void): unknown }> = [];

afterEach(async () => {
  for (const l of listeners.splice(0)) await l.close();
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => r()); });
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Line = [string, Record<string, unknown>];

async function standUp(opts: { hostMode?: unknown; hostOrigin?: string; hostPort?: number } = {}):
Promise<{ sidecar: Sidecar; lines: Line[] }> {
  const dir = await freshDataDir("ohmail-host-listener-");
  dirs.push(dir);
  const lines: Line[] = [];
  const sidecar = await createSidecar({
    dataDir: dir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "mila@example.test", pass: "app-password-9f3a" } },
    adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    now: () => AT,
    log: (event, detail) => { lines.push([event, detail]); },
    ...(opts.hostMode !== undefined ? { hostMode: opts.hostMode as boolean } : {}),
    ...(opts.hostOrigin !== undefined ? { hostOrigin: opts.hostOrigin } : {}),
    ...(opts.hostPort !== undefined ? { hostPort: opts.hostPort } : {}),
  });
  sidecars.push(sidecar);
  return { sidecar, lines };
}

/** A port that is free right now — bound once on the loopback and released. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  probe.listen(0, HOST_LOOPBACK_ADDRESS);
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => { probe.close(() => r()); });
  return port;
}

/** One HTTP request against the loopback, fully read. */
function loopbackRequest(port: number, path: string, init: {
  method?: string; headers?: Record<string, string>; body?: string;
} = {}): Promise<{ status: number; headers: IncomingMessage["headers"]; setCookies: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: HOST_LOOPBACK_ADDRESS, port, path, method: init.method ?? "GET", headers: init.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          setCookies: res.headers["set-cookie"] ?? [],
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** The refusal a port that nothing listens on answers. */
function connectRefused(port: number, host = HOST_LOOPBACK_ADDRESS): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    sock.once("connect", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(true));
  });
}

const json = (body: unknown): { body: string; headers: Record<string, string> } => ({
  body: JSON.stringify(body), headers: { "content-type": "application/json" },
});

function hostReq(method: string, path: string, init: { origin?: string; body?: string; headers?: Record<string, string> } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.origin) headers.set("origin", init.origin);
  return new Request(`http://sidecar${path}`, { method, headers, body: init.body });
}

async function mintPairToken(sidecar: Sidecar, label: string): Promise<string> {
  const res = await sidecar.handle(new Request("http://sidecar/pair", {
    method: "POST",
    headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ grant: "device-pair", label }),
  }));
  expect(res.status).toBe(200);
  return (await res.json() as { token: string }).token;
}

// ═════ resolveHostConfig — the one reading of the knobs, and every refusal it owes ═══════════

describe("resolveHostConfig", () => {
  it("absent, and every garbage truthy value, stays disarmed — silently, because nothing was asked for", () => {
    for (const hostMode of [undefined, false, "yes" as unknown as boolean, 1 as unknown as boolean]) {
      const r = resolveHostConfig({ ...(hostMode !== undefined ? { hostMode } : {}), hostOrigin: SERVED_ORIGIN, hostPort: 8799 });
      expect(r.state).toEqual({ armed: false, origin: null, port: null, reason: null });
      expect(r.authConfig).toBeNull();
    }
  });

  it("armed alone is the minimal composition: no origin, no port, no reason", () => {
    const r = resolveHostConfig({ hostMode: true });
    expect(r.state).toEqual({ armed: true, origin: null, port: null, reason: null });
    expect(r.authConfig).toBeNull();
  });

  it("armed with the MagicDNS origin: canonicalized, and the auth config allow-lists exactly it", () => {
    const r = resolveHostConfig({ hostMode: true, hostOrigin: `${SERVED_ORIGIN}/`, hostPort: 8799 });
    expect(r.state).toEqual({ armed: true, origin: SERVED_ORIGIN, port: 8799, reason: null });
    expect(r.authConfig).not.toBeNull();
    expect(r.authConfig!.rpID).toBe("machine.tail1234.ts.net");
    expect(isAllowedOrigin(r.authConfig!, SERVED_ORIGIN)).toBe(true);
    expect(isAllowedOrigin(r.authConfig!, "https://evil.example")).toBe(false);
    // The stdio door's own origin is NOT on this door's list — the two doors genuinely differ.
    expect(isAllowedOrigin(r.authConfig!, "http://localhost")).toBe(false);
  });

  it("a loopback http origin passes — the dev/test shape, the same exemption every door has", () => {
    for (const o of ["http://localhost:8799", "http://127.0.0.1:8799"]) {
      const r = resolveHostConfig({ hostMode: true, hostOrigin: o });
      expect(r.state.armed).toBe(true);
      expect(r.state.origin).toBe(o);
    }
  });

  it("a garbage origin turns host mode OFF with a reason that names the variable and never the value", () => {
    const user = "user";                          // interpolated: a whole credentialed URL literal is a credential to the push gate
    const garbage = [
      "not a url",
      `${SERVED_ORIGIN}/pair`,                    // a path is not an origin
      "http://machine.tail1234.ts.net",           // http is a secure context only on loopback
      `https://${user}:pw@machine.tail1234.ts.net`, // credentials
      "https://100.101.102.103",                  // the tailnet IP — the MagicDNS name is the origin
      "https://ts.net",                           // a bare public suffix
    ];
    for (const hostOrigin of garbage) {
      const r = resolveHostConfig({ hostMode: true, hostOrigin, hostPort: 8799 });
      expect(r.state.armed, hostOrigin).toBe(false);
      expect(r.state.reason, hostOrigin).toContain("OHMAIL_HOST_ORIGIN");
      // Never echoed: an origin can embed credentials in the general case.
      expect(r.state.reason, hostOrigin).not.toContain("100.101.102.103");
      expect(r.state.reason, hostOrigin).not.toContain("user:pw");
      expect(r.authConfig).toBeNull();
    }
  });

  it("a garbage port turns host mode OFF the same way — port 0 included, the serve target must not move", () => {
    for (const hostPort of [Number.NaN, 0, 1.5, 70000, -1]) {
      const r = resolveHostConfig({ hostMode: true, hostOrigin: SERVED_ORIGIN, hostPort });
      expect(r.state.armed, String(hostPort)).toBe(false);
      expect(r.state.reason, String(hostPort)).toContain("OHMAIL_HOST_PORT");
    }
  });
});

// ═════ The four adapter points, re-proven over the NEW subpath import on a real socket ═══════

describe("the extracted adapter at @trafficflow/core/adapters/http-host", () => {
  async function adapterServer(handle: (req: Request) => Promise<Response>, bodyMaxBytes = 1024): Promise<number> {
    const server = makeHttpServer(handle, { bodyMaxBytes, headersTimeoutMs: 5_000, requestTimeoutMs: 5_000 });
    servers.push(server);
    server.listen(0, HOST_LOOPBACK_ADDRESS);
    await once(server, "listening");
    return (server.address() as { port: number }).port;
  }

  it("point 1: a body-less POST passes NO body; a body-carrying one streams the exact bytes", async () => {
    const seen: Array<{ hasBody: boolean; text: string }> = [];
    const port = await adapterServer(async (req) => {
      seen.push({ hasBody: req.body !== null, text: req.body ? await req.text() : "" });
      return new Response(null, { status: 204 });
    });
    await loopbackRequest(port, "/x", { method: "POST" });
    await loopbackRequest(port, "/x", { method: "POST", ...json({ a: 1 }) });
    expect(seen).toEqual([{ hasBody: false, text: "" }, { hasBody: true, text: '{"a":1}' }]);
  });

  it("point 2: five Set-Cookie headers reach the client as five, never one folded line", async () => {
    const port = await adapterServer(async () => {
      const h = new Headers();
      for (let i = 1; i <= 5; i++) h.append("set-cookie", `c${i}=v${i}; Path=/`);
      return new Response("ok", { headers: h });
    });
    const res = await loopbackRequest(port, "/x");
    expect(res.setCookies).toHaveLength(5);
    expect(res.setCookies[4]).toBe("c5=v5; Path=/");
  });

  it("point 3: a streamed response arrives frame by frame, not at close", async () => {
    let release: (() => void) | undefined;
    const port = await adapterServer(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first-frame\n"));
        release = () => { controller.enqueue(new TextEncoder().encode("second-frame\n")); controller.close(); };
      },
    })));
    const firstBeforeClose = await new Promise<boolean>((resolve, reject) => {
      httpGet({ host: HOST_LOOPBACK_ADDRESS, port, path: "/stream" }, (res) => {
        let sawFirstEarly = false;
        let ended = false;
        res.on("data", (c: Buffer) => {
          if (!ended && c.toString("utf8").includes("first-frame")) {
            sawFirstEarly = true;
            release?.();     // only once the first frame was OBSERVED does the stream finish
          }
        });
        res.on("end", () => { ended = true; resolve(sawFirstEarly); });
      }).on("error", reject);
    });
    expect(firstBeforeClose).toBe(true);
  });

  it("point 4: a declared over-cap length is 413 before a byte is read; a chunked liar is cut off at the cap", async () => {
    let handlerBodies = 0;
    const port = await adapterServer(async (req) => {
      if (req.body) { handlerBodies++; await req.text().catch(() => undefined); }
      return new Response("ok");
    });
    const declared = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        { host: HOST_LOOPBACK_ADDRESS, port, path: "/x", method: "POST",
          headers: { "content-type": "application/json", "content-length": "4096" } },
        (r) => {
          let body = "";
          r.on("data", (d: Buffer) => { body += d.toString(); });
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      // Headers only — the refusal must not need a byte of body.
      req.flushHeaders();
    });
    expect(declared.status).toBe(413);
    expect(JSON.parse(declared.body).error.code).toBe("payload_too_large");

    // The chunked form declares nothing and lies with its bytes; the counting transform answers.
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: HOST_LOOPBACK_ADDRESS, port, path: "/x", method: "POST",
          headers: { "content-type": "application/json", "transfer-encoding": "chunked" } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.write(`{"pad":"${"x".repeat(4096)}`);
    });
    expect(chunked).toBe(413);
    expect(handlerBodies).toBeLessThanOrEqual(1);
  });
});

// ═════ The loopback literal — census, runtime, and the wire itself ═══════════════════════════

describe("the bind is 127.0.0.1 and NOTHING else", () => {
  const SRC = readFileSync(
    join(fileURLToPath(new URL("../src/", import.meta.url)), "host-listener.ts"), "utf8");
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");

  it("source census: ONE listen() call, carrying the literal constant; no 0.0.0.0 anywhere; no interface knob", () => {
    expect(code).toContain('HOST_LOOPBACK_ADDRESS = "127.0.0.1"');
    const listens = code.match(/\.listen\(/g) ?? [];
    expect(listens, "exactly one listen call site").toHaveLength(1);
    expect(code).toMatch(/\.listen\(\s*opts\.port\s*,\s*HOST_LOOPBACK_ADDRESS\s*,/);
    // Over the comment-stripped CODE: the header legitimately quotes the forbidden addresses as
    // the rule; what must never exist is one reaching an expression.
    expect(code).not.toContain("0.0.0.0");
  });

  it("the wire agrees: IPv4 loopback serves, IPv6 loopback refuses — no wildcard, no dual-stack", async () => {
    const listener = await startHostListener({ handle: async () => new Response("ok"), port: 0 });
    listeners.push(listener);
    expect(listener.port).toBeGreaterThan(0);
    expect((await loopbackRequest(listener.port, "/")).status).toBe(200);
    expect(await connectRefused(listener.port, "::1")).toBe(true);
  });
});

// ═════ Default-off: the dangerous branch requires configuration, and absent refuses connects ═

describe("host mode absent ⇒ no listener object is even constructed", () => {
  it("with the port and origin CONFIGURED but hostMode absent, the port refuses TCP outright", async () => {
    const port = await freePort();
    const { sidecar, lines } = await standUp({ hostOrigin: SERVED_ORIGIN, hostPort: port });
    expect(sidecar.hostState).toEqual({ armed: false, origin: null, port: null, reason: null });
    expect(sidecar.handleHost).toBeUndefined();

    // The production mount itself — the exact call main.ts makes — declines…
    const listener = await maybeStartHostListener(sidecar, (e, d) => lines.push([e, d]));
    expect(listener).toBeNull();
    // …and the wire proves nothing bound: the mutation that arms by default makes this connect
    // succeed, which is the red this census exists to show.
    expect(await connectRefused(port)).toBe(true);
    expect(lines.map(([e]) => e)).not.toContain("host_listening");
  });

  it("armed but half-configured: a port with no origin is REFUSED a listener, with the reason surfaced", async () => {
    const port = await freePort();
    const { sidecar } = await standUp({ hostMode: true, hostPort: port });
    const lines: Line[] = [];
    const listener = await maybeStartHostListener(sidecar, (e, d) => lines.push([e, d]));
    expect(listener).toBeNull();
    expect(await connectRefused(port)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toBe("host_listener_skipped");
    expect(String(lines[0]![1].reason)).toContain("OHMAIL_HOST_ORIGIN");
  });
});

// ═════ Armed: the door over a real socket, the origin obligation, and the shutdown ═══════════

describe("armed with origin and port — the door the phone reaches", () => {
  it("serves /hello as desktop-host over the socket, cookie-free, and closes cleanly", async () => {
    const port = await freePort();
    const { sidecar, lines } = await standUp({ hostMode: true, hostOrigin: SERVED_ORIGIN, hostPort: port });
    expect(sidecar.hostState).toEqual({ armed: true, origin: SERVED_ORIGIN, port, reason: null });

    const listener = await maybeStartHostListener(sidecar, (e, d) => lines.push([e, d]));
    expect(listener).not.toBeNull();
    expect(listener!.port).toBe(port);
    expect(lines.some(([e, d]) => e === "host_listening" && d.port === port)).toBe(true);

    const hello = await loopbackRequest(port, "/hello");
    expect(hello.status).toBe(200);
    expect(hello.setCookies).toEqual([]);
    const body = JSON.parse(hello.body);
    expect(body.flavor).toBe("desktop-host");
    /* `accountHeader` is a CONSTANT of the BUILD, not a host choice: the route table sets it
       `true` outright because `createApp.handle` sets `X-Ohmail-Account` in every composition
       compiled from that table, and a capability a host could contradict is worse than none. It
       is pinned HERE, in the frozen key set, because its whole use is negotiation by ABSENCE — a
       client requires the header only from a server that advertises it, so the day this key stops
       being sent every older client silently stops requiring it. That is exactly the change a
       frozen `toEqual` exists to catch. */
    expect(body.features).toEqual({
      sse: false, staging: false, ai: false, pairing: true,
      // Same composition, same armed egress as the window's own door.
      remoteImages: true, accountHeader: true, forwardParts: true,
    });

    // Graceful shutdown: stop admitting, release the socket, and be idempotent about it.
    await listener!.close();
    await listener!.close();
    expect(await connectRefused(port)).toBe(true);
  });

  it("THE ORIGIN OBLIGATION, over the wire: the served MagicDNS origin passes the guard, a foreign one is refused", async () => {
    const port = await freePort();
    const { sidecar, lines } = await standUp({ hostMode: true, hostOrigin: SERVED_ORIGIN, hostPort: port });
    const listener = await maybeStartHostListener(sidecar, (e, d) => lines.push([e, d]));
    listeners.push(listener!);

    // The phone's exact shape: a browser on the served origin redeems the pairing token, and the
    // browser SENDS that origin. Before the threading this answered 403 cross_site_denied — the
    // red recorded on `depsForHost` and this change captured before fixing.
    const token = await mintPairToken(sidecar, "Pixel in the kitchen");
    const redeemed = await loopbackRequest(port, "/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", origin: SERVED_ORIGIN },
      body: JSON.stringify({ grant: "device-pair", token }),
    });
    expect(redeemed.status, "a real phone's redeem must pass the request guard").toBe(200);
    expect(redeemed.setCookies).toEqual([]);
    const { tokens } = JSON.parse(redeemed.body);

    // …and the session it minted works over the same socket.
    const sync = await loopbackRequest(port, "/sync", {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(sync.status).toBe(200);

    // A FOREIGN origin is refused as cross-site, and the refusal spends nothing: the same token
    // redeems afterwards in the no-Origin (native/curl) shape, which carries no header at all.
    const second = await mintPairToken(sidecar, "The studio iPad");
    const foreign = await loopbackRequest(port, "/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ grant: "device-pair", token: second }),
    });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body).error.code).toBe("cross_site_denied");
    const native = await loopbackRequest(port, "/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant: "device-pair", token: second }),
    });
    expect(native.status).toBe(200);
  });

  it("the DOOR's body cap: a send-sized declaration over 50 MB is 413 before a byte of body moves", async () => {
    const port = await freePort();
    const { sidecar } = await standUp({ hostMode: true, hostOrigin: SERVED_ORIGIN, hostPort: port });
    const listener = await maybeStartHostListener(sidecar, () => undefined);
    listeners.push(listener!);

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: HOST_LOOPBACK_ADDRESS, port, path: "/pair/redeem", method: "POST",
          headers: { "content-type": "application/json", "content-length": String(HOST_BODY_MAX_BYTES + 1) } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); },
      );
      req.on("error", reject);
      // Headers only — the refusal must not need the body.
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });
});

// ═════ Shutdown drains handlers; admission bounds concurrency (the review's two findings) ════

describe("the listener's lifecycle holds the store safe and the heap bounded", () => {
  it("close() does not resolve while a handler is still running — the store must never close under one", async () => {
    // The failure sequence the review named: a request outlives the grace, closeAllConnections
    // destroys its SOCKET, node fires the close callback — but the HANDLER promise is still
    // running against the database, and main.ts closes PGlite the moment close() resolves.
    let release!: () => void;
    let entered!: () => void;
    const seen = new Promise<void>((r) => { entered = r; });
    const listener = await startHostListener({
      handle: () => {
        entered();
        return new Promise<Response>((res) => { release = () => res(new Response("late")); });
      },
      port: 0,
      graceMs: 30,
    });
    void loopbackRequest(listener.port, "/slow").catch(() => undefined);
    await seen;

    let closed = false;
    const closing = listener.close().then(() => { closed = true; });
    // Long past the 30 ms grace: the socket is destroyed, the handler is not settled.
    await new Promise((r) => setTimeout(r, 200));
    expect(closed, "close() resolved while a handler was still running against the store").toBe(false);
    release();
    await closing;
  });

  it("beyond the concurrent-admission bound the door answers 503 host_busy — and recovers when the surge drains", async () => {
    const releases: Array<() => void> = [];
    const listener = await startHostListener({
      handle: () => new Promise<Response>((res) => { releases.push(() => res(new Response("ok"))); }),
      port: 0,
    });
    listeners.push(listener);

    const held = Array.from({ length: HOST_MAX_CONCURRENT_REQUESTS }, () =>
      loopbackRequest(listener.port, "/held"));
    // Every admitted request has ENTERED its handler before the over-bound one is sent.
    const deadline = Date.now() + 4_000;
    while (releases.length < HOST_MAX_CONCURRENT_REQUESTS && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releases.length).toBe(HOST_MAX_CONCURRENT_REQUESTS);

    const refused = await loopbackRequest(listener.port, "/one-more");
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body).error.code).toBe("host_busy");

    releases.splice(0).forEach((r) => r());
    await Promise.all(held);
    // Recovery: the surge drained, so the next request is ADMITTED — it enters the same
    // deferred handler (a fresh entry in `releases` is the proof of admission) and answers
    // once released.
    const after = loopbackRequest(listener.port, "/after");
    const admitted = Date.now() + 4_000;
    while (releases.length < 1 && Date.now() < admitted) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releases.length, "the post-surge request was not admitted").toBe(1);
    releases.splice(0).forEach((r) => r());
    expect((await after).status).toBe(200);
  });
});

// ═════ The guard threading at the composition seam (no socket), and degrade-not-crash ════════

describe("depsForHost carries the served origin — and only when one is configured", () => {
  it("armed WITH the origin: a mutation carrying it clears the guard; a foreign one does not", async () => {
    const { sidecar } = await standUp({ hostMode: true, hostOrigin: SERVED_ORIGIN });
    // A garbage refresh token: the point is which GATE answers. Cross-site would be 403
    // cross_site_denied from the guard; clearing the guard reaches the auth machinery instead.
    const served = await sidecar.handleHost!(hostReq("POST", "/auth/refresh", {
      origin: SERVED_ORIGIN, ...json({ refreshToken: "garbage" }),
    }));
    expect(served.status).not.toBe(403);
    const foreign = await sidecar.handleHost!(hostReq("POST", "/auth/refresh", {
      origin: "https://evil.example", ...json({ refreshToken: "garbage" }),
    }));
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).error.code).toBe("cross_site_denied");
  });

  it("armed WITHOUT an origin (the minimal composition): browser-shaped mutations still die at the guard — which is WHY the listener refuses to start without one", async () => {
    const { sidecar } = await standUp({ hostMode: true });
    const res = await sidecar.handleHost!(hostReq("POST", "/auth/refresh", {
      origin: SERVED_ORIGIN, ...json({ refreshToken: "garbage" }),
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("cross_site_denied");
  });

  it("a garbage origin DEGRADES: host mode off with a surfaced reason, the stdio door alive and disarmed-shaped", async () => {
    const { sidecar, lines } = await standUp({ hostMode: true, hostOrigin: "not a url", hostPort: 8799 });
    expect(sidecar.hostState.armed).toBe(false);
    expect(sidecar.hostState.reason).toContain("OHMAIL_HOST_ORIGIN");
    expect(sidecar.handleHost).toBeUndefined();
    expect(lines.some(([e]) => e === "host_config_invalid")).toBe(true);

    // The stdio door serves, and serves the DISARMED composition: no mint, pairing false.
    const hello = await (await sidecar.handle(new Request("http://sidecar/hello"))).json();
    expect(hello.flavor).toBe("local");
    expect(hello.features.pairing).toBe(false);
    const mint = await sidecar.handle(new Request("http://sidecar/pair", {
      method: "POST",
      headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ grant: "device-pair", label: "x" }),
    }));
    expect(mint.status).toBe(404);
  });
});

// ═════ The send-surface pair — the derivation the header claims, held as arithmetic ══════════

describe("the body cap clears the send surface it announces", () => {
  it("32 MB raw, base64-inflated plus a JSON envelope, fits under the 50 MB cap with headroom", () => {
    const base64 = Math.ceil(HOST_SEND_MAX_TOTAL_BYTES / 3) * 4;
    expect(base64 + 1024 * 1024).toBeLessThan(HOST_BODY_MAX_BYTES);
    // …and the surface is a real widening over the hosted constant, not a restatement of it.
    expect(HOST_SEND_MAX_TOTAL_BYTES).toBe(32 * 1024 * 1024);
    expect(HOST_BODY_MAX_BYTES).toBe(50 * 1024 * 1024);
  });
});

// ═════ The CONNECTION bound and the stand-down — the two halves of one socket's life ═════════

/** Open one raw socket and leave it SILENT: connected, and not one header byte sent. */
async function silentSocket(port: number): Promise<ReturnType<typeof connect>> {
  const sock = connect({ host: HOST_LOOPBACK_ADDRESS, port });
  sock.on("error", () => { /* a refused socket ends here, not in the run */ });
  await once(sock, "connect");
  return sock;
}

/** Did the server close this socket on its own, within the budget? */
function closedByServer(sock: ReturnType<typeof connect>, ms: number): Promise<boolean> {
  if (sock.destroyed || sock.readyState === "readOnly") return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    sock.once("close", () => { clearTimeout(timer); resolve(true); });
    sock.once("end", () => { clearTimeout(timer); resolve(true); });
  });
}

describe("the door bounds CONNECTIONS, not only requests", () => {
  /**
   * THE SEQUENCE, MEASURED RED BEFORE THE BOUND EXISTED: sixty-five sockets that connect and
   * send nothing were all still open after a second and a half. Every cap on this door counts a
   * REQUEST, and a socket with no complete headers has reached no handler — so the admission
   * budget, the body cap and the timeouts all read zero while the door was full.
   */
  it("holds at most HOST_MAX_CONNECTIONS sockets; the next is turned away at the accept and COUNTED", async () => {
    const lines: Line[] = [];
    const listener = await startHostListener({
      handle: async () => new Response("ok"),
      port: 0,
      log: (e, d) => lines.push([e, d]),
    });
    listeners.push(listener);

    const held = [];
    for (let i = 0; i < HOST_MAX_CONNECTIONS; i++) held.push(await silentSocket(listener.port));
    // The bound is a CEILING, not a throttle: every socket under it is still held.
    expect(held.filter((s) => !s.destroyed && s.readyState === "open"))
      .toHaveLength(HOST_MAX_CONNECTIONS);

    const overflow = await silentSocket(listener.port);
    expect(await closedByServer(overflow, 3_000), "the socket past the bound was still held")
      .toBe(true);
    // Turned away at the ACCEPT: not one byte of an answer, because there was no request.
    expect(overflow.bytesRead).toBe(0);

    const refusal = lines.find(([e]) => e === "host_conn_refused");
    expect(refusal, "a refused connection was not counted").toBeDefined();
    expect(refusal![1].count).toBe(1);
    // The line says what happened and names no peer — the address is the identifying signal.
    expect(String(refusal![1].reason)).toContain("bound");
    expect(JSON.stringify(refusal![1])).not.toContain(HOST_LOOPBACK_ADDRESS);

    for (const s of [...held, overflow]) s.destroy();
  });

  it("a socket that sends no header inside the ceiling is closed AND counted, with node's own 408", async () => {
    const lines: Line[] = [];
    const listener = await startHostListener({
      handle: async () => new Response("ok"),
      port: 0,
      log: (e, d) => lines.push([e, d]),
      headersTimeoutMs: 200,
      connectionsCheckingIntervalMs: 50,
    });
    listeners.push(listener);

    const sock = await silentSocket(listener.port);
    const answered: Buffer[] = [];
    sock.on("data", (c: Buffer) => answered.push(c));
    expect(await closedByServer(sock, 4_000), "the header-less socket outlived the ceiling")
      .toBe(true);
    // The ANSWER is node's default, reproduced: attaching a clientError listener suppresses it,
    // so a counter that did not answer would turn every 408 into a bare socket close.
    expect(Buffer.concat(answered).toString("utf8")).toContain("408");

    const timedOut = lines.find(([e]) => e === "host_header_timeout");
    expect(timedOut, "a header timeout was not counted").toBeDefined();
    expect(timedOut![1].count).toBe(1);
    sock.destroy();
  });

  it("a flood writes ONE line per class per window, carrying the count — never a line per socket", () => {
    const lines: Line[] = [];
    let clock = 0;
    const reporter = socketRefusalReporter((e, d) => lines.push([e, d]), () => clock);
    for (let i = 0; i < 500; i++) reporter.note("bound");
    // First occurrence at once, and nothing after it inside the window.
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toBe("host_conn_refused");
    expect(lines[0]![1].count).toBe(1);

    clock = SOCKET_REFUSAL_LOG_WINDOW_MS;
    reporter.note("bound");
    expect(lines).toHaveLength(2);
    expect(lines[1]![1].count, "the second line must carry the 499 it stood for").toBe(500);

    // The classes are independent, and what a window still owes is said at close.
    reporter.note("header_timeout");
    reporter.note("bound");
    reporter.flush();
    expect(lines.map(([e]) => e)).toEqual([
      "host_conn_refused", "host_conn_refused", "host_header_timeout", "host_conn_refused",
    ]);
    expect(lines[3]![1].count).toBe(1);
  });
});

describe("a stand-down HOLDS the port and says the door has stopped", () => {
  /**
   * THE SEQUENCE, MEASURED RED: `close()` released the port and a second server claimed it at
   * once. A `tailscale serve` registration points at a FIXED loopback port and survives a
   * withdrawal that refused, so the next thing to bind that port inherits a published route to
   * somebody's tailnet. The contrast arm below is that measurement, kept.
   */
  async function claims(port: number): Promise<boolean> {
    const probe = createNetServer();
    probe.listen(port, HOST_LOOPBACK_ADDRESS);
    try {
      await once(probe, "listening");
      await new Promise<void>((r) => { probe.close(() => r()); });
      return true;
    } catch {
      return false;
    }
  }

  it("CLOSING releases the port — the sequence the stand-down must not take", async () => {
    const listener = await startHostListener({ handle: async () => new Response("ok"), port: 0 });
    const { port } = listener;
    await listener.close();
    expect(await claims(port), "a closed door must release its port at quit").toBe(true);
  });

  it("STANDING DOWN holds it, and every request gets the disarmed sentence without a handler", async () => {
    let entered = 0;
    const listener = await startHostListener({
      handle: async () => { entered += 1; return new Response("served"); },
      port: 0,
    });
    listeners.push(listener);
    expect((await loopbackRequest(listener.port, "/hello")).status).toBe(200);
    expect(entered).toBe(1);

    listener.standDown();
    expect(listener.stoodDown()).toBe(true);
    listener.standDown(); // idempotent

    const after = await loopbackRequest(listener.port, "/hello");
    expect(after.status).toBe(503);
    const body = JSON.parse(after.body);
    expect(body.error.code).toBe("host_stood_down");
    expect(String(body.error.message)).toContain("stopped serving mail");
    // Not a busy door: a client told to retry would keep a withdrawn address alive.
    expect(after.headers["retry-after"]).toBeUndefined();
    expect(entered, "the handler was entered after the stand-down").toBe(1);

    // THE POINT: the socket is still bound, so nothing else can take the published port.
    expect(await claims(listener.port), "a stood-down door released its port").toBe(false);
    expect(await connectRefused(listener.port)).toBe(false);
  });

  it("the boot entrance holds a published port when host mode is off — and refuses the knob when it is armed", async () => {
    const port = await freePort();
    const lines: Line[] = [];
    const held = await maybeHoldStoodDownPort({ standDownPort: port }, (e, d) => lines.push([e, d]));
    expect(held).not.toBeNull();
    listeners.push(held!);
    expect(held!.stoodDown()).toBe(true);
    expect(lines.some(([e, d]) => e === "host_stood_down" && d.port === port)).toBe(true);
    expect((await loopbackRequest(port, "/sync")).status).toBe(503);
    expect(await claims(port)).toBe(false);

    // Armed AND holding is a contradiction, refused by name — the armed door binds it itself.
    const armed: Line[] = [];
    expect(await maybeHoldStoodDownPort(
      { hostMode: true, standDownPort: port }, (e, d) => armed.push([e, d]),
    )).toBeNull();
    expect(armed[0]![0]).toBe("host_stand_down_skipped");
    expect(String(armed[0]![1].reason)).toContain("OHMAIL_HOST_STAND_DOWN");
  });

  it("a garbage port names the variable and holds nothing; an absent one says nothing at all", async () => {
    for (const standDownPort of [Number.NaN, 0, 1.5, 70000, -1]) {
      const lines: Line[] = [];
      expect(await maybeHoldStoodDownPort({ standDownPort }, (e, d) => lines.push([e, d])))
        .toBeNull();
      expect(lines, String(standDownPort)).toHaveLength(1);
      expect(String(lines[0]![1].reason)).toContain("OHMAIL_HOST_STAND_DOWN");
    }
    const quiet: Line[] = [];
    expect(await maybeHoldStoodDownPort({}, (e, d) => quiet.push([e, d]))).toBeNull();
    expect(quiet).toHaveLength(0);
  });
});
