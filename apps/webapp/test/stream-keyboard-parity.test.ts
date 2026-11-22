import { chromium, type Browser, type Locator } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readerStatesPage } from "../../../packages/app/test/states/reader-states.mjs";

const origin = "https://stream-keys.states.invalid";
let browser: Browser;
let html: string;

beforeAll(async () => {
  html = await readerStatesPage("apps/webapp/test/stream-keyboard-page.tsx");
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

async function waitForSettledScroll(scroller: Locator): Promise<void> {
  await scroller.evaluate(async (el) => {
    let top = el.scrollTop;
    let steady = 0;
    // Allow the landing's stable frames and the scroll-spy frame after them.
    while (steady < 4) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      steady = el.scrollTop === top ? steady + 1 : 0;
      top = el.scrollTop;
    }
  });
}

it.each([
  { width: 1440, place: "news", label: "News stream", face: "paper" },
  { width: 1440, place: "receipts", label: "Receipts stream", face: "paper" },
  { width: 390, place: "news", label: "News stream", face: "paper" },
  { width: 1440, place: "news", label: "News stream", face: "ohmarchy" },
  { width: 1440, place: "receipts", label: "Receipts stream", face: "ohmarchy" },
])("$label at $width in $face opens and closes a keyboard reply in its own card", async ({ width, place, label, face }) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.route(`${origin}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${origin}/?place=${place}&face=${face}`);
    const stream = page.getByRole("region", { name: label, exact: true });
    const scroller = stream.locator("[data-reading-scroll]");
    await stream.getByRole("heading", { name: "Short letter" }).waitFor({ timeout: 5000 });
    if (face === "ohmarchy") {
      await stream.getByRole("article").filter({ has: page.getByRole("heading", { name: "Long letter" }) })
        .getByRole("button", { name: "Expand", exact: true }).click();
    } else {
      await page.keyboard.press("j");
    }
    const selected = stream.locator("[data-stream-item][data-open]");
    await selected.waitFor({ timeout: 3000 });
    const item = selected.locator("..");
    const title = await selected.getByRole("heading").textContent();
    const card = (await item.elementHandle())!;
    const replyButton = stream.getByRole("button", { name: "Reply", exact: true });
    await replyButton.waitFor({ timeout: 3000 });
    await waitForSettledScroll(scroller);
    await expect.poll(() => replyButton.getAttribute("aria-keyshortcuts")).toBe("r");
    if (face === "ohmarchy") {
      const bar = stream.getByRole("toolbar", { name: "Actions", exact: true });
      for (const [name, key, hint] of [
        ["Reply", "r", "r"], ["Forward", "Shift+F", "⇧ f"], ["Later", "a", "a"],
        ["Park", "e", "e"], ["Resurface", "b", "b"],
      ] as const) {
        const button = bar.getByRole("button", { name, exact: true });
        await expect.poll(() => button.getAttribute("aria-keyshortcuts"), { message: name }).toBe(key);
        expect(await button.locator("kbd").isVisible()).toBe(true);
        expect(await button.locator("kbd").textContent()).toBe(hint);
      }
      const read = bar.getByRole("button", { name: /^Mark (un)?read$/ });
      await expect.poll(async () => {
        const key = await read.getAttribute("aria-keyshortcuts");
        const cap = read.locator("kbd");
        if (!(await cap.isVisible())) return false;
        const text = await cap.textContent();
        return (key === "Shift+I" && text === "⇧ i") || (key === "u" && text === "u");
      }).toBe(true);
    }
    await page.keyboard.press("r");
    const reply = stream.getByRole("textbox", { name: "Reply body" });
    await reply.waitFor({ timeout: 3000 });
    expect(await reply.evaluate((editor, original) => original.contains(editor), card)).toBe(true);
    expect(await page.getByRole("dialog", { name: "Reading" }).count()).toBe(0);
    await page.keyboard.press("Escape");
    await reply.waitFor({ state: "detached", timeout: 3000 });
    expect(await card.evaluate((node) => node.isConnected)).toBe(true);
    expect(await stream.getByRole("heading", { name: title!, exact: true }).count()).toBe(1);
    if (face === "ohmarchy") {
      const target = await selected.getAttribute("data-stream-item");
      expect(target).toBeTruthy();
      await page.keyboard.press("a");
      await page.waitForFunction((id) => Reflect.get(window, "streamFiled").includes(id), target);
    }
    if (width === 390) {
      await waitForSettledScroll(scroller);
      await page.keyboard.press("Shift+KeyF");
      const forward = stream.getByRole("textbox", { name: "Forward body" });
      await forward.waitFor({ timeout: 3000 });
      expect(await forward.evaluate((editor, original) => original.contains(editor), card)).toBe(true);
      expect(await page.getByRole("dialog", { name: "Reading" }).count()).toBe(0);
      await page.keyboard.press("Escape");
      await forward.waitFor({ state: "detached", timeout: 3000 });
      const long = stream.getByRole("article").filter({ has: page.getByRole("heading", { name: "Long letter" }) });
      await long.getByRole("button", { name: "Read in full" }).click({ timeout: 3000 });
      const reader = page.getByRole("dialog", { name: "Reading" });
      await reader.getByRole("heading", { name: "Long letter" }).waitFor({ timeout: 3000 });
    }
  } finally {
    await page.close();
  }
}, 60_000);

it.each([
  { width: 1440, key: "r", body: "Reply body", face: "paper" },
  { width: 1440, key: "r", body: "Reply body", face: "ohmarchy" },
  { width: 390, key: "Shift+KeyF", body: "Forward body", face: "paper" },
])("$key at $width in $face waits until the addressed card is visible", async ({ width, key, body, face }) => {
  const page = await browser.newPage({ viewport: { width, height: 660 }, reducedMotion: "reduce" });
  try {
    await page.route(`${origin}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${origin}/?place=news&older=1&face=${face}`);
    const stream = page.getByRole("region", { name: "News stream", exact: true });
    const scroller = stream.locator("[data-reading-scroll]");
    const short = stream.getByRole("heading", { name: "Short letter", exact: true });
    await short.waitFor();
    if (width === 1440) await short.click();
    else await page.keyboard.press("j");
    const selected = stream.locator("[data-stream-item][data-open]");
    await selected.waitFor();
    const card = (await selected.elementHandle())!;
    const replyButton = stream.getByRole("button", { name: "Reply", exact: true });
    await replyButton.waitFor();
    const hint = replyButton.locator("kbd");
    if (face === "ohmarchy") await hint.waitFor();
    await scroller.hover();
    await page.mouse.wheel(0, 680);
    const bottom = () => card.evaluate((item) => {
      const port = item.closest("[data-reading-scroll]")!.getBoundingClientRect();
      return item.getBoundingClientRect().bottom - port.top;
    });
    await expect.poll(bottom).toBeLessThan(-10);
    if (face === "ohmarchy") await hint.waitFor({ state: "hidden" });
    await page.keyboard.press(key);
    const editor = stream.getByRole("textbox", { name: body, exact: true });
    const opened = await editor.waitFor({ state: "attached", timeout: 650 }).then(() => true, () => false);
    expect(opened, "an offscreen card acquired an editor").toBe(false);

    await scroller.evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
    await expect.poll(bottom).toBeGreaterThan(0);
    await waitForSettledScroll(scroller);
    if (face === "ohmarchy") await hint.waitFor();
    await page.keyboard.press(key);
    await editor.waitFor();
    expect(await editor.evaluate((box, original) => original.parentElement?.contains(box), card)).toBe(true);
  } finally {
    await page.close();
  }
}, 60_000);
