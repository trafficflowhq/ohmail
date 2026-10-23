import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * THE BOOT LINE STAYS INSIDE THE RAIL IN EVERY FRAME OF THE LAUNCH.
 *
 * Reported on the Linux desktop (the ohmarchy look): for about half a second at start the card at
 * the foot of the rail that says the mailbox is opening stood past the rail's right edge, over the
 * gap and into the list. The card was placed by fixed numbers (`left: 32px; width: 196px`), the
 * paper look's 16px window gap and the default 224px rail restated, while the rail it stands in is
 * `clamp(200px, var(--rail-w, 224px), …)` at `var(--gap-edge)` (10px in the ohmarchy look). A rail
 * dragged to its 200px floor, or a window under ~1064px that clamps it there, left the card 18px
 * outside it. The card now takes its box from the rail's own track, in CSS, from the first frame.
 *
 * Measured in Chromium over the window's own stylesheets, with the real `BootSkeleton` (its real
 * grace) and `BootStatus`, one reading per animation frame from the mount: in every frame the card
 * lies inside the rail silhouette, or, in the frames before the silhouette's grace has elapsed,
 * inside the rail the shell then stands on. The steady shell's sync line is held to the same rail,
 * in both looks, light and dark.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const ROOT = process.cwd();

type Box = { l: number; r: number; t: number; b: number };
type Frame = { t: number; line: Box | null; rail: Box | null };
type Rig = { shell: () => { rail: Box | null; line: Box | null }; boot: (ms: number) => Promise<Frame[]> };

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let js = "";
let css = "";
const dirs: string[] = [];

