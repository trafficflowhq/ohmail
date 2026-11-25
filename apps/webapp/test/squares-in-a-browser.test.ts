/**
 * THE CONVERSATION'S SQUARES IN A REAL BROWSER: what jsdom cannot show, the squares laid out by the kit's sheets
 * beside the reader's letters (on a phone, in the bar over the column), through the real frame over the fake host
 * (`packages/app/test/states/squares-reader-1-page.tsx`). They stand beside the letters and over none, inside their capsule and the window,
 * still while the letters scroll; a conversation longer than its room stands a run around the letter the reader is
 * on, every square of it whole or tapered, the two counts saying every letter the run hides; a press on a square,
 * a tapered one too, lands the reader on that letter; and the engine's walk, measured over the laid-out letters,
 * names the first at the top and the last at the end. Each measurement has a red control or a "this proves
 * nothing" guard. Nothing leaves the machine: the page is served on a routed origin.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { threadWalk } from "@ohmail/client-engine";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
type Browser = Awaited<ReturnType<typeof chromium.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

const ORIGIN = "http://squares.states.invalid";
let browser: Browser | null = null;
let html = "";

beforeAll(async () => {
  const states = (await import("../../../packages/app/test/states/reader-states.mjs")) as {
    readerStatesPage: (entry?: string) => Promise<string>;
  };
  html = await states.readerStatesPage("packages/app/test/states/squares-reader-1-page.tsx");
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
interface Opened {
  page: Page;
  errors: string[];
}

/** The page at `query`, in a window `width` × `height`, once the conversation's squares stand and the open settled. */
async function open(
  query: string,
  width: number,
  height: number,
  motion: "reduce" | "no-preference" = "reduce",
): Promise<Opened> {
  const page = await browser!.newPage({ viewport: { width, height }, reducedMotion: motion });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto(`${ORIGIN}/?${query}${motion === "no-preference" ? "&motion=full" : ""}`);
  await squaresOf(page).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(700);
  return { page, errors };
}

/** The conversation's squares: the group named by its counts. */
const squaresOf = (page: Page) => page.getByRole("group", { name: /^\d+ messages, \d+ unread$/ });

/**
 * The squares as drawn: each one's slot and face, whether it stands (a slot outside the run is folded to nothing) and
 * whether it is the reader's; the two counts; the capsule; the letters; the reading column's scroller.
 */
function walkGeometry(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-reading-scroll]")!;
    const top = scroller.getBoundingClientRect().top;
    const tops = [...scroller.querySelectorAll("[data-conv-id]")].map(
      (letter) => letter.getBoundingClientRect().top - top + scroller.scrollTop,
    );
    const stops = [...scroller.closest("[data-read-column]")!.querySelectorAll("[data-read-stop]")]
      .map((stop) => stop.getBoundingClientRect())
      .filter((box) => box.height > 0 && box.top > top);
    const bottom = Math.min(top + scroller.clientHeight, ...stops.map((box) => box.top));
    return { tops, max: scroller.scrollHeight - scroller.clientHeight, view: bottom - top };
  });
}

/** The first hand scroll releases the extra room that holds an opening while bodies load. */
async function releaseOpeningAtTop(page: Page): Promise<void> {
  const scroller = page.locator("[data-reading-scroll]");
  await scroller.evaluate((el) => {
    el.dispatchEvent(new WheelEvent("wheel"));
    el.scrollTop = 0;
  });
  await expect.poll(() => scroller.evaluate((el: HTMLElement) =>
    el.scrollTop === 0 && el.style.getPropertyValue("--oh-thread-landing-room") === "",
  )).toBe(true);
}

async function showLetter(page: Page, index: number) {
  await releaseOpeningAtTop(page);
  const layout = await walkGeometry(page);
  const last = layout.tops.length - 1;
  const walk = threadWalk({ ...layout, opened: last });
  const offset = index === 0 ? 0 : index === last ? layout.max
    : Math.round((walk.scrollFor(index) + walk.scrollFor(index + 1)) / 2);
  await page.evaluate((scrollTop) => {
    document.querySelector<HTMLElement>("[data-reading-scroll]")!.scrollTop = scrollTop;
  }, offset);
  await expect.poll(async () => (await read(page)).squares.findIndex((square) => square.here)).toBe(index);
  await expect.poll(() => squaresOf(page).evaluate((group) =>
    group.getAnimations({ subtree: true }).some((animation) => animation.playState === "running"),
  )).toBe(false);
}

