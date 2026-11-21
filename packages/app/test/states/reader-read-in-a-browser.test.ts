/**
 * THE READ RULE IN A REAL BROWSER, on the reader's states page: what jsdom cannot show, a column laid out by the
 * kit's sheets and the body's own text. A conversation of three unread letters, opened on the first, which is long:
 * once its first lines stayed 0.7 s with its sender line on screen it turns read, exactly once, and the two letters
 * below the fold never do. And the wide window (B12-1): from 1440 up the column keeps its width and what is read
 * stands centred at the reading width, the panel on its middle and no wider. Nothing leaves the machine: the page is served on a
 * routed origin.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const ORIGIN = "http://reader.states.invalid";
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

type Read = { kind: string; messageIds?: string[]; unread?: boolean };

describe("the read rule in a real browser", () => {
  it("the opened letter turns read once, after the dwell; the letters below the fold never do", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?open=rd-a&read=1&screen=reading`);
    await page.waitForSelector('[data-conv-id="rd-a"][data-body-ready]', { timeout: 15_000 });
    const reads = (): Promise<Read[]> =>
      page.evaluate(() =>
        ((globalThis as { readerMutations?: Read[] }).readerMutations ?? []).filter(
          (m) => m.kind === "mark_seen",
        ),
      );
    // Before the dwell, nothing.
    expect(await reads()).toEqual([]);
    await page.waitForTimeout(2_000);
    const after = await reads();
    expect(after.map((m) => [m.messageIds, m.unread])).toEqual([[["rd-a"], false]]);
    // The letters below the fold stayed off screen, and unread.
    const below = await page.evaluate(() => {
      const sc = document.querySelector(".oh-sheet-scroll")!.getBoundingClientRect();
      return ["rd-b", "rd-c"].map(
        (id) => document.querySelector(`[data-conv-id="${id}"]`)!.getBoundingClientRect().top > sc.bottom,
      );
    });
    expect(below).toEqual([true, true]);
    await page.waitForTimeout(1_000);
    expect((await reads()).length).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("marks the visible middle and newest messages when the newest message is chosen", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.route(`${ORIGIN}/**`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
      );
      await page.goto(`${ORIGIN}/?open=rd-c&read=1&screen=reading`);
      await page.waitForSelector('[data-conv-id="rd-c"][data-body-ready]');
      const marked = () =>
        page.evaluate(() =>
          ((globalThis as { readerMutations?: Read[] }).readerMutations ?? [])
            .filter((m) => m.kind === "mark_seen" && m.unread === false)
            .flatMap((m) => m.messageIds ?? [])
            .sort(),
        );
      await expect.poll(marked, { timeout: 4000 }).toEqual(["rd-b", "rd-c"]);
      await page.waitForTimeout(850);
      expect(await marked()).toEqual(["rd-b", "rd-c"]);
    } finally {
      await page.close();
    }
  }, 20_000);
});

describe("the wide window in a real browser", () => {
  /** The reading body's box, the panel's, and the column's, at one window size. */
  async function measure(width: number, height: number) {
    const page = await browser!.newPage({ viewport: { width, height } });
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?open=lt-log&screen=reading`);
    await page.waitForSelector('[data-conv-id="lt-log"][data-body-ready]', { timeout: 15_000 });
    const boxes = await page.evaluate(() => {
      const box = (el: Element | null) => {
        const r = el!.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      };
      return {
        column: box(document.querySelector('.oh-sheet[data-kind="reading"]')),
        run: box(document.querySelector('.oh-sheet[data-kind="reading"] .oh-sheet-body')),
        panel: box(document.querySelector('[role="toolbar"]')),
        readw: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--readw")),
      };
    });
    await page.close();
    return boxes;
  }

  it("at 2536 the run is the reading width and centred, the panel on its middle and no wider; at 1440 the run fills the column", async () => {
    const wide = await measure(2536, 1303);
    expect(wide.readw).toBe(740);
    expect(wide.run.width).toBeLessThanOrEqual(wide.readw + 8);
    expect(wide.run.width).toBeGreaterThan(wide.readw - 8);
    const sideL = wide.run.left - wide.column.left;
    const sideR = wide.column.right - wide.run.right;
    expect(Math.abs(sideL - sideR)).toBeLessThanOrEqual(1);
    // The panel stands on the run's middle, not the wide column's.
    const mid = (b: { left: number; right: number }) => (b.left + b.right) / 2;
    expect(Math.abs(mid(wide.panel) - mid(wide.run))).toBeLessThanOrEqual(1);
    expect(wide.panel.width).toBeLessThanOrEqual(wide.run.width + 1);
    const desk = await measure(1440, 900);
    expect(desk.run.width).toBeGreaterThan(desk.column.width - 16);
  }, 60_000);
});

describe("the panel's folds in a real browser", () => {
  /* Every verb of a letter that went to two more people, in the design's order (the panel's and More's). */
  const VERBS = ["Reply", "Reply all", "Forward", "Later", "Park", "Resurface", "Tag", "Mark unread"];
  /* What folds first: the highest rank. Reply, Forward and the read slot never fold. */
  const FOLDS = ["Tag", "Resurface", "Park", "Later", "Reply all"];
  /*
   * The design's panel at each size: what stands in it, in order, each with its word or its icon alone, and what
   * stands behind More. On the upright foldable the read slot gives up its word first, and Reply all and Tag stand
   * behind More; on a phone the read slot does too. At 1280 what folds is read by the rule.
   */
  const SIZES: readonly (readonly [string, number, number, string[] | null, string[] | null])[] = [
    ["", 1280, 800, null, null],
    [
      "device=fold&",
      719,
      841,
      ["Reply: word", "Forward: word", "Mark unread: icon"],
      ["Reply all", "Later", "Park", "Resurface", "Tag", "Delete"],
    ],
    [
      "device=phone&",
      390,
      844,
      ["Reply: word", "Forward: word", "Later: word"],
      ["Reply all", "Park", "Resurface", "Tag", "Mark unread", "Delete"],
    ],
  ];
  for (const [device, width, height, panelIs, moreIs] of SIZES)
    it(`${device}${width} wide: the panel's verbs stand in the design's order, in the panel or behind More, and a folded one runs from there`, async () => {
      const page = await browser!.newPage({ viewport: { width, height } });
      await page.route(`${ORIGIN}/**`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
      );
      await page.goto(`${ORIGIN}/?all=1&${device}open=lt-log&screen=reading`);
      await page.waitForSelector('[data-conv-id="lt-log"][data-body-ready]', { timeout: 15_000 });
      const panel = page.getByRole("toolbar", { name: "Actions" });
      /* The panel's verbs as they stand, in order: each with its word, or its icon alone. */
      const standing = await panel.evaluate((bar) =>
        [...bar.querySelectorAll<HTMLButtonElement>("button")]
          .filter((b) => b.getBoundingClientRect().width > 0 && b.getAttribute("aria-label") !== "More")
          .map((b) => `${b.getAttribute("aria-label")}: ${b.innerText.trim() === "" ? "icon" : "word"}`),
      );
      const shown = standing.map((s) => s.slice(0, s.indexOf(":")));
      console.log(`PANEL ${width}: ${standing.join(", ")}`);
      /* On a phone the frame's dock stands over the panel while a letter is open (the frame's to rule): pressed as an event. */
      if (width < 600) await panel.getByRole("button", { name: "More" }).dispatchEvent("click");
      else await panel.getByRole("button", { name: "More" }).click();
      const menuItems = await page.getByRole("menuitem").all();
      const behind = await Promise.all(
        menuItems.map(async (item) => /^- menuitem "([^"]+)"/.exec(await item.ariaSnapshot())?.[1]),
      );
      console.log(`MORE ${width}: ${behind.join(", ")}`);
      expect(VERBS.filter((v) => !shown.includes(v) && !behind.includes(v))).toEqual([]);
      expect(VERBS.filter((v) => shown.includes(v) && behind.includes(v))).toEqual([]);
      expect(shown, "the panel stands in the design's order").toEqual(VERBS.filter((v) => shown.includes(v)));
      expect(behind, "More lists in the panel's order, Delete last").toEqual([
        ...VERBS.filter((v) => behind.includes(v)),
        "Delete",
      ]);
      if (panelIs) expect(standing).toEqual(panelIs);
      if (moreIs) expect(behind).toEqual(moreIs);
      else {
        /* What folded is the highest ranks first, and Reply, Forward and the read slot stand with their words. */
        const folded = FOLDS.filter((v) => behind.includes(v));
        expect(folded).toEqual(FOLDS.slice(0, folded.length));
        expect(standing.filter((s) => /^(Reply|Forward|Mark unread):/.test(s))).toEqual([
          "Reply: word",
          "Forward: word",
          "Mark unread: word",
        ]);
      }
      const folded = VERBS.filter((v) => behind.includes(v));
      if (width < 1440) expect(folded.length).toBeGreaterThan(0);
      if (folded.includes("Park")) {
        await page.getByRole("menuitem", { name: "Park" }).dispatchEvent("click");
        const pressed = await page.evaluate(() =>
          (
            (globalThis as { readerMutations?: { kind: string; state?: string }[] }).readerMutations ?? []
          ).filter((m) => m.kind === "triage_set"),
        );
        expect(pressed).toEqual([expect.objectContaining({ state: "set_aside" })]);
      }
      await page.close();
    }, 60_000);
});