beforeAll(async () => {
  const { build } = await import("esbuild");
  const out = mkdtempSync(join(tmpdir(), "ohmail-boot-frames-"));
  dirs.push(out);
  await build({
    entryPoints: [join(ROOT, "apps/desktop/test/rigs/boot-frames-entry.tsx")],
    bundle: true, format: "iife", platform: "browser", target: ["es2020"], jsx: "automatic",
    conditions: ["ohmail-source"],
    // One React, the root's, as `vitest.config.ts` resolves it: `apps/desktop` carries its own copy,
    // and the rig's components reach both (`one-react.test.tsx` holds the suite to the same rule).
    alias: { react: join(ROOT, "node_modules/react"), "react-dom": join(ROOT, "node_modules/react-dom") },
    outdir: out, loader: { ".css": "css", ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl", ".woff": "dataurl" },
    banner: { js: "window.process = window.process || { env: {} };" },
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning",
  });
  js = readFileSync(join(out, "boot-frames-entry.js"), "utf8");
  css = readFileSync(join(out, "boot-frames-entry.css"), "utf8");
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Face = "paper" | "ohmarchy";
type Scheme = "light" | "dark";
interface Case { face: Face; scheme: Scheme; width: number; height: number; rail?: number; zero?: boolean }

/** One window: the face and scheme stamped as `boot-stamp.ts` stamps them, a dragged rail width as
 *  `stampColumns` writes it, the Zero layout as the stamp writes it, the stylesheets in the head (render-blocking, as in the window). */
async function open(c: Case) {
  const ctx = await browser!.newContext({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const attrs = `${c.face === "ohmarchy" ? ' data-face="ohmarchy"' : ""} data-theme="${c.scheme}"${c.zero ? ' data-layout="zero"' : ""}`;
  const rail = c.rail === undefined ? "" : ` style="--rail-w: ${c.rail}px"`;
  await page.setContent(`<!doctype html><html${attrs}${rail}><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
    <body class="mo-canvas app-body"><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: js });
  return { page, close: () => ctx.close() };
}

const inside = (inner: Box, outer: Box): boolean => inner.l >= outer.l - 0.5 && inner.r <= outer.r + 0.5;
const fmt = (b: Box | null): string => (b ? `${b.l.toFixed(1)}..${b.r.toFixed(1)}` : "none");

const CASES: Case[] = [];
for (const face of ["ohmarchy", "paper"] as const) {
  for (const scheme of ["dark", "light"] as const) {
    for (const [width, height] of [[1100, 700], [1440, 900]] as const) {
      CASES.push({ face, scheme, width, height });
      // The rail dragged to its floor (`column-store.ts` RAIL.min).
      CASES.push({ face, scheme, width, height, rail: 200 });
    }
  }
  // A window narrow enough that the track clamps the rail to its floor with no drag at all.
  CASES.push({ face, scheme: "dark", width: 1040, height: 700 });
}

describe("the boot line at the foot of the rail, frame by frame", () => {
  it.each(CASES.map((c) => [`${c.face} ${c.scheme} ${c.width}x${c.height}${c.rail ? ` rail ${c.rail}px` : ""}`, c] as const))(
    "%s: inside the rail in every frame, and so is the steady sync line",
    async (_name, c) => {
      const w = await open(c);
      try {
        const steady = await w.page.evaluate(() => (window as unknown as { rig: Rig }).rig.shell());
        expect(steady.rail, "the shell drew no rail").not.toBeNull();
        expect(steady.line, "the shell drew no sync line").not.toBeNull();
        expect(inside(steady.line!, steady.rail!), `steady line ${fmt(steady.line)} outside rail ${fmt(steady.rail)}`).toBe(true);

        const frames = await w.page.evaluate(() => (window as unknown as { rig: Rig }).rig.boot(600));
        const withLine = frames.filter((f) => f.line !== null);
        // Both sides of the silhouette's grace were sampled: frames with the card alone, and with it.
        expect(withLine.some((f) => f.rail === null), "no frame before the silhouette's grace").toBe(true);
        expect(withLine.some((f) => f.rail !== null), "no frame after the silhouette's grace").toBe(true);
        const outside = withLine
          .map((f) => ({ f, rail: f.rail ?? steady.rail! }))
          .filter(({ f, rail }) => !inside(f.line!, rail))
          .map(({ f, rail }) => `t=${f.t.toFixed(0)}ms line ${fmt(f.line)} rail ${fmt(rail)}`);
        expect(outside, `${outside.length} of ${withLine.length} frames painted the boot line outside the rail`).toEqual([]);
        // …and the silhouette's rail is the shell's: the card is placed against the rail it hands over to.
        const sk = withLine.find((f) => f.rail !== null)!.rail!;
        expect(Math.abs(sk.l - steady.rail!.l) + Math.abs(sk.r - steady.rail!.r)).toBeLessThan(1);
      } finally {
        await w.close();
      }
    },
    30_000,
  );
});

/* THE ZERO LAYOUT'S RIBBON TIER (392-1023px): the rail is a 52px ribbon of keys, in the silhouette
   and in the shell, and it carries no sentence. A 196px card at the rail's foot covered the ribbon
   and ran 160px on into the tile; it stands at the foot of the tile instead, clear of the ribbon. */
const RIBBON: Case[] = [];
for (const face of ["ohmarchy", "paper"] as const) {
  for (const scheme of ["dark", "light"] as const) {
    for (const [width, height] of [[900, 700], [600, 700]] as const) RIBBON.push({ face, scheme, width, height, zero: true });
  }
}

describe("the boot line beside the Zero layout's ribbon, frame by frame", () => {
  it.each(RIBBON.map((c) => [`${c.face} ${c.scheme} ${c.width}x${c.height}`, c] as const))(
    "%s: never over the ribbon, inside the window, in every frame",
    async (_name, c) => {
      const w = await open(c);
      try {
        const steady = await w.page.evaluate(() => (window as unknown as { rig: Rig }).rig.shell());
        expect(steady.rail, "the shell drew no ribbon").not.toBeNull();
        expect(steady.rail!.r - steady.rail!.l, "the shell's rail is not the ribbon").toBeLessThan(60);
        const frames = await w.page.evaluate(() => (window as unknown as { rig: Rig }).rig.boot(600));
        const withLine = frames.filter((f) => f.line !== null);
        expect(withLine.some((f) => f.rail !== null), "no frame after the silhouette's grace").toBe(true);
        const bad = withLine
          .map((f) => ({ f, rib: f.rail ?? steady.rail! }))
          .filter(({ f, rib }) => f.line!.l < Math.max(rib.r, steady.rail!.r) - 0.5 || f.line!.r > c.width + 0.5)
          .map(({ f, rib }) => `t=${f.t.toFixed(0)}ms line ${fmt(f.line)} ribbon ${fmt(rib)}`);
        expect(bad, `${bad.length} of ${withLine.length} frames painted the boot line over the ribbon`).toEqual([]);
      } finally {
        await w.close();
      }
    },
    30_000,
  );
});
