import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a .mjs script with no declarations; the exports are what is under test.
import { frameVerdict, readXwd, readPpm, readFrame } from "../scripts/verify-desktop-launch.mjs";
import { publicPath } from "./support/public-root.mjs";

/**
 * "ALIVE" IS NOT THE QUESTION THE LAUNCH CHECK ASKS.
 *
 * 0.9.7 aborted on every platform on every launch and shipped past a green five-job matrix.
 * 0.13.7 opened its window and threw on the FIRST render — a process that is running, a window
 * with the right geometry, and nothing painted in it. So the verdict is a captured frame with
 * content, and this is the guard on the verdict: it has to say yes to a real frame and no to a
 * blank one, or the check is decoration that passes whatever the build did.
 *
 * The frames are synthesised rather than committed, because a captured screenshot of a mail
 * client is a picture of somebody's mail. The four shapes are the ones that separate: a flat
 * fill, a smooth gradient in each direction, and text-like content.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The `readXwd` return shape: width, height and a pixel reader. */
function image(width: number, height: number, at: (x: number, y: number) => [number, number, number]) {
  return { width, height, pixel: at };
}

const FLAT = image(1400, 900, () => [250, 250, 249]);
/* A window that painted its background and rendered nothing — the 0.13.7 shape. Down the frame,
 * so most of its pixels differ from the dominant colour: a verdict counting that would pass it. */
const GRADIENT_DOWN = image(1400, 900, (_x, y) => [180 + (y % 60), 180 + (y % 60), 190]);
/* And across it, in case a background is painted the other way. */
const GRADIENT_ACROSS = image(1400, 900, (x) => [180 + Math.floor(x / 24), 180, 190]);
/* Text WITHOUT antialiasing: exactly two colours, which is why a distinct-colour floor cannot be
 * the gate — a real capture of this app reads 408 colours and this reads 2. */
const TEXT = image(1400, 900, (x, y) =>
  (y % 24 < 9 && x % 7 < 2 && x > 120 && x < 700) ? [24, 24, 27] : [250, 250, 249]);

describe("the launch check's frame verdict", () => {
  it("refuses a window that opened and rendered nothing", () => {
    const v = frameVerdict(FLAT);
    expect(v.rendered).toBe(false);
    expect(v.edges).toBe(0);
    expect(v.why).toContain("rendered nothing");
  });

  it("refuses a ground with nothing on it, painted either way", () => {
    for (const [name, img] of [["down", GRADIENT_DOWN], ["across", GRADIENT_ACROSS]] as const) {
      const v = frameVerdict(img);
      expect(v.rendered, `${name}: ${v.edges} edges on ${v.edgeRows}/${v.rows} rows`).toBe(false);
    }
  });

  it("admits text with two colours in it", () => {
    // The positive control, and the case a colour-count floor got wrong: a verdict that refuses
    // every frame is the same failure as one that refuses none, and dearer — it would refuse
    // every correct release.
    const v = frameVerdict(TEXT);
    expect(v.rendered, `${v.edges} edges on ${v.edgeRows}/${v.rows} rows`).toBe(true);
    expect(v.colours).toBe(2);
  });

  it("wants content SPREAD over rows, not piled onto two of them", () => {
    /* Dense dashes on four consecutive rows — four, not two, because the band is sampled every
     * other row and a two-row fixture can miss the sampled parity entirely (it did, and read as
     * zero edges). Edges comfortably over the edge total, on a few rows of the frame.
     * This is the case that tells the two halves of the verdict apart — an earlier fixture here
     * was a solid black line, which has no horizontal transitions at all and so was refused by
     * the edge total, leaving the row-spread half unwatched and a mutation dropping it green. */
    const twoRows = image(1400, 900, (x, y) =>
      (y >= 449 && y <= 452 && x % 4 < 2) ? [0, 0, 0] : [250, 250, 249]);
    const v = frameVerdict(twoRows);
    expect(v.edges, "the fixture has to clear the edge total or it proves the wrong half")
      .toBeGreaterThanOrEqual(200);
    expect(v.edgeRows).toBeLessThan(8);
    expect(v.rendered).toBe(false);
  });

  it("samples the middle band, not the whole frame", () => {
    // A first-run screen can legitimately be flat at the very top and bottom.
    const topOnly = image(1400, 900, (x, y) =>
      (y < 200 && x % 7 < 2) ? [10, 10, 10] : [250, 250, 249]);
    expect(frameVerdict(topOnly).rendered).toBe(false);
    expect(frameVerdict(TEXT).rows).toBeLessThan(900);
  });
});

