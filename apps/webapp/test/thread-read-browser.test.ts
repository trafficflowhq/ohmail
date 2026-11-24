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
  "packages/ui/src/composites/stream.css",
  "packages/ui/src/mail/Reading/message.css",
  "apps/webapp/app/app.css",
  "packages/letter-body/src/message-body.css",
  "packages/letter-body/src/message-body-sheet.css",
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

/** The proxy's requests: how many were asked (each url how often), and the most at once; a `held` url is answered on `release`. */
interface Proxied { asked: number; now: number; most: number; urls?: Map<string, number>; release?: Promise<void> }
async function open(browser: Browser, proxied: Proxied = { asked: 0, now: 0, most: 0 }, lateMs = 400): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1024, height: 1000 } });
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/rig.js") return route.fulfill({ contentType: "application/javascript", body: bundle });
    if (path === "/api/img") {
      const u = new URL(route.request().url()).searchParams.get("u") ?? "";
      const held = u.includes("-held");
      if (!held) proxied.asked += 1;
      proxied.urls?.set(u, (proxied.urls.get(u) ?? 0) + 1);
      proxied.most = Math.max(proxied.most, ++proxied.now);
      if (held) await proxied.release;
      else await new Promise((r) => setTimeout(r, lateMs)); // the proxy's picture, late
      proxied.now -= 1;
      // A refusal, as `/img` answers an SVG (415) or an upstream failure: no cache lifetime.
      if (u.includes("-refused")) return route.fulfill({ status: 415, contentType: "application/json", body: "{}" });
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

/** Under this frame width the reader lays every letter out at the column (`REFLOW_BELOW_PX`). */
const REFLOW_BELOW_PX = 480;
/** The smallest scale a letter is fitted at, for its type to stay readable (`MIN_FIT_SCALE`). */
const MIN_FIT_SCALE = 0.6;

const designFixtures = [
  { name: "600px table", width: 600, html: '<table class="canvas" width="600"><tr><td>Weekly edition</td></tr></table>' },
  { name: "640px heading and button", width: 640, html: '<table class="canvas" width="640"><tr><td><h1 style="font-size:48px">The weekend edition</h1><a href="https://example.test/edition" style="display:inline-block;padding:16px 36px;background:#ddd">Read the edition</a></td></tr></table>' },
  { name: "fluid table", width: 600, fluid: true, html: '<table class="canvas" width="100%" style="max-width:600px"><tr><td>Responsive edition</td></tr></table>' },
  { name: "fixed inner table", width: 260, html: '<table width="100%"><tr><td><table class="canvas" width="260"><tr><td>A narrow card</td><td>More</td></tr></table></td></tr></table>' },
];

interface DesignRig {
  openDesign(html: string): void;
  openPreview(html: string): void;
  openAnchored(html: string, width?: number, thread?: boolean): void;
  openPendingPress(html: string): void;
  pressEarlier(): string | null;
  deliverPicture(data: string): void;
  resizeDesign(width: number): void;
  showDesign(open: boolean, reader: boolean): void;
}

function paintedDesign(page: Page) {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>(".mb-frame")!;
    const doc = frame.contentDocument!;
    const root = doc.documentElement;
    const table = doc.querySelector<HTMLElement>(".canvas")!;
    const rect = table.getBoundingClientRect();
    const sheet = frame.closest<HTMLElement>(".oh-message, .scast")!;
    const inset = parseFloat(getComputedStyle(doc.body).paddingLeft);
    return {
      frame: frame.clientWidth, sheet: sheet.clientWidth, inset,
      drawn: rect.width, layout: table.offsetWidth, right: rect.right, left: rect.left,
      scale: rect.width / table.offsetWidth,
      scaled: getComputedStyle(doc.body).transform !== "none",
      reflow: root.getAttribute("data-ohmail-reflow"),
    };
  });
}

