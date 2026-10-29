#!/usr/bin/env node
/**
 * VIEW-SWITCH HARNESS — how long a press of 1/2/3 (or a click on the rail) takes to paint the pile
 * it names, over a large local mirror, in real engines. Local fixtures only: the page is
 * `view-switch-entry.tsx` (the real AppShell over a FixturesAdapter), served from loopback.
 *
 *   node scripts/perf/view-switch.mjs build --out DIR [--tree ROOT]
 *       Bundle the page from ROOT's sources (default: this checkout) into DIR. `--tree` builds an
 *       older tree (a `git archive` with its own install) with THIS entry, so both arms run one page.
 *   node scripts/perf/view-switch.mjs run --dist DIR [--engine chromium|webkit] [--reps 10]
 *       One arm, JSON on stdout.
 *   node scripts/perf/view-switch.mjs ab --arms base=DIR,head=DIR [--engines webkit,chromium] [--rounds 2]
 *       Arms interleaved A B A B on one host, the load printed before each, and a table of medians.
 *   node scripts/perf/view-switch.mjs compare A.json B.json
 *       Compares two saved arms, and refuses unless they come from one `ab` run, at most a round apart.
 *
 * Common: --q "n=3000&nr=2000&nc=1000&demo=0&heavy=1" (the 3000/2000/1000 heavy fixture, the default)
 * --warm 80 (bodies hydrated per stream before timing) --viewport 1440x900.
 * --scenario screener times the Screener's tabs instead of 1/2/3 (`runScreener`, its own default
 * fixture adds 60 screened-out senders and 40 spam senders, 40 letters each); --gap 1000.
 *
 * What a press reports (median and p90 over the presses): `paint` press -> the frame that shows
 * the pile's list rows has painted (rows seen in a frame's callback, then the next frame's);
 * `paint2` one frame later (the earlier harness's two-frames-after reading, for comparison);
 * `stream` press -> its first stream card on screen; `settle` press -> the
 * last DOM mutation before 400 ms of quiet; `maxLong` the longest longtask / long-animation-frame
 * (Chromium only); `maxGap` the longest gap between two animation frames (both engines; WebKit has
 * neither observer, so this is its long-task reading); `iframes` frames inside the pile at the
 * paint; `sanitize` sanitizeMailHtml calls during the press (counted by a wrapper this build adds,
 * nothing in the product counts); `requests` body fetches and fetch() calls during the press.
 * `rapid` is 2,3,2,3,2 forty ms apart, timed from the last press.
 *
 * Needs the root install and Playwright's Chromium and WebKit (`npx playwright install chromium
 * webkit`); the page is bundled the desktop window's way (no API client) with the root's one copy
 * of React. The host is shared: the load is printed with every arm, and a comparison is only made
 * between arms of one interleaved run. `apps/webapp/test/view-switch-journey.test.ts` drives the
 * same page in CI, asserting what the presses did, never how long they took.
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const ENTRY = join(HERE, "view-switch-entry.tsx");
const DEFAULT_Q = "n=3000&nr=2000&nc=1000&demo=0&heavy=1";
/* A full Screener: 2,400 screened-out letters from 60 senders, 1,600 spam from 40. */
const SCREENER_Q = `${DEFAULT_Q}&ns=60&nsh=40&np=40&nph=40`;

const IS_MAIN = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const argv = IS_MAIN ? process.argv.slice(2) : [];
const cmd = argv[0];
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i > 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

function hostLoad() {
  const [one, five] = loadavg();
  return { load1: Number(one.toFixed(2)), load5: Number(five.toFixed(2)), cpus: cpus().length };
}

/* ── build ──────────────────────────────────────────────────────────────────────────────── */

