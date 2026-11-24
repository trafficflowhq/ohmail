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
  const params = new URLSearchParams(query);
  const place = params.get("place");
  const ready = {
    settings: params.has("menu") ? "Settings" : "Settings view",
    reader: "Letter view",
    calendar: "Calendar month",
  }[place as "settings" | "reader" | "calendar"];
  if (ready) await page.getByRole("heading", { name: ready }).waitFor();
  else await page.waitForSelector("[role=option][data-id]", { timeout: 15_000 });
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

  it("a swipe from a row at the leading edge only opens the drawer", async () => {
    const { page } = await open();
    try {
      // Give both listeners the same real row as a target, with an edge origin regardless of list inset.
      await page
        .locator("[role=option][data-id]")
        .first()
        .evaluate((row) => {
          const y = row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
          const send = (type: string, x: number) =>
            row.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                pointerType: "touch",
                pointerId: 1,
                isPrimary: true,
                button: 0,
                clientX: x,
                clientY: y,
              }),
            );
          send("pointerdown", 10);
          send("pointermove", 155);
          send("pointerup", 155);
        });
      await expect.poll(() => page.getByRole("dialog", { name: "More" }).count()).toBe(1);
      expect(await saidOf(page)).toMatchObject({ marked: [], opened: [], acted: [], picked: 0 });
    } finally {
      await page.context().close();
    }
  }, 15_000);

  it.each([390, 719])(
    "opens from the edge of each compact surface at %i px",
    async (width) => {
      for (const place of ["list", "reader", "settings", "calendar"]) {
        const { page, cdp, errors } = await open(`place=${place}`, width);
        try {
          const drawer = page.getByRole("dialog", { name: "More" });
          const heading =
            place === "calendar"
              ? await page.getByRole("heading", { name: "Calendar month" }).boundingBox()
              : null;
          const y = heading ? heading.y + heading.height / 2 : 240;
          await run(cdp, { x: 5, y }, { x: 145, y: 3 });
          await expect.poll(() => drawer.count(), { message: place }).toBe(1);
          await run(cdp, { x: 245, y: 240 }, { x: -148, y: 1 });
          await expect.poll(() => drawer.count(), { message: place }).toBe(0);
          expect(await saidOf(page)).toMatchObject({ marked: [], opened: [], acted: [] });
          expect(errors).toEqual([]);
        } finally {
          await page.context().close();
        }
      }
    },
    60_000,
  );

  it.each(
    [390, 884].flatMap((width) =>
      [
        ["list", "Ohbox"],
        ["reader", "Letter body"],
        ["settings", "Settings view"],
        ["calendar", "Calendar month"],
      ].map(([place, heading]) => ({ width, place, heading })),
    ),
  )(
    "opens from inside $place at $width px",
    async ({ width, place, heading }) => {
      const { page, cdp, errors } = await open(`place=${place}`, width);
      try {
        const surface = page.getByRole(place === "reader" ? "region" : "heading", {
          name: heading,
          exact: true,
        });
        await surface.tap({ trial: true, timeout: 3000 });
        const box = (await surface.boundingBox({ timeout: 3000 }))!;
        const x = Math.max(120, box.x + 16);
        const y = box.y + box.height / 2;
        await run(cdp, { x, y }, { x: 145, y: 3 });
        await expect.poll(() => page.getByRole("dialog", { name: "More" }).count()).toBe(1);
        expect(await saidOf(page)).toMatchObject({ marked: [], opened: [], acted: [] });
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    },
    15_000,
  );

  it("keeps a rightward swipe on the calendar month for the previous month", async () => {
    const { page, cdp } = await open("place=calendar");
    try {
      const date = page.getByRole("button", { name: /\b12 August\b/ });
      const box = (await date.boundingBox({ timeout: 3000 }))!;
      await run(cdp, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: 140, y: 0 });
      await expect.poll(() => page.getByRole("button", { name: /\b1 July\b/ }).count()).toBe(1);
      expect(await page.getByRole("dialog", { name: "More" }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 15_000);

  it.each(["settings", "calendar"])(
    "opens inside the %s scroll surface",
    async (place) => {
      const { page, cdp } = await open(`place=${place}&menu`);
      try {
        const ground =
          place === "settings"
            ? page.getByRole("button", { name: "AI" })
            : page.getByText("Nothing", { exact: true });
        const box = (await ground.boundingBox({ timeout: 3000 }))!;
        await run(cdp, { x: 120, y: box.y + box.height / 2 }, { x: 145, y: 3 });
        await expect.poll(() => page.getByRole("dialog", { name: "More" }).count()).toBe(1);
      } finally {
        await page.context().close();
      }
    },
    15_000,
  );

  it("leaves editable controls, horizontal scrolling and selected text to the page", async () => {
    const { page, cdp } = await open("place=settings&controls");
    const drawer = page.getByRole("dialog", { name: "More" });
    try {
      for (const name of ["Name", "Notes", "Signature"]) {
        const box = (await page.getByRole("textbox", { name }).boundingBox())!;
        await run(cdp, { x: box.x + 10, y: box.y + box.height / 2 }, { x: 140, y: 0 });
        expect(await drawer.count()).toBe(0);
      }

      const preview = page.getByRole("region", { name: "Preview" });
      await preview.evaluate((el) => {
        el.scrollLeft = 250;
      });
      const box = (await preview.boundingBox())!;
      await run(cdp, { x: box.x + 50, y: box.y + box.height / 2 }, { x: 140, y: 0 });
      await expect.poll(() => preview.evaluate((el) => el.scrollLeft)).toBeLessThan(250);
      expect(await drawer.count()).toBe(0);

      const heading = page.getByRole("heading", { name: "Settings view" });
      await heading.evaluate((el) => getSelection()!.selectAllChildren(el));
      const title = (await heading.boundingBox())!;
      await run(cdp, { x: 120, y: title.y + title.height / 2 }, { x: 140, y: 0 });
      expect(await drawer.count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 15_000);

  it.each([
    [390, "paper", "light"],
    [390, "paper", "dark"],
    [390, "ohmarchy", "light"],
    [390, "ohmarchy", "dark"],
    [719, "paper", "light"],
    [719, "paper", "dark"],
    [719, "ohmarchy", "light"],
    [719, "ohmarchy", "dark"],
  ] as const)(
    "settles without flashing at %i px in %s %s",
    async (width, face, scheme) => {
      const { page, cdp } = await open(`motion=full&dock=full&face=${face}&scheme=${scheme}`, width);
      try {
        const drawer = page.locator(".fr-railsheet");
        const handle = (await page.getByRole("button", { name: "More", exact: true }).boundingBox())!;
        for (const direction of [1, -1]) {
          const x = direction === 1 ? handle.x + handle.width / 2 : 245;
          const y = direction === 1 ? handle.y + handle.height / 2 : 240;
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          for (const step of [24, 70, 120]) {
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: x + step * direction, y }],
            });
          }
          const held = direction === 1 ? -180 : -120;
          await expect
            .poll(async () => (await drawer.boundingBox({ timeout: 1000 }))?.x, {
              message: "the panel follows the finger while held",
            })
            .toBeCloseTo(held, 0);
          const frames = page.evaluate(async () => {
            const result: { reveal: number; dim: number; surface: boolean }[] = [];
            const end = performance.now() + 420;
            do {
              await new Promise(requestAnimationFrame);
              const panel = document.querySelector(".fr-railsheet");
              const sc = panel?.parentElement;
              const frame = document.querySelector(".fr-frame")!;
              result.push({
                reveal: Math.max(0, panel?.getBoundingClientRect().right ?? 0),
                dim: sc ? Number(getComputedStyle(sc, "::before").opacity) : 0,
                surface:
                  frame.getBoundingClientRect().height > 0 &&
                  getComputedStyle(frame).visibility === "visible" &&
                  getComputedStyle(frame).opacity === "1",
              });
            } while (performance.now() < end);
            return result;
          });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          const samples = await frames;
          expect(samples.length).toBeGreaterThan(3);
          expect(samples.every(({ surface }) => surface)).toBe(true);
          expect(
            samples.some(({ reveal }) =>
              direction === 1 ? reveal > 125 && reveal < 295 : reveal > 5 && reveal < 175,
            ),
          ).toBe(true);
          for (let k = 1; k < samples.length; k++) {
            expect((samples[k]!.reveal - samples[k - 1]!.reveal) * direction).toBeGreaterThanOrEqual(-1);
            expect((samples[k]!.dim - samples[k - 1]!.dim) * direction).toBeGreaterThanOrEqual(-0.02);
          }
          expect(samples.at(-1)).toMatchObject({
            reveal: direction === 1 ? 300 : 0,
            dim: direction === 1 ? 1 : 0,
          });
        }
      } finally {
        await page.context().close();
      }
    },
    20_000,
  );

  it("opens available Trash from More on the unfolded phone", async () => {
    const { page } = await open("dock=full", 884);
    await page.getByRole("button", { name: "More", exact: true }).tap();
    const drawer = page.getByRole("dialog", { name: "More" });
    await drawer.getByRole("button", { name: "Trash", exact: true }).tap({ timeout: 3000 });
    await page.getByRole("heading", { name: "Trash", exact: true }).waitFor();
    await drawer.waitFor({ state: "hidden" });
    await page.context().close();
  }, 10_000);

  it("opens on a tap of More during a short drag's snap back", async () => {
    const { page, cdp } = await open("motion=full");
    try {
      const more = (await page.getByRole("button", { name: "More", exact: true }).boundingBox())!;
      const x = more.x + more.width / 2;
      const y = more.y + more.height / 2;
      await run(
        cdp,
        { x, y },
        { x: 42, y: 0 },
        {
          rest: 120,
          afterRelease: () => page.touchscreen.tap(x, y),
        },
      );
      const drawer = page.getByRole("dialog", { name: "More" });
      await expect.poll(async () => (await drawer.boundingBox({ timeout: 1000 }))?.x).toBeCloseTo(0, 0);
      await page.keyboard.press("Escape");
      await expect.poll(() => drawer.count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 15_000);

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
