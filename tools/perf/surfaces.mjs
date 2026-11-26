import { once, EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request, STATUS_CODES } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildEnvironment,
  buildSurfaces,
  FIXTURE_PROXY_PORT,
  LOOPBACK,
  nextCli,
  spawnLogged,
} from "./surfaces-build.mjs";

const OBSERVERS = "response";
const CLIENT_COOKIE = "perf_client";
const MIRROR_PAGE = "/api/__perf/mirror-state";
const EMPTY_MIRROR_PAGE = "<!doctype html><meta charset=utf-8><title>Mailbox benchmark</title>";
const HOP_HEADERS = [
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function checkedFixture(fixture) {
  if (!fixture) return null;
  const url = new URL(fixture.baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== LOOPBACK ||
    url.username ||
    url.password ||
    url.origin !== fixture.baseUrl
  ) {
    throw new Error("The mailbox fixture must use a bare HTTP IPv4 loopback origin.");
  }
  for (const key of ["sessionToken", "accountId", "mailboxId", "email", "familyId", "csrfToken"]) {
    if (!fixture[key]) throw new Error(`The mailbox fixture did not provide ${key}.`);
  }
  return fixture;
}

function clientName(client) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(client)) throw new Error("Invalid benchmark client label.");
  return client;
}

async function startHttp(handler, port = 0) {
  const server = createServer(handler);
  server.listen(port, LOOPBACK);
  await once(server, "listening");
  return {
    origin: `http://${LOOPBACK}:${server.address().port}`,
    close() {
      return new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}

function mirrorPage(response) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(EMPTY_MIRROR_PAGE);
}

function notify(events, client, method, url, status, queries, timing) {
  const sqlQueries = queries === undefined || queries === null ? null : Number(queries);
  events.emit(OBSERVERS, {
    client,
    method,
    pathname: url.pathname,
    search: url.search,
    status,
    sqlQueries,
    ...timing,
  });
}

function watchResponses(events, listener) {
  events.on(OBSERVERS, listener);
  return () => events.off(OBSERVERS, listener);
}

function webProxy(currentFixture, events, port) {
  return startHttp((incoming, outgoing) => {
    // Use a fixed URL parser base so a client-controlled Host cannot select a destination.
    const path = new URL(incoming.url, `http://${LOOPBACK}`);
    if (incoming.method === "GET" && path.pathname === "/__perf/mirror-state") return mirrorPage(outgoing);
    const fixture = currentFixture();
    if (!fixture) {
      outgoing.writeHead(503).end();
      return;
    }
    const cookies = (incoming.headers.cookie ?? "").split(/;\s*/).filter(Boolean);
    const clientMarker = cookies.find((cookie) => cookie.startsWith(`${CLIENT_COOKIE}=`));
    const label = clientMarker?.slice(CLIENT_COOKIE.length + 1);
    const client = label && /^[a-zA-Z0-9_-]{1,100}$/.test(label) ? label : "web";
    const headers = { ...incoming.headers, "x-perf-client": client };
    for (const name of HOP_HEADERS) delete headers[name];
    const applicationCookies = cookies.filter((cookie) => !cookie.startsWith(`${CLIENT_COOKIE}=`));
    if (applicationCookies.length > 0) headers.cookie = applicationCookies.join("; ");
    else delete headers.cookie;
    const target = new URL(fixture.baseUrl);
    target.pathname = path.pathname;
    target.search = path.search;
    const upstream = request(target, { method: incoming.method, headers }, (reply) => {
      const responseHeaders = { ...reply.headers };
      for (const name of HOP_HEADERS) delete responseHeaders[name];
      outgoing.writeHead(reply.statusCode, responseHeaders);
      reply.pipe(outgoing);
      reply.once("end", () =>
        notify(events, client, incoming.method, path, reply.statusCode, reply.headers["x-perf-sql-queries"]),
      );
      reply.once("error", () => outgoing.destroy());
    });
    outgoing.once("close", () => upstream.destroy());
    upstream.once("error", () => {
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(502).end();
    });
    incoming.pipe(upstream);
  }, port);
}

async function unusedPort() {
  const temporary = await startHttp((_, response) => response.writeHead(404).end());
  const port = new URL(temporary.origin).port;
  await temporary.close();
  return port;
}

async function prepareWebPage(
  page,
  origin,
  fixture,
  { client = "web", webAuth = true, expireAccess = false } = {},
) {
  const context = page.context();
  await context.addCookies([
    { name: CLIENT_COOKIE, value: clientName(client), url: origin, httpOnly: true, sameSite: "Strict" },
  ]);
  if (!webAuth) return;
  if (!fixture) throw new Error("Start the mailbox fixture before preparing a signed-in page.");
  if (expireAccess && !fixture.refreshToken)
    throw new Error("Expired-access mode requires a fixture refresh session.");

  const refreshPath = "/auth/refresh";
  const jar = new Map(
    (await context.cookies([origin, `${origin}${refreshPath}`])).map(({ name, value }) => [name, value]),
  );
  const sameFamily = jar.get("tf_owner") === fixture.accountId && jar.get("tf_family") === fixture.familyId;
  if (expireAccess && sameFamily && !jar.has("tf_refresh")) {
    throw new Error("The warmed profile lost its fixture refresh cookie.");
  }
  if (!sameFamily) {
    const now = Math.floor(Date.now() / 1000);
    const refreshExpiry = now + 90 * 24 * 60 * 60;
    const accessExpiry = fixture.accessExpiresAt
      ? Math.floor(Date.parse(fixture.accessExpiresAt) / 1000)
      : now + 24 * 60 * 60;
    await context.addCookies(
      [
        {
          name: "tf_session",
          value: fixture.sessionToken,
          httpOnly: true,
          sameSite: "Strict",
          expires: accessExpiry,
        },
        { name: "tf_csrf", value: fixture.csrfToken, sameSite: "Strict", expires: accessExpiry },
        { name: "tf_owner", value: fixture.accountId, sameSite: "Strict", expires: refreshExpiry },
        { name: "tf_family", value: fixture.familyId, sameSite: "Strict", expires: refreshExpiry },
        {
          name: "tf_resume",
          value: fixture.resumeMarker ?? "1",
          httpOnly: true,
          sameSite: "Lax",
          expires: refreshExpiry,
        },
      ].map((cookie) => ({ ...cookie, url: origin })),
    );
    if (fixture.refreshToken) {
      // URL-based Playwright cookies derive a path ending in slash. The product's
      // host-only refresh cookie is scoped to the exact door, including its logout child.
      const session = await context.newCDPSession(page);
      try {
        const { success } = await session.send("Network.setCookie", {
          name: "tf_refresh",
          url: origin,
          value: fixture.refreshToken,
          path: refreshPath,
          secure: true,
          httpOnly: true,
          sameSite: "Strict",
          expires: refreshExpiry,
        });
        if (!success) throw new Error("Chromium refused the host-only fixture refresh cookie.");
      } finally {
        await session.detach();
      }
    }
  }

  // Preserve the rotated jar across warm reopens. The aged variant removes the same
  // two browser cookies that expire together while leaving the renewal family intact.
  if (expireAccess) {
    await context.clearCookies({ name: /^tf_(?:session|csrf)$/ });
  }
}

async function startWeb({ runtime, state, revision, currentFixture, events, proxyPort, skipFirstPageProbe }) {
  const webapp = join(runtime, "apps/webapp");
  const port = await unusedPort();
  // Next normalizes IPv4 loopback to localhost in NextURL. Use the same browser
  // origin so middleware's signed-in rewrite stays internal and keeps its cookie.
  const origin = `http://localhost:${port}`;
  const log = join(state, "web-start.log");
  const args = [nextCli(webapp), "start", "-p", port, "-H", "localhost"];
  const localEnv = await buildEnvironment(state, { web: true, revision, proxyPort });
  if (skipFirstPageProbe) localEnv.OHMAIL_FIRST_PAGE_NO_PROBE = "1";
  const { child, done } = spawnLogged(args, { cwd: webapp, env: localEnv, log });
  const deadline = Date.now() + 30_000;
  async function close() {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await done.catch(() => {});
  }
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      const response = await fetch(`${origin}/version`, { signal: AbortSignal.timeout(2_000) }).catch(
        () => null,
      );
      await response?.body?.cancel();
      if (response?.ok) {
        return {
          origin,
          pid: child.pid,
          mirrorPath: MIRROR_PAGE,
          close,
          onResponse: (listener) => watchResponses(events, listener),
          preparePage: (page, options) => prepareWebPage(page, origin, currentFixture(), options),
        };
      }
      await delay(150);
    }
    throw new Error(`Next production server did not become ready. See ${log}`);
  } catch (error) {
    await close();
    throw error;
  }
}

