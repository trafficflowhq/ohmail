/**
 * TODAY'S OHBOX SELECTION ON A PHONE, IN A REAL BROWSER. The demo's page (`demo-page/entry.tsx`: the product's
 * providers, today's views in the frame, the product's stylesheets) bundled and run in Chromium at 390 by 844 under a
 * finger. A row held stands the selection's bar at the list's foot, where the dock stands at rest: by the frame's rule
 * no dock is drawn while it stands, so each control of the bar is the control under its middle and a touch on it does
 * the bar's own act, never a place's. The dock is back once the selection is cleared, and once the place is left.
 */
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
type Browser = Awaited<ReturnType<typeof chromium.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
const ROOT = process.cwd();
const ORIGIN = "https://app.ohmail.test";
const PHONE = { width: 390, height: 844 } as const;
/** The row held, and the bar's four controls at a phone's width (the rest of its verbs fold behind More). */
const ROW = /Your talk is in/;
const CONTROLS = [/^1 selected/, /^Read/, /^Unread/, /^More$/] as const;

let browser: Browser | null = null;
const page$ = { js: "", css: "" };
const dirs: string[] = [];
beforeAll(async () => {
  const { build } = await import("esbuild");
  const out = mkdtempSync(join(tmpdir(), "ohmail-todays-selection-"));
  dirs.push(out);
  await build({
    entryPoints: [join(ROOT, "apps/webapp/test/frame/demo-page/entry.tsx")],
    bundle: true, format: "iife", platform: "browser", target: ["es2020"], jsx: "automatic", outdir: out,
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

/** The demo at an address, on a phone under a finger. The page's body is the product layout's. */
async function demo(at: string, phone = true, look?: { face: string; colorScheme: "light" | "dark" }): Promise<Page> {
  const context = await browser!.newContext({
    viewport: phone ? PHONE : { width: 1440, height: 900 },
    hasTouch: phone,
    isMobile: phone,
    colorScheme: look?.colorScheme,
  });
  if (look) {
    await context.addInitScript(({ face, colorScheme }) => {
      localStorage.setItem("ohmail.face", face);
      localStorage.setItem("ohmail.theme", colorScheme);
    }, look);
  }
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/page.js") return route.fulfill({ contentType: "application/javascript", body: page$.js });
    if (path === "/page.css") return route.fulfill({ contentType: "text/css", body: page$.css });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
        <link rel="stylesheet" href="/page.css"></head><body class="mo-canvas app-body today">
        <div id="app" style="display:contents"></div><script src="/page.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/demo${at}`);
  await page.getByRole("navigation", { name: "Places" }).waitFor();
  return page;
}

/** A finger held on the row until the selection stands, then lifted. */
async function hold(page: Page): Promise<void> {
  /* On the row's subject line, as a thumb holds a letter. */
  const subject = page.getByRole("option", { name: ROW }).getByText(ROW);
  await subject.waitFor();
  const at = (await subject.boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: at.x + 20, y: at.y + at.height / 2 }],
  });
  await page.waitForTimeout(900);
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => picked(page), { message: "the hold picked no row", timeout: 5000 }).toBe(1);
  await page.waitForTimeout(400);
}

/** How many rows the selection holds, as its bar says it: none while no bar stands. */
const picked = async (page: Page): Promise<number> => {
  const count = page.getByRole("button", { name: /^\d+ selected/ });
  if ((await count.count()) === 0 || !(await count.first().isVisible())) return 0;
  return Number(/^(\d+)/.exec((await count.first().getAttribute("aria-label")) ?? "")?.[1] ?? 0);
};
/** The docks drawn: the frame's navigation "Places" with a box. */
const docks = (page: Page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('nav[aria-label="Places"]')].filter((n) => n.getBoundingClientRect().height > 0)
        .length,
  );

/** Each visible control of that name, and whether it is the control under its own middle. */
async function underItsMiddle(page: Page, name: RegExp) {
  const found = page.getByRole("button", { name });
  const seen: { box: { x: number; y: number }; hit: boolean }[] = [];
  for (const control of await found.all()) {
    if (!(await control.isVisible())) continue;
    const box = (await control.boundingBox())!;
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const hit = await control.evaluate(
      (el, at) => el.contains(document.elementFromPoint(at.x, at.y)),
      middle,
    );
    seen.push({ box: middle, hit });
  }
  return seen;
}

