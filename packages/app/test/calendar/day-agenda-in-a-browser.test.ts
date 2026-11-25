import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { gardenGuests } from "./guest-fixture.js";
import { openCalRestPage } from "../states/calrest-page-open.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function day(width: number, check: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await openCalRestPage(page, "screen=day&viewport&state=long-title");
    await page.locator(".cd-day").waitFor();
    await check(page);
  } finally {
    await page.close();
  }
}
const views = [
  ["2", ".cw-week"],
  ["3", ".cal-mo"],
  ["4", ".cal-yr"],
] as const;
const panel = (page: Page) => page.locator(".cal-body-panel");
const toggle = (page: Page) => page.getByRole("button", { name: "Agenda", exact: true }).first();

it("opens the Agenda when Day has room and closes the automatic panel in other views", async () => {
  await day(1120, async (page) => {
    for (const [shortcut, view] of views) {
      await expect.poll(() => panel(page).count()).toBe(1);
      await page.keyboard.press(shortcut);
      await page.locator(view).waitFor();
      await expect.poll(() => panel(page).count()).toBe(0);
      await page.keyboard.press("1");
      await page.locator(".cd-day").waitFor();
    }
    await expect.poll(() => panel(page).count()).toBe(1);
    await page.setViewportSize({ width: 1119, height: 900 });
    await expect.poll(() => panel(page).count()).toBe(0);
  });
});

it("remembers closing a wide Day across reloads until the Agenda is explicitly reopened", async () => {
  await day(1440, async (page) => {
    await expect.poll(() => panel(page).count()).toBe(1);
    await panel(page).getByRole("button", { name: /close/i }).click();
    await expect.poll(() => panel(page).count()).toBe(0);
    await page.reload();
    await toggle(page).waitFor();
    expect(await panel(page).count()).toBe(0);
    await toggle(page).click();
    await expect.poll(() => panel(page).count()).toBe(1);
    await page.keyboard.press("2");
    await page.locator(".cw-week").waitFor();
    await expect.poll(() => panel(page).count()).toBe(1);
    await page.reload();
    await expect.poll(() => panel(page).count()).toBe(1);
  });
});

it("keeps a compact Agenda opened by keyboard beside the other calendar views", async () => {
  await day(1024, async (page) => {
    expect(await panel(page).count()).toBe(0);
    await page.keyboard.press("g");
    await page.keyboard.press("a");
    await expect.poll(async () => (await panel(page).boundingBox())?.width).toBe(264);
    const title = panel(page).getByText(/Autumn field work planning/);
    await title.waitFor();
    const fit = await title.evaluate((el) => {
      const scroll = el.closest(".cal-body-panel")!;
      const row = el.closest(".oh-erow")!;
      const title = el.getBoundingClientRect();
      const time = row.querySelector("time")!.getBoundingClientRect();
      const words = row.querySelector(".oh-erow-first")!.getBoundingClientRect();
      return {
        fullWidth: title.width >= words.width - 1,
        timeBelow: time.top >= title.bottom,
        twoLines: Math.abs(title.height - 2 * parseFloat(getComputedStyle(el).lineHeight)) < 1,
        cut: el.scrollHeight > el.clientHeight,
        fits:
          scroll.scrollWidth <= scroll.clientWidth &&
          document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(fit).toEqual({ fullWidth: true, timeBelow: true, twoLines: true, cut: true, fits: true });
    for (const [shortcut, view] of views) {
      await page.keyboard.press(shortcut);
      await page.locator(view).waitFor();
      await expect.poll(() => panel(page).count()).toBe(1);
    }
    await page.keyboard.press("Escape");
    await expect.poll(() => panel(page).count()).toBe(0);
  });
});

it("keeps the phone Agenda as its own place", async () => {
  await day(390, async (page) => {
    expect(await panel(page).count()).toBe(0);
    await page.keyboard.press("g");
    await page.keyboard.press("a");
    await page.locator(".cal-ag[data-device=phone]").waitFor();
    expect(await panel(page).count()).toBe(0);
  });
});

it("keeps the wide Agenda time beside its single-line title", async () => {
  await day(1440, async (page) => {
    const title = panel(page).getByText(/Autumn field work planning/);
    const inline = await title.evaluate((el) => {
      const time = el.closest(".oh-erow")!.querySelector("time")!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return (
        time.left >= box.right &&
        time.top < box.bottom &&
        el.scrollWidth > el.clientWidth &&
        getComputedStyle(el).textOverflow === "ellipsis"
      );
    });
    expect(inline).toBe(true);
  });
});

it.each([
  { width: 1440, height: 900, phone: false, scheme: "light", lang: "en", label: "Invitees" },
  { width: 1440, height: 900, phone: false, scheme: "dark", lang: "de", label: "Gäste" },
  { width: 390, height: 780, phone: true, scheme: "light", lang: "de", label: "Gäste" },
  { width: 390, height: 780, phone: true, scheme: "dark", lang: "en", label: "Invitees" },
])(
  "shows the inline guest list at $width px in $scheme ($lang)",
  async ({ width, height, phone, scheme, lang, label }) => {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: phone });
    try {
      await openCalRestPage(
        page,
        `screen=day&viewport&state=garden-guests&open=garden-workshop&scheme=${scheme}&lang=${lang}`,
      );
      const event = page.getByRole("dialog", { name: "Garden workshop" });
      const trigger = event.getByRole("button", { name: label });
      const guests = event.getByRole("region", { name: label });
      await browserExpect(event).toBeVisible();
      await browserExpect(trigger).toHaveAttribute("aria-expanded", "false");
      await browserExpect(guests).toHaveCount(0);
      await trigger.focus({ timeout: 3000 });
      await page.keyboard.press("Enter");
      await browserExpect(trigger).toHaveAttribute("aria-expanded", "true");
      await browserExpect(trigger).toBeFocused();
      await browserExpect(guests).toBeVisible({ timeout: 2500 });
      await browserExpect(page.getByRole("dialog", { name: label })).toHaveCount(0);
      await browserExpect(guests.getByRole("listitem")).toHaveCount(gardenGuests.length + 1);
      const last = guests.getByRole("listitem").last();
      await last.scrollIntoViewIfNeeded();
      await browserExpect(last).toBeInViewport();
      const card = await event.boundingBox();
      const list = await guests.boundingBox();
      expect(list).not.toBeNull();
      expect(list!.x).toBeGreaterThan(card!.x);
      expect(list!.x + list!.width).toBeLessThanOrEqual(card!.x + card!.width);
      await trigger.focus();
      await page.keyboard.press("Space");
      await browserExpect(guests).toHaveCount(0);
      await browserExpect(trigger).toHaveAttribute("aria-expanded", "false");
      await browserExpect(event).toBeVisible();
      await browserExpect(trigger).toBeFocused();
    } finally {
      await page.close();
    }
  },
);
