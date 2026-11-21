/**
 * THE TOUCH LAYER IN A REAL BROWSER, under a finger. jsdom has no pan, no pointer capture and no cancel, so the claim's
 * worth is read here: the first shell's protocol, fifty swipes and fifty scrolls on the Ohbox's list, each made by the
 * browser's own touch input. No scroll is taken for a swipe and each scroll moves the list, and a swipe presses its
 * verb once. Then a hold
 * picks a row and selects no text, a pull at the top pulls once, and the dock stands clear of the system's inset.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CDPSession, Page } from "@playwright/test";
import type { TouchSaid } from "./touch-page.js";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const ORIGIN = "http://touch.states.invalid";
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let html = "";

beforeAll(async () => {
  const states = (await import("./touch-states.mjs")) as { touchStatesPage: () => Promise<string> };
  html = await states.touchStatesPage();
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

async function open(query = "", width = 390): Promise<{ page: Page; cdp: CDPSession; errors: string[] }> {
  const context = await browser!.newContext({
    viewport: { width, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto(`${ORIGIN}/?${query}`);
  await page.waitForSelector("[role=option][data-id]", { timeout: 15_000 });
  return { page, cdp: await context.newCDPSession(page), errors };
}

type Point = { x: number; y: number };
/** One finger's run through the browser's own touch input, let go at its end (or after `hold` ms where it came down). */
async function run(
  cdp: CDPSession,
  from: Point,
  by: Point,
  opts: { steps?: number; hold?: number; rest?: number; afterRelease?: () => Promise<void> } = {},
): Promise<void> {
  const steps = opts.steps ?? 10;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  if (opts.hold) await new Promise((r) => setTimeout(r, opts.hold));
  let at = from;
  for (let k = 1; k <= steps; k++) {
    at = { x: from.x + (by.x * k) / steps, y: from.y + (by.y * k) / steps };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at] });
  }
  if (opts.rest) await new Promise((resolve) => setTimeout(resolve, opts.rest));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await opts.afterRelease?.();
  await new Promise((r) => setTimeout(r, 30));
}

const saidOf = (page: Page) => page.evaluate(() => (window as unknown as { touchSaid: TouchSaid }).touchSaid);
const presses = (said: TouchSaid) => said.marked.length + said.acted.length;

