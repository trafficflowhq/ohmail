/**
 * What the two speed checks share (`open-letter.mjs`, `search-first.mjs`): the page's bundle, the
 * browser, the timer in the page, the percentiles, and the verdict against the row of
 * `test/contracts/perf-budgets.json` each one reads.
 *
 * The rules, the same for both. One command, a goal on file, a reading, the surface it was read on.
 * A missing input REFUSES (rc 3) and is never a pass: no row or no goal in the budgets file, an
 * unknown size class, no bundle, no browser, a page that logged an error, a press whose end never
 * came. A row whose arm is `records` prints the reading beside its goal and reddens nothing (rc 0);
 * only a row a maintainer turned to `decides` can be RED (rc 1). A goal its row defines over one
 * size class is asked only of a run over that class. The host is shared, so the load
 * stands on every verdict line and a timing is only ever compared with one read beside it.
 *
 * The surface is the built web shell in a real browser, mounted the desktop window's way over
 * planted mail (`speed-check-entry.tsx`); the mirror's size is one of the budgets file's classes.
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../..");
export const BUDGETS = join(ROOT, "test/contracts/perf-budgets.json");
const ENTRY = join(HERE, "speed-check-entry.tsx");

/** An input the check cannot do without is missing. Never a pass. */
export class Refused extends Error {}
const refuse = (why) => { throw new Refused(why); };

/* ── the budgets file ───────────────────────────────────────────────────────────────────── */

/** The row a check reads: its goal in ms, and whether a reading over it reddens. */
export function budgetOf(key, goalField, file = BUDGETS) {
  if (!existsSync(file)) refuse(`no budgets file at ${file}`);
  const row = JSON.parse(readFileSync(file, "utf8")).latency?.[key];
  if (row === undefined) refuse(`the budgets file has no latency row "${key}"`);
  const goalMs = row[goalField];
  if (typeof goalMs !== "number" || !(goalMs > 0)) refuse(`latency row "${key}" has no ${goalField}`);
  if (row.arm !== "records" && row.arm !== "decides") refuse(`latency row "${key}" has no arm`);
  return { key, goalField, goalMs, arm: row.arm, state: row.state };
}

/** How many messages a size class of the budgets file plants. */
export function sizeClassOf(name, file = BUDGETS) {
  if (!existsSync(file)) refuse(`no budgets file at ${file}`);
  const classes = JSON.parse(readFileSync(file, "utf8")).sizeClasses ?? {};
  const messages = classes[name]?.messages;
  if (typeof messages !== "number") refuse(`"${name}" is not a size class of the budgets file (${Object.keys(classes).join(", ")})`);
  return { name, messages };
}

/* ── percentiles and the verdict ────────────────────────────────────────────────────────── */

/** Nearest rank, as the window's own `ui_vitals` reads it: a value somebody measured, never one between two. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
export function stats(values) {
  const r = (v) => (v === null ? null : Math.round(v));
  return { n: values.length, medianMs: r(percentile(values, 50)), p95Ms: r(percentile(values, 95)), maxMs: values.length ? r(Math.max(...values)) : null };
}

/**
 * One line and an exit code. `readingMs` is the figure the goal is asked of, `null` when nothing was read.
 * RECORDED rc 0 · GREEN rc 0 · RED rc 1 · REFUSED rc 3.
 *
 * `goalSize` is the size class a row's goal is defined over, when its row names one, and `size` the
 * class the run read. A run over another class keeps its reading and gets no distance to the goal:
 * a small mailbox under a goal set for the large one says nothing about it. On a row that decides
 * such a run is refused, so it can be neither a pass nor a red.
 */
export function verdictOf({ tag, budget, readingMs, what, surface, size = null, goalSize = null }) {
  if (readingMs === null || !Number.isFinite(readingMs)) return { rc: 3, line: `${tag}: REFUSED -- no reading: ${what}` };
  const asked = `the goal ${budget.goalField === "p95Ms" ? "p95 " : ""}${budget.goalMs} ms`;
  if (goalSize !== null && size !== goalSize) {
    const only = `${asked} is asked only of the ${goalSize} class`;
    if (budget.arm === "records") return { rc: 0, line: `${tag}: RECORDED -- ${what} · ${surface}; ${only}, so this run has no distance to it` };
    return { rc: 3, line: `${tag}: REFUSED -- ${only} and the row decides, so this run is no verdict: ${what} · ${surface}` };
  }
  const goal = `${asked} (x${(readingMs / budget.goalMs).toFixed(2)})`;
  const said = `${what} against ${goal} · ${surface}`;
  if (budget.arm === "records") return { rc: 0, line: `${tag}: RECORDED -- ${said}; the row records, nothing reddens` };
  return readingMs <= budget.goalMs ? { rc: 0, line: `${tag}: GREEN -- ${said}` } : { rc: 1, line: `${tag}: RED -- ${said}` };
}

