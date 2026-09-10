#!/usr/bin/env node
/**
 * verify-desktop-launch.mjs — start the packaged app and prove its window RENDERED.
 *
 * Every job that builds this app is a build or a static read, so a panic that only exists at
 * runtime is invisible until a release is in people's hands. 0.9.7 aborted on every platform on
 * every launch and shipped past a green five-job matrix; 0.13.7 opened its window and threw on the
 * FIRST RENDER, which no liveness check can tell from a working app.
 *
 * So "alive" is not the question. The verdict is a captured frame with content in it:
 *
 *   1 · a window exists with real geometry — a WebView that cannot initialise leaves one 1×1
 *   2 · the frame is RENDERED — a band across it carries edges, on many rows
 *
 * Both, because either alone passes the failure the other exists to catch: a correctly sized
 * window can be blank, and a rendered frame belongs to some window.
 *
 * DISPLAY comes from the caller, which is what makes this runnable outside CI. The capture is
 * `xwd -root`: an app-window capture is black here, because the compositor draws elsewhere.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/* ── THE CLI IS BEHIND A MAIN CHECK, so `frameVerdict` can be imported ─────────────────────────
 * The verdict is the part worth guarding, and a guard cannot import a module whose top level
 * parses argv and calls `process.exit`. Run as a script it behaves exactly as before; imported,
 * only the exports run. */
const RUN_AS_SCRIPT = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

const args = process.argv.slice(2);
const appPath = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
if (RUN_AS_SCRIPT && (!appPath || args.includes("--help"))) {
  process.stderr.write(
    "usage: verify-desktop-launch.mjs <app> [--home <dir>] [--timeout <s>] [--out <dir>]\n" +
    "       [--frame <file.xwd>]   verdict on an existing capture, no launch\n" +
    "DISPLAY must name a running X server.\n");
  process.exit(2);
}

/* ── THE xwd READER ────────────────────────────────────────────────────────────────────────────
 * A 32-bit header of big-endian words, then the window name, then — only if `ncolors` is
 * non-zero — that many 12-byte colormap entries, then the pixels. The channel positions come
 * from the red/green/blue MASKS in the header rather than being assumed: a reader that assumed
 * them shifted every pixel and a whole measurement was made against the wrong offsets.
 *
 * The word indices are written down because two of them were read one slot late, and the
 * symptom was "no frame could be captured" — a sentence about the capture, for a defect in the
 * reader. 11 bits_per_pixel · 12 bytes_per_line · 13 visual_class · 14-16 the masks · 19 ncolors.
 * The arithmetic that settles it: header 107 + 256x12 colormap + 1400x900x4 == the file size. */
function readXwd(file) {
  const buf = readFileSync(file);
  const w = (i) => buf.readUInt32BE(i * 4);
  const headerSize = w(0);
  const pixmapWidth = w(4);
  const pixmapHeight = w(5);
  const bitsPerPixel = w(11);
  const bytesPerLine = w(12);
  const redMask = w(14);
  const greenMask = w(15);
  const blueMask = w(16);
  const ncolors = w(19);
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    throw new Error(`xwd: ${bitsPerPixel} bits per pixel is not a shape this reads`);
  }
  const pixels = headerSize + ncolors * 12;
  const shiftOf = (mask) => { let s = 0; while (s < 32 && !((mask >>> s) & 1)) s++; return s; };
  const chan = {
    r: shiftOf(redMask) >>> 3,
    g: shiftOf(greenMask) >>> 3,
    b: shiftOf(blueMask) >>> 3,
  };
  const stride = bitsPerPixel >>> 3;
  return {
    width: pixmapWidth,
    height: pixmapHeight,
    pixel(x, y) {
      const at = pixels + y * bytesPerLine + x * stride;
      return [buf[at + chan.r], buf[at + chan.g], buf[at + chan.b]];
    },
  };
}

/* ── THE VERDICT: EDGES, NOT COLOUR COUNTS ────────────────────────────────────────────────────
 * A band across the middle, because a first-run screen puts its text and its control there while
 * the top and bottom can legitimately be one flat colour.
 *
 * The measure is HORIZONTAL TRANSITIONS — adjacent pixels along a row differing by more than a
 * threshold — spread over many rows. Two weaker measures were tried and both are wrong:
 *
 *   · distinct colours counts ANTIALIASING. A real capture of this app reads 408 colours, but
 *     text drawn without smoothing is two, so the floor would refuse a rendered window.
 *   · the share of pixels differing from the dominant colour is 87% for a smooth VERTICAL
 *     gradient, which is a window that painted its background and rendered nothing — the exact
 *     0.13.7 shape this check exists to catch.
 *
 * Edges separate all four cases: a flat fill has none, a gradient in either direction has none
 * (its per-pixel steps are below the threshold, and a vertical one varies down the frame rather
 * than across it), and content — text, a control, a border — has many, on many rows.
 */
export function frameVerdict(img, { minEdgeRows = 8, minEdges = 200, delta = 24 } = {}) {
  const y0 = Math.floor(img.height * 0.25);
  const y1 = Math.floor(img.height * 0.75);
  let edges = 0;
  let edgeRows = 0;
  let rows = 0;
  let sampled = 0;
  const colours = new Set();
  for (let y = y0; y < y1; y += 2) {
    rows++;
    let onThisRow = 0;
    let prev = img.pixel(0, y);
    for (let x = 1; x < img.width; x++) {
      const px = img.pixel(x, y);
      sampled++;
      if (colours.size < 4096) colours.add((px[0] << 16) | (px[1] << 8) | px[2]);
      const d = Math.max(Math.abs(px[0] - prev[0]), Math.abs(px[1] - prev[1]), Math.abs(px[2] - prev[2]));
      if (d > delta) onThisRow++;
      prev = px;
    }
    edges += onThisRow;
    if (onThisRow >= 4) edgeRows++;
  }
  const rendered = edgeRows >= Math.max(minEdgeRows, Math.floor(rows * 0.1)) && edges >= minEdges;
  return {
    rendered,
    edges,
    edgeRows,
    rows,
    colours: colours.size,
    sampled,
    why: rendered
      ? `content on ${edgeRows} of ${rows} sampled rows (${edges} edges)`
      : edges === 0
        ? "the band has no edges at all — a window that opened and rendered nothing"
        : `only ${edgeRows} of ${rows} sampled rows carry content (${edges} edges) — a ground with nothing on it`,
  };
}

