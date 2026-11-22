/**
 * GERMAN ON EVERY STATE, AT TEXT SIZE 1.5: each state write's page draws, at a phone's width (390) and a
 * computer's (1440), and the named states also at a folded and an unfolded foldable's (719, 841), in German and in
 * English, with the web door's text size at 150 %, in a real browser. Inside the place (the rail is the frame's, the list beside the letter the places') German cuts nothing English does not (told apart by the element, never by its words):
 * no box clips its words or ends them in an ellipsis while they are wider than it, and nothing runs past its box; no
 * control is left without a name, and no catalogue key is shown. The page is served on a routed origin; nothing
 * leaves the machine. It runs with the comparison (`npx vitest run --config test/compare/vitest.compare.config.ts
 * packages/app/test/compare/write-german.compare.ts`), as the screen's pictures do: what it finds is the screen's
 * and the kit's to mend, named in write's handover until it reads green.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { subjects } from "../../../../test/compare/subjects/compose.js";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const ORIGIN = "http://write.states.invalid";
const ROOMS = [
  ["phone", 390, 844],
  ["fold", 719, 900],
  ["foldl", 841, 900],
  ["desktop", 1440, 900],
] as const;
/*
 * A key that names its own window is drawn there alone; every other at a phone's and a computer's width, and the
 * named states (a letter with its marks, its files, and Send later's card) at all four.
 */
const keys = subjects.map((s) => s.key);
const NAMED = new Set([
  "screen=compose&state=marks",
  "screen=compose&state=files",
  "screen=compose&state=later",
]);
const rooms = (key: string) => {
  const own = /(^|&)device=([a-z]+)/.exec(key)?.[2];
  if (own) return ROOMS.filter(([d]) => d === own);
  return NAMED.has(key) ? ROOMS : ROOMS.filter(([d]) => d === "phone" || d === "desktop");
};

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let html = "";

beforeAll(async () => {
  const states = (await import("../states/write-states.mjs")) as {
    writeStatesPage: () => Promise<string>;
  };
  html = await states.writeStatesPage();
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

/**
 * What is wrong with the place at `key` in `lang`: one fault an element, by its place in the page (the same in both
 * languages: the words are not what tells a fault apart) and with its words for the reading.
 */
async function faultsOf(
  key: string,
  room: (typeof ROOMS)[number],
  lang: "de" | "en",
): Promise<{ at: string; said: string }[]> {
  const [device, width, height] = room;
  const page = await browser!.newPage({ viewport: { width, height } });
  try {
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    const query = key.replace(/(^|&)device=[a-z]+/, "");
    await page.goto(`${ORIGIN}/?${query}&device=${device}&lang=${lang}&zoom=1.5`);
    await page.waitForSelector('html[data-ready="1"]', { timeout: 15_000 });
    return await page.evaluate(() => {
      const faults: { at: string; said: string }[] = [];
      const rail = document.querySelector('nav, [role="navigation"]');
      const placeOf = (el: Element): string => {
        const steps: string[] = [];
        for (let at: Element | null = el; at && at !== document.body; at = at.parentElement)
          steps.push(`${at.tagName.toLowerCase()}${[...(at.parentElement?.children ?? [])].indexOf(at)}`);
        return steps.reverse().join("/");
      };
      for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
        if (rail?.contains(el) || el.tagName === "svg" || el.closest("svg")) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim() !== "");
        if (!own || !el.checkVisibility()) continue;
        const cs = getComputedStyle(el);
        const clips = cs.textOverflow === "ellipsis" || cs.overflowX === "hidden" || cs.overflowX === "clip";
        const wide = el.scrollWidth > el.clientWidth + 1 && cs.display !== "inline";
        const words = el.textContent!.trim().slice(0, 60);
        if (wide)
          faults.push({
            at: `${clips ? "cut" : "overflows"} ${placeOf(el)}`,
            said: `${clips ? "cut" : "overflows"}: "${words}"`,
          });
        if (
          /\b(write|shared|status|draft|files|later|from|reply|forwarded|marks)\.[a-zA-Z]+\b/.test(
            el.textContent!,
          )
        )
          faults.push({ at: `key ${placeOf(el)}`, said: `key shown: "${words}"` });
      }
      for (const el of document.body.querySelectorAll<HTMLElement>(
        'button, [role="menuitem"], [role="menuitemradio"], [role="option"]',
      )) {
        if (rail?.contains(el) || !el.checkVisibility()) continue;
        const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
        if (name === "" && !el.getAttribute("aria-labelledby"))
          faults.push({ at: `unnamed ${placeOf(el)}`, said: `unnamed ${el.tagName.toLowerCase()}` });
      }
      return faults;
    });
  } finally {
    await page.close();
  }
}

describe("German on every state of write at text size 1.5", () => {
  it("the states are the subject's", () => {
    expect(keys.length).toBe(109);
  });

  it("no word cut or overflowing that English does not cut, no control unnamed, no key shown", async () => {
    const found: string[] = [];
    for (const key of keys)
      for (const room of rooms(key)) {
        const english = new Set((await faultsOf(key, room, "en")).map((f) => f.at));
        for (const fault of await faultsOf(key, room, "de"))
          if (!english.has(fault.at)) found.push(`${key} @${room[1]}: ${fault.said}`);
      }
    expect(found).toEqual([]);
  }, 2_400_000);
});
