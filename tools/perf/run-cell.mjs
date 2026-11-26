import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism, loadavg, release } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { createResourcePhases } from "./resources.mjs";
import { monitorHost, observeStartup, startTrace, startup } from "./sampling.mjs";
import { startSurfaces } from "./surfaces.mjs";
import { activeUse, runGestures } from "./gestures.mjs";
import {
  addArrivals,
  ageForReopen,
  conditionWarm,
  measureLiveArrival,
  observeArrival,
  waitForArrival,
  watchMirrorSync,
} from "./mirror.mjs";
import { compareMirrorReads, observeLoad } from "./load-trace.mjs";
import { measureResourceDetail } from "./resource-browser.mjs";

const [
  runtimeArg,
  outputArg,
  revision,
  client,
  sizeArg,
  mode,
  quietFile,
  memTool,
  pgBin,
  pgLib,
  proxyPortArg,
] = process.argv.slice(2);
const traceLoad = ["load", "load-unasked", "load-backlog", "load-delayed-script", "load-store"].includes(
  mode,
);
const traceResources = ["resource-detail", "preload-detail", "resource-plateau"].includes(mode);
const skipFirstPageProbe = mode === "load-unasked";
const delayAsset = mode === "load-delayed-script" ? process.env.PERF_DELAY_ASSET : null;
const assetDelayMs = Number(process.env.PERF_DELAY_MS ?? 600);
if (mode === "load-delayed-script" && !/^[\w.-]+\.js$/.test(delayAsset ?? "")) {
  throw Error("Set PERF_DELAY_ASSET to a versioned JavaScript filename for the cold startup control.");
}
if (delayAsset && (!Number.isSafeInteger(assetDelayMs) || assetDelayMs < 0 || assetDelayMs > 2500)) {
  throw Error("Cold startup script delay must be between 0 and 2500 ms.");
}
const sizes = [1000, 10000, 50000, 200000, 400000, 1000000];
const viewports = {
  web: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
};
const size = Number(sizeArg);
if (
  !runtimeArg ||
  !outputArg ||
  !revision ||
  !Object.hasOwn(viewports, client) ||
  !sizes.includes(size) ||
  (!traceLoad && !traceResources && !["interactive", "reopen", "resources"].includes(mode)) ||
  !quietFile
) {
  throw Error("Pass runtime, output, source revision, surface, mailbox size, mode and quiet-file path.");
}
if (client === "desktop" && traceLoad && mode !== "load") {
  throw Error("The load comparison controls require the browser surface.");
}
if (traceResources && client === "phone") throw Error("Resource detail requires a desktop-size surface.");
const runtime = resolve(runtimeArg);
const output = resolve(outputArg);
const surface = client === "desktop" ? "desktop" : "web";
const require = createRequire(join(runtime, "package.json"));
const { chromium } = require("@playwright/test");
const blocked = () => existsSync(quietFile) || loadavg()[0] >= 18;
while (blocked()) await delay(5000);
const folder = join(output, "runs", String(size), client, mode);
await mkdir(folder, { recursive: true });
const dir = await mkdtemp(join(folder, "trial-"));
const tmp = join(dir, "tmp");
await mkdir(tmp, { mode: 0o700 });
const home = join(dir, "home");
await mkdir(home, { mode: 0o700 });
const childEnv = {
  HOME: home,
  TMPDIR: tmp,
  XDG_RUNTIME_DIR: tmp,
  DBUS_SESSION_BUS_ADDRESS: "disabled:",
  PATH: process.env.PATH,
  LANG: "C.UTF-8",
  TZ: "UTC",
  NODE_ENV: "production",
  TSX_DISABLE_CACHE: "1",
};
const doc = {
  revision,
  client,
  size,
  mode,
  viewport: viewports[client],
  phases: {},
  observations: {},
  state: "starting",
  node: process.version,
  kernel: release(),
  coresVisible: availableParallelism(),
  maxObservedLoad: loadavg()[0],
};
const save = async () => {
  await writeFile(join(dir, "pending.json"), JSON.stringify(doc, null, 2), { mode: 0o600 });
  await rename(join(dir, "pending.json"), join(dir, "result.json"));
};
const harness = createHash("sha256");
const tooling = traceLoad || traceResources ? import.meta.dirname : join(runtime, "tools/perf");
for (const file of (await readdir(tooling)).sort()) {
  if (/\.(mjs|ts)$/.test(file)) harness.update(file).update(await readFile(join(tooling, file)));
}
doc.toolingSha256 = harness.digest("hex");
await save();
let dbHost, surfaces, context, fixture, page, sync, stopHealth, resources, loadTrace;
const abort = new AbortController();
let interrupted = false,
  measuring = false,
  stage = "fixture setup";