if (RUN_AS_SCRIPT) {
  function capture(out) {
    execFileSync("xwd", ["-root", "-silent", "-out", out], { stdio: ["ignore", "ignore", "inherit"] });
    return readXwd(out);
  }

  /* A verdict on a capture somebody else made — how the blank-frame arm is exercised without
   * needing an app that crashes on its first render. */
  const frameOnly = opt("frame", null);
  if (frameOnly) {
    const v = frameVerdict(readXwd(frameOnly));
    process.stdout.write(`frame ${frameOnly}: ${v.rendered ? "RENDERED" : "NOT RENDERED"} — ${v.why}\n`);
    process.exit(v.rendered ? 0 : 1);
  }

  if (!process.env.DISPLAY) {
    process.stderr.write("DISPLAY is not set — start an X server and point this at it.\n");
    process.exit(2);
  }
  const outDir = opt("out", join(process.cwd(), "launch-check"));
  mkdirSync(outDir, { recursive: true });
  const home = opt("home", null);
  const timeoutS = Number(opt("timeout", "90"));

  /* A FRESH HOME, and the app needs XDG_DATA_DIRS of its own: without it the process starts,
   * spawns its WebView, writes its data directory and leaves every window 1×1 — which looks
   * exactly like a broken build. Never `env -i`, and never `dbus-run-session`: GTK's own init
   * fails under it and the app exits 134. */
  const env = {
    ...process.env,
    HOME: home ?? join(outDir, "home"),
    XDG_DATA_DIRS: process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? join(outDir, "run"),
  };
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });

  const log = join(outDir, "app.log");
  const child = spawn(appPath, args.slice(1).filter((a) => !a.startsWith("--") && a !== appPath), {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.on("data", (d) => { text += d; });
  child.stderr.on("data", (d) => { text += d; });

  const deadline = Date.now() + timeoutS * 1000;
  let verdict = null;
  let geometry = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* The window list off the root, so a 1×1 window is a named failure rather than a blank frame
   * with no explanation. `xwininfo` is in the same package as `xwd`. */
  function windows() {
    try {
      const out = execFileSync("xwininfo", ["-root", "-children"], { encoding: "utf8", env });
      return [...out.matchAll(/^\s+0x[0-9a-f]+ .*?(\d+)x(\d+)\+/gm)]
        .map((m) => ({ w: Number(m[1]), h: Number(m[2]) }));
    } catch {
      return null;
    }
  }

  /* POLLED, because a window appears before it paints and a first render can take seconds on a
   * cold runner. The loop stops at the first RENDERED frame; a 1×1 window or a blank one keeps it
   * waiting until the deadline, which is what makes the timeout a real failure rather than a
   * flake. Every capture is kept: a red that cannot be looked at is half a diagnosis. */
  let shots = 0;
  let captureError = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (child.exitCode !== null) break;
    const wins = windows();
    if (wins && wins.length) geometry = wins;
    const shot = join(outDir, `frame-${String(++shots).padStart(2, "0")}.xwd`);
    let img;
    try {
      img = capture(shot);
    } catch (e) {
      // Instrumented rather than skipped: a reader that throws and an app that painted nothing
      // are the same silence otherwise, and the first is a defect in this file.
      captureError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      continue;
    }
    verdict = frameVerdict(img);
    process.stdout.write(
      `  ${new Date().toISOString().slice(11, 19)}  ` +
      `windows ${wins ? wins.map((w) => `${w.w}x${w.h}`).join(",") : "unreadable"}  ` +
      `edges ${verdict.edges} on ${verdict.edgeRows}/${verdict.rows} rows\n`);
    if (verdict.rendered) break;
  }

  writeFileSync(log, text);
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch { /* already gone */ }

  const big = (geometry ?? []).filter((w) => w.w > 1 && w.h > 1);
  const fail = [];
  if (child.exitCode !== null && child.exitCode !== 0) {
    fail.push(`the app exited with ${child.exitCode} before a frame was rendered`);
  }
  if (!big.length) {
    fail.push(
      geometry?.length
        ? `every window is 1×1 (${geometry.map((w) => `${w.w}x${w.h}`).join(", ")}) — the WebView did not initialise`
        : "no window ever appeared on the display");
  }
  if (!verdict?.rendered) {
    fail.push(verdict ? verdict.why
      : `no frame could be read${captureError ? ` — every capture failed with ${captureError}` : ""}`);
  }

  process.stdout.write(`\nlaunch check · ${appPath}\n  captures ${shots} in ${outDir}\n  log ${log}\n`);
  if (fail.length) {
    process.stderr.write(`\nthe packaged app did not render:\n${fail.map((f) => `  · ${f}`).join("\n")}\n`);
    if (text.trim()) process.stderr.write(`\n--- the app's own output (last 40 lines) ---\n${text.trim().split("\n").slice(-40).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `  windows ${big.map((w) => `${w.w}x${w.h}`).join(", ")}\n` +
    `  the window rendered: ${verdict.why}, ${verdict.colours} distinct colours\n`);
}