const ASSET_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
  [".wasm", "application/wasm"],
]);

function serveDesktop(root) {
  return startHttp(async (incoming, outgoing) => {
    if (incoming.method !== "GET" && incoming.method !== "HEAD") {
      outgoing.writeHead(405).end();
      return;
    }
    try {
      const path = new URL(incoming.url, `http://${LOOPBACK}`).pathname;
      if (path === MIRROR_PAGE) return mirrorPage(outgoing);
      const file = resolve(root, `.${path === "/" ? "/index.html" : decodeURIComponent(path)}`);
      if (!file.startsWith(`${root}${sep}`)) throw new Error("Invalid asset path.");
      const info = await stat(file);
      if (!info.isFile()) throw new Error("Asset does not exist.");
      const kind = extname(file);
      const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      const headers = {
        "content-type": ASSET_TYPES.get(kind) ?? "application/octet-stream",
        "cache-control": /\/assets\/[^/]+-[\w-]{8}\.[\w]+$/.test(path)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        etag,
      };
      if (incoming.headers["if-none-match"] === etag) {
        outgoing.writeHead(304, headers).end();
      } else {
        outgoing.writeHead(200, { ...headers, "content-length": info.size });
        if (incoming.method === "HEAD") outgoing.end();
        else
          createReadStream(file)
            .on("error", () => outgoing.destroy())
            .pipe(outgoing);
      }
    } catch {
      outgoing.writeHead(404).end();
    }
  });
}

