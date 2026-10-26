import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * THE PREVIEW STAGE IN A REAL ENGINE — what jsdom cannot show: where a preview sits in the stage.
 * A page or text taller than the stage starts at its top and scrolls to its end; one that fits stays
 * centred. A picture never scrolls: a larger one is fitted whole into the stage (contain), a smaller one
 * keeps its own size. A flex box that centres content taller than its scroll box pushes the top out
 * above it, where no scroll reaches: a one-page invoice whose text sits 15% down the page then previewed
 * blank. The markup is the stage AttachmentPreview renders (stage > content > the kind's shape), with
 * the real stylesheets, in a 1440x900 window (and a phone's 390x844 for the pictures). Chromium and WebKit (the desktop window is WebKitGTK).
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const pw = require_("@playwright/test") as typeof import("@playwright/test");
type Browser = Awaited<ReturnType<typeof pw.chromium.launch>>;
const ROOT = process.cwd();
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/ui/src/base.css",
  "apps/webapp/app/components/attachment-preview.css",
].map((p) => readFileSync(join(ROOT, p), "utf8")).join("\n");

/** A grey PNG of the given size, made here: no real attachment in the test. */
function png(w: number, h: number): string {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([head, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; // 8-bit grey
  const rows = Buffer.alloc((w + 1) * h, 0x88);
  for (let y = 0; y < h; y++) rows[y * (w + 1)] = 0; // filter byte per row
  const file = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${file.toString("base64")}`;
}

/** The inner shape of each preview kind, as `renderContent` returns it. */
const SHAPES = {
  tallPdf: `<div class="ap-pdf"><canvas class="ap-canvas" width="900" height="1273" style="width:900px;height:1273px"></canvas></div>`,
  smallPdf: `<div class="ap-pdf"><canvas class="ap-canvas" width="300" height="200" style="width:300px;height:200px"></canvas></div>`,
  tallImg: `<img class="ap-img" src="${png(1200, 4000)}" alt="screenshot.png">`,
  wideImg: `<img class="ap-img" src="${png(4000, 600)}" alt="panorama.png">`,
  smallImg: `<img class="ap-img" src="${png(240, 160)}" alt="icon.png">`,
  longText: `<pre class="ap-text">${Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n")}</pre>`,
  card: `<div class="ap-card" role="status"><b>No preview</b><span class="ap-card-detail">Download it instead.</span></div>`,
} as const;
type Shape = keyof typeof SHAPES;

interface Geometry {
  stageTop: number; stageBottom: number; stageLeft: number; stageRight: number;
  clientHeight: number; scrollHeight: number; clientWidth: number; scrollWidth: number;
  topAt0: number; bottomAtEnd: number; height: number; width: number; centreY: number; centreX: number;
  naturalWidth: number; naturalHeight: number;
  footBottom: number; maxScrollTop: number;
}

const ENGINES = [["chromium", pw.chromium], ["webkit", pw.webkit]] as const;
for (const [name, engine] of ENGINES) {
  describe.runIf(existsSync(engine.executablePath()))(`${name}: the preview stage keeps every preview's top in reach`, () => {
    let browser: Browser | null = null;
    beforeAll(async () => { browser = await engine.launch(); }, 120_000);
    afterAll(async () => { await browser?.close(); });

    async function measure(shape: Shape, viewport = { width: 1440, height: 900 }, zoom = 1): Promise<Geometry> {
      const context = await browser!.newContext({ viewport });
      try {
        const page = await context.newPage();
        await page.setContent(
          // Web Text size above 100%: shell/text-size.ts stamps `zoom` and `--ui-zoom` on <html>.
          `<!doctype html><html${zoom === 1 ? "" : ` style="zoom:${zoom};--ui-zoom:${zoom}"`}><meta charset="utf-8"><style>${SHEETS}</style><body style="margin:0">
          <div class="ap-scrim"><div class="ap-panel">
            <header class="ap-head"><div class="ap-id"><span class="ap-name">invoice</span></div></header>
            <div class="ap-stage">
              <button type="button" class="ap-nav ap-prev">&lt;</button>
              <div class="ap-content">${SHAPES[shape]}</div>
              <button type="button" class="ap-nav ap-next">&gt;</button>
            </div>
            <footer class="ap-foot"><span>Esc closes</span></footer>
          </div></div></body>`,
          { waitUntil: "load" },
        );
        return await page.evaluate(async () => {
          await Promise.all(Array.from(document.images, (i) => i.decode().catch(() => undefined)));
          // Past the panel's rise animation, so the boxes stand where they rest.
          for (const a of document.getAnimations()) a.finish();
          const stage = document.querySelector(".ap-stage") as HTMLElement;
          const shown = document.querySelector(".ap-content")!.firstElementChild as HTMLElement;
          stage.scrollTop = 0;
          const s = stage.getBoundingClientRect();
          const at0 = shown.getBoundingClientRect();
          stage.scrollTop = stage.scrollHeight;
          const atEnd = shown.getBoundingClientRect();
          const maxScrollTop = stage.scrollTop;
          return {
            stageTop: s.top, stageBottom: s.bottom, stageLeft: s.left, stageRight: s.right,
            clientHeight: stage.clientHeight, scrollHeight: stage.scrollHeight,
            clientWidth: stage.clientWidth, scrollWidth: stage.scrollWidth,
            topAt0: at0.top, bottomAtEnd: atEnd.bottom, height: at0.height, width: at0.width,
            centreY: at0.top + at0.height / 2, centreX: at0.left + at0.width / 2,
            naturalWidth: (shown as HTMLImageElement).naturalWidth ?? 0,
            naturalHeight: (shown as HTMLImageElement).naturalHeight ?? 0,
            footBottom: document.querySelector(".ap-foot")!.getBoundingClientRect().bottom, maxScrollTop,
          };
        });
      } finally {
        await context.close();
      }
    }

    for (const shape of ["tallPdf", "longText"] as const)
      it(`${shape}: taller than the stage, its top is on screen at scrollTop 0 and its end at the bottom of the scroll`, async () => {
        const g = await measure(shape);
        expect(g.height, "the preview fits the stage: the case is not exercised").toBeGreaterThan(g.clientHeight);
        expect(g.topAt0, `the top sits ${Math.round(g.stageTop - g.topAt0)}px above the stage, out of scroll reach`).toBeGreaterThanOrEqual(g.stageTop - 0.5);
        expect(g.bottomAtEnd, "the end is out of scroll reach").toBeLessThanOrEqual(g.stageBottom + 0.5);
      }, 60_000);

    for (const shape of ["smallPdf", "smallImg", "card"] as const)
      it(`${shape}: smaller than the stage, it stays centred`, async () => {
        const g = await measure(shape);
        expect(g.scrollHeight, "a small preview made the stage scroll").toBe(g.clientHeight);
        expect(Math.abs(g.centreY - (g.stageTop + g.stageBottom) / 2)).toBeLessThanOrEqual(1);
        expect(Math.abs(g.centreX - (g.stageLeft + g.stageRight) / 2)).toBeLessThanOrEqual(1);
        if (shape === "smallImg") expect([g.width, g.height], "a small picture was scaled").toEqual([240, 160]);
      }, 60_000);

    const PICTURE_VIEWPORTS = [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const;
    for (const [where, viewport] of PICTURE_VIEWPORTS)
      for (const shape of ["tallImg", "wideImg"] as const)
        it(`${shape} (${where}): larger than the stage, it is fitted whole, uncropped and centred, and nothing scrolls`, async () => {
          const g = await measure(shape, viewport);
          expect(g.naturalHeight, "the picture did not decode").toBeGreaterThan(0);
          expect(g.scrollHeight, "the stage scrolls vertically").toBe(g.clientHeight);
          expect(g.scrollWidth, "the stage scrolls sideways").toBe(g.clientWidth);
          expect(g.topAt0).toBeGreaterThanOrEqual(g.stageTop - 0.5);
          expect(g.bottomAtEnd).toBeLessThanOrEqual(g.stageBottom + 0.5);
          // Contain: its own proportions, and as large as the stage allows on one side.
          expect(g.width / g.height).toBeCloseTo(g.naturalWidth / g.naturalHeight, 2);
          const fill = Math.max(g.height / (g.stageBottom - g.stageTop), g.width / (g.stageRight - g.stageLeft));
          expect(fill, "the picture is shrunk below the stage").toBeGreaterThan(0.85);
          expect(Math.abs(g.centreY - (g.stageTop + g.stageBottom) / 2)).toBeLessThanOrEqual(1);
          expect(Math.abs(g.centreX - (g.stageLeft + g.stageRight) / 2)).toBeLessThanOrEqual(1);
        }, 60_000);

    for (const [w, h] of [[1440, 900], [1024, 768], [1280, 720]] as const)
      it(`tallImg at Text size 125% in ${w}x${h}: the picture and the footer end inside the window`, async () => {
        const g = await measure("tallImg", { width: w, height: h }, 1.25);
        expect(g.naturalHeight, "the picture did not decode").toBeGreaterThan(0);
        // Rects read in window px under the html zoom (both engines).
        expect(g.topAt0 + g.height, "the picture runs off the bottom of the window").toBeLessThanOrEqual(h + 0.5);
        expect(g.footBottom, "the footer runs off the bottom of the window").toBeLessThanOrEqual(h + 0.5);
        // Not scrollHeight: WebKit rounds it a pixel past clientHeight at a fractional zoom with nothing to scroll.
        expect(g.maxScrollTop, "the stage scrolls vertically").toBe(0);
      }, 60_000);
  });
}