async function waitForMeasurementWindow() {
  while (blocked() && !interrupted) await delay(1000);
  if (interrupted) throw Error("workstation guard");
}
let stopRun;
const stopped = new Promise((_, reject) => {
  stopRun = reject;
});
stopped.catch(() => {});
const stop = () => {
  if (interrupted) return;
  interrupted = true;
  abort.abort();
  stopRun(Error("workstation guard"));
};
const guard = setInterval(() => {
  if (measuring) {
    doc.maxObservedLoad = Math.max(doc.maxObservedLoad, loadavg()[0]);
    if (blocked()) stop();
  }
}, 250);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
async function freePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
let debugPort;
async function launch({ expireAccess = false, admitted = mode !== "interactive" && !traceLoad } = {}) {
  // Persistent profile keeps the browser mirror and compiled HTTP resources on reopen.
  await waitForMeasurementWindow();
  debugPort = await freePort();
  context = await chromium.launchPersistentContext(join(dir, "profile"), {
    viewport: viewports[client],
    isMobile: client === "phone",
    hasTouch: client === "phone",
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    env: childEnv,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--proxy-server=http://127.0.0.1:9",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${debugPort}`,
    ],
  });
  doc.chromium = context.browser().version();
  page = context.pages()[0] ?? (await context.newPage());
  const health = { pageErrors: 0, failedReads: {}, errorsByStatus: {} };
  (doc.surfaceHealth ??= []).push(health);
  page.on("pageerror", () => {
    health.pageErrors++;
  });
  stopHealth = surfaces[surface].onResponse((event) => {
    if (event.client !== client || event.status < 400) return;
    // A fixed route family without mailbox ids or request parameters.
    const family =
      /^\/(?:api\/)?(sync|messages|auth|search|calendar|mailboxes|sends|drafts)(?:\/|$)/.exec(
        event.pathname,
      )?.[1] ?? "other";
    health.failedReads[family] = (health.failedReads[family] ?? 0) + 1;
    health.errorsByStatus[event.status] = (health.errorsByStatus[event.status] ?? 0) + 1;
  });
  await surfaces[surface].preparePage(page, { client, expireAccess });
  await observeStartup(page);
  sync = watchMirrorSync(page, {
    fixture,
    surface,
    client,
    origin: surfaces[surface].origin,
    onDesktopResponse: surfaces[surface].onResponse,
  });
  if (traceLoad) loadTrace = await observeLoad(context, page, surfaces[surface], client);
  if (admitted) {
    const browserSession = await context.browser().newBrowserCDPSession();
    const hostPids = [fixture.apiPid, fixture.postgresPid, surfaces.web?.pid].filter(Boolean);
    resources = await createResourcePhases({
      isBlocked: blocked,
      signal: abort.signal,
      browserSession,
      hostPids,
      sqlSnapshot,
      onLoad: (value) => {
        if (!blocked()) doc.maxObservedLoad = Math.max(doc.maxObservedLoad, value);
      },
    });
  }
}
async function closeBrowser() {
  resources?.close();
  resources = undefined;
  sync?.stop?.();
  stopHealth?.();
  await loadTrace?.close();
  loadTrace = undefined;
  if (context) await context.close().catch(() => {});
  context = undefined;
}
async function sqlSnapshot() {
  const response = await fetch(new URL("/__perf/stats", fixture.baseUrl), {
    headers: { authorization: `Bearer ${fixture.sessionToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("host statistics unavailable");
  const data = await response.json();
  if (!Number.isFinite(data.totalQueries)) throw Error("host statistics missing SQL count");
  return data;
}
async function totalSQL() {
  return (await sqlSnapshot()).totalQueries;
}
async function phase(name, fn) {
  await waitForMeasurementWindow();
  measuring = true;
  stage = name;
  doc.state = name;
  await save();
  const initialSQL = await totalSQL();
  const finish = monitorHost([fixture.apiPid, fixture.postgresPid, surfaces.web?.pid].filter(Boolean));
  try {
    const value = await fn();
    if (interrupted || blocked()) {
      stop();
      throw Error("workstation guard");
    }
    const stats = finish();
    stats.queries = (await totalSQL()) - initialSQL;
    doc.phases[name] = { value, host: stats };
    await save();
    return value;
  } finally {
    measuring = false;
    finish();
  }
}

async function prepare(name, fn) {
  if (mode === "interactive" || traceLoad) return phase(name, fn);
  stage = name;
  doc.state = name;
  await save();
  let retries = 0;
  const { value, admission } = await resources.active(async (clock) => {
    for (;;) {
      const epoch = await clock.ready();
      try {
        const result = await fn();
        // A successful read has proved the real application state even after a hold.
        // A wall-clock timeout during a hold can be retried on the same browser profile.
        if (!result.failure || (await clock.ready()) === epoch) return result;
      } catch (error) {
        if ((await clock.ready()) === epoch) throw error;
      }
      retries++;
    }
  });
  // These navigations prepare the mirror. Their wall-clock readings cannot be
  // used as startup measurements, even if the guard happened to stay open.
  if (name === "cold" || name === "warm") {
    delete value.documentTtfbMs;
    delete value.firstPaintMs;
    delete value.firstContentfulPaintMs;
    delete value.usableMs;
  }
  doc.phases[name] = { value, admission: { ...admission, purpose: "preparation", retries } };
  await save();
  return value;
}

async function run() {
  const state = join(dir, "mailbox");
  const templatesRoot = process.env.PERF_TEMPLATE_DIRECTORY ?? join(output, "templates");
  const prepared = join(templatesRoot, String(size));
  const templateArgs = existsSync(join(prepared, "template-ready.json")) ? ["--template", prepared] : [];
  const entry = traceResources
    ? "tools/perf/resource-browser-fixture.ts"
    : traceLoad
      ? "tools/perf/load-mailbox-host.ts"
      : "tools/perf/mailbox-host.ts";
  if (traceLoad || traceResources) await copyFile(join(tooling, "mailbox-host.ts"), join(runtime, entry));
  dbHost = spawn(
    process.execPath,
    [
      "--conditions=ohmail-source",
      "--import",
      "tsx",
      entry,
      "--output",
      output,
      "--state",
      state,
      "--rows",
      String(size),
      ...(pgBin ? ["--pg-bin", resolve(pgBin)] : []),
      ...templateArgs,
    ],
    {
      cwd: runtime,
      env: { ...childEnv, ...(pgLib ? { LD_LIBRARY_PATH: resolve(pgLib) } : {}) },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  dbHost.stderr.on("data", (chunk) => {
    // The fixture's short stage / numeric SQLSTATE is enough to diagnose setup;
    // never copy driver exception text or database credentials to a result file.
    const stageMatch = String(chunk).match(/^Mailbox fixture stage (migration|seed|listen)\s*$/m);
    if (stageMatch) doc.fixtureStage = stageMatch[1];
    const sqlState = String(chunk).match(/^Mailbox fixture startup failed \w+ ([0-9A-Z]{5})\s*$/m);
    if (sqlState) doc.fixtureSqlState = sqlState[1];
  });
  const manifest = join(state, "mailbox-ready.json");
  const deadline = Date.now() + 1800000;
  while (!existsSync(manifest)) {
    if (interrupted) return;
    if (dbHost.exitCode !== null || dbHost.signalCode !== null || Date.now() > deadline)
      throw Error("fixture unavailable");
    await delay(150);
  }
  fixture = JSON.parse(await readFile(manifest, "utf8"));
  if (
    fixture.rowCount !== size ||
    !Number.isSafeInteger(fixture.attachmentCount) ||
    fixture.attachmentCount < 1 ||
    !["127.0.0.1", "localhost"].includes(new URL(fixture.baseUrl).hostname)
  ) {
    throw Error("fixture count, attachment metadata or loopback validation failed");
  }
  doc.fixture = {
    messageCount: fixture.rowCount,
    attachmentCount: fixture.attachmentCount,
    messagesWithAttachments: fixture.messagesWithAttachments,
    ...(fixture.eventsMode === "polling" ? { eventsMode: "polling" } : {}),
  };
  await waitForMeasurementWindow();
  stage = "surface setup";
  surfaces = await startSurfaces({
    runtime,
    state: join(output, proxyPortArg ? "surfaces-phone" : "surfaces"),
    fixture,
    surfaces: [surface],
    revision,
    skipFirstPageProbe,
    ...(proxyPortArg ? { proxyPort: Number(proxyPortArg) } : {}),
  });
  await launch();
  const origin = surfaces[surface].origin;
  const options = () => ({ fixture, surface, origin, sync });
  const start = async () => {
    const index = loadTrace?.count();
    const openedAt = Date.now();
    const result = await startup(page, origin, 90000);
    if (loadTrace && !result.failure) result.trace = await loadTrace.snapshot(openedAt, index);
    return result;
  };
  const chunk = delayAsset && new URL(`/_next/static/chunks/${delayAsset}`, origin).href;
  let delayRequests = 0;
  let assetRequested;
  const firstAssetRequest =
    chunk &&
    new Promise((resolve) => {
      assetRequested = resolve;
    });
  if (chunk)
    await page.route(chunk, async (route) => {
      delayRequests++;
      assetRequested?.();
      if (assetDelayMs > 0) await delay(assetDelayMs);
      await route.continue();
    });
  const cold = await prepare("cold", async () => {
    const result = await start();
    if (chunk && result.trace && result.usableMs != null) {
      const usableAt = result.trace.beforeDocumentMs + result.usableMs;
      const requests = result.trace.requests.filter((request) => request.asset === delayAsset);
      const completed = requests.filter((request) => request.end <= usableAt);
      result.scriptDelay = {
        asset: delayAsset,
        delayMs: assetDelayMs,
        startedBeforeUsable: requests.filter((request) => request.start <= usableAt).length,
        wireBytesBeforeUsable: completed.reduce((bytes, request) => bytes + (request.wireBytes ?? 0), 0),
      };
    }
    return result;
  });
  if (chunk) {
    // A preload deferred until after the first list paint can start just after `start` returns.
    await Promise.race([firstAssetRequest, delay(1000)]);
    await page.unrouteAll({ behavior: "wait" });
    if (delayRequests !== 1) throw Error("cold startup control must delay one request");
    if (cold.scriptDelay) {
      cold.scriptDelay.matched = delayRequests;
      await save();
    }
  }
  if (cold.failure || (chunk && process.argv.includes("--cold-control-only"))) return;
  await prepare("conditioning", () => conditionWarm(page, options()));
  await closeBrowser();
  await launch();
  const warm = await prepare("warm", start);
  if (warm.failure) return;
  await prepare("warm-settled", () => conditionWarm(page, options()));
  if (mode === "reopen" || traceLoad) {
    const aged = await prepare("age", () => ageForReopen(page, options()));
    if (mode === "load-store") await phase("mirror-read", () => compareMirrorReads(page, fixture.accountId));
    await closeBrowser();
    await waitForMeasurementWindow();
    const arrival = await addArrivals(fixture, mode === "load-backlog" ? 5000 : undefined);
    const expired = surface === "web" && Boolean(fixture.refreshToken);
    doc.expiredAccessOnReopen = expired;
    await launch({ expireAccess: expired, admitted: false });
    await observeArrival(page, arrival);
    await phase("catch-up", async () => {
      const index = loadTrace?.count();
      const openedAt = Date.now();
      await page.goto(origin, { waitUntil: "commit" });
      const result = await waitForArrival(page, {
        ...options(),
        arrival,
        agedAtMs: aged.agedAtMs,
        onVisible: async ({ visibleMs, navigationEpochMs }) => {
          if (interrupted) return;
          doc.observations.arrival = { visibleMs: visibleMs + Math.max(0, navigationEpochMs - openedAt) };
          await save();
        },
      });
      const paint = await page.evaluate(() => ({
        firstPaintMs: performance.getEntriesByName("first-paint", "paint")[0]?.startTime ?? null,
        usableMs: window.__perfUsable ?? null,
        navigationEpochMs: performance.timeOrigin,
      }));
      // Refresh may replace the resume document. Include its time in every visible endpoint.
      const beforeDocumentMs = Math.max(0, paint.navigationEpochMs - openedAt);
      const sinceOpen = (value) => (Number.isFinite(value) ? beforeDocumentMs + value : null);
      return {
        ...result,
        firstPaintMs: sinceOpen(paint.firstPaintMs),
        usableMs: sinceOpen(paint.usableMs),
        visibleMs: sinceOpen(result.visibleMs),
        convergenceMs: sinceOpen(result.convergenceMs),
        beforeDocumentMs,
        ...(loadTrace ? { trace: await loadTrace.snapshot(openedAt, index) } : {}),
      };
    });
    if (mode === "load" && surface === "web" && fixture.eventsMode === "polling") {
      await phase("live-arrival", async () => {
        const index = loadTrace.count();
        const startedAt = Date.now();
        const result = await measureLiveArrival(page, fixture);
        const { requests } = await loadTrace.snapshot(startedAt, index);
        return { ...result, requests };
      });
    }
  } else if (mode === "interactive") {
    const cdp = await context.newCDPSession(page);
    const finish = await startTrace(cdp);
    let resourceStop, queryBaseline;
    try {
      await phase("gestures", () =>
        runGestures(page, {
          repetitions: 1,
          onBefore: async (name) => {
            await page.evaluate((action) => {
              window.__ohmailTraceAction = action;
            }, name);
            queryBaseline = await totalSQL();
            resourceStop = monitorHost(
              [fixture.apiPid, fixture.postgresPid, surfaces.web?.pid].filter(Boolean),
            );
          },
          onResult: async (name, data) => {
            const host = resourceStop();
            host.queries = (await totalSQL()) - queryBaseline;
            doc.observations[name] = { ...data, host };
            if (!interrupted) await save();
          },
        }),
      );
    } finally {
      resourceStop?.();
      if (!interrupted)
        await writeFile(join(dir, "render-trace.json.gz"), gzipSync(JSON.stringify(await finish())));
      await cdp.detach().catch(() => {});
    }
  } else if (traceResources) {
    await measureResourceDetail({
      page,
      context,
      resources,
      fixture,
      size,
      surface,
      sync,
      sqlSnapshot,
      mode,
      record: async (name, runPhase) => {
        stage = name;
        doc.state = name;
        await save();
        doc.phases[name] = await runPhase();
        await save();
      },
    });
  } else {
    async function record(name, runPhase) {
      stage = name;
      doc.state = name;
      await save();
      doc.phases[name] = await runPhase();
      await save();
    }
    await record("idle", () => resources.idle(120000));
    await record("active-use", () =>
      resources.active((clock) => activeUse(page, { activeMs: 600000, clock })),
    );
    await record("heap", () =>
      resources.heap(async () => {
        if (memTool) {
          const { readTab } = await import(pathToFileURL(resolve(memTool)));
          const result = await readTab({ port: debugPort, origin });
          return { afterGcMiB: result.heap_after_gc_mb, worlds: result.kit_worlds };
        }
        const session = await context.newCDPSession(page);
        try {
          await session.send("HeapProfiler.collectGarbage");
          await delay(500);
          await session.send("HeapProfiler.collectGarbage");
          const result = await session.send("Runtime.getHeapUsage");
          return { afterGcMiB: result.usedSize / 1048576 };
        } finally {
          await session.detach();
        }
      }),
    );
  }
}
try {
  await Promise.race([run(), stopped]);
  doc.state =
    doc.phases.cold?.value.failure || doc.phases.warm?.value.failure ? "list unavailable" : "finished";
} catch (err) {
  doc.state = interrupted ? "guard interrupted" : "failed";
  // Record the failing function/line, omitting URLs, cookies, command lines and page copy.
  doc.error = {
    stage,
    kind: err.name,
    frames: String(err.stack)
      .split("\n")
      .map((line) => line.match(/(tools\/perf\/[\w.-]+:\d+:\d+)/)?.[1])
      .filter(Boolean)
      .slice(0, 5),
  };
} finally {
  clearInterval(guard);
  await closeBrowser();
  await surfaces?.close().catch(() => {});
  if (dbHost && dbHost.exitCode === null && dbHost.signalCode === null) {
    const done = once(dbHost, "exit");
    dbHost.kill("SIGTERM");
    await Promise.race([done, delay(15000, undefined, { ref: false })]);
  }
  await save();
}
console.log(`${client} ${size} ${mode}: ${doc.state} (${stage})`);
process.exit(doc.state === "guard interrupted" ? 75 : doc.state === "finished" ? 0 : 1);
