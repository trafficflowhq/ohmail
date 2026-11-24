/**
 * SETUP UNDER THE FRAME, IN A REAL BROWSER. The web shell in the frame (`first-run-page/entry.tsx`: the product's
 * providers and stylesheets, a connected mailbox nothing has agreed to organize yet) bundled and run in Chromium at
 * `#/first-run`. The frame makes what it holds inert while setup stands over it, and jsdom models neither `inert` nor
 * the cascade: a stage drawn inside the held frame took no press and no key, and a foot of the kit's own name stood at
 * the window's corners. Here a person goes through it with the mouse alone and with the keyboard alone, at a wide and a
 * phone's width, and the foot is measured inside the card at every width from 320 to 2560 and at Text size 1.5.
 *
 * SORTED (the switch's older tests, sorted once): setup is the frame's stage now, one dialog named as the frame names
 * its stage, the step saying itself by its heading; the step's card is its own page, the stage's one main landmark,
 * whose content runs across the step's text column. Every expectation as it stood.
 */
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { TEXT_SIZE_KEY, textSizeBootScript } from "../../app/shell/text-size";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
type Browser = Awaited<ReturnType<typeof chromium.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
const ROOT = process.cwd();
const ORIGIN = "https://app.ohmail.test";
const t = en.onboarding;
/** The steps a connected, not yet organized mailbox walks first, by the heading each one says. */
const ORGANIZE = t.organizeLast.replace("<window></window>.", t.windowYear);
const AI = t.aiSay.replace("<on></on>.", t.aiOff);

