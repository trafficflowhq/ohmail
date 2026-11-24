#!/usr/bin/env node
/**
 * capture.mjs --studio <dir> --tag <tag> --out <dir> [--only <screen>,…] [--jobs <n>]
 *             [--pack --canary <screen> [--home <address prefix>] [--revision <n>]]
 *
 * Takes the reference pictures: every registered state of the app, drawn by the design reference at one
 * tag, each with its data file. A maintainer runs it after the studio is tagged; nothing in a test run
 * calls it. It writes into --out and nowhere else:
 *
 *   registry.json            the derived registry of states (copied to test/compare/ by hand)
 *                            A screen named in no-picture.json keeps its states here and is not drawn.
 *   pictures/<screen>/<file>.png|.json
 *   manifest.json            one row a picture: sizes and checksums
 *   problems.json            states that could not be drawn, or drew with an error
 *   archive/<screen>-<tag>.<revision>.tar.gz and archive.lock.json   (with --pack; --canary is the shard
 *                            every comparison run checks; --home is where the shards can be fetched, and
 *                            without it the lock names no address)
 *
 * A state whose picture already stands in --out for the same commit is kept, so a cut-off run continues.
 * --studio and --tag have no default, and the page is served from the tag on loopback: never from a
 * running copy of the reference, which may be ahead of its tag.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { size } from "./png.mjs";
import { deriveRegistry, fileOf, registryText, stateHash } from "./registry.mjs";
import { launch, shoot } from "./render.mjs";
import { addressOf, commitOf, extractSimulator, readScreens, scaleOf, serveLoopback, windows } from "./studio.mjs";

const sha256 = (/** @type {Uint8Array | string} */ b) => createHash("sha256").update(b).digest("hex");
/** The registered screens that get no picture, each with its reason (`no-picture.json`). @type {{ screen: string, reason: string }[]} */
const NO_PICTURE = JSON.parse(readFileSync(fileURLToPath(new URL("./no-picture.json", import.meta.url)), "utf8"));
const FEEDBACK_TOOL = /\/feedback\.js$/;
/* Console lines that are no problem of the state: a file that did not load is counted by its status, and a
   letter is drawn in a frame that runs no script, which the browser says when the renderer's own are offered to it. */
const EXPECTED_SAID = /Failed to load resource|Blocked script execution in 'about:srcdoc'/;
/** How often a state is drawn again when the page lost a file or the host's network moved under it. */
const TRIES = 4;