function framed(status, headers, body) {
  const metadata = Buffer.from(
    JSON.stringify({ status, statusText: STATUS_CODES[status] ?? "", h: [...headers] }),
  );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(metadata.length);
  return Buffer.concat([prefix, metadata, body]).toString("base64");
}

function jsonFrame(body) {
  return framed(200, [["content-type", "application/json"]], Buffer.from(JSON.stringify(body)));
}

function bodyForBridge(payload) {
  if (payload.bodyText !== undefined) return payload.bodyText;
  if (payload.body64 !== undefined) return Buffer.from(payload.body64, "base64");
  if (payload.body?.length) return Buffer.from(payload.body);
  return undefined;
}

async function bridgeRequest(payload, fixture, client, events) {
  const base = fixture.baseUrl;
  const url = new URL(payload.url, base);
  if (url.origin !== base || !payload.url.startsWith("/"))
    throw new Error("Desktop request must target the local fixture.");
  const method = payload.method ?? "GET";
  if (method === "GET") {
    switch (url.pathname) {
      case "/health":
        return jsonFrame({
          ok: true,
          mode: "cloud",
          schemaTier: "mail",
          mailboxId: fixture.mailboxId,
          signedIn: true,
          online: true,
          sessionExpired: false,
        });
      case "/mirror/freshness":
        return jsonFrame({ state: "current", asOf: new Date().toISOString(), draining: false });
      case "/cloud/session/wait":
        return jsonFrame({ changed: true, session: null });
    }
  }
  const headers = new Headers(payload.headers);
  for (const name of [...HOP_HEADERS, "content-length", "cookie"]) headers.delete(name);
  headers.set("authorization", `Bearer ${fixture.sessionToken}`);
  headers.set("x-perf-client", client);
  const startedAtMs = performance.timeOrigin + performance.now();
  const reply = await fetch(url, {
    method,
    headers,
    body: bodyForBridge(payload),
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  });
  const bytes = Buffer.from(await reply.arrayBuffer());
  const responseHeaders = new Headers(reply.headers);
  for (const name of [...HOP_HEADERS, "content-length", "content-encoding", "set-cookie"])
    responseHeaders.delete(name);
  notify(events, client, method, url, reply.status, reply.headers.get("x-perf-sql-queries"), {
    startedAtMs,
    endedAtMs: performance.timeOrigin + performance.now(),
    bodyBytes: bytes.length,
  });
  return framed(reply.status, responseHeaders, bytes);
}

