/**
 * THE STREAM'S READ RULE IN A REAL BROWSER (B12-4), on the streams' page: what jsdom cannot show, the column laid out
 * by the kit's sheets and real wheel and finger scrolls. Nothing is read before a hand; what a hand carries up past
 * the line 90 px below the top is read at once, and nothing else until the stream rests; the item it rests on after
 * 0.6 s. A wheel over the list beside the stream is no hand on it. Nothing leaves the machine: the page is served on a
 * routed origin.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { THREAD_READ_HOLD_MS } from "../../../../test/support/engine-fixtures.js";
import { SEEN_MAX_LATENCY_MS } from "@ohmail/app-logic/reading/seen-batch";
import { MENU_KEY_CHORD } from "../../../ui/src/base/Overlays/menu-place.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>;

const ORIGIN = "https://streams.states.invalid";
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let html = "";
let menuReaderHtml = "";

beforeAll(async () => {
  const states = (await import("./reader-states.mjs")) as {
    readerStatesPage: (entry?: string) => Promise<string>;
  };
  html = await states.readerStatesPage("packages/app/test/states/streams-page.tsx");
  menuReaderHtml = await states.readerStatesPage();
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

/** The shared rule decides eligibility before the existing write batch dispatches. */
const earned = (page: Page): Promise<string[]> =>
  page.evaluate(() => (globalThis as { streamReadEvidence?: string[] }).streamReadEvidence ?? []);

async function expectWritten(page: Page, carried: readonly string[]): Promise<void> {
  // Rest and displayed-text evidence can arrive in separate batches. Compare after both can drain.
  await page.waitForTimeout(THREAD_READ_HOLD_MS + SEEN_MAX_LATENCY_MS + 100);
  const later = await page.evaluate(() => {
    const world = globalThis as { streamRestReads: string[]; streamDisplayedReads: string[] };
    return [...world.streamRestReads, ...world.streamDisplayedReads];
  });
  expect((await written(page)).sort()).toEqual([...new Set([...carried, ...later])].sort());
}

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
  it("draws the News letter in dark mode both folded and expanded, with the folded fade", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.route(`${ORIGIN}/**`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
      );
      await page.goto(`${ORIGIN}/?place=news&body=designed&scheme=dark`);
      const card = page.locator("[data-stream-item]").first();
      const clip = card.locator(".oh-message-clip");
      const frame = card.frameLocator(".mb-frame");
      await expect.poll(() => clip.getAttribute("data-shut")).toBe("");
      await frame.getByText("Weekend edition").waitFor({ state: "attached", timeout: 5000 });
      expect(await clip.evaluate((el) => getComputedStyle(el).maskImage)).toContain("linear-gradient");
      const filter = () => frame.locator("body").evaluate((el) => getComputedStyle(el).filter);
      expect(await filter()).toContain("invert");
      const gaps = await card.locator(".mb-frame").evaluate((frame) => {
        const pane = frame.closest(".oh-message")!.getBoundingClientRect();
        const design = (frame as HTMLIFrameElement)
          .contentDocument!.querySelector("table")!
          .getBoundingClientRect();
        const left = frame.getBoundingClientRect().left + design.left - pane.left;
        const right = pane.right - frame.getBoundingClientRect().left - design.right;
        return { imbalance: Math.abs(left - right), pane: pane.width, frame: frame.clientWidth };
      });
      expect(Math.abs(gaps.pane - gaps.frame)).toBeLessThanOrEqual(2);
      expect(gaps.imbalance).toBeLessThanOrEqual(2);
      await card.getByRole("button", { name: "Expand" }).click();
      await expect.poll(() => clip.getAttribute("data-shut")).toBeNull();
      expect(await filter()).toContain("invert");
    } finally {
      await page.close();
    }
  });

  it("a wheel reads what it carries past the 90 px line at once, the item it rests on after 0.6 s, nothing before", async () => {
    const { page, errors } = await open();
    await page.waitForTimeout(800);
    expect(await written(page)).toEqual([]);
    expect(await earned(page)).toEqual([]);
    const at = await geometry(page);
    await page.mouse.move(at.x, at.y);
    // Stop at 700 px so the third card’s first lines enter the reading band.
    await page.mouse.wheel(0, 700);
    await settled(page);
    const after = await geometry(page);
    expect(after.scrollTop).toBeGreaterThan(400);
    expect(after.above.length).toBeGreaterThan(0);
    // At once: exactly what was carried past the line.
    expect([...(await earned(page))].sort()).toEqual([...after.above].sort());
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
    expect([...(await earned(page))].sort()).toEqual([...stopped.above].sort());
    // After the rest: one more, the item the stream rests on, below the line.
    await page.waitForFunction(
      () => (globalThis as { streamRestReads?: string[] }).streamRestReads?.length,
      undefined,
      { timeout: 800 },
    );
    const rested = await page.evaluate(() => (globalThis as { streamRestReads: string[] }).streamRestReads);
    expect(rested).toHaveLength(1);
    expect(stopped.above).not.toContain(rested[0]);
    await expectWritten(page, stopped.above);
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
    const now = await earned(page);
    for (const id of after.above) expect(now).toContain(id);
    await expectWritten(page, after.above);
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
    // A read earned before End may still be queued in the stream's write batch.
    await page.waitForFunction(
      () => {
        const ids = (globalThis as { streamWrites?: string[][] }).streamWrites?.flat() ?? [];
        return ids.includes("n1") && ids.includes("n2");
      },
      undefined,
      { timeout: 5_000 },
    );
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
      const inView = (id: string) => {
        const card = sc.querySelector<HTMLElement>(`[data-stream-item="${id}"]`)?.getBoundingClientRect();
        return card !== undefined && card.bottom > box.top && card.top < box.bottom;
      };
      return {
        scrollTop: sc.scrollTop,
        screen: sc.clientHeight,
        n1InView: inView("n1"),
        finalCardInView: inView("n29"),
        distanceFromEnd: sc.scrollHeight - sc.clientHeight - sc.scrollTop,
      };
    });
    expect(landed.scrollTop).toBeGreaterThan(from.scrollTop + 2 * rest.screen);
    expect(rest.scrollTop).toBeGreaterThanOrEqual(landed.scrollTop - 2);
    expect(rest.n1InView).toBe(false);
    expect(rest.finalCardInView).toBe(true);
    expect(rest.distanceFromEnd).toBeLessThanOrEqual(2);
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