describe("the letter's body brings no sheet of the old kit's ground", () => {
  it("in the paper face no key hint stands on a control unless it is shown on purpose", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?open=lt-log&screen=reading`);
    await page.waitForSelector('[data-conv-id="lt-log"][data-body-ready]', { timeout: 15_000 });
    const standing = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".oh-key")]
          .filter((k) => k.dataset.shown === undefined && getComputedStyle(k).display !== "none")
          .map((k) => k.textContent),
      );
    expect(await page.locator(".oh-key").count()).toBeGreaterThan(0);
    expect(await standing()).toEqual([]);
    // The control: the old kit's base sheet as a body that brought it stood it, its key rule unguarded (the kit's
    // sheet now passes over its own parts: its guard is taken off here), stands the caps up, so the reading above
    // can see one.
    const guarded = 'kbd:where(:not([class^="oh-"], [class*=" oh-"])){';
    const sheet = readFileSync(resolve(process.cwd(), "packages/ui/src/base.css"), "utf8");
    expect(sheet).toContain(guarded);
    await page.addStyleTag({ content: sheet.replace(guarded, "kbd{") });
    expect((await standing()).length).toBeGreaterThan(0);
    await page.close();
  }, 60_000);
});

describe("the panel's menus in a real browser", () => {
  /*
   * A menu comes out of the control that opened it (the kit's K3: a verb's press hands its element): the Tag menu ends
   * at its opener's right edge, the Resurface chooser starts at the Resurface button's left edge, and More's own
   * menu ends at More. The day picker that "Pick a date" opens stands where the chooser stood. This case
   * exercises Tag folded into More so the anchor is the button that opened that menu.
   */
  it("at 1440 the Tag menu ends at its button, the Resurface chooser starts at its button and its day picker, More's menu ends at More", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?open=lt-journal&screen=reading`);
    await page.waitForSelector('[data-conv-id="lt-journal"][data-body-ready]', { timeout: 15_000 });
    const panel = page.getByRole("toolbar", { name: "Actions" });
    await page.evaluate(() => document.fonts.ready);
    // Widen the list if necessary so Tag folds into More while Resurface stays on the toolbar.
    const tag = panel.getByRole("button", { name: "Tag", exact: true });
    const listWidth = page.getByRole("separator", { name: "List width" });
    for (let step = 0; step < 8 && (await tag.isVisible()); step++) {
      await listWidth.press("ArrowRight");
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
    }
    if (await tag.isVisible()) {
      await tag.evaluate((button) => {
        const bar = button.parentElement!;
        const rank = Number(button.dataset.rank);
        const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
        const higher = [...bar.querySelectorAll<HTMLElement>("[data-rank]")]
          .filter((verb) => !verb.hidden && Number(verb.dataset.rank) > rank)
          .reduce((width, verb) => {
            const style = getComputedStyle(verb);
            return (
              width + verb.offsetWidth + parseFloat(style.marginLeft) + parseFloat(style.marginRight) + gap
            );
          }, 0);
        bar.parentElement!.style.maxWidth = `${bar.scrollWidth - Math.ceil(higher + button.offsetWidth / 2)}px`;
      });
      await tag.waitFor({ state: "hidden" });
    }
    const box = async (name: string) =>
      (await panel.getByRole("button", { name, exact: true }).boundingBox())!;
    const opened = async (button: string, menu: string) => {
      await panel.getByRole("button", { name: button, exact: true }).click();
      const b = (await page.getByRole("menu", { name: menu, exact: true }).boundingBox())!;
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "detached" });
      return b;
    };
    expect(await tag.isVisible()).toBe(false);
    const more = await box("More");
    await panel.getByRole("button", { name: "More", exact: true }).click();
    await page
      .getByRole("menu", { name: "More", exact: true })
      .getByRole("menuitem", { name: "Tag", exact: true })
      .click();
    const tagMenu = (await page.getByRole("menu", { name: "Tag", exact: true }).boundingBox())!;
    expect(
      Math.abs(tagMenu.x + tagMenu.width - (more.x + more.width)),
      "the Tag menu ends at the More button that opened it",
    ).toBeLessThanOrEqual(1);
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached" });
    const resurface = await box("Resurface");
    const chooser = await opened("Resurface", "Resurface");
    expect(
      Math.abs(chooser.x - resurface.x),
      "the Resurface chooser starts at its button",
    ).toBeLessThanOrEqual(1);
    const moreMenu = await opened("More", "More");
    expect(
      Math.abs(moreMenu.x + moreMenu.width - (more.x + more.width)),
      "More's menu ends at More",
    ).toBeLessThanOrEqual(1);
    await panel.getByRole("button", { name: "Resurface", exact: true }).click();
    await page.getByRole("menuitem", { name: "Pick a date", exact: true }).click();
    const picker = (await page.getByRole("menu", { name: "Pick a date", exact: true }).boundingBox())!;
    expect(
      Math.abs(picker.x - resurface.x),
      "the day picker stands where the chooser stood",
    ).toBeLessThanOrEqual(1);
    await page.close();
  }, 60_000);
});