function installNativeBridge({ status, origin }) {
  if (window.location.origin !== origin || window !== window.top) return;
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    async invoke(command, payload) {
      if (command === "engine_status") return status;
      if (command !== "engine_request") return null;
      // The Native window holds this request while the healthy fixture has no new session state.
      if (
        (payload.method ?? "GET") === "GET" &&
        /^\/cloud\/session\/wait\?.*\bstate=none(?:&|$)/.test(payload.url)
      ) {
        return new Promise(() => {});
      }
      const encoded = await window.__ohmailPerfBridge(payload);
      const bytes = Uint8Array.fromBase64
        ? Uint8Array.fromBase64(encoded)
        : Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      return bytes.buffer;
    },
  };
}

async function startDesktop({ runtime, currentFixture, events }) {
  const site = await serveDesktop(join(runtime, "apps/desktop/dist"));
  return {
    ...site,
    mirrorPath: MIRROR_PAGE,
    onResponse: (listener) => watchResponses(events, listener),
    async preparePage(page, { client = "desktop" } = {}) {
      const fixture = currentFixture();
      if (!fixture) throw new Error("Start the mailbox fixture before preparing a signed-in page.");
      clientName(client);
      await page.exposeBinding("__ohmailPerfBridge", (source, payload) => {
        if (source.frame !== page.mainFrame() || new URL(source.frame.url()).origin !== site.origin) {
          throw new Error("Desktop bridge request came from outside the benchmark window.");
        }
        return bridgeRequest(payload, fixture, client, events);
      });
      const status = {
        state: "serving",
        mode: "cloud",
        address: fixture.email,
        mailboxId: fixture.mailboxId,
        accountId: fixture.accountId,
        credentialState: "ready",
        noticeDocument: 1,
        noticeSession: 1,
      };
      await page.addInitScript(installNativeBridge, { status, origin: site.origin });
    },
  };
}

export async function startSurfaces({
  runtime,
  state,
  revision,
  fixture,
  surfaces = ["web", "desktop"],
  proxyPort = FIXTURE_PROXY_PORT,
  skipFirstPageProbe = false,
}) {
  runtime = resolve(runtime);
  state = resolve(state);
  await buildSurfaces({ runtime, state, revision, surfaces, proxyPort });
  let activeFixture = checkedFixture(fixture);
  const currentFixture = () => activeFixture;
  const cleanups = [];
  const handles = {};
  async function close() {
    while (cleanups.length) await cleanups.pop()();
  }
  try {
    if (surfaces.includes("web")) {
      const events = new EventEmitter();
      const proxy = await webProxy(currentFixture, events, proxyPort);
      cleanups.push(proxy.close);
      handles.web = await startWeb({
        runtime,
        state,
        revision,
        currentFixture,
        events,
        proxyPort,
        skipFirstPageProbe,
      });
      cleanups.push(handles.web.close);
    }
    if (surfaces.includes("desktop")) {
      handles.desktop = await startDesktop({ runtime, currentFixture, events: new EventEmitter() });
      cleanups.push(handles.desktop.close);
    }
    return {
      ...handles,
      close,
      setFixture(fixture) {
        activeFixture = checkedFixture(fixture);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
