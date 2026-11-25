import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readerStatesPage } from "../../../packages/app/test/states/reader-states.mjs";

let browser: Browser;
const WIDTH = 1440;
const ORIGIN = "https://stream-paint.states.invalid";
let html: string;

beforeAll(async () => {
  html = await readerStatesPage("apps/webapp/test/stream-edge-page.tsx");
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

async function greenAcross(page: Page, y: number, x = 0, width = page.viewportSize()!.width): Promise<number> {
  const b64 = (await page.screenshot({ clip: { x, y, width, height: 1 } })).toString("base64");
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
  }, [b64, width] as const);
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

for (const width of [390, WIDTH]) for (const [face, scheme] of [["paper", "light"], ["ohmarchy", "dark"]]) {
  it.each([["reads", "News"], ["receipts", "Receipts"]])(`%s scrolls under the ${face} action bar at ${width}px`, async (place, name) => {
    const touch = width === 390;
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch, reducedMotion: "reduce" });
    try {
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${ORIGIN}/?face=${face}&scheme=${scheme}&geometry=${place}`);
      const reading = page.getByRole("region", { name: `${name} stream`, exact: true });
      if (touch) await reading.getByRole("heading", { name: "Short letter", exact: true }).click();
      const bar = (touch ? page : reading).getByRole("toolbar", { name: "Actions", exact: true });
      await bar.waitFor();
      const card = touch ? "[data-conv-id]" : "[data-stream-item]";
      await page.addStyleTag({
        content: `
          ${card} { min-height: 1200px; background: #0f0 !important; }
          ${card} .oh-message { background: #0f0 !important; }
        `,
      });
      const panel = touch ? page.locator(".oh-sheet").filter({ has: bar }) : reading;
      const scroller = panel.locator("[data-reading-scroll]");
      await scroller.evaluate((el) => { el.scrollTop = 200; });
      expect(await scroller.evaluate((el) => el.scrollTop)).toBe(200);
      const port = (await scroller.boundingBox())!;
      const bounds = (await panel.boundingBox())!;
      const pill = (await bar.boundingBox())!;
      const barY = Math.ceil(pill.y);
      const panelBottom = bounds.y + bounds.height;
      expect(port.y + port.height).toBeCloseTo(panelBottom, 0);
      expect(pill.y + pill.height).toBeLessThan(panelBottom);
      expect(await greenAcross(page, barY - 12)).toBeGreaterThan(300);
      const pillCenter = Math.floor(pill.x + pill.width / 2);
      expect(await greenAcross(page, barY + 2, pillCenter - 8, 16)).toBe(0);
      expect(await greenAcross(page, barY + 18, pillCenter - 8, 16)).toBe(0);
      const belowPill = Math.floor((pill.y + pill.height + panelBottom) / 2);
      expect(await greenAcross(page, belowPill), "mail paints below the floating pill").toBeGreaterThan(300);

      await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      const last = (await scroller.locator(card).last().boundingBox())!;
      expect(last.y + last.height, "the last letter clears the pill").toBeLessThanOrEqual(pill.y);
    } finally {
      await page.close();
    }
  }, 60_000);
}

describe("inline conversation geometry", () => {
  for (const width of [1024, 1440]) for (const scheme of ["light", "dark"]) {
    it(`${width}px in ${scheme} aligns a single letter with its neighbors and keeps the conversation squares inside the stream`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
        await page.goto(`${ORIGIN}/?face=ohmarchy&scheme=${scheme}`);
        const stream = page.getByRole("region", { name: "News stream", exact: true });
        const first = stream.locator('[data-stream-item="news-0"]');
        const neighbor = stream.locator('[data-stream-item="news-1"]');
        const before = await neighbor.boundingBox();
        await first.getByRole("heading").click();
        await stream.getByRole("button", { name: "Reply", exact: true }).click();
        await stream.getByRole("textbox", { name: "Reply body" }).waitFor();
        const paperBefore = await first.getByRole("article").boundingBox();
        await page.evaluate(() => window.dispatchEvent(new Event("example-reply")));
        const squares = first.getByRole("group", { name: /^2 messages/ });
        await squares.waitFor();
        const marks = await squares.locator("[data-square]").all();
        expect(marks).toHaveLength(2);
        const rail = (await squares.boundingBox())!;
        const paper = (await first.getByRole("article").first().boundingBox())!;
        const after = (await neighbor.boundingBox())!;
        const scroll = stream.locator("[data-reading-scroll]");
        const port = (await scroll.boundingBox())!;
        expect(rail.x).toBeGreaterThanOrEqual(port.x - 0.5);
        expect(rail.x + rail.width).toBeLessThanOrEqual(paper.x);
        expect(paper.x + paper.width + 2).toBeLessThanOrEqual(port.x + port.width + 0.5);
        expect(paperBefore!.x, "the single letter starts at the folded card's edge").toBeCloseTo(before!.x, 1);
        expect(paperBefore!.width, "the single letter uses the folded card's width").toBeCloseTo(before!.width, 1);
        expect([after.x, after.width]).toEqual([before!.x, before!.width]);
        expect(await scroll.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});

it("keeps a directly opened card expanded when the person addresses an earlier card", async () => {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?face=paper&linked`);
    const stream = page.getByRole("region", { name: "News stream", exact: true });
    const first = stream.locator('[data-stream-item="news-0"]');
    const second = stream.locator('[data-stream-item="news-1"]');
    await second.getByRole("button", { name: "Collapse" }).waitFor();
    await first.getByRole("heading").click();
    await first.getByRole("button", { name: "Collapse" }).waitFor();
    expect(await second.getByRole("button", { name: "Collapse" }).count()).toBe(1);
    expect(await stream.getByRole("toolbar", { name: "Actions" }).count()).toBe(1);
  } finally {
    await page.close();
  }
}, 60_000);

it("folds one more recipient when the German disclosure has less room", async () => {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?face=paper&recipients`);
    const card = page.locator('[data-stream-item="news-0"]');
    const second = card.getByRole("button", { name: "Theodor Maximilian Mühlenberg", exact: true });
    await second.waitFor();
    await card.getByRole("button", { name: /und 1 weitere.*Empfänger/i }).waitFor();
    await page.setViewportSize({ width: 1024, height: 900 });
    const disclosure = card.getByRole("button", { name: /und 2 weitere.*Empfänger/i });
    await disclosure.waitFor();
    expect(await second.count()).toBe(0);
    await disclosure.click();
    await second.waitFor();
    expect(await card.getByRole("button", { name: "Cora" }).count()).toBe(1);
  } finally {
    await page.close();
  }
}, 60_000);

it("shows fitting letters whole and clips long letters at six fading lines in both streams", async () => {
  for (const place of ["News", "Receipts"] as const) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, reducedMotion: "reduce" });
    try {
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${ORIGIN}/?geometry=${place === "Receipts" ? "receipts" : "reads"}`);
      const stream = page.getByRole("region", { name: `${place} stream`, exact: true });
      const short = stream.getByRole("article").filter({ has: page.getByRole("heading", { name: "Short letter" }) });
      const long = stream.getByRole("article").filter({ has: page.getByRole("heading", { name: "Long letter" }) });
      const shortClip = short.locator(".oh-message-clip");
      const longClip = long.locator(".oh-message-clip");
      await shortClip.waitFor();
      await short.locator("[data-fits]").waitFor();
      expect(await short.getByRole("button", { name: "Expand" }).count()).toBe(0);
      expect(await shortClip.evaluate((clip) => getComputedStyle(clip).maskImage)).toBe("none");
      const box = await shortClip.evaluate((clip) => ({
        view: clip.clientHeight,
        content: clip.scrollHeight,
        voidPx: clip.getBoundingClientRect().bottom - clip.querySelector(".oh-message-body")!.getBoundingClientRect().bottom,
      }));
      expect(box.view).toBe(box.content);
      expect(box.voidPx).toBeLessThanOrEqual(24);

      const expand = long.getByRole("button", { name: "Expand" });
      await expand.waitFor();
      const clipped = await longClip.evaluate((clip) => {
        const body = clip.querySelector(".oh-message-body")!;
        const line = Number.parseFloat(getComputedStyle(body).lineHeight);
        const rect = clip.getBoundingClientRect();
        return { lines: rect.height / line, bottom: rect.bottom,
          overflowing: clip.scrollHeight > clip.clientHeight, fade: getComputedStyle(clip).maskImage };
      });
      expect(clipped.overflowing).toBe(true);
      expect((await expand.boundingBox())!.y).toBeGreaterThanOrEqual(clipped.bottom - 0.5);
      expect(clipped.lines).toBeCloseTo(6, 1);
      expect(clipped.fade).toContain("linear-gradient");
    } finally {
      await page.close();
    }
  }
}, 60_000);

