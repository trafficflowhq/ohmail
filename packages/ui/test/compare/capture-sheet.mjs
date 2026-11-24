#!/usr/bin/env node
/**
 * capture-sheet.mjs --studio <dir> --commit <rev> --entry <base|mail|calendar> --map <file> --out <dir>
 *                   [--only <Component>[/<state>]] [--pack [--revision <n>]]
 *
 * Takes the kit's reference pictures: each state of `test/reference/<entry>/states.json`, drawn by the
 * design reference's own component sheet at one commit, in each look the row names. A maintainer runs
 * it after the design reference moved; nothing in a test run calls it.
 *
 * The design reference is a private repository. What this tool is told about it stays outside this one:
 * --studio is its checkout, and --map is a file kept beside it that says where the sheet shows each
 * state, one row a state under its `<Component>/<state>` key:
 *
 *   { "spec": "<specimen>", "opts": { … }, "cell": "<the cell's caption>" | <its index>, "part": "<selector>", "among": true }
 *       a cell of a specimen the sheet draws itself; `part` narrows it to one node of the cell, which then
 *       stands alone unless `among` keeps its neighbours beside it
 *   { "state": "<the app's state, as its address names it>", "part": "<selector>", "press": "<selector>", "place": "cell" | "block" }
 *       a node of a whole screen, drawn in the device's own window; `press` is pressed first. With `place`
 *       the part is read from its own corner, as one that does not keep a place in the window
 *
 * It writes the data files into `test/reference/<entry>/` (public: names, boxes and drawn values), the
 * pictures into --out (never into this repository), and with --pack one archive of the pictures, named
 * in the entry's manifest with its SHA-256. A state already taken at this commit is kept.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as prettier from "prettier";
import { decode, encode } from "../../../../test/compare/png.mjs";
import { launch, RequestLost, shoot } from "../../../../test/compare/render.mjs";
import { serveLoopback } from "../../../../test/compare/studio.mjs";
import { cutScene, readAlone } from "./cut.mjs";
import { fileOf, looksOf, PRIVATE, referenceKey, stateHash, stateKey } from "./reference.mjs";

const sha256 = (/** @type {Uint8Array | string} */ b) => createHash("sha256").update(b).digest("hex");
/** A file of this repository is written as its formatter writes it, so the manifest names the bytes that stay. */
const formatted = async (/** @type {string} */ file, /** @type {string} */ text) =>
  prettier.format(text, { ...(await prettier.resolveConfig(file)), filepath: file });

/** The two folders of the design reference a specimen is drawn from. Nothing else of it is unpacked. */
const SHEET = "site/system",
  APP = "site/simulator";
const FEEDBACK_TOOL = /\/feedback\.js$/;
const TRIES = 4;
/** Raised when the way a picture is taken changes: every picture is then taken again. */
const TAKING = 6;
const sourceHash = (
  /** @type {unknown} */ source,
  /** @type {{ component: string, state: string }} */ row,
) => {
  const staged =
    (row.component === "WaitRow" && row.state === "refused") ||
    (row.component === "Report" && row.state === "why") ||
    (row.component === "Page" && row.state === "refused");
  return sha256(
    JSON.stringify(staged ? [TAKING, source ?? null, "screen-stage"] : [TAKING, source ?? null]),
  ).slice(0, 16);
};
/** A specimen stands in a page as wide as the sheet's own; a screen in its device's window. */
const SHEET_WINDOW = [1440, 900];
const WINDOWS = { desktop: [1440, 900], phone: [390, 844], fold: [719, 781], foldl: [841, 673] };

/** @param {string[]} argv */
function args(argv) {
  /** @type {Record<string, string | true>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`capture-sheet: unexpected argument ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

/** In the page: the box around what `selector` names under `root`, to a tenth of a pixel. */
function boxIn(/** @type {{ root: string, selector: string | null }} */ { root, selector }) {
  const host = document.querySelector(root);
  if (!host) return null;
  const list = selector ? host.querySelectorAll(selector) : host.children;
  /* Finer than a box is read: the fraction of a pixel the part stands on decides how its edges are drawn. */
  const round = (/** @type {number} */ n) => Math.round(n * 10000) / 10000;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const el of list) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    x0 = Math.min(x0, r.left);
    y0 = Math.min(y0, r.top);
    x1 = Math.max(x1, r.right);
    y1 = Math.max(y1, r.bottom);
  }
  return x1 > x0 && y1 > y0 ? [round(x0), round(y0), round(x1 - x0), round(y1 - y0)] : null;
}

