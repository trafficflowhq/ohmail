/**
 * THE OPENED LETTER STAYS ON THE READING LINE WHILE THE LETTERS ABOVE IT GET THEIR PICTURES, in a real browser
 * (`thread-pictures-page.tsx`): a long conversation of framed replies, the embedded pictures arriving one part at a
 * time after the open, as the engine delivers them. The gap is read after each frame is painted (a task posted from
 * the frame's callback runs once that frame is drawn): a plain frame callback reads the layout before the column's
 * own observer has corrected it, which no person ever sees.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readerStatesPage } from "./reader-states.mjs";

const requireFromRoot = createRequire(resolve(process.cwd(), "package.json"));
const { chromium, webkit } = requireFromRoot("@playwright/test") as typeof import("@playwright/test");
type Page = import("@playwright/test").Page;
type Browser = import("@playwright/test").Browser;

const ORIGIN = "https://thread-pictures.example";
const LINE_GAP = 14;
const NEWEST = "tp7";
const WIDTHS = [
  { width: 1440, height: 900, device: "desktop" },
  { width: 1100, height: 800, device: "desktop" },
  { width: 390, height: 844, device: "phone" },
] as const;
type Painted = { t: number; gap: number };

const svg = (w: number, h: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#7a8"/></svg>`;

/** Open the conversation and start reading the newest letter's gap to the reading line after every paint. */
async function open(browser: Browser, view: { width: number; height: number }, query: string): Promise<Page> {
  const page = await browser.newPage({ viewport: view, reducedMotion: "reduce" });
  const html = await pageHtml();
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname !== "/img") return route.fulfill({ contentType: "text/html", body: html });
    const banner = url.searchParams.get("name") === "banner.png";
    return route.fulfill({ contentType: "image/svg+xml", body: banner ? svg(600, 150) : svg(200, 60) });
  });
  await page.goto(`${ORIGIN}/?${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((id) => {
    const painted: { t: number; gap: number }[] = [];
    Object.assign(window, { painted });
    const start = (window as Window & { pageStart?: number }).pageStart ?? 0;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const letter = document.querySelector<HTMLElement>(`[data-reading-scroll] [data-conv-id="${id}"]`);
      if (!letter) return;
      const port = letter.closest<HTMLElement>("[data-reading-scroll]")!;
      const head = port.querySelector(".oh-readinghead");
      const line =
        head && getComputedStyle(head).position === "sticky"
          ? head.getBoundingClientRect().bottom
          : port.getBoundingClientRect().top;
      painted.push({
        t: Math.round(performance.now() - start),
        gap: letter.getBoundingClientRect().top - line,
      });
    };
    const tick = () => {
      channel.port2.postMessage(0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, NEWEST);
  await page.getByRole("button", { name: "Autumn stay" }).click();
  return page;
}

let built: Promise<string> | null = null;
const pageHtml = () => (built ??= readerStatesPage("packages/app/test/states/thread-pictures-page.tsx"));

const painted = (page: Page) =>
  page.evaluate(() => (window as Window & { painted?: Painted[] }).painted ?? []);
const arrivals = (page: Page) =>
  page.evaluate(() =>
    ((window as Window & { pictureEvents?: { e: string }[] }).pictureEvents ?? [])
      .map((x) => x.e)
      .filter((e) => e.startsWith("cid ")),
  );
const worst = (gaps: Painted[], at: number) => Math.max(...gaps.map((p) => Math.abs(p.gap - at)));
const largestMove = (gaps: Painted[]) =>
  Math.max(0, ...gaps.slice(1).map((p, i) => Math.abs(p.gap - gaps[i]!.gap)));
const show = (gaps: Painted[]) =>
  gaps
    .filter((p, i) => i === 0 || Math.abs(p.gap - gaps[i - 1]!.gap) > 1)
    .slice(0, 12)
    .map((p) => `${p.t}ms ${Math.round(p.gap)}`)
    .join(", ");

export function threadPictureCases() {
  describe("the opened letter while the letters above get their pictures", () => {
    beforeAll(async () => {
      await pageHtml();
    }, 120_000);

    for (const [browserName, engine] of [
      ["chromium", chromium],
      ["webkit", webkit],
    ] as const) {
      describe.runIf(existsSync(engine.executablePath()))(browserName, () => {
        let browser: Browser;
        beforeAll(async () => {
          browser = await engine.launch();
        }, 120_000);
        afterAll(async () => {
          await browser?.close();
        });

        it.each(
          WIDTHS.flatMap((view) =>
            ["paper", "ohmarchy"].flatMap((face) =>
              ["auto", "blocked"].map((consent) => ({ ...view, face, consent })),
            ),
          ),
        )(
          "stays on the reading line at $width in $face with pictures $consent while batches arrive above",
          async ({ width, height, device, face, consent }) => {
            const page = await open(
              browser,
              { width, height },
              `device=${device}&face=${face}&consent=${consent}`,
            );
            try {
              await page.waitForTimeout(10_000);
              const gaps = await painted(page);
              const above = (await arrivals(page)).filter((e) => e !== `cid ${NEWEST}`);
              const world = await page.evaluate((id) => {
                const port = document.querySelector<HTMLElement>("[data-reading-scroll]")!;
                const letters = [...port.querySelectorAll<HTMLElement>("[data-conv-id]")];
                return {
                  framed: letters.filter((l) => l.querySelector("iframe")).length,
                  earliest: letters[0]!.getBoundingClientRect().height,
                  newest: port.querySelector(`[data-conv-id="${id}"]`)!.getBoundingClientRect().height,
                  view: port.clientHeight,
                };
              }, NEWEST);
              expect(world.framed, "every letter is a framed reply").toBe(8);
              expect(world.earliest, "the earliest letter is thousands of pixels tall").toBeGreaterThan(3000);
              expect(world.newest, "the newest letter is shorter than the column").toBeLessThan(world.view);
              expect(above.length, "picture batches arrived above the opened letter").toBeGreaterThan(2);
              expect(worst(gaps, LINE_GAP), `painted gaps: ${show(gaps)}`).toBeLessThanOrEqual(2);
            } finally {
              await page.close();
            }
          },
          40_000,
        );

        it.each(WIDTHS)(
          "never moves a newest letter taller than the column at $width while batches arrive above",
          async ({ width, height, device }) => {
            const page = await open(browser, { width, height }, `device=${device}&newest=tall`);
            try {
              await page.waitForTimeout(10_000);
              const gaps = await painted(page);
              const newest = await page
                .locator(`[data-conv-id="${NEWEST}"]`)
                .evaluate(
                  (l) => l.getBoundingClientRect().height - l.closest("[data-reading-scroll]")!.clientHeight,
                );
              expect(newest, "the newest letter is taller than the column").toBeGreaterThan(0);
              expect((await arrivals(page)).length, "picture batches arrived").toBeGreaterThan(2);
              expect(
                Math.abs(gaps[0]!.gap - LINE_GAP),
                `first painted gap: ${show(gaps)}`,
              ).toBeLessThanOrEqual(2);
              expect(largestMove(gaps), `painted gaps: ${show(gaps)}`).toBeLessThanOrEqual(1);
            } finally {
              await page.close();
            }
          },
          40_000,
        );

        it.each(WIDTHS)(
          "paints a short newest letter on the reading line from its first frame at $width",
          async ({ width, height, device }) => {
            const page = await open(browser, { width, height }, `device=${device}&lat=0`);
            try {
              await page.waitForTimeout(3_000);
              const gaps = await painted(page);
              expect(gaps.length).toBeGreaterThan(10);
              expect(worst(gaps, LINE_GAP), `painted gaps: ${show(gaps)}`).toBeLessThanOrEqual(2);
            } finally {
              await page.close();
            }
          },
          30_000,
        );

        // This page's file door is a stand-in that moves a `first` ask to the front of its own line, so this case
        // covers only the handoff: the letter on screen tells the files seam its pictures come first. The order of
        // the engine's real line is held by client-engine's inline-images-first.test.ts.
        it("draws the opened letter's own picture in the first pass, before the letters above", async () => {
          const page = await open(browser, { width: 1440, height: 900 }, "device=desktop");
          try {
            await expect
              .poll(async () => (await arrivals(page)).includes(`cid ${NEWEST}`), { timeout: 8_000 })
              .toBe(true);
            const order = await arrivals(page);
            expect(order.indexOf(`cid ${NEWEST}`), `arrivals: ${order.join(", ")}`).toBeLessThanOrEqual(1);
            const picture = page
              .locator(`[data-conv-id="${NEWEST}"]`)
              .frameLocator("iframe")
              .locator('img[width="507"]');
            await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(507);
          } finally {
            await page.close();
          }
        }, 30_000);

        it.each([WIDTHS[0], WIDTHS[2]])(
          "moves the letter by exactly a wheel gesture at $width, and no further as batches keep arriving",
          async ({ width, height, device }) => {
            const page = await open(browser, { width, height }, `device=${device}`);
            try {
              await page.waitForTimeout(2_500);
              const before = (await painted(page)).at(-1)!.gap;
              const box = (await page.locator("[data-reading-scroll]").boundingBox())!;
              await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
              await page.mouse.wheel(0, -300);
              // A browser may deliver the gesture a few frames late: read from the frame it took effect.
              const last = async () => (await painted(page)).at(-1)!;
              await expect.poll(async () => (await last()).gap).toBeGreaterThan(before + 150);
              const movedAt = (await last()).t;
              await page.waitForTimeout(7_000);
              const after = (await painted(page)).filter((p) => p.t > movedAt + 300);
              expect(after.length).toBeGreaterThan(10);
              expect(
                worst(after, before + 300),
                `painted after the wheel: ${show(after)}`,
              ).toBeLessThanOrEqual(2);
            } finally {
              await page.close();
            }
          },
          30_000,
        );
      });
    }
  });
}