for (const width of [390, 358, 386, 620]) {
  it(`keeps the mounted receipt name, amount and timestamp whole at ${width}px`, async () => {
    const touch = width === 390;
    const viewportWidth = touch ? width : WIDTH;
    const page = await browser.newPage({ viewport: { width: viewportWidth, height: 900 }, isMobile: touch, hasTouch: touch });
    try {
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${ORIGIN}/?geometry=receipts`);
      const stream = page.getByRole("region", { name: "Receipts stream", exact: true });
      const card = stream.getByRole("article").filter({ has: page.getByRole("heading", { name: "Short letter" }) });
      await card.waitFor();
      if (!touch) {
        await page.addStyleTag({ content: `[data-receipts] [data-stream-item] { inline-size: ${width}px }` });
        expect((await card.boundingBox())!.width).toBeCloseTo(width, 0);
      }
      const sender = card.getByRole("button", { name: /^Open-Air Kino Seeblick / });
      await sender.waitFor();
      const pieces = [
        card.getByText("Open-Air Kino Seeblick", { exact: true }),
        card.getByText("CHF 36.00", { exact: true }),
        card.locator("time"),
      ];
      const bounds = (await card.boundingBox())!;
      for (const piece of pieces) {
        const geometry = await piece.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const outer = el.getBoundingClientRect();
          const inner = range.getBoundingClientRect();
          const tops = [...range.getClientRects()].map((rect) => rect.top);
          return {
            oneLine: Math.max(...tops) - Math.min(...tops) < 0.5,
            fits: inner.width <= outer.width + 0.5,
            natural: inner.width,
            room: outer.width,
            shrink: getComputedStyle(el).flexShrink,
            header: getComputedStyle(el.closest("article")!.querySelector("header")!).gridTemplateColumns,
            left: inner.left,
            right: inner.right,
          };
        });
        const label = await piece.textContent();
        expect(geometry.oneLine, label ?? "").toBe(true);
        expect(geometry.fits, `${label} ${JSON.stringify(geometry)}`).toBe(true);
        expect(geometry.left).toBeGreaterThanOrEqual(bounds.x - 0.5);
        expect(geometry.right).toBeLessThanOrEqual(bounds.x + bounds.width + 0.5);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewportWidth);
      const subject = card.getByRole("heading", { name: "Short letter" });
      const amount = card.getByText("CHF 36.00", { exact: true });
      const subjectBox = (await subject.boundingBox())!;
      const amountBox = (await amount.boundingBox())!;
      expect(Math.abs(subjectBox.y - amountBox.y)).toBeLessThanOrEqual(1);
      expect(subjectBox.x + subjectBox.width).toBeLessThanOrEqual(amountBox.x);

      if (touch) {
        // Force less than fourteen characters of actual address room in the mounted sender.
        await page.addStyleTag({ content: "[data-receipts] .oh-messagehead-address { inline-size: 60px !important }" });
        const address = await sender.locator(".oh-messagehead-address > .oh-address").boundingBox();
        expect(address?.width).toBeLessThanOrEqual(1);
        expect(address?.height).toBeLessThanOrEqual(1);
        expect(await sender.count()).toBe(1);
      } else {
        await subject.click();
        await card.getByRole("button", { name: "Collapse" }).waitFor();
        expect((await amount.boundingBox())!.y).toBeGreaterThanOrEqual(
          (await subject.boundingBox())!.y + (await subject.boundingBox())!.height,
        );
      }
    } finally {
      await page.close();
    }
  }, 60_000);
}

it("keeps a narrow News list free of filing copy and controls", async () => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?filing`);
    const list = page.getByRole("region", { name: "News", exact: true });
    const approve = list.getByRole("button", { name: "Approve", exact: true });
    const correct = list.getByRole("button", { name: "Correct", exact: true });
    await list.waitFor({ timeout: 4000 });
    await list.evaluate((element) => { element.style.inlineSize = "300px"; });
    expect((await list.boundingBox())!.width).toBeCloseTo(300, 0);
    await list.getByRole("option").first().waitFor();
    expect(await list.getByText(/newsletter fingerprint/).count()).toBe(0);
    expect(await approve.count()).toBe(0);
    expect(await correct.count()).toBe(0);
  } finally {
    await page.close();
  }
}, 60_000);

