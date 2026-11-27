import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { gardenGuests } from "./guest-fixture.js";
import { calendarEditAndDragCases } from "./edit-and-drag-in-a-browser.cases.js";
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

it("keeps the open invitation facts within the tablet panel", async () => {
  const page = await browser.newPage({ viewport: { width: 1032, height: 1100 }, hasTouch: true });
  try {
    await openCalRestPage(page, "screen=invitations&viewport&device=fold&open=ev-techcheck");
    const card = page.locator('.oh-ecard[data-frame="inline"]');
    await browserExpect(card.getByText("Makersfest, Hall 2, Zürich")).toBeVisible();
    await browserExpect(card.getByText("Petra Wyss")).toBeVisible();
    const fit = await card.evaluate((element) => {
      const place = element.querySelector(".oh-ecard-where")!;
      const box = element.closest('[role="listitem"]')!.getBoundingClientRect();
      return {
        usesFullWidth: Math.abs(element.getBoundingClientRect().width - box.width) < 1,
        line: getComputedStyle(place).whiteSpace,
        overflow: getComputedStyle(place).textOverflow,
      };
    });
    expect(fit).toEqual({ usesFullWidth: true, line: "nowrap", overflow: "ellipsis" });
  } finally {
    await page.close();
  }
});

it("keeps the first characters of a narrow week title and its full spoken name", async () => {
  const page = await browser.newPage({ viewport: { width: 1032, height: 1100 }, hasTouch: true });
  try {
    await openCalRestPage(page, "screen=invitations&viewport&device=fold&open=ev-techcheck");
    const chip = page.locator('.oh-ev[data-size="block"][data-record="ev-techcheck"]').first();
    await chip.waitFor();
    const title = chip.locator(".oh-ev-tt");
    await chip.evaluate((el) => {
      el.style.width = "62px";
    });
    await browserExpect(title).toHaveText(/^T[^…]*…$/);
    await chip.evaluate((el) => {
      el.style.width = "54px";
    });
    await browserExpect(title).toHaveText("T");
    await browserExpect(chip).toHaveAccessibleName(/Tech check, main hall/);
  } finally {
    await page.close();
  }
});

it("shows the start of a word that cannot fit in a floating event heading", async () => {
  const page = await browser.newPage({ viewport: { width: 1032, height: 1100 }, hasTouch: true });
  try {
    await openCalRestPage(page, "screen=invitations&viewport&device=fold&lang=de&open=ev-techcheck");
    const event = page.locator(".oh-ecard:not([data-frame])");
    const heading = event.getByRole("heading");
    const title = await heading.textContent();
    await heading.evaluate((el) => {
      el.style.boxSizing = "content-box";
      el.style.width = "36px";
    });
    await browserExpect(heading).toHaveText(/^T[^…]*…/);
    await browserExpect(event).toHaveAccessibleName(title!);
  } finally {
    await page.close();
  }
});

it("keeps the next word on its own line below an oversized word in a tall week block", async () => {
  const page = await browser.newPage({ viewport: { width: 1032, height: 1100 }, hasTouch: true });
  try {
    await openCalRestPage(page, "screen=invitations&viewport&device=fold&state=title-fit&open=ev-techcheck");
    const chip = page.locator('.oh-ev[data-size="block"][data-record="ev-techcheck"]').first();
    await chip.waitFor();
    await chip.evaluate((el) => {
      el.style.width = "90px";
    });
    const title = chip.locator(".oh-ev-tt");
    await browserExpect(title).toHaveText(/^A[^…]*…\s+heute$/);
    await browserExpect(chip).toHaveAccessibleName(/Ausstellungsrundgang heute/);
  } finally {
    await page.close();
  }
});

it("shows the title prefix on a narrow all-day chip", async () => {
  const page = await browser.newPage({ viewport: { width: 1032, height: 1100 }, hasTouch: true });
  try {
    await openCalRestPage(page, "screen=week&viewport&device=fold&state=all");
    const chip = page.locator('.oh-ev[data-size="pill"][data-record="ev-glaze"]').first();
    await chip.waitFor();
    await chip.evaluate((el) => {
      el.style.width = "64px";
    });
    await browserExpect(chip.locator(".oh-ev-tt")).toHaveText(/^G[^…]*…$/);
    await browserExpect(chip).toHaveAccessibleName(/Glaze order #2291 arrives/);
  } finally {
    await page.close();
  }
});

it.each(["en", "de"])(
  "draws the start of each overlapping week title beside Invitations in %s",
  async (lang) => {
    const page = await browser.newPage({ viewport: { width: 1032, height: 1100 }, hasTouch: true });
    try {
      await openCalRestPage(
        page,
        `screen=invitations&viewport&device=fold&state=overlap-titles&lang=${lang}&open=ev-techcheck`,
      );
      await page.evaluate(() => document.fonts.ready);
      for (const [record, initial] of [
        ["ev-stand-setup", "S"],
        ["ev-techcheck", "T"],
        ["ev-print-review", "P"],
      ]) {
        const chip = page.locator(`.oh-ev[data-size="block"][data-record="${record}"]`);
        const title = chip.locator(".oh-ev-tt");
        await expect
          .poll(() =>
            title.evaluate((element) => {
              const first = document.createRange();
              first.setStart(element.firstChild!, 0);
              first.setEnd(element.firstChild!, 1);
              const glyph = first.getBoundingClientRect();
              const box = element.getBoundingClientRect();
              const block = element.closest("button")!.getBoundingClientRect();
              return {
                initial: element.textContent?.[0],
                narrow: block.width > 0 && block.width < 24,
                fits: glyph.right <= Math.min(box.right, block.right),
              };
            }),
          )
          .toEqual({ initial, narrow: true, fits: true });
      }
    } finally {
      await page.close();
    }
  },
);

calendarEditAndDragCases(() => browser);
