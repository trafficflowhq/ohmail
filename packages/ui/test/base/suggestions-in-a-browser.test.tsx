/**
 * A FIELD THAT SUGGESTS, IN A REAL BROWSER: what jsdom cannot lay out or type. Each case mounts the kit's own
 * parts with their listeners and sheets, types with real keys and presses with a real pointer, and reads where
 * the list stands, what it covers, and where the caret is. The web door's Text size is a zoom on the root: the
 * cases that place a list run at the default size and under it.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch } from "../../../../test/compare/render.mjs";
import { DEVICES, entryCss, fontsCss } from "../compare/harness.js";
import type { Scene } from "./suggestions-in-a-browser.page.js";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
type Browser = Awaited<ReturnType<typeof launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

let browser: Browser | null = null;
let script = "";
let sheets = "";
beforeAll(async () => {
  const { build } = await import("esbuild");
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./suggestions-in-a-browser.page.tsx", import.meta.url))],
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
  sheets = [
    await fontsCss(),
    await entryCss("base"),
    await entryCss("mail"),
    await entryCss("calendar"),
  ].join("\n");
  browser = await launch(chromium);
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

interface How {
  zoom?: number;
  phone?: boolean;
  face?: "paper" | "ohmarchy";
  lang?: string;
  window?: [number, number];
}

/** The scene mounted in a desktop window (or a phone's), the door's stamp on the root when the text size is not 1. */
async function mount(scene: Scene, how: How = {}): Promise<Page> {
  const device = DEVICES[how.phone ? "phone" : "desktop"];
  const root = {
    "data-face": how.face ?? "paper",
    "data-scheme": "light",
    ...device.root,
    "data-icons": "1",
    "data-rm": "1",
  };
  const attrs = Object.entries(root)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  const zoom = how.zoom ?? 1;
  const stamp = zoom === 1 ? "" : ` style="zoom:${zoom};--ui-zoom:${zoom}"`;
  const [width, height] = how.window ?? device.window;
  const page = await browser!.newPage({
    viewport: { width, height },
    hasTouch: how.phone === true,
    reducedMotion: "reduce",
  });
  await page.setContent(`<!doctype html><html lang="${how.lang ?? "en"}"${attrs}${stamp}><head><meta charset="utf-8">
<style>${sheets}</style><style>html,body{margin:0}</style></head><body><div class="oh-root" id="host"></div></body></html>`);
  /* A control that is not there is said at once, by its name, not by the case's own time running out. */
  page.setDefaultTimeout(5000);
  await page.evaluate(() => Promise.all([...document.fonts].map((face) => face.load())));
  await page.addScriptTag({ content: script });
  await page.evaluate(
    (s) =>
      (window as unknown as { mountScene: (h: Element, s: string) => void }).mountScene(
        document.getElementById("host")!,
        s,
      ),
    scene,
  );
  return page;
}

/** Types into the field that has the keys, and waits until what it offers stands. */
async function typeFor(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text);
  await page.getByRole("listbox").waitFor();
}

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Locator = ReturnType<Page["locator"]>;
const rect = async (of: Locator): Promise<Rect> =>
  of.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
/** The list's own box: what holds the listbox and its foot. */
const card = (page: Page): Locator => page.getByRole("listbox").locator("xpath=..");
const near = (seen: number, meant: number, by = 1.5): void => {
  expect(Math.abs(seen - meant), `${seen} where ${meant} was meant`).toBeLessThanOrEqual(by);
};
/** Whether what a person sees at the middle of `of` is `of` itself or something in it: nothing covers or cuts it. */
const inSight = (of: Locator): Promise<boolean> =>
  of.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const seen = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return seen !== null && el.contains(seen);
  });
/** Where the first words in `of` start, and where a field's own words start: both in the window's px. */
const wordsStart = (of: Locator): Promise<number> =>
  of.evaluate((el) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walk.nextNode();
    while (node && !node.textContent?.trim()) node = walk.nextNode();
    const range = document.createRange();
    range.selectNodeContents(node!);
    return range.getBoundingClientRect().left;
  });
const fieldStart = (field: Locator, zoom: number): Promise<number> =>
  field.evaluate((el, z) => {
    const style = getComputedStyle(el);
    return (
      el.getBoundingClientRect().left +
      (parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)) * z
    );
  }, zoom);

