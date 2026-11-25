import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitUserValue } from "@ohmail/app-logic/lists/column-store";

/** The startup status and columns are measured in the browser across the switch from quiet to shaped. */
const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const ROOT = process.cwd();

type Box = { l: number; r: number; t: number; b: number };
type Paint = { backgroundColor: string; boxShadow: string; padding: string };
type Columns = { rail: Box | null; list: Box | null; reader: Box | null; paint: Paint | null };
type SheetFrame = { list: Box | null; reader: Box | null; background: string | null; opacity: number; readerOpacity: number };
type Frame = Columns & { t: number; line: Box | null; shaped: boolean; railInset: number };
type Rig = {
  shell: () => Columns;
  boot: (ms: number) => Promise<Frame[]>;
  handoff: () => Promise<{ opening: SheetFrame; frames: SheetFrame[] }>;
};

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
interface Case { face: Face; scheme: Scheme; width: number; height: number; rail?: number; list?: boolean; zero?: boolean }

/** One window: the face and scheme stamped as `boot-stamp.ts` stamps them, a dragged rail width as
 *  `stampColumns` writes it, the Zero layout as the stamp writes it, the stylesheets in the head (render-blocking, as in the window). */
async function open(c: Case) {
  const ctx = await browser!.newContext({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const attrs = `${c.face === "ohmarchy" ? ' data-face="ohmarchy"' : ""} data-theme="${c.scheme}"${c.zero ? ' data-layout="zero"' : ""}`;
  const rail = ` style="${c.rail === undefined ? "" : `--rail-w: ${c.rail}px;`}${c.list ? `--split-user: ${splitUserValue(520)};` : ""}"`;
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
      CASES.push({ face, scheme, width, height, rail: 200, list: true });
    }
    CASES.push({ face, scheme, width: 1040, height: 700 });
    CASES.push({ face, scheme, width: 900, height: 700, zero: true });
    CASES.push({ face, scheme, width: 600, height: 700, zero: true });
    CASES.push({ face, scheme, width: 390, height: 700 });
  }
}

describe("the desktop opens in the mail frame", () => {
  it.each(CASES.map((c) => [`${c.face} ${c.scheme} ${c.width}x${c.height}${c.rail ? " with saved widths" : ""}`, c] as const))(
    "%s: status stays inside its column and the layout matches the mailbox",
    async (_name, c) => {
      const w = await open(c);
      try {
        const steady = await w.page.evaluate(() => (window as unknown as { rig: Rig }).rig.shell());
        const frames = await w.page.evaluate(() => (window as unknown as { rig: Rig }).rig.boot(600));
        expect(frames.some((f) => !f.shaped), "no frame before the grace").toBe(true);
        const shaped = frames.filter((f) => f.shaped);
        expect(shaped.length, "no frame after the grace").toBeGreaterThan(0);
        const slot = c.width >= 840 && !c.zero ? "rail" : "list";
        if (c.zero) expect(steady.rail!.r - steady.rail!.l).toBe(52);
        if (c.width < 700) expect(steady.reader).toBeNull();
        if (c.width < 392) expect(steady.rail).toBeNull();
        for (const frame of frames) {
          expect(frame.line, "no opening status").not.toBeNull();
          expect(frame[slot], "no column for the status").not.toBeNull();
          expect(inside(frame.line!, frame[slot]!), `t=${frame.t.toFixed(0)}ms line ${fmt(frame.line)} outside ${fmt(frame[slot])}`).toBe(true);
          expect(Math.abs(frame.line!.b - (frame[slot]!.b - (slot === "rail" ? frame.railInset : 0)))).toBeLessThan(1);
        }
        if (c.face === "ohmarchy" && slot === "rail") {
          expect(steady.paint?.boxShadow).not.toBe("none");
          for (const frame of shaped) expect(frame.paint).toEqual(steady.paint);
          expect(shaped[0]!.rail).toEqual(steady.rail);
        }
        for (const column of ["rail", "list", "reader"] as const) {
          const first = shaped[0]![column];
          const live = steady[column];
          if (live === null) {
            expect(first).toBeNull();
          } else {
            expect(first).not.toBeNull();
            expect(Math.abs(first!.l - live.l) + Math.abs(first!.r - live.r), `${column}: opening ${fmt(first)} vs steady ${fmt(live)}`).toBeLessThan(1);
          }
        }
        await expect(w.page.locator(".boot-foot").textContent()).resolves.toBe("Opening your local mail store…");
      } finally {
        await w.close();
      }
    },
    30_000,
  );
});


it.each(["light", "dark"] as const)("keeps the mail sheet painted throughout the %s startup handoff", async (scheme) => {
  const w = await open({ face: "ohmarchy", scheme, width: 1440, height: 900 });
  try {
    const { opening, frames } = await w.page.evaluate(() => (window as unknown as { rig: Rig }).rig.handoff());
    expect(opening.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(frames.length).toBeGreaterThan(2);
    for (const frame of frames) expect(frame).toEqual(opening);
  } finally {
    await w.close();
  }
}, 30_000);
