import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readerStatesPage } from "../../../packages/app/test/states/reader-states.mjs";

let browser: Browser;
const WIDTH = 1440;
const ORIGIN = "https://stream-paint.states.invalid";
let html: string;

beforeAll(async () => {
  html = await readerStatesPage("apps/webapp/test/stream-paint-page.tsx");
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

async function greenAcross(page: Page, y: number): Promise<number> {
  const b64 = (await page.screenshot({ clip: { x: 0, y, width: WIDTH, height: 1 } })).toString("base64");
  return page.evaluate(async ([b64, width]) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const ctx = new OffscreenCanvas(width, 1).getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, 1).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i]! < 80 && pixels[i + 1]! > 200 && pixels[i + 2]! < 80) count++;
    }
    return count;
  }, [b64, WIDTH] as const);
}

async function streamPaint(face: "paper" | "ohmarchy") {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, reducedMotion: "reduce" });
  try {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?face=${face}`);
    const reading = page.getByRole("region", { name: "News stream", exact: true });
    try {
      await reading.waitFor({ timeout: 6000 });
    } catch {
      throw new Error(`the mounted News stream did not draw: ${errors.join(" | ")}`);
    }
    await page.addStyleTag({
      content: `
        [data-stream-item] { min-height: 620px; background: #0f0 !important; }
        [data-stream-item] .oh-message { background: #0f0 !important; }
      `,
    });
    const list = await page.getByRole("region", { name: "News", exact: true }).boundingBox();
    const scroller = await reading.evaluate((node) => {
      const scroller = node.matches("[data-reading-scroll]") ? node : node.querySelector("[data-reading-scroll]")!;
      scroller.scrollTop = 300;
      return { top: scroller.getBoundingClientRect().top, scrollTop: scroller.scrollTop };
    });
    expect(scroller.scrollTop).toBe(300);
    const above = Math.max(0, Math.floor(list!.y - 8));
    const inside = Math.ceil(scroller.top + 10);
    return { above: await greenAcross(page, above), inside: await greenAcross(page, inside), top: scroller.top };
  } finally {
    await page.close();
  }
}

describe("the mounted stream's paint at the window edge", () => {
  it("Ohmarchy clips the scrolled letter under the list's top line", async () => {
    const paint = await streamPaint("ohmarchy");
    expect(paint.inside).toBeGreaterThan(400);
    expect(paint.above).toBe(0);
  }, 60_000);

  it("paper lets the scrolled letter reach the window's edge", async () => {
    const paint = await streamPaint("paper");
    expect(paint.inside).toBeGreaterThan(400);
    expect(paint.above, JSON.stringify(paint)).toBeGreaterThan(400);
  }, 60_000);
});