/**
 * AND THE READER UNDER THE VERDICT, ON REAL 24-BPP BYTES.
 *
 * The verdict above is only as good as the pixels handed to it, and the reader trusted its own
 * header: a capture cut short still describes rows that are not in the file, the reads past the
 * end are `undefined`, every comparison is NaN, no edges are counted — and the check reports the
 * APP as not rendering for a defect in this file. The two fixtures are 24-bpp because that is the
 * shape where the header and the stride can disagree: `padded-24bpp.xwd` is 7 pixels wide on a
 * 24-byte row (21 bytes of pixels, 3 of padding), `truncated-24bpp.xwd` is the same header with
 * two of its four rows missing. Both are 25 big-endian words then the 8-byte window name, ncolors
 * 0, masks 0x00FF0000 / 0x0000FF00 / 0x000000FF, pixel (x, y) = [10x, 20y, 200].
 */
describe("the launch check's xwd reader", () => {
  const fixture = (name: string) => `${HERE}fixtures/xwd/${name}.xwd`;

  it("reads a padded 24-bpp capture, stride and channels both right", () => {
    const img = readXwd(fixture("padded-24bpp"));
    expect([img.width, img.height]).toEqual([7, 4]);
    // The padding is the point: a reader stepping width x 3 per row instead of bytes_per_line
    // would read these two off the end of their rows.
    expect(img.pixel(3, 0)).toEqual([30, 0, 200]);
    expect(img.pixel(6, 3)).toEqual([60, 60, 200]);
  });

  it("refuses a truncated capture by name rather than reading undefined rows", () => {
    expect(() => readXwd(fixture("truncated-24bpp")))
      .toThrow(/describes 204 bytes and the file holds 156 — the capture is truncated/);
  });

  it("refuses a row too narrow for the pixels the header puts on it", () => {
    /* The other half of the same arithmetic, and the one no capture on disk shows: bytes_per_line
     * under width x stride means the rows overlap, and every pixel after the first row is somebody
     * else's. Built from the padded fixture by writing word 12, so the fixture stays the subject. */
    const buf = readFileSync(fixture("padded-24bpp"));
    buf.writeUInt32BE(20, 12 * 4);
    // Written where a fresh clone can write: `build/` does not exist until something builds.
    const narrow = join(mkdtempSync(join(tmpdir(), "xwd-")), "narrow-row.xwd");
    writeFileSync(narrow, buf);
    expect(() => readXwd(narrow)).toThrow(/20 bytes per line is short of 7 pixels at 3 bytes each/);
  });

  it("tells a capture it cannot read from a window that rendered nothing, by exit code", () => {
    /* rc 1 is the app's verdict and the step exits on it; a reader refusal wearing rc 1 is read
     * as a release that does not render. The truncated frame is rc 2, and says NOT READ. */
    const run = (frame: string) => spawnSync("node",
      [`${HERE}../scripts/verify-desktop-launch.mjs`, "--frame", frame], { encoding: "utf8" });
    const bad = run(fixture("truncated-24bpp"));
    expect(bad.status, `${bad.stdout}${bad.stderr}`).toBe(2);
    expect(`${bad.stdout}${bad.stderr}`).toContain("NOT READ");
    const flat = run(fixture("padded-24bpp"));
    expect(flat.status, "a readable capture still gets the verdict's own exit code").toBe(1);
    expect(`${flat.stdout}${flat.stderr}`).toContain("NOT RENDERED");
  });

  it("gives a binary PPM capture a VERDICT through --frame, both ways", () => {
    /* THE CALL SITE, not the reader. Both frames above are xwd, and `readFrame` falls through to
     * `readXwd` for those — so the flag reverted to `readXwd` leaves every case here green while
     * the Wayland route it was written for hands back a grim ppm the CLI cannot read at all. A
     * reader refusal there wears rc 2 NOT READ, which is not the app's verdict about anything.
     * Both directions, so the arm cannot pass on a route that refuses everything. */
    const dir = mkdtempSync(join(tmpdir(), "ohmail-launch-cli-ppm-"));
    const run = (frame: string) => spawnSync("node",
      [`${HERE}../scripts/verify-desktop-launch.mjs`, "--frame", frame], { encoding: "utf8" });
    const blank = join(dir, "blank.ppm");
    writeFileSync(blank, ppm(1400, 900, () => [250, 250, 249]));
    const b = run(blank);
    expect(b.status, `${b.stdout}${b.stderr}`).toBe(1);
    expect(`${b.stdout}${b.stderr}`).toContain("NOT RENDERED");
    const drawn = join(dir, "drawn.ppm");
    writeFileSync(drawn, ppm(1400, 900, (x, y) =>
      (y % 24 < 9 && x % 7 < 2 && x > 120 && x < 700) ? [24, 24, 27] : [250, 250, 249]));
    const d = run(drawn);
    expect(d.status, `${d.stdout}${d.stderr}`).toBe(0);
    expect(`${d.stdout}${d.stderr}`).toContain("RENDERED");
    rmSync(dir, { recursive: true, force: true });
  });
});

