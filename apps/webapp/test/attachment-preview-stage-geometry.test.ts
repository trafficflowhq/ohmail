import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * THE PREVIEW STAGE IN A REAL ENGINE — what jsdom cannot show: where a preview sits in the stage.
 * A page, picture or text taller than the stage starts at its top and scrolls to its end; one that
 * fits stays centred. A flex box that centres content taller than its scroll box pushes the top out
 * above it, where no scroll reaches: a one-page invoice whose text sits 15% down the page then previewed
 * blank. The markup is the stage AttachmentPreview renders (stage > content > the kind's shape), with
 * the real stylesheets, in a 1440x900 window. Chromium and WebKit (the desktop window is WebKitGTK).
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

const svg = (w: number, h: number) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#888"/></svg>`)}`;

/** The inner shape of each preview kind, as `renderContent` returns it. */
const SHAPES = {
  tallPdf: `<div class="ap-pdf"><canvas class="ap-canvas" width="900" height="1273" style="width:900px;height:1273px"></canvas></div>`,
  smallPdf: `<div class="ap-pdf"><canvas class="ap-canvas" width="300" height="200" style="width:300px;height:200px"></canvas></div>`,
  tallImg: `<img class="ap-img" width="600" height="2400" src="${svg(600, 2400)}" alt="">`,
  smallImg: `<img class="ap-img" width="240" height="160" src="${svg(240, 160)}" alt="">`,
  longText: `<pre class="ap-text">${Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n")}</pre>`,
  card: `<div class="ap-card" role="status"><b>No preview</b><span class="ap-card-detail">Download it instead.</span></div>`,
} as const;
type Shape = keyof typeof SHAPES;

interface Geometry {
  stageTop: number; stageBottom: number; stageLeft: number; stageRight: number;
  clientHeight: number; scrollHeight: number;
  topAt0: number; bottomAtEnd: number; height: number; centreY: number; centreX: number;
}

const ENGINES = [["chromium", pw.chromium], ["webkit", pw.webkit]] as const;
for (const [name, engine] of ENGINES) {
  describe.runIf(existsSync(engine.executablePath()))(`${name}: the preview stage keeps every preview's top in reach`, () => {
    let browser: Browser | null = null;
    beforeAll(async () => { browser = await engine.launch(); }, 120_000);
    afterAll(async () => { await browser?.close(); });

    async function measure(shape: Shape): Promise<Geometry> {
      const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
      try {
        const page = await context.newPage();
        await page.setContent(
          `<!doctype html><meta charset="utf-8"><style>${SHEETS}</style><body style="margin:0">
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
          return {
            stageTop: s.top, stageBottom: s.bottom, stageLeft: s.left, stageRight: s.right,
            clientHeight: stage.clientHeight, scrollHeight: stage.scrollHeight,
            topAt0: at0.top, bottomAtEnd: atEnd.bottom, height: at0.height,
            centreY: at0.top + at0.height / 2, centreX: at0.left + at0.width / 2,
          };
        });
      } finally {
        await context.close();
      }
    }

    for (const shape of ["tallPdf", "tallImg", "longText"] as const)
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
      }, 60_000);
  });
}
