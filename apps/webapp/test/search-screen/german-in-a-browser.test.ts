/**
 * GERMAN ON EVERY STATE, AT TEXT SIZE 1.5: each state Search draws, in German and in English at its reference
 * picture's window, at the web door's largest Text size, in a real browser. Inside Search's list German cuts nothing
 * English does not, nothing runs past its part, no control is left without a name, and no catalogue key is shown.
 * The page is served on a routed origin; nothing leaves the machine.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEARCH_KEYS } from "./search-states-of.js";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const ORIGIN = "http://search.states.invalid";
type Row = { key: string; png: { w: number; h: number; scale: number } };
const manifest: Row[] = (
  JSON.parse(readFileSync(resolve(process.cwd(), "test/compare/manifest.json"), "utf8")) as { rows: Row[] }
).rows;
const rows = SEARCH_KEYS.map((key) => manifest.find((r) => r.key === key)).filter((r): r is Row => r !== undefined);

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let html = "";

beforeAll(async () => {
  const states = (await import("./search-states.mjs")) as { searchStatesPage: () => Promise<string> };
  html = await states.searchStatesPage();
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

/** What is wrong with Search's list at `key` in `lang`: one line a fault. */
async function faultsOf(row: Row, lang: "de" | "en"): Promise<string[]> {
  const page = await browser!.newPage({
    viewport: { width: Math.round(row.png.w / row.png.scale), height: Math.round(row.png.h / row.png.scale) },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  try {
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?${row.key}&lang=${lang}&zoom=1.5`);
    await page.waitForTimeout(1200);
    const faults = await page.evaluate(() => {
      const found: string[] = [];
      const list = document.querySelector(".sr-list");
      if (!list) return ["Search's list is not drawn"];
      for (const el of list.querySelectorAll<HTMLElement>("*")) {
        if (el.tagName === "svg" || el.closest("svg")) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim() !== "");
        if (!own || !el.checkVisibility()) continue;
        const cs = getComputedStyle(el);
        const clips = cs.textOverflow === "ellipsis" || cs.overflowX === "hidden" || cs.overflowX === "clip";
        const wide = el.scrollWidth > el.clientWidth + 1 && cs.display !== "inline";
        if (wide) found.push(`${clips ? "cut" : "overflows"}: "${el.textContent!.trim().slice(0, 60)}"`);
        if (/\b(search|screener)\.[a-zA-Z]+\b/.test(el.textContent!))
          found.push(`key shown: "${el.textContent!.trim().slice(0, 60)}"`);
      }
      for (const el of document.querySelectorAll<HTMLElement>(
        '.sr-list button, [role="menuitem"], [role="menuitemradio"]',
      )) {
        if (!el.checkVisibility()) continue;
        const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
        if (name === "" && !el.getAttribute("aria-labelledby")) found.push(`unnamed ${el.tagName.toLowerCase()}`);
      }
      return found;
    });
    return [...errors, ...faults];
  } finally {
    await page.close();
  }
}

/** Faults that are a part's own rule, each with its reason. They stay named here, so a new one is still red. */
const DECLARED: Record<string, string> = {
  'cut: "mila@lichtgrat.example"':
    "the kit's row gives up its address first when its line is full (its own rule); the German date beside it is longer",
};

describe("German on every Search state, at Text size 1.5", () => {
  it("every state this step draws has its reference picture's window", () => {
    expect(rows.map((r) => r.key)).toEqual([...SEARCH_KEYS]);
  });

  it("no word cut or overflowing, no control unnamed, no key shown, in any of them", async () => {
    const found: string[] = [];
    for (const row of rows) {
      const english = new Set(await faultsOf(row, "en"));
      for (const fault of await faultsOf(row, "de"))
        if (!english.has(fault) && !(fault in DECLARED)) found.push(`${row.key}: ${fault}`);
      for (const fault of english) if (fault.startsWith("page error") || fault.startsWith("Search's list"))
        found.push(`${row.key} (en): ${fault}`);
    }
    expect(found).toEqual([]);
  }, 900_000);
});

describe.each([
  { face: "paper", scheme: "light" },
  { face: "paper", scheme: "dark" },
  { face: "ohmarchy", scheme: "dark" },
])("desktop $face $scheme", ({ face, scheme }) => {
  it("keeps the Search controls edge to edge above overflowing results", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 540 }, reducedMotion: "reduce" });
    try {
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${ORIGIN}/?q=glaze&many=1&face=${face}&scheme=${scheme}`);
      const heading = page.getByRole("heading", { level: 1, name: "Search", exact: true });
      await page.getByRole("listitem").filter({ hasText: "Glaze sample 40" }).waitFor();

      const header = heading.locator("xpath=ancestor::header");
      const scroller = header.locator("xpath=following-sibling::*[1]");
      const before = await heading.boundingBox();
      expect(before).not.toBeNull();
      await scroller.hover();
      await expect.poll(async () => {
        const top = await scroller.evaluate((el) => el.scrollTop);
        if (top <= 120) await page.mouse.wheel(0, 240);
        return top;
      }).toBeGreaterThan(120);
      const after = await heading.boundingBox();
      expect(after).not.toBeNull();
      expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
      const { gaps, clipped, headCoversResults } = await scroller.evaluate((el) => {
        const header = el.previousElementSibling!;
        const head = header.getBoundingClientRect();
        const port = el.getBoundingClientRect();
        const inside = [head.left + 1, (head.left + head.right) / 2, head.right - 1];
        return {
          gaps: [Math.abs(head.left - port.left), Math.abs(head.right - port.right), Math.abs(head.bottom - port.top)],
          clipped: getComputedStyle(el).overflowY === "auto",
          headCoversResults: inside.every((x) => {
            const hits = document.elementsFromPoint(x, port.top - 2);
            return hits.some((hit) => header.contains(hit)) && hits.every((hit) => !el.contains(hit));
          }),
        };
      });
      for (const gap of gaps) expect(gap).toBeLessThanOrEqual(1);
      expect(clipped).toBe(true);
      expect(headCoversResults).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);
});