let browser: Browser | null = null;
const page$ = { js: "", css: "" };
const dirs: string[] = [];
beforeAll(async () => {
  const { build } = await import("esbuild");
  const out = mkdtempSync(join(tmpdir(), "ohmail-first-run-"));
  dirs.push(out);
  await build({
    entryPoints: [join(ROOT, "apps/webapp/test/frame/first-run-page/entry.tsx")],
    bundle: true, format: "esm", platform: "browser", target: ["es2022"], jsx: "automatic", outdir: out,
    entryNames: "page",
    alias: { "next-intl": join(ROOT, "apps/webapp/test/editor-feel/intl-shim.mjs") },
    loader: { ".json": "json", ".css": "css", ".woff2": "dataurl", ".woff": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl" },
    banner: { js: "window.process = window.process || { env: {} };" },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": "undefined" },
    logLevel: "warning",
  });
  page$.js = readFileSync(join(out, "page.js"), "utf8");
  page$.css = readFileSync(join(out, "page.css"), "utf8");
  browser = await chromium.launch();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Setup at `#/first-run` on its first step, at a window's size; a Text size where one is named, stamped as the page's boot does. */
async function setup(width: number, height: number, textSize?: number): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  if (textSize !== undefined)
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [TEXT_SIZE_KEY, String(textSize)] as const);
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/page.js") return route.fulfill({ contentType: "application/javascript", body: page$.js });
    if (path === "/page.css") return route.fulfill({ contentType: "text/css", body: page$.css });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
        <link rel="stylesheet" href="/page.css"><script>${textSizeBootScript()}</script></head>
        <body class="mo-canvas app-body today"><div id="app" style="display:contents"></div><script type="module" src="/page.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/#/first-run?mailbox=mb1`);
  await step(page, ORGANIZE).waitFor({ timeout: 20_000 });
  return page;
}

/* Setup is the frame's stage: the one dialog, named as the frame names its stage; the step says itself by its heading. */
const dialog = (page: Page) => page.getByRole("dialog", { name: en.frame.landmark.stage, exact: true });
const step = (page: Page, title: string) => page.getByRole("heading", { name: title });
const button = (page: Page, name: string) => dialog(page).getByRole("button", { name: new RegExp(`^${escape(name)}`) });
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** The step on screen: the heading of the one step drawn. */
async function stepOn(page: Page): Promise<string | null> {
  for (const title of [ORGANIZE, AI]) if (await step(page, title).isVisible()) return title;
  return null;
}
const asked = (page: Page) => page.evaluate(() => (window as unknown as { firstRunAsked: { complete: number } }).firstRunAsked);
/** Whether an element or anything it stands in is inert. */
const inert = (page: Page, name: string) =>
  button(page, name).first().evaluate((el) => el.closest("[inert]") !== null);
/** The app behind setup, once setup has closed: the frame's rail (its dock on a phone), visible and taking presses. */
async function appStands(page: Page): Promise<{ hash: string; dialog: number; places: boolean; inert: boolean }> {
  const rail = new RegExp(`^(${en.frame.landmark.places}|${en.frame.landmark.fedRail})$`);
  const places = page.getByRole("navigation", { name: rail }).first();
  return {
    hash: await page.evaluate(() => location.hash),
    dialog: await dialog(page).count(),
    places: await places.isVisible(),
    inert: await places.evaluate((el) => el.closest("[inert]") !== null),
  };
}

const SIZES = [
  { name: "1440 by 900", width: 1440, height: 900 },
  { name: "390 by 844", width: 390, height: 844 },
] as const;

for (const size of SIZES) {
  describe(`setup over the frame at ${size.name}`, () => {
    it("nothing of setup stands in what the frame makes inert", async () => {
      const page = await setup(size.width, size.height);
      const held = { agree: await inert(page, t.agree), cancel: await inert(page, t.setupMenu) };
      await page.context().close();
      expect(held, "setup's controls stand in an inert subtree").toEqual({ agree: false, cancel: false });
    }, 60_000);

    // The folder map and consent share the step, so Agree is its forward control.
    it("with the mouse: a click on Continue moves the step", async () => {
      const page = await setup(size.width, size.height);
      await button(page, t.agree).click({ timeout: 5000 });
      await expect.poll(() => stepOn(page), { message: "Agree moved no step", timeout: 5000 }).toBe(AI);
      await page.context().close();
    }, 60_000);

    it("with the keyboard: ↵ on a step moves the step", async () => {
      const page = await setup(size.width, size.height);
      await page.keyboard.press("Enter");
      await expect.poll(() => stepOn(page), { message: "↵ moved no step", timeout: 5000 }).toBe(AI);
      await page.context().close();
    }, 60_000);

    it("with the keyboard: Escape asks to close, and ↵ there closes setup and the app stands", async () => {
      const page = await setup(size.width, size.height);
      await page.keyboard.press("Escape");
      await expect.poll(() => button(page, t.cancelConfirm).isVisible(), { message: "Escape opened no confirm", timeout: 5000 }).toBe(true);
      await page.keyboard.press("Enter");
      await expect.poll(() => dialog(page).count(), { message: "↵ in the confirm did not close setup", timeout: 5000 }).toBe(0);
      const app = await appStands(page);
      const said = await asked(page);
      await page.context().close();
      expect(app).toEqual({ hash: "#/ohbox", dialog: 0, places: true, inert: false });
      expect(said.complete, "closing setup stamped it done once").toBe(1);
    }, 60_000);

    it("with the keyboard: in the confirm, Escape takes it back and the step stands; ↵ then moves the step", async () => {
      const page = await setup(size.width, size.height);
      await page.keyboard.press("Escape");
      await expect.poll(() => button(page, t.cancelConfirm).isVisible(), { message: "Escape opened no confirm", timeout: 5000 }).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => button(page, t.cancelConfirm).count(), { message: "Escape left the confirm open", timeout: 5000 }).toBe(0);
      const stood = await stepOn(page);
      await page.keyboard.press("Enter");
      await expect.poll(() => stepOn(page), { message: "↵ after the confirm moved no step", timeout: 5000 }).toBe(AI);
      const said = await asked(page);
      await page.context().close();
      expect(stood, "the step did not stand").toBe(ORGANIZE);
      expect(said.complete, "taking the confirm back closed setup").toBe(0);
    }, 60_000);

    it("with the mouse: Cancel setup asks, Back takes it back, Close setup closes and the app stands", async () => {
      const page = await setup(size.width, size.height);
      await button(page, t.setupMenu).click({ timeout: 5000 });
      await dialog(page).getByRole("menuitem", { name: new RegExp(`^${escape(t.cancel)}`) }).click({ timeout: 5000 });
      await button(page, t.cancelConfirm).waitFor({ timeout: 5000 });
      /* The confirm's Back, not the foot's: the confirm's is the last of the name in the dialog. */
      await button(page, t.back).last().click({ timeout: 5000 });
      await expect.poll(() => button(page, t.cancelConfirm).count(), { message: "Back left the confirm open", timeout: 5000 }).toBe(0);
      const stood = await stepOn(page);
      await button(page, t.setupMenu).click({ timeout: 5000 });
      await dialog(page).getByRole("menuitem", { name: new RegExp(`^${escape(t.cancel)}`) }).click({ timeout: 5000 });
      await button(page, t.cancelConfirm).click({ timeout: 5000 });
      await expect.poll(() => dialog(page).count(), { message: "Close setup did not close it", timeout: 5000 }).toBe(0);
      const app = await appStands(page);
      await page.context().close();
      expect(stood, "the step did not stand").toBe(ORGANIZE);
      expect(app).toEqual({ hash: "#/ohbox", dialog: 0, places: true, inert: false });
    }, 60_000);
  });
}

