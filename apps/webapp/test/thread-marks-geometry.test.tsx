import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readerStatesPage } from "../../../packages/app/test/states/reader-states.mjs";

/**
 * A LETTER ANSWERED IN ITS READING STREAM, MEASURED IN A REAL ENGINE: the squares beside a conversation that opened in
 * place among a stream's cards, and paper's paint at the window edge. These measurements specify the placement of
 * conversation controls and the paint visible beyond the list's top line. The mounted stream clipping measurement
 * also runs over the registered frame below.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
type Box = { left: number; right: number; top: number; bottom: number };
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

const overlap = (a: Box, b: Box): boolean =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

const WIDTH = 1440;
const STREAM_ORIGIN = "https://thread-stream.states.invalid";

/** Count marker-colour pixels in one painted row. */
async function greenAcross(page: Page, y: number): Promise<number> {
  const png = (await page.screenshot({ clip: { x: 0, y: Math.floor(y), width: WIDTH, height: 1 } })).toString("base64");
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
  }, [png, WIDTH] as const);
}

/** The reader may still be landing its first selection while the browser lays out the tall test article. */
async function measureScrolledPaint(page: Page, column: ReturnType<Page["locator"]>, title: ReturnType<Page["locator"]>) {
  await vi.waitFor(async () => {
    const top = await title.evaluate((node) => node.getBoundingClientRect().top);
    const scrolled = await column.locator("[data-reading-scroll]").evaluate(async (node) => {
      node.scrollTop = 300;
      await new Promise<void>((painted) => requestAnimationFrame(() => requestAnimationFrame(() => painted())));
      return node.scrollTop;
    });
    expect(scrolled, "the reading column did not scroll").toBe(300);
    expect(await greenAcross(page, Math.max(0, top - 8))).toBeGreaterThan(400);
  }, { timeout: 6000 });
}

let readerHtml: Promise<string> | undefined;
let streamHtml: Promise<string> | undefined;

async function show(page: Page, html: Promise<string>, query: string) {
  const content = await html;
  await page.unroute("**/*");
  await page.route("**/*", (route) => route.request().url().startsWith(STREAM_ORIGIN + "/")
    ? route.fulfill({ contentType: "text/html", body: content })
    : route.abort());
  await page.goto(STREAM_ORIGIN + "/" + query);
}

describe("the scrolled reader stays under its tile's top line", () => {
  it("paper keeps scrolling to the window's edge, and the measurement sees it", async () => {
    const page = await browser!.newPage({ viewport: { width: WIDTH, height: 800 }, reducedMotion: "reduce" });
    try {
      await show(page, readerHtml ??= readerStatesPage(), "?face=paper&scheme=dark&read=1&open=rd-a");
      const reader = page.getByRole("region", { name: "Open message" });
      await reader.getByRole("article").first().waitFor({ timeout: 6000 });
      await page.addStyleTag({ content: "[data-conv-id] .oh-message { min-height: 600px; background: #0f0 !important; }" });
      await measureScrolledPaint(page, reader, reader);

      await show(page, streamHtml ??= readerStatesPage("apps/webapp/test/stream-edge-page.tsx"), "?face=paper");
      const list = page.getByRole("region", { name: "News", exact: true });
      const stream = page.getByRole("region", { name: "News stream", exact: true });
      await stream.getByRole("article").first().waitFor({ timeout: 6000 });
      await page.addStyleTag({
        content: "[data-stream-item], [data-stream-item] .oh-message { min-height: 620px; background: #0f0 !important; }",
      });
      await measureScrolledPaint(page, stream, list);
    } finally {
      await page.close();
    }
  }, 60_000);
});

/**
 * A LETTER ANSWERED FROM A STREAM: the card holds the Ohbox's conversation on desktop, with the
 * squares on the seam. On a phone, a press opens the reader, with the squares in its head. In both
 * rooms the paper stays put as the reply joins, both rings fit, and the stream's other cards stay
 * where they were. Without the desktop stream's reclaim its box cuts the rings.
 */
const NO_RECLAIM = '[data-reading-scroll]:has(.rd-stream-conversation){clip-path:inset(0 24px)}';
const STREAM_CASES = [1440, 1024, 390] as const;

