/**
 * Everything that reads the design reference: the private studio repository, at one tag.
 *
 * Only two things are ever read from it, both with git and neither by a checkout: the list of screens
 * (one file) and the app simulation's folder, which is unpacked into a temporary directory and served
 * on loopback. Nothing else of that repository is extracted, so nothing else can be drawn. The studio's
 * path is always an argument: this repository does not know where the studio is.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";

/** The one folder of the studio that is unpacked, and the one file that is read. */
export const SIMULATOR = "site/simulator";
export const SCREENS = "site/fullstop.json";

const git = (/** @type {string} */ studio, /** @type {string[]} */ args) =>
  execFileSync("git", ["-C", studio, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** @param {string} studio @param {string} tag */
export function commitOf(studio, tag) {
  return git(studio, ["rev-parse", "--verify", `${tag}^{commit}`]).trim();
}

/** The design reference's list of screens at the tag, parsed. @param {string} studio @param {string} tag */
export function readScreens(studio, tag) {
  return JSON.parse(git(studio, ["show", `${tag}:${SCREENS}`]));
}

/** Unpacks the simulation's folder at the tag into `into` and returns the folder to serve. @param {string} studio @param {string} tag @param {string} into */
export function extractSimulator(studio, tag, into) {
  const archive = spawnSync("git", ["-C", studio, "archive", "--format=tar", tag, SIMULATOR], { maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`studio: git archive ${tag} ${SIMULATOR} failed`);
  const untar = spawnSync("tar", ["-x", "-C", into], { input: archive.stdout });
  if (untar.status !== 0) throw new Error("studio: the archive could not be unpacked");
  return join(into, SIMULATOR);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };

/**
 * Serves one folder on loopback, read only, and nothing above it.
 * @param {string} root
 * @returns {Promise<{ base: string, close: () => Promise<void> }>}
 */
export function serveLoopback(root) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    let file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": TYPES[/** @type {keyof typeof TYPES} */ (extname(file))] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const at = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({ base: `http://127.0.0.1:${at.port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

/** The address a state is drawn at: its key, with the reference's own frame off and its motion short. @param {string} base @param {string} key */
export function addressOf(base, key) {
  return `${base}?${key}&bare=1&fast=1`;
}

/** Pixels per CSS pixel a device's pictures are taken at: the desktop at one, every hand-held at two. @param {string} device */
export function scaleOf(device) {
  return device === "desktop" ? 1 : 2;
}

/**
 * The window each device is drawn in, read from the reference itself and never guessed: the four plain
 * sizes from its frame's own table, a foldable's from its device table through the page (`FS.stage()`),
 * which knows the posture the address names.
 *
 * @param {string} served the unpacked simulation folder
 * @param {() => Promise<import("@playwright/test").Browser>} browser the browser to ask, each time one is needed
 * @param {string} base
 */
export function windows(served, browser, base) {
  const frame = readFileSync(join(served, "core/frame.js"), "utf8");
  const table = /var STAGE = (\{[^}]*\});/.exec(frame);
  if (!table) throw new Error("studio: the frame's table of stage sizes was not found");
  /** @type {Record<string, [number, number]>} */
  const plain = JSON.parse(table[1].replace(/(\w+):/g, '"$1":'));
  /** @type {Map<string, [number, number]>} */
  const seen = new Map();
  return async (/** @type {string} */ key) => {
    const q = new URLSearchParams(key);
    const device = q.get("device") ?? "desktop";
    if (plain[device]) return plain[device];
    const id = ["device", "posture", "turn", "make"].map((k) => q.get(k) ?? "").join("|");
    const had = seen.get(id);
    if (had) return had;
    const context = await (await browser()).newContext({ viewport: { width: 1600, height: 1200 } });
    try {
      const page = await context.newPage();
      const only = new URLSearchParams();
      for (const k of ["screen", "device", "posture", "turn", "make"]) if (q.has(k)) only.set(k, /** @type {string} */ (q.get(k)));
      await page.goto(`${base}?${only}`, { waitUntil: "load" });
      const stage = await page.evaluate(() => { const fs = /** @type {any} */ (window).FS; return fs && fs.stage ? fs.stage() : null; });
      if (!Array.isArray(stage) || !(stage[0] > 0) || !(stage[1] > 0)) throw new Error(`studio: the reference names no stage for device=${device}`);
      const size = /** @type {[number, number]} */ ([stage[0], stage[1]]);
      seen.set(id, size);
      return size;
    } finally {
      await context.close();
    }
  };
}
