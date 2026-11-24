/**
 * WHAT THE READER ASKS FOR, IN A REAL BROWSER, over letters whose markup names pictures, styles, a typeface and a
 * link on hosts of their own (every host under `.example`). One conversation: a let-in sender, a sender waiting at
 * the gate, a name that claims a company, an address that could not be confirmed; pictures load by themselves. The
 * page is served on a routed http origin (on `file:` the proxy is never reached), and every request is recorded.
 * Nothing but the page and the proxy's own address may be asked, each picture under its own letter's id, and none
 * for the waiting or the claiming letter. Control: the let-in letter's pictures ARE asked for.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReaderPage } from "./reader-pages.js";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const ORIGIN = "http://reader.states.invalid";
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let html = "";
/** An 8 by 8 grey picture, as the proxy answers. */
const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");

beforeAll(async () => {
  const states = (await import("./reader-states.mjs")) as { readerStatesPage: () => Promise<string> };
  html = await states.readerStatesPage();
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

describe("the reader's requests in a real browser", () => {
  it("asks only the proxy, for a granted letter's own pictures under its own id", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const asked: string[] = [];
    page.on("request", (r) => asked.push(r.url()));
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === "/img") return route.fulfill({ status: 200, contentType: "image/gif", body: GIF });
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    });
    await page.goto(`${ORIGIN}/?hostile=1&open=h-letin&screen=reading`);
    await page.waitForSelector('[data-conv-id="h-unconfirmed"][data-body-ready]', { timeout: 15_000 });
    await page.waitForTimeout(2_000);
    await page.close();

    const elsewhere = asked.filter((u) => new URL(u).origin !== ORIGIN);
    expect(elsewhere, "a request left for a host a letter names").toEqual([]);
    const pictures = asked.map((u) => new URL(u)).filter((u) => u.pathname === "/img");
    const others = asked.map((u) => new URL(u)).filter((u) => u.pathname !== "/img" && u.pathname !== "/");
    expect(others.map((u) => u.href)).toEqual([]);
    for (const u of pictures) {
      const mid = u.searchParams.get("mid")!;
      expect(["h-letin", "h-unconfirmed"], `a picture asked under ${mid}`).toContain(mid);
      // Its own pictures, styles' pictures and typeface: hosts its own markup names, never a sibling's.
      expect(new URL(u.searchParams.get("u")!).hostname, "a picture asked under another letter's id").toMatch(
        new RegExp(`^(pix|css|font)\\.${mid}\\.example$`),
      );
    }
    const of = (mid: string) => pictures.filter((u) => u.searchParams.get("mid") === mid).length;
    expect(of("h-letin"), "the let-in letter's pictures were not asked for").toBeGreaterThan(0);
    // The tracking pixel stays blank with the account's pixel switch off.
    expect(pictures.filter((u) => u.searchParams.get("u")!.endsWith("/t.gif"))).toEqual([]);
    expect(of("h-waiting")).toBe(0);
    expect(of("h-claims")).toBe(0);
  }, 60_000);
});

it.each([
  ["desktop", 1440, "en", "Tracker blocked", "A tracking pixel was blocked."],
  ["phone", 390, "de", "Tracker blockiert", "Ein Tracking-Pixel wurde blockiert."],
] as const)(
  "the %s shield uses only an icon and discloses the full sentence",
  async (device, width, lang, caption, sentence) => {
    const page = await browser!.newPage({ viewport: { width, height: 900 }, hasTouch: device === "phone" });
    try {
      await openReaderPage(page, `screen=reading&open=lt-journal&device=${device}&lang=${lang}`);
      const shield = page.getByRole("button", { name: caption });
      await shield.waitFor();
      if (device === "desktop") await shield.hover();
      expect(await shield.textContent()).toBe("");
      expect((await shield.boundingBox())!.width).toBeLessThanOrEqual(32);
      expect(await shield.getAttribute("title")).toBe(sentence);
      await (device === "phone" ? shield.tap() : shield.click());
      const dialog = page.getByRole("dialog", { name: caption });
      await dialog.getByRole("note").waitFor();
      expect(await dialog.getByRole("note").textContent()).toBe(sentence);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect(await shield.evaluate((button) => button === document.activeElement)).toBe(true);
    } finally {
      await page.close();
    }
  },
  60_000,
);

it.each([
  ["en", "to you ("],
  ["de", "an dich ("],
] as const)(
  "prints the own address with the recipient and keeps details in %s",
  async (lang, words) => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      await openReaderPage(page, `screen=reading&open=lt-journal&device=phone&lang=${lang}`);
      const head = page.locator('[data-conv-id="lt-journal"] .oh-messagehead');
      const to = head.locator(".oh-messagehead-to");
      await to.waitFor();
      const ownAddress = await to.locator("button[title]").getAttribute("title");
      expect(ownAddress).toMatch(/@/);
      expect(await to.textContent()).toContain(words);
      expect(await to.textContent()).toContain(ownAddress?.match(/<([^>]+)>$/)?.[1] ?? ownAddress);
      const details = to.locator("button[data-details]");
      await details.tap();
      await head.locator(".oh-messagehead-lines").waitFor();
    } finally {
      await page.close();
    }
  },
  60_000,
);
