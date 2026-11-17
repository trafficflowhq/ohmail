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
      const behind = await page.getByRole("menuitem").allTextContents();
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
   * at the Tag button's right edge, the Resurface chooser starts at the Resurface button's left edge, and More's own
   * menu ends at More; the day picker that "Pick a date" opens stands where the chooser stood. Read at 1440 on a letter
   * whose panel stands whole.
   */
  it("at 1440 the Tag menu ends at its button, the Resurface chooser starts at its button and its day picker, More's menu ends at More", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?open=lt-journal&screen=reading`);
    await page.waitForSelector('[data-conv-id="lt-journal"][data-body-ready]', { timeout: 15_000 });
    const panel = page.getByRole("toolbar", { name: "Actions" });
    const box = async (name: string) =>
      (await panel.getByRole("button", { name, exact: true }).boundingBox())!;
    const opened = async (button: string, menu: string) => {
      await panel.getByRole("button", { name: button, exact: true }).click();
      const b = (await page.getByRole("menu", { name: menu, exact: true }).boundingBox())!;
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "detached" });
      return b;
    };
    const tag = await box("Tag");
    const tagMenu = await opened("Tag", "Tag");
    expect(
      Math.abs(tagMenu.x + tagMenu.width - (tag.x + tag.width)),
      "the Tag menu ends at its button",
    ).toBeLessThanOrEqual(1);
    const resurface = await box("Resurface");
    const chooser = await opened("Resurface", "Resurface");
    expect(
      Math.abs(chooser.x - resurface.x),
      "the Resurface chooser starts at its button",
    ).toBeLessThanOrEqual(1);
    const more = await box("More");
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