it("puts the delivered-to badge on a wide receipt and moves it to the opened narrow head", async () => {
  for (const width of [620, 386]) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, reducedMotion: "reduce" });
    try {
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${ORIGIN}/?geometry=receipts&delivery`);
      await page.addStyleTag({ content: `[data-receipts] [data-stream-item] { inline-size: ${width}px }` });
      const stream = page.getByRole("region", { name: "Receipts stream", exact: true });
      const subject = page.getByRole("heading", { name: "Short letter" });
      const card = stream.getByRole("article").filter({ has: subject });
      const delivery = card.getByTitle("Delivered to Work");
      await subject.waitFor();
      expect((await card.boundingBox())!.width).toBeCloseTo(width, 0);
      if (width === 386) {
        await delivery.waitFor({ state: "attached", timeout: 4000 });
        expect(await delivery.isVisible()).toBe(false);
        await subject.click();
        await card.getByRole("button", { name: "Collapse" }).waitFor();
      }
      await delivery.waitFor({ timeout: 4000 });
      expect((await delivery.boundingBox())!.y).toBeLessThan((await subject.boundingBox())!.y);
    } finally {
      await page.close();
    }
  }
}, 60_000);

it("a waiting receipt reserves room for its own body below the clip ceiling", async () => {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?geometry=receipts&waiting`);
    await page.addStyleTag({ content: "[data-receipts] [data-stream-item] { inline-size: 358px }" });
    const stream = page.getByRole("region", { name: "Receipts stream", exact: true });
    const card = (name: string) => stream.getByRole("article").filter({ has: page.getByRole("heading", { name }) });
    const clip = (name: string) => card(name).locator(".oh-message-clip");
    await clip("Short letter").waitFor();
    const waiting = (await clip("Short letter").boundingBox())!.height;
    const ceiling = (await clip("Long letter").boundingBox())!.height;
    expect(waiting).toBeGreaterThanOrEqual(119.5);
    expect(waiting).toBeLessThan(ceiling);
    await card("Short letter").getByRole("button", { name: "Expand" }).waitFor({ timeout: 4000 });
  } finally {
    await page.close();
  }
}, 60_000);
