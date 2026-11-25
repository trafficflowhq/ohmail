/**
 * THE PLACES' STATES IN A REAL BROWSER, on the places' states page: every key the comparison draws for the eleven
 * screens (each state, and the named state in each of the seven links) opens its place at its reference picture's
 * window, with no error and no catalogue key shown. In German at a Text size of 1.5 (the web door's zoom on <html>),
 * no word is cut or runs past its part where the English one is not and does not, and no control is left unnamed.
 * Nothing leaves the machine: the page is served on a routed origin.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCalRestPage } from "./calrest-page-open.js";
import { openPlacesPage, placesStatesPage } from "./places-pages.js";
import { comparedKeys, PLACE_SCREENS } from "./places-states.mjs";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
type Browser = Awaited<ReturnType<typeof chromium.launch>>;

type Row = { key: string; png: { w: number; h: number; scale: number } };
const sizeOf = new Map(
  (
    JSON.parse(readFileSync(resolve(process.cwd(), "test/compare/manifest.json"), "utf8")) as { rows: Row[] }
  ).rows.map((r) => [
    r.key,
    { width: Math.round(r.png.w / r.png.scale), height: Math.round(r.png.h / r.png.scale) },
  ]),
);
const KEYS = PLACE_SCREENS.flatMap((s) => comparedKeys(s));
const NAMESPACES =
  /\b(frame|shared|place|news|reads|stream|receipts|later|parked|resurface|triage|history|tags|tag|folder|address|drafts|trash)\.[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)*\b/;

let browser: Browser | null = null;

beforeAll(async () => {
  await placesStatesPage();
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

/** A fault: where it stands (its kind and the element's place in the document, the same in both languages) and what it says. */
type Fault = { at: string; said: string };

