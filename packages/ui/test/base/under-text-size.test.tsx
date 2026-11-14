/**
 * THE NEXT DESIGN'S PARTS UNDER THE WEB DOOR'S TEXT SIZE, IN A REAL BROWSER. The door stamps a CSS `zoom` and
 * `--ui-zoom` on `<html>` (the webapp's `text-size.ts`); under it the browser's rects and pointer reads answer in
 * the window's px while a style's lengths stay in the page's own. Each case mounts the kit's own part, with its
 * own listeners and sheets, at the default size and at 125 %, drives it with a real pointer or finger, and reads
 * in the window's px that what the part places stands where the person's hand or its anchor is.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch } from "../../../../test/compare/render.mjs";
import { DEVICES, entryCss, fontsCss } from "../compare/harness.js";
import type { Scene } from "./under-text-size.page.js";

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
    entryPoints: [fileURLToPath(new URL("./under-text-size.page.tsx", import.meta.url))],
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

const ZOOMS = [1, 1.25] as const;

/** Within a pixel of the window: a fractional zoom rounds a box's edge, never by a whole step. */
const near = (seen: number, meant: number): void => {
  expect(Math.abs(seen - meant), `${seen} where ${meant} was meant`).toBeLessThanOrEqual(1);
};

/** A desktop window (or a phone's, for a finger) with the scene mounted, the door's stamp on the root when not 1. */
async function mount(
  scene: Scene,
  zoom: number,
  how: { phone?: boolean; moving?: boolean } = {},
): Promise<Page> {
  const device = DEVICES[how.phone ? "phone" : "desktop"];
  const root = {
    "data-face": "paper",
    "data-scheme": "light",
    ...device.root,
    "data-icons": "1",
    "data-rm": how.moving ? "0" : "1",
  };
  const attrs = Object.entries(root)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  const stamp = zoom === 1 ? "" : ` style="zoom:${zoom};--ui-zoom:${zoom}"`;
  const [width, height] = device.window;
  const page = await browser!.newPage({
    viewport: { width, height },
    hasTouch: how.phone === true,
    reducedMotion: how.moving ? "no-preference" : "reduce",
  });
  await page.setContent(`<!doctype html><html lang="en"${attrs}${stamp}><head><meta charset="utf-8">
<style>${sheets}</style><style>html,body{margin:0}</style></head><body><div class="oh-root" id="host"></div></body></html>`);
  /* Every face loaded before the part stands: a part that keeps where it stood must not see the words reflow. */
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

/** Two frames: what the part set on the pointer's last move is drawn. */
const frames = (page: Page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const rectOf = (page: Page, selector: string): Promise<Rect> =>
  page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }, selector);

const middleOf = async (page: Page, selector: string): Promise<[number, number]> => {
  const r = await rectOf(page, selector);
  return [r.left + r.width / 2, r.top + r.height / 2];
};

/** A finger, as the browser's own touch input: its pointer events say `touch`. It rests `rests` ms where it came down. */
async function finger(page: Page, path: [number, number][], rests = 0): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  const [first, ...rest] = path;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: first![0], y: first![1] }],
  });
  if (rests > 0) await new Promise((done) => setTimeout(done, rests));
  for (const [x, y] of rest)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  return async () => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
}

/** Steps of a straight travel, so the part reads the pointer on its way as a hand moves it. */
const along = (from: [number, number], by: [number, number], steps = 8): [number, number][] =>
  Array.from({ length: steps + 1 }, (_, i) => [from[0] + (by[0] * i) / steps, from[1] + (by[1] * i) / steps]);

