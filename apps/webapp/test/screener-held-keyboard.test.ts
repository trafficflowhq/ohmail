import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readerStatesPage } from "../../../packages/app/test/states/reader-states.mjs";

const origin = "https://held-keys.states.invalid";
let browser: Browser;
let html: string;

beforeAll(async () => {
  html = await readerStatesPage("apps/webapp/test/screener-held-keyboard-page.tsx");
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

it.each([390, 1100])("at %ipx keeps the newest letter below the stationary sender heading", async (width) => {
  const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion: "reduce" });
  try {
    await page.route(`${origin}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(origin);
    const first = page.getByRole("option", { name: /Sender 0: Newest letter 0/ });
    const sections = page.getByRole("group", { name: "Screener sections" });
    const rect = async (locator: typeof first) => {
      const box = await locator.boundingBox({ timeout: 3000 });
      if (!box) throw new Error("Expected the control to be visible");
      return box;
    };
    await first.click();
    const reading = page.getByRole("region", { name: "Sender 0", exact: true });
    const head = reading.getByRole("heading", { name: /Sender 0 goes to/ });
    const letter = page.getByRole("heading", { name: "Newest letter 0", exact: true });
    const senderLine = reading.getByRole("article").filter({ has: letter }).getByRole("button", { name: /^Sender 0 / });
    const expectClear = async () => {
      const [bar, line, subject, column] = await Promise.all([rect(head), rect(senderLine), rect(letter), rect(reading)]);
      expect(line.y).toBeGreaterThanOrEqual(bar.y + bar.height - 0.5);
      expect(subject.y + subject.height).toBeLessThanOrEqual(column.y + column.height + 0.5);
    };
    await expectClear();

    const scroller = reading.locator("[data-reading-scroll]");
    const before = await rect(head);
    const moved = await scroller.evaluate((node) => {
      const at = node.scrollTop;
      node.scrollTop += 100;
      return node.scrollTop - at;
    });
    expect(moved).toBeGreaterThan(0);
    expect((await rect(head)).y).toBeCloseTo(before.y, 0);

    // The clearance probe must reject the old landing line above the stationary heading's bottom.
    const covered = await letter.evaluate((node) => {
      const pane = node.closest('[role="region"]')!;
      const port = pane.querySelector("[data-reading-scroll]")!;
      const head = pane.querySelector("h2")!;
      port.scrollTop += node.getBoundingClientRect().top - head.getBoundingClientRect().top;
      return node.getBoundingClientRect().top < head.getBoundingClientRect().bottom;
    });
    expect(covered).toBe(true);

    if (width >= 700) {
      await first.focus();
      for (let i = 0; i < 23; i++) await page.keyboard.press("j");
      await page.getByRole("option", { name: /Sender 23: Newest letter 23/, selected: true }).waitFor();
      expect((await rect(first)).y).toBeLessThan((await rect(sections)).y);
      for (let i = 0; i < 23; i++) await page.keyboard.press("k");
      await page.getByRole("option", { name: /Sender 0: Newest letter 0/, selected: true }).waitFor();
      const listHead = await rect(sections);
      const row = await rect(first);
      const listPort = await rect(page.getByRole("listbox", { name: "Screener", exact: true }).locator("xpath=ancestor::*[@class='sc-scroll']"));
      expect(row.y).toBeGreaterThanOrEqual(listHead.y + listHead.height - 0.5);
      expect(row.y).toBeGreaterThanOrEqual(listPort.y - 0.5);
      await expect.poll(async () => {
        const [subject, column] = await Promise.all([rect(letter), rect(reading)]);
        return subject.y + subject.height - (column.y + column.height);
      }).toBeLessThanOrEqual(0.5);
      await expectClear();
    }
  } finally {
    await page.close();
  }
}, 60_000);