/** In the page: the box of every node of the part, so what merely lies behind it is not read as its own. */
function ownBoxes(/** @type {{ root: string, selector: string | null }} */ { root, selector }) {
  const host = document.querySelector(root);
  if (!host) return [];
  const tops = selector ? [...host.querySelectorAll(selector)] : [...host.children];
  return tops
    .flatMap((top) => [top, ...top.querySelectorAll("*")])
    .map((el) => {
      /* As measured: a scene's box is rounded to a tenth, and two roundings of a value on the half part ways. */
      const r = el.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height];
    });
}

/** In the page: resolves once the typefaces are in and every move that ends has ended. */
async function settled() {
  /* Every declared face, not only those the first layout asked for: a weight that arrives late moves boxes read before it. */
  await Promise.all([...document.fonts].map((face) => face.load().catch(() => null)));
  await document.fonts.ready;
  const frame = () => new Promise((done) => requestAnimationFrame(() => done(null)));
  await frame();
  await Promise.all(
    document
      .getAnimations()
      .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
      .map((a) => a.finished.catch(() => null)),
  );
  await frame();
  await frame();
}

/**
 * The part's own boxes once they stand still: a screen may set itself out once more after its first
 * paint (the room it measured, a face that arrived), and boxes read before that are not the picture's.
 * @param {import("@playwright/test").Page} page @param {{ root: string, selector: string | null }} where
 */
async function stillBoxes(page, where) {
  let boxes = await page.evaluate(ownBoxes, where);
  for (let turn = 0; turn < 12; turn++) {
    await page.waitForTimeout(120);
    const again = await page.evaluate(ownBoxes, where);
    if (JSON.stringify(again) === JSON.stringify(boxes)) return again;
    boxes = again;
  }
  throw new Error("the part did not come to rest");
}

/**
 * Draws one state in one look and returns its picture, cut to the part, and its data file.
 * @param {import("@playwright/test").Browser} browser @param {string} base
 * @param {{ component: string, state: string }} row @param {any} source @param {string} look @param {string} studioCommit
 */
