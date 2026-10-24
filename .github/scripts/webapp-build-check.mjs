/**
 * THE WEB BUILD'S OWN CHECKS, run by ci.yml's "suite · webapp next build" job after `next build`.
 *
 *   imports <build log>   exit 1 when the log carries a missing export. webpack reports one as a warning
 *                         and next build exits 0, while the bundle ships the name undefined: a named
 *                         `Activity` from Next's vendored React reached a release that way, and News and
 *                         Receipts threw React #130 on the web.
 *   smoke <webapp dir>    next start over that build on a free port, then /demo (the client over its
 *                         fixtures, no account, no network) in Chromium at the Ohbox, News and Receipts.
 *                         Exit 1 on a server 5xx, an uncaught page error, a React error in the console
 *                         or a view's failure card.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** webpack's wording, and the wording Next rewrites it to. */
const MISSING_EXPORT = [
  /Attempted import error:/,
  /\bexport '[^']*' \((?:imported|reexported) as '[^']*'\) was not found in\b/,
  /\bis not exported from '/,
];

/** Each missing export in a build log, as "<module>: <line>" (the module is the line above it). */
export function importErrors(log) {
  const lines = String(log).split(/\r?\n/);
  const found = [];
  lines.forEach((line, i) => {
    if (!MISSING_EXPORT.some((re) => re.test(line))) return;
    const above = (lines[i - 1] ?? "").trim();
    found.push(/^\.{0,2}\/\S+$/.test(above) ? `${above}: ${line.trim()}` : line.trim());
  });
  return found;
}

const REACT_ERROR = /Minified React error #\d+|React error #\d+/;

/** What one browser event fails the smoke for, or null. */
export function smokeFailure(event) {
  switch (event.kind) {
    case "response":
      return event.status >= 500 ? `server ${event.status} at ${event.url}` : null;
    case "pageerror":
      return `uncaught page error: ${event.text}`;
    case "console":
      return event.type === "error" && REACT_ERROR.test(event.text ?? "") ? `console: ${event.text}` : null;
    case "failcard":
      return `the ${event.text} view drew its failure card`;
    default:
      return null;
  }
}

/** The views the smoke opens, by hash route; each one's root carries `.view-<id>`. */
const ROUTES = ["ohbox", "reads", "receipts"];

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function smoke(webapp) {
  const req = createRequire(join(resolve(webapp), "package.json"));
  const nextCli = join(dirname(req.resolve("next/package.json")), "dist/bin/next");
  const { chromium } = await import("playwright");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [nextCli, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: webapp,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  const failures = [];
  let browser = null;
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`next start exited ${server.exitCode}\n${serverLog}`);
      const up = await fetch(`${origin}/version`).then((r) => r.status, () => 0);
      if (up > 0) break;
      if (Date.now() > deadline) throw new Error(`next start did not answer in 60 s\n${serverLog}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    browser = await chromium.launch();
    const page = await browser.newPage();
    const note = (event) => {
      const f = smokeFailure(event);
      if (f) failures.push(f);
    };
    page.on("response", (r) => note({ kind: "response", url: r.url(), status: r.status() }));
    page.on("pageerror", (e) => note({ kind: "pageerror", text: e.stack ?? String(e) }));
    page.on("console", (m) => note({ kind: "console", type: m.type(), text: m.text().split("\n", 2).join("\n") }));
    const doc = await page.goto(`${origin}/demo#/${ROUTES[0]}`, { waitUntil: "load" });
    if (!doc || doc.status() >= 400) failures.push(`/demo answered ${doc?.status() ?? "nothing"}`);
    for (const view of ROUTES) {
      // A hash change, as a press of the rail does: the shell switches views without a reload.
      await page.evaluate((v) => { window.location.hash = `#/${v}`; }, view);
      const drawn = await page
        .waitForSelector(`.view-${view}, .view-fail`, { state: "visible", timeout: 30_000 })
        .then(() => true, () => false);
      await page.waitForTimeout(1_000);
      const failed = (await page.locator(".view-fail:visible").count()) > 0;
      if (failed) note({ kind: "failcard", text: view });
      else if (!drawn) failures.push(`the ${view} view did not draw in 30 s`);
      console.log(`webapp smoke: ${view} ${failed ? "failed" : drawn ? "drawn" : "not drawn"}`);
    }
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
  return failures;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [verb, arg] = process.argv.slice(2);
  if (verb === "imports" && arg) {
    const found = importErrors(readFileSync(arg, "utf8"));
    for (const f of found) console.log(`::error::next build: ${f}`);
    if (found.length) console.log(`next build: ${found.length} missing export(s); webpack warned and exited 0.`);
    process.exit(found.length ? 1 : 0);
  } else if (verb === "smoke" && arg) {
    const failures = await smoke(arg).catch((e) => [String(e?.stack ?? e)]);
    for (const f of failures) console.log(`::error::webapp smoke: ${f}`);
    if (!failures.length) console.log("webapp smoke: the Ohbox, News and Receipts drew with no error.");
    process.exit(failures.length ? 1 : 0);
  } else {
    console.error("usage: webapp-build-check.mjs imports <build log> | smoke <webapp dir>");
    process.exit(2);
  }
}
