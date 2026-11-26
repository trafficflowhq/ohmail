import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { measureScroll } from "./gesture-probes.mjs";
import { conditionWarm, watchMirrorSync } from "./mirror.mjs";
import { startSurfaces } from "./surfaces.mjs";

const [rootArg, runtimeArg, revision, client, sizeArg, pgBin, pgLib, quiet, portArg, radiusArg] =
  process.argv.slice(2);
const size = Number(sizeArg);
const keyboardRail = process.argv.includes("--keyboard");
const measureWheel = process.argv.includes("--wheel");
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
  !quiet
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

const dir = await mkdtemp(join(root, "a1-"));
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
const report = { revision, client, size, stage: "fixture", peakLoad: loadavg()[0] };
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
    stdio: "ignore",
  },
);
const hostDone = once(host, "close");
hostDone.catch(stop);
let surfaces;
let browser;
let context;
const closeBrowser = () => context?.close().catch(() => {});
controller.signal.addEventListener("abort", () => {
  void closeBrowser();
});

const rail = ".oh-monthrail";

function snapshot() {
  const list = document.querySelector(".oh-monthrail [data-window-top]")?.parentElement;
  if (!list) return null;
  let box = list.parentElement;
  while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box) return null;
  const top = list.firstElementChild;
  const bottom = list.lastElementChild;
  const slots = [...list.querySelectorAll("[data-index]")];
  const rows = slots.filter((node) => node.getAttribute("role") === "option");
  const view = box.getBoundingClientRect();
  const shown = rows.filter((node) => {
    const at = node.getBoundingClientRect();
    return at.bottom > view.top && at.top < view.bottom;
  });
  const index = (node) => (node ? Number(node.dataset.index) : null);
  return {
    total: Number(rows[0]?.getAttribute("aria-setsize")) || null,
    top: box.scrollTop,
    height: box.scrollHeight,
    viewport: box.clientHeight,
    intendedTop: parseFloat(top.style.height),
    actualTop: top.offsetHeight,
    intendedBottom: parseFloat(bottom.style.height),
    actualBottom: bottom.offsetHeight,
    firstSlot: index(slots[0]),
    lastSlot: index(slots.at(-1)),
    mounted: rows.length,
    visible: shown.length,
    firstVisible: index(shown[0]),
    lastVisible: index(shown.at(-1)),
  };
}

async function api(page, path) {
  const begin = performance.now();
  let wire;
  if (desktop) {
    wire = await page.evaluate(async (url) => {
      const bytes = new Uint8Array(
        await window.__TAURI_INTERNALS__.invoke("engine_request", { url, method: "GET" }),
      );
      const size = new DataView(bytes.buffer).getUint32(0);
      const decode = (part) => new TextDecoder().decode(part);
      const meta = JSON.parse(decode(bytes.subarray(4, size + 4)));
      return {
        status: meta.status,
        queries: Number(new Headers(meta.h).get("x-perf-sql-queries")),
        body: meta.status === 200 ? JSON.parse(decode(bytes.subarray(size + 4))) : null,
      };
    }, path);
  } else {
    wire = await page.evaluate(async (url) => {
      const response = await fetch(`/api${url}`, { redirect: "error", signal: AbortSignal.timeout(12_000) });
      return {
        status: response.status,
        queries: Number(response.headers.get("x-perf-sql-queries")),
        body: response.ok ? await response.json() : null,
      };
    }, path);
  }
  if (wire.status !== 200) {
    report.apiFailureStatus = wire.status;
    throw new Error("fixture request failed");
  }
  return { body: wire.body, ms: performance.now() - begin, queries: wire.queries };
}