export async function captureState(browser, base, row, source, look, studioCommit) {
  const [face, scheme, device] = look.split("-");
  const whole = typeof source.state === "string";
  const [width, height] = whole ? WINDOWS[device] : SHEET_WINDOW;
  const variant = { device, face, scheme, width, height, scale: device === "desktop" ? 1 : 2 };
  /* The review tool is no part of the app; a specimen needs none of the whole screens the sheet also frames. */
  const notNeeded = (/** @type {string} */ path) =>
    FEEDBACK_TOOL.test(path) || (!whole && path.endsWith(`/${APP}/index.html`));
  /** @type {string[]} */
  const said = [];
  /** @type {number[] | null} */
  let target = null;
  /** @type {number[][]} */
  let own = [];
  /** @type {import("../../../../test/compare/scene.d.mts").Scene | null} */
  let alone = null;
  const { png } = await shoot(
    browser,
    variant,
    async (page) => {
      page.on("pageerror", (e) => said.push(`error: ${e.message}`));
      page.on("response", (r) => {
        if (r.status() >= 400) said.push(`status ${r.status()}: ${new URL(r.url()).pathname}`);
      });
      if (whole) {
        const q = new URLSearchParams(source.state);
        q.set("device", device);
        if (face !== "paper") q.set("face", face);
        if (scheme !== "light") q.set("scheme", scheme);
        q.set("bare", "1");
        q.set("fast", "1");
        await page.goto(`${base}${APP}/index.html?${q}`, { waitUntil: "load" });
        /* The screen marks itself bare once its script has run, which on a busy machine can come after the load. */
        await page
          .waitForFunction(() => document.body.dataset.bare === "1", null, { timeout: 5000 })
          .catch(() => {
            throw new Error("the reference did not draw the state bare");
          });
        if (device === "phone")
          await page.addStyleTag({
            content:
              ".ob-acts { background: transparent !important; } .ob-acts::before { display: none !important; }",
          });
        if (source.press) await page.locator(source.press).first().click();
        await page.locator(source.part).first().waitFor({ state: "visible", timeout: 5000 });
        if (row.component === "WaitRow" && row.state === "refused") {
          await page.evaluate((selector) => {
            const part = document.querySelector(selector);
            for (const sibling of [...(part?.parentElement?.children ?? [])]) {
              if (sibling !== part) sibling.remove();
            }
          }, source.part);
        }
        if (row.component === "Report" && row.state === "why") {
          await page.addStyleTag({
            content:
              'body *{visibility:hidden}#report,#report *{visibility:visible}#report{isolation:isolate}#report::before{content:"";position:fixed;inset:0;background:var(--ground);z-index:-1}',
          });
        }
        if (
          row.component === "Page" &&
          row.state === "refused" &&
          face === "ohmarchy" &&
          device !== "phone"
        ) {
          await page.evaluate((selector) => {
            const part = document.querySelector(selector);
            const frame = part?.parentElement;
            if (!(part instanceof HTMLElement) || !frame) throw new Error("the page window is missing");
            const a = part.getBoundingClientRect();
            const b = frame.getBoundingClientRect();
            if (
              [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height].some((n) => Math.abs(n) > 0.05)
            )
              throw new Error("the page and its window do not share bounds");
            const ring = getComputedStyle(frame).boxShadow;
            if (ring === "none") throw new Error("the page window has no ring");
            part.style.boxShadow = ring;
            frame.style.boxShadow = "none";
          }, source.part);
        }
        await page.evaluate(settled);
        own = await stillBoxes(page, { root: "body", selector: source.part });
        target = await page.evaluate(boxIn, { root: "body", selector: source.part });
        alone = await readAlone(page, variant, { root: "body", selector: source.part });
      } else {
        await page.goto(`${base}${SHEET}/index.html?face=${face}&scheme=${scheme}`, { waitUntil: "load" });
        /* One specimen, alone on the page, drawn by the sheet's own renderer in the look asked for. */
        const found = await page.evaluate(
          ({ spec, opts, device, face, scheme, cell, part, among }) => {
            const sheet = /** @type {any} */ (window).DS;
            if (!sheet || !sheet.specs || !sheet.specs[spec]) return `no specimen "${spec}"`;
            const el = document.createElement("div");
            el.className = "fs spec";
            el.dataset.spec = spec;
            el.dataset.device = device;
            el.dataset.lFace = face;
            el.dataset.lScheme = scheme;
            if (opts) el.dataset.opts = JSON.stringify(opts);
            document.body.replaceChildren(el);
            sheet.render(el);
            const cells = [...el.querySelectorAll(".ds-cell")];
            const at =
              typeof cell === "number"
                ? cells[cell]
                : cells.find((c) => (c.querySelector("figcaption")?.textContent ?? "").trim() === cell);
            const inner = at?.querySelector(".ds-cell-in");
            if (!inner)
              return `no cell ${JSON.stringify(cell)} (${cells.map((c) => c.querySelector("figcaption")?.textContent?.trim()).join(" | ")})`;
            inner.setAttribute("data-kit-cell", "");
            /* The cell alone: what stood before it would set it on a fraction of a pixel, and the part's own picture with it. */
            for (let node = at; node && node !== el; node = node.parentElement) {
              for (const other of node.parentElement?.children ?? [])
                if (other !== node) /** @type {HTMLElement} */ (other).style.display = "none";
            }
            /* One part of several in a cell stands alone too, unless the row keeps its neighbours (`"among": true`). */
            const parts = part ? inner.querySelectorAll(part) : [];
            if (parts.length === 1 && !among) {
              for (let node = parts[0]; node && node !== inner; node = node.parentElement) {
                for (const other of node.parentElement?.children ?? [])
                  if (other !== node) /** @type {HTMLElement} */ (other).style.display = "none";
              }
            }
            window.scrollTo(
              0,
              Math.max(0, Math.round(inner.getBoundingClientRect().top + window.scrollY - 24)),
            );
            return "";
          },
          {
            spec: source.spec,
            opts: source.opts ?? null,
            device,
            face,
            scheme,
            cell: source.cell ?? 0,
            part: source.part ?? null,
            among: source.among === true,
          },
        );
        if (found) throw new Error(found);
        await page.evaluate(settled);
        own = await stillBoxes(page, { root: "[data-kit-cell]", selector: source.part ?? null });
        target = await page.evaluate(boxIn, { root: "[data-kit-cell]", selector: source.part ?? null });
        alone = await readAlone(page, variant, { root: "[data-kit-cell]", selector: source.part ?? null });
      }
    },
    {
      /* A render, never a visit: no host but the loopback server is called, and the review tool the pages ask for is not part of the app. */
      prepare: (context) =>
        context.route("**/*", (route) => {
          const u = new URL(route.request().url());
          if (notNeeded(u.pathname)) return route.abort();
          return u.hostname === "127.0.0.1" ? route.continue() : route.abort();
        }),
      mayFail: (url) => notNeeded(new URL(url).pathname),
    },
  );
  if (!target || !alone) throw new Error("the part was not found, or has no size");
  const place = source.place ?? (whole ? "window" : "cell");
  const [x, y, w, h] = target;
  const clip = [Math.max(0, Math.floor(x)), Math.max(0, Math.floor(y)), 0, 0];
  clip[2] = Math.min(width, Math.ceil(x + w)) - clip[0];
  clip[3] = Math.min(height, Math.ceil(y + h)) - clip[1];
  /* What is the part's own: a box the scene rounds to a tenth is within a twentieth of one measured. */
  const mine = (/** @type {number[]} */ box) =>
    own.some((b) => b.every((v, k) => Math.abs(v - box[k]) < 0.06));
  const scene = cutScene(alone, target, place, mine);
  const data = {
    component: row.component,
    state: row.state,
    look,
    place,
    target,
    clip,
    studioCommit,
    variant,
    reader: scene.reader,
    page: scene.page,
    fonts: scene.fonts,
    types: scene.types,
    paints: scene.paints,
    nodes: scene.nodes,
    loose: scene.loose,
  };
  return { png: cut(png, clip, variant.scale), data, said };
}