/** A frame, as `grim -t ppm -` writes one: a header and then w*h*3 bytes. */
function ppm(width: number, height: number, at: (x: number, y: number) => [number, number, number]): Buffer {
  const head = Buffer.from(`${"P"}6\n${width} ${height}\n255\n`, "ascii");
  const body = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = at(x, y);
      const o = (y * width + x) * 3;
      body[o] = r; body[o + 1] = g; body[o + 2] = b;
    }
  }
  return Buffer.concat([head, body]);
}

describe("the capture route the session decides", () => {
  const src = readFileSync(`${HERE}../scripts/verify-desktop-launch.mjs`, "utf8");

  it("reads a binary PPM frame in the same shape the xwd reader answers in", () => {
    /* THE ROW THIS EXISTS FOR, measured on the Omarchy guest 2026-09-17: `xwd -root` on its
     * Xwayland `:0` answers BadMatch on X_GetImage and writes a ZERO-byte file, because a
     * Wayland compositor's root is not a capturable X drawable. `grim` writes a full frame
     * with many distinct colours over the same desktop. So the Wayland route captures with
     * grim, and its frame has to reach the verdict unchanged. */
    const img = readPpm(ppm(40, 20, (x, y) => [x * 2, y * 3, 7]));
    expect(img.width).toBe(40);
    expect(img.height).toBe(20);
    expect(img.pixel(3, 4)).toEqual([6, 12, 7]);
  });

  it("gives a grim frame and an xwd frame the same verdict", () => {
    const content = (x: number, y: number): [number, number, number] =>
      (y % 24 < 9 && x % 7 < 2 && x > 120 && x < 700) ? [24, 24, 27] : [250, 250, 249];
    const viaPpm = frameVerdict(readPpm(ppm(1400, 900, content)));
    const viaShape = frameVerdict(image(1400, 900, content));
    expect(viaPpm.rendered).toBe(true);
    expect(viaPpm.edges).toBe(viaShape.edges);
    expect(viaPpm.edgeRows).toBe(viaShape.edgeRows);
  });

  it("refuses an empty grim frame, which is what a guest that rendered nothing hands back", () => {
    /* The guest's own control: the desktop frame read many distinct colours and a blank one 1.
     * The gate is EDGES rather than that count — unsmoothed text is two colours — so both are
     * asserted: no edges at all, and the one colour that says the frame carried nothing. */
    const v = frameVerdict(readPpm(ppm(1400, 900, () => [250, 250, 249])));
    expect(v.rendered).toBe(false);
    expect(v.edges).toBe(0);
    expect(v.colours).toBe(1);
  });

  it("reads a capture by what it IS, so one --frame flag serves both routes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-launch-frame-"));
    const f = join(dir, "frame-01.ppm");
    writeFileSync(f, ppm(24, 12, (x) => [x, 0, 0]));
    const img = readFrame(f);
    expect(img.width).toBe(24);
    expect(img.pixel(5, 2)).toEqual([5, 0, 0]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("asserts every tool the chosen route spawns BEFORE the app is launched", () => {
    /* A check that finds its tool missing afterwards has already spent the launch, and a missing
     * tool read as "the app does not render" is the shape the build workflow's own guard exists
     * for. The assertion is `command -v`, and the refusal names what is absent. */
    expect(src).toContain('execFileSync("sh", ["-c", `command -v ${t}`]');
    expect(src).toContain("LAUNCH-TOOLS-MISSING");
    const at = (needle: string) => src.indexOf(needle);
    expect(at("LAUNCH-TOOLS-MISSING"), "the tool assertion is gone").toBeGreaterThan(-1);
    expect(at("LAUNCH-TOOLS-MISSING")).toBeLessThan(at("const child = spawn(appPath"));
  });

  it("chooses the route from the session and prints it, rather than assuming an X server", () => {
    expect(src).toContain('process.env.XDG_SESSION_TYPE === "wayland"');
    expect(src).toContain('execFileSync("grim", ["-t", "ppm", "-"]');
    expect(src).toContain("capture route: ${route} (${routeWhy})");
    /* And a DISPLAY is required only where a capture needs one. */
    expect(src).toContain('if (route === "xwd" && !process.env.DISPLAY)');
  });

  it("says the geometry half DID NOT RUN rather than calling it an absent window", () => {
    /* Wayland has no root to enumerate. Treating that as "no window ever appeared" would refuse
     * every rendered app on such a guest; treating it as a pass would be the silence this whole
     * check exists to end. */
    expect(src).toContain("the geometry half DID NOT RUN");
    expect(src).toContain('execFileSync("hyprctl", ["-j", "clients"]');
    expect(src).toContain("NOT RUN: ");
  });
});