/** The state at `key` in `lang` at a Text size of 1.5: whether its place stood, and its faults. */
async function look(key: string, lang: "en" | "de"): Promise<{ stood: boolean; faults: Fault[] }> {
  const page = await browser!.newPage({ viewport: sizeOf.get(key) ?? { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await openPlacesPage(page, `${key}&lang=${lang}`);
    const stood = await page
      .waitForFunction(
        () => document.querySelector("main h1, main h2, main h3, main [role=heading]") !== null,
        null,
        {
          timeout: 10_000,
        },
      )
      .then(
        () => true,
        () => false,
      );
    await page.evaluate(() => {
      document.documentElement.style.setProperty("zoom", "1.5");
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.waitForTimeout(300);
    const faults = await page.evaluate((keyPattern) => {
      const out: { at: string; said: string }[] = [];
      const shownKey = new RegExp(keyPattern);
      const history = new URLSearchParams(location.search).get("screen") === "history";
      const all = [...document.body.querySelectorAll<HTMLElement>("*")];
      for (const [i, el] of all.entries()) {
        if (el.tagName === "svg" || el.closest("svg") || el.closest("iframe")) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim() !== "");
        if (!own || !el.checkVisibility()) continue;
        const cs = getComputedStyle(el);
        const clips = cs.textOverflow === "ellipsis" || cs.overflowX === "hidden" || cs.overflowX === "clip";
        const words = el.textContent!.trim().slice(0, 60);
        if (el.scrollWidth > el.clientWidth + 1 && cs.display !== "inline") {
          // History's byline keeps the timestamp and uses an ellipsis only while enough of the address fits.
          const byline = history && el.classList.contains("oh-row-address") && cs.textOverflow === "ellipsis";
          const aboveFloor = el.clientWidth >= Math.max(96, el.scrollWidth * 0.6);
          if (byline && !aboveFloor)
            out.push({ at: `byline#${i}`, said: "a History address is clipped below its fit floor" });
          if (!byline) out.push({ at: `wide#${i}`, said: `${clips ? "cut" : "overflows"}: "${words}"` });
        }
        if (shownKey.test(el.textContent!)) out.push({ at: `key#${i}`, said: `key shown: "${words}"` });
      }
      for (const el of document.body.querySelectorAll<HTMLElement>(
        'button, [role="menuitem"], [role="option"]',
      )) {
        if (!el.checkVisibility()) continue;
        const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
        if (name === "" && !el.getAttribute("aria-labelledby"))
          out.push({ at: `unnamed#${all.indexOf(el)}`, said: `unnamed ${el.tagName.toLowerCase()}` });
      }
      return out;
    }, NAMESPACES.source);
    return {
      stood,
      faults: [...errors.map((e) => ({ at: "error", said: `error: ${e.slice(0, 120)}` })), ...faults],
    };
  } finally {
    await page.close();
  }
}

/**
 * What German cuts that English does not, each with its reason. They stay named here, so a new one is still red.
 */
const DECLARED: Record<string, string> = {
  'cut: "support@hostwerk.example"':
    "the kit's letter row gives way on the sender's address, with an ellipsis, so that the longer German stamp stands whole",
  'cut: "nadja@erdton-atelier.example"':
    "the kit's letter row gives way on the sender's address, with an ellipsis, so that the longer German stamp stands whole",
  'cut: "flurina@haldenlicht.example"':
    "the kit's letter row gives way on the sender's address, with an ellipsis, so that the longer German stamp stands whole",
};

describe("the places' states, each drawn", () => {
  it("are every state of the eleven screens and the named state of each link", () => {
    expect(KEYS.length).toBe(102);
    expect(KEYS.every((k) => sizeOf.has(k))).toBe(true);
  });

  it("keeps a scheduled reply's recipient, label and cancel button readable at enlarged German text size", async () => {
    const key = "face=ohmarchy&open=draft-nadja&screen=drafts";
    const page = await browser!.newPage({ viewport: sizeOf.get(key)! });
    try {
      await openPlacesPage(page, `${key}&lang=de`);
      await page.evaluate(() => {
        document.documentElement.style.zoom = "1.5";
      });
      const action = page.getByRole("button", { name: "Versand abbrechen", exact: true });
      await action.click({ trial: true });
      const fits = (el: Element) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = Array.from(range.getClientRects());
        for (let box: Element | null = el; box; box = box.parentElement) {
          const style = getComputedStyle(box);
          if (style.overflowX === "visible" && style.overflowY === "visible" && box.tagName !== "BUTTON")
            continue;
          const b = box.getBoundingClientRect();
          if (
            lines.some(
              (r) =>
                r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1,
            )
          )
            return false;
        }
        return lines.length > 0;
      };
      const row = page.getByRole("option").filter({ hasText: "An Nadja Lehner" });
      for (const label of ["An Nadja Lehner", "Antwort"]) {
        await expect.poll(() => row.getByText(label, { exact: true }).evaluate(fits)).toBe(true);
      }
      expect(await action.getByText("Versand abbrechen", { exact: true }).evaluate(fits)).toBe(true);
    } finally {
      await page.close();
    }
  });

  /** Each key in both languages, four pages at a time. */
  async function everyKey(): Promise<Map<string, Record<"en" | "de", { stood: boolean; faults: Fault[] }>>> {
    const out = new Map<string, Record<"en" | "de", { stood: boolean; faults: Fault[] }>>();
    const queue = [...KEYS];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let key = queue.shift(); key !== undefined; key = queue.shift())
          out.set(key, { en: await look(key, "en"), de: await look(key, "de") });
      }),
    );
    return out;
  }

  it("each opens its place in both languages, with no error and no key shown; in German at a Text size of 1.5 nothing is cut or overflows that English keeps whole, and nothing is unnamed", async () => {
    const seen = await everyKey();
    const found: string[] = [];
    for (const key of KEYS) {
      const { en, de } = seen.get(key)!;
      const english = new Set(en.faults.map((f) => f.at));
      for (const [lang, side] of [
        ["en", en],
        ["de", de],
      ] as const) {
        if (!side.stood) found.push(`${key} ${lang}: nothing stood`);
        for (const f of side.faults)
          if (f.at === "error" || f.at.startsWith("key#") || f.at.startsWith("byline#"))
            found.push(`${key} ${lang}: ${f.said}`);
      }
      for (const f of de.faults)
        if (
          !english.has(f.at) &&
          f.at !== "error" &&
          !f.at.startsWith("key#") &&
          !f.at.startsWith("byline#") &&
          !(f.said in DECLARED)
        )
          found.push(`${key} de: ${f.said}`);
    }
    expect(found).toEqual([]);
  }, 1_200_000);
});