export async function build(out, tree = ROOT, names = false) {
  const req = createRequire(join(tree, "package.json"));
  const esbuild = req("esbuild");
  const desk = join(tree, "apps/desktop");
  mkdirSync(out, { recursive: true });
  const plugin = {
    name: "view-switch",
    setup(b) {
      /* The entry's own relative imports name sources in a tree; point them at `tree`. */
      b.onResolve({ filter: /^\.\.\/\.\.\// }, (a) =>
        a.importer === ENTRY ? b.resolve(`./${a.path.slice(6)}`, { kind: a.kind, resolveDir: tree }) : undefined);
      /* The desktop window's way: no API client, and one copy of React and the catalogue's runtime,
         the tree root's (`vitest.config.ts` holds the suite to the same rule). */
      b.onResolve({ filter: /^(?:.*\/)?api-client$/ }, () => ({ path: join(desk, "src/no-api-client.ts") }));
      /* A tree on this checkout's install (an archive with its node_modules linked here) would take its
         workspace packages from THIS checkout, a second copy beside the entry's: point them at the tree's. */
      const here = realpathSync(ROOT);
      if (realpathSync(tree) !== here) {
        b.onResolve({ filter: /^@ohmail\// }, async (a) => {
          if (a.pluginData === "ws") return undefined;
          const r = await b.resolve(a.path, { kind: a.kind, resolveDir: a.resolveDir, pluginData: "ws" });
          if (r.errors.length > 0 || !r.path.startsWith(`${here}/`) || r.path.includes("/node_modules/")) return undefined;
          return { path: join(tree, r.path.slice(here.length + 1)), sideEffects: r.sideEffects };
        });
      }
      b.onResolve({ filter: /^next-intl$/ }, (a) => b.resolve("use-intl", { kind: a.kind, resolveDir: tree }));
      b.onResolve({ filter: /^(react|react-dom|use-intl)(\/.*)?$/ }, (a) =>
        a.pluginData === "root" ? undefined : b.resolve(a.path, { kind: a.kind, resolveDir: tree, pluginData: "root" }));
      /* The sanitize counter: every call site under the web app, wrapped. The definition is not. */
      b.onLoad({ filter: /apps\/webapp\/app\/.*\.tsx?$/ }, (a) => {
        const src = readFileSync(a.path, "utf8");
        if (!/(?<!function )\bsanitizeMailHtml\(/.test(src)) return undefined;
        const counted = src.replace(/(?<!function )\bsanitizeMailHtml\(/g, "__vsCounted(sanitizeMailHtml)(");
        const head = "const __vsCounted = (f) => (...a) => { globalThis.__vsSanitize = (globalThis.__vsSanitize ?? 0) + 1; return f(...a); };\n";
        return { contents: head + counted, loader: a.path.endsWith(".tsx") ? "tsx" : "ts", resolveDir: dirname(a.path) };
      });
    },
  };
  await esbuild.build({
    entryPoints: [ENTRY],
    // `--names` keeps function names, for a profile (`node … build --names`).
    bundle: true, outdir: out, format: "iife", jsx: "automatic", minify: !names, keepNames: names, target: "es2022",
    entryNames: "entry", conditions: ["ohmail-source"], platform: "browser",
    loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
    plugins: [plugin],
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_API_BASE": "undefined",
      "process.env.NEXT_PUBLIC_DESKTOP": '"1"',
      __OHMAIL_VERSION__: '"0.0.0-perf"', __OHMAIL_BUILD_SHA__: '"perf"', __OHMAIL_PLATFORM__: '"linux"', __OHMAIL_DISTRIBUTION__: '"direct"',
    },
    logLevel: "warning",
    banner: { js: "globalThis.process = globalThis.process || { env: { NODE_ENV: \"production\" } };" },
  });
  const sha = spawnSync("git", ["-C", tree, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim() || "unknown";
  writeFileSync(join(out, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="entry.css"></head><body><div id="root"></div><script src="entry.js"></script></body></html>`);
  writeFileSync(join(out, "build.json"), JSON.stringify({ tree, sha, at: new Date().toISOString() }));
  return out;
}

/* ── one arm ────────────────────────────────────────────────────────────────────────────── */

const VIEW = { "1": ".view-ohbox", "2": ".view-reads", "3": ".view-receipts" };
const RAIL = { "1": "ohbox", "2": "reads", "3": "receipts" };

/** Installed in the page once: the observers and the per-press probe. */
function pageProbe() {
  const w = window;
  w.__vs = { lt: [], frames: [] };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__vs.lt.push({ s: e.startTime, d: e.duration }); })
      .observe({ type: "longtask", buffered: false });
  } catch {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__vs.lt.push({ s: e.startTime, d: e.duration }); })
      .observe({ type: "long-animation-frame", buffered: false });
  } catch {}
  const origFetch = w.fetch?.bind(w);
  w.__vsFetches = 0;
  if (origFetch) w.fetch = (...a) => { w.__vsFetches += 1; return origFetch(...a); };
  const visible = (root, sel) => {
    if (!root) return 0;
    let n = 0;
    // An inert subtree (the Screener's hidden primer) is never on screen.
    for (const e of root.querySelectorAll(sel)) if (e.getClientRects().length > 0 && !e.closest("[inert]")) n += 1;
    return n;
  };
  /** Resolves with the press's readings; `t0` is the LAST keydown/pointerdown seen after arming.
      `rows` names the rows to wait for instead of the pile's own (no stream follows them). */
  w.__vsArm = (viewSel, presses, rows) => new Promise((resolve) => {
    let t0 = null;
    let seen = 0;
    const onPress = () => { seen += 1; if (seen >= presses) t0 = performance.now(); };
    addEventListener("keydown", onPress, { capture: true });
    addEventListener("pointerdown", onPress, { capture: true });
    const frames = [];
    let running = true;
    const tick = (t) => { frames.push(t); if (running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const s0 = w.__vsSanitize ?? 0;
    const b0 = (w.__bodyFetches ?? 0) + w.__vsFetches;
    let rowsAt = null; let paintAt = null; let paint2At = null; let streamAt = null; let iframes = 0; let cards = 0;
    const stream = rows === undefined && viewSel !== ".view-ohbox";
    const rowSel = rows ?? (stream ? ".row" : "[data-index]");
    const check = () => {
      const view = document.querySelector(viewSel);
      if (t0 !== null && rowsAt === null && visible(view, rowSel) > 0) {
        /* Seen in this frame's callback, so this frame paints them: the next frame's callback runs
           after that paint (`paint`). One frame later again is the two-frames-after reading the
           earlier harness took (`paint2`), kept so its numbers can be compared. */
        rowsAt = performance.now();
        const v = document.querySelector(viewSel);
        iframes = v ? v.querySelectorAll("iframe").length : 0;
        cards = v ? v.querySelectorAll(".scast").length : 0;
        requestAnimationFrame(() => {
          paintAt = performance.now();
          requestAnimationFrame(() => { paint2At = performance.now(); });
        });
      }
      if (t0 !== null && stream && streamAt === null && visible(view, ".scast") > 0) streamAt = performance.now();
      if (paint2At !== null && (!stream || streamAt !== null)) return settle();
      requestAnimationFrame(check);
    };
    const settle = () => {
      let last = performance.now();
      const mo = new MutationObserver(() => { last = performance.now(); });
      mo.observe(document.querySelector("main") ?? document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      const quiet = () => {
        if (performance.now() - last < 400) return void setTimeout(quiet, 50);
        mo.disconnect();
        running = false;
        removeEventListener("keydown", onPress, { capture: true });
        removeEventListener("pointerdown", onPress, { capture: true });
        const end = last;
        const lts = w.__vs.lt.filter((x) => x.s + x.d >= t0 && x.s <= end);
        w.__vs.lt = [];
        let maxGap = 0;
        for (let i = 1; i < frames.length; i++) {
          if (frames[i] < t0 || frames[i - 1] > end) continue;
          maxGap = Math.max(maxGap, frames[i] - Math.max(frames[i - 1], t0));
        }
        resolve({
          paintMs: paintAt - t0, paint2Ms: paint2At - t0, rowsMs: rowsAt - t0, streamMs: streamAt === null ? null : streamAt - t0,
          settleMs: Math.max(paintAt, last) - t0,
          maxLong: Math.max(0, ...lts.map((x) => x.d)), maxGap,
          iframes, cards,
          sanitize: (w.__vsSanitize ?? 0) - s0,
          requests: (w.__bodyFetches ?? 0) + w.__vsFetches - b0,
        });
      };
      setTimeout(quiet, 50);
    };
    requestAnimationFrame(check);
  });
}

/* THE SCREENER'S TABS (`--scenario screener`): per rep a cold page, the rail's Screener, then one
   held segment's tab first (Screened out and Spam take turns), the other one, and warm switches:
   between the two tabs, and by way of the Ohbox and the Screener again. `--gap` is the wait
   between opening the Screener and the first tab click. */
const SCN_TAB = { waiting: 0, screened: 1, spam: 2 };
const SCN_ROWS = { screened: '[data-id^="screened:"]', spam: '[data-id^="spam:"]' };

async function runScreener(browser, { url, reps, gap, size, errors }) {
  const presses = [];
  let bootMs = 0;
  for (let r = 0; r < reps; r++) {
    /* A fresh page per rep: a goto that differs only in the hash would keep the document warm. */
    const page = await browser.newPage({ viewport: size });
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
    const tabs = page.locator(".view-screener .scn-seg [role=\"tab\"]");
    const shown = () => page.evaluate(() => {
      const on = [...document.querySelectorAll(".view-screener .scn-seg [role=\"tab\"]")]
        .findIndex((b) => b.getAttribute("aria-selected") === "true");
      return ["waiting", "screened", "spam"][on] ?? null;
    });
    const press = async (act, viewSel, rows, view, phase) => {
      const wait = page.evaluate(([sel, r]) => window.__vsArm(sel, 1, r), [viewSel, rows]);
      await page.waitForTimeout(30);
      await act();
      presses.push({ how: "click", view, phase, ...(await wait) });
      await page.waitForTimeout(250);
    };
    const tab = (seg, phase) => press(() => tabs.nth(SCN_TAB[seg]).click(), ".view-screener", SCN_ROWS[seg], seg, phase);
    const openScreener = (phase) => press(() => page.click('[data-rail-id="screener"]'), ".view-screener", "[data-index]", "screener", phase);
    const t0 = Date.now();
    await page.goto(url);
    await page.waitForSelector(".view-ohbox [data-index]", { timeout: 120000 });
    await page.waitForTimeout(1500);
    bootMs = Math.max(bootMs, Date.now() - t0);
    await page.evaluate(pageProbe);
    await openScreener("screener");
    await page.waitForTimeout(gap);
    const [first, other] = r % 2 === 0 ? ["screened", "spam"] : ["spam", "screened"];
    await tab(first, "first");
    await tab(other, "other");
    for (let k = 0; k < 4; k++) await tab((await shown()) === "spam" ? "screened" : "spam", "warm");
    for (let k = 0; k < 2; k++) {
      await press(() => page.keyboard.press("1"), ".view-ohbox", undefined, "1", "away");
      await openScreener("screener-warm");
      await tab((await shown()) === "spam" ? "screened" : "spam", "warm");
    }
    await page.close();
  }
  return { presses, bootMs };
}

export async function runArm({ dist, engine = "chromium", reps = 10, q, warm = 80, viewport = "1440x900", scenario = "piles", gap = 1000 }) {
  q ??= scenario === "screener" ? SCREENER_Q : DEFAULT_Q;
  const { chromium, webkit } = createRequire(join(ROOT, "package.json"))("playwright");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
  const srv = createServer((req, res) => {
    let p = new URL(req.url, "http://x").pathname;
    if (p === "/") p = "/index.html";
    try {
      const body = readFileSync(join(dist, p));
      res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const [vw, vh] = viewport.split("x").map(Number);
  const browser = await (engine === "webkit" ? webkit : chromium).launch({ headless: true });
  const errors = [];
  if (scenario === "screener") {
    const url = `http://127.0.0.1:${srv.address().port}/?${q}#/ohbox`;
    const { presses, bootMs } = await runScreener(browser, { url, reps, gap, size: { width: vw, height: vh }, errors });
    await browser.close();
    srv.close();
    return { engine, q, reps, warm: 0, viewport, scenario, gap, bootMs, presses, errors: errors.slice(0, 8), uiVitals: {} };
  }
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${srv.address().port}/?${q}#/ohbox`);
  await page.waitForSelector(".view-ohbox [data-index]", { timeout: 120000 });
  await page.waitForTimeout(1500);
  if (warm > 0) {
    await page.evaluate(async (n) => {
      const e = window.__harness.engine;
      for (const f of ["reads", "receipts"]) for (let i = 0; i < n; i++) await e.hydrateBody(`${f}-${i}`);
    }, warm);
    await page.waitForTimeout(1000);
  }
  const bootMs = Date.now() - t0;
  await page.evaluate(pageProbe);
  await page.evaluate(() => window.__harness.resetVitals?.());

  const presses = [];
  const press = async (how, k, phase) => {
    const wait = page.evaluate(([sel]) => window.__vsArm(sel, 1), [VIEW[k]]);
    await page.waitForTimeout(30);
    if (how === "key") await page.keyboard.press(k);
    else await page.click(`[data-rail-id="${RAIL[k]}"]`);
    const r = await wait;
    presses.push({ how, view: k, phase, ...r });
    await page.waitForTimeout(250);
  };
  const seq = ["2", "3", "1"];
  const visited = new Set(["1"]);
  for (let r = 0; r < reps; r++) {
    for (const k of seq) {
      await press("key", k, visited.has(k) ? "revisit" : "first");
      visited.add(k);
    }
  }
  /* The keys leave focus in the page; a click moves it to the rail. Back to the Ohbox first. */
  for (let r = 0; r < reps; r++) for (const k of seq) await press("click", k, "revisit");
  /* FIRST VISITS: leaving the three piles unmounts the kept ones, so the next press of 2 or 3
     mounts its pile fresh, as the first press of a session does. */
  await page.keyboard.press("Escape");
  for (let r = 0; r < reps; r++) {
    await page.evaluate(() => { window.location.hash = "#/history"; });
    await page.waitForTimeout(500);
    await press("key", r % 2 === 0 ? "2" : "3", "first");
    await press("key", "1", "revisit-after-first");
  }
  /* RAPID: 2,3,2,3 then 2, a fast hand's forty ms apart, timed from the last press. */
  for (let r = 0; r < reps; r++) {
    const wait = page.evaluate(([sel]) => window.__vsArm(sel, 5), [VIEW["2"]]);
    await page.waitForTimeout(30);
    for (const k of ["2", "3", "2", "3", "2"]) { await page.keyboard.press(k); await page.waitForTimeout(40); }
    const res = await wait;
    presses.push({ how: "key", view: "2", phase: "rapid", ...res });
    await page.waitForTimeout(250);
    const back = page.evaluate(([sel]) => window.__vsArm(sel, 1), [VIEW["1"]]);
    await page.waitForTimeout(30);
    await page.keyboard.press("1");
    await back;
    await page.waitForTimeout(250);
  }
  const vitals = await page.evaluate(() => window.__harness.vitals());
  await browser.close();
  srv.close();
  return {
    engine, q, reps, warm, viewport, bootMs, presses, errors: errors.slice(0, 8),
    uiVitals: { switchP50: vitals.switchP50Ms ?? null, switchP95: vitals.switchP95Ms ?? null, switchCount: vitals.switchCount ?? null },
  };
}

/* ── summary ────────────────────────────────────────────────────────────────────────────── */

const sorted = (a) => [...a].sort((x, y) => x - y);
const med = (a) => (a.length ? sorted(a)[Math.floor(a.length / 2)] : null);
const p90 = (a) => (a.length ? sorted(a)[Math.min(a.length - 1, Math.ceil(0.9 * a.length) - 1)] : null);
const round = (v) => (v === null || v === undefined ? null : Math.round(v));

export function summarize(res) {
  const pick = (f) => res.presses.filter(f);
  const stat = (rows, key) => {
    const v = rows.map((x) => x[key]).filter((x) => typeof x === "number");
    return { med: round(med(v)), p90: round(p90(v)), max: round(v.length ? Math.max(...v) : null), n: v.length };
  };
  const out = {};
  for (const [name, f] of [
    ["ohbox", (p) => p.view === "1" && p.phase === "revisit"],
    ["news", (p) => p.view === "2" && p.phase === "revisit"],
    ["receipts", (p) => p.view === "3" && p.phase === "revisit"],
    ["news-keys", (p) => p.view === "2" && p.phase === "revisit" && p.how === "key"],
    ["news-click", (p) => p.view === "2" && p.phase === "revisit" && p.how === "click"],
    ["receipts-keys", (p) => p.view === "3" && p.phase === "revisit" && p.how === "key"],
    ["receipts-click", (p) => p.view === "3" && p.phase === "revisit" && p.how === "click"],
    ["revisit", (p) => p.phase === "revisit"],
    ["first", (p) => p.phase === "first"],
    ["rapid", (p) => p.phase === "rapid"],
    ["all-switches", (p) => p.phase !== "rapid"],
    ["scn-open", (p) => p.phase === "screener"],
    ["scn-first-screened", (p) => p.phase === "first" && p.view === "screened"],
    ["scn-first-spam", (p) => p.phase === "first" && p.view === "spam"],
    ["scn-other", (p) => p.phase === "other"],
    ["scn-warm", (p) => p.phase === "warm"],
  ]) {
    const rows = pick(f);
    out[name] = {
      paint: stat(rows, "paintMs"), paint2: stat(rows, "paint2Ms"), stream: stat(rows, "streamMs"), settle: stat(rows, "settleMs"),
      maxLong: stat(rows, "maxLong"), maxGap: stat(rows, "maxGap"), iframes: stat(rows, "iframes"),
      sanitize: stat(rows, "sanitize"), requests: stat(rows, "requests"),
    };
  }
  return out;
}

function line(label, s) {
  const f = (x) => `${x.med ?? "-"}/${x.p90 ?? "-"}`;
  return `  ${label.padEnd(15)} paint ${f(s.paint).padEnd(10)} paint2 ${f(s.paint2).padEnd(10)} stream ${f(s.stream).padEnd(10)} settle ${f(s.settle).padEnd(10)}` +
    ` maxLong ${f(s.maxLong).padEnd(9)} maxGap ${f(s.maxGap).padEnd(9)} iframes ${String(s.iframes.max ?? "-").padEnd(4)}` +
    ` sanitize ${String(s.sanitize.max ?? "-").padEnd(4)} requests ${s.requests.max ?? "-"}`;
}

function printArm(tag, res) {
  const s = summarize(res);
  console.log(`## ${tag} ${res.engine} load ${res.load.load1}/${res.load.cpus} boot ${res.bootMs} ms` +
    ` uiVitals p50 ${round(res.uiVitals.switchP50)} p95 ${round(res.uiVitals.switchP95)} errors ${res.errors.length}`);
  const keys = res.scenario === "screener"
    ? ["scn-open", "scn-first-screened", "scn-first-spam", "scn-other", "scn-warm"]
    : ["ohbox", "news", "receipts", "revisit", "first", "rapid"];
  for (const k of keys) console.log(line(k, s[k]));
  return s;
}

/* ── commands ───────────────────────────────────────────────────────────────────────────── */

if (cmd === "build") {
  const out = resolve(arg("out", join(tmpdir(), "ohmail-view-switch")));
  const tree = resolve(arg("tree", ROOT));
  await build(out, tree, argv.includes("--names"));
  console.log(`built ${out} from ${tree}`);
} else if (cmd === "run") {
  const res = await runArm({
    dist: resolve(arg("dist")), engine: arg("engine", "chromium"), reps: Number(arg("reps", "10")),
    q: arg("q"), warm: Number(arg("warm", "80")), viewport: arg("viewport", "1440x900"),
    scenario: arg("scenario", "piles"), gap: Number(arg("gap", "1000")),
  });
  res.load = hostLoad();
  res.summary = summarize(res);
  console.log(JSON.stringify(res, null, 1));
} else if (cmd === "ab") {
  const arms = arg("arms", "").split(",").filter(Boolean).map((a) => {
    const [name, dir] = a.split("=");
    return { name, dist: resolve(dir) };
  });
  if (arms.length < 2) throw new Error("--arms base=DIR,head=DIR");
  const engines = arg("engines", "webkit,chromium").split(",");
  const rounds = Number(arg("rounds", "2"));
  const runId = randomUUID();
  const all = [];
  for (const engine of engines) {
    for (let r = 1; r <= rounds; r++) {
      for (const arm of arms) {
        const load = hostLoad();
        const res = await runArm({
          dist: arm.dist, engine, reps: Number(arg("reps", "10")), q: arg("q"),
          warm: Number(arg("warm", "80")), viewport: arg("viewport", "1440x900"),
          scenario: arg("scenario", "piles"), gap: Number(arg("gap", "1000")),
        });
        Object.assign(res, { arm: arm.name, round: r, runId, load, build: JSON.parse(readFileSync(join(arm.dist, "build.json"), "utf8")) });
        res.summary = printArm(`${arm.name} r${r}`, res);
        all.push(res);
      }
    }
  }
  const out = arg("out", null);
  if (out) {
    mkdirSync(out, { recursive: true });
    for (const res of all) writeFileSync(join(out, `${res.engine}-${res.arm}-r${res.round}.json`), JSON.stringify(res));
    console.log(`saved ${all.length} arms in ${out}`);
  }
} else if (cmd === "compare") {
  const [a, b] = argv.slice(1, 3).map((p) => JSON.parse(readFileSync(p, "utf8")));
  if (!a.runId || a.runId !== b.runId) throw new Error("REFUSED: the arms come from different runs; run them interleaved with `ab`");
  if (Math.abs(a.round - b.round) > 1) throw new Error("REFUSED: the arms are more than one round apart");
  if (a.engine !== b.engine || a.q !== b.q || a.scenario !== b.scenario) throw new Error("REFUSED: different engines or fixtures");
  printArm(`${a.arm} r${a.round}`, a);
  printArm(`${b.arm} r${b.round}`, b);
} else if (IS_MAIN) {
  console.log("usage: view-switch.mjs build|run|ab|compare — see the header");
  process.exit(2);
}