describe("today's Ohbox selection bar on a phone, 390 by 844, under a finger", () => {
  it("leaves the first group inside the sheet and the final History action clear of the dock", async () => {
    const page = await demo("#/ohbox");
    try {
      const scroller = page.locator(".ob-scroll");
      const first = scroller.getByRole("heading").first();
      const heading = page.locator(".oh-listhead");
      const firstBox = (await first.boundingBox())!;
      const headBox = (await heading.boundingBox())!;
      expect.soft(firstBox.y - headBox.y - headBox.height).toBe(4);
      await scroller.evaluate((list) => { list.scrollTop = list.scrollHeight; });
      const action = scroller.getByRole("button", { name: "History", exact: true });
      const actionBox = (await action.boundingBox())!;
      const dockBox = (await page.locator(".oh-dock").boundingBox())!;
      expect.soft(actionBox.y + actionBox.height).toBeLessThan(dockBox.y);
      expect(await action.evaluate((button) => {
        const box = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  it("while the bar stands no dock is drawn, and each of its controls is the control under its middle", async () => {
    const page = await demo("#/ohbox");
    expect(await docks(page), "no dock at rest").toBe(1);
    await hold(page);
    const seen = await Promise.all(CONTROLS.map(async (name) => ({ name: String(name), at: await underItsMiddle(page, name) })));
    const drawn = await docks(page);
    await page.context().close();
    for (const control of seen) {
      expect(control.at.length, `${control.name} is not on screen`).toBeGreaterThan(0);
      expect(control.at.filter((c) => !c.hit), `${control.name}: something stands over it`).toEqual([]);
    }
    expect(drawn, "a dock is drawn over the selection's bar").toBe(0);
  }, 60_000);

  it("a touch on each control does the bar's own act and leaves the Ohbox where it is", async () => {
    const acts: Record<string, { hash: string; picked: number; unread: string | null; menu: number; docks: number }> = {};
    for (const name of CONTROLS) {
      const page = await demo("#/ohbox");
      /* The held row's own mark of unseen mail: said the same by today's list and by the Ohbox's own. */
      const unread = () => page.getByRole("option", { name: ROW }).first().getAttribute("data-unseen");
      const before = await unread();
      await hold(page);
      const control = (await underItsMiddle(page, name))[0]!;
      await page.touchscreen.tap(control.box.x, control.box.y);
      await page.waitForTimeout(500);
      acts[String(name)] = {
        hash: await page.evaluate(() => location.hash),
        picked: await picked(page),
        unread: (await unread()) === before ? "unchanged" : "changed",
        menu: await page.getByRole("menu").count(),
        docks: await docks(page),
      };
      await page.context().close();
    }
    /* Clear ends the selection, and the dock is back. */
    expect(acts[String(CONTROLS[0])]).toEqual({ hash: "#/ohbox", picked: 0, unread: "unchanged", menu: 0, docks: 1 });
    /* Read and Unread mark the row and end the selection: the row's own mark moves, the dock is back. */
    expect(acts[String(CONTROLS[1])]).toEqual({ hash: "#/ohbox", picked: 0, unread: "changed", menu: 0, docks: 1 });
    expect(acts[String(CONTROLS[2])]).toMatchObject({ hash: "#/ohbox", picked: 0, menu: 0, docks: 1 });
    /* More opens the bar's menu over the selection, which stands: still no dock. */
    expect(acts[String(CONTROLS[3])]).toEqual({ hash: "#/ohbox", picked: 1, unread: "unchanged", menu: 1, docks: 0 });
  }, 120_000);

  it("the dock is back once the place is left while the bar stands", async () => {
    const page = await demo("#/reads");
    await page.evaluate(() => {
      location.hash = "#/ohbox";
    });
    await hold(page);
    const during = await docks(page);
    await page.goBack();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/reads");
    const after = await docks(page);
    await page.context().close();
    expect(during, "a dock is drawn over the selection's bar").toBe(0);
    expect(after, "no dock once the Ohbox is left").toBe(1);
  }, 60_000);
});

it.each([["desktop", false], ["phone", true]] as const)(
  "the %s's native circle button activates with Enter and updates the already-mounted live region",
  async (_device, phone) => {
    const page = await demo("#/ohbox", phone);
    try {
      const circle = page.getByRole("button", { name: "Select the message" }).first();
      const region = await page.locator('[aria-live="polite"][aria-atomic="true"]').elementHandle();
      expect(await region?.textContent()).toBe("");
      const isSeparate = await circle.evaluate(
        (button) => button.parentElement?.closest('[role="option"], [role="button"], button') === null,
      );
      expect(isSeparate).toBe(true);
      await circle.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => picked(page)).toBe(1);
      expect(await region?.textContent()).toBe("1 selected");
      expect(await page.evaluate(() => location.hash)).toBe("#/ohbox");

      await page.keyboard.press("Space");
      await expect.poll(() => picked(page)).toBe(0);
      expect(await region?.textContent()).toBe("");

      if (phone) await circle.tap();
      else await circle.click();
      await expect.poll(() => picked(page)).toBe(1);
      await page.keyboard.press("Escape");
      await expect.poll(() => picked(page)).toBe(0);
    } finally {
      await page.context().close();
    }
  },
);

it.each([["desktop", false], ["phone", true]] as const)(
  "unselected Ohbox circles keep their contact colours on %s",
  async (_device, phone) => {
    const page = await demo("#/ohbox", phone);
    try {
      const first = page.getByRole("option", { name: ROW });
      const other = page.getByRole("option", { name: /Re: Glaze order/ });
      const circleFor = (row: ReturnType<Page["getByRole"]>) =>
        row.locator("..").getByRole("button", { name: "Select the message", exact: true });
      const avatar = other.getByText("G", { exact: true });
      const draw = () => avatar.evaluate((el) => {
        const { backgroundColor, color, boxShadow, visibility } = getComputedStyle(el);
        return { backgroundColor, color, boxShadow, visibility };
      }, undefined, { timeout: 2000 });
      const before = await draw();
      expect(before.visibility).toBe("visible");
      await circleFor(first).press("Enter");
      await expect.poll(() => picked(page)).toBe(1);
      expect(await first.getByText("P", { exact: true }).count()).toBe(0);
      expect(await draw()).toEqual(before);

      const otherCircle = circleFor(other);
      if (!phone) {
        await otherCircle.hover();
        await expect.poll(async () => (await draw()).boxShadow).not.toBe(before.boxShadow);
        await page.mouse.move(0, 0);
        await expect.poll(async () => (await draw()).boxShadow).toBe(before.boxShadow);
      }
      await otherCircle.focus();
      await expect.poll(async () => (await draw()).boxShadow).not.toBe(before.boxShadow);
      expect((await draw()).backgroundColor).toBe(before.backgroundColor);
      await page.keyboard.press("Space");
      await expect.poll(() => picked(page)).toBe(2);
      expect(await otherCircle.getAttribute("aria-pressed")).toBe("true");
    } finally {
      await page.context().close();
    }
  },
);

const looks = (["paper", "ohmarchy"] as const).flatMap((face) =>
  (["light", "dark"] as const).flatMap((colorScheme) =>
    [false, true].map((phone) => ({ face, colorScheme, phone })),
  ),
);

it.each(looks)("shows the keyboard's indicator in $face $colorScheme (phone: $phone)", async (look) => {
  const page = await demo("#/ohbox", look.phone, look);
  try {
    const rows = page.getByRole("option");
    const start = rows.filter({ hasText: /Your talk is in/ });
    await start.focus();
    const focused = rows.and(page.locator(":focus-visible"));
    const paint = () => focused.evaluate((option) => {
      const css = getComputedStyle(option);
      const sample = document.createElement("canvas").getContext("2d")!;
      const sheet = css.getPropertyValue("--sheet");
      const luminance = (colour: string) => {
        sample.fillStyle = sheet;
        sample.fillRect(0, 0, 1, 1);
        sample.fillStyle = colour;
        sample.fillRect(0, 0, 1, 1);
        const [r, g, b] = sample.getImageData(0, 0, 1, 1).data;
        const linear = (c: number) => c / 255 <= 0.04045 ? c / 3294.6 : ((c / 255 + 0.055) / 1.055) ** 2.4;
        return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);
      };
      const contrast = (colour: string | undefined, against: string) => {
        if (!colour) return 0;
        const [light, dark] = [luminance(colour), luminance(against)].sort((a, b) => b - a);
        return (light! + 0.05) / (dark! + 0.05);
      };
      const probe = document.createElement("span");
      probe.style.backgroundColor = css.getPropertyValue("--row-open");
      option.append(probe);
      const openFill = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const open = option.hasAttribute("data-open");
      const ring = css.boxShadow.match(/(?:rgba?|color)\([^)]+\)/)?.[0];
      const bounds = option.getBoundingClientRect();
      const scroll = option.closest(".ob-scroll")!;
      const edge = bounds.right - 0.5;
      return {
        outline: css.outlineStyle,
        shadow: css.boxShadow,
        ringContrast: contrast(ring, sheet),
        sheetContrast: contrast(css.backgroundColor, sheet),
        fillContrast: contrast(ring, css.backgroundColor),
        textContrast: contrast(css.color, css.backgroundColor),
        transition: css.transitionProperty,
        open,
        background: css.backgroundColor,
        openFill,
        scrolled: scroll.scrollTop > 0,
        rightVisible: edge < scroll.getBoundingClientRect().left + scroll.clientWidth &&
          option.contains(document.elementFromPoint(edge, bounds.top + bounds.height / 2)),
      };
    });
    const expectInsetRing = (shadow: string) => {
      expect(shadow.replace(/(?:rgba?|color)\([^)]+\)/, "").trim()).toBe("0px 0px 0px 1px inset");
    };
    const checkQuiet = async () => {
      const quiet = await paint();
      expect(quiet).toMatchObject({ open: false, outline: "none", rightVisible: true });
      expectInsetRing(quiet.shadow);
      expect(quiet.fillContrast).toBeGreaterThanOrEqual(3);
      expect(quiet.ringContrast).toBeGreaterThanOrEqual(3);
    };
    await checkQuiet();

    for (let step = 1; step <= 20; step++) {
      const old = await focused.elementHandle();
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => old!.evaluate((row) => row === document.activeElement)).toBe(false);
      expect(await focused.count()).toBe(1);
      const current = await paint();
      expect(current).toMatchObject({ outline: "none", open: true, rightVisible: true });
      expect(current.background).toBe(current.openFill);
      if (look.face === "paper") {
        expect(current.shadow).toBe("none");
        expect(current.sheetContrast).toBeGreaterThanOrEqual(3);
      } else {
        expectInsetRing(current.shadow);
        expect(current.ringContrast).toBeGreaterThanOrEqual(3);
        expect(current.fillContrast).toBeGreaterThanOrEqual(3);
      }
      expect(current.textContrast).toBeGreaterThanOrEqual(4.5);
      if (step >= 3 && current.scrolled) break;
    }
    expect((await paint()).scrolled).toBe(true);

    await page.emulateMedia({ reducedMotion: "reduce" });
    const previous = await focused.elementHandle();
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => previous!.evaluate((row) => row === document.activeElement)).toBe(false);
    expect((await paint()).transition).toBe("none");

    const scroller = page.locator(".ob-scroll");
    await scroller.evaluate((list) => {
      const view = list.getBoundingClientRect();
      const closed = [...list.querySelectorAll<HTMLElement>('[role="option"]:not([data-open])')].find((row) => {
        const box = row.getBoundingClientRect();
        return box.top >= view.top && box.bottom <= view.bottom;
      });
      closed?.focus({ preventScroll: true });
    });
    expect((await paint()).scrolled).toBe(true);
    await checkQuiet();
  } finally {
    await page.context().close();
  }
}, 30_000);