/**
 * THE FOOT BELONGS TO THE CARD: Cancel setup and Start over on the left, Back and the step's verb on the right, inside
 * the card's box at its bottom, and the card on screen: never at the window's edge, never under the rail, never cut.
 * Read on the first three steps, each scrolled to its foot as a person scrolls a tall step on a phone.
 */
describe("setup's foot stands inside its card", () => {
  const WIDTHS = [
    { width: 320, height: 640 }, { width: 390, height: 844 }, { width: 1440, height: 900 },
    { width: 2000, height: 1300 }, { width: 2560, height: 1440 },
  ];
  const cases = [
    ...WIDTHS.map((w) => ({ ...w, textSize: undefined as number | undefined })),
    { width: 390, height: 844, textSize: 150 }, { width: 1440, height: 900, textSize: 150 },
  ];
  for (const c of cases) {
    it(`at ${c.width} by ${c.height}${c.textSize ? ", Text size 1.5" : ""}`, async () => {
      const page = await setup(c.width, c.height, c.textSize);
      const seen: string[] = [];
      for (const title of [ORGANIZE, AI]) {
        await step(page, title).waitFor({ timeout: 5000 });
        const action = title === ORGANIZE ? t.agree : t.continue;
        const at = await button(page, action).evaluate(async (el) => {
          const box = (e: Element | null) => {
            const r = e!.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          };
          /* The step's card is its own page, the one main landmark of the stage's dialog. */
          const card = el.closest("main")!;
          /* Read where the card comes to rest: its entrance moves it. */
          await Promise.all(card.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined)));
          const foot = el.closest(".oh-page-acts")!;
          foot.scrollIntoView({ block: "end" });
          /* The text column runs across the Page grid. The heading inside it has its own line-length limit. */
          const column = box(card.querySelector(".oh-page-say"));
          const inner = { left: column.left, right: column.right };
          const controls = [...foot.children].filter((c) => c.tagName === "BUTTON").map(box);
          const rect = box(foot);
          const padding = getComputedStyle(foot);
          const scale = rect.right - rect.left === 0 ? 1 : (rect.right - rect.left) / (foot as HTMLElement).offsetWidth;
          const content = { left: rect.left + scale * parseFloat(padding.paddingLeft), right: rect.right - scale * parseFloat(padding.paddingRight), top: rect.top + scale * parseFloat(padding.paddingTop), bottom: rect.bottom - scale * parseFloat(padding.paddingBottom) };
          return { card: box(card), inner, foot: content, controls, view: { right: innerWidth, bottom: innerHeight } };
        });
        const inside = (b: { left: number; top: number; right: number; bottom: number }, o: typeof b) =>
          b.left >= o.left - 0.5 && b.right <= o.right + 0.5 && b.top >= o.top - 0.5 && b.bottom <= o.bottom + 0.5;
        const view = { left: 0, top: 0, ...at.view };
        if (!inside(at.foot, at.card)) seen.push(`${title}: the foot ${JSON.stringify(at.foot)} is outside the card ${JSON.stringify(at.card)}`);
        for (const b of at.controls)
          if (!inside(b, view)) seen.push(`${title}: a control of the foot ${JSON.stringify(b)} is cut by the window ${JSON.stringify(view)}`);
        /* Across the card: the foot runs from the card's inner left edge to its inner right edge. */
        if (Math.abs(at.foot.left - at.inner.left) > 1 || Math.abs(at.foot.right - at.inner.right) > 1)
          seen.push(`${title}: the foot ${JSON.stringify(at.foot)} does not run across the card ${JSON.stringify(at.inner)}`);
        /* On to the next step by its own ↵: Agree. */
        if (title !== AI) await page.keyboard.press("Enter");
      }
      await page.context().close();
      expect(seen).toEqual([]);
    }, 60_000);
  }
});