async function heap(session) {
  await session.send("HeapProfiler.collectGarbage");
  const { usedSize, backingStorageSize } = await session.send("Runtime.getHeapUsage");
  return { usedSize, backingStorageSize };
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
  const traffic = [];
  target.onResponse(({ pathname, search, status, sqlQueries }) => {
    if (status === 423 || status === 429) {
      report.refusalStatus = status;
      stop();
    }
    const kind =
      pathname === "/messages/timeline"
        ? "timeline"
        : pathname === "/messages" && new URLSearchParams(search).get("view") === "all"
          ? "page"
          : null;
    if (kind) traffic.push({ kind, status, sqlQueries });
  });
  await target.preparePage(page, { client });
  const sync = watchMirrorSync(page, {
    surface,
    client,
    origin: target.origin,
    onDesktopResponse: target.onResponse,
  });
  await page.goto(target.origin, { waitUntil: "domcontentloaded" });
  await page.locator('.ob-scroll [role="option"][data-id]').first().waitFor({ timeout: 45_000 });
  report.stage = "settle mirror";
  const warm = await conditionWarm(page, { fixture, surface, sync });
  report.mirrorRows = warm.mirrorRows;
  sync.stop();
  const cdp = await context.newCDPSession(page);
  report.ohboxHeap = await heap(cdp);
  if (measureWheel) {
    report.stage = "Ohbox wheel scroll";
    const scroller = page.locator(".ob-scroll:visible").first();
    report.ohboxWheel = await measureScroll(page, scroller, { screens: 10, timeoutMs: 5000 });
    await scroller.evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
  }
  traffic.length = 0;
  report.stage = "open History";
  const opened = performance.now();
  if (phone)
    await page.evaluate(() => {
      location.hash = "/history";
    });
  else await page.locator('[data-rail-id="history"]').click({ timeout: 8000 });
  const list = page.locator(`${rail} [role="listbox"]`);
  await list.waitFor({ timeout: 15_000 });
  await page.waitForFunction(
    () => document.querySelector(".history-head")?.textContent?.includes(" messages"),
    null,
    { timeout: 25_000 },
  );
  report.open = {
    ms: performance.now() - opened,
    geometry: await page.evaluate(snapshot),
    requests: traffic.splice(0),
  };
  report.open.heap = await heap(cdp);

  report.stage = "timeline and page controls";
  const timelinePath = "/messages/timeline?zone=UTC";
  const ask = (path) => api(page, path);
  const timeline = await ask(timelinePath);
  const { months, total } = timeline.body;
  if (!Array.isArray(months) || total !== size) {
    report.apiTimelineShape = {
      hasMonths: Array.isArray(months),
      total: typeof total === "number" ? total : null,
    };
    throw new Error("unexpected timeline");
  }
  const oldest = months.at(-1);
  const oldestSlot = size - oldest.count;
  const oldestTitle = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${oldest.month}-15T12:00:00Z`));
  report.timeline = {
    months: months.length,
    newestMonthCount: months[0].count,
    oldestCount: oldest.count,
    oldestSlot,
    total,
  };
  const oldestPage = `/messages?${new URLSearchParams({ view: "all", limit: "50", atDate: oldest.first.date, atId: oldest.first.id })}`;
  report.api = [];
  for (let i = 0; i < 5; i += 1) {
    const recent = await ask("/messages?view=all&limit=50");
    const grouped = await ask(timelinePath);
    const deep = await ask(oldestPage);
    report.api.push({
      top: recent.ms,
      timeline: grouped.ms,
      deepest: deep.ms,
      topQueries: recent.queries,
      timelineQueries: grouped.queries,
      deepestQueries: deep.queries,
      topRows: recent.body.items?.length,
      deepestRows: deep.body.items?.length,
      deepBoundaryMatched: deep.body.items?.[0]?.id === oldest.first.id,
    });
  }

  report.stage = "same-month scrollbar jump";
  const requestedSlot = Math.floor(months[0].count * 0.8);
  if (requestedSlot > 100) {
    traffic.length = 0;
    const start = performance.now();
    await list.evaluate(
      (node, { requestedSlot, total, radius }) => {
        let box = node.parentElement;
        while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
        const bottom = parseFloat(node.lastElementChild.style.height);
        const slots = [...node.querySelectorAll("[data-index]")];
        const last = Number(slots.at(-1).dataset.index);
        // At the top, the bounded renderer keeps a measured band before the compressed tail.
        // Include that band's pixels so both renderers aim at the same global slot.
        const band = Math.min(total, radius + 1);
        const drawn = slots.map((slot) => slot.offsetHeight).filter((height) => height > 0);
        if (radius > 0 && band > last && band < requestedSlot && drawn.length > 0) {
          const drawnPx = drawn.reduce((sum, height) => sum + height, 0);
          const assumed = drawnPx / drawn.length;
          const bandPx = drawnPx + (band - last - 1) * assumed;
          const tailPx = bottom - (band - last - 1) * assumed;
          box.scrollTop = Math.round(bandPx + ((requestedSlot - band) * tailPx) / (total - band));
          return;
        }
        box.scrollTop = Math.round((requestedSlot * bottom) / (total - last - 1));
      },
      { requestedSlot, total, radius: Number(radiusArg ?? 0) },
    );
    const tolerance = 75;
    const candidate = await page
      .waitForFunction(
        ({ requestedSlot, tolerance }) => {
          const rows = [...document.querySelectorAll('.oh-monthrail [role="option"][data-index]')];
          const box = rows[0]?.closest(".pl-scroll")?.getBoundingClientRect();
          return (
            box &&
            rows.some((row) => {
              const rect = row.getBoundingClientRect();
              return (
                Math.abs(Number(row.dataset.index) - requestedSlot) <= tolerance &&
                rect.bottom > box.top &&
                rect.top < box.bottom
              );
            })
          );
        },
        { requestedSlot, tolerance },
        { timeout: 16_000 },
      )
      .then(
        () => true,
        () => false,
      );
    report.scrollbarJump = {
      requestedSlot,
      candidate,
      ms: performance.now() - start,
      geometry: await page.evaluate(snapshot),
      requests: traffic.splice(0),
    };
  }

  report.stage = "oldest rail jump";
  if (months.length > 1 && !phone) {
    const year = page.locator(`${rail} button[data-year]`, { hasText: oldest.month.slice(0, 4) });
    const button = page.getByRole("button", { name: oldestTitle, exact: true });
    if ((await button.count()) === 0) await year.click({ timeout: 5000 });
    traffic.length = 0;
    const start = performance.now();
    if (keyboardRail) await button.press("Enter", { timeout: 5000 });
    else await button.click({ timeout: 5000 });
    const scrolled = await page
      .waitForFunction(
        (slot) => {
          const row = document.querySelector(`.oh-monthrail [role="option"][data-index="${slot}"]`);
          if (!row) return false;
          let box = row.parentElement;
          while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
          if (!box) return false;
          const rowRect = row.getBoundingClientRect();
          const boxRect = box.getBoundingClientRect();
          return rowRect.bottom > boxRect.top && rowRect.top < boxRect.bottom;
        },
        oldestSlot,
        { timeout: 3000 },
      )
      .then(
        () => true,
        () => false,
      );
    report.oldestRailJump = {
      scrolled,
      ms: performance.now() - start,
      geometry: await page.evaluate(snapshot),
      requests: traffic.splice(0),
    };
    if (keyboardRail) {
      report.oldestRailJump.keyboardFocus = await page
        .waitForFunction(
          (slot) => document.activeElement?.getAttribute("data-index") === String(slot),
          oldestSlot,
          { timeout: 3000 },
        )
        .then(
          () => true,
          () => false,
        );
    }
    report.oldestRailJump.heap = await heap(cdp);
  }
  report.stage = "scrollbar end";
  traffic.length = 0;
  const bottomStart = performance.now();
  // A hand taking the scrollbar releases the rail's month pin.
  await list.evaluate((node) => {
    node.closest(".pl-scroll").dispatchEvent(new PointerEvent("pointerdown"));
  });
  const finalRow = await page
    .waitForFunction(
      (slot) => {
        const rail = document.querySelector(".oh-monthrail");
        const box = rail?.closest(".pl-scroll");
        if (!box) return false;
        box.scrollTop = 1_000_000_000;
        const tail = rail.querySelector(`[data-index="${slot}"]`);
        if (!tail || (!tail.hasAttribute("data-folded-row") && tail.getAttribute("role") !== "option"))
          return false;
        const edge = box.getBoundingClientRect();
        const rect = tail.getBoundingClientRect();
        return rect.bottom >= edge.top && rect.top <= edge.bottom + 1;
      },
      size - 1,
      { timeout: 5000 },
    )
    .then(
      () => true,
      () => false,
    );
  report.scrollbarEnd = {
    finalRow,
    ms: performance.now() - bottomStart,
    geometry: await page.evaluate(snapshot),
    requests: traffic.splice(0),
  };

  report.stage = "revisit History";
  await page.evaluate(() => {
    location.hash = "/ohbox";
  });
  await page.locator('.ob-scroll [role="option"][data-id]').first().waitFor({ timeout: 10_000 });
  traffic.length = 0;
  const returned = performance.now();
  await page.evaluate(() => {
    location.hash = "/history";
  });
  await page.waitForFunction(
    () => document.querySelector(".history-head")?.textContent?.includes(" messages"),
    null,
    { timeout: 25_000 },
  );
  report.revisit = {
    ms: performance.now() - returned,
    geometry: await page.evaluate(snapshot),
    requests: traffic.splice(0),
  };
  if (measureWheel) {
    report.stage = "History wheel scroll";
    await list.locator('[role="option"]').first().waitFor({ timeout: 5000 });
    const scroller = page.locator(".pl-scroll").filter({ has: list });
    await scroller.evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
    report.wheel = await measureScroll(page, scroller, { screens: 10, timeoutMs: 5000 });
  }
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
  await writeFile(join(dir, "history.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}

console.log(`${client} ${size}: ${report.stage}${report.guardInterrupted ? " (workstation guard)" : ""}`);
process.exitCode = report.refusalStatus ? 1 : report.guardInterrupted ? 75 : report.failed ? 1 : 0;