async function streamRead(viewport: number, theme: "light" | "dark", panels: number, placed = true, extra = "") {
  const page = await browser!.newPage({ viewport: { width: viewport, height: 800 }, reducedMotion: "reduce" });
  try {
    await show(page, streamHtml ??= readerStatesPage("apps/webapp/test/stream-edge-page.tsx"), `?geometry=news&face=ohmarchy&scheme=${theme}`);
    const stream = page.getByRole("region", { name: "News stream" });
    const phone = viewport < 700;
    const card = stream.locator('[data-stream-item="news-0"]');
    await card.getByRole("heading", { name: "Short letter" }).waitFor({ timeout: 6000 });
    const reader = phone && placed ? page.getByRole("region", { name: "Open message", exact: true }) : stream;
    if (placed) {
      await card.getByRole("heading", { name: "Short letter" }).click({ timeout: 6000 });
      await reader.getByRole("button", { name: "Reply", exact: true }).click({ timeout: 6000 });
      await reader.getByRole("textbox", { name: "Reply body" }).waitFor({ timeout: 6000 });
      if (panels === 2) {
        await page.evaluate(() => window.dispatchEvent(new Event("example-reply")));
        await (phone ? reader : card).getByRole("group", { name: /^2 messages/ }).waitFor({ timeout: 6000 });
      }
    }
    if (extra) await page.addStyleTag({ content: extra });
    const measured = await reader.evaluate((pane, phoneReader) => {
      const box = (el: Element | null): Box | null => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      const scroller = pane.querySelector<HTMLElement>("[data-reading-scroll]")!;
      const marks = phoneReader ? pane.querySelector(".oh-sheet-top") : pane.querySelector(".rd-stream-squares");
      const scrollBox = box(scroller)!;
      const clipPath = getComputedStyle(scroller).clipPath;
      const clip = Number(/^inset\(0px (\d+(?:\.\d+)?)px\)$/.exec(clipPath)?.[1] ?? 0);
      return {
        stream: { ...scrollBox, left: scrollBox.left + clip, right: scrollBox.right - clip },
        ringFrame: box(phoneReader ? pane : scroller)!,
        list: box(document.querySelector('[aria-label="News"]')),
        squares: [...(marks?.querySelectorAll("[data-square]") ?? [])].map((node) => box(node)!),
        ringBox: box(marks?.querySelector(".oh-readsquares-ring") ?? null),
        panels: [...pane.querySelectorAll(phoneReader ? "[data-conv-id] article" : ".rd-stream-letters article")]
          .map((node) => box(node)!),
        overflow: scroller.scrollWidth - scroller.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    }, phone && placed);
    if (phone && placed) {
      await reader.locator(".oh-sheet-back button").click({ timeout: 6000 });
      await stream.waitFor({ state: "visible", timeout: 6000 });
    }
    const resting = await stream.locator('[data-stream-item="news-1"]').evaluate((node) => {
      const { left, right } = node.getBoundingClientRect();
      return { left, right };
    });
    return { ...measured, ring: measured.ringBox?.left ?? null, resting };
  } finally {
    await page.close();
  }
}

describe("a letter answered in its reading stream", () => {
  for (const viewport of STREAM_CASES)
    for (const theme of ["light", "dark"] as const)
      it(`${viewport}px, ${theme}: the squares beside the panels, the ring whole and the lone letter aligned with its neighbors`, async () => {
        const two = await streamRead(viewport, theme, 2);
        const one = await streamRead(viewport, theme, 1);
        const rest = await streamRead(viewport, theme, 1, false);
        expect(one.panels, "the reader before the reply").toHaveLength(1);
        expect(two.panels, "the reader after the reply").toHaveLength(2);
        expect(two.squares, "the conversation drew no squares").toHaveLength(2);
        const hits = two.squares.flatMap((s, i) => two.panels.filter((p) => overlap(s, p)).map((_, j) => `square ${i} × panel ${j}`));
        expect(hits, "a square is drawn over a message").toEqual([]);
        const ringFrame = viewport < 700 ? two.ringFrame : two.stream;
        expect(two.ring!, "the ring is cut on the left").toBeGreaterThanOrEqual(ringFrame.left - 0.5);
        expect(two.ringBox!.right, "the ring is cut on the right").toBeLessThanOrEqual(ringFrame.right + 0.5);
        expect(two.panels[0]!.right + 2, "the paper's ring is cut at the reading edge").toBeLessThanOrEqual(two.stream.right + 0.5);
        expect([two.resting.left, two.resting.right], "a resting card moved sideways").toEqual([rest.resting.left, rest.resting.right]);
        expect(two.overflow, "the stream scrolls sideways").toBeLessThanOrEqual(0);
        expect(two.pageOverflow, "the page scrolls sideways").toBeLessThanOrEqual(0);
        if (viewport < 700) {
          expect(two.panels[0]!.left, "the paper moved when the reply joined").toBeCloseTo(one.panels[0]!.left, 1);
          expect(Math.max(...two.squares.map((box) => box.bottom))).toBeLessThanOrEqual(two.panels[0]!.top);
        } else {
          expect(one.panels[0]!.left, "the single letter starts at the folded card's edge").toBeCloseTo(rest.resting.left, 1);
          expect(one.panels[0]!.right, "the single letter ends at the folded card's edge").toBeCloseTo(rest.resting.right, 1);
          // The studio's Ohmarchy seam: 18px on either side of the 16px mark ring.
          expect(two.ringBox!.right - two.ringBox!.left, "the mark ring width").toBeCloseTo(16, 1);
          expect(two.ring! - two.list!.right - 2, "list ring → mark ring").toBeCloseTo(18, 1);
          expect(two.panels[0]!.left - 2 - two.ringBox!.right, "mark ring → paper ring").toBeCloseTo(18, 1);
        }
      }, 60_000);

  // Keep the original case name for the test ledger. These exact positions are the studio's Ohmarchy frame.
  it("at 1440 the paper stands where the Ohbox's does (x692, 736 wide), the cards where they stood (x736)", async () => {
    const r = await streamRead(1440, "light", 2);
    expect([r.panels[0]!.left, r.panels[0]!.right - r.panels[0]!.left], "the Ohbox's paper box").toEqual([726, 702]);
    expect(r.resting.left, "the resting card's starting edge").toBe(684);
  }, 60_000);

  it("RED CONTROL: without the stream's reclaim the ring and the paper's edge are cut, and the measurement says so", async () => {
    const r = await streamRead(1440, "light", 2, true, NO_RECLAIM);
    expect(r.ring!, "the control found the ring whole: the measurement proves nothing").toBeLessThan(r.stream.left - 0.5);
    expect(r.panels[0]!.right + 2, "the control found the paper's ring whole").toBeGreaterThan(r.stream.right + 0.5);
  }, 60_000);
});