/** @param {Uint8Array} png @param {number[]} clip @param {number} scale */
function cut(png, clip, scale) {
  const from = decode(png);
  const [x, y, w, h] = clip.map((n) => Math.round(n * scale));
  const data = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++)
    data.set(
      from.data.subarray(((y + row) * from.width + x) * 4, ((y + row) * from.width + x + w) * 4),
      row * w * 4,
    );
  return encode({ width: w, height: h, data });
}

async function main() {
  const a = args(process.argv.slice(2));
  for (const need of ["studio", "commit", "entry", "map", "out"])
    if (typeof a[need] !== "string")
      throw new Error(`capture-sheet: --${need} is required; nothing here has a default`);
  const entry = String(a.entry),
    out = resolve(String(a.out)),
    studio = resolve(String(a.studio));
  const reference = resolve(process.cwd(), "packages/ui/test/reference", entry);
  const states = JSON.parse(readFileSync(join(reference, "states.json"), "utf8")).rows;
  const map = JSON.parse(readFileSync(resolve(String(a.map)), "utf8"));
  const commit = execFileSync("git", ["-C", studio, "rev-parse", "--verify", `${a.commit}^{commit}`], {
    encoding: "utf8",
  }).trim();
  const only = typeof a.only === "string" ? a.only.split(",") : null;

  const work = mkdtempSync(join(tmpdir(), "kit-sheet-"));
  const archive = spawnSync("git", ["-C", studio, "archive", "--format=tar", commit, SHEET, APP], {
    maxBuffer: 512 * 1024 * 1024,
  });
  if (archive.status !== 0 || spawnSync("tar", ["-x", "-C", work], { input: archive.stdout }).status !== 0)
    throw new Error("capture-sheet: the design reference could not be unpacked at that commit");
  const server = await serveLoopback(work);
  const { chromium } = createRequire(resolve(process.cwd(), "package.json"))("@playwright/test");
  const browser = await launch(chromium);

  const manifestFile = join(reference, "manifest.json");
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : { rows: [] };
  /** @type {Map<string, any>} */
  const rows = new Map(manifest.rows.map((/** @type {any} */ r) => [r.key, r]));
  /** @type {{ key: string, said: string[] }[]} */
  const problems = [];
  let taken = 0,
    kept = 0;
  try {
    for (const row of states) {
      const name = stateKey(row);
      if (only && !only.some((o) => o === name || o === row.component)) continue;
      const source = map[name];
      for (const look of looksOf(row)) {
        const key = referenceKey(row, look);
        const picture = join(out, entry, "pictures", `${key}.png`),
          dataFile = join(reference, `${key}.json`);
        const had = rows.get(key);
        if (
          had &&
          had.studioCommit === commit &&
          had.stateHash === stateHash(row) &&
          had.source === sourceHash(source, row) &&
          existsSync(picture) &&
          existsSync(dataFile) &&
          sha256(readFileSync(picture)) === had.png.sha256
        ) {
          kept++;
          continue;
        }
        if (!source) {
          problems.push({ key, said: ["the map names no place on the sheet for this state"] });
          continue;
        }
        let shot = null,
          failed = "";
        for (let attempt = 1; attempt <= TRIES && !shot; attempt++) {
          try {
            shot = await captureState(browser, server.base, row, source, look, commit);
          } catch (e) {
            failed = /** @type {Error} */ (e).message;
            if (!(e instanceof RequestLost)) break;
          }
        }
        if (!shot) {
          problems.push({ key, said: [failed] });
          process.stdout.write(`PROBLEM ${key}: ${failed}\n`);
          continue;
        }
        const text = await formatted(dataFile, `${JSON.stringify(shot.data)}\n`);
        if (PRIVATE.test(text)) {
          problems.push({ key, said: ["the data file would name a private path, a host or a real address"] });
          continue;
        }
        mkdirSync(dirname(picture), { recursive: true });
        mkdirSync(dirname(dataFile), { recursive: true });
        writeFileSync(picture, shot.png);
        writeFileSync(dataFile, text);
        const { width, height } = decode(shot.png);
        rows.set(key, {
          key,
          file: fileOf(key),
          png: { sha256: sha256(shot.png), w: width, h: height, scale: shot.data.variant.scale },
          scene: { sha256: sha256(text) },
          stateHash: stateHash(row),
          source: sourceHash(source, row),
          studioCommit: commit,
        });
        if (shot.said.length) problems.push({ key, said: shot.said });
        taken++;
        process.stdout.write(`TOOK ${key} ${width}x${height} nodes=${shot.data.nodes.length}\n`);
      }
    }
  } finally {
    await browser.close();
    await server.close();
    rmSync(work, { recursive: true, force: true });
  }

  /* A picture of a state that is no longer listed leaves with its data file. */
  const wanted = new Set(states.flatMap((/** @type {any} */ r) => looksOf(r).map((l) => referenceKey(r, l))));
  for (const key of [...rows.keys()])
    if (!wanted.has(key)) {
      rows.delete(key);
      rmSync(join(reference, `${key}.json`), { force: true });
    }
  const sorted = [...rows.values()].sort((x, y) => (x.key < y.key ? -1 : 1));
  let shard = manifest.shard ?? null;
  if (a.pack) {
    const revision = Number(a.revision ?? (shard ? shard.revision + 1 : 1));
    const stage = mkdtempSync(join(tmpdir(), "kit-pack-"));
    for (const r of sorted)
      writeFileSync(join(stage, `${r.file}.png`), readFileSync(join(out, entry, "pictures", `${r.key}.png`)));
    const file = `kit-${entry}-${commit.slice(0, 12)}.${revision}.tar.gz`;
    mkdirSync(join(out, "archive"), { recursive: true });
    /* Sorted names, no owner, one fixed time: the same pictures pack to the same bytes. */
    const names = readdirSync(stage).sort();
    const tar = spawnSync(
      "tar",
      [
        "--sort=name",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--mtime=@0",
        "-C",
        stage,
        "-cf",
        "-",
        ...names,
      ],
      { maxBuffer: 1024 * 1024 * 1024 },
    );
    const gz = spawnSync("gzip", ["-n", "-9"], { input: tar.stdout, maxBuffer: 1024 * 1024 * 1024 });
    if (tar.status !== 0 || gz.status !== 0)
      throw new Error("capture-sheet: the archive could not be packed");
    writeFileSync(join(out, "archive", file), gz.stdout);
    rmSync(stage, { recursive: true, force: true });
    shard = {
      id: `kit-${entry}`,
      file,
      revision,
      sha256: sha256(gz.stdout),
      bytes: gz.stdout.length,
      urls: [],
    };
  }
  writeFileSync(
    manifestFile,
    await formatted(
      manifestFile,
      `{\n"shard": ${JSON.stringify(shard)},\n"rows": [\n${sorted.map((r) => JSON.stringify(r)).join(",\n")}\n]\n}\n`,
    ),
  );
  mkdirSync(join(out, entry), { recursive: true });
  writeFileSync(join(out, entry, "problems.json"), `${JSON.stringify(problems, null, 1)}\n`);
  process.stdout.write(
    `CAPTURE entry=${entry} commit=${commit} taken=${taken} kept=${kept} pictures=${sorted.length} problems=${problems.length}${shard ? ` shard=${shard.file}` : ""}\n`,
  );
  process.exit(problems.some((p) => !rows.has(p.key)) ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    process.stderr.write(`capture-sheet: ${e.stack ?? e}\n`);
    process.exit(1);
  });
}