it.each([540, 1000])(
  "steps the heading back only in a short room (%i high)",
  async (height) => {
    const page = await browser!.newPage({ viewport: { width: 1440, height }, reducedMotion: "reduce" });
    try {
      await page.route(`${ORIGIN}/**`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
      );
      await page.goto(`${ORIGIN}/?open=rd-a&read=1&screen=reading`);
      const heading = page.locator(".oh-readinghead-subject");
      const short = page.locator(".oh-readinghead-short");
      await heading.evaluate((el) => el.parentElement!.parentElement!.scrollTo(0, 315));
      await expect.poll(() => short.isVisible()).toBe(height < 900);
      await heading.evaluate((el) => el.parentElement!.parentElement!.scrollTo(0, 0));
      await expect.poll(() => short.isVisible()).toBe(false);
      expect(await heading.isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  },
  20_000,
);

it("fades the sticky Paper heading only while it covers the letter", async () => {
  const page = await browser!.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  try {
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?open=rd-a&read=1&screen=reading`);
    const heading = page.getByRole("heading", { name: "Open studio: the plan" });
    const fade = () =>
      heading.evaluate((heading) => {
        const edge = getComputedStyle(heading.parentElement!, "::after");
        return edge.content === "none" ? null : [edge.height, edge.backgroundImage];
      });
    expect(await fade()).toBeNull();
    await heading.evaluate((heading) => heading.parentElement!.parentElement!.scrollBy(0, 300));
    await expect.poll(fade).toEqual(["24px", expect.stringContaining("linear-gradient(")]);
    await heading.evaluate((heading) => heading.parentElement!.parentElement!.scrollTo(0, 0));
    await expect.poll(fade).toBeNull();
  } finally {
    await page.close();
  }
}, 20_000);

it.each([
  { face: "paper", scheme: "light", width: 1440, height: 900 },
  { face: "ohmarchy", scheme: "light", width: 1440, height: 900 },
  { face: "paper", scheme: "dark", width: 1440, height: 540 },
  { face: "paper", scheme: "dark", width: 2000, height: 540 },
])(
  "covers the scrolled letter across and above the $face $scheme heading at $width",
  async ({ face, scheme, width, height }) => {
    const page = await browser!.newPage({
      viewport: { width, height },
      reducedMotion: "reduce",
    });
    try {
      await page.route(`${ORIGIN}/**`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
      );
      await page.goto(`${ORIGIN}/?open=rd-a&read=1&screen=reading&face=${face}&scheme=${scheme}`);
      const letter = page.locator('[data-conv-id="rd-a"][data-body-ready]');
      await letter.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const { leftGap, rightGap, topGap, clip, textUnderHead } = await page
        .locator(".oh-readinghead")
        .evaluate(async (head) => {
          const scroller = head.parentElement!;
          scroller.scrollTop = 315;
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          const port = scroller.getBoundingClientRect();
          const box = head.getBoundingClientRect();
          const left = port.left + scroller.clientLeft;
          const right = left + scroller.clientWidth;
          const top = port.top + scroller.clientTop;
          const walker = document.createTreeWalker(
            scroller.querySelector('[data-conv-id="rd-a"]')!,
            NodeFilter.SHOW_TEXT,
          );
          const range = document.createRange();
          let textUnderHead = false;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.startsWith("Line ")) continue;
            range.selectNodeContents(node);
            textUnderHead ||= [...range.getClientRects()].some(
              (text) => text.top < box.bottom && text.bottom > top,
            );
          }
          return {
            leftGap: Math.abs(box.left - left),
            rightGap: Math.abs(box.right - right),
            topGap: box.top - top,
            clip: {
              x: Math.ceil(left),
              y: Math.ceil(top),
              width: Math.floor(right) - Math.ceil(left),
              height: Math.floor(box.bottom) - Math.ceil(top),
            },
            textUnderHead,
          };
        });
      expect(leftGap).toBeLessThanOrEqual(1);
      expect(rightGap).toBeLessThanOrEqual(1);
      expect(textUnderHead).toBe(true);
      expect(
        topGap,
        "the sticky heading leaves no exposed strip at the top of the scrollport",
      ).toBeLessThanOrEqual(0);
      // Hiding the letter without moving it must change no pixels from the scrollport's top through the heading.
      const visible = await page.screenshot({ clip });
      await letter.evaluate((el) => el.style.setProperty("visibility", "hidden"));
      const hidden = await page.screenshot({ clip });
      expect(visible.equals(hidden), "the letter paints through the heading or along its edges").toBe(true);
    } finally {
      await page.close();
    }
  },
  20_000,
);

it("aligns the first unread letter when the rest of the thread is short and can still scroll to the last", async () => {
  const { readerStatesPage } = await import("./reader-states.mjs");
  const threadHtml = await readerStatesPage("packages/app/test/states/squares-reader-1-page.tsx");
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: threadHtml }),
    );
    await page.goto(`${ORIGIN}/?n=6&whole=1&open=5&firstUnread=4`);
    const heading = page.getByRole("heading", { name: "Q3 plan" });
    const group = page.getByRole("group", { name: /^6 messages,/ });
    const here = (position: number) =>
      group
        .getByRole("button", { name: new RegExp(`^Message ${position} of 6 `) })
        .and(group.locator('[aria-current="true"]'));
    const letter = page.locator('[data-conv-id="w4"]');
    await here(5).waitFor();
    const gap = () =>
      heading.evaluate((h) => {
        const panel = h.closest("[data-reading-scroll]")!.querySelector('[data-conv-id="w4"]')!;
        return panel.getBoundingClientRect().top - h.parentElement!.getBoundingClientRect().bottom;
      });
    await expect.poll(gap).toBeLessThanOrEqual(16);
    expect(await gap()).toBeGreaterThanOrEqual(13);

    await letter.hover();
    await page.mouse.wheel(0, 10_000);
    await here(6).waitFor();
  } finally {
    await page.close();
  }
}, 60_000);

it("lands the last message on the reading line after jumping away in a short thread", async () => {
  const { readerStatesPage } = await import("./reader-states.mjs");
  const threadHtml = await readerStatesPage("packages/app/test/states/squares-reader-1-page.tsx");
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: threadHtml }),
    );
    await page.goto(`${ORIGIN}/?n=6&whole=1&open=5&firstUnread=4`);
    const heading = page.getByRole("heading", { name: "Q3 plan" });
    const group = page.getByRole("group", { name: /^6 messages,/ });
    const square = (position: number) =>
      group.getByRole("button", { name: new RegExp(`^Message ${position} of 6 `) });
    await expect.poll(() => square(5).getAttribute("aria-current")).toBe("true");
    await square(1).click();
    await expect.poll(() => square(1).getAttribute("aria-current")).toBe("true");
    await square(6).click();
    await expect.poll(() => square(6).getAttribute("aria-current")).toBe("true");
    const gap = await heading.evaluate((h) => {
      const panel = h.closest("[data-reading-scroll]")!.querySelector('[data-conv-id="w5"]')!;
      return panel.getBoundingClientRect().top - h.parentElement!.getBoundingClientRect().bottom;
    });
    expect(gap).toBeGreaterThan(100);
    expect(gap).toBeLessThan(300);
  } finally {
    await page.close();
  }
}, 60_000);

it.each([
  { width: 390, height: 844, axis: "head", dx: -75, dy: 0, pointer: "coarse" },
  { width: 719, height: 781, axis: "head", dx: -75, dy: 0, pointer: "coarse" },
  { width: 719, height: 781, axis: "head", dx: -75, dy: 0, pointer: "fine" },
  { width: 1000, height: 781, axis: "column", dx: 0, dy: -165, pointer: "fine" },
  { width: 1000, height: 781, axis: "column", dx: 0, dy: -165, pointer: "coarse" },
])(
  "walks a long $axis run at $width px under a finger and still selects on tap with a $pointer primary pointer",
  async ({ width, height, axis, dx, dy, pointer }) => {
    const { readerStatesPage } = await import("./reader-states.mjs");
    const threadHtml = await readerStatesPage("packages/app/test/states/squares-reader-1-page.tsx");
    const page = await browser!.newPage({
      viewport: { width, height },
      reducedMotion: "reduce",
      hasTouch: true,
      isMobile: true,
    });
    try {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.route("**/*", (route) =>
        route.request().url().startsWith(ORIGIN)
          ? route.fulfill({ contentType: "text/html", body: threadHtml })
          : route.abort(),
      );
      const mailCount = 160;
      const start = 80;
      await page.goto(
        `${ORIGIN}/?n=${mailCount}&open=${start}&device=phone${pointer === "fine" ? "&fine" : ""}${axis === "column" && pointer === "coarse" ? "&column" : ""}`,
      );
      const group = page.getByRole("group", { name: new RegExp(`^${mailCount} messages, \\d+ unread$`) });
      const here = () => group.locator("[data-here]").getAttribute("data-square").then(Number);
      await expect.poll(here).toBe(start);
      expect(await page.locator("html").getAttribute("data-touch")).toBe(pointer === "coarse" ? "1" : "0");
      expect(await group.getAttribute("data-axis")).toBe(axis);
      const state = () =>
        group.evaluate((el) => ({
          before: Number(el.firstElementChild?.textContent?.replace(/^\+/, "")),
          scroll: document.querySelector("[data-reading-scroll]")!.scrollTop,
          background: [window.scrollY, document.querySelector(".fr-list")?.scrollTop ?? 0],
        }));
      const before = await state();
      const cdp = await page.context().newCDPSession(page);
      const current = (await group.locator("[data-here]").boundingBox())!;
      const pitch = axis === "head" ? current.width : current.height;
      const x = current.x + current.width / 2;
      const y = current.y + current.height / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 10; step++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x + (dx * step) / 10, y: y + (dy * step) / 10 }],
        });
        if (step === 5) await expect.poll(here).toBe(start + Math.round(Math.hypot(dx, dy) / 2 / pitch));
      }
      const end = start + Math.round(Math.hypot(dx, dy) / pitch);
      await expect.poll(here).toBe(end);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      const after = await state();
      expect(after.scroll).toBeGreaterThan(before.scroll);
      expect(after.before).toBeGreaterThan(before.before);
      expect(after.background).toEqual(before.background);
      expect(await page.getByRole("dialog", { name: "More" }).count()).toBe(0);
      await page.evaluate(
        () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
      );
      await group.locator(`[data-square="${end - 1}"]`).tap();
      await expect.poll(here).toBe(end - 1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  },
  25_000,
);

