/**
 * GERMAN ON EVERY STATE, AT TEXT SIZE 1.5: each state the Screener's page draws, at a phone's width (390) and a
 * computer's (1440), and the named states also at a folded and an unfolded foldable's (719, 841), in German and in
 * English, with the web door's text size at 150 %, in a real browser. Inside the place (the rail is the frame's) German cuts nothing English does not (told apart by the element, never by its words):
 * no box clips its words or ends them in an ellipsis while they are wider than it, nothing runs past its box, and no
 * box of words runs past its parent's content box or the box that clips it; no
 * control is left without a name, and no catalogue key is shown. The page is served on a routed origin; nothing
 * leaves the machine. It runs with the comparison (`npx vitest run --config vitest.compare.config.ts
 * packages/app/test/compare/screener-german.compare.ts`), as the screen's pictures do: what it finds is the screen's
 * and the kit's to mend, named in the Screener's handover until it reads green.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { subjects } from "../../../../test/compare/subjects/screener.js";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const ORIGIN = "http://screener.states.invalid";
const ROOMS = [
  ["phone", 390, 844],
  ["fold", 719, 900],
  ["foldl", 841, 900],
  ["desktop", 1440, 900],
] as const;
/*
 * A key that names its own window is drawn there alone; every other at a phone's and a computer's width, and the
 * named states (a sender open, Junk, a failed letter open) at all four.
 */
const keys = subjects.map((s) => s.key);
const NAMED = new Set([
  "open=scr-lena&screen=screener",
  "screen=screener&sec=junk&state=live",
  "open=mmf-giulia&screen=screener&state=failed",
]);
const rooms = (key: string) => {
  const own = /(^|&)device=([a-z]+)/.exec(key)?.[2];
  if (own) return ROOMS.filter(([d]) => d === own);
  return NAMED.has(key) ? ROOMS : ROOMS.filter(([d]) => d === "phone" || d === "desktop");
};

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let html = "";

beforeAll(async () => {
  const states = (await import("../states/screener-states.mjs")) as {
    screenerStatesPage: () => Promise<string>;
  };
  html = await states.screenerStatesPage();
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
    await page.waitForTimeout(500);
    return await page.evaluate(() => {
      const faults: { at: string; said: string }[] = [];
      const rail = document.querySelector('nav, [role="navigation"]');
      /*
       * An element's place, the same in both languages: from its nearest marked ancestor (an id the page gives, a
       * row's data-id, a part's data-part), each step down by its role or tag, its class and its order among the
       * siblings of that same shape. Never by words (a name is the language's) nor by an id React counts out, and a
       * sibling of another shape that only one language draws moves nothing.
       */
      const shapeOf = (el: Element): string =>
        `${el.getAttribute("role") ?? el.tagName.toLowerCase()}${el.classList[0] ? `.${el.classList[0]}` : ""}`;
      const markOf = (el: Element): string | null =>
        (el.id && !el.id.startsWith("_") ? el.id : null) ??
        el.getAttribute("data-id") ??
        el.getAttribute("data-part");
      const placeOf = (el: Element): string => {
        const steps: string[] = [];
        for (let at: Element | null = el; at && at !== document.body; at = at.parentElement) {
          const mark = markOf(at);
          if (mark !== null) {
            steps.push(`${shapeOf(at)}#${mark}`);
            break;
          }
          const shape = shapeOf(at);
          const twins = [...(at.parentElement?.children ?? [])].filter((s) => shapeOf(s) === shape);
          steps.push(twins.length > 1 ? `${shape}${twins.indexOf(at)}` : shape);
        }
        return steps.reverse().join("/");
      };
      /* The room a box has: its content box (a parent's) or what it shows (a box that clips), left and right. */
      const roomOf = (box: Element, inner: boolean) => {
        const r = box.getBoundingClientRect();
        const cs = getComputedStyle(box);
        const px = (v: string) => Number.parseFloat(v) || 0;
        const left = px(cs.borderLeftWidth) + (inner ? px(cs.paddingLeft) : 0);
        const right = px(cs.borderRightWidth) + (inner ? px(cs.paddingRight) : 0);
        return { left: r.left + left, right: r.right - right };
      };
      /* A box past its parent's content box, or past the nearest box that clips: words that ran out of their room. */
      const pastRoom = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        const out = (room: { left: number; right: number }) =>
          r.right > room.right + 1 || r.left < room.left - 1;
        let parent = el.parentElement;
        while (parent && getComputedStyle(parent).display === "contents") parent = parent.parentElement;
        if (parent && parent !== document.body && out(roomOf(parent, true))) return true;
        for (let at = parent; at && at !== document.body; at = at.parentElement) {
          if (getComputedStyle(at).overflowX !== "visible") return out(roomOf(at, false));
        }
        return false;
      };
      for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
        if (rail?.contains(el) || el.tagName === "svg" || el.closest("svg")) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim() !== "");
        if (!own || !el.checkVisibility()) continue;
        const cs = getComputedStyle(el);
        const clips = cs.textOverflow === "ellipsis" || cs.overflowX === "hidden" || cs.overflowX === "clip";
        const wide = (el.scrollWidth > el.clientWidth + 1 && cs.display !== "inline") || pastRoom(el);
        const words = el.textContent!.trim().slice(0, 60);
        if (wide)
          faults.push({
            at: `${clips ? "cut" : "overflows"} ${placeOf(el)}`,
            said: `${clips ? "cut" : "overflows"}: "${words}"`,
          });
        if (/\b(screener|place|shared|seed|screening)\.[a-zA-Z]+\b/.test(el.textContent!))
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

describe("German on every Screener state at text size 1.5", () => {
  it("the states are the subject's", () => {
    expect(keys.length).toBe(64);
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

it("keeps room around each Screener segment's label and count on touch and desktop", async () => {
  for (const [device, width, height] of ROOMS) {
    const page = await browser!.newPage({ viewport: { width, height }, hasTouch: device !== "desktop" });
    try {
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${ORIGIN}/?device=${device}`);
      const sections = page.getByRole("group", { name: "Screener sections" });
      await sections.waitFor();
      for (const listWidth of device === "desktop" ? [400, 320] : [null]) {
        if (listWidth !== null)
          await page.evaluate((px) => {
            document.documentElement.style.setProperty("--split-user", `${px}px 1fr`);
          }, listWidth);
        const padding = await sections
          .getByRole("button")
          .evaluateAll((buttons) =>
            buttons.map((button) => Number.parseFloat(getComputedStyle(button).paddingInlineStart)),
          );
        expect(padding).toHaveLength(3);
        if (device === "desktop") expect(padding).toEqual([10, 10, 10]);
        else expect(Math.min(...padding)).toBeGreaterThanOrEqual(8);
      }
    } finally {
      await page.close();
    }
  }
}, 60_000);