/** The middle of the `n`th row on screen now. */
async function rowAt(page: Page, n: number): Promise<Point> {
  return page.evaluate((k) => {
    const rows = [...document.querySelectorAll<HTMLElement>("[role=option][data-id]")].filter((r) => {
      const b = r.getBoundingClientRect();
      return b.top > 120 && b.bottom < innerHeight - 120;
    });
    const b = rows[k % rows.length]!.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, n);
}

describe("the touch layer under a real finger", () => {
  it("opens the compact navigation by tap or rightward drag and closes it by dragging left", async () => {
    const { page, cdp } = await open("motion=full");
    const more = page.getByRole("button", { name: "More", exact: true });
    const drawer = page.getByRole("dialog", { name: "More" });
    await more.tap();
    await drawer.waitFor();
    await drawer.evaluate(async (el) =>
      Promise.all(el.getAnimations().map((animation) => animation.finished)),
    );
    const box = (await drawer.boundingBox())!;
    expect(box.width).toBe(300);
    expect(box.x).toBeCloseTo(0);
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
    const handle = (await more.boundingBox())!;
    await run(cdp, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: 120, y: 4 });
    await drawer.waitFor();
    await run(cdp, { x: 240, y: box.y + box.height / 3 }, { x: -130, y: 2 });
    await drawer.waitFor({ state: "hidden" });
    const dock = (await page.getByRole("navigation", { name: "Places" }).boundingBox())!;
    const edge = { x: dock.x + 5, y: dock.y + dock.height / 2 };
    await run(cdp, edge, { x: 3, y: -100 });
    expect(await drawer.count()).toBe(0);
    await run(cdp, edge, { x: 120, y: 3 });
    await drawer.waitFor();
    await page.touchscreen.tap(370, 100);
    await drawer.waitFor({ state: "hidden" });
    await page.context().close();
  }, 60_000);

  it("opens available Trash from More on the unfolded phone", async () => {
    const { page } = await open("dock=full", 884);
    await page.getByRole("button", { name: "More", exact: true }).tap();
    const drawer = page.getByRole("dialog", { name: "More" });
    await drawer.getByRole("button", { name: "Trash", exact: true }).tap({ timeout: 3000 });
    await page.getByRole("heading", { name: "Trash", exact: true }).waitFor();
    await drawer.waitFor({ state: "hidden" });
    await page.context().close();
  }, 10_000);

  it("keeps the drawer closed when Escape interrupts a snap back", async () => {
    const { page, cdp } = await open("motion=full");
    await page.getByRole("button", { name: "More", exact: true }).tap();
    const drawer = page.getByRole("dialog", { name: "More" });
    await drawer.evaluate(async (el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await run(
      cdp,
      { x: 240, y: 290 },
      { x: -55, y: 0 },
      {
        rest: 120,
        afterRelease: async () => {
          expect(await drawer.evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
          await page.keyboard.press("Escape");
        },
      },
    );
    await page.waitForTimeout(300);
    expect(await drawer.count()).toBe(0);
    await page.context().close();
  }, 10_000);

  it("marks the same thread read on a left swipe and unread on a right swipe", async () => {
    const { page, cdp } = await open();
    const point = await rowAt(page, 0);
    await run(cdp, point, { x: -30, y: 0 });
    expect(presses(await saidOf(page))).toBe(0);
    await run(cdp, point, { x: -120, y: 0 });
    await run(cdp, point, { x: 120, y: 0 });
    const said = await saidOf(page);
    expect(said.marked).toHaveLength(2);
    expect(said.marked[0]).toEqual({ ids: said.marked[1]!.ids, unread: false });
    expect(said.marked[1]!.unread).toBe(true);
    expect(said.acted).toEqual([]);
    expect(said.opened).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("takes fifty swipes, each pressed exactly once, and opens no letter for them", async () => {
    const { page, cdp, errors } = await open();
    const each: number[] = [];
    for (let k = 0; k < 50; k++) {
      const side = k % 2 === 0 ? 1 : -1;
      const before = presses(await saidOf(page));
      await run(cdp, await rowAt(page, k), { x: side * 120, y: (k % 5) * 3 });
      each.push(presses(await saidOf(page)) - before);
    }
    const said = await saidOf(page);
    console.log(`SWIPES 50 pressed=${presses(said)}`);
    expect(
      each.flatMap((n, k) => (n === 1 ? [] : [`swipe ${k}: ${n}`])),
      "a swipe pressed other than once",
    ).toEqual([]);
    expect(said.opened).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  }, 120_000);

  it("never takes a scroll for a swipe, fifty times, and the list scrolls each time", async () => {
    const { page, cdp } = await open();
    const scrollTop = () => page.evaluate(() => document.querySelector(".ob-scroll")!.scrollTop);
    /* The middle of the list's run, so each scroll has room both ways. */
    await page.evaluate(async () => {
      const list = document.querySelector(".ob-scroll")!;
      list.scrollTop = (list.scrollHeight - list.clientHeight) / 2;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    const moved: number[] = [];
    for (let k = 0; k < 50; k++) {
      const down = k % 2 === 0 ? -1 : 1;
      const before = await scrollTop();
      await run(cdp, await rowAt(page, k), { x: ((k % 7) - 3) * 10, y: down * 220 });
      /* A finger moving up scrolls the list down: the list moves against the finger. */
      moved.push((before - (await scrollTop())) * down);
    }
    const said = await saidOf(page);
    console.log(`SCROLLS 50 pressed=${presses(said)} moved min=${Math.min(...moved)}`);
    expect(presses(said)).toBe(0);
    expect(
      moved.filter((by) => by < 100),
      "a finger's scroll that did not move the list",
    ).toEqual([]);
    await page.context().close();
  }, 120_000);

  it("pulls once from the list's top, and a hold picks a row and selects no text", async () => {
    const { page, cdp } = await open();
    await run(cdp, await rowAt(page, 0), { x: 0, y: 160 }, { steps: 12 });
    expect((await saidOf(page)).pulled).toBe(1);
    await run(cdp, await rowAt(page, 1), { x: 0, y: 0 }, { steps: 1, hold: 700 });
    expect((await saidOf(page)).picked).toBe(1);
    expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
    await page.context().close();
  }, 60_000);

  it("keeps the dock controls circular and moves a place into More at a narrower width", async () => {
    const browserPage = async (width: number) => {
      const page = await browser!.newPage({ viewport: { width, height: 844 }, hasTouch: true });
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${ORIGIN}/?dock=full`);
      const dock = page.getByRole("navigation", { name: "Places" });
      await dock.getByRole("button", { name: "More" }).waitFor();
      const sizes = await dock
        .getByRole("button")
        .evaluateAll((buttons) =>
          buttons.map((b) => [b.getBoundingClientRect().width, b.getBoundingClientRect().height]),
        );
      expect(sizes.every(([w, h]) => Math.abs(w! - h!) < 1)).toBe(true);
      return { page, dock, count: sizes.length };
    };
    const wide = await browserPage(440);
    const narrow = await browserPage(390);
    expect(wide.count - narrow.count).toBe(1);
    expect(await narrow.dock.getByRole("button", { name: "Receipts" }).count()).toBe(0);
    await narrow.dock.getByRole("button", { name: "More" }).click();
    const drawer = narrow.page.getByRole("dialog", { name: "More" });
    await drawer.getByRole("button", { name: "Receipts" }).waitFor();
    await wide.page.close();
    await narrow.page.close();
  }, 60_000);

  it("stands the dock clear of the system's inset, its own margin where none is reported", async () => {
    const foot = async (query: string) => {
      const { page } = await open(query);
      const bottom = await page.evaluate(() => {
        const dock = document.querySelector(".fr-dockbox")!;
        return innerHeight - dock.getBoundingClientRect().bottom;
      });
      await page.context().close();
      return bottom;
    };
    expect(await foot("")).toBe(16);
    expect(await foot("sysb=34")).toBe(34);
    expect(await foot("sysb=8"), "the larger of the two, never the sum").toBe(16);
  }, 60_000);
});
