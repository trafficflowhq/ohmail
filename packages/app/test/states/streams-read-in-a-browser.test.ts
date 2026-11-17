/**
 * THE STREAM'S READ RULE IN A REAL BROWSER (B12-4), on the streams' page: what jsdom cannot show, the column laid out
 * by the kit's sheets and real wheel and finger scrolls. Nothing is read before a hand; what a hand carries up past
 * the line 90 px below the top is read at once, and nothing else until the stream rests; the item it rests on after
 * 0.6 s. A wheel over the list beside the stream is no hand on it. Nothing leaves the machine: the page is served on a
 * routed origin.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>;

const ORIGIN = "http://streams.states.invalid";
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let html = "";

beforeAll(async () => {
  const states = (await import("./reader-states.mjs")) as {
    readerStatesPage: (entry?: string) => Promise<string>;
  };
  html = await states.readerStatesPage("packages/app/test/states/streams-page.tsx");
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

async function open(touch = false): Promise<{ page: Page; errors: string[] }> {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: touch });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto(`${ORIGIN}/?place=news`);
  await page.waitForSelector('[data-stream-item="n3"]', { timeout: 15_000 });
  return { page, errors };
}

/** Every id the place wrote read, in order. */
const written = (page: Page): Promise<string[]> =>
  page.evaluate(() => ((globalThis as { streamWrites?: string[][] }).streamWrites ?? []).flat());

/** The stream's scroller box, and the items whose foot stands at or above the line 90 px below its top. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const sc = document.querySelector('[aria-label="News stream"] .oh-sheet-scroll') as HTMLElement;
    const box = sc.getBoundingClientRect();
    const above = [...sc.querySelectorAll<HTMLElement>("[data-stream-item]")]
      .filter((el) => el.getBoundingClientRect().bottom - box.top <= 90)
      .map((el) => el.dataset.streamItem!);
    return {
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
      left: box.left,
      scrollTop: sc.scrollTop,
      above,
    };
  });

/** Wait for the scroller to stop moving (a wheel and a fling animate), well inside the 0.6 s rest. */
async function settled(page: Page): Promise<void> {
  let last = -1;
  for (let i = 0; i < 40; i += 1) {
    const now = (await geometry(page)).scrollTop;
    if (now === last) return;
    last = now;
    await page.waitForTimeout(40);
  }
}

