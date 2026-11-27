import { chromium, type Browser, type Locator, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readerStatesPage } from "../../../packages/app/test/states/reader-states.mjs";
import en from "../messages/en.json";

const origin = "https://screener-rules.states.invalid";
let browser: Browser;
let html: string;

beforeAll(async () => {
  html = await readerStatesPage("apps/webapp/test/phone-width-screener-page.tsx");
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

async function visit(width: number, coarse: boolean, check: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width, height: width === 375 ? 812 : 900 }, hasTouch: coarse });
  try {
    await page.route("**/*", (route) => (
      route.request().url() === `${origin}/`
        ? route.fulfill({ contentType: "text/html", body: html })
        : route.abort()
    ));
    await page.addInitScript("window.process = { env: {} };");
    await page.goto(origin);
    await row(page).waitFor({ timeout: 5000 });
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(coarse);
    await check(page);
  } finally {
    await page.close();
  }
}

const row = (page: Page) => page.getByRole("option", { name: "Casey Sender: The Screener's test letter" });

async function senderCard(page: Page) {
  await row(page).click();
  const sender = page.getByRole("region", { name: "Casey Sender", exact: true });
  const change = sender.getByRole("button", { name: "sender@example.invalid", exact: true });
  await change.click({ timeout: 5000 });
  const card = page.getByRole("dialog", { name: en.screener.place.keyCard });
  await card.waitFor({ timeout: 5000 });
  return card;
}

async function namedClose(sheet: Locator) {
  const close = sheet.getByRole("button", { name: "Close", exact: true });
  await close.waitFor({ timeout: 5000 });
  const box = (await close.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await close.evaluate((button) => getComputedStyle(button.parentElement!).position)).toBe("sticky");
  await close.click();
  await sheet.waitFor({ state: "hidden", timeout: 5000 });
}

describe("R13-04 — a full-height sender sheet carries a close control of at least 44px", () => {
  it("at 375x812 the sheet fills the band, and its close is a named 44px button that closes it", async () => {
    for (const coarse of [true, false]) await visit(375, coarse, async (page) => {
      await page.addStyleTag({ content: ".oh-contactcard-head { min-height: 900px }" });
      await namedClose(await senderCard(page));
    });
  }, 30_000);

  it("the subject-rule sheet, the same shell, carries the same way out", async () => {
    for (const coarse of [true, false]) await visit(375, coarse, async (page) => {
      await page.addStyleTag({ content: ".subject-rule-card .oh-contactcard-head { min-height: 900px }" });
      const card = await senderCard(page);
      await card.getByRole("menuitem", { name: en.screening.cardSubject }).click({ timeout: 5000 });
      await namedClose(page.getByRole("dialog", { name: en.screening.subjectAria, exact: true }));
    });
  }, 30_000);

  it("control: a sheet with room around it keeps its face — no close control", async () => {
    await visit(1440, false, async (page) => {
      const card = await senderCard(page);
      expect(await card.getByRole("button", { name: "Close", exact: true }).count()).toBe(0);
    });
  }, 30_000);
});

const badge = (page: Page) => row(page).locator(".sc-mailbox-badge");
const shortLabel = "casey-with-a-deliberately-long-mailbox-label";

describe("R13-07 — at phone width the subject gets the row, and the chip says which mailbox briefly", () => {
  it("two mailboxes: the chip is the mailbox's short label, never the full address, capped at a third", async () => {
    await visit(375, true, async (page) => {
      const chip = badge(page);
      await chip.waitFor({ timeout: 5000 });
      expect(await chip.textContent()).toBe(shortLabel);
      const geometry = await chip.evaluate((node) => {
        const tag = node.querySelector<HTMLElement>(".oh-tag")!;
        const styles = getComputedStyle(tag);
        return {
          width: node.getBoundingClientRect().width,
          row: node.closest('[role="option"]')!.getBoundingClientRect().width,
          clipped: tag.scrollWidth > tag.clientWidth,
          style: [styles.overflow, styles.textOverflow, styles.whiteSpace],
        };
      });
      expect(geometry.width).toBeLessThanOrEqual(geometry.row / 3 + 0.5);
      expect(geometry.clipped).toBe(true);
      expect(geometry.style).toEqual(["hidden", "ellipsis", "nowrap"]);
      await row(page).click();
      const detailChip = page.getByRole("note", { name: "Delivered to casey-with-a-deliberately-long-mailbox-label@example.invalid" });
      await detailChip.waitFor();
      expect(await detailChip.evaluate((node) => {
        const { backgroundColor, borderRadius, textOverflow } = getComputedStyle(node);
        return {
          filled: backgroundColor !== "rgba(0, 0, 0, 0)",
          rounded: parseFloat(borderRadius) > 0,
          clipped: node.scrollWidth > node.clientWidth,
          textOverflow,
        };
      })).toEqual({ filled: true, rounded: true, clipped: true, textOverflow: "ellipsis" });
      const chipBox = await detailChip.boundingBox();
      const letterBox = await page.getByRole("feed").getByRole("article").first().boundingBox();
      expect(letterBox!.y - (chipBox!.y + chipBox!.height)).toBeGreaterThanOrEqual(8);
    });
  }, 30_000);

  it("control: wide, the chip keeps the full label", async () => {
    await visit(1440, false, async (page) => {
      await row(page).click();
      const detailChip = page.getByRole("note", { name: "Delivered to casey-with-a-deliberately-long-mailbox-label@example.invalid" });
      await detailChip.waitFor();
      expect(await detailChip.textContent()).toBe("Delivered to casey-with-a-deliberately-long-mailbox-label@example.invalid");
    });
  }, 30_000);

});

async function keycaps(page: Page, coarse: boolean) {
  const dock = page.getByRole("navigation", { name: "Places" });
  const write = dock.getByRole("button", { name: "Write", exact: true }).locator("kbd");
  const search = dock.getByRole("button", { name: "Search", exact: true }).locator("kbd");
  expect(await write.allTextContents()).toEqual(["c"]);
  expect(await search.allTextContents()).toEqual(["/"]);
  await row(page).click({ button: "right" });
  const menu = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: /Ohbox/ }) });
  await menu.waitFor({ timeout: 5000 });
  const caps = menu.locator("kbd");
  expect(await caps.allTextContents()).toEqual(expect.arrayContaining(["o", "x"]));
  for (const cap of [write, search, ...await caps.all()]) expect(await cap.isVisible()).toBe(!coarse);

  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 5000 });
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("option", { name: /Keyboard shortcuts/ }).waitFor({ timeout: 5000 });

}

describe("R13-06 — with a coarse pointer the Screener's and the drawer's keycaps are not drawn", () => {
  it("the row menu's letters, Compose's c, Search's / and the dock's chord are hidden", async () => {
    await visit(375, true, (page) => keycaps(page, true));
  }, 30_000);

  it("control: with a fine pointer every one of them is drawn", async () => {
    await visit(375, false, (page) => keycaps(page, false));
  }, 30_000);
});
