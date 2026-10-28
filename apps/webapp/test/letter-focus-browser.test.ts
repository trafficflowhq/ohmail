import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A CLICK INTO A FRAMED LETTER KEEPS THE APP'S KEYS, AND COPY STILL COPIES THE LETTER — in Chromium
 * and WebKit, which jsdom cannot stand in for: the frame's focus, its selection and where the
 * browser runs copy and select-all. Page: the real watcher (`letter-focus.ts`) over an
 * `iframe.mb-frame` with the reader's sandbox, on a routed origin.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const pw = require_("@playwright/test") as typeof import("@playwright/test");
type Browser = Awaited<ReturnType<typeof pw.chromium.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
const ROOT = process.cwd();
const ORIGIN = "https://app.ohmail.test";
const LETTER = `<p id="code">Your parcel code is ZX12345, keep it.</p>${"<p>Some more of the letter to read on with.</p>".repeat(80)}`;

let bundle = "";
const dirs: string[] = [];
beforeAll(async () => {
  const { build } = await import("esbuild");
  const out = mkdtempSync(join(tmpdir(), "ohmail-letter-focus-"));
  dirs.push(out);
  await build({
    stdin: {
      contents: `import { holdLetterFocusWatch } from "./letter-focus"; import { FRAME_SANDBOX } from "./MessageBody";
        window.rig = { FRAME_SANDBOX, hold: () => holdLetterFocusWatch(window) };`,
      resolveDir: join(ROOT, "apps/webapp/app/components"), loader: "ts", sourcefile: "rig.ts",
    },
    bundle: true, format: "iife", platform: "browser", target: ["es2020"], jsx: "automatic", outfile: join(out, "rig.js"),
    alias: { "next-intl": join(ROOT, "apps/webapp/test/editor-feel/intl-shim.mjs") },
    loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".woff2": "empty", ".json": "json" },
    banner: { js: "window.process = window.process || { env: {} };" },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": "undefined" },
    logLevel: "warning",
  });
  bundle = readFileSync(join(out, "rig.js"), "utf8");
}, 120_000);
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function open(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    if (new URL(route.request().url()).pathname === "/rig.js") return route.fulfill({ contentType: "application/javascript", body: bundle });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><body style="margin:0"><p id="app">Inbox list and toolbar</p>` +
        `<textarea id="paste" style="width:400px;height:40px"></textarea><div id="reader"></div></body><script src="/rig.js"></script>`,
    });
  });
  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForFunction(() => typeof (window as unknown as { rig?: unknown }).rig === "object");
  await page.evaluate((letter) => {
    const w = window as unknown as { rig: { FRAME_SANDBOX: string; hold: () => void }; keys: string[] };
    w.keys = [];
    document.addEventListener("keydown", (e) => w.keys.push(e.key));
    // The window blurs each time the letter takes the focus.
    window.addEventListener("blur", () => w.keys.push("(letter)"));
    const f = document.createElement("iframe");
    f.className = "mb-frame";
    f.setAttribute("sandbox", w.rig.FRAME_SANDBOX);
    f.style.cssText = "width:800px;height:500px;border:0";
    f.srcdoc = `<!doctype html><html><body>${letter}</body></html>`;
    document.getElementById("reader")!.append(f);
    w.rig.hold();
  }, LETTER);
  await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.getElementById("code") != null);
  return page;
}

const state = (page: Page) => page.evaluate(() => {
  const f = document.querySelector("iframe")!;
  return {
    keys: (window as unknown as { keys: string[] }).keys.slice(),
    inLetter: document.activeElement === f,
    letterSelection: f.contentDocument!.getSelection()!.toString().length,
    appSelection: document.getSelection()!.toString().length,
  };
});

/**
 * What the clipboard holds, read by pasting it into the app's own field. Playwright's WebKit on Linux
 * runs no copy or select-all key on a page's own selection (the control reads it), so the app's own
 * copy and select-all are read only where the engine runs them; the letter's are read everywhere.
 */
async function pasted(page: Page): Promise<string> {
  await page.evaluate(() => { (document.getElementById("paste") as HTMLTextAreaElement).value = ""; });
  await page.click("#paste");
  await page.keyboard.press("ControlOrMeta+v");
  return page.evaluate(() => (document.getElementById("paste") as HTMLTextAreaElement).value);
}

const ENGINES = [["chromium", pw.chromium], ["webkit", pw.webkit]] as const;
for (const [name, engine] of ENGINES) {
  describe.runIf(existsSync(engine.executablePath()))(`${name}: a click into a framed letter`, () => {
    let browser: Browser | null = null;
    beforeAll(async () => { browser = await engine.launch(); }, 120_000);
    afterAll(async () => { await browser?.close(); });
    let copies = false;

    it("control: a selection in the app is copied by the key (where the engine copies at all)", async () => {
      const page = await open(browser!);
      try {
        await page.click("#app", { clickCount: 3 });
        await page.keyboard.press("ControlOrMeta+c");
        copies = (await pasted(page)).includes("Inbox list and toolbar");
        if (name === "chromium") expect(copies).toBe(true);
      } finally {
        await page.context().close();
      }
    }, 60_000);

    it("select a code, copy it, read on: j and Escape reach the app and the code is on the clipboard", async () => {
      const page = await open(browser!);
      try {
        await page.frameLocator("iframe").locator("#code").dblclick({ position: { x: 150, y: 8 } });
        const word = await page.evaluate(() => document.querySelector("iframe")!.contentDocument!.getSelection()!.toString());
        expect(word.length, "the double-click selected nothing: the case is not exercised").toBeGreaterThan(0);
        await page.waitForTimeout(400);
        expect((await state(page)).inLetter, "the held selection kept the focus in the letter").toBe(false);
        await page.keyboard.press("ControlOrMeta+c");
        await page.waitForTimeout(500);
        await page.keyboard.press("j");
        await page.keyboard.press("Escape");
        const s = await state(page);
        expect(s.keys.slice(s.keys.lastIndexOf("Control")), "the letter took the keys")
          .toEqual(["Control", "c", "j", "Escape"]);
        expect(s.inLetter).toBe(false);
        expect(s.letterSelection, "the selection was dropped").toBe(word.length);
        expect(await pasted(page)).toBe(word);
      } finally {
        await page.context().close();
      }
    }, 60_000);

    it("click, select all, copy: the whole letter is selected and copied, not the app", async () => {
      const page = await open(browser!);
      try {
        await page.frameLocator("iframe").locator("#code").click();
        await page.waitForTimeout(400);
        expect((await state(page)).inLetter, "the plain click kept the focus in the letter").toBe(false);
        await page.keyboard.press("ControlOrMeta+a");
        const s = await state(page);
        expect(s.letterSelection).toBeGreaterThan(3000);
        expect(s.appSelection).toBe(0);
        await page.waitForTimeout(400);
        await page.keyboard.press("ControlOrMeta+c");
        await page.waitForTimeout(400);
        expect(await pasted(page)).toContain("Your parcel code is ZX12345");
        await page.keyboard.press("Escape");
        expect((await state(page)).keys).toContain("Escape");
      } finally {
        await page.context().close();
      }
    }, 60_000);

    it("control: once the app is pressed, select all and copy are the app's own again", async () => {
      const page = await open(browser!);
      try {
        await page.frameLocator("iframe").locator("#code").dblclick({ position: { x: 150, y: 8 } });
        await page.waitForTimeout(400);
        await page.click("#app", { clickCount: 3 });
        await page.keyboard.press("ControlOrMeta+c");
        expect((await state(page)).keys.at(-1), "the app's own copy was routed to the letter").toBe("c");
        if (copies) expect(await pasted(page)).toContain("Inbox list and toolbar");
        await page.click("#app");
        await page.keyboard.press("ControlOrMeta+a");
        const s = await state(page);
        expect(s.inLetter).toBe(false);
        expect(s.letterSelection, "select-all went to the letter").toBeLessThan(100);
        if (copies) expect(s.appSelection).toBeGreaterThan(0);
      } finally {
        await page.context().close();
      }
    }, 60_000);
  });
}
