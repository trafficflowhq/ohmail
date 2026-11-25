import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readerStatesPage } from "./reader-states.mjs";

const requireFromRoot = createRequire(resolve(process.cwd(), "package.json"));
const { chromium, webkit } = requireFromRoot("@playwright/test") as typeof import("@playwright/test");
const ORIGIN = "https://reader-layout.example";
const WIDTHS = [
  { width: 1440, height: 900, device: "desktop" },
  { width: 1100, height: 900, device: "desktop" },
  { width: 390, height: 844, device: "phone" },
] as const;
const PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAWgAAAEYAQAAAABZvFG5AAAAQ0lEQVR4nO3KMQEAAAgDoFWzuNnM4Ktwk8qGbdu2bdu2bdu2bdu2bdu2bdv2nd22bdu2bdu2bdu2bdu2bdu2bds/9wATI4t1M77hWQAAAABJRU5ErkJggg==",
  "base64",
);
const SHORT_PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAWgAAAAoAQMAAADpBPJOAAAABlBMVEWrvtGNoLaCSxLoAAAAHElEQVR4nGMIJQUwjKoeVT2qelT1qOpR1SNSNQBYzFXHthEkYwAAAABJRU5ErkJggg==",
  "base64",
);

function readingGap(letter: Element) {
  const port = letter.closest("[data-reading-scroll]")!;
  const head = port.querySelector(".oh-readinghead");
  const top =
    head && getComputedStyle(head).position === "sticky"
      ? head.getBoundingClientRect().bottom
      : port.getBoundingClientRect().top;
  return letter.getBoundingClientRect().top - top;
}

