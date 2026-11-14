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
  how: {
    phone?: boolean;
    moving?: boolean;
    face?: "paper" | "ohmarchy";
    scheme?: "light" | "dark";
    /** A window of another size than the device's own. */
    window?: [number, number];
    /** The unfolded phone on its side, by its root's attributes (a pointer's case: no finger). */
    foldl?: boolean;
  } = {},
): Promise<Page> {
  const device = DEVICES[how.phone ? "phone" : how.foldl ? "foldl" : "desktop"];
  const root = {
    "data-face": how.face ?? "paper",
    "data-scheme": how.scheme ?? "light",
    ...device.root,
    "data-icons": "1",
    "data-rm": how.moving ? "0" : "1",
  };
  const attrs = Object.entries(root)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  const stamp = zoom === 1 ? "" : ` style="zoom:${zoom};--ui-zoom:${zoom}"`;
  const [width, height] = how.window ?? device.window;
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

  it("the Move menu asked to end at its control and open upwards ends at the control's right edge, above it", async () => {
    const page = await mount("move", zoom);
    try {
      await page.getByRole("button", { name: "More" }).click();
      const control = await rectOf(page, "button[aria-haspopup]");
      const menu = await rectOf(page, "[role='menu']");
      near(menu.right, control.right);
      near(control.top - menu.bottom, 8 * zoom);
    } finally {
      await page.close();
    }
  }, 60_000);

  it.each([
    /* one column from 600 wide (the open Duo held upright is 669 by 951): the sheet keeps a phone's 460 in the middle */
    [600, 951, true],
    [669, 951, true],
    [699, 951, true],
    /* a phone's own window: the sheet runs from edge to edge, a step in from each side */
    [390, 844, false],
    [466, 678, false],
  ] as const)(
    "a menu, a card or a sheet a finger opens on a phone %sx%s comes up from the foot, 460 wide in the middle from 600 wide (%s)",
    async (width, height, middle) => {
      for (const scene of ["control", "card", "footSheet"] as const)
        for (const face of ["paper", "ohmarchy"] as const)
          for (const scheme of ["light", "dark"] as const) {
            const page = await mount(scene, zoom, { phone: true, face, scheme, window: [width, height] });
            try {
              await page.getByRole("button", { name: "More" }).tap();
              await frames(page);
              const menu = await rectOf(page, scene === "card" ? "[role='dialog']" : "[role='menu']");
              const look = `${scene} ${face} ${scheme}`;
              /* The window's px: the page's own lengths (460, the 8 at the edge) are drawn × the zoom. */
              const room = width / zoom;
              const side = middle ? Math.max(8, room / 2 - 230) : 8;
              near(menu.left, side * zoom);
              near(menu.width, (room - 2 * side) * zoom);
              if (middle) near(menu.width, 460 * zoom);
              near(height - menu.bottom, 8 * zoom);
              expect(await page.getByText("Forward", { exact: true }).isVisible(), look).toBe(true);
            } finally {
              await page.close();
            }
          }
    },
    120_000,
  );

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

  it("a head's line of segments wider than its list scrolls inside the head: the pressed one in view, a fade at each end that hides more", async () => {
    const page = await mount("piles", zoom);
    try {
      const read = () =>
        page.evaluate(() => {
          const head = document.querySelector("header")!;
          const group = document.querySelector('[role="group"]')!;
          const line = group.parentElement!;
          const [box, on] = [line.getBoundingClientRect(), group.querySelector('[aria-pressed="true"]')!];
          const item = on.getBoundingClientRect();
          return {
            /* The head is as wide as its list, whatever its line holds, and the window does not scroll. */
            head: Math.round(
              head.getBoundingClientRect().width /
                (parseFloat(getComputedStyle(document.documentElement).zoom) || 1),
            ),
            page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            wider: line.scrollWidth > line.clientWidth + 1,
            at: Math.round(line.scrollLeft),
            end: Math.round(line.scrollWidth - line.clientWidth),
            seen: item.left >= box.left - 0.5 && item.right <= box.right + 0.5,
            pressed: on.textContent,
            fade: getComputedStyle(line).maskImage,
            /* No segment is cut to fit: each keeps its own words whole. */
            whole: [...group.querySelectorAll("button")].every((b) => b.scrollWidth <= b.clientWidth + 1),
          };
        });
      const first = await read();
      expect([first.head, first.page, first.wider, first.whole]).toEqual([300, false, true, true]);
      /* It starts with the pressed segment in view, so both ends hide more and both fade. */
      expect([first.pressed, first.seen, first.at > 0, first.at < first.end]).toEqual([
        "2022",
        true,
        true,
        true,
      ]);
      /** Which ends fade, the near one then the far one: read from the mask the line is drawn through. */
      const fades = (fade: string): boolean[] | null => {
        const stops =
          /^linear-gradient\(to right, rgba\(0, 0, 0, 0\) 0px, rgba?\([^)]+\) (\d+)px, rgba?\([^)]+\) (.+), rgba\(0, 0, 0, 0\) 100%\)$/.exec(
            fade,
          );
        return stops ? [stops[1] !== "0", stops[2]!.includes("32px")] : null;
      };
      expect(fades(first.fade)).toEqual([true, true]);
      /* At its start only the far end fades; at its end only the near one. */
      const fadeAt = async (left: number) => {
        await page.evaluate((to) => {
          const line = document.querySelector('[role="group"]')!.parentElement!;
          line.scrollLeft = to;
          line.dispatchEvent(new Event("scroll"));
        }, left);
        return fades((await read()).fade);
      };
      expect(await fadeAt(0)).toEqual([false, true]);
      expect(await fadeAt(first.end)).toEqual([true, false]);
      /* A press on another segment takes it: the line is a line of the same segments. */
      await page.getByRole("button", { name: "2020" }).click();
      expect((await read()).pressed).toBe("2020");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("a row pulled by the list's layer stands as far as it is pulled, in the page's own px", async () => {
    const page = await mount("swipe", zoom, { phone: true });
    try {
      const rest = await rectOf(page, ".oh-row-slot");
      const pulled = await rectOf(page, ".oh-row");
      /* 60 of the page's px, short of the point where the verb fires: 60 times the Text size in the window's. */
      near(pulled.left - rest.left, 60 * zoom);
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

/*
 * A PAGE OF TWO COLUMNS IN A SMALLER WINDOW (the doors' ask, from their security review and its ruling): a page
 * whose sentence column is taller than its window folds to one column, which scrolls, so its one act is reached with
 * a pointer; a page that fits keeps its two columns. The rooms are the review's: three smaller desktop windows, and
 * the web door's Text size at the desktop's window and at the smallest of them.
 */
const ROOMS = [
  { room: "1280x720", size: [1280, 720], zoom: 1 },
  { room: "1100x640", size: [1100, 640], zoom: 1 },
  { room: "1024x600", size: [1024, 600], zoom: 1 },
  { room: "text 1.25 at 1440x900", size: [1440, 900], zoom: 1.25 },
  { room: "text 1.5 at 1440x900", size: [1440, 900], zoom: 1.5 },
  { room: "text 1.25 at 1280x720", size: [1280, 720], zoom: 1.25 },
] as const;
const LOOKS = [
  ["paper", "light"],
  ["paper", "dark"],
  ["ohmarchy", "light"],
  ["ohmarchy", "dark"],
] as const;

/** The rooms where the scene's two refusals push paper's act under the window's foot (ohmarchy's lead is 0: it fits). */
const FOLD_ON_REFUSAL: readonly string[] = ["1024x600", "text 1.5 at 1440x900", "text 1.25 at 1280x720"];

/** Where the page's parts stand, in the window's px, and whether the page says it folded. */
const pageRead = (page: Page) =>
  page.evaluate(() => {
    const box = (sel: string) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    return {
      say: box(".oh-page-say"),
      material: box("[data-scene='material']"),
      act: box(".oh-page-acts .oh-button"),
      folded: document.querySelector(".oh-page")!.hasAttribute("data-folded"),
    };
  });

describe("a page of two columns in a smaller window", () => {
  it.each([
    ...ROOMS,
    { room: "the unfolded phone on its side, 841x673", size: [841, 673], zoom: 1, foldl: true },
  ] as const)(
    "at $room, a page whose sentence column is taller than the window folds to one column: its act is reached by a wheel and pressed by a pointer",
    async ({ size, zoom, ...at }) => {
      const [width, height] = size;
      for (const [face, scheme] of LOOKS) {
        const look = `${face} ${scheme}`;
        const page = await mount("pageTall", zoom, {
          face,
          scheme,
          window: [width, height],
          foldl: "foldl" in at,
        });
        try {
          /* The case is what it says: the act stands under the window's foot when the page is drawn. */
          expect((await pageRead(page)).act.bottom, `${look}: the act starts under the foot`).toBeGreaterThan(
            height,
          );
          await page.mouse.move(width / 2, height / 2);
          await page.mouse.wheel(0, 4000);
          const reached = await page
            .waitForFunction(
              (foot) =>
                document.querySelector(".oh-page-acts .oh-button")!.getBoundingClientRect().bottom <= foot,
              height,
              { timeout: 3_000 },
            )
            .then(() => true)
            .catch(() => false);
          const seen = await pageRead(page);
          expect(
            reached,
            `${look}: a wheel brings the act inside (it stands at ${seen.act.top} to ${seen.act.bottom})`,
          ).toBe(true);
          expect(seen.act.top, `${look}: the act inside the window`).toBeGreaterThanOrEqual(0);
          await page.mouse.click((seen.act.left + seen.act.right) / 2, (seen.act.top + seen.act.bottom) / 2);
          expect(await page.locator("[data-pressed]").getAttribute("data-pressed"), `${look}: pressed`).toBe(
            "1",
          );
          /* One column, as the unfolded phone held upright draws a page that stacks: the material under the act. */
          expect(seen.folded, look).toBe(true);
          expect(seen.material.top, `${look}: the material under the act`).toBeGreaterThan(seen.act.bottom);
          near(seen.material.left, seen.say.left);
        } finally {
          await page.close();
        }
      }
    },
    120_000,
  );

  it.each([
    ...ROOMS,
    { room: "1440x900", size: [1440, 900], zoom: 1 },
    { room: "the unfolded phone on its side, 841x673", size: [841, 673], zoom: 1, foldl: true },
  ] as const)(
    "at $room, a page whose sentence column fits keeps its two columns",
    async ({ size, zoom, ...at }) => {
      const [width, height] = size;
      for (const [face, scheme] of LOOKS) {
        const look = `${face} ${scheme}`;
        const foldl = "foldl" in at;
        const page = await mount("pageShort", zoom, { face, scheme, window: [width, height], foldl });
        try {
          const seen = await pageRead(page);
          expect(seen.folded, look).toBe(false);
          expect(seen.material.left, `${look}: the material beside the sentence`).toBeGreaterThan(
            seen.say.right,
          );
          expect(seen.act.bottom, `${look}: the act inside the window`).toBeLessThanOrEqual(height);
        } finally {
          await page.close();
        }
      }
    },
    120_000,
  );

  it("a folded page that is measured again keeps the place it was scrolled to; folded under the keys, what has them stays in sight, and the window is told of no error", async () => {
    const [width, height] = [1024, 600];
    const step = (page: Page) =>
      page.evaluate(() => (window as unknown as { stepScene: () => void }).stepScene());
    const scrolled = (page: Page) => page.evaluate(() => document.querySelector(".oh-page-body")!.scrollTop);
    /*
     * Folded by a refusal and scrolled to its foot, further than its two columns could scroll; then the window a
     * little lower: the page measures in its two columns again and stays where it was.
     */
    const kept = await mount("pageShort", 1, { window: [width, height] });
    try {
      await step(kept);
      await frames(kept);
      expect((await pageRead(kept)).folded).toBe(true);
      await kept.mouse.move(width / 2, height / 2);
      await kept.mouse.wheel(0, 4000);
      await kept.waitForFunction(() => {
        const body = document.querySelector(".oh-page-body")!;
        return body.scrollTop > 200 && body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
      });
      const at = await scrolled(kept);
      await kept.setViewportSize({ width, height: height - 10 });
      await frames(kept);
      expect((await pageRead(kept)).folded).toBe(true);
      near(await scrolled(kept), at);
      /* And in a window it fits again, it is two columns again. */
      await kept.setViewportSize({ width: 1440, height: 900 });
      await frames(kept);
      const wide = await pageRead(kept);
      expect(wide.folded).toBe(false);
      expect(wide.material.left, "the material beside the sentence").toBeGreaterThan(wide.say.right);
    } finally {
      await kept.close();
    }
    /* The keys in the material, which the fold sends under the buttons and the window's foot: it is brought back. */
    const held = await mount("pageShort", 1, { window: [width, height] });
    try {
      const inside = held.locator("[data-scene='in-material']");
      await inside.focus();
      /* The fold moves the boxes the part watches: the browser must not say on the window that it could not tell of them. */
      await held.evaluate(() => {
        const told: string[] = [];
        Object.assign(window, { told });
        addEventListener("error", (event) => told.push(event.message));
      });
      await step(held);
      await frames(held);
      expect(await held.evaluate(() => (window as unknown as { told: string[] }).told)).toEqual([]);
      const seen = await pageRead(held);
      expect(seen.folded).toBe(true);
      expect(seen.material.top, "the material under the act").toBeGreaterThan(seen.act.bottom);
      expect(await inside.evaluate((el) => el === document.activeElement), "the keys stay").toBe(true);
      const box = await rectOf(held, "[data-scene='in-material']");
      expect(box.top, "what has the keys in sight").toBeGreaterThanOrEqual(0);
      expect(box.bottom, "what has the keys in sight").toBeLessThanOrEqual(height + 1);
    } finally {
      await held.close();
    }
  }, 60_000);

  it.each(ROOMS)(
    "at $room, a refusal said while a person types folds the page where it no longer fits: the keys and the typed words stay in the blank",
    async ({ room, size, zoom }) => {
      const [width, height] = size;
      for (const [face, scheme] of LOOKS) {
        const look = `${face} ${scheme}`;
        const page = await mount("pageShort", zoom, { face, scheme, window: [width, height] });
        try {
          const blank = page.getByRole("textbox", { name: "Billing address" });
          await blank.click();
          await page.keyboard.type("anna@");
          await page.evaluate(() => (window as unknown as { stepScene: () => void }).stepScene());
          await frames(page);
          await page.keyboard.type("example.ch");
          const seen = await pageRead(page);
          /* Where the two refusals make the sentence column taller than the window, the page folds; else it keeps two. */
          expect(seen.folded, look).toBe(face === "paper" && FOLD_ON_REFUSAL.includes(room));
          if (seen.folded)
            expect(seen.material.top, `${look}: the material under the act`).toBeGreaterThan(seen.act.bottom);
          else expect(seen.material.left, `${look}: the material beside`).toBeGreaterThan(seen.say.right);
          expect(await blank.inputValue(), look).toBe("anna@example.ch");
          expect(await blank.evaluate((el) => el === document.activeElement), `${look}: the keys stay`).toBe(
            true,
          );
          const at = await rectOf(page, ".oh-blank");
          expect(at.top, `${look}: the blank in sight`).toBeGreaterThanOrEqual(0);
          expect(at.bottom, `${look}: the blank in sight`).toBeLessThanOrEqual(height);
        } finally {
          await page.close();
        }
      }
    },
    120_000,
  );
});

describe("the look tiles under the keys and a finger", () => {
  const PAPER = "oh";
  const OHMARCHY = "ohmarchy follows Omarchy";
  const pressed = (page: Page) =>
    Promise.all(
      [PAPER, OHMARCHY].map((name) =>
        page.getByRole("button", { name, exact: true }).getAttribute("aria-pressed"),
      ),
    );
  it.each([1, 1.25] as const)(
    "at Text size %s: Tab reaches each tile, Enter and Space choose and pressed is said; under a finger a tap chooses and each tile is a thumb's height or more",
    async (zoom) => {
      for (const face of ["paper", "ohmarchy"] as const) {
        const keys = await mount("tiles", zoom, { face });
        try {
          await keys.keyboard.press("Tab");
          const first = await keys.evaluate(() => document.activeElement?.getAttribute("aria-pressed"));
          expect(first, `${face}: the first stop is the first tile`).toBe("true");
          await keys.keyboard.press("Tab");
          expect(
            await keys
              .getByRole("button", { name: OHMARCHY, exact: true })
              .evaluate((el) => el === document.activeElement),
          ).toBe(true);
          await keys.keyboard.press("Enter");
          expect(await pressed(keys), `${face}: Enter`).toEqual(["false", "true"]);
          await keys.keyboard.press("Shift+Tab");
          await keys.keyboard.press(" ");
          expect(await pressed(keys), `${face}: Space`).toEqual(["true", "false"]);
          /* Said: one button of each name, and the chosen one pressed. */
          expect(await keys.getByRole("button", { name: PAPER, exact: true, pressed: true }).count()).toBe(1);
        } finally {
          await keys.close();
        }
        const touch = await mount("tiles", zoom, { face, phone: true });
        try {
          await touch.getByRole("button", { name: OHMARCHY, exact: true }).tap();
          expect(await pressed(touch), `${face}: a tap`).toEqual(["false", "true"]);
          for (const name of [PAPER, OHMARCHY]) {
            const box = (await touch.getByRole("button", { name, exact: true }).boundingBox())!;
            expect(box.height, `${face}: ${name} under a finger`).toBeGreaterThanOrEqual(44 * zoom);
          }
          /* One column under a finger: the second tile stands under the first. */
          const [a, b] = await Promise.all(
            [PAPER, OHMARCHY].map(
              async (name) => (await touch.getByRole("button", { name, exact: true }).boundingBox())!,
            ),
          );
          expect(b!.y, `${face}: one column`).toBeGreaterThanOrEqual(a!.y + a!.height);
        } finally {
          await touch.close();
        }
      }
    },
    60_000,
  );
  it.each([1, 1.25] as const)(
    "at Text size %s: under a pointer the tiles stand side by side where two fit, and one under the other in a narrower column; every word stays in its tile",
    async (zoom) => {
      for (const face of ["paper", "ohmarchy"] as const)
        for (const width of [390, 430, 760] as const) {
          /* A mouse in a narrow window: the frame says one column under 700 wide, and a finger only where one is. */
          const page = await mount("tiles", zoom, { face, window: [Math.round(width * zoom), 800] });
          try {
            const tiles = await page.evaluate(() =>
              [...document.querySelectorAll("button[aria-pressed]")].map((tile) => {
                const at = tile.getBoundingClientRect();
                const ends = [...tile.querySelectorAll("time"), tile.lastElementChild!.lastElementChild!].map(
                  (word) => word.getBoundingClientRect().right,
                );
                return {
                  top: at.top,
                  bottom: at.bottom,
                  right: at.right,
                  past: Math.max(...ends) - at.right,
                };
              }),
            );
            const [a, b] = tiles as [(typeof tiles)[number], (typeof tiles)[number]];
            for (const tile of tiles)
              expect(tile.past, `${face} ${width}: a word past its tile's edge`).toBeLessThanOrEqual(0);
            if (width === 760) expect(b.top, `${face} ${width}: side by side`).toBe(a.top);
            else expect(b.top, `${face} ${width}: one under the other`).toBeGreaterThanOrEqual(a.bottom);
          } finally {
            await page.close();
          }
        }
    },
    60_000,
  );
  it.each([1, 1.25, 1.5] as const)(
    "at Text size %s: a longer word beside a tile's name stays inside its tile, under a finger and under a mouse, and the tile is heard by the whole word",
    async (zoom) => {
      const LONG = "übernimmt das Omarchy-Theme";
      for (const face of ["paper", "ohmarchy"] as const)
        for (const finger of [true, false]) {
          /* A phone, and a mouse in the desktop's narrowest window. */
          const page = await mount(
            "tilesLong",
            zoom,
            finger ? { face, phone: true } : { face, window: [Math.round(390 * zoom), 800] },
          );
          try {
            const tile = page.getByRole("button", { name: `ohmarchy ${LONG}`, exact: true });
            expect(await tile.count(), `${face}: the tile heard by its name and the whole word`).toBe(1);
            const at = await tile.evaluate((button) => {
              const box = button.getBoundingClientRect();
              const tag = button.lastElementChild!.lastElementChild!;
              const word = tag.getBoundingClientRect();
              return {
                past: Math.max(word.right - box.right, word.bottom - box.bottom, box.left - word.left),
                over: tag.scrollWidth - tag.clientWidth,
              };
            });
            const where = `${face} ${finger ? "a finger" : "a mouse"}`;
            expect(at.past, `${where}: the word past its tile's edge`).toBeLessThanOrEqual(0);
            expect(at.over, `${where}: the word past its own capsule`).toBeLessThanOrEqual(0);
          } finally {
            await page.close();
          }
        }
    },
    60_000,
  );
});

describe("words a part measures for itself, in German at the largest Text size", () => {
  it.each([
    ["paper", 1],
    ["paper", 1.5],
    ["ohmarchy", 1.5],
  ] as const)(
    "in %s on a phone at Text size %s: the draft control draws its fewer words where the whole would be cut, whole and inside the foot, and keeps its whole name",
    async (face, zoom) => {
      const page = await mount("draftFoot", zoom, { face, phone: true });
      try {
        await frames(page);
        const control = page.getByRole("button", { name: "Aus deinem Text entwerfen", exact: true });
        expect(await control.count()).toBe(1);
        const at = await control.evaluate((button) => {
          const foot = button.closest('[role="toolbar"]')!.getBoundingClientRect();
          const box = button.getBoundingClientRect();
          const drawn = [...button.querySelectorAll("span")].filter(
            (word) => word.getClientRects().length > 0,
          );
          return {
            words: drawn.map((word) => word.textContent),
            cut: drawn.map((word) => word.scrollWidth - word.clientWidth),
            past: Math.max(box.right - foot.right, foot.left - box.left),
          };
        });
        /* One of the two is drawn, never both, and what is drawn is whole. */
        expect(at.words).toHaveLength(1);
        expect(at.cut[0], `"${at.words[0]}" past its own box`).toBeLessThanOrEqual(0);
        expect(at.past, "the control past the foot's edge").toBeLessThanOrEqual(0.5);
        if (zoom === 1.5) expect(at.words).toEqual(["Aus Text entwerfen"]);
      } finally {
        await page.close();
      }
    },
    60_000,
  );

  it.each([
    ["paper", 1],
    ["ohmarchy", 1],
    ["paper", 1.5],
    ["ohmarchy", 1.5],
  ] as const)(
    "in %s at Text size %s: a list line's quiet press wider than the line takes a second line inside the list, its words inside it with air over and under them; one that fits is the small button on one line",
    async (face, zoom) => {
      const page = await mount("lineFold", zoom, { face });
      try {
        await frames(page);
        const got = await page.evaluate(() =>
          [...document.querySelectorAll("#column p")].map((line) => {
            const box = line.getBoundingClientRect();
            const act = line.querySelector("button")!;
            const [a, word] = [act.getBoundingClientRect(), act.querySelector("span")!];
            const w = word.getBoundingClientRect();
            const letters = document.createRange();
            letters.selectNodeContents(word);
            const probe = document.createElement("i");
            probe.style.cssText = "display:block;height:var(--h-s)";
            line.append(probe);
            const small = probe.getBoundingClientRect().height;
            probe.remove();
            return {
              actInside: a.left >= box.left - 0.5 && a.right <= box.right + 0.5,
              wordInsideItsPress: w.left >= a.left - 0.5 && w.right <= a.right + 0.5,
              wordHasAir: w.top - a.top >= 2 && a.bottom - w.bottom >= 2,
              lines: new Set([...letters.getClientRects()].map((row) => Math.round(row.top))).size,
              overASmallButton: Math.round((a.height - small) * 10) / 10,
              sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          }),
        );
        const [long, short] = got;
        expect({ ...long, lines: Math.min(long!.lines, 2), overASmallButton: 0 }).toEqual({
          actInside: true,
          wordInsideItsPress: true,
          wordHasAir: true,
          lines: 2,
          overASmallButton: 0,
          sideways: 0,
        });
        expect(long!.overASmallButton).toBeGreaterThan(0);
        /* One that fits is exactly the small button it was. */
        expect(short).toEqual({ ...long, lines: 1, overASmallButton: 0 });
      } finally {
        await page.close();
      }
    },
    60_000,
  );

  it("in paper at Text size 1: a list line's quiet press folds when its column narrows and stands on one line again when it widens, with nothing drawn again", async () => {
    const page = await mount("lineFold", 1, { face: "paper" });
    try {
      await frames(page);
      const folds = () =>
        page.evaluate(() =>
          [...document.querySelectorAll("#column p > button")].map((b) => b.hasAttribute("data-fold")),
        );
      expect(await folds()).toEqual([true, false]);
      await page.evaluate(() => void (document.getElementById("column")!.style.width = "1200px"));
      await frames(page);
      expect(await folds()).toEqual([false, false]);
      await page.evaluate(() => void (document.getElementById("column")!.style.width = "250px"));
      await frames(page);
      expect(await folds()).toEqual([true, false]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it.each([
    ["paper", 1],
    ["ohmarchy", 1],
    ["paper", 1.5],
  ] as const)(
    "in %s at Text size %s: a note that is to stay in the reading panel, longer than its column, takes a second line inside the panel; the panel stays inside its column and keeps its verb",
    async (face, zoom) => {
      const page = await mount("panelNote", zoom, { face });
      try {
        await frames(page);
        const at = await page.evaluate(() => {
          const column = document.getElementById("column")!.getBoundingClientRect();
          const bar = document.querySelector('[role="toolbar"]')!;
          const box = bar.getBoundingClientRect();
          const note = bar.querySelector("span")!;
          const n = note.getBoundingClientRect();
          const lineHigh =
            parseFloat(getComputedStyle(note).lineHeight) * (box.width / (bar as HTMLElement).offsetWidth);
          return {
            barPast: Math.max(box.right - column.right, column.left - box.left),
            notePast: Math.max(
              n.right - box.right,
              box.left - n.left,
              n.bottom - box.bottom,
              box.top - n.top,
            ),
            noteCut: note.scrollWidth - note.clientWidth,
            lines: Math.round(n.height / lineHigh),
            words: note.textContent,
            verb: bar.querySelector("button")!.getClientRects().length > 0,
          };
        });
        expect(at.words).toBe("Dieses Postfach wird von nichts organisiert");
        expect(at.barPast, "the panel past its column").toBeLessThanOrEqual(0.5);
        expect(at.notePast, "the note past the panel").toBeLessThanOrEqual(0.5);
        expect(at.noteCut, "the note's words past its own box").toBeLessThanOrEqual(0);
        expect(at.lines).toBeGreaterThan(1);
        expect(at.verb).toBe(true);
      } finally {
        await page.close();
      }
    },
    60_000,
  );
});