it.each(["no-preference", "reduce"] as const)(
  "uses the Calendar column motion on Mail entry with motion preference %s",
  async (reducedMotion) => {
    const { readerStatesPage } = await import("./reader-states.mjs");
    const threadHtml = await readerStatesPage("packages/app/test/states/squares-reader-1-page.tsx");
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion });
    try {
      await page.addInitScript(() => {
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (...args: Parameters<typeof animate>) {
          const result = animate.apply(this, args);
          if (this.matches(".fr-main > :is(.fr-list, .fr-reading, .fr-wide)")) {
            const effect = result.effect as KeyframeEffect;
            this.dispatchEvent(
              new CustomEvent("column-arrival", {
                bubbles: true,
                detail: { frames: effect.getKeyframes(), timing: effect.getTiming() },
              }),
            );
          }
          return result;
        };
        const arrivals: unknown[] = [];
        Object.assign(window, { arrivals });
        document.addEventListener("column-arrival", (event) => arrivals.push((event as CustomEvent).detail));
      });
      await page.route(`${ORIGIN}/**`, (route) =>
        route.fulfill({ contentType: "text/html", body: threadHtml }),
      );
      const arrivals = () =>
        page.evaluate(
          () =>
            (window as Window & { arrivals?: { frames: ComputedKeyframe[]; timing: EffectTiming }[] })
              .arrivals ?? [],
        );
      await page.goto(`${ORIGIN}/?switch&motion=full&n=6`);
      const open = page.getByRole("button", { name: "Q3 plan" });
      await open.waitFor();
      const boot = reducedMotion === "reduce" ? 0 : 2;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      await expect.poll(async () => (await arrivals()).length).toBe(boot);

      await open.click();
      await page.getByRole("heading", { name: "Q3 plan" }).waitFor();
      expect(await arrivals()).toHaveLength(boot);

      await page.getByRole("button", { name: "Calendar", exact: true }).click();
      await page.getByRole("heading", { name: "Calendar week" }).waitFor();
      await expect.poll(async () => (await arrivals()).length).toBe(boot + 1);
      await page.getByRole("button", { name: "Mail", exact: true }).click();
      await page.getByRole("heading", { name: "Q3 plan" }).waitFor();
      await expect.poll(async () => (await arrivals()).length).toBe(boot + 3);

      const entries = await arrivals();
      const [calendar, mail, reader] = entries.slice(boot);
      expect(mail).toEqual(calendar);
      if (boot) expect(entries.slice(0, boot)).toEqual([mail, reader]);
      expect(reader?.timing.delay).toBe(2 * (mail?.timing.delay ?? 0));
      if (reducedMotion === "reduce") {
        expect(mail?.frames.map((frame) => frame.transform)).toEqual([undefined, undefined]);
      } else {
        expect(mail?.frames[0]?.transform).toBe("translateY(8px)");
      }
    } finally {
      await page.close();
    }
  },
  60_000,
);