export function readerLayoutCases() {
  describe("reader layout", () => {
    let html: string;
    beforeAll(async () => {
      html = await readerStatesPage("packages/app/test/states/squares-reader-1-page.tsx");
    }, 120_000);

    for (const [browserName, engine] of [
      ["chromium", chromium],
      ["webkit", webkit],
    ] as const) {
      describe.runIf(existsSync(engine.executablePath()))(browserName, () => {
        let browser: Awaited<ReturnType<typeof engine.launch>>;
        beforeAll(async () => {
          browser = await engine.launch();
        }, 120_000);
        afterAll(async () => {
          await browser?.close();
        });

        it.each([
          { device: "desktop", width: 1440, height: 900, picture: "tall" },
          { device: "phone", width: 390, height: 844, picture: "tall" },
          { device: "phone", width: 390, height: 844, picture: "short" },
        ])(
          "keeps the opened letter steady and aligns its content on $device with a $picture picture",
          async ({ device, width, height, picture }) => {
            const context = await browser.newContext({
              viewport: { width, height },
              reducedMotion: "reduce",
            });
            const page = await context.newPage();
            const below = Promise.withResolvers<void>();
            const above = Promise.withResolvers<void>();
            try {
              await page.route("**/*", async (route) => {
                const url = new URL(route.request().url());
                if (url.origin !== ORIGIN) return route.abort();
                if (url.pathname !== "/img") return route.fulfill({ contentType: "text/html", body: html });
                const name = url.searchParams.get("name");
                if (name === "below.png") await below.promise;
                if (name === "above.png") await above.promise;
                return route.fulfill({
                  contentType: "image/png",
                  body: name === "below.png" && picture === "short" ? SHORT_PHOTO : PHOTO,
                });
              });
              await page.goto(
                `${ORIGIN}/?latePictures&n=6&device=${device}${picture === "short" ? "&short" : ""}`,
              );
              await page.getByRole("button", { name: "Q3 plan" }).click();
              const opened = page.locator('[data-conv-id="w5"][aria-current="true"]');
              const older = page.locator('[data-conv-id="w0"]');
              const photo = (letter: typeof opened) =>
                letter.frameLocator("iframe").getByRole("img", { name: "Project photo" });
              const inFlight = (image: ReturnType<typeof photo>) =>
                image.evaluate((el: HTMLImageElement) => !el.complete && el.src.includes("/img?"));
              await expect.poll(() => inFlight(photo(opened))).toBe(true);
              await expect.poll(() => inFlight(photo(older))).toBe(true);
              await page.evaluate(() => document.fonts.ready);
              const start = await opened.evaluate((letter) => {
                const port = letter.closest("[data-reading-scroll]")!;
                const head = port.querySelector(".oh-readinghead");
                const sticky = head !== null && getComputedStyle(head).position === "sticky";
                const gaps: number[] = [];
                const record = () => {
                  const line = sticky
                    ? head.getBoundingClientRect().bottom
                    : port.getBoundingClientRect().top;
                  gaps.push(letter.getBoundingClientRect().top - line);
                  if (letter.isConnected) requestAnimationFrame(record);
                };
                Object.assign(window, { readerGaps: gaps });
                record();
                const avatar = letter.querySelector(".oh-messagehead .oh-avatar")!.getBoundingClientRect();
                const files = letter.querySelector(".oh-files")!.getBoundingClientRect();
                const frame = letter.querySelector("iframe")!;
                const text = frame.contentDocument!.querySelector("p")!.getBoundingClientRect();
                const plain = letter.previousElementSibling!;
                const plainText = plain.querySelector(".msg-p")!.getBoundingClientRect();
                const plainAvatar = plain
                  .querySelector(".oh-messagehead .oh-avatar")!
                  .getBoundingClientRect();
                return {
                  gap: gaps[0]!,
                  avatar: avatar.left,
                  files: files.left,
                  text: frame.getBoundingClientRect().left + text.left,
                  plain: plainText.left - plainAvatar.left,
                };
              });
              const waiting = await photo(opened).evaluate((el) => el.getBoundingClientRect().height);
              const captures = picture === "tall" ? process.env.OHMAIL_READER_CAPTURES : undefined;
              if (captures) {
                mkdirSync(captures, { recursive: true });
                await page.screenshot({ path: join(captures, `${browserName}-${device}-waiting.png`) });
              }
              below.resolve();
              await expect
                .poll(() => photo(opened).evaluate((el: HTMLImageElement) => el.naturalHeight))
                .toBe(picture === "short" ? 40 : 280);
              // On desktop the upper picture arrives after the reader's opening window has ended.
              await page.waitForTimeout(device === "desktop" ? 6100 : 200);
              if (device === "desktop" || picture === "short") {
                await page.keyboard.press("Shift");
                expect
                  .soft(
                    Math.abs((await opened.evaluate(readingGap)) - (picture === "short" ? start.gap : 14)),
                    "a modifier key preserves the position",
                  )
                  .toBeLessThanOrEqual(2);
              }
              const beforeAbove = await opened.evaluate(readingGap);
              above.resolve();
              await expect
                .poll(() => photo(older).evaluate((el: HTMLImageElement) => el.naturalHeight))
                .toBe(280);
              await page.waitForTimeout(200);
              if (captures)
                await page.screenshot({ path: join(captures, `${browserName}-${device}-loaded.png`) });

              expect
                .soft(
                  Math.abs((await opened.evaluate(readingGap)) - beforeAbove),
                  "the visible letter stays put when the older picture arrives",
                )
                .toBeLessThanOrEqual(2);
              const gaps = await page.evaluate(
                () => (window as Window & { readerGaps?: number[] }).readerGaps!,
              );
              const movement = Math.max(
                ...gaps.map((gap) => Math.abs(gap - (picture === "short" ? start.gap : 14))),
              );
              if (process.env.OHMAIL_READER_CAPTURES) {
                console.info("reader drift", browserName, width, picture, movement);
              }
              expect.soft(Math.abs(start.text - start.avatar), "HTML body and avatar").toBeLessThanOrEqual(1);
              expect.soft(Math.abs(start.plain), "plain body and avatar").toBeLessThanOrEqual(1);
              expect
                .soft(Math.abs(start.files - start.avatar), "attachments and avatar")
                .toBeLessThanOrEqual(1);
              expect
                .soft(waiting, "the image reserves room while the bytes are in flight")
                .toBeGreaterThan(0);
              expect(movement, "opened letter drift across both loads").toBeLessThanOrEqual(2);
              if (device === "desktop") {
                const port = page.locator("[data-reading-scroll]");
                const box = (await port.boundingBox())!;
                const scroll = () => port.evaluate((el) => el.scrollTop);
                const beforeWheel = await scroll();
                await page.mouse.move(box.x + box.width / 2, box.y + 120);
                await page.mouse.wheel(0, -240);
                await expect
                  .poll(async () => Math.abs((await scroll()) - (beforeWheel - 240)))
                  .toBeLessThanOrEqual(1);
                const earlier = page.locator('[data-conv-id="w4"]');
                const beforeBody = await earlier.evaluate(readingGap);
                await page.evaluate(() =>
                  (window as Window & { deliverEarlierBody(): void }).deliverEarlierBody(),
                );
                await page.getByText("Earlier details", { exact: true }).waitFor({ state: "attached" });
                await page.evaluate(
                  () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
                );
                expect(
                  Math.abs((await earlier.evaluate(readingGap)) - beforeBody),
                  "a body above the viewport preserves the position chosen by scrolling",
                ).toBeLessThanOrEqual(2);
              }
              if (picture === "short") {
                await page.keyboard.press("End");
                const port = page.locator("[data-reading-scroll]");
                await expect
                  .poll(() =>
                    port.evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop),
                  )
                  .toBeLessThanOrEqual(2);
              }
            } finally {
              above.resolve();
              below.resolve();
              await context.close();
            }
          },
          40_000,
        );

        it.each([...WIDTHS.map((view) => ({ ...view, face: "paper" })), { ...WIDTHS[0], face: "ohmarchy" }])(
          "aligns plain mail, centers the designed letter at $width in $face, and shows small pictures at their natural size after consent",
          async ({ width, height, device, face }) => {
            const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
            const imageBytes = Promise.withResolvers<void>();
            let pictures = 0;
            try {
              await page.route("**/*", async (route) => {
                const url = new URL(route.request().url());
                if (url.origin !== ORIGIN) return route.abort();
                if (url.pathname !== "/img") return route.fulfill({ contentType: "text/html", body: html });
                pictures += 1;
                await imageBytes.promise;
                return route.fulfill({
                  contentType: "image/svg+xml",
                  body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="navy"/></svg>',
                });
              });
              await page.goto(`${ORIGIN}/?readerEdges&n=6&device=${device}&face=${face}`);
              await page.getByRole("button", { name: "Q3 plan" }).click();
              const opened = page.locator('[data-conv-id="w5"]');
              const image = opened.frameLocator("iframe").locator('img[alt="Project icon"]');
              await image.waitFor({ state: "attached", timeout: 5000 });
              expect(pictures, "the proxy has no request before consent").toBe(0);

              const geometry = await opened.evaluate((letter) => {
                const article = letter.querySelector(".oh-message")!.getBoundingClientRect();
                const avatar = letter.querySelector(".oh-messagehead .oh-avatar")!.getBoundingClientRect();
                const files = letter.querySelector(".oh-files")!.getBoundingClientRect();
                const invitation = letter.querySelector(".rd-invitation")!.getBoundingClientRect();
                const frame = letter.querySelector("iframe")!;
                const paper = frame.getBoundingClientRect();
                const text = frame.contentDocument!.querySelector("p")!.getBoundingClientRect();
                const plain = letter.previousElementSibling!;
                return {
                  avatar: avatar.left,
                  files: files.left,
                  invitation: invitation.left,
                  textCenter: paper.left + (text.left + text.right) / 2,
                  plain: plain.querySelector(".msg-p")!.getBoundingClientRect().left,
                  sheetLeft: article.left,
                  sheetRight: article.right,
                  paperLeft: paper.left,
                  paperRight: paper.right,
                };
              });
              if (process.env.OHMAIL_READER_CAPTURES) {
                console.info("reader geometry", browserName, width, JSON.stringify(geometry));
              }
              expect.soft(geometry.plain, "plain body at the avatar edge").toBeCloseTo(geometry.avatar, 0);
              expect
                .soft(geometry.textCenter, "designed content is centered on its paper")
                .toBeCloseTo((geometry.paperLeft + geometry.paperRight) / 2, 0);
              expect
                .soft(geometry.files, "attachments at the invitation edge")
                .toBeCloseTo(geometry.invitation, 0);
              expect
                .soft(geometry.invitation, "invitation at the avatar edge")
                .toBeCloseTo(geometry.avatar, 0);
              expect
                .soft(geometry.paperLeft, "paper at the left sheet edge")
                .toBeCloseTo(geometry.sheetLeft, 0);
              expect
                .soft(geometry.paperRight, "paper at the right sheet edge")
                .toBeCloseTo(geometry.sheetRight, 0);

              const sized = opened.frameLocator("iframe").getByRole("img", { name: "Sized icon" });
              const sizedHeight = () => sized.evaluate((img) => img.getBoundingClientRect().height);
              expect.soft(await sizedHeight(), "a blocked picture keeps its declared ratio").toBe(48);
              expect
                .soft(
                  await image.evaluate((el) => el.getBoundingClientRect().height),
                  "blocked picture strip",
                )
                .toBe(14);
              const unread = page.locator('[data-conv-id="w3"]');
              const missing = unread.frameLocator("iframe").getByRole("img", { name: "Unavailable logo" });
              await missing.waitFor({ state: "attached" });
              expect
                .soft(
                  await missing.evaluate((el) => el.getBoundingClientRect().height),
                  "unavailable picture strip",
                )
                .toBe(14);
              const unreadGeometry = await unread.evaluate((letter) => {
                const article = letter.querySelector(".oh-message[data-unread]")!;
                const frame = article.querySelector("iframe")!;
                const paper = frame.getBoundingClientRect();
                const text = frame.contentDocument!.querySelector("p")!.getBoundingClientRect();
                return {
                  paperOffset: paper.left - article.getBoundingClientRect().left,
                  bar: parseFloat(getComputedStyle(article).getPropertyValue("--new-bar")),
                  textCenter: paper.left + (text.left + text.right) / 2,
                  paperCenter: (paper.left + paper.right) / 2,
                };
              });
              if (face === "ohmarchy") expect(unreadGeometry.bar).toBeGreaterThan(0);
              expect
                .soft(unreadGeometry.paperOffset, "paper begins after the unread bar")
                .toBeCloseTo(unreadGeometry.bar, 0);
              expect
                .soft(unreadGeometry.textCenter, "unread designed content is centered after the bar")
                .toBeCloseTo(unreadGeometry.paperCenter, 0);

              await opened.getByRole("button", { name: /show images/i }).press("Enter", { timeout: 5000 });
              await expect.poll(() => pictures).toBe(2);
              expect(await image.evaluate((img) => img.getBoundingClientRect().height)).toBeGreaterThan(24);
              expect.soft(await sizedHeight(), "a waiting picture reserves its declared ratio").toBe(48);
              imageBytes.resolve();
              await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(24);
              await expect
                .poll(() => image.evaluate((img) => img.getBoundingClientRect().height), {
                  message: "a loaded width-only small picture is drawn at its natural height",
                })
                .toBe(24);
              await expect
                .poll(sizedHeight, { message: "the natural ratio wins when the picture loads" })
                .toBe(24);
            } finally {
              imageBytes.resolve();
              await page.close();
            }
          },
          30_000,
        );

        it.each([WIDTHS[0], WIDTHS[2]])(
          "reaches the reading line at $width when the latest body arrives after the open",
          async ({ width, height, device }) => {
            const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
            try {
              await page.route(`${ORIGIN}/**`, (route) =>
                route.fulfill({ contentType: "text/html", body: html }),
              );
              await page.goto(`${ORIGIN}/?lateBody&n=6&device=${device}`);
              await page.getByRole("button", { name: "Q3 plan" }).click();
              const opened = page.locator('[data-conv-id="w5"][aria-current="true"]');
              const gap = () => opened.evaluate(readingGap);
              // The opening holds the reading line while the body is still on its way: it no longer
              // draws the short letter low and snaps once the body lands.
              await expect.poll(async () => Math.abs((await gap()) - 14)).toBeLessThanOrEqual(2);
              expect(await opened.getAttribute("data-body-ready"), "the body has not arrived yet").toBeNull();
              await page.evaluate(() => {
                (window as Window & { deliverLatestBody(): void }).deliverLatestBody();
              });
              // Read the line only once the body has landed: before it, the gap above already holds.
              await page.locator('[data-conv-id="w5"][aria-current="true"][data-body-ready]').waitFor();
              await opened.locator(".msg-p").first().waitFor();
              await expect
                .poll(async () => Math.abs((await gap()) - 14), {
                  message:
                    "the opened letter's top sits within a few px of the reading line once the body has landed",
                })
                .toBeLessThanOrEqual(2);
            } finally {
              await page.close();
            }
          },
          30_000,
        );

        it.each([WIDTHS[0], WIDTHS[2]].flatMap((view) => [false, true].map((late) => ({ ...view, late }))))(
          "lands on the reading line with a cold newsletter at $width (late body: $late)",
          async ({ width, height, device, late }) => {
            const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
            const bytes = Promise.withResolvers<void>();
            try {
              await page.route(`${ORIGIN}/**`, async (route) => {
                if (new URL(route.request().url()).pathname !== "/img") {
                  return route.fulfill({ contentType: "text/html", body: html });
                }
                await bytes.promise;
                return route.fulfill({ contentType: "image/png", body: PHOTO });
              });
              await page.goto(`${ORIGIN}/?newsletter&n=6&device=${device}${late ? "&lateBody" : ""}`);
              await page.getByRole("button", { name: "Q3 plan" }).click();
              const opened = page.locator('[data-conv-id="w5"]');
              const gap = () => opened.evaluate(readingGap);
              if (late) {
                await expect.poll(async () => Math.abs((await gap()) - 14)).toBeLessThanOrEqual(2);
                expect(
                  await opened.getAttribute("data-body-ready"),
                  "the body has not arrived yet",
                ).toBeNull();
                await page.evaluate(() =>
                  (window as Window & { deliverLatestBody(): void }).deliverLatestBody(),
                );
                await page.locator('[data-conv-id="w5"][data-body-ready]').waitFor();
                await expect
                  .poll(async () => Math.abs((await gap()) - 14), {
                    message: "the opened letter stays on the reading line once its body has landed",
                  })
                  .toBeLessThanOrEqual(2);
              }
              const photo = opened.frameLocator("iframe").getByRole("img", { name: "Project photo" });
              await expect.poll(() => photo.evaluate((el: HTMLImageElement) => !el.complete)).toBe(true);
              const before = await gap();
              bytes.resolve();
              await expect.poll(() => photo.evaluate((el: HTMLImageElement) => el.naturalHeight)).toBe(280);
              await expect.poll(async () => Math.abs((await gap()) - 14)).toBeLessThanOrEqual(2);
              expect(
                Math.abs(before - 14),
                "the measured newsletter lands before its picture",
              ).toBeLessThanOrEqual(2);
            } finally {
              bytes.resolve();
              await page.close();
            }
          },
          30_000,
        );

        it("reserves the declared size of an embedded picture before its part arrives", async () => {
          const page = await browser.newPage({
            viewport: { width: 1440, height: 900 },
            reducedMotion: "reduce",
          });
          try {
            await page.route(`${ORIGIN}/**`, (route) =>
              route.fulfill({ contentType: "text/html", body: html }),
            );
            await page.goto(`${ORIGIN}/?embeddedPicture&n=6`);
            await page.getByRole("button", { name: "Q3 plan" }).click();
            const older = page.locator('[data-conv-id="w4"]');
            const opened = page.locator('[data-conv-id="w5"][aria-current="true"]');
            const gap = () => opened.evaluate(readingGap);
            const placeholder = older.locator(".msg-img-placeholder");
            const box = (el: Element) => ({
              width: el.getBoundingClientRect().width,
              height: el.getBoundingClientRect().height,
            });
            await expect.poll(() => placeholder.count()).toBe(3);
            expect(await placeholder.first().evaluate(box)).toEqual({ width: 90, height: 70 });
            const first = await gap();
            await page.evaluate(
              ([sketch, logo]) => {
                const fixture = window as Window & {
                  deliverEmbeddedImages: (sketch: string, logo: string) => void;
                };
                fixture.deliverEmbeddedImages(sketch, logo);
              },
              [PHOTO, SHORT_PHOTO].map((image) => `data:image/png;base64,${image.toString("base64")}`) as [
                string,
                string,
              ],
            );
            const image = older.getByRole("img", { name: "Inline sketch" });
            await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalHeight)).toBe(280);
            expect(await image.evaluate(box)).toEqual({ width: 90, height: 70 });
            const logo = older.getByRole("img", { name: "Inline logo" });
            await expect.poll(() => logo.evaluate((el: HTMLImageElement) => el.naturalHeight)).toBe(40);
            expect.soft(await logo.evaluate(box)).toEqual({ width: 360, height: 40 });
            await expect
              .poll(() => placeholder.count(), {
                message: "the placeholder clears once the missing part is known to be unavailable",
              })
              .toBe(0);
            expect(
              await logo.evaluate((el) => el.parentElement!.getBoundingClientRect().height),
            ).toBeLessThan(60);
            expect(Math.abs((await gap()) - first)).toBeLessThanOrEqual(2);
          } finally {
            await page.close();
          }
        }, 30_000);
      });
    }
  });
}