describe("the workflow calls it on the artifact it just built", () => {
  const wf = readFileSync(publicPath("github/workflows/build.yml"), "utf8");

  it("launches both Linux artifacts under a display of its own", () => {
    for (const app of ["build/ohmail-linux-x86_64.AppImage", "build/ohmail-linux-aarch64.AppImage"]) {
      expect(wf).toContain(`node scripts/verify-desktop-launch.mjs ${app}`);
    }
    // Two jobs, so two of everything.
    expect(wf.split("verify-desktop-launch.mjs").length - 1).toBe(2);
    expect(wf.split("xvfb x11-utils x11-apps").length - 1).toBe(2);
  });

  it("installs the tool it captures frames with, and says so before it starts anything", () => {
    /* `xwd` takes the frame and ships in x11-apps; x11-utils carries only `xwininfo`. With the
     * package absent every capture failed `spawnSync xwd ENOENT` and the check reported the APP
     * as not rendering — a missing tool wearing a product verdict's clothes. Both halves are
     * asserted: the package is installed, and each job refuses BY NAME before Xvfb starts, so
     * the next tool that goes missing cannot be read as a render failure either. */
    /* Counted through the apt list's own line, not a bare "x11-apps": the comment above the
     * assertion names the package too, and a loose count of it is a pin that moves when
     * somebody explains the fix. */
    expect(wf.split("xvfb x11-utils x11-apps").length - 1).toBe(2);
    const lines = wf.split("\n");
    const guards = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes("for t in xwd xwininfo; do"));
    expect(guards, "no tool assertion in the launch-check steps").toHaveLength(2);
    for (const { i } of guards) {
      const after = lines.slice(i, i + 4).join("\n");
      expect(after, `the tool assertion at line ${i + 1} does not name the missing tool`)
        .toMatch(/command -v "\$t".*is not installed/s);
      /* ORDER, not proximity: the assertion has to come before the display starts, and a fixed
       * window of lines is a pin that moves when somebody adds a step between the two — it did,
       * and the guard reddened for a workflow whose order was never wrong. Read the next start
       * after this guard instead; a guard moved below the last one has none and still reds. */
      const startsAfter = lines.findIndex((l, j) => j > i && /Xvfb :99/.test(l));
      expect(startsAfter, `Xvfb starts before the tools are asserted at line ${i + 1}`)
        .toBeGreaterThan(i);
    }
  });

  it("reports the check's own status rather than the shell's", () => {
    /* Under `set -e` a red check exits the step before its status is read, so each call sits
     * between a `set +e` and a `RC=$?`. Asserted as that ORDER rather than as one line: pinning
     * the exact spelling made this red the moment an environment variable joined the command,
     * which is a guard measuring its own regex. */
    const lines = wf.split("\n");
    const calls = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes("verify-desktop-launch.mjs"));
    expect(calls, "no call to the launch check in the workflow").toHaveLength(2);
    for (const { i } of calls) {
      const before = lines.slice(Math.max(0, i - 12), i).join("\n");
      const after = lines.slice(i, i + 12).join("\n");
      expect(before, `no 'set +e' above the call at line ${i + 1}`).toMatch(/^\s*set \+e$/m);
      expect(after, `no 'RC=$?' below the call at line ${i + 1}`).toMatch(/^\s*RC=\$\?$/m);
      expect(after, `no 'set -e' restored below the call at line ${i + 1}`).toMatch(/^\s*set -e$/m);
    }
    expect(wf).toContain('exit "$RC"');
    // FUSE is not assumed: an AppImage self-mounts through it and a runner image without libfuse2
    // could not start the artifact at all, which would refuse every correct release. THREE, not
    // two: the perf smoke in the x86_64 job starts the same artifact a third time and needs the
    // same extraction — `test/perf-smoke-check.test.ts` holds the other half of this count.
    expect(wf.split("APPIMAGE_EXTRACT_AND_RUN=1").length - 1).toBe(3);
  });
});