describe.each([1, 1.25])("a list at its field, at the text size %s", (zoom) => {
  it("stands under the field in a layer of its own: nothing that holds the field cuts it, and a row's words start where the field's do", async () => {
    const page = await mount("place", { zoom });
    try {
      const field = page.getByRole("combobox", { name: "Place" });
      await field.click();
      await typeFor(page, "tec");
      const options = page.getByRole("option");
      expect(await options.count()).toBe(7);
      const [at, list, column] = [
        await rect(field),
        await rect(card(page)),
        await rect(page.locator("#column")),
      ];
      near(list.top, at.bottom + 6 * zoom);
      near(await wordsStart(options.first()), await fieldStart(field, zoom));
      /* As much wider than the field on the other side as on this one. */
      near(list.right - at.right, at.left - list.left);
      expect(list.left).toBeGreaterThanOrEqual(column.left + 8 * zoom - 1);
      expect(list.right).toBeLessThanOrEqual(column.right - 8 * zoom + 1);
      /* The form's card cuts what leaves it, and the list is wider than the card: every row is still seen whole. */
      expect(list.width).toBeGreaterThan((await rect(page.locator("#card"))).width);
      for (const option of await options.all()) expect(await inSight(option)).toBe(true);
      expect(await inSight(page.getByRole("link"))).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("stands over the field where the room under it is short", async () => {
    const page = await mount("place-low", { zoom });
    try {
      const field = page.getByRole("combobox", { name: "Place" });
      await field.click();
      await typeFor(page, "tec");
      const [at, list] = [await rect(field), await rect(card(page))];
      near(list.bottom, at.top - 6 * zoom);
      expect(list.top).toBeGreaterThanOrEqual(8 * zoom - 1);
      expect(await inSight(page.getByRole("option").first())).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("is cut to the room it has: its rows scroll, the credit stays, and the row the keys are on is brought into sight", async () => {
    const page = await mount("place", { zoom, window: [1100, Math.round(430 * zoom)] });
    try {
      await page.getByRole("combobox", { name: "Place" }).click();
      await typeFor(page, "tec");
      const [list, rows, window_] = [
        await rect(card(page)),
        await rect(page.getByRole("listbox")),
        page.viewportSize()!,
      ];
      expect(list.bottom).toBeLessThanOrEqual(window_.height - 8 * zoom + 1);
      expect(await page.getByRole("listbox").evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(
        true,
      );
      expect(await inSight(page.getByRole("link"))).toBe(true);
      for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowDown");
      const last = await rect(page.getByRole("option", { selected: true }));
      expect((await page.getByRole("option", { selected: true }).textContent()) ?? "").toContain(
        "Basel-Landschaft",
      );
      expect(last.bottom).toBeLessThanOrEqual(rows.bottom + 1);
      expect(last.top).toBeGreaterThanOrEqual(rows.top - 1);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      const first = await rect(page.getByRole("option", { selected: true }));
      expect(first.top).toBeGreaterThanOrEqual(rows.top - 1);
    } finally {
      await page.close();
    }
  });
});

describe("a field that suggests, under a real pointer and real keys", () => {
  it("keeps the caret in the field while a row is pressed, and the press takes the row", async () => {
    const page = await mount("place");
    try {
      const field = page.getByRole("combobox", { name: "Place" });
      await field.click();
      await typeFor(page, "tec");
      const row = await rect(page.getByRole("option").nth(3));
      await page.mouse.move(row.left + row.width / 2, row.top + row.height / 2);
      expect((await page.getByRole("option", { selected: true }).textContent()) ?? "").toContain(
        "Technikumstrasse 9",
      );
      await page.mouse.down();
      expect(await field.evaluate((el) => document.activeElement === el)).toBe(true);
      await page.mouse.up();
      expect(await field.inputValue()).toBe("Technikumstrasse 9");
      expect(await field.evaluate((el) => document.activeElement === el)).toBe(true);
      expect(await page.getByRole("listbox").count()).toBe(0);
      /* A word added after what was taken: the list offers again only what was typed for. */
      await page.keyboard.type(", room 2");
      expect(await field.inputValue()).toBe("Technikumstrasse 9, room 2");
    } finally {
      await page.close();
    }
  });

  it("draws the row under the keys on the menu's wash in each face, and the typed part bold", async () => {
    for (const face of ["paper", "ohmarchy"] as const) {
      const page = await mount("place", { face });
      try {
        await page.getByRole("combobox", { name: "Place" }).click();
        await typeFor(page, "tec");
        await page.keyboard.press("ArrowDown");
        const read = (of: Locator) => of.evaluate((el) => getComputedStyle(el).backgroundColor);
        const wash = await page.evaluate(
          (token) => {
            const probe = document.body.appendChild(document.createElement("i"));
            probe.style.background = `var(${token})`;
            const colour = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return colour;
          },
          face === "paper" ? "--hover" : "--off",
        );
        expect(await read(page.getByRole("option", { selected: true }))).toBe(wash);
        expect(await read(page.getByRole("option").nth(3))).toBe("rgba(0, 0, 0, 0)");
        const weights = await page
          .getByRole("option")
          .nth(3)
          .evaluate((el) => {
            const bold = el.querySelector("b")!;
            return [
              getComputedStyle(bold).fontWeight,
              getComputedStyle(bold.parentElement!).fontWeight,
              bold.textContent,
            ];
          });
        expect(weights[2]).toBe("Tec");
        expect(Number(weights[0])).toBeGreaterThan(Number(weights[1]));
      } finally {
        await page.close();
      }
    }
  });

  it("holds German at Text size 1.5: the list stays in its column, rows grow with their words, nothing leaves a row", async () => {
    const tall: number[] = [];
    for (const zoom of [1, 1.5]) {
      const page = await mount("place-german", { zoom, lang: "de" });
      try {
        await page.getByRole("combobox", { name: "Place" }).click();
        await typeFor(page, "tec");
        const [list, column] = [await rect(card(page)), await rect(page.locator("#column"))];
        expect(list.left).toBeGreaterThanOrEqual(column.left);
        expect(list.right).toBeLessThanOrEqual(column.right);
        expect(await page.getByRole("group", { name: "Deine Orte" }).count()).toBe(1);
        for (const option of await page.getByRole("option").all()) {
          const row = await rect(option);
          expect(row.left).toBeGreaterThanOrEqual(list.left);
          expect(row.right).toBeLessThanOrEqual(list.right);
          expect(await option.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        }
        const credit = await rect(page.getByRole("link", { name: "© OpenStreetMap-Mitwirkende" }));
        expect(credit.right).toBeLessThanOrEqual(list.right);
        expect(credit.left).toBeGreaterThanOrEqual(list.left);
        tall.push((await rect(page.getByRole("option").nth(1))).height / zoom);
      } finally {
        await page.close();
      }
    }
    /* The same row in the page's own px: it is no shorter under the larger text, and wraps instead of running out. */
    expect(tall[1]!).toBeGreaterThanOrEqual(tall[0]! - 0.5);
  });

  it("set into a sheet at a phone's width it is the rows alone: no box of its own, rows a finger can press, German at Text size 1.5 inside the window", async () => {
    for (const zoom of [1, 1.5]) {
      const page = await mount("place-sheet", { zoom, phone: true, lang: "de" });
      try {
        await page.getByRole("combobox", { name: "Place" }).click();
        await typeFor(page, "tec");
        const box = await card(page).evaluate((el) => {
          const style = getComputedStyle(el);
          return [style.position, style.boxShadow, style.backgroundColor, style.paddingLeft];
        });
        expect(box).toEqual(["relative", "none", "rgba(0, 0, 0, 0)", "0px"]);
        const window_ = page.viewportSize()!;
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);
        for (const option of await page.getByRole("option").all()) {
          const row = await rect(option);
          expect(row.height).toBeGreaterThanOrEqual(56 * zoom - 0.5);
          expect(row.left).toBeGreaterThanOrEqual(0);
          expect(row.right).toBeLessThanOrEqual(window_.width);
        }
        expect((await rect(page.getByRole("link"))).right).toBeLessThanOrEqual(window_.width);
      } finally {
        await page.close();
      }
    }
  });
});

describe("the people a line of a letter can take", () => {
  it("stand under the line from the label's end, over what follows, the first one on; Enter and Tab take and the caret stays", async () => {
    const page = await mount("letter");
    try {
      const to = page.getByRole("combobox", { name: "To" });
      await to.click();
      await typeFor(page, "be");
      const [line, label, list] = [
        await rect(page.getByRole("group", { name: "To" })),
        await rect(page.getByRole("group", { name: "To" }).getByText("To", { exact: true })),
        await rect(card(page)),
      ];
      near(list.top, line.bottom);
      near(list.left, label.right);
      expect(list.right).toBeLessThanOrEqual(line.right + 1);
      expect(list.width).toBeGreaterThanOrEqual(400 - 1);
      const options = page.getByRole("option");
      expect(await options.count()).toBe(3);
      for (const option of await options.all()) expect(await inSight(option)).toBe(true);
      const first = page.getByRole("option", { selected: true });
      expect((await first.textContent()) ?? "").toContain("Ben Arnold");
      /* Two lines: the address stands under the name, never beside it. */
      const [name, address] = await first.evaluate((el) => {
        const lines = [...el.querySelectorAll("span")].filter(
          (s) => /Arnold|lichtgrat/.test(s.textContent ?? "") && !s.querySelector("span"),
        );
        return lines.map((s) => s.getBoundingClientRect().top);
      });
      expect(address!).toBeGreaterThan(name! + 8);

      await page.keyboard.press("Enter");
      expect(await page.locator("#taken").textContent()).toBe("ben@lichtgrat.example");
      expect(await to.inputValue()).toBe("");
      await typeFor(page, "ber");
      expect((await page.getByRole("option", { selected: true }).textContent()) ?? "").toContain(
        "Tim Berger",
      );
      await page.keyboard.press("Tab");
      expect(await page.locator("#taken").textContent()).toBe("tim@gassenblatt.example");
      expect(await to.evaluate((el) => document.activeElement === el)).toBe(true);
    } finally {
      await page.close();
    }
  });
});

describe("the signature of a letter being written", () => {
  it("hands its words over while they are typed, and the caret stays where the person types", async () => {
    const page = await mount("signed");
    try {
      const signature = page.getByRole("textbox", { name: "Signature" });
      await signature.click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type(", on the road");
      expect(await page.locator("#kept").textContent()).toBe("Mila Brunner, on the road");
      expect(await signature.textContent()).toBe("Mila Brunner, on the road");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Lichtgrat");
      expect(await page.locator("#kept").textContent()).toBe("Mila Brunner, on the road\nLichtgrat");
    } finally {
      await page.close();
    }
  });
});