/** @param {string[]} argv */
function args(argv) {
  /** @type {Record<string, string | true>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`capture: unexpected argument ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

/**
 * Draws one registered state at `base` and returns its picture, its data file and what went wrong on the way.
 * @param {import("@playwright/test").Browser} browser
 * @param {string} base
 * @param {import("./registry.d.mts").RegisteredState} state
 * @param {[number, number]} window
 * @param {{ studioTag: string, studioCommit: string }} at
 */
export async function captureState(browser, base, state, window, at) {
  const variant = { ...state.variant, width: window[0], height: window[1], scale: scaleOf(state.variant.device) };
  /** @type {string[]} */
  const said = [];
  const { png, scene } = await shoot(
    browser,
    variant,
    async (page) => {
      page.on("pageerror", (e) => said.push(`error: ${e.message}`));
      page.on("console", (m) => { if (m.type() === "error" && !EXPECTED_SAID.test(m.text())) said.push(`console: ${m.text()}`); });
      page.on("response", (r) => { if (r.status() >= 400) said.push(`status ${r.status()}: ${new URL(r.url()).pathname}`); });
      await page.goto(addressOf(base, state.key), { waitUntil: "load" });
      const bare = await page.evaluate(() => document.body.dataset.bare ?? "unset");
      if (bare !== "1") throw new Error(`capture: the reference did not draw the state bare (${bare})`);
    },
    {
      /* A render, not a visit: no host but the loopback server is ever called. The page also asks for the
         studio's feedback tool, which is not part of the app and is not unpacked: that request is dropped. */
      prepare: (context) => context.route("**/*", (route) => {
        const u = new URL(route.request().url());
        if (FEEDBACK_TOOL.test(u.pathname)) return route.abort();
        if (u.origin + "/" === base || u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return route.continue();
        said.push(`refused: a request to another host (${u.protocol}//…)`);
        return route.abort();
      }),
      mayFail: (url) => FEEDBACK_TOOL.test(new URL(url).pathname) || !url.startsWith(base),
    },
  );
  if (scene.page.scrollWidth > scene.page.clientWidth) said.push(`scrolls sideways: ${scene.page.scrollWidth} > ${scene.page.clientWidth}`);
  return { png, scene: { key: state.key, studioTag: at.studioTag, studioCommit: at.studioCommit, ...scene }, said };
}

/** Packs one screen's pictures into an archive whose bytes depend on its files alone. @param {string} from @param {string} to */
function pack(from, to) {
  const tar = execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--format=gnu", "-C", from, "-cf", "-", "."], { maxBuffer: 2 * 1024 * 1024 * 1024 });
  writeFileSync(to, execFileSync("gzip", ["-n", "-6", "-c"], { input: tar, maxBuffer: 2 * 1024 * 1024 * 1024 }));
}

async function main() {
  const a = args(process.argv.slice(2));
  if (typeof a.studio !== "string" || typeof a.tag !== "string" || typeof a.out !== "string") {
    process.stderr.write("usage: capture.mjs --studio <dir> --tag <tag> --out <dir> [--only <screen>,…] [--jobs <n>] [--pack --canary <screen> [--home <address prefix>] [--revision <n>]]\n");
    process.exit(2);
  }
  const out = resolve(a.out);
  const revision = typeof a.revision === "string" ? a.revision : "1";
  const jobs = Math.max(1, Math.min(8, Number(a.jobs) || 4));
  const only = typeof a.only === "string" ? new Set(a.only.split(",")) : null;
  const at = { studioTag: a.tag, studioCommit: commitOf(a.studio, a.tag) };
  const registry = deriveRegistry(readScreens(a.studio, a.tag), at);
  mkdirSync(join(out, "pictures"), { recursive: true });
  writeFileSync(join(out, "registry.json"), registryText(registry));

  const work = mkdtempSync(join(tmpdir(), "ohmail-reference-"));
  const served = extractSimulator(a.studio, a.tag, work);
  const site = await serveLoopback(served);
  const require_ = createRequire(resolve(process.cwd(), "package.json"));
  const { chromium } = require_("@playwright/test");
  let browser = await launch(chromium);
  /* A browser that died takes every state after it along; a fresh one is started in its place, once for
     all the jobs that find it dead. */
  /** @type {Promise<void> | null} */
  let starting = null;
  const alive = async () => {
    if (browser.isConnected()) return browser;
    starting ??= launch(chromium).then((b) => { browser = b; starting = null; process.stdout.write("capture: the browser was gone; started another\n"); });
    await starting;
    return browser;
  };
  const windowOf = windows(served, alive, site.base);

  const left = new Set(NO_PICTURE.map((n) => n.screen));
  const pictured = registry.states.filter((s) => !left.has(s.screen));
  const todo = pictured.filter((s) => !only || only.has(s.screen));
  /** @type {{ key: string, said: string[] }[]} */
  const problems = [];
  let done = 0, kept = 0;
  const started = Date.now();
  const next = async () => {
    for (;;) {
      const state = todo.shift();
      if (!state) return;
      const dir = join(out, "pictures", state.screen), file = fileOf(state.key);
      const png = join(dir, `${file}.png`), json = join(dir, `${file}.json`);
      if (existsSync(png) && existsSync(json) && JSON.parse(readFileSync(json, "utf8")).studioCommit === at.studioCommit) { kept++; continue; }
      for (let attempt = 1; attempt <= TRIES; attempt++) {
        try {
          const shot = await captureState(await alive(), site.base, state, await windowOf(state.key), at);
          mkdirSync(dir, { recursive: true });
          writeFileSync(json, JSON.stringify(shot.scene));
          writeFileSync(png, shot.png);
          if (shot.said.length) problems.push({ key: state.key, said: [...new Set(shot.said)] });
          break;
        } catch (e) {
          if (attempt === TRIES) problems.push({ key: state.key, said: [`NO PICTURE: ${/** @type {Error} */ (e).message.split("\n")[0]}`] });
        }
      }
      if (++done % 100 === 0) process.stdout.write(`capture: ${done} drawn, ${kept} kept, ${todo.length} to go, ${Math.round((Date.now() - started) / 1000)} s\n`);
    }
  };
  try {
    await Promise.all(Array.from({ length: jobs }, next));
  } finally {
    await browser.close();
    await site.close();
    rmSync(work, { recursive: true, force: true });
  }

  /* The manifest is read back from what stands on disk, so a continued run and a whole one write the same. */
  /** @type {import("./registry.d.mts").ManifestRow[]} */
  const rows = [];
  /** @type {string[]} */
  const missing = [];
  for (const state of pictured) {
    const dir = join(out, "pictures", state.screen), file = fileOf(state.key);
    if (!existsSync(join(dir, `${file}.png`)) || !existsSync(join(dir, `${file}.json`))) { missing.push(state.key); continue; }
    const png = readFileSync(join(dir, `${file}.png`)), scene = readFileSync(join(dir, `${file}.json`));
    const { width, height } = size(png);
    rows.push({ key: state.key, shard: state.screen, png: { sha256: sha256(png), bytes: png.length, w: width, h: height, scale: JSON.parse(scene.toString("utf8")).variant.scale }, scene: { sha256: sha256(scene) }, stateHash: stateHash(state) });
  }
  const shards = Object.fromEntries([...new Set(rows.map((r) => r.shard))].map((id) => [id, at]));
  writeFileSync(join(out, "manifest.json"), `{\n"shards": ${JSON.stringify(shards)},\n"rows": [\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]\n}\n`);
  writeFileSync(join(out, "problems.json"), JSON.stringify(problems, null, 1));

  if (a.pack) {
    if (typeof a.canary !== "string" || !shards[a.canary]) throw new Error("capture: --pack needs --canary <a screen with pictures>");
    if (a.home !== undefined && (typeof a.home !== "string" || !a.home.endsWith("/"))) throw new Error("capture: --home is an address prefix ending in /");
    mkdirSync(join(out, "archive"), { recursive: true });
    const lock = [];
    for (const id of Object.keys(shards).sort()) {
      /* Letters, digits, dots and dashes only: a name every host keeps as it is. */
      const file = `${id}-${a.tag}.${revision}.tar.gz`;
      pack(join(out, "pictures", id), join(out, "archive", file));
      const bytes = readFileSync(join(out, "archive", file));
      lock.push({ id, file, sha256: sha256(bytes), bytes: bytes.length, urls: a.home ? [`${a.home}${file}`] : [] });
    }
    writeFileSync(join(out, "archive.lock.json"), `{\n"canary": ${JSON.stringify(a.canary)},\n"shards": [\n${lock.map((s) => JSON.stringify(s)).join(",\n")}\n]\n}\n`);
  }

  const drawn = readdirSync(join(out, "pictures")).reduce((n, d) => n + readdirSync(join(out, "pictures", d)).filter((f) => f.endsWith(".png")).length, 0);
  process.stdout.write(`CAPTURE registered=${registry.states.length} left_out_on_purpose=${registry.states.length - pictured.length} pictures=${rows.length} without=${missing.length} problems=${problems.length} drawn_now=${done} kept=${kept} on_disk=${drawn} seconds=${Math.round((Date.now() - started) / 1000)}\n`);
  if (!only) for (const k of missing) process.stdout.write(`WITHOUT ${k}\n`);
  process.exit(only ? 0 : missing.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { process.stderr.write(`capture: ${e.stack ?? e}\n`); process.exit(1); });
}
