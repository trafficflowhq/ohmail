import { afterAll, beforeAll, expect, it } from "vitest";
import de from "../../messages/write.de.json" with { type: "json" };
import en from "../../messages/write.en.json" with { type: "json" };
import { chromium } from "../support/browser-page.js";
import { writeStatesPage } from "./write-states.mjs";

const ORIGIN = "http://write.states.invalid";
const WIDTH = 320;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let html = "";

beforeAll(async () => {
  html = await writeStatesPage();
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

it.each([
  ["en", en],
  ["de", de],
] as const)(
  "keeps Discard reachable below its explanation in narrow Write (%s)",
  async (lang, words) => {
    const page = await browser!.newPage({ viewport: { width: WIDTH, height: 800 }, hasTouch: true });
    try {
      await page.route(`${ORIGIN}/**`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
      );
      await page.goto(`${ORIGIN}/?state=draft&device=phone&discard=sent-elsewhere&lang=${lang}`);
      await page.locator('html[data-ready="1"]').waitFor();

      const letter = page.getByRole("region", { name: words.write.letter, exact: true });
      const sentence = words.compose.cancelWhatSentElsewhereTyped;
      const explanation = letter.getByText(sentence, { exact: true });
      const toolbar = letter.getByRole("toolbar", { name: words.write.verbs, exact: true });
      const discard = toolbar.getByRole("button", {
        name: `${words.write.discard}. ${sentence}`,
        exact: true,
      });

      expect(await explanation.isVisible(), "the discard explanation").toBe(true);
      expect(await discard.isVisible(), "the named Discard button").toBe(true);
      const note = (await explanation.boundingBox())!;
      const actions = (await toolbar.boundingBox())!;
      expect(note.x).toBeGreaterThanOrEqual(0);
      expect(note.x + note.width).toBeLessThanOrEqual(WIDTH);
      expect(note.y + note.height).toBeLessThanOrEqual(actions.y);
      await discard.click({ trial: true });
    } finally {
      await page.close();
    }
  },
  30_000,
);

it("shows the failed send with the studio's verdict and way back", async () => {
  const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?state=draft&device=phone&send=failed`);
    await page.locator('html[data-ready="1"]').waitFor();
    const verdict = page.getByText("Not sent.", { exact: true });
    expect(await verdict.count()).toBe(1);
    expect(await verdict.isVisible()).toBe(true);
    expect(await verdict.evaluate((el) => el.tagName)).toBe("B");
    expect(
      await page
        .getByRole("status")
        .filter({ hasText: "Not sent. Sending did not work, but your draft is kept, so try again." })
        .count(),
    ).toBe(1);
  } finally {
    await page.close();
  }
}, 30_000);

it("explains an unreachable mail server with the studio's retry wording", async () => {
  const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?state=draft&device=phone&send=unreachable`);
    await page.locator('html[data-ready="1"]').waitFor();
    expect(
      await page
        .getByRole("status")
        .filter({ hasText: "It's kept in Drafts, so send it again once your mail server answers." })
        .count(),
    ).toBe(1);
  } finally {
    await page.close();
  }
}, 30_000);

it.each([344, 390, 884])(
  "keeps Send and the editor above a keyboard at width %i",
  async (width) => {
    const page = await browser!.newPage({ viewport: { width, height: 844 }, hasTouch: true });
    try {
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${ORIGIN}/?state=draft&device=${width <= 390 ? "phone" : "fold"}`);
      const letter = page.getByRole("region", { name: en.write.letter, exact: true });
      const editor = letter.getByRole("textbox", { name: en.write.text, exact: true });
      const send = letter.getByRole("button", { name: en.write.send, exact: true });
      await editor.focus();
      await page.evaluate(() => {
        const viewport = window.visualViewport!;
        Object.defineProperty(viewport, "height", { configurable: true, get: () => 400 });
        viewport.dispatchEvent(new Event("resize"));
      });
      await page.waitForFunction(() => {
        const pane = document.querySelector("[data-writing-keyboard]");
        return pane && pane.getBoundingClientRect().bottom <= 401;
      });
      await editor.press("End");
      await editor.press("Space");
      const action = (await send.boundingBox())!;
      const text = (await editor.boundingBox())!;
      expect(action.y).toBeGreaterThanOrEqual(0);
      expect(action.y + action.height).toBeLessThanOrEqual(400);
      expect(action.y).toBeGreaterThan(text.y);
      await expect
        .poll(() =>
          editor.evaluate((el) => {
            const range = getSelection()?.getRangeAt(0).cloneRange();
            range?.collapse(false);
            const caret = range?.getBoundingClientRect();
            const scroll = el.closest("[data-reading-scroll]")!.getBoundingClientRect();
            return Boolean(
              caret && caret.height > 0 && caret.top >= scroll.top - 1 && caret.bottom <= scroll.bottom + 1,
            );
          }),
        )
        .toBe(true);
      await expect.poll(() => letter.getByText("From", { exact: true }).isVisible()).toBe(true);
      expect(text.y).toBeLessThan(400);
      expect(await page.evaluate(() => scrollY)).toBe(0);
    } finally {
      await page.close();
    }
  },
  30_000,
);

it("keeps the Send target and typing line visible in a 105 px keyboard viewport", async () => {
  const page = await browser!.newPage({ viewport: { width: 344, height: 780 }, hasTouch: true });
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?state=draft&device=phone`);
    const editor = page.getByRole("textbox", { name: en.write.text, exact: true });
    const send = page.getByRole("button", { name: en.write.send, exact: true });
    await editor.focus();
    const resize = (height: number) =>
      page.evaluate((h) => {
        Object.defineProperty(visualViewport!, "height", { configurable: true, get: () => h });
        visualViewport!.dispatchEvent(new Event("resize"));
      }, height);
    await editor.press("End");
    await resize(105);
    const visible = () =>
      editor.evaluate((el) => {
        const scroller = el.closest("[data-reading-scroll]")!.getBoundingClientRect();
        const range = getSelection()?.getRangeAt(0).cloneRange();
        range?.collapse(false);
        const caret = range?.getBoundingClientRect();
        return Boolean(
          caret && caret.height > 0 && caret.top >= scroller.top - 1 && caret.bottom <= scroller.bottom + 1,
        );
      });
    const sendBottom = async () => {
      const box = (await send.boundingBox())!;
      return box.y + box.height;
    };
    await expect.poll(sendBottom, { timeout: 1800 }).toBeLessThanOrEqual(105);
    await expect.poll(visible, { timeout: 1800 }).toBe(true);
    await page.keyboard.insertText(" still here");
    await expect.poll(visible, { timeout: 1800 }).toBe(true);
    expect(await sendBottom()).toBeLessThanOrEqual(105);
    const draft = await editor.textContent();
    expect(draft).toContain("still here");
    await resize(780);
    await page.waitForFunction(() => !document.querySelector("[data-writing-keyboard]"));
    await expect.poll(() => editor.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await editor.textContent()).toBe(draft);
    expect(await page.evaluate(() => scrollY)).toBe(0);
  } finally {
    await page.close();
  }
}, 30_000);
