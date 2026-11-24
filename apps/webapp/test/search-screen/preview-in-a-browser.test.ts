import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";

const origin = "https://search-preview.test";
let browser: Browser;
let html: string;

beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["apps/webapp/test/search-screen/preview-page.tsx"],
    outdir: "out", bundle: true, write: false, format: "esm", platform: "browser",
    conditions: ["ohmail-source"], jsx: "automatic", loader: { ".woff2": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))!.text;
  const js = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  html = `<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>${css}html,body,#root{margin:0;height:100%}</style>
    <body class="today"><div id="root"></div>
    <script type="module">${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

async function inBrowser(run: (page: Page) => Promise<void>, at = "#/search", width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 680 }, reducedMotion: "reduce" });
  try {
    await page.route(`${origin}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    page.setDefaultTimeout(4_000);
    await page.goto(origin + at);
    await run(page);
  } finally {
    await page.close();
  }
}

const field = (page: Page) => page.getByRole("textbox", { name: "Search", exact: true });
const row = (page: Page, n: number) => page.locator(`[data-hit="sample-${n}"] .oh-row`);
const reader = (page: Page) => page.locator(".fr-reading");
const scroll = (page: Page) => page.locator(".sr-scroll");
const hash = (page: Page) => new URL(page.url()).hash;

async function search(page: Page) {
  await field(page).fill("glaze");
  await row(page, 1).waitFor();
}

async function open(page: Page, n: number) {
  await row(page, n).click();
  await expect.poll(() => hash(page)).toMatch(new RegExp(`/m/sample-${n}(?:\\?|$)`));
}