export function hostLoad() {
  const [one, five] = loadavg();
  return { load1: Number(one.toFixed(2)), load5: Number(five.toFixed(2)), cpus: cpus().length };
}

/* ── the page's bundle ──────────────────────────────────────────────────────────────────── */

/** Bundle the page from this checkout into `out`, the desktop window's way: no API client, one React. */
export async function buildPage(out) {
  const esbuild = createRequire(join(ROOT, "package.json"))("esbuild");
  mkdirSync(out, { recursive: true });
  const plugin = {
    name: "speed-check",
    setup(b) {
      b.onResolve({ filter: /^(?:.*\/)?api-client$/ }, () => ({ path: join(ROOT, "apps/desktop/src/no-api-client.ts") }));
      b.onResolve({ filter: /^next-intl$/ }, (a) => b.resolve("use-intl", { kind: a.kind, resolveDir: ROOT }));
      b.onResolve({ filter: /^(react|react-dom|use-intl)(\/.*)?$/ }, (a) =>
        a.pluginData === "root" ? undefined : b.resolve(a.path, { kind: a.kind, resolveDir: ROOT, pluginData: "root" }));
    },
  };
  await esbuild.build({
    entryPoints: [ENTRY], bundle: true, outdir: out, format: "iife", jsx: "automatic", minify: true, target: "es2022",
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
  const sha = spawnSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim() || "unknown";
  writeFileSync(join(out, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="entry.css"></head><body><div id="root"></div><script src="entry.js"></script></body></html>`);
  writeFileSync(join(out, "build.json"), JSON.stringify({ sha, at: new Date().toISOString() }));
  return out;
}

/* ── the browser ────────────────────────────────────────────────────────────────────────── */

/**
 * Installed in the page once. `__speedArm(what, arg, timeoutMs)` resolves with one press's reading:
 * the clock starts at the first press, key or input event after arming and stops at the frame after
 * the one that showed the end (`letter`: that letter's first lines in the reader; `hits`: the first
 * result row). `null` when the end never came.
 */
function pageProbe() {
  const w = window;
  const lt = [];
  for (const type of ["longtask", "long-animation-frame"]) {
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push({ s: e.startTime, d: e.duration }); }).observe({ type, buffered: false }); } catch {}
  }
  const shown = (e) => e !== null && e.getClientRects().length > 0 && !e.closest("[inert]");
  const ends = {
    /* The reader holds this letter, its body is final, and the body's box has lines in it: its own
       text, or the text of the framed document (the frame stands empty for a frame or two first). */
    letter: (id) => {
      /* A narrow window keeps a second, hidden copy of the reader under its sheet: any copy on screen counts. */
      for (const body of document.querySelectorAll(`article.msg[data-conv-id="${CSS.escape(id)}"][data-body-ready] .msg-body`)) {
        if (!shown(body) || body.getBoundingClientRect().height < 8) continue;
        const frame = body.querySelector("iframe");
        const text = frame === null ? body.textContent : frame.contentDocument?.body?.textContent;
        if ((text ?? "").trim().length > 0) return true;
      }
      return false;
    },
    hits: () => shown(document.querySelector(".view-search [data-hit]")),
  };
  w.__speedArm = (what, arg, timeoutMs) => new Promise((done) => {
    let t0 = null;
    const start = () => { if (t0 === null) t0 = performance.now(); };
    const EVENTS = ["pointerdown", "keydown", "input"];
    for (const ev of EVENTS) addEventListener(ev, start, { capture: true });
    const armed = performance.now();
    const frames = [];
    const finish = (seenAt, paintAt) => {
      for (const ev of EVENTS) removeEventListener(ev, start, { capture: true });
      if (paintAt === null) return done(null);
      let maxGap = 0;
      for (let i = 1; i < frames.length; i++) if (frames[i] >= t0) maxGap = Math.max(maxGap, frames[i] - Math.max(frames[i - 1], t0));
      const long = lt.filter((x) => x.s + x.d >= t0 && x.s <= paintAt).map((x) => x.d);
      lt.length = 0;
      done({ ms: paintAt - t0, seenMs: seenAt - t0, maxGapMs: maxGap, maxLongMs: Math.max(0, ...long) });
    };
    const tick = (now) => {
      frames.push(now);
      if (t0 !== null && ends[what](arg)) {
        const seenAt = performance.now();
        return void requestAnimationFrame((t) => { frames.push(t); finish(seenAt, performance.now()); });
      }
      if (performance.now() - armed > timeoutMs) return finish(null, null);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Serve `dist` on loopback and open the page over `messages` planted messages. Returns the page,
 * the errors it logged, and `close()`. `trace` (Chromium only) keeps the browser's own performance
 * recording of the whole visit in that file, to be opened in its Performance panel.
 */
export async function openPage({ dist, engine = "chromium", viewport = "1440x900", messages, bodyMs = 0, trace = null }) {
  if (!existsSync(join(dist, "entry.js")) || !existsSync(join(dist, "index.html"))) refuse(`no bundle in ${dist}: run the build first`);
  if (engine !== "chromium" && engine !== "webkit") refuse(`"${engine}" is not an engine this check drives (chromium, webkit)`);
  if (trace !== null && engine !== "chromium") refuse("a performance recording is Chromium's; --trace needs --engine chromium");
  const [width, height] = viewport.split("x").map(Number);
  if (!(width > 0) || !(height > 0)) refuse(`"${viewport}" is not a viewport (1440x900)`);
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
  const pw = createRequire(join(ROOT, "package.json"))("playwright");
  let browser;
  try {
    browser = await pw[engine].launch({ headless: true });
  } catch (e) {
    srv.close();
    refuse(`${engine} did not start (npx playwright install ${engine}): ${String(e).split("\n")[0]}`);
  }
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
  if (trace !== null) await browser.startTracing(page, { path: trace });
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${srv.address().port}/?n=${messages}&bodyMs=${bodyMs}#/ohbox`);
  try {
    await page.waitForSelector(".view-ohbox button.row[data-id]", { timeout: 180000 });
  } catch {
    await browser.close();
    srv.close();
    refuse(`the Ohbox drew no row over ${messages} messages within 180 s${errors.length ? `: ${errors[0]}` : ""}`);
  }
  const bootMs = Date.now() - t0;
  await page.waitForTimeout(1500);
  await page.evaluate(pageProbe);
  await page.evaluate(() => window.__speed.resetVitals());
  const arm = (what, arg, timeoutMs = 30000) => page.evaluate(([w, a, t]) => window.__speedArm(w, a, t), [what, arg, timeoutMs]);
  const close = async () => {
    if (trace !== null) await browser.stopTracing();
    await browser.close();
    srv.close();
  };
  return { page, errors, bootMs, arm, close };
}

/* ── the command line both checks share ─────────────────────────────────────────────────── */

/**
 * `build --out DIR` bundles the page; anything else runs the check: over `--dist DIR`, or over a
 * bundle built for this run and removed after it. `measure(options)` returns `{ readingMs, what,
 * detail }`; the verdict line is the last line printed and `--out FILE` keeps the whole run.
 * `goalSize` names the size class the row's goal is defined over: the class read when `--size` is
 * absent, and the only one whose reading is set against the goal.
 */
export async function main({ tag, budgetKey, goalField, goalSize = null, usage, measure }) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage);
    return 0;
  }
  if (argv[0] === "build") {
    const out = resolve(arg("out", join(tmpdir(), "ohmail-speed-check")));
    await buildPage(out);
    console.log(`built ${out}`);
    return 0;
  }
  let own = null;
  try {
    const table = arg("budget-table", BUDGETS);
    const budget = budgetOf(budgetKey, goalField, table);
    if (goalSize !== null) sizeClassOf(goalSize, table);
    const size = sizeClassOf(arg("size", goalSize ?? "5k"), table);
    const reps = Number(arg("reps", "0"));
    if (!Number.isInteger(reps) || reps < 0) refuse(`--reps ${arg("reps")} is not a count`);
    let dist = arg("dist", null);
    if (dist === null) {
      own = mkdtempSync(join(tmpdir(), "ohmail-speed-check-"));
      dist = await buildPage(own);
    }
    const options = {
      dist: resolve(dist), engine: arg("engine", "chromium"), viewport: arg("viewport", "1440x900"),
      messages: size.messages, bodyMs: Number(arg("body-ms", "0")), trace: arg("trace", null), ...(reps > 0 ? { reps } : {}),
    };
    const load = hostLoad();
    const run = await measure(options);
    if (run.errors.length > 0) refuse(`the page logged an error: ${run.errors[0]}`);
    const surface = `${size.name} (${size.messages} messages) · ${options.engine} ${options.viewport} · load ${load.load1}/${load.cpus}`;
    const verdict = verdictOf({ tag, budget, readingMs: run.readingMs, what: run.what, surface, size: size.name, goalSize });
    const build = existsSync(join(options.dist, "build.json")) ? JSON.parse(readFileSync(join(options.dist, "build.json"), "utf8")) : null;
    const record = { check: tag, budget, size, goalSize, options: { ...options, dist: undefined }, load, build, at: new Date().toISOString(), ...run, verdict: verdict.line };
    const out = arg("out", null);
    if (out !== null) writeFileSync(resolve(out), JSON.stringify(record, null, 1));
    for (const line of run.detail) console.log(line);
    console.log(verdict.line);
    return verdict.rc;
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    console.log(`${tag}: REFUSED -- ${e.message}`);
    return 3;
  } finally {
    if (own !== null) rmSync(own, { recursive: true, force: true });
  }
}