async function openMenuFixture(width = 1440, path = "/?place=news&body=short"): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width, height: 900 } });
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: path.startsWith("/reader") ? menuReaderHtml : html,
    }),
  );
  await page.goto(`${ORIGIN}${path}&device=${width < 500 ? "phone" : "desktop"}`);
  return page;
}

it.each(["pointer", MENU_KEY_CHORD, "ContextMenu"])(
  "opens the News row menu with %s",
  async (trigger) => {
    const page = await openMenuFixture();
    try {
      const row = page.locator('.oh-row[data-id="n1"]');
      if (trigger === "pointer") await row.click({ button: "right" });
      else await row.press(trigger);
      await page
        .getByRole("menu")
        .getByRole("menuitem", { name: "Open", exact: true })
        .waitFor({ timeout: 3000 });
      await page.keyboard.press("Escape");
      expect(await page.getByRole("menu").count()).toBe(0);
      expect(await row.evaluate((node) => node === document.activeElement)).toBe(true);
    } finally {
      await page.close();
    }
  },
  20_000,
);

it.each([1440, 390])(
  "opens the addressed message menu at %i px and leaves body text selectable",
  async (width) => {
    const page = await openMenuFixture(width);
    try {
      const card = page.locator('[data-stream-item="n1"]');
      await card.locator(".oh-messagehead").click({ button: "right" });
      await page
        .getByRole("menu")
        .getByRole("menuitem", { name: "Reply", exact: true })
        .waitFor({ timeout: 3000 });
      await page.keyboard.press("Escape");
      const body = card.locator(".oh-message-body").first();
      expect(
        await body.evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          const text = selection.toString();
          const native = node.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
          );
          return native && text.length > 0 && selection.toString() === text;
        }),
      ).toBe(true);
      expect(await page.getByRole("menu").count()).toBe(0);
    } finally {
      await page.close();
    }
  },
  20_000,
);

it("the sidebar opens the focused place's menu and restores focus", async () => {
  const page = await openMenuFixture();
  try {
    const news = page.locator('[data-rail-id="news"] button');
    await news.press(MENU_KEY_CHORD);
    const menu = page.getByRole("menu");
    await menu.getByRole("menuitem", { name: "Open", exact: true }).waitFor({ timeout: 3000 });
    await page.keyboard.press("Escape");
    expect(await news.evaluate((node) => node === document.activeElement)).toBe(true);
  } finally {
    await page.close();
  }
}, 20_000);

it("the context menu of an attachment offers its existing preview and download", async () => {
  const page = await openMenuFixture(1440, "/reader?open=lt-invoice");
  try {
    const file = page.locator(".oh-file-main").first();
    await file.press("ContextMenu");
    const menu = page.getByRole("menu");
    await menu.getByRole("menuitem", { name: /^Preview / }).waitFor({ timeout: 3000 });
    expect(await menu.getByRole("menuitem", { name: /^Download / }).count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(await file.evaluate((node) => node === document.activeElement)).toBe(true);
  } finally {
    await page.close();
  }
}, 20_000);

it("a message in a thread opens its own menu without taking the HTML frame's native menu", async () => {
  const page = await openMenuFixture(1440, "/reader?hostile=1&open=h-letin&screen=reading");
  try {
    const message = page.locator('[data-conv-id="h-unconfirmed"]');
    const sender = message.locator(".oh-messagehead-sender");
    await sender.press(MENU_KEY_CHORD);
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Reply", exact: true })
      .waitFor({ timeout: 3000 });
    await page.keyboard.press("Escape");
    expect(await sender.evaluate((node) => node === document.activeElement)).toBe(true);
    const frame = message.frameLocator("iframe");
    expect(
      await frame
        .locator("body")
        .evaluate((node) =>
          node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
        ),
    ).toBe(true);
    expect(await page.getByRole("menu").count()).toBe(0);
  } finally {
    await page.close();
  }
}, 20_000);

it("a recoverable attachment offers its existing retry from the menu key", async () => {
  const page = await openMenuFixture(1440, "/reader?open=lt-files&state=server");
  try {
    const attachment = page.locator('.oh-file[data-state="failed"]');
    const retry = attachment.getByRole("button");
    const label = (await retry.innerText()).trim();
    expect(label.length).toBeGreaterThan(0);
    await retry.press(MENU_KEY_CHORD);
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: label, exact: true })
      .waitFor({ timeout: 3000 });
    await page.keyboard.press("Escape");
    expect(await retry.evaluate((node) => node === document.activeElement)).toBe(true);
  } finally {
    await page.close();
  }
}, 20_000);
