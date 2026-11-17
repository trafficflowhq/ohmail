/**
 * THE KIT's FIELDS, BUTTONS AND TILES IN A FORM, IN A REAL BROWSER: what jsdom cannot type or send. Each case
 * mounts the kit's own parts with React running, types with real keys, and reads what the page's markup holds,
 * what a press read, how often a form was sent, and where the keys are.
 *
 * What is typed as a password is looked for and never printed: every reading is a yes, a no or a count.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch } from "../../../../test/compare/render.mjs";
import type { Told } from "./forms-in-a-browser.page.js";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
type Browser = Awaited<ReturnType<typeof launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

const TYPED = "zq-typed-by-real-keys-4d2a";
let browser: Browser | null = null;
let script = "";
beforeAll(async () => {
  const { build } = await import("esbuild");
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./forms-in-a-browser.page.tsx", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    jsx: "automatic",
    loader: { ".css": "empty", ".svg": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  script = out.outputFiles[0]!.text;
  browser = await launch(chromium);
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

/** The forms mounted in a window of their own. */
async function mount(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1000, height: 900 }, reducedMotion: "reduce" });
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="host"></div></body></html>`,
  );
  /* A control that is not there is said at once, by its name, not by the case's own time running out. */
  page.setDefaultTimeout(5000);
  await page.addScriptTag({ content: script });
  await page.evaluate(
    (typed) =>
      (window as unknown as { mountForms: (h: Element, typed: string) => void }).mountForms(
        document.getElementById("host")!,
        typed,
      ),
    TYPED,
  );
  await page.getByLabel("Kept password").waitFor();
  return page;
}
const inMarkup = (page: Page): Promise<boolean> =>
  page.evaluate((typed) => document.documentElement.outerHTML.includes(typed), TYPED);
const told = (page: Page): Promise<Told> => page.evaluate(() => (window as unknown as { told: Told }).told);
const keysOn = (page: Page): Promise<string> =>
  page.evaluate(() => document.activeElement?.textContent ?? "");

describe("a password typed by real keys", () => {
  it("is in no markup in a form that keeps it: typed, sent by Enter, shown as text, hidden again", async () => {
    const page = await mount();
    try {
      await page.getByLabel("Kept password").click();
      await page.keyboard.type(TYPED);
      const typed = await inMarkup(page);
      await page.keyboard.press("Enter");
      const read = (await told(page)).read.keeping;
      const sent = await inMarkup(page);
      await page.getByRole("button", { name: "Show kept" }).click();
      const shown = [await inMarkup(page), await page.getByLabel("Kept password").getAttribute("type")];
      await page.getByRole("button", { name: "Show kept" }).click();
      const hidden = [await inMarkup(page), await page.getByLabel("Kept password").getAttribute("type")];
      expect({ typed, read, sent, shown, hidden }).toEqual({
        typed: false,
        read: true,
        sent: false,
        shown: [false, "text"],
        hidden: [false, "password"],
      });
    } finally {
      await page.close();
    }
  });

  it("is in no markup in a sentence's blank either, shown as text and hidden again", async () => {
    const page = await mount();
    try {
      await page.getByLabel("Blank password").click();
      await page.keyboard.type(TYPED);
      const typed = await inMarkup(page);
      await page.getByRole("button", { name: "Show blank" }).click();
      const shown = await inMarkup(page);
      await page.getByRole("button", { name: "Show blank" }).click();
      const hidden = await inMarkup(page);
      expect({ typed, shown, hidden }).toEqual({ typed: false, shown: false, hidden: false });
    } finally {
      await page.close();
    }
  });

  it("is read by the press from the field itself where the form hands no value, and filled as a password manager fills it is handed to the form: in no markup", async () => {
    const page = await mount();
    try {
      await page.getByLabel("Own password").click();
      await page.keyboard.type(TYPED);
      await page.getByRole("button", { name: "Sign in own" }).click();
      await page.getByLabel("Filled password").fill(TYPED);
      await page.getByRole("button", { name: "Sign in filled" }).click();
      const { read } = await told(page);
      expect({ own: read.own, filled: read.filled, markup: await inMarkup(page) }).toEqual({
        own: true,
        filled: true,
        markup: false,
      });
    } finally {
      await page.close();
    }
  });
});

describe("Enter in a form's field while its submit button is under way", () => {
  it("sends nothing: one field or two, as with a button that is off; a button that is ready sends once", async () => {
    const page = await mount();
    try {
      for (const name of ["busy", "off", "ready", "two"]) {
        await page.getByLabel(`Code ${name}`).click();
        await page.keyboard.type("1");
        await page.keyboard.press("Enter");
      }
      const { sent } = await told(page);
      const busy = page.getByRole("button", { name: "Verify busy" });
      /* It stays the form's submit button, said off and never turned off by the browser's own switch. */
      expect({
        sent: [sent.busy ?? 0, sent.off ?? 0, sent.ready ?? 0, sent.two ?? 0],
        type: await busy.getAttribute("type"),
        saidOff: await busy.getAttribute("aria-disabled"),
        turnedOff: await busy.evaluate((el) => (el as HTMLButtonElement).disabled),
      }).toEqual({ sent: [0, 0, 1, 0], type: "submit", saidOff: "true", turnedOff: false });
    } finally {
      await page.close();
    }
  });
});

describe("the tiles of a choice by the keys", () => {
  it("are one stop of Tab: the arrows, Home and End move the keys between them, and Tab leaves the group", async () => {
    const page = await mount();
    try {
      await page.getByRole("button", { name: "Before the tiles" }).focus();
      await page.keyboard.press("Tab");
      const entered = await keysOn(page);
      await page.keyboard.press("ArrowRight");
      const arrow = await keysOn(page);
      await page.keyboard.press("End");
      const end = await keysOn(page);
      await page.keyboard.press("Home");
      const home = await keysOn(page);
      await page.keyboard.press("ArrowLeft");
      const back = await keysOn(page);
      await page.keyboard.press("Tab");
      const left = await keysOn(page);
      expect({ entered, arrow, end, home, back, left }).toEqual({
        entered: "Gmail",
        arrow: "Microsoft",
        end: "Yahoo",
        home: "Gmail",
        back: "Yahoo",
        left: "After the tiles",
      });
    } finally {
      await page.close();
    }
  });
});