it("anchors the reader menu when opened during Mail entry", async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.addInitScript(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args: Parameters<typeof animate>) {
        const result = animate.apply(this, args);
        if (this.matches(".fr-main > .fr-reading")) {
          result.pause();
          result.currentTime = 100;
        }
        return result;
      };
    });
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?open=lt-journal&screen=reading&motion=full`);
    const button = page.getByRole("button", { name: "Resurface", exact: true });
    const reader = page.getByRole("region", { name: "Reading", exact: true });
    const entryPaused = () =>
      reader.evaluate((node) => node.getAnimations().some((animation) => animation.playState === "paused"));
    await expect.poll(entryPaused).toBe(true);
    await button.evaluate((node) => {
      const column = node.closest('[aria-label="Reading"]')!;
      node.addEventListener(
        "pointerdown",
        (event) => {
          if (event.isTrusted) node.setAttribute("data-press-transform", getComputedStyle(column).transform);
        },
        { once: true },
      );
    });
    await button.click();
    expect(await entryPaused()).toBe(false);
    const menu = page.getByRole("menu", { name: "Resurface", exact: true });
    await menu.waitFor();
    expect(
      await menu.evaluate((node) => {
        const { x, y, width, height } = node.parentElement!.getBoundingClientRect();
        return { x, y, width, height };
      }),
    ).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    await expect
      .poll(async () => {
        const box = (await button.boundingBox())!;
        const overlay = (await menu.boundingBox())!;
        return Math.abs(overlay.x - box.x);
      })
      .toBeLessThanOrEqual(1);
    expect(await button.getAttribute("data-press-transform")).toBe("none");
  } finally {
    await page.close();
  }
}, 20_000);

it.each([
  ["phone", 390, 844],
  ["fold", 719, 841],
] as const)(
  "opens Mail on %s without sliding the whole frame",
  async (device, width, height) => {
    const page = await browser!.newPage({ viewport: { width, height }, reducedMotion: "no-preference" });
    try {
      await page.addInitScript(() => {
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (...args: Parameters<typeof animate>) {
          const result = animate.apply(this, args);
          if (this.matches(".fr-frame")) result.pause();
          return result;
        };
      });
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${ORIGIN}/?device=${device}&open=lt-journal&screen=reading&motion=full`);
      await page.getByRole("toolbar", { name: "Actions" }).waitFor();
      const moving = await page.locator(".fr-frame").evaluate(
        (frame) =>
          new Promise<number>((done) => {
            requestAnimationFrame(() => requestAnimationFrame(() => done(frame.getAnimations().length)));
          }),
      );
      expect(moving).toBe(0);
    } finally {
      await page.close();
    }
  },
  20_000,
);
