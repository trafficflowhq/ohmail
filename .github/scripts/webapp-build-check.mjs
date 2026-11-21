/**
 * THE WEB BUILD'S OWN CHECKS, run by ci.yml's "suite · webapp next build" job after `next build`.
 *
 *   imports <build log>   exit 1 when the log carries a missing export. webpack reports one as a warning
 *                         and next build exits 0, while the bundle ships the name undefined: a named
 *                         `Activity` from Next's vendored React reached a release that way, and News and
 *                         Receipts threw React #130 on the web.
 *   smoke <webapp dir>    next start over that build on a free port, then /demo (the client over its
 *                         fixtures, no account, no network) in Chromium. Open a message, compose a letter, visit News and Receipts,
 *                         and verify that an unregistered address returns to the Ohbox.
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
  const { chromium } = req("playwright");
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
    page.setDefaultTimeout(30_000);
    const note = (event) => {
      const f = smokeFailure(event);
      if (f) failures.push(f);
    };
    page.on("response", (r) => note({ kind: "response", url: r.url(), status: r.status() }));
    page.on("pageerror", (e) => note({ kind: "pageerror", text: e.stack ?? String(e) }));
    page.on("console", (m) => note({ kind: "console", type: m.type(), text: m.text().split("\n", 2).join("\n") }));
    const doc = await page.goto(`${origin}/demo#/ohbox`, { waitUntil: "load" });
    if (!doc || doc.status() >= 400) failures.push(`/demo answered ${doc?.status() ?? "nothing"}`);
    const inbox = page.locator("section.fr-list .ob-list");
    const firstLetter = inbox.getByRole("option").first();
    await firstLetter.waitFor();
    await firstLetter.click();
    await page.getByRole("region", { name: "Open message", exact: true }).getByRole("heading").first().waitFor();
    await page.keyboard.press("c");
    await page.getByRole("textbox", { name: "Subject", exact: true }).waitFor();
    if (await page.locator(".view-fail:visible").count()) note({ kind: "failcard", text: "Compose" });
    for (const [path, title] of [["reads", "News"], ["receipts", "Receipts"]]) {
      await page.evaluate((id) => { window.location.hash = `#/${id}`; }, path);
      const list = page.locator("section.fr-list");
      await list.getByRole("heading", { name: title, exact: true }).waitFor();
      const first = list.locator('[role="option"][data-id]').first();
      const letter = await first.getAttribute("data-id");
      if (!letter) throw new Error(`${title} has no first message`);
      await first.click();
      await page.waitForURL((url) => url.hash === `#/${path}/m/${letter}`);
      if (await page.locator(".view-fail:visible").count()) note({ kind: "failcard", text: title });
    }
    await page.evaluate(() => { window.location.hash = "#/unknown-place"; });
    await page.waitForURL((url) => url.hash === "#/ohbox");
    await firstLetter.waitFor();
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
    if (!failures.length) console.log("webapp smoke: Ohbox, Reader, Compose, News, Receipts and the unknown-address fallback passed.");
    process.exit(failures.length ? 1 : 0);
  } else {
    console.error("usage: webapp-build-check.mjs imports <build log> | smoke <webapp dir>");
    process.exit(2);
  }
}