describe.each([
  { face: "paper", scheme: "light" },
  { face: "paper", scheme: "dark" },
  { face: "ohmarchy", scheme: "dark" },
])("desktop $face $scheme", ({ face, scheme }) => {
  it("covers scrolled Calendar accounts across the Mail Settings header", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 540 }, reducedMotion: "reduce" });
    try {
      await openCalRestPage(page, `screen=mail-settings&face=${face}&scheme=${scheme}`);
      const scroller = page.getByRole("region", { name: "Calendar accounts" });
      const heading = scroller.getByRole("heading", { name: "Calendar accounts", level: 1 });
      await heading.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const before = await heading.boundingBox();
      expect(before).not.toBeNull();
      await scroller.evaluate((el) => el.scrollBy(0, 240));
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(120);
      const after = await heading.boundingBox();
      expect(after).not.toBeNull();
      expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);

      const { clip, gaps, contentUnderHeader } = await heading.evaluate((el) => {
        const header = el.closest("header")!;
        const scroller = header.parentElement!;
        const content = header.nextElementSibling as HTMLElement;
        const head = header.getBoundingClientRect();
        const port = scroller.getBoundingClientRect();
        const left = port.left + scroller.clientLeft;
        const right = left + scroller.clientWidth;
        const top = port.top + scroller.clientTop;
        return {
          clip: {
            x: Math.ceil(left),
            y: Math.ceil(top),
            width: Math.floor(right) - Math.ceil(left),
            height: Math.floor(head.bottom) - Math.ceil(top),
          },
          gaps: [head.left - left, right - head.right, head.top - top],
          contentUnderHeader: [...content.querySelectorAll("button")].some((button) => {
            const row = button.getBoundingClientRect();
            return row.top < head.bottom && row.bottom > top;
          }),
        };
      });
      for (const gap of gaps) expect(gap).toBeLessThanOrEqual(1);
      expect(contentUnderHeader).toBe(true);

      const visible = await page.screenshot({ clip, animations: "disabled" });
      await heading.evaluate((el) => {
        (el.closest("header")!.nextElementSibling as HTMLElement).style.visibility = "hidden";
      });
      expect((await page.screenshot({ clip, animations: "disabled" })).equals(visible)).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);
});

async function swipeUp(page: Page, over: Locator) {
  const box = (await over.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.synthesizeScrollGesture", {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      yDistance: -2400,
      speed: 5000,
      gestureSourceType: "touch",
    });
  } finally {
    await cdp.detach();
  }
}

it.each([
  { width: 390, scheme: "light", state: "unconfigured" },
  { width: 640, scheme: "dark", state: "connected" },
])(
  "can scroll Calendar Settings and its sections at $width pixels ($scheme)",
  async ({ width, scheme, state }) => {
    const page = await browser!.newPage({ viewport: { width, height: 664 }, hasTouch: true });
    page.setDefaultTimeout(5_000);
    try {
      await openCalRestPage(
        page,
        `screen=calendar-settings&device=phone&viewport&scheme=${scheme}&state=${state}`,
      );
      const back = page.getByRole("button", { name: "Back to Settings" });
      const menu = page.getByRole("navigation", { name: "Settings sections" });
      const last = menu.getByRole("button", { name: "Help & contact", exact: true });
      const dock = page.locator(".fr-dockbox");
      const checkMenu = async () => {
        await back.tap();
        await menu.waitFor();
        const dockTop = (await dock.boundingBox())!.y;
        const lastRowBottom = async () => {
          const row = (await last.boundingBox())!;
          return row.y + row.height;
        };
        if ((await lastRowBottom()) > dockTop) await swipeUp(page, menu);
        await expect.poll(lastRowBottom).toBeLessThanOrEqual(dockTop);
      };

      if (state === "unconfigured") {
        await page.getByRole("button", { name: "Connect a calendar" }).tap();
      } else {
        const pane = page.getByRole("region", { name: "Calendar accounts" });
        const lastAccount = pane.getByRole("button", { name: /Workshop calendar/ }).last();
        const add = page.getByRole("button", { name: "Add account", exact: true });
        await lastAccount.waitFor();
        await swipeUp(page, pane);
        await expect
          .poll(async () => {
            const row = (await lastAccount.boundingBox())!;
            return row.y + row.height;
          })
          .toBeLessThanOrEqual((await add.boundingBox())!.y);
        await lastAccount.tap();
        expect(await lastAccount.getAttribute("aria-expanded")).toBe("true");
      }
      await checkMenu();
      await last.tap();
      await checkMenu();
    } finally {
      await page.close();
    }
  },
  30_000,
);
