import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const pw = createRequire(resolve("package.json"))("@playwright/test") as typeof import("@playwright/test");
let script: string;
let styles: string;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: ["apps/webapp/test/composer-menus/page.tsx"],
    outfile: "reply.js",
    write: false,
    bundle: true,
    jsx: "automatic",
    conditions: ["ohmail-source"],
    loader: { ".woff2": "dataurl" },
  });
  script = outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  styles = outputFiles.find((file) => file.path.endsWith(".css"))!.text;
}, 60_000);

async function open(page: Page, device: "desktop" | "phone", query = "") {
  await page.route("**/*", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/reply.js") return route.fulfill({ contentType: "application/javascript", body: script });
    if (path === "/reply.css") return route.fulfill({ contentType: "text/css", body: styles });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" data-face="paper" data-device="${device}"
        data-touch="${device === "phone" ? 1 : 0}"><head><meta charset="utf-8">
        <link rel="stylesheet" href="/reply.css"><style>
        html, body { height: 100% } body { margin: 0 } #root { display: flex; flex-direction: column; height: 100vh }
        </style></head><body><main id="root" class="oh-root"></main><script src="/reply.js"></script></body></html>`,
    });
  });
  await page.goto(`https://composer.example.com/${query}`);
}

async function pickOverSend(page: Page, last: Locator) {
  const row = (await last.boundingBox())!;
  const send = (await page.getByRole("button", { name: "Send", exact: true }).boundingBox())!;
  const left = Math.max(row.x, send.x);
  const right = Math.min(row.x + row.width, send.x + send.width);
  const top = Math.max(row.y, send.y);
  const bottom = Math.min(row.y + row.height, send.y + send.height);
  expect(right).toBeGreaterThan(left);
  expect(bottom).toBeGreaterThan(top);
  const point = { x: (left + right) / 2, y: (top + bottom) / 2 };
  await expect
    .poll(() =>
      last.evaluate((element, { x, y }) => element.contains(document.elementFromPoint(x, y)), point),
    )
    .toBe(true);
  await page.mouse.click(point.x, point.y);
}

describe.each([
  { surface: "web", engine: pw.chromium, width: 1440, height: 900, phone: false },
  ...(process.env.COMPOSER_WEBKIT === "1"
    ? [{ surface: "desktop WebKit", engine: pw.webkit, width: 1440, height: 900, phone: false }]
    : []),
  { surface: "phone web", engine: pw.chromium, width: 390, height: 844, phone: true },
])("$surface composer", ({ surface, engine, width, height, phone }) => {
  it("can scroll the From menu and pick the last address above the action pill", async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: phone });
      await open(page, phone ? "phone" : "desktop");
      await page.getByRole("button", { name: /choose another address/ }).click();
      const menu = page.getByRole("menu", { name: "From" });
      const last = menu.getByRole("menuitemradio", { name: "sender-40@example.com" });
      await last.waitFor();
      expect(await menu.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
        await menu.evaluate((element) => element.clientHeight),
      );
      await menu.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const screenshots = process.env.COMPOSER_SCREENSHOTS;
      if (surface === "web" && screenshots) {
        await page.screenshot({ path: screenshots, animations: "disabled" });
      }
      const bounds = (await menu.boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
      if (phone) {
        await last.tap({ timeout: 2000 });
      } else {
        await pickOverSend(page, last);
      }
      await page.getByRole("button", { name: /From sender-40/ }).waitFor();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("can pick the last To suggestion, then open and use Send later", async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: phone });
      await open(page, phone ? "phone" : "desktop", "?compact");
      const to = page.getByRole("combobox", { name: "To" });
      await to.fill("contact");
      const last = page.getByRole("option", { name: /contact-18@example.com/ });
      await last.waitFor();
      await last.scrollIntoViewIfNeeded();
      if (phone) await last.tap({ timeout: 2000 });
      else await last.click({ timeout: 2000 });
      expect(await to.inputValue()).toBe("contact-18@example.com");

      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Send later" }).click({ timeout: 2000 });
      const schedule = page.getByRole("dialog", { name: "Send later" });
      await schedule.getByRole("menuitem", { name: /Pick a date and time/ }).click({ timeout: 2000 });
      const confirm = schedule.getByRole("button", { name: "Schedule send" });
      await confirm.click({ timeout: 2000 });
      await page.getByRole("status", { name: "Schedule result" }).waitFor();
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe("composer popovers in the reader", () => {
  it("leaves the active To field in sight when suggestions open upward", async () => {
    const browser = await pw.chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
      await open(page, "phone", "?lower");
      const to = page.getByRole("combobox", { name: "To" });
      await to.fill("contact");
      const line = page.getByRole("group", { name: "To" });
      const list = page.getByRole("listbox", { name: "Address suggestions" });
      const bounds = async () => {
        const row = (await line.boundingBox())!;
        const menu = (await list.boundingBox())!;
        return menu.y + menu.height - row.y;
      };
      await expect.poll(bounds).toBeLessThanOrEqual(1);
      expect(await to.evaluate((el) => document.activeElement === el)).toBe(true);
      await to.press("x");
      expect(await to.inputValue()).toBe("contactx");
    } finally {
      await browser.close();
    }
  }, 30_000);

  it.each([
    { scope: "phone", name: "Reading column", phone: true },
    { scope: "reply-run", name: "Reply run", phone: false },
  ])(
    "keeps From and To inside the $scope modal",
    async ({ scope, name, phone }) => {
      const browser = await pw.chromium.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: phone ? 390 : 1440, height: 844 },
          hasTouch: phone,
        });
        await open(page, phone ? "phone" : "desktop", `?scope=${scope}`);
        const modal = page.getByRole("dialog", { name });
        await modal.getByRole("button", { name: /choose another address/ }).click({ timeout: 3000 });
        await page.getByRole("menu", { name: "From" }).waitFor({ timeout: 2000 });
        expect.soft(await modal.getByRole("menu", { name: "From" }).count()).toBe(1);
        await page.keyboard.press("Escape");
        await modal.getByRole("combobox", { name: "To" }).fill("contact");
        const nameOfFirst = /contact-1@example.com/;
        await page.getByRole("option", { name: nameOfFirst }).waitFor({ timeout: 2000 });
        expect(await modal.getByRole("option", { name: nameOfFirst }).count()).toBe(1);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.each(["?report", "?report&scope=phone"])(
    "leaves Undo and the bottom of the sender menu usable together (%s)",
    async (scene) => {
      const browser = await pw.chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
        await open(page, "phone", scene);
        const choose = page.getByRole("button", { name: /choose another address/ });
        await choose.tap();
        const menu = page.getByRole("menu", { name: "From" });
        const last = menu.getByRole("menuitemradio", { name: "sender-40@example.com" });
        await menu.waitFor();
        const undo = page.getByRole("button", { name: "Undo" });
        await undo.tap({ trial: true, timeout: 2000 });
        const roomAboveUndo = async () => {
          const sheet = (await menu.boundingBox())!;
          const button = (await undo.boundingBox())!;
          return sheet.y + sheet.height - button.y;
        };
        await expect.poll(roomAboveUndo).toBeLessThanOrEqual(1);
        await last.tap({ timeout: 2000 });
        const selected = page.getByRole("button", { name: /From sender-40/ });
        await selected.tap();
        await menu.waitFor();
        await undo.tap({ timeout: 2000 });
        await page.getByRole("status", { name: "Undo result" }).waitFor();
        expect(await menu.isVisible()).toBe(true);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.each(["?report", "?report&scope=phone"])(
    "keeps To options and Undo tappable together (%s)",
    async (scene) => {
      const browser = await pw.chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
        await open(page, "phone", scene);
        const to = page.getByRole("combobox", { name: "To" });
        await to.fill("contact");
        const suggestions = page.getByRole("listbox", { name: "Address suggestions" });
        const report = page.getByRole("status").filter({ hasText: "Draft discarded" });
        const last = suggestions.getByRole("option", { name: /contact-18@example.com/ });
        await last.waitFor();
        await report.waitFor();
        await expect
          .poll(async () => {
            const list = (await suggestions.boundingBox())!;
            const toast = (await report.boundingBox())!;
            return list.y + list.height - toast.y;
          })
          .toBeLessThanOrEqual(1);
        const undo = report.getByRole("button", { name: "Undo" });
        await undo.tap({ trial: true, timeout: 2000 });
        await last.tap({ timeout: 2000 });
        expect(await to.inputValue()).toBe("contact-18@example.com");

        await to.fill("contact");
        await suggestions.waitFor();
        await undo.tap({ timeout: 2000 });
        await page.getByRole("status", { name: "Undo result" }).waitFor();
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it("reveals keyboard focus in the sender menu without scrolling the reader", async () => {
    const browser = await pw.chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 600 } });
      await open(page, "desktop", "?lower");
      await page.getByRole("button", { name: /choose another address/ }).click();
      const reader = page.getByRole("region", { name: "Conversation" });
      const before = await reader.evaluate((el) => el.scrollTop);
      const menu = page.getByRole("menu", { name: "From" });
      const visibleFocus = async (address: string) => {
        const row = menu.getByRole("menuitemradio", { name: address });
        expect(await row.evaluate((el) => document.activeElement === el)).toBe(true);
        const a = (await row.boundingBox())!;
        const b = (await menu.boundingBox())!;
        expect(a.y).toBeGreaterThanOrEqual(b.y - 1);
        expect(a.y + a.height).toBeLessThanOrEqual(b.y + b.height + 1);
      };
      await page.keyboard.press("End");
      await visibleFocus("sender-40@example.com");
      await page.keyboard.press("ArrowDown");
      await visibleFocus("sender-1@example.com");
      expect(await reader.evaluate((el) => el.scrollTop)).toBe(before);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
