import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { conditionWarm, watchMirrorSync } from "./mirror.mjs";
import { startSurfaces } from "./surfaces.mjs";
import { measurePress } from "./gesture-probes.mjs";
import { runGestures } from "./gestures.mjs";

const [rootArg, runtimeArg, revision, client, sizeArg, pgBin, pgLib, quiet, portArg, actionTrialsArg] =
  process.argv.slice(2);
const size = Number(sizeArg);
const actionTrials = Number(actionTrialsArg ?? 0);
const settingsTrials = process.argv.includes("--settings");
const desktop = client === "desktop";
const phone = client === "phone";
if (
  !rootArg ||
  !runtimeArg ||
  !revision ||
  !["web", "desktop", "phone"].includes(client) ||
  ![1000, 10000, 50000, 200000, 400000, 1000000].includes(size) ||
  !pgBin ||
  !pgLib ||
  !quiet ||
  !Number.isSafeInteger(actionTrials) ||
  actionTrials < 0 ||
  (settingsTrials && actionTrials === 0) ||
  actionTrials > 100
) {
  throw new Error(
    "Pass output root, runtime, revision, surface, fixture size, PostgreSQL bin and library paths, quiet file and optional proxy port.",
  );
}

const root = resolve(rootArg);
const runtime = resolve(runtimeArg);
const surface = desktop ? "desktop" : "web";
const state = phone ? "surfaces-phone" : "surfaces";
const proxyPort = portArg ? Number(portArg) : undefined;
const require = createRequire(join(runtime, "package.json"));
const { chromium } = require("@playwright/test");
const blocked = () => existsSync(quiet) || loadavg()[0] >= 18;
while (blocked()) await delay(3000);

const dir = await mkdtemp(join(root, "a2-"));
const build = join(dir, "build");
const tmp = join(dir, "tmp");
await Promise.all([mkdir(build), mkdir(tmp)]);
const fingerprint = `${surface}-build-fingerprint`;
await copyFile(join(root, state, fingerprint), join(build, fingerprint));
const env = {
  PATH: process.env.PATH,
  HOME: tmp,
  TMPDIR: tmp,
  XDG_RUNTIME_DIR: tmp,
  DBUS_SESSION_BUS_ADDRESS: "disabled:",
  LANG: "C.UTF-8",
  TZ: "UTC",
  TSX_DISABLE_CACHE: "1",
};
const report = { revision, client, size, stage: "fixture", peakLoad: loadavg()[0], sendPhases: [] };
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const guard = setInterval(() => {
  report.peakLoad = Math.max(report.peakLoad, loadavg()[0]);
  if (blocked()) stop();
}, 200);

const host = spawn(
  process.execPath,
  [
    "--conditions=ohmail-source",
    "--import",
    "tsx",
    "tools/perf/mailbox-host.ts",
    "--output",
    root,
    "--state",
    join(dir, "mail"),
    "--rows",
    sizeArg,
    "--pg-bin",
    pgBin,
    "--template",
    join(root, "templates-with-files", sizeArg),
  ],
  {
    cwd: runtime,
    env: { ...env, LD_LIBRARY_PATH: pgLib },
    stdio: ["ignore", "pipe", "ignore"],
  },
);
// Only preserve the product's allowlisted numeric phase fields.
const phaseNames = ["reserveMs", "assembleMs", "openMs", "submitMs", "finalizeMs", "projectMs", "totalMs"];
createInterface({ input: host.stdout }).on("line", (line) => {
  if (!line.includes('"send_phases"')) return;
  try {
    const fields = JSON.parse(line);
    const phases = Object.fromEntries(
      phaseNames.filter((name) => Number.isFinite(fields[name])).map((name) => [name, fields[name]]),
    );
    if (Object.keys(phases).length > 0) report.sendPhases.push(phases);
  } catch {
    // Some output uses a different format.
  }
});
const hostDone = once(host, "close");
hostDone.catch(stop);
let surfaces;
let browser;
let context;
const closeBrowser = () => context?.close().catch(() => {});
controller.signal.addEventListener("abort", () => {
  void closeBrowser();
});
const OHBOX = '.ob-scroll .oh-row[role="option"][data-id]';
const SEARCH = 'input[aria-label="Search"]';
const RESULTS = 'section.fr-list [role="listitem"][data-hit]';
const CAL = 'section.cal-body[aria-label="Calendar"]';
const SETTINGS = 'nav[aria-label="Settings sections"] .oh-row[role="button"]';
const SELECTION = '[role="toolbar"][aria-label="Selection"]';
const WAIT = { timeout: 10_000 };