it("opens a News result within Search and highlights the result", () => inBrowser(async (page) => {
  await search(page);
  await open(page, 1);
  expect(hash(page)).toMatch(/^#\/search\/m\/sample-1/);
  expect(await field(page).inputValue()).toBe("glaze");
  expect(await row(page, 1).getAttribute("data-open")).toBe("");
  await reader(page).getByRole("heading", { name: "Glaze sample 1", exact: true }).waitFor();
}));

it("keeps the scrolled results and the attachment facet on open", () => inBrowser(async (page) => {
  await search(page);
  const facet = page.getByRole("button", { name: /has attachment/i });
  await facet.click();
  await expect.poll(() => facet.getAttribute("aria-pressed")).toBe("true");
  await page.locator('[data-hit="sample-20"][aria-posinset]').waitFor();
  const hit = row(page, 20);
  await hit.scrollIntoViewIfNeeded();
  const top = await scroll(page).evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(0);
  await open(page, 20);
  expect(await scroll(page).evaluate((el) => el.scrollTop)).toBe(top);
  expect(await facet.getAttribute("aria-pressed")).toBe("true");
}));

it("arrows and j/k walk the results with the reader following", () => inBrowser(async (page) => {
  await search(page);
  await open(page, 2);
  for (const [key, id] of [["ArrowDown", 3], ["j", 4], ["k", 3], ["ArrowUp", 2]] as const) {
    await page.keyboard.press(key);
    await expect.poll(() => hash(page)).toMatch(new RegExp(`^#/search/m/sample-${id}(?:\\?|$)`));
    expect(await row(page, id).getAttribute("data-open")).toBe("");
  }
}));

it("arrows scroll the focused reader and j walks to the next result", () => inBrowser(async (page) => {
  await search(page);
  await open(page, 2);
  const letter = reader(page).locator("[data-reading-scroll]");
  const top = () => letter.evaluate((el) => el.scrollTop);
  await expect.poll(() => letter.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(300);
  await reader(page).getByRole("button", { name: "Reply", exact: true }).focus();
  const before = await top();
  await page.keyboard.press("ArrowDown");
  await expect.poll(top).toBeGreaterThan(before);
  expect(hash(page)).toMatch(/^#\/search\/m\/sample-2/);
  const scrolled = await top();
  await page.keyboard.press("ArrowUp");
  await expect.poll(top).toBeLessThan(scrolled);
  expect(hash(page)).toMatch(/^#\/search\/m\/sample-2/);
  await page.keyboard.press("j");
  await expect.poll(() => hash(page)).toMatch(/^#\/search\/m\/sample-3/);
}, "?long=1#/search"));

it("browser Back closes the preview after walking several results", () => inBrowser(async (page) => {
  await search(page);
  await open(page, 2);
  await page.keyboard.press("j");
  await expect.poll(() => hash(page)).toMatch(/^#\/search\/m\/sample-3/);
  await page.goBack();
  await expect.poll(() => hash(page)).toMatch(/^#\/search(?:\?|$)/);
  expect(await field(page).inputValue()).toBe("glaze");
  await page.locator('[data-hit="sample-3"][aria-posinset]').waitFor();
  await expect.poll(() => row(page, 3).evaluate((el) => el === document.activeElement)).toBe(true);
}));

it("Escape closes the reader and returns focus to the hit", () => inBrowser(async (page) => {
  await search(page);
  await open(page, 2);
  await reader(page).getByRole("button", { name: "Reply", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => hash(page)).toMatch(/^#\/search(?:\?|$)/);
  expect(await field(page).inputValue()).toBe("glaze");
  await page.locator('[data-hit="sample-2"][aria-posinset]').waitFor();
  await expect.poll(() => row(page, 2).evaluate((el) => el === document.activeElement)).toBe(true);
}));

it("Escape unwinds a pushed preview and the next Back leaves Search", () => inBrowser(async (page) => {
  await page.locator(".fr-list .ob-scroll").waitFor();
  await page.keyboard.press("/");
  await search(page);
  await open(page, 2);
  await page.keyboard.press("j");
  await expect.poll(() => hash(page)).toMatch(/^#\/search\/m\/sample-3/);
  await page.getByRole("button", { name: /has attachment/i }).click();
  await expect.poll(() => hash(page)).toBe("#/search/m/sample-3?q=glaze&files=1");
  await page.keyboard.press("Escape");
  await expect.poll(() => hash(page)).toBe("#/search?q=glaze&files=1");
  await page.goBack();
  await expect.poll(() => hash(page)).toBe("#/ohbox");
}, "#/ohbox"));

it("Escape closes a directly linked preview and keeps focus in the Search box", () => inBrowser(async (page) => {
  await page.locator(".fr-list .ob-scroll").waitFor();
  await page.evaluate(() => { location.hash = "/search/m/sample-2?q=glaze"; });
  await reader(page).getByRole("heading", { name: "Glaze sample 2", exact: true }).waitFor();
  await field(page).focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => hash(page)).toBe("#/search?q=glaze");
  await expect.poll(() => field(page).evaluate((el) => el === document.activeElement)).toBe(true);
  expect(await field(page).inputValue()).toBe("glaze");
}, "#/ohbox"));

it("facet and unread changes replace the Search link for the current question", () => inBrowser(async (page) => {
  await search(page);
  const entries = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: /has attachment/i }).click();
  await expect.poll(() => hash(page)).toBe("#/search?q=glaze&files=1");
  await page.getByRole("button", { name: "Unread", exact: true }).click();
  await expect.poll(() => hash(page)).toBe("#/search?q=glaze&files=1&unread=1");
  await page.getByRole("button", { name: "Unread", exact: true, pressed: true }).click();
  await expect.poll(() => hash(page)).toBe("#/search?q=glaze&files=1");
  expect(await page.evaluate(() => history.length)).toBe(entries);
}, "?unread=1#/search"));

it("walking past an unread result leaves it unread after the reader dwell", () => inBrowser(async (page) => {
  await page.locator('[data-hit="sample-1"][aria-posinset]').waitFor();
  await open(page, 1);
  expect(await row(page, 2).getAttribute("data-unread")).toBe("");
  await page.keyboard.press("j");
  await reader(page).getByRole("heading", { name: "Glaze sample 2", exact: true }).waitFor();
  await page.waitForTimeout(1_000);
  await page.keyboard.press("j");
  await expect.poll(() => hash(page)).toMatch(/\/m\/sample-3/);
  expect(await row(page, 2).getAttribute("data-unread")).toBe("");
}, "?unread=1#/search?q=glaze"));

it("keeps an explicitly opened unread-filter result listed after reading it", () => inBrowser(async (page) => {
  await page.locator('[data-hit="sample-2"][aria-posinset]').waitFor();
  await open(page, 2);
  await reader(page).getByRole("button", { name: "Mark unread", exact: true }).waitFor();
  expect(await row(page, 2).getAttribute("data-open")).toBe("");
  expect(await row(page, 2).getAttribute("data-unread")).toBeNull();
}, "?unread=1#/search?q=glaze&unread=1"));

it("updates the result in place after Mark unread", () => inBrowser(async (page) => {
  await search(page);
  await open(page, 2);
  const selected = row(page, 2);
  expect(await selected.getAttribute("data-unread")).toBeNull();
  await reader(page).getByRole("button", { name: "Mark unread", exact: true }).click();
  await expect.poll(() => selected.getAttribute("data-unread")).toBe("");
  expect(hash(page)).toMatch(/^#\/search\/m\/sample-2/);
}));

async function searchOhbox(page: Page, text: string) {
  await field(page).fill(text);
  await page.getByRole("button", { name: "Place", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Ohbox/ }).click();
  await expect.poll(() => page.getByRole("button", { name: "Ohbox", exact: true, pressed: true }).count()).toBe(1);
}

async function moveToReceipts(page: Page) {
  const column = reader(page);
  // The shared reader handles the same keyboard gesture as its Move control.
  await column.getByRole("button", { name: "Reply", exact: true }).focus();
  await page.keyboard.press("m");
  await page.getByRole("menu", { name: "Move", exact: true }).getByRole("menuitem", { name: "Receipts" }).click();
}

it("filing a result outside the current place advances the preview without scrolling", () => inBrowser(async (page) => {
  await searchOhbox(page, "glaze");
  await page.locator('[data-hit="sample-20"][aria-posinset]').waitFor();
  await row(page, 20).scrollIntoViewIfNeeded();
  const top = await scroll(page).evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(0);
  await open(page, 20);
  await moveToReceipts(page);

  await reader(page).getByRole("heading", { name: "Glaze sample 21", exact: true }).waitFor();
  await row(page, 20).waitFor({ state: "detached" });
  expect(await row(page, 21).getAttribute("data-open")).toBe("");
  expect(await field(page).inputValue()).toBe("glaze");
  expect(await page.getByRole("button", { name: "Ohbox", exact: true, pressed: true }).count()).toBe(1);
  expect(await scroll(page).evaluate((el) => el.scrollTop)).toBe(top);
}));

it("filing the last matching result closes only the preview", () => inBrowser(async (page) => {
  await searchOhbox(page, "sample 48");
  await page.locator('[data-hit="sample-48"][aria-posinset]').waitFor();
  await open(page, 48);
  await moveToReceipts(page);

  await expect.poll(() => hash(page)).toMatch(/^#\/search(?:\?|$)/);
  await row(page, 48).waitFor({ state: "detached" });
  expect(await field(page).inputValue()).toBe("sample 48");
  expect(await page.getByRole("button", { name: "Ohbox", exact: true, pressed: true }).count()).toBe(1);
}));

it("filing within an unfiltered search keeps the same result open", () => inBrowser(async (page) => {
  await search(page);
  await page.locator('[data-hit="sample-2"][aria-posinset]').waitFor();
  await open(page, 2);
  await moveToReceipts(page);

  await row(page, 2).getByText("Receipts", { exact: true }).waitFor();
  expect(await row(page, 2).getAttribute("data-open")).toBe("");
  expect(hash(page)).toMatch(/^#\/search\/m\/sample-2/);
}));

it("Mark read advances inside the unread filter and leaves the next message unread", () => inBrowser(async (page) => {
  await page.locator('[data-hit="sample-2"][aria-posinset]').waitFor();
  await reader(page).getByRole("button", { name: "Mark read", exact: true }).click();
  await reader(page).getByRole("heading", { name: "Glaze sample 3", exact: true }).waitFor();
  await row(page, 2).waitFor({ state: "detached" });
  expect(await row(page, 3).getAttribute("data-unread")).toBe("");
  expect(await page.getByRole("button", { name: "Unread", exact: true, pressed: true }).count()).toBe(1);
}, "?unread=1#/search/m/sample-2?q=glaze&unread=1"));

it("Trash advances the preview and Undo restores the row without reopening it", () => inBrowser(async (page) => {
  await search(page);
  await page.locator('[data-hit="sample-2"][aria-posinset]').waitFor();
  await open(page, 2);
  await reader(page).getByRole("button", { name: "Reply", exact: true }).focus();
  await page.keyboard.press("Delete");
  await reader(page).getByRole("heading", { name: "Glaze sample 3", exact: true }).waitFor();
  await row(page, 2).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await row(page, 2).waitFor();
  expect(await row(page, 3).getAttribute("data-open")).toBe("");
}));

it("opens a reply for the result inside the Search reader", () => inBrowser(async (page) => {
  await search(page);
  await open(page, 2);
  await reader(page).getByRole("button", { name: "Reply", exact: true }).click();
  await reader(page).getByRole("textbox", { name: "Reply body" }).waitFor();
  expect(await row(page, 2).getAttribute("data-open")).toBe("");
  expect(hash(page)).toMatch(/^#\/search\/m\/sample-2/);
  await page.keyboard.press("Escape");
  await reader(page).getByRole("textbox", { name: "Reply body" }).waitFor({ state: "hidden" });
  expect(hash(page)).toMatch(/^#\/search\/m\/sample-2/);
}));

it("leaves the Ohbox scroll position alone", () => inBrowser(async (page) => {
  const ohbox = page.locator(".fr-list .ob-scroll");
  await ohbox.waitFor();
  await expect.poll(() => ohbox.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(150);
  await ohbox.evaluate((el) => { el.scrollTop = 150; });
  const before = await ohbox.evaluate((el) => el.scrollTop);
  await page.keyboard.press("/");
  await search(page);
  await open(page, 2);
  expect(await ohbox.count()).toBe(0);
  await page.getByRole("navigation", { name: "Places", exact: true }).getByRole("button", { name: /^Ohbox/ }).click();
  await expect.poll(() => ohbox.evaluate((el) => el.scrollTop)).toBe(before);
}, "#/ohbox"));

it("restores the query and the reader from a Search link", () => inBrowser(async (page) => {
  await row(page, 2).waitFor();
  expect(await field(page).inputValue()).toBe("glaze");
  await expect.poll(() => page.getByRole("button", { name: /has attachment/i }).getAttribute("aria-pressed")).toBe("true");
  await reader(page).getByRole("heading", { name: "Glaze sample 2", exact: true }).waitFor();
  expect(await row(page, 2).getAttribute("data-open")).toBe("");
}, "#/search/m/sample-2?q=glaze&files=1"));

it("Back on a phone returns to the query and focuses the opened result", () => inBrowser(async (page) => {
  await search(page);
  await open(page, 2);
  await reader(page).getByRole("button", { name: "Search", exact: true }).click();
  await expect.poll(() => hash(page)).toMatch(/^#\/search(?:\?|$)/);
  expect(await field(page).inputValue()).toBe("glaze");
  await page.locator('[data-hit="sample-2"][aria-posinset]').waitFor();
  await expect.poll(() => row(page, 2).evaluate((el) => el === document.activeElement)).toBe(true);
}, "#/search", 390));
