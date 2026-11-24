/**
 * GERMAN ON EVERY STATE: each registered reading state, drawn in German and in English at its reference picture's
 * window, in a real browser. Inside the reading column German cuts nothing English does not (a box that clips its
 * text, or ends it in an ellipsis, while the text is wider than the box: a letter's long address is cut in both, as
 * drawn) and nothing runs past its box, no control is left without a name, and no catalogue key is shown. The page is served on a routed origin; nothing leaves the machine.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const ORIGIN = "http://reader.states.invalid";
type Row = { key: string; png: { w: number; h: number; scale: number } };
const rows: Row[] = (
  JSON.parse(readFileSync(resolve(process.cwd(), "test/compare/manifest.json"), "utf8")) as { rows: Row[] }
).rows.filter((r) => /(^|&)screen=reading(&|$)/.test(r.key));

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let html = "";

beforeAll(async () => {
  const states = (await import("./reader-states.mjs")) as { readerStatesPage: () => Promise<string> };
  html = await states.readerStatesPage();
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

/** What is wrong with the column at `key` in `lang`: one line a fault. */
async function faultsOf(row: Row, lang: "de" | "en"): Promise<string[]> {
  const page = await browser!.newPage({
    viewport: { width: Math.round(row.png.w / row.png.scale), height: Math.round(row.png.h / row.png.scale) },
  });
  try {
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?${row.key}&lang=${lang}`);
    await page.waitForTimeout(600);
    return await page.evaluate(() => {
      const faults: string[] = [];
      const column = document.querySelector("[data-read-column]");
      if (!column) return faults;
      for (const el of column.querySelectorAll<HTMLElement>("*")) {
        if (el.closest("iframe") || el.tagName === "IFRAME" || el.tagName === "svg" || el.closest("svg"))
          continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim() !== "");
        if (!own || !el.checkVisibility()) continue;
        const cs = getComputedStyle(el);
        const clips = cs.textOverflow === "ellipsis" || cs.overflowX === "hidden" || cs.overflowX === "clip";
        // The touch target can extend past the button as a pseudo-element. Measure the rendered words.
        const content = document.createRange();
        content.selectNodeContents(el);
        const box = el.getBoundingClientRect();
        const left = box.left + el.clientLeft;
        const right = left + el.clientWidth;
        const wide =
          cs.display !== "inline" &&
          [...content.getClientRects()].some((rect) => rect.left < left - 1 || rect.right > right + 1);
        if (wide) faults.push(`${clips ? "cut" : "overflows"}: "${el.textContent!.trim().slice(0, 60)}"`);
        if (/\b(reader|message|body|place|shared)\.[a-zA-Z]+\b/.test(el.textContent!))
          faults.push(`key shown: "${el.textContent!.trim().slice(0, 60)}"`);
      }
      for (const el of column.querySelectorAll<HTMLElement>(
        'button, [role="menuitem"], [role="menuitemradio"]',
      )) {
        if (!el.checkVisibility()) continue;
        const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
        if (name === "" && !el.getAttribute("aria-labelledby"))
          faults.push(`unnamed ${el.tagName.toLowerCase()}`);
      }
      return faults;
    });
  } finally {
    await page.close();
  }
}

/**
 * Faults found and asked of a part's owner, each with its reason. They stay named here, so a new one is still red.
 */
const DECLARED: Record<string, string> = {
  'overflows: "an dich Details"':
    "the kit's MessageHead: its recipients line runs 3 px past its track at a phone's width in German (asked of the kit)",
};

describe("German on every reading state", () => {
  it("the states are the registry's", () => {
    expect(rows.length).toBe(85);
  });

  it("no word cut or overflowing, no control unnamed, no key shown, in any of them", async () => {
    const found: string[] = [];
    for (const row of rows) {
      const english = new Set(await faultsOf(row, "en"));
      for (const fault of await faultsOf(row, "de"))
        if (!english.has(fault) && !(fault in DECLARED)) found.push(`${row.key}: ${fault}`);
    }
    expect(found).toEqual([]);
  }, 900_000);
});
