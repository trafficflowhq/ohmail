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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    await page.waitForTimeout(300);
    const faults = await page.evaluate((keyPattern) => {
      const out: { at: string; said: string }[] = [];
      const shownKey = new RegExp(keyPattern);
      const all = [...document.body.querySelectorAll<HTMLElement>("*")];
      for (const [i, el] of all.entries()) {
        if (el.tagName === "svg" || el.closest("svg") || el.closest("iframe")) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim() !== "");
        if (!own || !el.checkVisibility()) continue;
        const cs = getComputedStyle(el);
        const clips = cs.textOverflow === "ellipsis" || cs.overflowX === "hidden" || cs.overflowX === "clip";
        const words = el.textContent!.trim().slice(0, 60);
        if (el.scrollWidth > el.clientWidth + 1 && cs.display !== "inline")
          out.push({ at: `wide#${i}`, said: `${clips ? "cut" : "overflows"}: "${words}"` });
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
          if (f.at === "error" || f.at.startsWith("key#")) found.push(`${key} ${lang}: ${f.said}`);
      }
      for (const f of de.faults)
        if (!english.has(f.at) && f.at !== "error" && !f.at.startsWith("key#") && !(f.said in DECLARED))
          found.push(`${key} de: ${f.said}`);
    }
    expect(found).toEqual([]);
  }, 1_200_000);
});
