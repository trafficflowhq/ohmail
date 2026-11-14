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