describe("the stream's read rule in a real browser", () => {
  it("a wheel reads what it carries past the 90 px line at once, the item it rests on after 0.6 s, nothing before", async () => {
    const { page, errors } = await open();
    await page.waitForTimeout(800);
    expect(await written(page)).toEqual([]);
    const at = await geometry(page);
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, 900);
    await settled(page);
    const after = await geometry(page);
    expect(after.scrollTop).toBeGreaterThan(400);
    expect(after.above.length).toBeGreaterThan(0);
    // At once: exactly what was carried past the line.
    expect([...(await written(page))].sort()).toEqual([...after.above].sort());
    // A second step stops an item's foot 150 px below the top: short of the line, so it stays unread.
    const short = await page.evaluate(() => {
      const sc = document.querySelector('[aria-label="News stream"] .oh-sheet-scroll') as HTMLElement;
      const top = sc.getBoundingClientRect().top;
      const next = [...sc.querySelectorAll<HTMLElement>("[data-stream-item]")].find(
        (el) => el.getBoundingClientRect().bottom - top > 170,
      )!;
      return {
        id: next.dataset.streamItem!,
        by: Math.round(next.getBoundingClientRect().bottom - top - 150),
      };
    });
    await page.mouse.wheel(0, short.by);
    await settled(page);
    const stopped = await geometry(page);
    expect(stopped.above).not.toContain(short.id);
    expect([...(await written(page))].sort()).toEqual([...stopped.above].sort());
    // After the rest: one more, the item the stream rests on, below the line.
    await page.waitForTimeout(900);
    const rested = (await written(page)).filter((id) => !stopped.above.includes(id));
    expect(rested).toHaveLength(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("a finger reads what it carries past the line, as the wheel does", async () => {
    const { page, errors } = await open(true);
    const at = await geometry(page);
    const cdp = await page.context().newCDPSession(page);
    // A finger of touch points, 700 px up in 20 moves: a synthesized touch gesture scrolls nothing in headless
    // Chromium on Linux, not even a plain scroller, while these points scroll it as a finger does.
    const x = Math.round(at.x);
    const from = Math.round(at.y) + 350;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
    for (let i = 1; i <= 20; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: from - i * 35 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settled(page);
    const after = await geometry(page);
    expect(after.scrollTop).toBeGreaterThan(300);
    const now = await written(page);
    for (const id of after.above) expect(now).toContain(id);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("End after a press reads only what stood in view", async () => {
    const { page, errors } = await open();
    // The furthest the stream went; the items it passes on the way are on screen only in flight.
    await page.evaluate(() => {
      const sc = document.querySelector('[aria-label="News stream"] .oh-sheet-scroll') as HTMLElement;
      const g = globalThis as { furthest?: number };
      g.furthest = 0;
      sc.addEventListener("scroll", () => (g.furthest = Math.max(g.furthest ?? 0, sc.scrollTop)), {
        passive: true,
      });
    });
    await page.click('[data-stream-item="n1"]');
    await settled(page);
    await page.waitForTimeout(800);
    const before = await written(page);
    const from = await geometry(page);
    await page.keyboard.press("End");
    await settled(page);
    await page.waitForTimeout(900);
    const rest = await page.evaluate(() => {
      const sc = document.querySelector('[aria-label="News stream"] .oh-sheet-scroll') as HTMLElement;
      const box = sc.getBoundingClientRect();
      const ids = [...sc.querySelectorAll<HTMLElement>("[data-stream-item]")]
        .filter(
          (el) => el.getBoundingClientRect().bottom > box.top && el.getBoundingClientRect().top < box.bottom,
        )
        .map((el) => el.dataset.streamItem!);
      return { ids, furthest: (globalThis as { furthest?: number }).furthest ?? 0, screen: sc.clientHeight };
    });
    // End flew the stream screens down; what it read is only what stands in view where it rests.
    expect(rest.furthest).toBeGreaterThan(from.scrollTop + 2 * rest.screen);
    const added = (await written(page)).filter((id) => !before.includes(id));
    expect(added.filter((id) => !rest.ids.includes(id))).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("End with a letter open holds at the foot: the stream does not come back to the open letter", async () => {
    const { page, errors } = await open();
    await page.click('[data-stream-item="n1"]');
    await settled(page);
    await page.waitForTimeout(800);
    const from = await geometry(page);
    await page.keyboard.press("End");
    await settled(page);
    const landed = await geometry(page);
    // The run grows once End nears its foot; the stream stays where End brought it.
    await page.waitForTimeout(1_200);
    await settled(page);
    const rest = await page.evaluate(() => {
      const sc = document.querySelector('[aria-label="News stream"] .oh-sheet-scroll') as HTMLElement;
      const box = sc.getBoundingClientRect();
      const n1 = sc.querySelector<HTMLElement>('[data-stream-item="n1"]')!.getBoundingClientRect();
      return {
        scrollTop: sc.scrollTop,
        screen: sc.clientHeight,
        n1InView: n1.bottom > box.top && n1.top < box.bottom,
      };
    });
    expect(landed.scrollTop).toBeGreaterThan(from.scrollTop + 2 * rest.screen);
    expect(rest.scrollTop).toBeGreaterThanOrEqual(landed.scrollTop - 2);
    expect(rest.n1InView).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("End after a press, then a page hide: the line moves to the top of the screen End rests on", async () => {
    const { page, errors } = await open();
    await page.click('[data-stream-item="n1"]');
    await settled(page);
    await page.waitForTimeout(800);
    await page.keyboard.press("End");
    await settled(page);
    await page.waitForTimeout(900);
    const top = await page.evaluate(() => {
      const sc = document.querySelector('[aria-label="News stream"] .oh-sheet-scroll') as HTMLElement;
      const box = sc.getBoundingClientRect();
      return [...sc.querySelectorAll<HTMLElement>("[data-stream-item]")].find(
        (el) => el.getBoundingClientRect().bottom > box.top && el.getBoundingClientRect().top < box.bottom,
      )!.dataset.streamItem!;
    });
    expect(Number(top.slice(1))).toBeGreaterThan(4);
    const leaves = await page.evaluate(() => {
      const g = globalThis as { streamPageHide?: () => void; streamLeaves?: { upToId: string }[] };
      g.streamPageHide?.();
      return (g.streamLeaves ?? []).map((c) => c.upToId);
    });
    expect(leaves).toEqual([top]);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("a wheel over the list beside the stream reads nothing, also after the rest", async () => {
    const { page, errors } = await open();
    const at = await geometry(page);
    await page.mouse.move(at.left - 160, at.y);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(1_200);
    expect(await written(page)).toEqual([]);
    expect((await geometry(page)).scrollTop).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