async function read(page: Page) {
  const group = await squaresOf(page).elementHandle();
  return group!.evaluate((g: Element) => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const slots = [...g.querySelectorAll<HTMLElement>("[data-square]")];
    const count = (el: Element | null): number => Number((el?.textContent ?? "").replace(/^\+/, "")) || 0;
    const scroller = document.querySelector<HTMLElement>("[data-reading-scroll]")!;
    return {
      capsule: box(g),
      squares: slots.map((s) => ({
        index: Number(s.dataset.square),
        slot: box(s),
        face: box(s.firstElementChild!),
        stands: !s.hasAttribute("data-off"),
        here: s.hasAttribute("data-here"),
      })),
      before: count(g.firstElementChild),
      after: count(g.lastElementChild),
      letters: [...document.querySelectorAll("[data-conv-id]")].map(box),
      column: box(scroller),
      scrollTop: scroller.scrollTop,
      sideways: scroller.scrollWidth - scroller.clientWidth,
      pageSideways: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

const overlap = (a: Box, b: Box): boolean =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const inside = (a: Box, b: Box): boolean =>
  a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;

describe("the column of squares stands beside the letters, over none", () => {
  const LOOKS = [
    [1440, 900, "paper", "light"],
    [1440, 900, "paper", "dark"],
    [1024, 768, "ohmarchy", "dark"],
    [1024, 768, "paper", "light"],
  ] as const;
  for (const [width, height, face, scheme] of LOOKS)
    for (const n of [4, 80])
      it(`${width}×${height}, ${face} ${scheme}, ${n} letters: no square on a letter, each inside its capsule and the window, nothing scrolls sideways`, async () => {
        const { page, errors } = await open(`n=${n}&face=${face}&scheme=${scheme}`, width, height);
        try {
          const r = await read(page);
          const standing = r.squares.filter((s) => s.stands);
          expect(standing.length, "the column drew no squares").toBeGreaterThan(3);
          const hits = standing.flatMap((s) =>
            r.letters.filter((l) => overlap(s.face, l)).map(() => `square ${s.index}`),
          );
          expect(hits, "a square is drawn over a letter").toEqual([]);
          const out = standing.filter((s) => !inside(s.slot, r.capsule)).map((s) => s.index);
          expect(out, "a square stands outside its capsule").toEqual([]);
          const win = { left: 0, top: 0, right: width, bottom: height, width, height };
          expect(inside(r.capsule, win), "the capsule runs out of the window").toBe(true);
          expect(r.sideways, "the squares widen the column's scroll").toBeLessThanOrEqual(0);
          expect(r.pageSideways, "the page scrolls sideways").toBeLessThanOrEqual(0);
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      }, 60_000);

  it("RED CONTROL: the column moved onto the letters lands on them, and the measurement says so", async () => {
    const { page } = await open("n=4", 1440, 900);
    try {
      const before = await read(page);
      const face = before.squares.find((square) => square.stands)!.face;
      const letter = before.letters.find((box) => overlap(box, before.column))!;
      await squaresOf(page).evaluate((group, { x, y }) => {
        const style = (group as HTMLElement).style;
        style.position = "relative";
        style.left = `${x}px`;
        style.top = `${y}px`;
      }, { x: letter.left + 8 - face.left, y: Math.max(letter.top, before.column.top) + 8 - face.top });
      const r = await read(page);
      const hits = r.squares.filter((s) => s.stands && r.letters.some((l) => overlap(s.face, l)));
      expect(
        hits.length,
        "the control found no square on a letter: the measurement proves nothing",
      ).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("the squares stand still while the letters scroll, and stay beside them", async () => {
    const { page } = await open("n=8&open=0", 1440, 900);
    try {
      await showLetter(page, 0);
      const before = await read(page);
      await page.evaluate(() => {
        document.querySelector<HTMLElement>("[data-reading-scroll]")!.scrollTop += 600;
      });
      await page.waitForTimeout(100);
      const after = await read(page);
      expect(
        after.scrollTop - before.scrollTop,
        "the letters did not scroll: this proves nothing",
      ).toBeGreaterThan(500);
      expect(
        after.squares.map((s) => s.face.top),
        "a square moved with the scroll",
      ).toEqual(before.squares.map((s) => s.face.top));
      expect(
        after.squares.some((s) => after.letters.some((l) => overlap(s.face, l))),
        "a scrolled letter runs under a square",
      ).toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("on a phone the squares stand in the bar over the column, on top, before and after a scroll", async () => {
    const { page } = await open("n=12&open=0&device=phone", 390, 844);
    try {
      const look = () =>
        page.evaluate(() => {
          const g = document.querySelector<HTMLElement>('[role="group"][aria-label$="unread"]')!;
          const q = g.querySelector("[data-square]:not([data-off])")!.getBoundingClientRect();
          const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
          const first = document.querySelector("[data-conv-id]")!.getBoundingClientRect();
          const sc = document.querySelector<HTMLElement>("[data-reading-scroll]")!.getBoundingClientRect();
          return {
            top: q.top,
            onTop: hit !== null && g.contains(hit),
            over: q.bottom <= Math.max(first.top, sc.top) + 0.5,
            inWindow: q.left >= 0 && q.top >= 0 && q.right <= innerWidth && q.bottom <= innerHeight,
          };
        });
      const before = await look();
      const scrolled = await page.evaluate(() => {
        const sc = document.querySelector<HTMLElement>("[data-reading-scroll]")!;
        sc.scrollTop = 900;
        return sc.scrollTop;
      });
      await page.waitForTimeout(100);
      const after = await look();
      expect(scrolled, "the column did not scroll: this proves nothing").toBeGreaterThan(800);
      for (const at of [before, after]) {
        expect(at.onTop, "the square is under something").toBe(true);
        expect(at.over, "the square is not over the conversation").toBe(true);
        expect(at.inWindow).toBe(true);
      }
      expect(after.top, "the squares scrolled away with the letters").toBe(before.top);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("the head of a conversation among many people", () => {
  it("stands four faces and counts the rest: the column does not scroll sideways", async () => {
    const { page } = await open("n=80", 1440, 900);
    try {
      const r = await read(page);
      const head = await page.evaluate(
        () => document.querySelector("[data-reading-scroll] header")?.textContent ?? "",
      );
      expect(r.sideways, "the head's faces widen the column's scroll").toBeLessThanOrEqual(0);
      expect(head, "the head does not count the people it draws no face for").toContain("+76");
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("a long conversation's squares: a run, whole squares, +N and the taper", () => {
  const LINES = [
    ["the column", "n=80", 1440, 900, "paper", "light"],
    ["the column", "n=80", 1440, 900, "ohmarchy", "dark"],
    ["the bar on a phone", "n=40&device=phone", 390, 844, "paper", "light"],
    ["the bar on a phone", "n=40&device=phone", 390, 844, "ohmarchy", "dark"],
  ] as const;
  for (const [line, query, width, height, face, scheme] of LINES)
    it(`${line}, ${face} ${scheme}: opened at letter after letter, an unbroken run around the reader's, the counts saying every letter`, async () => {
      const n = Number(/n=(\d+)/.exec(query)![1]);
      const froms: number[] = [];
      for (const at of [0, 3, Math.floor(n / 3), Math.floor(n / 2), n - 4, n - 1]) {
        const { page } = await open(`${query}&open=${at}&face=${face}&scheme=${scheme}`, width, height);
        try {
          await showLetter(page, at);
          const r = await read(page);
          const here = r.squares.findIndex((s) => s.here);
          const shown = r.squares.filter((s) => s.stands).map((s) => s.index);
          expect(here, `open at ${at}: no square is the reader's`).toBeGreaterThanOrEqual(0);
          expect(shown, `open at ${at}: the reader's square is not in the run`).toContain(here);
          expect(shown.length, `open at ${at}: the conversation fits: this proves nothing`).toBeLessThan(n);
          const whole = r.squares.filter((s) => s.stands && inside(s.slot, r.capsule));
          expect(whole.length, `open at ${at}: a square drawn in part`).toBe(shown.length);
          const ring = r.squares[here]!;
          const full = Math.max(...r.squares.filter((s) => s.stands).map((s) => s.face.width));
          expect(ring.face.width, `open at ${at}: the ringed square is not at full size`).toBe(full);
          expect(
            r.before + shown.length + r.after,
            `open at ${at}: the counts and the squares say every letter`,
          ).toBe(n);
          expect(shown, "one unbroken run").toEqual(shown.map((_, k) => shown[0]! + k));
          expect(r.before, "+N before: exactly the squares hidden there").toBe(shown[0]);
          const sizes = shown.map((i) => r.squares[i]!.face.width);
          if (r.before > 0) {
            const edge = sizes.slice(0, 3);
            expect(edge, "the old edge tapers toward the hidden").toEqual([...edge].sort((a, b) => a - b));
            expect(edge[0], "the old edge's last square is smaller").toBeLessThan(full);
          }
          if (r.after > 0) {
            const edge = sizes.slice(-3).reverse();
            expect(edge, "the new edge tapers toward the hidden").toEqual([...edge].sort((a, b) => a - b));
            expect(edge[0], "the new edge's last square is smaller").toBeLessThan(full);
          }
          if (r.before === 0) expect(sizes[0], "no count, no taper").toBe(full);
          froms.push(shown[0]!);
        } finally {
          await page.close();
        }
      }
      expect(froms[0], "at the start the first is shown").toBe(0);
      expect(
        new Set(froms).size,
        "the run follows the reader: the start, the middle, the end",
      ).toBeGreaterThanOrEqual(3);
    }, 120_000);

  it("a short conversation stands every square whole and no count", async () => {
    const { page } = await open("n=9&open=4", 1440, 900);
    try {
      const r = await read(page);
      expect([
        r.before,
        r.after,
        r.squares.filter((s) => s.stands && inside(s.slot, r.capsule)).length,
      ]).toEqual([0, 0, 9]);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("a press on a square", () => {
  const AXES = [
    ["the column", "n=80&open=40", 1440, 900],
    ["the bar on a phone", "n=40&open=20&device=phone", 390, 844],
  ] as const;
  for (const [line, query, width, height] of AXES)
    it(`${line}: a mouse press on a tapered square lands the reader on that letter, the window stays`, async () => {
      for (const motion of ["reduce", "no-preference"] as const) {
        const { page } = await open(query, width, height, motion);
        try {
          await showLetter(page, line === "the column" ? 40 : 20);
          await page.waitForTimeout(300); // the first run's step
          const r = await read(page);
          const full = Math.max(...r.squares.filter((s) => s.stands).map((s) => s.face.width));
          const tapered = r.squares.filter((s) => s.stands && s.face.width < full).map((s) => s.index);
          expect(tapered.length, "both edges taper").toBe(6);
          const one = tapered[0]!;
          const slot = r.squares[one]!.slot;
          await page.mouse.move(slot.left + slot.width / 2, slot.top + slot.height / 2);
          await page.mouse.down();
          await page.waitForTimeout(90);
          await page.mouse.up();
          await page.waitForTimeout(400);
          const after = await read(page);
          expect(
            after.squares.filter((s) => s.here).map((s) => s.index),
            `${motion}: a press on ${one} lands the reader there`,
          ).toEqual([one]);
        } finally {
          await page.close();
        }
      }
    }, 120_000);

  it("keeps keyboard focus on the same letter when an earlier letter arrives", async () => {
    const { page } = await open("n=8&open=0", 1440, 900);
    try {
      const square = squaresOf(page).getByRole("button", { name: /Sender 4/ });
      await square.focus();
      await page.evaluate(() => (window as unknown as { addEarlier: () => void }).addEarlier());
      await squaresOf(page).getByRole("button", { name: /Sender 4/ }).waitFor();
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toContain("Sender 4");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      expect((await read(page)).squares.findIndex((s) => s.here)).toBe(5);
    } finally { await page.close(); }
  }, 60_000);

  it("leaves browser navigation keys to the browser", async () => {
    const { page } = await open("n=8&open=4", 1440, 900);
    try {
      const result = await squaresOf(page).evaluate((group) => {
        const square = group.querySelector<HTMLElement>("[data-here]")!;
        square.focus();
        const event = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true });
        square.dispatchEvent(event);
        return { canceled: event.defaultPrevented, focused: document.activeElement === square };
      });
      expect(result).toEqual({ canceled: false, focused: true });
    } finally { await page.close(); }
  }, 60_000);

  it("a keyboard focus on a square beyond the window pulls it over", async () => {
    const { page } = await open("n=80&open=40", 1440, 900);
    try {
      const focused = await (await squaresOf(page).elementHandle())!.evaluate((g: Element) => {
        const here = g.querySelector<HTMLElement>("[data-here]")!;
        here.focus();
        return document.activeElement === here;
      });
      expect(focused, "a square takes no keyboard").toBe(true);
      await page.keyboard.press("Home");
      await page.waitForTimeout(300);
      const l = await read(page);
      expect([l.before, l.squares[0]!.stands], "Home: the first square in view").toEqual([0, true]);
      await page.keyboard.press("End");
      await page.waitForTimeout(300);
      const e = await read(page);
      expect([e.after, e.squares[79]!.stands], "End: the last").toEqual([0, true]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("the run's steps move as motion: a slot grows and folds, its square with it", async () => {
    const { page } = await open("n=80&open=40", 1440, 900, "no-preference");
    try {
      const t = await (await squaresOf(page).elementHandle())!.evaluate((g: Element) => {
        const slot = g.querySelector("[data-square]")!;
        return [
          getComputedStyle(slot).transitionProperty,
          getComputedStyle(slot.firstElementChild!).transitionProperty,
        ];
      });
      expect(t[0].split(/,\s*/), "a slot moves and fades by compositor properties").toEqual([
        "transform", "opacity",
      ]);
      expect(t[1], "the square grows and folds by transform").toBe("transform");
      await (await squaresOf(page).elementHandle())!.evaluate((group) => {
        group.querySelector<HTMLElement>("[aria-current=true]")!.focus();
      });
      await page.keyboard.press("Home");
      await expect.poll(async () => (await read(page)).before).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("the walk over a laid-out thread", () => {
  it("measured in the engine: the first at the top, the one-line last at the end, never a step back, a press lands on the line", async () => {
    const { page } = await open("n=9", 1440, 800);
    try {
      await page.addStyleTag({
        content: `[data-conv-id="w0"],[data-conv-id="w8"]{max-height:64px;overflow:hidden}[data-conv-id="w4"]{min-height:900px}`,
      });
      await releaseOpeningAtTop(page);
      const geo = await walkGeometry(page);
      expect(geo.tops.length, "the column holds the nine letters").toBe(9);
      expect(geo.max, "the thread does not scroll: this proves nothing").toBeGreaterThan(geo.view);
      const walk = threadWalk({ ...geo, opened: 8 });
      expect(walk.current(0)).toBe(0);
      expect(walk.current(geo.max), "the short last message at the very end").toBe(8);
      const seen: number[] = [];
      for (let s = 0; s <= geo.max; s += 1) seen.push(walk.current(s));
      expect(
        seen.every((v, i) => i === 0 || v >= seen[i - 1]!),
        "a step back on a scroll down",
      ).toBe(true);
      expect(new Set(seen).size, "every message is current on the way").toBe(9);
      for (let k = 1; k < 8; k++) {
        const s = walk.scrollFor(k);
        const at = await page.evaluate(
          ([s, k]) => {
            const sc = document.querySelector<HTMLElement>("[data-reading-scroll]")!;
            sc.scrollTop = s!;
            const p = sc.querySelectorAll<HTMLElement>("[data-conv-id]")[k!]!;
            return {
              scroll: sc.scrollTop,
              top: p.getBoundingClientRect().top - sc.getBoundingClientRect().top,
            };
          },
          [s, k],
        );
        expect(at.scroll, `the engine took the press's scroll for ${k}`).toBeCloseTo(s, 0);
        expect(walk.current(at.scroll), `a press on ${k} rings it`).toBe(k);
        expect(at.top, `${k}'s top on the line`).toBeLessThanOrEqual(walk.lineAt(at.scroll) + 1);
      }
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("conversation previews", () => {
  it.each(["desktop", "phone"] as const)("shows an opaque card in the kit face on %s", async (device) => {
    const { page } = await open(`n=4&device=${device}`, device === "phone" ? 390 : 1440, device === "phone" ? 844 : 900);
    try {
      const square = squaresOf(page).getByRole("button").first();
      if (device === "phone") await square.dispatchEvent("pointerdown", { pointerType: "touch", bubbles: true });
      else await square.hover();
      const preview = page.getByRole("tooltip", { includeHidden: true });
      await preview.waitFor({ state: "visible" });
      const seen = await preview.evaluate((el) => {
        const style = getComputedStyle(el);
        const root = getComputedStyle(document.querySelector(".oh-root")!);
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = style.backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        const probe = document.createElement("span");
        probe.style.boxShadow = "var(--float)";
        document.querySelector(".oh-root")!.append(probe);
        const expectedShadow = getComputedStyle(probe).boxShadow;
        probe.remove();
        return {
          shadow: style.boxShadow,
          expectedShadow,
          alpha: ctx.getImageData(0, 0, 1, 1).data[3],
          font: style.fontFamily,
          kitFont: root.fontFamily,
        };
      });
      expect(seen.shadow).toBe(seen.expectedShadow);
      expect(seen.alpha).toBe(255);
      expect(seen.font).toBe(seen.kitFont);
    } finally {
      await page.close();
    }
  });
});