const ENGINES = [["chromium", pw.chromium], ["webkit", pw.webkit]] as const;
for (const [name, engine] of ENGINES) {
  describe.runIf(existsSync(engine.executablePath()))(`${name}: the thread-read rule over a laid-out reader`, () => {
    let browser: Browser | null = null;
    beforeAll(async () => { browser = await engine.launch(); }, 120_000);
    afterAll(async () => { await browser?.close(); });

    for (const { name: designName, width, fluid, html } of designFixtures) {
      it(`draws the ${designName} across pane resizes and when opened in the reader`, async () => {
        const page = await open(browser!);
        try {
          await page.evaluate((value) => (window as unknown as { rig: DesignRig }).rig.openDesign(value), html);
          await page.locator(".mb [data-own-end]").waitFor({ state: "attached" });
          let wide = 0;
          for (const paneWidth of [940, 720, 560, 390, 940]) {
            await page.evaluate((w) => (window as unknown as { rig: DesignRig }).rig.resizeDesign(w), paneWidth);
            await expect.poll(async () => {
              const m = await paintedDesign(page);
              return Math.abs(m.frame - m.sheet);
            }).toBeLessThanOrEqual(3);
            await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
            const m = await paintedDesign(page);
            const room = m.frame - 2 * m.inset;
            if (paneWidth === 940) wide = m.drawn;
            // Never cut: the letter's right edge stays inside the frame, its left edge too; only a letter already
            // shrunk to the smallest readable scale may reach past it.
            expect(m.left).toBeGreaterThanOrEqual(-1);
            if (m.scale > MIN_FIT_SCALE + 0.001) expect(m.right).toBeLessThanOrEqual(m.frame + 1);
            else expect(m.right).toBeLessThanOrEqual(m.frame + 0.02 * width);
            if (fluid || width <= room) {
              // It fits: drawn at its own width, never a narrow column.
              expect(m.drawn).toBeGreaterThanOrEqual(Math.min(width, room) - 3);
              expect(m.scale).toBeCloseTo(1, 2);
            } else if (m.frame >= REFLOW_BELOW_PX) {
              // Wider than the pane: laid out at its own width and scaled down evenly to the pane.
              expect(m.layout).toBe(width);
              expect(m.scale).toBeLessThan(1);
              expect(m.reflow).toBeNull();
              expect(m.drawn).toBeGreaterThanOrEqual(room - 3);
            } else {
              // A pane narrower than a reading column lays the letter out at the column instead.
              // (WebKit keeps a table wider than `max-width`; it is then fitted as in a wide column.)
              expect(m.reflow).toBe("column");
              expect(m.drawn).toBeGreaterThanOrEqual(room * 0.9);
            }
          }
          await page.evaluate(() => (window as unknown as { rig: DesignRig }).rig.showDesign(false, false));
          await page.locator(".oh-message-clip[data-shut]").waitFor({ state: "attached" });
          // A shut card's letter is as wide as the card, not a narrow cut column.
          await expect.poll(async () => {
            const m = await paintedDesign(page);
            return Math.abs(m.frame - m.sheet);
          }).toBeLessThanOrEqual(3);
          await page.evaluate(() => (window as unknown as { rig: DesignRig }).rig.showDesign(true, true));
          await page.locator(".mb [data-own-end]").waitFor({ state: "attached" });
          const designWidth = fluid ? width : wide;
          await expect.poll(async () => Math.abs((await paintedDesign(page)).drawn - designWidth)).toBeLessThanOrEqual(1);
          if (!fluid && width > 390) {
            for (const paneWidth of [560, 390, 940]) {
              await page.evaluate((w) => (window as unknown as { rig: DesignRig }).rig.resizeDesign(w), paneWidth);
              await expect.poll(async () => {
                const m = await paintedDesign(page);
                return {
                  layout: m.layout,
                  leftInFrame: m.left >= -1,
                  scaled: m.scale < 0.999,
                  fitted: m.right <= m.frame + 1 || Math.abs(m.scale - MIN_FIT_SCALE) < 0.0001,
                };
              }).toEqual({ layout: width, leftInFrame: true, scaled: paneWidth < width, fitted: true });
              const m = await paintedDesign(page);
              if (m.right > m.frame + 1) {
                expect(m.scale).toBeCloseTo(MIN_FIT_SCALE, 4);
                await expectSidewaysAccess(page);
              } else {
                expect(m.scale).toBeGreaterThanOrEqual(MIN_FIT_SCALE - 0.0001);
              }
            }
          }
        } finally {
          await page.context().close();
        }
      }, 15_000);
    }

    async function openNarrow(page: Page, html: string, preview: boolean) {
      await page.evaluate(({ value, preview }) => {
        const rig = (window as unknown as { rig: DesignRig }).rig;
        if (preview) rig.openPreview(value);
        else {
          rig.openDesign(value);
          rig.resizeDesign(390);
          rig.showDesign(true, true);
        }
      }, { value: html, preview });
      await page.locator(".mb [data-own-end]").waitFor({ state: "attached" });
    }

    async function expectSidewaysAccess(page: Page) {
      const reached = await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>(".mb-frame")!.contentDocument!;
        const root = doc.documentElement;
        const frame = doc.defaultView!;
        const table = doc.querySelector(".canvas")!;
        const position = getComputedStyle(root);
        const overflow = position.overflowX;
        const right = table.getBoundingClientRect().right;
        frame.scrollTo(Math.ceil(right - root.clientWidth) + 1, 0);
        return { overflow, scroll: frame.scrollX, right: table.getBoundingClientRect().right, width: root.clientWidth };
      });
      expect(["auto", "scroll", "visible"]).toContain(reached.overflow);
      expect(reached.scroll).toBeGreaterThan(0);
      expect(reached.right).toBeLessThanOrEqual(reached.width + 1);
    }

    for (const preview of [false, true]) {
      const surface = preview ? "phone News preview" : "full reader";
      for (const width of [640, 760]) {
        it(`keeps a ${width}px newsletter readable at 390px in the ${surface}`, async () => {
          const page = await open(browser!);
          try {
            await openNarrow(page, `<table class="canvas" width="${width}"><tr><td>Weekend edition</td></tr></table>`, preview);
            const m = await paintedDesign(page);
            expect(m.layout).toBe(width);
            expect(m.scale).toBeCloseTo(MIN_FIT_SCALE, 4);
            if (m.right > m.frame + 1) await expectSidewaysAccess(page);
          } finally {
            await page.context().close();
          }
        });
      }

      it(`scrolls a long data cell at full size in the ${surface}`, async () => {
        const page = await open(browser!);
        try {
          const html = '<table class="canvas" width="100%" style="max-width:600px"><tr>' +
            '<td style="white-space:nowrap">' + "M".repeat(80) + '</td></tr></table>';
          await openNarrow(page, html, preview);
          const m = await paintedDesign(page);
          expect(m.reflow).toBe("1");
          expect(m.scaled).toBe(false);
          expect(m.scale).toBeCloseTo(1, 3);
          await expectSidewaysAccess(page);
        } finally {
          await page.context().close();
        }
      });
    }

    it("refits an already measured newsletter when a late font widens its row", async () => {
      const page = await open(browser!);
      try {
        const html = '<table class="canvas" width="600"><tr><td><span style="white-space:nowrap;font:20px/24px Late, Arial">' +
          "i".repeat(60) + '</span></td></tr></table>';
        await page.evaluate((value) => {
          const rig = (window as unknown as { rig: DesignRig }).rig;
          rig.openDesign(value);
          rig.resizeDesign(560);
          rig.showDesign(true, true);
        }, html);
        await page.locator(".mb [data-own-end]").waitFor({ state: "attached" });
        const before = await paintedDesign(page);
        expect(before.layout).toBe(600);
        const font = readFileSync(join(ROOT, "packages/tokens/fonts/jetbrains-latin.woff2")).toString("base64");
        await page.evaluate(async (base64) => {
          const doc = document.querySelector<HTMLIFrameElement>(".mb-frame")!.contentDocument!;
          const sheet = doc.createElement("style");
          sheet.textContent = `@font-face { font-family: Late; src: url(data:font/woff2;base64,${base64}); }`;
          doc.head.appendChild(sheet);
          await doc.fonts.load("20px Late", "i");
        }, font);
        await expect.poll(async () => (await paintedDesign(page)).layout).toBeGreaterThan(before.layout + 100);
        await expect.poll(async () => (await paintedDesign(page)).scale).toBeLessThan(before.scale - 0.1);
        const after = await paintedDesign(page);
        expect(after.scale).toBeGreaterThanOrEqual(MIN_FIT_SCALE - 0.0001);
        expect(after.right).toBeLessThanOrEqual(after.frame + 1);
      } finally {
        await page.context().close();
      }
    });

    it.each([false, true])("keeps the text below a late width-only picture on the reading line (embedded: %s)", async (embedded) => {
      const release = Promise.withResolvers<void>();
      const page = await open(browser!, { asked: 0, now: 0, most: 0, release: release.promise });
      try {
        const src = embedded ? "cid:issue-cover" : "https://pictures.example.test/edition-held.png";
        const html = '<table width="600" cellspacing="0" cellpadding="0">' +
          '<tr><td style="height:400px">Before the picture</td></tr>' +
          `<tr><td><img src="${src}" width="600" alt="Cover"></td></tr>` +
          '<tr><td style="height:50px;text-align:center"><p class="reading-text">The line being read</p></td></tr>' +
          '<tr><td style="height:1000px">After the line</td></tr></table>';
        await page.evaluate((value) => (window as unknown as { rig: DesignRig }).rig.openAnchored(value), html);
        await page.locator(".mb [data-own-end]").waitFor({ state: "attached" });
        const photo = page.frameLocator(".mb-frame").getByRole("img", { name: "Cover" });
        if (!embedded) {
          await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.src.includes("/api/img"))).toBe(true);
        }
        const line = page.frameLocator(".mb-frame").locator(".reading-text");
        await page.evaluate(() => {
          const frame = document.querySelector<HTMLIFrameElement>(".mb-frame")!;
          const text = frame.contentDocument!.querySelector(".reading-text")!;
          frame.closest(".read-col")!.scrollTop += frame.getBoundingClientRect().top + text.getBoundingClientRect().top - 12;
        });
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const top = async () => (await line.boundingBox())!.y;
        const before = await top();
        expect(Math.abs(before - 12)).toBeLessThanOrEqual(1);
        const frame = page.locator(".mb-frame");
        const height = (await frame.boundingBox())!.height;
        if (embedded) {
          await page.evaluate((data) => (window as unknown as { rig: DesignRig }).rig.deliverPicture(data),
            `data:image/png;base64,${PNG.toString("base64")}`);
        } else {
          release.resolve();
        }
        await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(8);
        await expect.poll(async () => (await frame.boundingBox())!.height).toBeGreaterThan(height + 50);
        expect(Math.abs(await top() - before)).toBeLessThanOrEqual(2);
      } finally {
        release.resolve();
        await page.context().close();
      }
    });

    it.each([
      { width: 940, thread: false, positionApi: false },
      { width: 390, thread: false, positionApi: false },
      { width: 940, thread: true, positionApi: false },
      { width: 390, thread: true, positionApi: false },
      { width: 390, thread: false, positionApi: true },
    ])("holds text below a picture at $width px (thread: $thread, position API: $positionApi)", async (fixture) => {
      const release = Promise.withResolvers<void>();
      const page = await open(browser!, { asked: 0, now: 0, most: 0, release: release.promise });
      try {
        const html = '<table width="600" cellspacing="0" cellpadding="0">' +
          '<tr><td style="height:400px">Before the picture</td></tr>' +
          '<tr><td><img src="https://pictures.example.test/cover-held.png" width="600" alt="Cover"></td></tr>' +
          '<tr><td style="text-align:center"><span class="reading-text">The first line after the cover</span></td></tr>' +
          '<tr><td style="height:1000px">After the line</td></tr></table>';
        await page.evaluate(({ html, width, thread }) => {
          (window as unknown as { rig: DesignRig }).rig.openAnchored(html, width, thread);
        }, { html, ...fixture });
        await page.locator(".mb [data-own-end]").waitFor({ state: "attached" });
        const photo = page.frameLocator(".mb-frame").getByRole("img", { name: "Cover" });
        await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.src.includes("/api/img"))).toBe(true);
        await page.evaluate(({ positionApi }) => {
          const frame = document.querySelector<HTMLIFrameElement>(".mb-frame")!;
          const doc = frame.contentDocument!;
          if (positionApi) {
            const getRange = doc.caretRangeFromPoint.bind(doc);
            Object.defineProperties(doc, {
              caretRangeFromPoint: { value: undefined },
              caretPositionFromPoint: { value: (x: number, y: number) => {
                const range = getRange(x, y);
                return range && { offsetNode: range.startContainer, offset: range.startOffset };
              } },
            });
          }
          const target = doc.querySelector(positionApi ? ".reading-text" : 'img[alt="Cover"]')!;
          const { top, height } = target.getBoundingClientRect();
          frame.closest(".read-col")!.scrollTop += frame.getBoundingClientRect().top + top + height / 2 - 14;
        }, fixture);
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const cover = (await photo.boundingBox())!;
        const line = page.frameLocator(".mb-frame").locator(".reading-text");
        const before = (await line.boundingBox())!.y;
        if (!fixture.positionApi) {
          expect(cover.y).toBeLessThan(14);
          expect(cover.y + cover.height).toBeGreaterThan(14);
          expect(before).toBeGreaterThan(14);
        }
        const height = (await page.locator(".mb-frame").boundingBox())!.height;
        release.resolve();
        await expect.poll(async () => (await page.locator(".mb-frame").boundingBox())!.height).toBeGreaterThan(height + 50);
        expect(Math.abs((await line.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
      } finally {
        release.resolve();
        await page.context().close();
      }
    });

    it("captures the reading anchor once after a burst of scroll events", async () => {
      const page = await open(browser!);
      try {
        await page.evaluate(() => {
          const rig = (window as unknown as { rig: DesignRig }).rig;
          rig.openAnchored('<table width="600"><tr><td style="text-align:center">' +
            '<p style="font-size:24px">A line of the edition</p>'.repeat(60) + '</td></tr></table>');
        });
        await page.locator(".mb [data-own-end]").waitFor({ state: "attached" });
        const hits = await page.evaluate(async () => {
          const frame = document.querySelector<HTMLIFrameElement>(".mb-frame")!;
          const doc = frame.contentDocument!;
          const scroller = frame.closest<HTMLElement>(".read-col")!;
          const line = doc.querySelectorAll("p")[10]!;
          scroller.scrollTop += frame.getBoundingClientRect().top + line.getBoundingClientRect().top - 8;
          const nextFrame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
          await nextFrame();
          await nextFrame();
          const getRange = doc.caretRangeFromPoint.bind(doc);
          let calls = 0;
          doc.caretRangeFromPoint = (x, y) => { calls++; return getRange(x, y); };
          for (let i = 0; i < 8; i++) {
            scroller.scrollTop += 1;
            scroller.dispatchEvent(new Event("scroll"));
          }
          const duringScroll = calls;
          await nextFrame();
          return { duringScroll, afterFrame: calls };
        });
        expect(hits).toEqual({ duringScroll: 0, afterFrame: 1 });
      } finally {
        await page.context().close();
      }
    });

    it.each([false, true])("bounds caret lookups in a pane full of pictures (frames throttled: %s)", async (throttled) => {
      const page = await open(browser!);
      try {
        const picture = `<img src="data:image/png;base64,${PNG.toString("base64")}" width="200" height="16" alt="Photo">`;
        const html = '<table width="600" cellspacing="0" cellpadding="0">' +
          `<tr><td style="text-align:center">${(picture + "<br>").repeat(60)}</td></tr></table>`;
        await page.evaluate((html) => (window as unknown as { rig: DesignRig }).rig.openAnchored(html), html);
        await page.locator(".mb [data-own-end]").waitFor({ state: "attached" });
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const result = await page.evaluate(async (throttled) => {
          const frame = document.querySelector<HTMLIFrameElement>(".mb-frame")!;
          const doc = frame.contentDocument!;
          const scroller = frame.closest<HTMLElement>(".read-col")!;
          const getRange = doc.caretRangeFromPoint.bind(doc);
          const probes: number[] = [];
          doc.caretRangeFromPoint = (x, y) => {
            probes.push(y);
            return getRange(x, y);
          };
          if (throttled) window.requestAnimationFrame = () => 0;
          scroller.scrollTop = 100;
          scroller.dispatchEvent(new Event("scroll"));
          if (throttled) await new Promise((done) => setTimeout(done, 48));
          else await new Promise((done) => requestAnimationFrame(() => done(undefined)));
          return { scroll: scroller.scrollTop, probes };
        }, throttled);
        expect(result.scroll).toBe(100);
        expect(result.probes.length).toBeGreaterThan(0);
        expect(result.probes.length).toBeLessThanOrEqual(12);
      } finally {
        await page.context().close();
      }
    });

    it("leaves a hand scroll where it lands while a list press is still pending", async () => {
      const page = await open(browser!);
      try {
        const html = '<table width="600"><tr><td style="height:900px">The long edition</td></tr></table>';
        await page.evaluate((html) => (window as unknown as { rig: DesignRig }).rig.openPendingPress(html), html);
        await page.locator(".mb [data-own-end]").waitFor({ state: "attached" });
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const result = await page.evaluate(async () => {
          const scroller = document.querySelector<HTMLElement>(".read-col")!;
          const rig = (window as unknown as { rig: DesignRig }).rig;
          Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 0 });
          const pending = rig.pressEarlier();
          Reflect.deleteProperty(scroller, "clientHeight");
          scroller.style.setProperty("--oh-thread-landing-room", "30px");
          scroller.scrollTop = 240;
          const handTop = scroller.scrollTop;
          scroller.dispatchEvent(new Event("scroll"));
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          const afterScroll = scroller.scrollTop;
          window.dispatchEvent(new Event("resize"));
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          return { pending, handTop, afterScroll, afterMeasure: scroller.scrollTop };
        });
        expect(result.pending).toBe("earlier");
        expect(result.handTop).toBeGreaterThan(0);
        expect(result.afterScroll).toBe(result.handTop);
        expect(result.afterMeasure).toBe(0);
      } finally {
        await page.context().close();
      }
    });

    it("holds the letter top when a picture fills the rest of the reading pane", async () => {
      const page = await open(browser!);
      const errors: Error[] = [];
      page.on("pageerror", (error) => errors.push(error));
      try {
        const html = '<table width="600" cellspacing="0" cellpadding="0">' +
          `<tr><td><img src="data:image/png;base64,${PNG.toString("base64")}" width="600" height="1000" alt="Cover"></td></tr>` +
          '<tr><td>The line after the cover</td></tr></table>';
        await page.evaluate((html) => (window as unknown as { rig: DesignRig }).rig.openAnchored(html, 940, true), html);
        await page.locator(".mb [data-own-end]").waitFor({ state: "attached" });
        const photo = page.frameLocator(".mb-frame").getByRole("img", { name: "Cover" });
        await photo.evaluate((img) => {
          const frame = img.ownerDocument.defaultView!.frameElement!;
          const scroller = frame.closest<HTMLElement>(".read-col")!;
          scroller.scrollTop += frame.getBoundingClientRect().top + img.getBoundingClientRect().top + 80;
        });
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const cover = (await photo.boundingBox())!;
        const pane = (await page.locator(".read-col").boundingBox())!;
        expect(cover.y).toBeLessThan(pane.y + 14);
        expect(cover.y + cover.height).toBeGreaterThan(pane.y + pane.height);
        const letter = page.locator("[data-conv-id=open]");
        const before = (await letter.boundingBox())!.y;
        const earlier = page.locator("[data-conv-id=earlier]");
        const height = (await earlier.boundingBox())!.height;
        await earlier.evaluate((element, height) => { element.style.height = `${height + 100}px`; }, height);
        expect((await earlier.boundingBox())!.height).toBeCloseTo(height + 100);
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        expect(Math.abs((await letter.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    });

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

    // 2026-10-26: one tab's Screener drew 27 letters of 40 pictures at once, 1,080 GET /img in 6 s.
    it("three letters of 20 pictures draw every picture, never more than 6 asked of the proxy at once; a width-only picture waits flat", async () => {
      let release = (): void => {};
      const proxied: Proxied = { asked: 0, now: 0, most: 0, release: new Promise((r) => { release = r; }) };
      const page = await open(browser!, proxied, 120);
      try {
        const r = await page.evaluate(() => (window as unknown as { rig: { pictures: (n: number) => Promise<{ total: number; drawn: number; parked: unknown }> } }).rig.pictures(20));
        expect({ total: r.total, drawn: r.drawn }, "a picture never drew").toEqual({ total: 63, drawn: 60 });
        expect(proxied.asked, "a picture was asked twice, or not at all").toBe(60);
        expect(proxied.most, "the proxy was asked for more than 6 pictures at once").toBeLessThanOrEqual(6);
        // A parked picture with no declared height stands as an in-flight one does, not as a square of its width.
        expect(r.parked, "a width-only picture waits as a blank square").toEqual({ w: 564, h: 0 });
      } finally {
        release();
        await page.context().close();
      }
    }, 90_000);

    it("three letters of 20 background-image cells, inline and in a sheet, never ask more than 6 at once, each url once", async () => {
      const proxied: Proxied = { asked: 0, now: 0, most: 0, urls: new Map() };
      const page = await open(browser!, proxied, 120);
      try {
        const r = await page.evaluate(() => (window as unknown as { rig: { backgrounds: (n: number) => Promise<{ cells: number; shown: number; parked: number }> } }).rig.backgrounds(10));
        expect(r, "a cell never showed its background").toEqual({ cells: 60, shown: 60, parked: 0 });
        await new Promise((d) => setTimeout(d, 500)); // a second ask after the swap would land here
        expect(proxied.most, "the proxy was asked for more than 6 backgrounds at once").toBeLessThanOrEqual(6);
        expect(proxied.urls!.size, "a background was never asked").toBe(60);
        expect([...proxied.urls!.values()].every((n) => n === 1), "a background was asked twice").toBe(true);
      } finally {
        await page.context().close();
      }
    }, 90_000);

    // A refused url carries no cache lifetime: the live css swapped in asked for it again, outside the queue.
    it("background urls the proxy refuses, inline and in a sheet, are asked once each, never more than 6 at once; the rest still show", async () => {
      const proxied: Proxied = { asked: 0, now: 0, most: 0, urls: new Map() };
      const page = await open(browser!, proxied, 120);
      try {
        const r = await page.evaluate(() => (window as unknown as { rig: { backgrounds: (n: number, refused: number) => Promise<{ cells: number; shown: number; parked: number }> } }).rig.backgrounds(10, 4));
        expect.soft(r, "a cell never showed its background, or a refused one did").toEqual({ cells: 60, shown: 36, parked: 0 });
        await new Promise((d) => setTimeout(d, 500)); // a second ask after the swap would land here
        expect(proxied.most, "the proxy was asked for more than 6 backgrounds at once").toBeLessThanOrEqual(6);
        expect(proxied.urls!.size, "a background was never asked").toBe(60);
        expect([...proxied.urls!].filter(([, n]) => n !== 1), "a background was asked twice").toEqual([]);
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

    // WebKit and Chromium tell the page nothing of a press inside a sandboxed letter but the window's blur.
    it("a press inside a stream card's letter, with no scroll, reads that card after the dwell, and nothing below the screen", async () => {
      const page = await open(browser!);
      try {
        type Pressed = { reads: string[][]; at: number[]; since: number };
        await page.evaluate(() => (window as unknown as { rig: { streamPress: () => void } }).rig.streamPress());
        await page.waitForTimeout(1200);
        const idle = await page.evaluate(() => (window as unknown as { rig: { pressed: () => Pressed } }).rig.pressed());
        expect(idle.reads, "read before any press").toEqual([]);
        const box = (await page.locator('.scast[data-sid="c1"] iframe').boundingBox())!;
        await page.mouse.click(box.x + 60, box.y + 20);
        const pressedAt = (await page.evaluate(() => (window as unknown as { rig: { pressed: () => Pressed } }).rig.pressed())).since;
        await page.waitForTimeout(1300);
        const r = await page.evaluate(() => (window as unknown as { rig: { pressed: () => Pressed } }).rig.pressed());
        expect(r.reads, "the pressed letter was not read, or more than it").toEqual([["c1"]]);
        expect(r.at[0]! - pressedAt, "read before the dwell was done").toBeGreaterThanOrEqual(600);
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

it("returns from Calendar to the open conversation at its reading position on the first frame", async () => {
  const { readerStatesPage } = await import("../../../packages/app/test/states/reader-states.mjs");
  const html = await readerStatesPage("packages/app/test/states/squares-reader-1-page.tsx");
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    await page.route("**/*", (route) => route.request().url().startsWith(`${ORIGIN}/`)
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: html })
      : route.abort());
    await page.goto(`${ORIGIN}/?switch&n=32&open=3&motion=full`);
    await page.getByRole("button", { name: "Q3 plan" }).click();
    const reader = page.getByRole("region", { name: "Reading", exact: true });
    await reader.getByRole("group", { name: /^32 messages,/ }).waitFor();
    await reader.getByRole("button", { name: /history/i }).first().waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const scrollport = reader.locator("[data-reading-scroll]");
    const initial = await scrollport.evaluate((element) => element.scrollTop);
    // The conversation opens at the newest letter, near the end of the scrollport.
    expect(initial).toBeGreaterThan(500);
    await scrollport.hover();
    await page.mouse.wheel(0, -1000);
    await page.waitForFunction((top) =>
      document.querySelector("[data-reading-scroll]")!.scrollTop < top - 500, initial);
    await page.waitForTimeout(400); // Let the squares settle after the scroll.

    const recording = await page.evaluateHandle(() => {
      function readMailFrame() {
        const rail = document.querySelector<HTMLElement>(".oh-rail");
        const list = document.querySelector<HTMLElement>(".fr-list");
        const reader = document.querySelector<HTMLElement>("[data-reading-scroll]");
        const reading = reader?.closest(".fr-reading");
        const squares = document.querySelector<HTMLElement>('[role="group"][aria-label$="unread"]');
        const shift = (element: Element | null) => {
          const transform = element ? getComputedStyle(element).transform : "none";
          return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
        };
        const box = (element: HTMLElement | null, moving: Element | null = element) => {
          if (!element?.getClientRects().length) return null;
          const { x, y, width, height } = element.getBoundingClientRect();
          return [x, y - shift(moving), width, height].map((value) => Math.round(value * 100) / 100);
        };
        return {
          rail: box(rail),
          railGroup: box(rail?.querySelector(".oh-rail-group:not(:empty)") ?? null),
          list: box(list),
          reader: box(reader, reading ?? null),
          squares: box(squares, reading ?? null),
          motion: {
            listShift: shift(list),
            readerShift: shift(reading ?? null),
            listOpacity: list ? getComputedStyle(list).opacity : null,
            readerOpacity: reading ? getComputedStyle(reading).opacity : null,
          },
          scrollTop: reader?.scrollTop ?? null,
          loading: [...(reader?.querySelectorAll('[role="status"]') ?? [])]
            .some((line) => line.textContent?.includes("Loading the full message")),
        };
      }

      const frames: ReturnType<typeof readMailFrame>[] = [];
      const shifts: number[] = [];
      type Shift = PerformanceEntry & { value: number };
      const before = readMailFrame();
      let away = false;
      let arrived: number | undefined;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Shift[]) {
          if (arrived !== undefined && entry.startTime >= arrived) shifts.push(entry.value);
        }
      });
      observer.observe({ type: "layout-shift" });
      let frame = requestAnimationFrame(function sample(now) {
        if (document.documentElement.dataset.product === "cal") away = true;
        if (away && document.documentElement.dataset.product === "mail") {
          arrived ??= now;
          frames.push(readMailFrame());
        }
        frame = requestAnimationFrame(sample);
      });
      return { before, frames, shifts, stop: () => { observer.disconnect(); cancelAnimationFrame(frame); } };
    });
    const products = page.getByRole("group", { name: "Mail or Calendar" });
    await products.getByRole("button", { name: "Calendar" }).click();
    await page.getByRole("heading", { name: "Calendar week" }).waitFor();
    expect(await reader.count()).toBe(0);
    await products.getByRole("button", { name: "Mail" }).click();
    await page.waitForFunction((record) => record.frames.length >= 8, recording);
    await page.waitForTimeout(400); // Sample through the product arrival animation.
    const { before, frames, shifts } = await recording.evaluate((record) => {
      record.stop();
      return { before: record.before, frames: record.frames, shifts: record.shifts };
    });
    expect(before.squares).not.toBeNull();
    expect(before.loading).toBe(false);
    expect.soft(shifts, "layout shifts after returning to Mail").toEqual([]);
    expect(frames.some(({ motion }) => motion.listShift > 0 && motion.readerShift > 0),
      "the restored reader and list share the entry motion").toBe(true);
    expect(frames.at(-1), "geometry and visibility after the entry settles").toEqual(before);
    const { motion: _entry, ...rest } = before;
    const geometry = frames.map(({ motion: _motion, ...frame }) => JSON.stringify(frame));
    expect([...new Set(geometry)].map((frame) => JSON.parse(frame)),
      "geometry, readiness, and scroll position from the first Mail frame").toEqual([rest]);
  } finally {
    await browser.close();
  }
}, 60_000);
