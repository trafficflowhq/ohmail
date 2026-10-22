import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * THE THREAD-READ RULE IN A REAL ENGINE — what jsdom cannot show: a frame's height, image loads and
 * the frame order of observers. Page: `thread-read-browser/entry.tsx` (the real adapter, rule and
 * `MessageBody`), on a routed origin, so nothing leaves the machine. Chromium and WebKit.
 *
 * A DESIGNED LETTER IS READ BY ITS TOP (owner ruling 2026-10-23): the frame stands at its 150px
 * default until its document loads and is measured, and the panel is ready only then; once its
 * sender line and the frame's top have been on screen for the 0.7 s dwell it is read, exactly once,
 * its end some 8000px below never shown. Nothing is read before the frame measured, and a top the
 * person scrolled away from before the dwell is not read until it is back on screen for it. The
 * pictures are served late, as the proxy does.
 *
 * A BODY LANDING ABOVE THE OPENED PANEL READS NOTHING NOBODY SAW: the anchor's re-scroll keeps the
 * panel above off screen, and it is never read. Control: with no anchor the panel pushed into view
 * stays there, and once its top was there for the dwell it is read.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const pw = require_("@playwright/test") as typeof import("@playwright/test");
type Browser = Awaited<ReturnType<typeof pw.chromium.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
const ROOT = process.cwd();
const ORIGIN = "https://app.ohmail.test";
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/ui/src/base.css",
  "packages/ui/src/composites/message.css",
  "apps/webapp/app/app.css",
  "apps/webapp/app/components/message-body.css",
].map((p) => readFileSync(join(ROOT, p), "utf8")).join("\n");

function chunk(tag: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(tag, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([head, body, crc]);
}
/** A small grey PNG, the proxied picture. */
function png(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const raw = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, 128, 128, 128, 128, 128, 128, 128, 128])));
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG = png();

let bundle = "";
const dirs: string[] = [];
beforeAll(async () => {
  const { build } = await import("esbuild");
  const out = mkdtempSync(join(tmpdir(), "ohmail-thread-read-"));
  dirs.push(out);
  await build({
    entryPoints: [join(ROOT, "apps/webapp/test/thread-read-browser/entry.tsx")],
    bundle: true, format: "iife", platform: "browser", target: ["es2020"], jsx: "automatic", outdir: out,
    alias: { "next-intl": join(ROOT, "apps/webapp/test/editor-feel/intl-shim.mjs") },
    loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".woff2": "empty", ".json": "json" },
    banner: { js: "window.process = window.process || { env: {} };" },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": "undefined" },
    logLevel: "warning",
  });
  bundle = readFileSync(join(out, "entry.js"), "utf8");
}, 120_000);
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function open(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1024, height: 1000 } });
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/rig.js") return route.fulfill({ contentType: "application/javascript", body: bundle });
    if (path === "/api/img") {
      await new Promise((r) => setTimeout(r, 400)); // the proxy's picture, late
      return route.fulfill({ contentType: "image/png", body: PNG });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><style>${SHEETS}</style><body style="margin:0"></body><script src="/rig.js"></script>`,
    });
  });
  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForFunction(() => typeof (window as unknown as { rig?: unknown }).rig === "object");
  return page;
}

interface Framed {
  framed: boolean; frameHeight: number; measuredAt: number; atMeasure: string[][]; tallAt: number; atTall: string[][];
  whileAway: string[][]; awayTop: number; reads: string[][]; at: number[]; endInView: boolean;
}
interface Landing { before: string[][]; reads: string[][]; aInView: boolean }

const ENGINES = [["chromium", pw.chromium], ["webkit", pw.webkit]] as const;
for (const [name, engine] of ENGINES) {
  describe.runIf(existsSync(engine.executablePath()))(`${name}: the thread-read rule over a laid-out reader`, () => {
    let browser: Browser | null = null;
    beforeAll(async () => { browser = await engine.launch(); }, 120_000);
    afterAll(async () => { await browser?.close(); });

    for (const pictures of [0, 1])
      it(`a framed letter of ~8000px (${pictures} late picture${pictures === 1 ? "" : "s"}) is read by its top once measured and in view for the dwell, once, its end never shown`, async () => {
        const page = await open(browser!);
        try {
          for (let run = 0; run < 3; run++) {
            const r = await page.evaluate((p) => (window as unknown as { rig: { framed: (o: unknown) => Promise<Framed> } }).rig.framed(p), { rows: 18, pictures, away: false });
            expect(r.framed, "the letter was set as prose, not framed: the case is not exercised").toBe(true);
            expect(r.frameHeight, "the frame never measured").toBeGreaterThan(7000);
            expect(r.atMeasure, `run ${run}: read before its frame measured`).toEqual([]);
            expect(r.reads, `run ${run}: its top on screen for the dwell`).toEqual([["m1"]]);
            expect(r.at[0]! - r.measuredAt, `run ${run}: the read came before the dwell was done`).toBeGreaterThanOrEqual(690);
            expect(r.endInView, "its end was on screen: the case is not exercised").toBe(false);
          }
        } finally {
          await page.context().close();
        }
      }, 90_000);

    it("a letter whose top the person scrolled away from before the dwell is not read until its top is back for it", async () => {
      const page = await open(browser!);
      try {
        for (let run = 0; run < 3; run++) {
          const r = await page.evaluate((p) => (window as unknown as { rig: { framed: (o: unknown) => Promise<Framed> } }).rig.framed(p), { rows: 18, pictures: 0, away: true });
          expect(r.framed).toBe(true);
          expect(r.atTall, `run ${run}: read before the frame had its height (${r.tallAt - r.measuredAt}ms after it measured): the case is not exercised`).toEqual([]);
          expect(r.awayTop, "the person's scroll did not hold").toBeGreaterThan(2000);
          expect(r.whileAway, `run ${run}: read while its top was off screen`).toEqual([]);
          expect(r.reads, `run ${run}: the control, its top back on screen`).toEqual([["m1"]]);
        }
      } finally {
        await page.context().close();
      }
    }, 90_000);

    it("a body landing above the opened panel reads nothing the anchor kept off screen; with no anchor it reads what stays in view", async () => {
      const page = await open(browser!);
      try {
        for (let run = 0; run < 3; run++) {
          const held = await page.evaluate(() => (window as unknown as { rig: { landing: (o: unknown) => Promise<Landing> } }).rig.landing({ anchor: true }));
          expect(held.before, "nothing in view was readable before the landing").toEqual([]);
          expect(held.aInView, "the anchor did not hold the opened panel").toBe(false);
          expect(held.reads, `run ${run}: a message that was never on screen was read`).toEqual([]);
          const free = await page.evaluate(() => (window as unknown as { rig: { landing: (o: unknown) => Promise<Landing> } }).rig.landing({ anchor: false }));
          expect(free.aInView).toBe(true);
          expect(free.reads, `run ${run}: the control read nothing: the rig proves nothing`).toEqual([["a"]]);
        }
      } finally {
        await page.context().close();
      }
    }, 90_000);
  });
}