describe.each(ZOOMS)("at a text size of %s", (zoom) => {
  it("a menu opened from its control stands at the control's left edge, its gap below it", async () => {
    const page = await mount("control", zoom);
    try {
      await page.getByRole("button", { name: "More" }).click();
      const control = await rectOf(page, "button[aria-haspopup]");
      const menu = await rectOf(page, "[role='menu']");
      near(menu.left, control.left);
      /* The gap is the menu's own 8, a length of the page: the window shows it 8 × the zoom. */
      near(menu.top - control.bottom, 8 * zoom);
    } finally {
      await page.close();
    }
  }, 60_000);

  it.each(["row", "agenda", "trigger"])(
    "a menu at the pointer: a right click on a %s opens it with its corner at the pointer",
    async (thing) => {
      const page = await mount("pointer", zoom);
      try {
        const box = await rectOf(page, `[data-scene='${thing}']`);
        const at = { x: Math.round(box.left + 60), y: Math.round(box.top + box.height / 2) };
        await page.mouse.click(at.x, at.y, { button: "right" });
        const menu = await rectOf(page, "[role='menu']");
        near(menu.left, at.x);
        near(menu.top - at.y, 2 * zoom);
      } finally {
        await page.close();
      }
    },
    60_000,
  );

  it("the column handle's width follows the pointer", async () => {
    const page = await mount("handle", zoom);
    try {
      const handle = page.getByRole("separator", { name: "List width" });
      const box = await rectOf(page, "[role='separator']");
      const from: [number, number] = [box.left + box.width / 2, box.top + 40];
      const before = Number(await handle.getAttribute("aria-valuenow"));
      await page.mouse.move(...from);
      await page.mouse.down();
      for (const [x, y] of along(from, [100, 0])) await page.mouse.move(x, y);
      await page.mouse.up();
      await frames(page);
      const after = Number(await handle.getAttribute("aria-valuenow"));
      /* The width is the page's px; the pointer went 100 of the window's. */
      near((after - before) * zoom, 100);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("a row's swipe travels with the finger", async () => {
    const page = await mount("swipe", zoom, { phone: true });
    try {
      const before = await rectOf(page, ".oh-row");
      const from: [number, number] = [before.left + 120, before.top + before.height / 2];
      /* 60 of the window's px: short of the point where the verb fires, at either size. */
      const lift = await finger(page, along(from, [60, 0]));
      await frames(page);
      const pulled = await rectOf(page, ".oh-row");
      await lift();
      near(pulled.left - before.left, 60);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("a press on the fade beside a row's quick verb opens the row once; a press on the verb is the verb's", async () => {
    const page = await mount("quick", zoom);
    try {
      const pressed = () =>
        page.evaluate(() =>
          JSON.parse(document.querySelector("[data-pressed]")!.getAttribute("data-pressed")!),
        );
      await page.mouse.move(...(await middleOf(page, "[role='option']")));
      const fade = await rectOf(page, ".oh-row-quick");
      const verb = await rectOf(page, ".oh-row-quick > button");
      expect(verb.left - fade.left, "the fade has room beside the verb").toBeGreaterThan(16 * zoom);
      await page.mouse.click(fade.left + 4 * zoom, fade.top + fade.height / 2);
      expect(await pressed()).toEqual({ open: 1, done: 0 });
      await page.mouse.click(verb.left + verb.width / 2, verb.top + verb.height / 2);
      expect(await pressed()).toEqual({ open: 1, done: 1 });
    } finally {
      await page.close();
    }
  }, 60_000);

  it.each([
    ["its drawing", 0, 0],
    ["the room around its drawing", 60, 14],
  ] as const)(
    "an event's sheet follows a finger down from its grabber, taken at %s",
    async (_, dx, dy) => {
      const page = await mount("sheet", zoom, { phone: true });
      try {
        const grab = await rectOf(page, ".oh-ecard-grab");
        const before = await rectOf(page, "[role='dialog']");
        /* The room is the page's px around the drawing: the window shows it × the zoom. */
        const from: [number, number] = [
          grab.left + grab.width / 2 + dx * zoom,
          grab.top + grab.height / 2 + dy * zoom,
        ];
        /* A finger, not a mouse: a sheet that lets the browser pan it loses a finger's pull after three moves. */
        const lift = await finger(page, along(from, [0, 60]));
        await frames(page);
        const pulled = await rectOf(page, "[role='dialog']");
        await lift();
        near(pulled.top - before.top, 60);
      } finally {
        await page.close();
      }
    },
    60_000,
  );

  it("an event's sheet follows the mouse down from its grabber", async () => {
    const page = await mount("sheet", zoom, { phone: true });
    try {
      const grab = await rectOf(page, ".oh-ecard-grab");
      const before = await rectOf(page, "[role='dialog']");
      const from: [number, number] = [grab.left + grab.width / 2, grab.top + grab.height / 2];
      await page.mouse.move(...from);
      await page.mouse.down();
      for (const [x, y] of along(from, [0, 60])) await page.mouse.move(x, y);
      await frames(page);
      const pulled = await rectOf(page, "[role='dialog']");
      await page.mouse.up();
      near(pulled.top - before.top, 60);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("an event's sheet lets go when the mouse lets go outside it, and does not follow an unpressed mouse after", async () => {
    const page = await mount("sheet", zoom, { phone: true });
    try {
      const grab = await rectOf(page, ".oh-ecard-grab");
      const before = await rectOf(page, "[role='dialog']");
      const from: [number, number] = [grab.left + grab.width / 2, grab.top + grab.height / 2];
      await page.mouse.move(...from);
      await page.mouse.down();
      for (const [x, y] of along(from, [0, 40])) await page.mouse.move(x, y);
      /* Up and out over the sheet's top in one move, as a quick hand goes, and let go there. */
      await page.mouse.move(from[0], before.top - 60);
      await page.mouse.up();
      await frames(page);
      near((await rectOf(page, "[role='dialog']")).top, before.top);
      /* Back over the sheet with no button held, and down: it stays where it stands. */
      const back: [number, number] = [from[0], before.top + before.height / 2];
      await page.mouse.move(...back);
      for (const [x, y] of along(back, [0, 60])) await page.mouse.move(x, y);
      await frames(page);
      near((await rectOf(page, "[role='dialog']")).top, before.top);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("a dragged recipient's ghost stays under the pointer where it took hold, and the caret stands where it lands", async () => {
    const page = await mount("lines", zoom);
    try {
      const anna = await rectOf(page, "[data-person='a']");
      const ben = await rectOf(page, "[data-person='b']");
      const hold = { x: 6 * zoom, y: anna.height / 2 };
      const from: [number, number] = [anna.left + hold.x, anna.top + hold.y];
      /* Over Ben's left quarter: Anna lands before him. */
      const to: [number, number] = [ben.left + ben.width / 4, ben.top + ben.height / 2];
      await page.mouse.move(...from);
      await page.mouse.down();
      for (const [x, y] of along(from, [to[0] - from[0], to[1] - from[1]])) await page.mouse.move(x, y);
      await frames(page);
      const ghost = await rectOf(page, ".oh-recipients-ghost [data-person='a']");
      const benNow = await page.evaluate(() => {
        const r = document.querySelector("[data-person='b']")!.parentElement!.getBoundingClientRect();
        return { left: r.left, top: r.top, height: r.height };
      });
      const caret = await rectOf(page, ".oh-recipients-caret");
      await page.mouse.up();
      near(ghost.left, to[0] - hold.x);
      near(ghost.top, to[1] - hold.y);
      /* The caret's own 2 px, drawn 1 px out of the place it marks. */
      near(caret.left + caret.width / 2, benNow.left);
      near(caret.top, benNow.top);
      near(caret.height, benNow.height);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("on a phone a recipient held under a finger is carried by it to the next line, the caret where it lands", async () => {
    const page = await mount("phoneLines", zoom, { phone: true });
    try {
      const anna = await rectOf(page, "[data-person='a']");
      const clara = await rectOf(page, "[data-person='c']");
      const hold = { x: 8 * zoom, y: anna.height / 2 };
      const from: [number, number] = [anna.left + hold.x, anna.top + hold.y];
      /* Over Clara's left quarter, on the line below: Anna lands before her. */
      const to: [number, number] = [clara.left + clara.width / 4, clara.top + clara.height / 2];
      /* A finger lifts a person by resting on it (longer than the part's long press), then carries it. */
      const lift = await finger(page, along(from, [to[0] - from[0], to[1] - from[1]]), 600);
      await frames(page);
      const ghost = await page.evaluate(() => {
        const r = document.querySelector(".oh-recipients-ghost [data-person='a']")?.getBoundingClientRect();
        return r ? { left: r.left, top: r.top } : null;
      });
      const claraNow = await page.evaluate(() => {
        const r = document.querySelector("[data-person='c']")!.parentElement!.getBoundingClientRect();
        return { left: r.left, top: r.top, height: r.height };
      });
      const caret = await page.evaluate(() => {
        const r = document.querySelector(".oh-recipients-caret")?.getBoundingClientRect();
        return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
      });
      await lift();
      expect(ghost, "the person is still held when the finger has moved").not.toBeNull();
      near(ghost!.left, to[0] - hold.x);
      near(ghost!.top, to[1] - hold.y);
      expect(caret).not.toBeNull();
      near(caret!.left + caret!.width / 2, claraNow.left);
      near(caret!.top, claraNow.top);
    } finally {
      await page.close();
    }
  }, 60_000);

  it.each([
    ["the read squares' ring", "squares", ".oh-readsquares-ring"],
    ["the switcher's ink half", "knob", ".oh-switcher-knob"],
  ] as const)(
    "%s glides from where it stood",
    async (_, scene, selector) => {
      const page = await mount(scene, zoom, { moving: true });
      try {
        const stood = await rectOf(page, selector);
        const first = await page.evaluate((sel) => {
          (window as unknown as { stepScene: () => void }).stepScene();
          const el = document.querySelector(sel)!;
          const moves = el.getAnimations();
          for (const a of moves) {
            a.pause();
            a.currentTime = 0;
          }
          const r = el.getBoundingClientRect();
          return { moves: moves.length, left: r.left, top: r.top, width: r.width };
        }, selector);
        expect(first.moves, "it glided at all").toBeGreaterThan(0);
        near(first.left, stood.left);
        near(first.top, stood.top);
        near(first.width, stood.width);
      } finally {
        await page.close();
      }
    },
    60_000,
  );
});