function routeKind(path, query) {
  const local = path.replace(/^\/api\//, "/");
  if (local === "/sync/snapshot") return "mail-snapshot";
  if (local === "/sync") return "mail-sync";
  if (local === "/local/window/outbox") return "window-outbox";
  if (/^\/drafts\/[^/]+\/send/.test(local)) return "submit";
  if (/^\/drafts(?:\/|$)/.test(local)) return local === "/drafts" ? "drafts" : "draft";
  if (/^\/messages\/[^/]+\/(?:read|move|trash|restore)$/.test(local)) return local.split("/").at(-1);
  if (/^\/messages\/(?:by-id|bodies)/.test(local) || (local === "/messages" && query.has("ids")))
    return "bodies";
  if (/^\/messages/.test(local)) return local === "/messages" ? "messages" : "message";
  if (local === "/calendar/sync/snapshot") return "calendar-snapshot";
  if (local === "/calendar/sync") return "calendar-sync";
  if (/^\/calendar/.test(local)) return "calendar";
  if (/^\/search/.test(local)) return "search";
  if (local === "/mailboxes") return query.has("counts") ? "mailboxes-with-counts" : "mailboxes";
  if (/^\/mailboxes\//.test(local)) return "mailboxes-subroute";
  if (/^\/trash/.test(local)) return "trash";
  if (/^\/(settings|consent|account|rules|tags|screener)(?:\/|$)/.test(local)) return local.split("/")[1];
  return "other-api";
}

function observeBrowser(cdp, origin, timeOrigin) {
  const requests = [];
  const byId = new Map();
  cdp.on("Network.requestWillBeSent", ({ requestId, request, type, timestamp, wallTime }) => {
    const url = new URL(request.url);
    if (url.origin !== origin) return;
    const kind =
      type === "Document"
        ? "document"
        : type === "Script"
          ? "script"
          : type === "Stylesheet"
            ? "stylesheet"
            : url.pathname.startsWith("/api/")
              ? routeKind(url.pathname, url.searchParams)
              : null;
    if (!kind) return;
    const offset = wallTime * 1000 - timestamp * 1000 - timeOrigin;
    const row = { kind, method: request.method, start: wallTime * 1000 - timeOrigin };
    requests.push(row);
    byId.set(requestId, { row, offset });
  });
  cdp.on("Network.responseReceived", ({ requestId, timestamp, response }) => {
    const reading = byId.get(requestId);
    if (reading)
      Object.assign(reading.row, {
        status: response.status,
        response: timestamp * 1000 + reading.offset,
        cached: !!(reading.row.cached || response.fromDiskCache || response.fromServiceWorker),
        sql: Number(response.headers["x-perf-sql-queries"] ?? 0),
      });
  });
  cdp.on("Network.requestServedFromCache", ({ requestId }) => {
    const reading = byId.get(requestId);
    if (reading) reading.row.cached = true;
  });
  cdp.on("Network.loadingFinished", ({ requestId, timestamp, encodedDataLength }) => {
    const reading = byId.get(requestId);
    if (reading)
      Object.assign(reading.row, { end: timestamp * 1000 + reading.offset, bytes: encodedDataLength });
  });
  return requests;
}

try {
  const manifest = join(dir, "mail", "mailbox-ready.json");
  const deadline = performance.now() + 180_000;
  while (!existsSync(manifest)) {
    controller.signal.throwIfAborted();
    if (host.exitCode !== null || performance.now() > deadline) throw new Error("fixture unavailable");
    await delay(100);
  }
  const fixture = JSON.parse(await readFile(manifest, "utf8"));
  const fixtureUrl = new URL(fixture.baseUrl);
  if (
    fixtureUrl.origin !== fixture.baseUrl ||
    fixtureUrl.hostname !== "127.0.0.1" ||
    fixtureUrl.protocol !== "http:" ||
    fixture.rowCount !== size ||
    fixture.attachmentCount < 1
  ) {
    throw new Error("fixture verification failed");
  }
  report.attachments = fixture.attachmentCount;
  report.stage = "start surface";
  surfaces = await startSurfaces({
    runtime,
    state: build,
    revision,
    fixture,
    surfaces: [surface],
    proxyPort,
  });
  controller.signal.throwIfAborted();
  const target = surfaces[surface];
  report.stage = "open Ohbox";
  browser = await chromium.launch({
    env,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--proxy-server=http://127.0.0.1:9",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    ],
  });
  context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: phone,
    hasTouch: phone,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
  });
  report.chromium = browser.version();
  const page = await context.newPage();
  const responses = [];
  target.onResponse(({ pathname, search, status, sqlQueries, method }) => {
    if (status === 423 || status === 429) {
      report.refusalStatus = status;
      stop();
    }
    responses.push({
      kind: routeKind(pathname, new URLSearchParams(search)),
      method,
      status,
      sql: sqlQueries,
      wall: Date.now(),
    });
  });
  await target.preparePage(page, { client });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const trace = { writes: [], send: [], roster: [] };
    window.__ohmailActionSamples = trace;
    window.__ohmailRosterCallsite = () => {
      const previousLimit = Error.stackTraceLimit;
      try {
        Error.stackTraceLimit = 32;
        return (new Error().stack ?? "")
          .split("\n")
          .slice(1)
          .flatMap((line) => {
            const frame = /\/([\w.-]+\.js):(\d+):(\d+)\)?$/.exec(line);
            return frame ? [{ asset: frame[1], line: Number(frame[2]), column: Number(frame[3]) }] : [];
          });
      } finally {
        Error.stackTraceLimit = previousLimit;
      }
    };
    const fetch_ = window.fetch;
    window.fetch = function (input) {
      const url = new URL(input instanceof Request ? input.url : input, location.origin);
      if (url.origin === location.origin && url.pathname === "/api/mailboxes") {
        trace.roster.push({ start: performance.now(), stack: window.__ohmailRosterCallsite() });
      }
      return fetch_.apply(this, arguments);
    };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      const names = [...tx.objectStoreNames];
      if (tx.mode !== "readwrite" || !names.includes("entities")) return tx;
      const row = {
        start: performance.now(),
        stores: names.filter((name) => name === "entities" || name === "meta"),
      };
      trace.writes.push(row);
      tx.addEventListener("complete", () => {
        row.end = performance.now();
      });
      tx.addEventListener("abort", () => {
        row.aborted = true;
      });
      return tx;
    };
    document.addEventListener(
      "click",
      (event) => {
        if (!event.isTrusted || !(event.target instanceof Element)) return;
        const composer = event.target.closest('[role="region"][aria-label="New message"]');
        const button = event.target.closest("button");
        if (
          !composer ||
          !button ||
          (button.getAttribute("aria-label") ?? button.textContent.trim()) !== "Send"
        )
          return;
        const row = { click: event.timeStamp, captureAt: performance.now() };
        trace.send.push(row);
        const detect = () => {
          if (
            row.sending === undefined &&
            (button.matches('[aria-busy="true"]') || button.textContent.includes("Sending"))
          ) {
            row.sending = performance.now();
          }
          if (!composer.isConnected || composer.closest("[inert], [hidden]")) {
            row.closed = performance.now();
            observer.disconnect();
          }
        };
        const observer = new MutationObserver(detect);
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        setTimeout(() => observer.disconnect(), 15_000);
      },
      true,
    );
  });
  const sync = watchMirrorSync(page, {
    surface,
    client,
    origin: target.origin,
    onDesktopResponse: target.onResponse,
  });
  await page.goto(target.origin, { waitUntil: "domcontentloaded" });
  await page.locator(OHBOX).first().waitFor({ timeout: 45_000 });
  report.stage = "settle mirror";
  const warm = await conditionWarm(page, { fixture, surface, sync });
  report.mirrorRows = warm.mirrorRows;
  sync.stop();

  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const cdp = await context.newCDPSession(page);
  const requests = observeBrowser(cdp, target.origin, timeOrigin);
  if (desktop) {
    await page.exposeBinding("__ohmailRecordBridge", (_, path, method, start, end) => {
      const url = new URL(path, target.origin);
      if (url.origin === target.origin)
        requests.push({ kind: routeKind(url.pathname, url.searchParams), method, start, end });
    });
    await page.evaluate(() => {
      const bridge = window.__TAURI_INTERNALS__;
      const invoke = bridge.invoke;
      bridge.invoke = async function (command, payload) {
        if (command !== "engine_request") return invoke.apply(this, arguments);
        const start = performance.now();
        if (/^\/mailboxes(?:\?|$)/.test(payload.url)) {
          window.__ohmailActionSamples.roster.push({ start, stack: window.__ohmailRosterCallsite() });
        }
        const result = await invoke.apply(this, arguments);
        const end = performance.now();
        void window.__ohmailRecordBridge(payload.url, payload.method ?? "GET", start, end);
        return result;
      };
    });
  }
  await cdp.send("Network.enable");

  const visible = (selector) => page.locator(`${selector}:visible`).first();
  const click = (target) => (phone ? target.tap(WAIT) : target.click(WAIT));
  const press = (target, effect) =>
    measurePress(target, () => click(target), [[{ selector: effect }]], 10_000);
  const nav = (name) =>
    page
      .getByRole("button", { name })
      .and(page.locator(":is(nav button, .oh-switcher button):not([inert] *):visible"))
      .first();
  async function switchTo(name, effect) {
    const button = nav(name);
    if (!(await button.isVisible())) await click(visible("nav button[data-drawer-toggle]:not([inert] *)"));
    return press(button, effect);
  }
  async function ohbox() {
    if (await visible(CAL).isVisible()) return switchTo(/^Mail$/, OHBOX);
    return switchTo(/^Ohbox\b/, OHBOX);
  }

  report.stage = "first interaction pass";
  report.samples = [];
  const saveSample = (name, sample) => report.samples.push({ name, ...sample });
  if (settingsTrials) {
    for (let rep = 1; rep <= actionTrials; rep++) {
      if (rep > 1) {
        await page.evaluate(() => history.replaceState(null, "", location.pathname));
        await page.reload({ waitUntil: "domcontentloaded" });
        await page
          .locator('.ob-scroll [role="option"][data-id]:not([aria-disabled="true"])')
          .first()
          .waitFor({ timeout: 45_000 });
      }
      await delay(500);
      await runGestures(page, {
        only: ["switch-settings"],
        onResult: (name, sample) => saveSample(name, { ...sample, rep }),
      });
    }
  } else {
    await runGestures(page, {
      ...(actionTrials > 0
        ? { repetitions: actionTrials, only: ["mark-read", "move"], directSetup: true }
        : {}),
      onResult: (name, sample) => {
        if (name !== "scroll-ten-screens") saveSample(name, sample);
      },
    });
  }

  if (actionTrials === 0) {
    report.stage = "warm navigation";
    // Record view data for half a second after paint before allowing the next switch.
    await delay(550);
    for (let visit = 2; visit <= 3; visit++) {
      saveSample("return-from-settings", { visit: visit - 1, ...(await ohbox()) });
      await visible(OHBOX).waitFor(WAIT);
      await delay(550);
      saveSample("search-revisit", { visit, ...(await switchTo(/^Search$/, SEARCH)) });
      const search = await visible(SEARCH).inputValue(WAIT);
      if (search !== "Harbor") throw new Error("expected remembered search");
      await visible(RESULTS).waitFor(WAIT);
      const resultsAt = await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now()))),
          ),
      );
      report.samples.at(-1).resultsBy = resultsAt;
      await delay(550);
      saveSample("return-from-search", { visit, ...(await ohbox()) });
      await delay(550);
      saveSample("calendar-revisit", { visit, ...(await switchTo(/^Calendar$/, CAL)) });
      await delay(550);
      saveSample("return-from-calendar", { visit, ...(await ohbox()) });
      await delay(550);
      saveSample("settings-revisit", { visit, ...(await switchTo(/^Settings(?:\b|$)/, SETTINGS)) });
      await delay(550);
    }

    report.stage = "delete and undo";
    saveSample("return-from-settings", { visit: 3, ...(await ohbox()) });
    const undo = page.getByRole("button", { name: /^Undo\b/ }).first();
    async function selectFor(name) {
      const row = visible(OHBOX);
      const id = await row.evaluate((el) => CSS.escape(el.getAttribute("data-id")));
      const exact = `${OHBOX}[data-id="${id}"]`;
      await click(row.locator("..").getByRole("button", { name: "Select the message", exact: true }));
      const toolbar = visible(SELECTION);
      let button = toolbar.getByRole("button", { name, exact: true });
      if (!(await button.isVisible())) {
        await click(toolbar.getByRole("button", { name: "More", exact: true }));
        button = page
          .getByRole("menu", { name: "More", exact: true })
          .getByRole("menuitem", { name, exact: true });
      }
      return { exact, button };
    }

    async function hideRow(name, button, exact) {
      const sample = await measurePress(
        button,
        () => click(button),
        [[{ selector: exact, hidden: true }]],
        10_000,
      );
      saveSample(name, sample);
      if (!Number.isFinite(sample.ms)) throw new Error("row did not leave");
    }

    async function trash(name) {
      const { exact, button } = await selectFor("Delete");
      await click(button);
      const confirm = page.getByRole("menuitem", { name: "Move", exact: true });
      await hideRow(name, confirm, exact);
      return exact;
    }

    const moved = await selectFor("Move");
    await click(moved.button);
    const dialog = page.getByRole("dialog", { name: "Move", exact: true });
    await hideRow("move-with-undo", dialog.getByRole("menuitem", { name: "News", exact: true }), moved.exact);
    await undo.waitFor(WAIT);
    saveSample("undo-move", await press(undo, moved.exact));
    await delay(900);
    const exact = await trash("delete-with-undo");
    await undo.waitFor(WAIT);
    saveSample("undo-delete", await press(undo, exact));
    await delay(900);
    await trash("delete-with-commit");
    await delay(10_000);
  }
  report.browser = await page.evaluate(() => window.__ohmailActionSamples);
  report.requests = requests;
  report.responses = responses
    .filter(({ wall }) => wall >= timeOrigin)
    .map(({ wall, ...response }) => ({ ...response, end: wall - timeOrigin }));
  controller.signal.throwIfAborted();
  report.stage = "finished";
} catch {
  report.failed = true;
} finally {
  clearInterval(guard);
  report.guardInterrupted = controller.signal.aborted && !report.refusalStatus;
  await browser?.close().catch(() => {});
  await surfaces?.close().catch(() => {});
  host.kill("SIGTERM");
  await hostDone.catch(() => {});
  await writeFile(join(dir, "actions.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}

console.log(`${client} ${size}: ${report.stage}${report.guardInterrupted ? " (workstation guard)" : ""}`);
process.exitCode = report.refusalStatus ? 1 : report.guardInterrupted ? 75 : report.failed ? 1 : 0;
